/**
 * 1yn autogetkey — Discord 金鑰管理 Bot（中文版）
 * 
 * 雙 Key 系統：
 *   密鑰（Secret Key）：Bot 私訊給用戶，用於在 Discord【兌換密鑰】中兌換
 *   金鑰（License Key）：兌換成功後，用戶按【獲取金鑰】產生，用於 1ynkeycheck.exe
 *
 * 流程：
 *   1. /giveautoclick @用戶 → Bot 私訊一組「密鑰」
 *   2. 用戶按【兌換密鑰】→ 輸入密鑰 → 兌換成功 → 產生「金鑰」
 *   3. 用戶按【獲取金鑰】→ 私訊顯示「金鑰」（每次按都是同一組）
 *   4. 用戶在 1ynkeycheck.exe 輸入「金鑰」啟動
 *
 * 功能：
 *   1. /giveautoclick @使用者 — 管理員/代理賦予密鑰給指定使用者
 *   2. /setup — 管理員重新發送控制面板
 *   3. 兌換密鑰 按鈕 — 使用者輸入密鑰兌換，產生金鑰
 *   4. 獲取金鑰 按鈕 — 使用者取得金鑰（用於 exe）
 *   5. 獲取身分組 按鈕 — 檢查並賦予 autoclick 身分組
 *   6. 重置 HWID 按鈕 — 重置硬體綁定
 *   7. 查看統計 按鈕 — 查看個人狀態
 *
 * 永久儲存：密鑰、金鑰都保存在 Google Sheets，Bot 重啟時從 Sheets 載入
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
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxFID2dQMjC5xK228bkORU9ZYXICwtfdJ7gFSuOA3Xe69bULbpN9uKdmSLT_9xECW6usw/exec";

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

function encryptHWID(rawHwid) {
  return crypto.createHmac("sha256", HWID_SECRET)
    .update(rawHwid)
    .digest("hex");
}

function generateMachineCode(key, encryptedHwid) {
  const payload = `${key}:${encryptedHwid}:${HWID_SECRET}`;
  return crypto.createHash("sha512").update(payload).digest("hex").substring(0, 64);
}

function verifyMachineCode(key, encryptedHwid, machineCode) {
  const expected = generateMachineCode(key, encryptedHwid);
  return expected === machineCode;
}

// ======================================================================
// 產生密鑰（Secret Key）— 用於 Discord 兌換
// 格式：SEC-XXXX-XXXX-XXXX-XXXX
// ======================================================================
function generateSecretKey() {
  const uuid = uuidv4().replace(/-/g, "").toUpperCase();
  return `SEC-${uuid.substring(0, 4)}-${uuid.substring(4, 8)}-${uuid.substring(8, 12)}-${uuid.substring(12, 16)}`;
}

// ======================================================================
// 產生金鑰（License Key）— 用於 1ynkeycheck.exe
// 格式：1YN-XXXX-XXXX-XXXX-XXXX
// 同一用戶每次產生都是同一組（基於密鑰 + 用戶 ID 的確定性雜湊）
// ======================================================================
function generateLicenseKey(secretKey, userId) {
  const hash = crypto.createHmac("sha256", HWID_SECRET)
    .update(`${secretKey}:${userId}:license`)
    .digest("hex")
    .toUpperCase();
  return `1YN-${hash.substring(0, 4)}-${hash.substring(4, 8)}-${hash.substring(8, 12)}-${hash.substring(12, 16)}`;
}

// ======================================================================
// 資料庫（記憶體 + Google Sheets 永久儲存）
// ======================================================================
// secretStore: Map<secretKey, { userId, username, redeemed, licenseKey, createdAt }>
const secretStore = new Map();
// licenseStore: Map<licenseKey, { userId, username, secretKey, hwid, machineCode, sessionToken, createdAt }>
const licenseStore = new Map();
// userSecretMap: Map<userId, secretKey>
const userSecretMap = new Map();
// userLicenseMap: Map<userId, licenseKey>
const userLicenseMap = new Map();

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
// Google Sheets API 函式
// ======================================================================

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
 * 儲存密鑰+金鑰至 Google Sheets
 */
async function saveKeysToSheet(secretKey, licenseKey, username, userId, status, hwid, machineCode) {
  try {
    const payload = {
      type: "key_save",
      secret_key: secretKey,
      license_key: licenseKey || "",
      key: licenseKey || secretKey,  // 向後相容：API 用 license_key 驗證
      username,
      user_id: userId,
      status: status || "已建立",
      hwid: hwid || "",
      machine_code: machineCode || "",
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 儲存: 密鑰=${secretKey.substring(0, 8)}..., 金鑰=${licenseKey ? licenseKey.substring(0, 8) + "..." : "未產生"}`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] 儲存回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] 儲存失敗:`, err.message);
  }
}

async function updateHwidOnSheet(licenseKey, encryptedHwid, machineCode) {
  try {
    const payload = {
      type: "hwid_update",
      key: licenseKey,
      hwid: encryptedHwid,
      machine_code: machineCode,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 更新 HWID: ${licenseKey.substring(0, 8)}...`);
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

async function resetHwidOnSheet(licenseKey) {
  try {
    const payload = {
      type: "hwid_reset",
      key: licenseKey,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 重置 HWID: ${licenseKey.substring(0, 8)}...`);
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
 * 從 Google Sheets 刪除指定用戶的金鑰記錄
 */
async function deleteKeysFromSheet(secretKey, licenseKey, userId) {
  try {
    const payload = {
      type: "key_delete",
      secret_key: secretKey || "",
      license_key: licenseKey || "",
      user_id: userId,
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 刪除金鑰: user=${userId}, secret=${secretKey ? secretKey.substring(0, 8) + "..." : "N/A"}, license=${licenseKey ? licenseKey.substring(0, 8) + "..." : "N/A"}`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] 刪除金鑰回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] 刪除金鑰失敗:`, err.message);
  }
}

/**
 * 更新 session_token 至 Google Sheets
 */
async function updateSessionOnSheet(licenseKey, encryptedHwid, machineCode, sessionToken) {
  try {
    const payload = {
      type: "hwid_update",
      key: licenseKey,
      hwid: encryptedHwid || "",
      machine_code: machineCode || "",
      session_token: sessionToken || "",
      timestamp: new Date().toISOString()
    };
    console.log(`[試算表] 更新 Session Token: ${licenseKey.substring(0, 8)}...`);
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "follow"
    });
    const result = await response.text();
    console.log(`[試算表] Session Token 更新回應: ${result}`);
  } catch (err) {
    console.error(`[試算表] Session Token 更新失敗:`, err.message);
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
        if (!k.user_id) continue;

        const sKey = (k.secret_key || k.key || "").trim();
        const lKey = (k.license_key || "").trim().toUpperCase();
        const userId = k.user_id;
        const username = k.username || "unknown";
        const redeemed = k.status === "已兌換";
        const hwid = k.hwid || null;
        const mc = k.machine_code || null;
        const sessionToken = k.session_token || null;
        const createdAt = k.created_at || k.timestamp || new Date().toISOString();

        // 載入密鑰
        if (sKey && sKey.startsWith("SEC-")) {
          secretStore.set(sKey, {
            userId,
            username,
            redeemed,
            licenseKey: lKey || null,
            createdAt
          });
          userSecretMap.set(userId, sKey);
        }

        // 載入金鑰
        if (lKey && lKey.startsWith("1YN-")) {
          licenseStore.set(lKey, {
            userId,
            username,
            secretKey: sKey,
            hwid,
            machineCode: mc,
            sessionToken,
            createdAt
          });
          userLicenseMap.set(userId, lKey);
        }

        // 向後相容：如果舊資料只有 1YN- 格式的 key（沒有 secret_key）
        if (!sKey.startsWith("SEC-") && sKey.startsWith("1YN-")) {
          // 舊格式：把 1YN key 當作已兌換的 license key
          licenseStore.set(sKey, {
            userId,
            username,
            secretKey: "",
            hwid,
            machineCode: mc,
            sessionToken,
            createdAt
          });
          userLicenseMap.set(userId, sKey);
        }

        loaded++;
      }
      console.log(`[試算表] 已載入 ${loaded} 組資料 (密鑰: ${secretStore.size}, 金鑰: ${licenseStore.size})`);
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
      .setDescription("賦予指定使用者 autoclick 密鑰（管理員/代理專用）")
      .addUserOption(option =>
        option.setName("使用者")
          .setDescription("要賦予密鑰的使用者")
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("setup")
      .setDescription("重新發送控制面板至 get-key 頻道（管理員專用）")
      .toJSON(),
    new SlashCommandBuilder()
      .setName("removekey")
      .setDescription("移除指定使用者的金鑰匙和密鑰（管理員專用）")
      .addUserOption(option =>
        option.setName("使用者")
          .setDescription("要移除金鑰的使用者")
          .setRequired(true)
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName("listkeys")
      .setDescription("顯示指定使用者擁有的金鑰匙資訊（管理員專用）")
      .addUserOption(option =>
        option.setName("使用者")
          .setDescription("要查詢的使用者")
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
  await loadKeysFromSheet();
  await registerCommands();

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

    if (userSecretMap.has(targetUser.id)) {
      const existingSecret = userSecretMap.get(targetUser.id);
      return interaction.reply({
        content: `⚠ 該使用者已有密鑰：\`${existingSecret}\``,
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    // 產生密鑰（Secret Key）
    const secretKey = generateSecretKey();
    secretStore.set(secretKey, {
      userId: targetUser.id,
      username: targetUser.username,
      redeemed: false,
      licenseKey: null,
      createdAt: new Date().toISOString()
    });
    userSecretMap.set(targetUser.id, secretKey);

    // 私訊密鑰
    let dmSent = false;
    try {
      const dmEmbed = new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle("🔑 您已獲得 1yn AutoClick 密鑰！")
        .setDescription(
          `恭喜！管理員已為您分配了一組專屬密鑰。\n\n` +
          `**您的密鑰：**\n\`\`\`\n${secretKey}\n\`\`\`\n\n` +
          `**使用方式：**\n` +
          `前往 ${DOWNLOAD_LINK} 下載程式\n` +
          `將 \`1ynkeycheck.exe\` 和 \`yy_clicker.exe\` 放在同一資料夾\n` +
          `前往 ${GETKEY_LINK} 點選【兌換密鑰】再按下 取得金鑰匙\n` +
          `開啟 \`1ynkeycheck.exe\`\n` +
          `輸入 ${GETKEY_LINK} 獲得的【金鑰匙】\n\n` +
          `⚠ 請妥善保管此密鑰，切勿分享給他人。\n` +
          `⚠ 此密鑰用於在 Discord 兌換，兌換後可獲取程式用的金鑰。`
        )
        .setFooter({ text: "1yn autogetkey" })
        .setTimestamp();

      await targetUser.send({ embeds: [dmEmbed] });
      dmSent = true;
    } catch (err) {
      console.log(`[私訊] 無法私訊 ${targetUser.username}:`, err.message);
    }

    // 永久儲存密鑰至 Google Sheets
    await saveKeysToSheet(secretKey, "", targetUser.username, targetUser.id, "已建立", "", "");

    // 寫入用戶購買資料
    await sendUserDataToSheet(targetUser.username, targetUser.id, "autoclick（管理員賦予）", "1500 tokens");

    const replyEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("✅ 密鑰已賦予")
      .addFields(
        { name: "使用者", value: `<@${targetUser.id}>`, inline: true },
        { name: "密鑰", value: `\`${secretKey}\``, inline: true },
        { name: "金額", value: "1500 tokens", inline: true },
        { name: "私訊狀態", value: dmSent ? "✅ 已發送" : "❌ 發送失敗", inline: false }
      )
      .setFooter({ text: `由 ${interaction.user.username} 執行` })
      .setTimestamp();

    return interaction.editReply({ embeds: [replyEmbed] });
  }

  // ── Slash Command: /removekey ──
  if (interaction.isChatInputCommand() && interaction.commandName === "removekey") {
    const member = interaction.member;
    if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
      return interaction.reply({
        content: "\u274C 您沒有權限使用此指令。僅限管理員使用。",
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser("使用者");
    if (!targetUser) {
      return interaction.reply({ content: "\u274C 請指定一個使用者。", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const userId = targetUser.id;
    const secretKey = userSecretMap.get(userId) || null;
    const licenseKey = userLicenseMap.get(userId) || null;

    if (!secretKey && !licenseKey) {
      return interaction.editReply({
        content: `\u274C 使用者 <@${userId}> 沒有任何金鑰或密鑰記錄。`
      });
    }

    // 從記憶體中移除
    if (secretKey) {
      secretStore.delete(secretKey);
      userSecretMap.delete(userId);
    }
    if (licenseKey) {
      licenseStore.delete(licenseKey);
      userLicenseMap.delete(userId);
    }

    // 從 Google Sheets 中刪除
    await deleteKeysFromSheet(secretKey, licenseKey, userId);

    // 移除身分組
    try {
      const guildMember = await interaction.guild.members.fetch(userId);
      if (guildMember.roles.cache.has(AUTOCLICK_ROLE_ID)) {
        await guildMember.roles.remove(AUTOCLICK_ROLE_ID);
      }
    } catch (err) {
      console.error(`[角色] 移除失敗:`, err.message);
    }

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle("\u{1F5D1}\uFE0F 金鑰已移除")
      .addFields(
        { name: "使用者", value: `<@${userId}>`, inline: true },
        { name: "密鑰", value: secretKey ? `\`${secretKey}\`` : "（無）", inline: true },
        { name: "金鑰", value: licenseKey ? `\`${licenseKey}\`` : "（無）", inline: true }
      )
      .setFooter({ text: `由 ${interaction.user.username} 執行` })
      .setTimestamp();

    console.log(`[removekey] 已移除 ${targetUser.username} (${userId}) 的所有金鑰`);
    return interaction.editReply({ embeds: [embed] });
  }

  // ── Slash Command: /listkeys ──
  if (interaction.isChatInputCommand() && interaction.commandName === "listkeys") {
    const member = interaction.member;
    if (!member.roles.cache.has(ADMIN_ROLE_ID)) {
      return interaction.reply({
        content: "\u274C 您沒有權限使用此指令。僅限管理員使用。",
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser("使用者");
    if (!targetUser) {
      return interaction.reply({ content: "\u274C 請指定一個使用者。", ephemeral: true });
    }

    const userId = targetUser.id;
    const secretKey = userSecretMap.get(userId) || null;
    const licenseKey = userLicenseMap.get(userId) || null;

    if (!secretKey && !licenseKey) {
      return interaction.reply({
        content: `\u274C 使用者 <@${userId}> 沒有任何金鑰或密鑰記錄。`,
        ephemeral: true
      });
    }

    const secretData = secretKey ? secretStore.get(secretKey) : null;
    const licenseData = licenseKey ? licenseStore.get(licenseKey) : null;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`\u{1F511} ${targetUser.username} 的金鑰資訊`)
      .addFields(
        { name: "密鑰（Secret Key）", value: secretKey ? `\`${secretKey}\`` : "（無）", inline: false },
        { name: "金鑰（License Key）", value: licenseKey ? `\`${licenseKey}\`` : "（尚未兌換）", inline: false },
        { name: "兌換狀態", value: secretData && secretData.redeemed ? "\u2705 已兌換" : "\u23F3 未兌換", inline: true },
        { name: "HWID", value: licenseData && licenseData.hwid ? "\u2705 已綁定" : "\u26A0 未綁定", inline: true },
        { name: "Session Token", value: licenseData && licenseData.sessionToken ? "\u2705 已設定" : "\u26A0 未設定", inline: true },
        { name: "建立時間", value: secretData ? secretData.createdAt : (licenseData ? licenseData.createdAt : "未知"), inline: false }
      )
      .setFooter({ text: `查詢者: ${interaction.user.username}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
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
          .setLabel("請輸入您的密鑰")
          .setPlaceholder("例如：SEC-ABCD-1234-EFGH-5678")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(keyInput);
        modal.addComponents(row);
        return interaction.showModal(modal);
      }

      case "btn_get_key": {
        // 必須先兌換密鑰才能獲取金鑰
        if (!userLicenseMap.has(userId)) {
          // 檢查是否有密鑰但尚未兌換
          if (userSecretMap.has(userId)) {
            return interaction.reply({
              content: "❌ 您尚未兌換密鑰。請先點擊【兌換密鑰】輸入您的密鑰進行兌換。",
              ephemeral: true
            });
          }
          return interaction.reply({
            content: "❌ 您尚未被分配密鑰。請聯繫管理員或代理獲取授權。",
            ephemeral: true
          });
        }

        const licenseKey = userLicenseMap.get(userId);
        const licenseData = licenseStore.get(licenseKey);

        // 直接以 ephemeral 回覆顯示金鑰（僅用戶可見）
        const keyEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("🔑 您的 1yn AutoClick 金鑰")
          .setDescription(
            `**金鑰（用於 1ynkeycheck.exe）：**\n\`\`\`\n${licenseKey}\n\`\`\`\n\n` +
            `**HWID：** ${licenseData.hwid ? "✅ 已綁定" : "⏳ 未綁定"}\n` +
            `**建立時間：** ${licenseData.createdAt}\n\n` +
            `**使用方式：**\n` +
            `前往 ${DOWNLOAD_LINK} 下載程式\n` +
            `將 \`1ynkeycheck.exe\` 和 \`yy_clicker.exe\` 放在同一資料夾\n` +
            `開啟 \`1ynkeycheck.exe\`\n` +
            `輸入上方的【金鑰】即可啟動\n\n` +
            `⚠ 請妥善保管此金鑰，切勿分享給他人。\n` +
            `⚠ 金鑰會綁定您的電腦硬體（HWID），如需更換電腦請在 Discord 重置 HWID。`
          )
          .setFooter({ text: "1yn autogetkey" })
          .setTimestamp();

        return interaction.reply({
          embeds: [keyEmbed],
          ephemeral: true
        });
      }

      case "btn_get_role": {
        if (!userSecretMap.has(userId) && !userLicenseMap.has(userId)) {
          return interaction.reply({
            content: "❌ 您尚未被分配密鑰，無法獲取身分組。",
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
        if (!userLicenseMap.has(userId)) {
          return interaction.reply({ content: "❌ 您尚未擁有金鑰，無法重置 HWID。", ephemeral: true });
        }

        const licenseKey = userLicenseMap.get(userId);
        const licenseData = licenseStore.get(licenseKey);

        // 12 小時冷卻機制
        if (licenseData && licenseData.lastHwidReset) {
          const cooldownMs = 12 * 60 * 60 * 1000; // 12 小時
          const elapsed = Date.now() - new Date(licenseData.lastHwidReset).getTime();
          if (elapsed < cooldownMs) {
            const remainMs = cooldownMs - elapsed;
            const remainH = Math.floor(remainMs / (60 * 60 * 1000));
            const remainM = Math.ceil((remainMs % (60 * 60 * 1000)) / (60 * 1000));
            return interaction.reply({
              content: `⏳ HWID 重置冷卻中！\n\n距離下次可重置還需 **${remainH} 小時 ${remainM} 分鐘**。\n（每 12 小時只能重置一次）`,
              ephemeral: true
            });
          }
        }

        if (licenseData) {
          licenseData.hwid = null;
          licenseData.machineCode = null;
          licenseData.sessionToken = null;
          licenseData.lastHwidReset = new Date().toISOString();
          licenseStore.set(licenseKey, licenseData);
        }

        await resetHwidOnSheet(licenseKey);

        return interaction.reply({
          content: "✅ HWID 已重置！\n\n# 每 12 小時只能重置一次\n\n下次啟動程式時將重新綁定。\n請刪除程式資料夾中的 `checkHWID` 資料夾，然後重新開啟 `1ynkeycheck.exe`。",
          ephemeral: true
        });
      }

      case "btn_get_stats": {
        if (!userSecretMap.has(userId) && !userLicenseMap.has(userId)) {
          return interaction.reply({ content: "❌ 您尚未被分配密鑰。", ephemeral: true });
        }

        const secretKey = userSecretMap.get(userId) || "（無）";
        const licenseKey = userLicenseMap.get(userId) || "（尚未兌換）";
        const secretData = secretStore.get(secretKey);
        const licenseData = licenseStore.get(licenseKey);

        const statsEmbed = new EmbedBuilder()
          .setColor(0x5865F2)
          .setTitle("📊 您的金鑰統計")
          .addFields(
            { name: "密鑰（Discord 兌換用）", value: `\`${secretKey}\``, inline: false },
            { name: "金鑰（exe 啟動用）", value: licenseKey.startsWith("1YN-") ? `\`${licenseKey}\`` : licenseKey, inline: false },
            { name: "兌換狀態", value: secretData && secretData.redeemed ? "✅ 已兌換" : "⏳ 未兌換", inline: true },
            { name: "HWID", value: licenseData && licenseData.hwid ? "✅ 已綁定" : "未綁定", inline: true },
            { name: "建立時間", value: secretData ? secretData.createdAt : (licenseData ? licenseData.createdAt : "未知"), inline: false }
          )
          .setFooter({ text: "1yn autogetkey" })
          .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed], ephemeral: true });
      }
    }
  }

  // ── Modal 提交：兌換密鑰 ──
  if (interaction.isModalSubmit() && interaction.customId === "modal_redeem_key") {
    // 立即 deferReply 避免互動逾時導致用戶重試產生重複日誌
    await interaction.deferReply({ ephemeral: true });

    const rawInput = interaction.fields.getTextInputValue("input_key");
    const inputKey = rawInput.trim().toUpperCase().replace(/\s+/g, "");

    console.log(`[兌換] 用戶 ${interaction.user.username} (${interaction.user.id}) 輸入密鑰: ${inputKey}`);
    console.log(`[兌換] secretStore 大小: ${secretStore.size}, 包含此密鑰: ${secretStore.has(inputKey)}`);

    // 查找密鑰（精確匹配 + 容錯匹配）
    let actualSecretKey = null;
    if (secretStore.has(inputKey)) {
      actualSecretKey = inputKey;
    } else {
      for (const [storedKey] of secretStore) {
        if (storedKey.replace(/\s+/g, "").toUpperCase() === inputKey) {
          actualSecretKey = storedKey;
          break;
        }
      }
    }

    if (!actualSecretKey) {
      console.log(`[兌換] 密鑰不存在。secretStore: ${[...secretStore.keys()].map(k => k.substring(0, 12) + "...").join(", ")}`);
      return interaction.editReply({
        content: "❌ 密鑰無效！請確認您輸入的密鑰是否正確。"
      });
    }

    const secretData = secretStore.get(actualSecretKey);

    if (secretData.userId !== interaction.user.id) {
      return interaction.editReply({ content: "❌ 此密鑰不屬於您。" });
    }

    if (secretData.redeemed) {
      // 已兌換過，告知用戶去按【獲取金鑰】
      return interaction.editReply({
        content: "⚠ 此密鑰已經兌換過了。請點擊【獲取金鑰】按鈕來取得您的程式金鑰。"
      });
    }

    // 兌換成功 → 產生金鑰（License Key）
    const licenseKey = generateLicenseKey(actualSecretKey, interaction.user.id);

    // 更新密鑰狀態
    secretData.redeemed = true;
    secretData.licenseKey = licenseKey;
    secretStore.set(actualSecretKey, secretData);

    // 建立金鑰資料
    licenseStore.set(licenseKey, {
      userId: interaction.user.id,
      username: interaction.user.username,
      secretKey: actualSecretKey,
      hwid: null,
      machineCode: null,
      createdAt: new Date().toISOString()
    });
    userLicenseMap.set(interaction.user.id, licenseKey);

    // 賦予身分組
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(AUTOCLICK_ROLE_ID);
    } catch (err) {
      console.error(`[角色] 兌換時賦予失敗:`, err.message);
    }

    // 更新 Google Sheets（僅儲存金鑰資料，不重複寫入用戶資料）
    await saveKeysToSheet(actualSecretKey, licenseKey, interaction.user.username, interaction.user.id, "已兌換", "", "");

    console.log(`[兌換] 成功！密鑰=${actualSecretKey}, 金鑰=${licenseKey}, 用戶=${interaction.user.username}`);

    return interaction.editReply({
      content: `✅ 密鑰兌換成功！\n\n已獲得 autoclick 身分組。\n\n請點擊【獲取金鑰】按鈕來取得您的程式啟動金鑰。`
    });
  }
});

// ======================================================================
// 金鑰驗證 API（供 C++ 客戶端呼叫）— 只驗證 License Key（1YN- 格式）
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
      secrets_count: secretStore.size,
      licenses_count: licenseStore.size
    });
  }

  if (method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      secrets_count: secretStore.size,
      licenses_count: licenseStore.size
    });
  }

  // POST /api/verify-key — 金鑰驗證 + HWID 綁定（只接受 1YN- 格式的 License Key）
  if (method === "POST" && url.pathname === "/api/verify-key") {
    const body = await parseBody(req);
    const { key, hwid } = body;

    console.log(`[API] 驗證請求: key=${key ? key.substring(0, 8) + "..." : "null"}, hwid=${hwid ? hwid.substring(0, 16) + "..." : "null"}`);

    if (!key) return sendJson(res, 400, { valid: false, message: "未提供金鑰" });

    const normalizedKey = key.trim().toUpperCase();

    // 拒絕密鑰（SEC- 格式）直接用於 exe
    if (normalizedKey.startsWith("SEC-")) {
      return sendJson(res, 403, {
        valid: false,
        message: "此為密鑰，不可直接用於程式。請先在 Discord 兌換密鑰，再按【獲取金鑰】取得程式金鑰。"
      });
    }

    if (!licenseStore.has(normalizedKey)) {
      // 金鑰不在記憶體中 → 嘗試從 Google Sheets 重新載入
      console.log(`[API] 金鑰不存在於記憶體 (licenseStore: ${licenseStore.size})，嘗試重新載入...`);
      try {
        await loadKeysFromSheet();
      } catch (e) {
        console.error("[API] 重新載入失敗:", e.message);
      }
      if (!licenseStore.has(normalizedKey)) {
        console.log(`[API] 重新載入後仍找不到金鑰 (licenseStore: ${licenseStore.size})`);
        return sendJson(res, 404, { valid: false, message: "金鑰無效" });
      }
      console.log(`[API] 重新載入後找到金鑰`);
    }

    const licenseData = licenseStore.get(normalizedKey);

    // 加密 HWID
    const encryptedHwid = hwid ? encryptHWID(hwid) : null;

    // HWID 綁定檢查
    if (licenseData.hwid && encryptedHwid && licenseData.hwid !== encryptedHwid) {
      return sendJson(res, 403, {
        valid: false,
        message: "此金鑰已綁定至其他裝置。請在 Discord 重置 HWID。"
      });
    }

    // 首次綁定 HWID
    if (!licenseData.hwid && encryptedHwid) {
      const mc = generateMachineCode(normalizedKey, encryptedHwid);
      licenseData.hwid = encryptedHwid;
      licenseData.machineCode = mc;
      licenseStore.set(normalizedKey, licenseData);

      await updateHwidOnSheet(normalizedKey, encryptedHwid, mc);
      console.log(`[API] HWID 已綁定: ${normalizedKey.substring(0, 8)}...`);
    }

    return sendJson(res, 200, {
      valid: true,
      message: "金鑰驗證成功",
      username: licenseData.username,
      userId: licenseData.userId,
      hwid_hash: licenseData.hwid,
      machine_code: licenseData.machineCode
    });
  }

  // POST /api/verify-hwid — 驗證 checkHWID 資料夾中的機碼 + session_token
  if (method === "POST" && url.pathname === "/api/verify-hwid") {
    const body = await parseBody(req);
    const { key, hwid_hash, machine_code, session_token } = body;

    if (!key || !hwid_hash || !machine_code) {
      return sendJson(res, 400, { valid: false, message: "缺少必要參數" });
    }

    const normalizedKey = key.trim().toUpperCase();

    if (!licenseStore.has(normalizedKey)) {
      // 嘗試從 Google Sheets 重新載入
      console.log(`[API] verify-hwid: 金鑰不存在於記憶體，嘗試重新載入...`);
      try {
        await loadKeysFromSheet();
      } catch (e) {
        console.error("[API] 重新載入失敗:", e.message);
      }
      if (!licenseStore.has(normalizedKey)) {
        return sendJson(res, 404, { valid: false, message: "金鑰無效" });
      }
    }

    const licenseData = licenseStore.get(normalizedKey);

    // HWID 已重置（null）→ 重新綁定
    if (!licenseData.hwid) {
      // 驗證 machine_code 有效性
      if (!verifyMachineCode(normalizedKey, hwid_hash, machine_code)) {
        return sendJson(res, 403, { valid: false, message: "\u6A5F\u78BC\u9A57\u8B49\u5931\u6557" });
      }
      // 重新綁定 HWID
      licenseData.hwid = hwid_hash;
      licenseData.machineCode = machine_code;
      if (session_token) licenseData.sessionToken = session_token;
      licenseStore.set(normalizedKey, licenseData);
      await updateHwidOnSheet(normalizedKey, hwid_hash, machine_code);
      if (session_token) {
        await updateSessionOnSheet(normalizedKey, hwid_hash, machine_code, session_token);
      }
      console.log(`[API] HWID \u5DF2\u91CD\u65B0\u7D81\u5B9A (verify-hwid): ${normalizedKey.substring(0, 8)}...`);
      return sendJson(res, 200, {
        valid: true,
        message: "HWID \u5DF2\u91CD\u65B0\u7D81\u5B9A",
        username: licenseData.username
      });
    }

    if (licenseData.hwid !== hwid_hash) {
      return sendJson(res, 403, { valid: false, message: "HWID \u4E0D\u5339\u914D" });
    }

    if (licenseData.machineCode !== machine_code) {
      return sendJson(res, 403, { valid: false, message: "\u6A5F\u78BC\u4E0D\u5339\u914D" });
    }

    if (!verifyMachineCode(normalizedKey, hwid_hash, machine_code)) {
      return sendJson(res, 403, { valid: false, message: "\u6A5F\u78BC\u9A57\u8B49\u5931\u6557" });
    }

    // Session Token 驗證（如果伺服器端有存 session_token）
    if (licenseData.sessionToken && session_token) {
      if (licenseData.sessionToken !== session_token) {
        console.log(`[API] Session Token 不匹配: ${normalizedKey.substring(0, 8)}... (expected: ${licenseData.sessionToken.substring(0, 8)}..., got: ${session_token.substring(0, 8)}...)`);
        return sendJson(res, 403, { valid: false, message: "Session Token 不匹配，可能已被複製到其他電腦" });
      }
    }

    return sendJson(res, 200, {
      valid: true,
      message: "HWID 驗證成功",
      username: licenseData.username
    });
  }

  // POST /api/update-session — 更新 session_token（launcher 在綁定 HWID 時呼叫）
  if (method === "POST" && url.pathname === "/api/update-session") {
    const body = await parseBody(req);
    const { key, hwid_hash, machine_code, session_token } = body;

    if (!key || !session_token) {
      return sendJson(res, 400, { valid: false, message: "缺少必要參數" });
    }

    const normalizedKey = key.trim().toUpperCase();

    if (!licenseStore.has(normalizedKey)) {
      return sendJson(res, 404, { valid: false, message: "金鑰無效" });
    }

    const licenseData = licenseStore.get(normalizedKey);

    // 更新 session_token
    licenseData.sessionToken = session_token;
    if (hwid_hash) licenseData.hwid = hwid_hash;
    if (machine_code) licenseData.machineCode = machine_code;
    licenseStore.set(normalizedKey, licenseData);

    // 同步到 Google Sheets
    await updateSessionOnSheet(normalizedKey, hwid_hash || licenseData.hwid, machine_code || licenseData.machineCode, session_token);

    console.log(`[API] Session Token 已更新: ${normalizedKey.substring(0, 8)}... token=${session_token.substring(0, 8)}...`);

    return sendJson(res, 200, {
      valid: true,
      message: "Session Token 已更新"
    });
  }

  // GET /api/debug/keys
  if (method === "GET" && url.pathname === "/api/debug/keys") {
    const secrets = [];
    for (const [key, data] of secretStore.entries()) {
      secrets.push({
        secret_prefix: key.substring(0, 12) + "...",
        username: data.username,
        redeemed: data.redeemed,
        has_license: !!data.licenseKey
      });
    }
    const licenses = [];
    for (const [key, data] of licenseStore.entries()) {
      licenses.push({
        license_prefix: key.substring(0, 12) + "...",
        username: data.username,
        hwid: data.hwid ? "已綁定" : "未綁定",
        session_token: data.sessionToken ? "已設定" : "未設定"
      });
    }
    return sendJson(res, 200, {
      total_secrets: secretStore.size,
      total_licenses: licenseStore.size,
      secrets,
      licenses
    });
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
