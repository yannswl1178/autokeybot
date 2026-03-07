/**
 * Google Apps Script — 接收 Discord Bot 用戶資料
 * 
 * 部署步驟：
 *   1. 前往 https://script.google.com/ 建立新專案
 *   2. 將此程式碼貼入 Code.gs
 *   3. 修改下方 SPREADSHEET_ID 為您的試算表 ID
 *   4. 點擊「部署」→「新增部署作業」→ 類型選「網頁應用程式」
 *   5. 執行身分：「我」
 *   6. 存取權限：「所有人」
 *   7. 部署後複製 Web App URL
 *
 * 試算表格式（第一列標題）：
 *   A: 使用者名稱
 *   B: 使用者ID
 *   C: 使用者購買項目
 *   D: 使用者購買金額
 *   E: 時間戳記
 */

// ⚠ 請替換為您的試算表 ID
var SPREADSHEET_ID = "YOUR_SPREADSHEET_ID_HERE";
var SHEET_NAME = "用戶資料";

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME);
    
    // 如果工作表不存在，建立並加入標題
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow([
        "使用者名稱",
        "使用者ID",
        "使用者購買項目",
        "使用者購買金額",
        "時間戳記"
      ]);
      // 設定標題格式
      var headerRange = sheet.getRange(1, 1, 1, 5);
      headerRange.setFontWeight("bold");
      headerRange.setBackground("#4a86c8");
      headerRange.setFontColor("#ffffff");
      sheet.setFrozenRows(1);
    }
    
    // 寫入資料
    sheet.appendRow([
      data.username       || "N/A",
      data.user_id        || "N/A",
      data.purchase_item  || "N/A",
      data.purchase_amount || "N/A",
      data.timestamp      || new Date().toISOString()
    ]);
    
    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok", message: "資料已寫入" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ status: "ok", message: "Bot 用戶資料接收端運行中" }))
    .setMimeType(ContentService.MimeType.JSON);
}
