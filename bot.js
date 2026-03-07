/**
 * 1yn autogetkey — Discord 金鑰管理 Bot（中文版）
 * 
 * 功能：
 *   1. /giveautoclick @使用者 — 管理員/代理賦予金鑰給指定使用者
 *   2. 兌換金鑰 按鈕 — 使用者輸入金鑰兌換 autoclick 身分組
 *   3. 獲取金鑰 按鈕 — 使用者點擊後獲取已分配的金鑰（私訊發送）
 *   4. 獲取身分組 按鈕 — 檢查並賦予 autoclick 身分組
 *   5. 重置 HWID 按鈕 — 重置硬體綁定
 *   6. 查看統計 按鈕 — 查看個人金鑰狀態
 *
 * 環境變數：
 *   - DISCORD_TOKEN        : Bot Token
 *   - GOOGLE_SCRIPT_URL    : Google Apps Script Web App URL（用戶資料）
 *   - GUILD_ID             : 伺服器 ID（用於註冊指令）
 *
 * 頻道/角色 ID：
 *   - get key 類別：1479754371297181736
 *   - get key 頻道：1479754386568646746
 *   - 下載頻道：    1479754434547417208
 *   - autoclick 身分組：1479785119547002931
 *   - 管理員身分組：    1479780178069815447
 *   - 代理身分組：      1479780213599506463
 */

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  Events
} = require("discord.js");

const fetch = require("node-fetch");
const { v4: uuidv4 } = require("uuid");

// ======================================================================
// 設定
// ======================================================================
const TOKEN            = process.env.DISCORD_TOKEN || "";
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL || "";
const GUILD_ID         = process.env.GUILD_ID || "";

// 頻道 ID
const GETKEY_CATEGORY_ID = "1479754371297181736";
const GETKEY_CHANNEL_ID  = "1479754386568646746";
const DOWNLOAD_CHANNEL_ID = "1479754434547417208";

// 角色 ID
const AUTOCLICK_ROLE_ID  = "1479785119547002931";
const ADMIN_ROLE_ID      = "1479780178069815447";
const AGENT_ROLE_ID      = "1479780213599506463";

// ======================================================================
// 金鑰資料庫（記憶體內，重啟會清除 — 生產環境建議用資料庫）
// 結構：Map<key_string, { userId, username, redeemed, hwid, createdAt }>
// ======================================================================
const keyStore = new Map();
// 使用者 → 金鑰 對應：Map<userId, key_string>
const userKeyMap = new Map();

// ======================================================================
// 產生金鑰
// ======================================================================
function generateKey() {
  const uuid = uuidv4().replace(/-/g, "").toUpperCase();
  return `1YN-${uuid.substring(0, 4)}-${uuid.substring(4, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}`;
}

// ======================================================================
// 傳送用戶資料至 Google 試算表
// ======================================================================
async function sendUserDataToSheet(username, userId, purchaseItem, purchaseAmount) {
  if (!GOOGLE_SCRIPT_URL) {
    console.log("GOOGLE_SCRIPT_URL 未設定，跳過試算表寫入");
    return;
  }

  try {
    const payload = {
      username,
      user_id: userId,
      purchase_item: purchaseItem,
      purchase_amount: purchaseAmount,
      timestamp: new Date().toISOString()
    };

    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });

    const result = await response.text();
    console.log(`[試算表] 已寫入: ${username} (${userId}) — ${purchaseItem} — ${purchaseAmount}`);
  } catch (err) {
    console.error(`[試算表] 寫入失敗:`, err.message);
  }
}

// ======================================================================
// 建立 Discord Client
// ======================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// ======================================================================
// 註冊 Slash Commands
// ======================================================================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("giveautoclick")
      .setDescription("賦予指定使用者 autoclick 金鑰（管理員/代理專用）")
      .addUserOption(option =>
        option.setName("使用者")
          .setDescription("要賦予金鑰的使用者")
          .setRequired(true)
      )
      .toJSON()
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);

  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
      console.log(`[指令] 已註冊至伺服器 ${GUILD_ID}`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log("[指令] 已全域註冊");
    }
  } catch (err) {
    console.error("[指令] 註冊失敗:", err);
  }
}

// ======================================================================
// Bot Ready
// ======================================================================
client.once(Events.ClientReady, async () => {
  console.log(`[Bot] 已登入為 ${client.user.tag}`);
  await registerCommands();

  // 在 get key 頻道發送控制面板
  try {
    const channel = await client.channels.fetch(GETKEY_CHANNEL_ID);
    if (channel) {
      // 檢查是否已有控制面板訊息（避免重複發送）
      const messages = await channel.messages.fetch({ limit: 10 });
      const hasPanel = messages.some(m => m.author.id === client.user.id && m.embeds.length > 0);

      if (!hasPanel) {
        await sendControlPanel(channel);
      }
    }
  } catch (err) {
    console.error("[Bot] 無法發送控制面板:", err.message);
  }
});

// ======================================================================
// 控制面板 Embed + 按鈕
// ======================================================================
async function sendControlPanel(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle("1yn AutoClick 控制面板")
    .setDescription(
      `此控制面板用於管理 **1yn AutoClick** 專案。\n\n` +
      `**付費用戶（永久授權）**\n` +
      `如果您已購買並獲得授權，請點擊「獲取金鑰」來取得您的授權金鑰。\n\n` +
      `**新用戶**\n` +
      `請前往 <#${DOWNLOAD_CHANNEL_ID}> 下載程式，並使用獲得的金鑰啟動。\n\n` +
      `**使用方式**\n` +
      `1. 點擊「獲取金鑰」取得您的專屬金鑰\n` +
      `2. 下載 .cmd 啟動器和 .exe 主程式\n` +
      `3. 開啟 .cmd 檔案，輸入金鑰即可啟動`
    )
    .setFooter({ text: "1yn autogetkey" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_redeem_key")
      .setLabel("兌換金鑰")
      .setEmoji("🔑")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("btn_get_key")
      .setLabel("獲取金鑰")
      .setEmoji("📋")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_get_role")
      .setLabel("獲取身分組")
      .setEmoji("👤")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("btn_reset_hwid")
      .setLabel("重置 HWID")
      .setEmoji("⚙")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("btn_get_stats")
      .setLabel("查看統計")
      .setEmoji("📊")
      .setStyle(ButtonStyle.Secondary)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ======================================================================
// Slash Command 處理
// ======================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  // ── Slash Command: /giveautoclick ──
  if (interaction.isChatInputCommand() && interaction.commandName === "giveautoclick") {
    // 權限檢查：管理員或代理
    const member = interaction.member;
    const hasPermission = member.roles.cache.has(ADMIN_ROLE_ID) ||
                          member.roles.cache.has(AGENT_ROLE_ID);

    if (!hasPermission) {
      return interaction.reply({
        content: "❌ 您沒有權限使用此指令。僅限管理員和代理使用。",
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser("使用者");
    if (!targetUser) {
      return interaction.reply({ content: "❌ 請指定一個使用者。", ephemeral: true });
    }

    // 檢查是否已有金鑰
    if (userKeyMap.has(targetUser.id)) {
      const existingKey = userKeyMap.get(targetUser.id);
      return interaction.reply({
        content: `⚠ 該使用者已有金鑰：\`${existingKey}\``,
        ephemeral: true
      });
    }

    // 產生金鑰
    const key = generateKey();
    keyStore.set(key, {
      userId: targetUser.id,
      username: targetUser.username,
      redeemed: false,
      hwid: null,
      createdAt: new Date().toISOString()
    });
    userKeyMap.set(targetUser.id, key);

    // 賦予 autoclick 身分組
    try {
      const guild = interaction.guild;
      const targetMember = await guild.members.fetch(targetUser.id);
      await targetMember.roles.add(AUTOCLICK_ROLE_ID);
    } catch (err) {
      console.error(`[角色] 賦予失敗:`, err.message);
    }

    // 私訊金鑰給目標使用者
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("🔑 您已獲得 1yn AutoClick 金鑰！")
        .setDescription(
          `恭喜！管理員已為您分配了一組專屬金鑰。\n\n` +
          `**您的金鑰：**\n\`\`\`\n${key}\n\`\`\`\n\n` +
          `**使用方式：**\n` +
          `1. 前往下載頻道取得程式\n` +
          `2. 開啟 \`.cmd\` 啟動器\n` +
          `3. 輸入上方金鑰即可啟動 \`.exe\` 連點器\n\n` +
          `⚠ 請妥善保管此金鑰，切勿分享給他人。`
        )
        .setFooter({ text: "1yn autogetkey" })
        .setTimestamp();

      await targetUser.send({ embeds: [dmEmbed] });
    } catch (err) {
      console.log(`[私訊] 無法私訊 ${targetUser.username}:`, err.message);
    }

    // 寫入 Google 試算表
    await sendUserDataToSheet(
      targetUser.username,
      targetUser.id,
      "autoclick（管理員賦予）",
      "1500 tokens"
    );

    // 回覆管理員
    const replyEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("✅ 金鑰已賦予")
      .addFields(
        { name: "使用者", value: `<@${targetUser.id}>`, inline: true },
        { name: "金鑰", value: `\`${key}\``, inline: true },
        { name: "金額", value: "1500 tokens", inline: true }
      )
      .setFooter({ text: `由 ${interaction.user.username} 執行` })
      .setTimestamp();

    return interaction.reply({ embeds: [replyEmbed], ephemeral: true });
  }

  // ── 按鈕互動 ──
  if (interaction.isButton()) {
    const userId = interaction.user.id;

    switch (interaction.customId) {
      // ── 兌換金鑰 ──
      case "btn_redeem_key": {
        const modal = new ModalBuilder()
          .setCustomId("modal_redeem_key")
          .setTitle("兌換金鑰");

        const keyInput = new TextInputBuilder()
          .setCustomId("input_key")
          .setLabel("請輸入您的金鑰")
          .setPlaceholder("例如：1YN-ABCD-1234-EFGH-5678")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(keyInput);
        modal.addComponents(row);

        return interaction.showModal(modal);
      }

      // ── 獲取金鑰 ──
      case "btn_get_key": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({
            content: "❌ 您尚未被分配金鑰。請聯繫管理員或代理獲取授權。",
            ephemeral: true
          });
        }

        const key = userKeyMap.get(userId);
        const keyData = keyStore.get(key);

        try {
          const dmEmbed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle("🔑 您的 1yn AutoClick 金鑰")
            .setDescription(
              `**金鑰：**\n\`\`\`\n${key}\n\`\`\`\n\n` +
              `**狀態：** ${keyData.redeemed ? "✅ 已兌換" : "⏳ 未兌換"}\n` +
              `**建立時間：** ${keyData.createdAt}\n\n` +
              `**使用方式：**\n` +
              `1. 開啟 \`.cmd\` 啟動器\n` +
              `2. 輸入上方金鑰\n` +
              `3. 即可啟動 \`.exe\` 連點器`
            )
            .setFooter({ text: "1yn autogetkey" })
            .setTimestamp();

          await interaction.user.send({ embeds: [dmEmbed] });
          return interaction.reply({
            content: "✅ 金鑰已透過私訊發送給您，請查看私訊！",
            ephemeral: true
          });
        } catch (err) {
          return interaction.reply({
            content: `❌ 無法發送私訊。請確認您已開啟私訊功能。\n\n您的金鑰：\`${key}\``,
            ephemeral: true
          });
        }
      }

      // ── 獲取身分組 ──
      case "btn_get_role": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({
            content: "❌ 您尚未被分配金鑰，無法獲取身分組。",
            ephemeral: true
          });
        }

        try {
          const member = await interaction.guild.members.fetch(userId);
          if (member.roles.cache.has(AUTOCLICK_ROLE_ID)) {
            return interaction.reply({
              content: "✅ 您已擁有 autoclick 身分組！",
              ephemeral: true
            });
          }

          await member.roles.add(AUTOCLICK_ROLE_ID);
          return interaction.reply({
            content: "✅ 已成功賦予 autoclick 身分組！",
            ephemeral: true
          });
        } catch (err) {
          return interaction.reply({
            content: "❌ 無法賦予身分組，請聯繫管理員。",
            ephemeral: true
          });
        }
      }

      // ── 重置 HWID ──
      case "btn_reset_hwid": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({
            content: "❌ 您尚未被分配金鑰。",
            ephemeral: true
          });
        }

        const key = userKeyMap.get(userId);
        const keyData = keyStore.get(key);
        if (keyData) {
          keyData.hwid = null;
          keyStore.set(key, keyData);
        }

        return interaction.reply({
          content: "✅ HWID 已重置！下次啟動程式時將重新綁定。",
          ephemeral: true
        });
      }

      // ── 查看統計 ──
      case "btn_get_stats": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({
            content: "❌ 您尚未被分配金鑰。",
            ephemeral: true
          });
        }

        const key = userKeyMap.get(userId);
        const keyData = keyStore.get(key);

        const statsEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("📊 您的金鑰統計")
          .addFields(
            { name: "金鑰", value: `\`${key}\``, inline: false },
            { name: "狀態", value: keyData.redeemed ? "✅ 已兌換" : "⏳ 未兌換", inline: true },
            { name: "HWID", value: keyData.hwid || "未綁定", inline: true },
            { name: "建立時間", value: keyData.createdAt, inline: false }
          )
          .setFooter({ text: "1yn autogetkey" })
          .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed], ephemeral: true });
      }
    }
  }

  // ── Modal 提交：兌換金鑰 ──
  if (interaction.isModalSubmit() && interaction.customId === "modal_redeem_key") {
    const inputKey = interaction.fields.getTextInputValue("input_key").trim().toUpperCase();

    if (!keyStore.has(inputKey)) {
      return interaction.reply({
        content: "❌ 金鑰無效！請確認您輸入的金鑰是否正確。",
        ephemeral: true
      });
    }

    const keyData = keyStore.get(inputKey);

    // 檢查金鑰是否屬於此使用者
    if (keyData.userId !== interaction.user.id) {
      return interaction.reply({
        content: "❌ 此金鑰不屬於您。",
        ephemeral: true
      });
    }

    if (keyData.redeemed) {
      return interaction.reply({
        content: "⚠ 此金鑰已經兌換過了。",
        ephemeral: true
      });
    }

    // 標記為已兌換
    keyData.redeemed = true;
    keyStore.set(inputKey, keyData);

    // 賦予身分組
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(AUTOCLICK_ROLE_ID);
    } catch (err) {
      console.error(`[角色] 兌換時賦予失敗:`, err.message);
    }

    // 寫入 Google 試算表
    await sendUserDataToSheet(
      interaction.user.username,
      interaction.user.id,
      "autoclick（金鑰兌換）",
      "1500 tokens"
    );

    return interaction.reply({
      content: `✅ 金鑰兌換成功！\n\n您的金鑰：\`${inputKey}\`\n已獲得 autoclick 身分組。\n\n請使用此金鑰在 .cmd 啟動器中啟動程式。`,
      ephemeral: true
    });
  }
});

// ======================================================================
// 金鑰驗證 API（供 .cmd 腳本呼叫）
// ======================================================================
// 這個 API 端點讓 C++ 客戶端或 .cmd 腳本可以驗證金鑰
// 使用 Node.js 內建 http 模組（無需額外安裝 express）
const http = require("http");
const API_PORT = process.env.PORT || 3000;

// 輔助函式：解析 JSON body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

// 輔助函式：發送 JSON 回應
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

// 建立 HTTP 伺服器
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // GET /
  if (method === "GET" && url.pathname === "/") {
    return sendJson(res, 200, { status: "ok", message: "1yn autogetkey bot is running" });
  }

  // GET /health
  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok" });
  }

  // POST /api/verify-key
  if (method === "POST" && url.pathname === "/api/verify-key") {
    const body = await parseBody(req);
    const { key, hwid } = body;

    if (!key) {
      return sendJson(res, 400, { valid: false, message: "未提供金鑰" });
    }

    const normalizedKey = key.trim().toUpperCase();

    if (!keyStore.has(normalizedKey)) {
      return sendJson(res, 404, { valid: false, message: "金鑰無效" });
    }

    const keyData = keyStore.get(normalizedKey);

    // HWID 綁定檢查
    if (keyData.hwid && hwid && keyData.hwid !== hwid) {
      return sendJson(res, 403, {
        valid: false,
        message: "此金鑰已綁定至其他裝置。請在 Discord 重置 HWID。"
      });
    }

    // 如果尚未綁定 HWID，進行綁定
    if (!keyData.hwid && hwid) {
      keyData.hwid = hwid;
      keyStore.set(normalizedKey, keyData);
    }

    return sendJson(res, 200, {
      valid: true,
      message: "金鑰驗證成功",
      username: keyData.username,
      userId: keyData.userId
    });
  }

  // 404 for all other routes
  sendJson(res, 404, { error: "Not found" });
});

// 啟動 API 伺服器
server.listen(API_PORT, "0.0.0.0", () => {
  console.log(`[API] 金鑰驗證伺服器已啟動，監聽 port ${API_PORT}`);
});

// ======================================================================
// 啟動 Bot
// ======================================================================
client.login(TOKEN).catch(err => {
  console.error("[Bot] 登入失敗:", err.message);
  process.exit(1);
});
