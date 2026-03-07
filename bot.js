/**
 * 1yn autogetkey — Discord 金鑰管理 Bot（中文版）
 * 
 * 功能：
 *   1. /giveautoclick @使用者 — 管理員/代理賦予金鑰給指定使用者
 *   2. 兌換密鑰 按鈕 — 使用者輸入金鑰兌換 autoclick 身分組
 *   3. 獲取金鑰 按鈕 — 使用者點擊後獲取已分配的金鑰（私訊發送）
 *   4. 獲取身分組 按鈕 — 檢查並賦予 autoclick 身分組
 *   5. 重置 HWID 按鈕 — 重置硬體綁定（清除 Google Sheets 中的 HWID 記錄）
 *   6. 查看統計 按鈕 — 查看個人金鑰狀態
 *
 * 金鑰永久儲存：所有金鑰都保存在 Google Sheets，Bot 重啟時從 Sheets 載入
 * HWID 系統：加密 HWID + 機碼寫入 checkHWID 資料夾 + 同步至 Google Sheets
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
const crypto = require("crypto");

// ======================================================================
// 設定
// ======================================================================
const TOKEN            = process.env.DISCORD_TOKEN || "";
const GUILD_ID         = process.env.GUILD_ID || "";

// Google Apps Script URL（硬編碼）
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTj4GejwJge1GXolh_CiX3sgiGnzZMcAdK9yGwm8oYBya1DSv7VK4ApjBkUQXRUxIMSA/exec";

// 頻道 ID
const GETKEY_CATEGORY_ID  = "1479754371297181736";
const GETKEY_CHANNEL_ID   = "1479754386568646746";
const DOWNLOAD_CHANNEL_ID = "1479754434547417208";

// 角色 ID
const AUTOCLICK_ROLE_ID = "1479785119547002931";
const ADMIN_ROLE_ID     = "1479780178069815447";
const AGENT_ROLE_ID     = "1479780213599506463";

// Discord 頻道連結
const DOWNLOAD_LINK = "https://discord.com/channels/1479753380661428409/1479754434547417208";
const GETKEY_LINK   = "https://discord.com/channels/1479753380661428409/1479754386568646746";

// ======================================================================
// HWID 加密系統
// ======================================================================
const HWID_SECRET = "1yn-autoclick-hwid-salt-v2-" + (process.env.HWID_SECRET || "s3cur3K3y!");

/**
 * 產生加密 HWID 雜湊（不可逆，用戶無法破解）
 * 輸入：原始 HWID 字串（電腦名稱_使用者名稱_磁碟序號）
 * 輸出：64 字元的 SHA-256 雜湊
 */
function encryptHWID(rawHwid) {
  return crypto.createHmac("sha256", HWID_SECRET)
    .update(rawHwid)
    .digest("hex");
}

/**
 * 產生機碼（Machine Code）— 綁定金鑰 + HWID 的唯一識別碼
 * 這個機碼會寫入 checkHWID 資料夾的 JSON 檔案中
 */
function generateMachineCode(key, encryptedHwid) {
  const payload = `${key}:${encryptedHwid}:${HWID_SECRET}`;
  return crypto.createHash("sha512").update(payload).digest("hex").substring(0, 64);
}

/**
 * 驗證機碼是否匹配
 */
function verifyMachineCode(key, encryptedHwid, machineCode) {
  const expected = generateMachineCode(key, encryptedHwid);
  return expected === machineCode;
}

// ======================================================================
// 金鑰資料庫（記憶體 + Google Sheets 永久儲存）
// ======================================================================
const keyStore = new Map();
const userKeyMap = new Map();

// ======================================================================
// 防重複互動處理
// ======================================================================
const processedInteractions = new Set();
const INTERACTION_EXPIRE_MS = 30000;

function isInteractionProcessed(interactionId) {
  if (processedInteractions.has(interactionId)) return true;
  processedInteractions.add(interactionId);
  setTimeout(() => processedInteractions.delete(interactionId), INTERACTION_EXPIRE_MS);
  return false;
}

// ======================================================================
// 產生金鑰
// ======================================================================
function generateKey() {
  const uuid = uuidv4().replace(/-/g, "").toUpperCase();
  return `1YN-${uuid.substring(0, 4)}-${uuid.substring(4, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}`;
}

// ======================================================================
// Google Sheets API 函式
// ======================================================================

/**
 * 寫入用戶購買資料至 Google Sheets
 */
async function sendUserDataToSheet(username, userId, purchaseItem, purchaseAmount) {
  try {
    const payload = {
      type: "user_data",
      username,
      user_id: userId,
      purchase_item: purchaseItem,
      purchase_amount: purchaseAmount,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 寫入用戶資料: ${username} (${userId})`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] 用戶資料回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] 用戶資料寫入失敗:`, err.message);
  }
}

/**
 * 寫入/更新金鑰至 Google Sheets（永久儲存）
 */
async function saveKeyToSheet(key, username, userId, status, hwid, machineCode) {
  try {
    const payload = {
      type: "key_save",
      key,
      username,
      user_id: userId,
      status: status || "已建立",
      hwid: hwid || "",
      machine_code: machineCode || "",
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 儲存金鑰: ${key.substring(0, 8)}... → ${username}`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] 金鑰儲存回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] 金鑰儲存失敗:`, err.message);
  }
}

/**
 * 更新 HWID 至 Google Sheets
 */
async function updateHwidOnSheet(key, encryptedHwid, machineCode) {
  try {
    const payload = {
      type: "hwid_update",
      key,
      hwid: encryptedHwid,
      machine_code: machineCode,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 更新 HWID: ${key.substring(0, 8)}...`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] HWID 更新回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] HWID 更新失敗:`, err.message);
  }
}

/**
 * 重置 HWID（清除 Google Sheets 中的 HWID 記錄）
 */
async function resetHwidOnSheet(key) {
  try {
    const payload = {
      type: "hwid_reset",
      key,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 重置 HWID: ${key.substring(0, 8)}...`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] HWID 重置回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] HWID 重置失敗:`, err.message);
  }
}

/**
 * 從 Google Sheets 載入所有金鑰（Bot 啟動時呼叫）
 */
async function loadKeysFromSheet() {
  try {
    const url = GOOGLE_SCRIPT_URL + "?action=load_keys";
    console.log("[試算表] 正在從 Google Sheets 載入金鑰...");
    const response = await fetch(url, { redirect: "follow" });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("[試算表] 載入金鑰回應解析失敗:", text.substring(0, 200));
      return;
    }

    if (data.status === "ok" && Array.isArray(data.keys)) {
      let loaded = 0;
      for (const k of data.keys) {
        if (k.key && k.user_id) {
          const keyData = {
            userId: k.user_id,
            username: k.username || "unknown",
            redeemed: k.status === "已兌換",
            hwid: k.hwid || null,
            machineCode: k.machine_code || null,
            createdAt: k.created_at || k.timestamp || new Date().toISOString()
          };
          keyStore.set(k.key, keyData);
          userKeyMap.set(k.user_id, k.key);
          loaded++;
        }
      }
      console.log(`[試算表] 已從 Google Sheets 載入 ${loaded} 組金鑰`);
    } else {
      console.log("[試算表] 未找到金鑰或格式不符:", data.message || "");
    }
  } catch (err) {
    console.error("[試算表] 載入金鑰失敗:", err.message);
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
      .toJSON(),
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("重新發送控制面板至 get-key 頻道（管理員專用）")
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
// Bot Ready — 載入金鑰 + 發送控制面板
// ======================================================================
client.once(Events.ClientReady, async () => {
  console.log(`[Bot] 已登入為 ${client.user.tag}`);

  // 從 Google Sheets 載入所有金鑰（永久儲存）
  await loadKeysFromSheet();

  await registerCommands();

  // 在 get key 頻道發送控制面板
  try {
    const channel = await client.channels.fetch(GETKEY_CHANNEL_ID);
    if (channel) {
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
      `1. 前往 ${DOWNLOAD_LINK} 下載程式\n` +
      `2. 將 \`1ynkeycheck.exe\` 和 \`yy_clicker.exe\` 放在同一資料夾\n` +
      `3. 前往 ${GETKEY_LINK} 點選【兌換密鑰】再按下 取得金鑰匙\n` +
      `4. 開啟 \`1ynkeycheck.exe\`\n` +
      `5. 輸入 ${GETKEY_LINK} 獲得的【金鑰匙】`
    )
    .setFooter({ text: "1yn autogetkey" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("btn_redeem_key")
      .setLabel("兌換密鑰")
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
// Interaction Handler
// ======================================================================
client.on(Events.InteractionCreate, async (interaction) => {
  if (isInteractionProcessed(interaction.id)) return;

  // ── Slash Command: /setup ──
  if (interaction.isChatInputCommand() && interaction.commandName === "setup") {
    const member = interaction.member;
    if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
      return interaction.reply({
        content: "❌ 您沒有權限使用此指令。僅限管理員使用。",
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = await client.channels.fetch(GETKEY_CHANNEL_ID);
      if (!channel) {
        return interaction.editReply({ content: "❌ 找不到 get-key 頻道。" });
      }
      await sendControlPanel(channel);
      return interaction.editReply({ content: "✅ 控制面板已重新發送至 get-key 頻道！" });
    } catch (err) {
      console.error("[setup] 發送控制面板失敗:", err.message);
      return interaction.editReply({ content: `❌ 發送失敗：${err.message}` });
    }
  }

  // ── Slash Command: /giveautoclick ──
  if (interaction.isChatInputCommand() && interaction.commandName === "giveautoclick") {
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

    if (userKeyMap.has(targetUser.id)) {
      const existingKey = userKeyMap.get(targetUser.id);
      return interaction.reply({
        content: `⚠ 該使用者已有金鑰：\`${existingKey}\``,
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    // 產生金鑰
    const key = generateKey();
    keyStore.set(key, {
      userId: targetUser.id,
      username: targetUser.username,
      redeemed: false,
      hwid: null,
      machineCode: null,
      createdAt: new Date().toISOString()
    });
    userKeyMap.set(targetUser.id, key);

    // 賦予身分組
    try {
      const guild = interaction.guild;
      const targetMember = await guild.members.fetch(targetUser.id);
      await targetMember.roles.add(AUTOCLICK_ROLE_ID);
    } catch (err) {
      console.error(`[角色] 賦予失敗:`, err.message);
    }

    // 私訊金鑰（更新後的說明）
    let dmSent = false;
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("🔑 您已獲得 1yn AutoClick 金鑰！")
        .setDescription(
          `恭喜！管理員已為您分配了一組專屬金鑰。\n\n` +
          `**您的金鑰：**\n\`\`\`\n${key}\n\`\`\`\n\n` +
          `**使用方式：**\n` +
          `前往 ${DOWNLOAD_LINK} 下載程式\n` +
          `將 \`1ynkeycheck.exe\` 和 \`yy_clicker.exe\` 放在同一資料夾\n` +
          `前往 ${GETKEY_LINK} 點選【兌換密鑰】再按下 取得金鑰匙\n` +
          `開啟 \`1ynkeycheck.exe\`\n` +
          `輸入 ${GETKEY_LINK} 獲得的【金鑰匙】\n\n` +
          `⚠ 請妥善保管此金鑰，切勿分享給他人。\n` +
          `⚠ 金鑰會綁定您的電腦硬體（HWID），如需更換電腦請在 Discord 重置 HWID。\n` +
          `⚠ 程式首次啟動時會在資料夾中建立 \`checkHWID\` 資料夾，請勿刪除。`
        )
        .setFooter({ text: "1yn autogetkey" })
        .setTimestamp();

      await targetUser.send({ embeds: [dmEmbed] });
      dmSent = true;
    } catch (err) {
      console.log(`[私訊] 無法私訊 ${targetUser.username}:`, err.message);
    }

    // 永久儲存金鑰至 Google Sheets
    await saveKeyToSheet(key, targetUser.username, targetUser.id, "已建立", "", "");

    // 寫入用戶購買資料
    await sendUserDataToSheet(targetUser.username, targetUser.id, "autoclick（管理員賦予）", "1500 tokens");

    const replyEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("✅ 金鑰已賦予")
      .addFields(
        { name: "使用者", value: `<@${targetUser.id}>`, inline: true },
        { name: "金鑰", value: `\`${key}\``, inline: true },
        { name: "金額", value: "1500 tokens", inline: true },
        { name: "私訊狀態", value: dmSent ? "✅ 已發送" : "❌ 發送失敗", inline: false }
      )
      .setFooter({ text: `由 ${interaction.user.username} 執行` })
      .setTimestamp();

    return interaction.editReply({ embeds: [replyEmbed] });
  }

  // ── 按鈕互動 ──
  if (interaction.isButton()) {
    const userId = interaction.user.id;

    switch (interaction.customId) {
      case "btn_redeem_key": {
        const modal = new ModalBuilder()
          .setCustomId("modal_redeem_key")
          .setTitle("兌換密鑰");

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
              `**HWID：** ${keyData.hwid ? "✅ 已綁定" : "⏳ 未綁定"}\n` +
              `**建立時間：** ${keyData.createdAt}\n\n` +
              `**使用方式：**\n` +
              `前往 ${DOWNLOAD_LINK} 下載程式\n` +
              `將 \`1ynkeycheck.exe\` 和 \`yy_clicker.exe\` 放在同一資料夾\n` +
              `前往 ${GETKEY_LINK} 點選【兌換密鑰】再按下 取得金鑰匙\n` +
              `開啟 \`1ynkeycheck.exe\`\n` +
              `輸入 ${GETKEY_LINK} 獲得的【金鑰匙】`
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
            return interaction.reply({ content: "✅ 您已擁有 autoclick 身分組！", ephemeral: true });
          }
          await member.roles.add(AUTOCLICK_ROLE_ID);
          return interaction.reply({ content: "✅ 已成功賦予 autoclick 身分組！", ephemeral: true });
        } catch (err) {
          return interaction.reply({ content: "❌ 無法賦予身分組，請聯繫管理員。", ephemeral: true });
        }
      }

      case "btn_reset_hwid": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({ content: "❌ 您尚未被分配金鑰。", ephemeral: true });
        }

        const key = userKeyMap.get(userId);
        const keyData = keyStore.get(key);
        if (keyData) {
          keyData.hwid = null;
          keyData.machineCode = null;
          keyStore.set(key, keyData);
        }

        // 同步重置 Google Sheets 中的 HWID
        await resetHwidOnSheet(key);

        return interaction.reply({
          content: "✅ HWID 已重置！\n\n下次啟動程式時將重新綁定。\n請刪除程式資料夾中的 `checkHWID` 資料夾，然後重新開啟 `1ynkeycheck.exe`。",
          ephemeral: true
        });
      }

      case "btn_get_stats": {
        if (!userKeyMap.has(userId)) {
          return interaction.reply({ content: "❌ 您尚未被分配金鑰。", ephemeral: true });
        }

        const key = userKeyMap.get(userId);
        const keyData = keyStore.get(key);

        const statsEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("📊 您的金鑰統計")
          .addFields(
            { name: "金鑰", value: `\`${key}\``, inline: false },
            { name: "狀態", value: keyData.redeemed ? "✅ 已兌換" : "⏳ 未兌換", inline: true },
            { name: "HWID", value: keyData.hwid ? "✅ 已綁定" : "未綁定", inline: true },
            { name: "機碼", value: keyData.machineCode ? `\`${keyData.machineCode.substring(0, 16)}...\`` : "未產生", inline: true },
            { name: "建立時間", value: keyData.createdAt, inline: false }
          )
          .setFooter({ text: "1yn autogetkey" })
          .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed], ephemeral: true });
      }
    }
  }

  // ── Modal 提交：兌換密鑰 ──
  if (interaction.isModalSubmit() && interaction.customId === "modal_redeem_key") {
    const rawInput = interaction.fields.getTextInputValue("input_key");
    const inputKey = rawInput.trim().toUpperCase().replace(/\s+/g, "");

    console.log(`[兌換] 用戶 ${interaction.user.username} (${interaction.user.id}) 輸入金鑰: ${inputKey}`);
    console.log(`[兌換] keyStore 大小: ${keyStore.size}, 包含此金鑰: ${keyStore.has(inputKey)}`);

    if (!keyStore.has(inputKey)) {
      // 嘗試遍歷 keyStore 找到匹配的金鑰（防止空格/格式差異）
      let matchedKey = null;
      for (const [storedKey] of keyStore) {
        if (storedKey.replace(/\s+/g, "").toUpperCase() === inputKey) {
          matchedKey = storedKey;
          break;
        }
      }
      if (!matchedKey) {
        console.log(`[兌換] 金鑰不存在。keyStore 中的金鑰: ${[...keyStore.keys()].map(k => k.substring(0, 12) + "...").join(", ")}`);
        return interaction.reply({
          content: "❌ 金鑰無效！請確認您輸入的金鑰是否正確。",
          ephemeral: true
        });
      }
      // 使用匹配到的金鑰
      console.log(`[兌換] 透過遍歷找到匹配金鑰: ${matchedKey}`);
    }

    const actualKey = keyStore.has(inputKey) ? inputKey : [...keyStore.keys()].find(k => k.replace(/\s+/g, "").toUpperCase() === inputKey);
    const keyData = keyStore.get(actualKey);

    if (keyData.userId !== interaction.user.id) {
      return interaction.reply({ content: "❌ 此金鑰不屬於您。", ephemeral: true });
    }

    if (keyData.redeemed) {
      return interaction.reply({ content: "⚠ 此金鑰已經兌換過了。", ephemeral: true });
    }

    keyData.redeemed = true;
    keyStore.set(actualKey, keyData);

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(AUTOCLICK_ROLE_ID);
    } catch (err) {
      console.error(`[角色] 兌換時賦予失敗:`, err.message);
    }

    await sendUserDataToSheet(interaction.user.username, interaction.user.id, "autoclick（金鑰兌換）", "1500 tokens");

    // 更新 Google Sheets 中的金鑰狀態為已兌換
    await saveKeyToSheet(actualKey, interaction.user.username, interaction.user.id, "已兌換", keyData.hwid || "", keyData.machineCode || "");

    return interaction.reply({
      content: `✅ 金鑰兌換成功！\n\n您的金鑰：\`${actualKey}\`\n已獲得 autoclick 身分組。\n\n請使用此金鑰在 \`1ynkeycheck.exe\` 啟動器中啟動程式。`,
      ephemeral: true
    });
  }
});

// ======================================================================
// 金鑰驗證 API（供 C++ 客戶端呼叫）
// ======================================================================
const http = require("http");
const API_PORT = process.env.PORT || 3000;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  if (method === "GET" && url.pathname === "/") {
    return sendJson(res, 200, {
      status: "ok",
      message: "1yn autogetkey bot is running",
      keys_count: keyStore.size
    });
  }

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", keys_count: keyStore.size });
  }

  // POST /api/verify-key — 金鑰驗證 + HWID 綁定
  if (method === "POST" && url.pathname === "/api/verify-key") {
    const body = await parseBody(req);
    const { key, hwid } = body;

    console.log(`[API] 驗證請求: key=${key ? key.substring(0, 8) + "..." : "null"}, hwid=${hwid ? hwid.substring(0, 16) + "..." : "null"}`);

    if (!key) return sendJson(res, 400, { valid: false, message: "未提供金鑰" });

    const normalizedKey = key.trim().toUpperCase();

    if (!keyStore.has(normalizedKey)) {
      console.log(`[API] 金鑰不存在 (keyStore: ${keyStore.size})`);
      return sendJson(res, 404, { valid: false, message: "金鑰無效" });
    }

    const keyData = keyStore.get(normalizedKey);

    // 加密 HWID
    const encryptedHwid = hwid ? encryptHWID(hwid) : null;

    // HWID 綁定檢查
    if (keyData.hwid && encryptedHwid && keyData.hwid !== encryptedHwid) {
      return sendJson(res, 403, {
        valid: false,
        message: "此金鑰已綁定至其他裝置。請在 Discord 重置 HWID。"
      });
    }

    // 首次綁定 HWID
    if (!keyData.hwid && encryptedHwid) {
      const mc = generateMachineCode(normalizedKey, encryptedHwid);
      keyData.hwid = encryptedHwid;
      keyData.machineCode = mc;
      keyStore.set(normalizedKey, keyData);

      // 同步至 Google Sheets
      await updateHwidOnSheet(normalizedKey, encryptedHwid, mc);
      console.log(`[API] HWID 已綁定: ${normalizedKey.substring(0, 8)}...`);
    }

    return sendJson(res, 200, {
      valid: true,
      message: "金鑰驗證成功",
      username: keyData.username,
      userId: keyData.userId,
      hwid_hash: keyData.hwid,
      machine_code: keyData.machineCode
    });
  }

  // POST /api/verify-hwid — 驗證 checkHWID 資料夾中的機碼
  if (method === "POST" && url.pathname === "/api/verify-hwid") {
    const body = await parseBody(req);
    const { key, hwid_hash, machine_code } = body;

    if (!key || !hwid_hash || !machine_code) {
      return sendJson(res, 400, { valid: false, message: "缺少必要參數" });
    }

    const normalizedKey = key.trim().toUpperCase();

    if (!keyStore.has(normalizedKey)) {
      return sendJson(res, 404, { valid: false, message: "金鑰無效" });
    }

    const keyData = keyStore.get(normalizedKey);

    // 驗證 HWID 雜湊和機碼是否匹配
    if (keyData.hwid !== hwid_hash) {
      return sendJson(res, 403, { valid: false, message: "HWID 不匹配" });
    }

    if (keyData.machineCode !== machine_code) {
      return sendJson(res, 403, { valid: false, message: "機碼不匹配" });
    }

    // 額外驗證機碼的完整性
    if (!verifyMachineCode(normalizedKey, hwid_hash, machine_code)) {
      return sendJson(res, 403, { valid: false, message: "機碼驗證失敗" });
    }

    return sendJson(res, 200, {
      valid: true,
      message: "HWID 驗證成功",
      username: keyData.username
    });
  }

  // GET /api/debug/keys
  if (method === "GET" && url.pathname === "/api/debug/keys") {
    const keys = [];
    for (const [key, data] of keyStore.entries()) {
      keys.push({
        key_prefix: key.substring(0, 8) + "...",
        username: data.username,
        redeemed: data.redeemed,
        hwid: data.hwid ? "已綁定" : "未綁定",
        createdAt: data.createdAt
      });
    }
    return sendJson(res, 200, { total: keyStore.size, keys });
  }

  sendJson(res, 404, { error: "Not found" });
});

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
