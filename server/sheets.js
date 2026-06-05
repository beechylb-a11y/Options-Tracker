import { google } from 'googleapis';

// ================================================================
//  GOOGLE SHEETS SERVICE
//  Handles all interactions with the Google Sheet backend.
//  Sheet tabs: Config | Trades | TradeTracker | Decisions | BattingAverage | Journal
// ================================================================

let sheetsClient = null;
let authClient = null;

// ---- Auth setup ----
export function initAuth(credentials) {
  authClient = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri
  );
  return authClient;
}

export function getAuthUrl() {
  return authClient.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
}

export async function handleAuthCallback(code) {
  const { tokens } = await authClient.getToken(code);
  authClient.setCredentials(tokens);
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return tokens;
}

export function setTokens(tokens) {
  authClient.setCredentials(tokens);
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
}

function getSheets() {
  if (!sheetsClient) throw new Error('Not authenticated');
  return sheetsClient;
}

const SHEET_ID = () => process.env.SPREADSHEET_ID;

// ================================================================
//  SHEET STRUCTURE -- auto-create tabs if missing
// ================================================================
const REQUIRED_TABS = {
  Config: [['Setting', 'Value'],
    ['currentBankroll', '3000'],
    ['startingBankroll', '3000'],
    ['maxDailyLoss', '300'],
    ['maxOpenRisk', '450'],
    ['riskPerContract', '435'],
    ['winAmount', '65']
  ],
  Trades: [['Date/Time', 'Order #', 'Strategy (OIC)', 'Underlying', 'Instrument Type',
    'Description', 'Subcode', 'Symbol', 'Expiry', 'Strike', 'Call/Put',
    'Quantity', 'Avg Price', 'Fees', 'Net Value', 'Currency']],
  TradeTracker: [['Order #', 'Entry Date', 'Expiry Date', 'Close Date', 'Strategy (OIC)',
    'Underlying', 'Qty', 'Net Credit ($)', 'Total P&L ($)', 'W / L',
    'Cumul BA (%)', 'Status']],
  Decisions: [['Timestamp', 'Engine', 'Underlying', 'Strategy', 'Direction', 'Contracts',
    'Kelly $', 'POP Margin', 'Setup Score', 'Setup Grade', 'Regime',
    'Wing Strikes', 'Market Behaviour', 'Notes',
    'Price', 'VIX', 'VIX1D', 'IV', 'IVR', 'EM', 'Matched Trade',
    'Status', 'Close Date', 'Close Price', 'Actual P&L', 'Trade Notes']],
  BattingAverage: [['Metric', 'Value'],
    ['Total Trades', '0'],
    ['Batting Average', '0'],
    ['Avg Win', '0'],
    ['Avg Loss', '0'],
    ['Expectancy', '0'],
    ['Total P&L', '0']
  ],
  Journal: [['Date', 'Day P&L', 'Trades Count', 'Win Count', 'Loss Count', 'Notes', 'Week Number']]
};

export async function ensureSheetStructure() {
  const sheets = getSheets();
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const existingTabs = spreadsheet.data.sheets.map(s => s.properties.title);

  for (const [tabName, headerData] of Object.entries(REQUIRED_TABS)) {
    if (!existingTabs.includes(tabName)) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID(),
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }]
        }
      });
    }
    // Always update headers to ensure schema matches (handles upgrades)
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `${tabName}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: headerData }
    });
  }
}

// ================================================================
//  CONFIG
// ================================================================
export async function getConfig() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Config!A:B'
  });
  const rows = res.data.values || [];
  const config = {};
  rows.slice(1).forEach(([key, val]) => {
    if (key) config[key] = isNaN(val) ? val : parseFloat(val);
  });
  return config;
}

export async function updateConfig(key, value) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Config!A:B'
  });
  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => r[0] === key);
  if (rowIndex >= 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `Config!B${rowIndex + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[value]] }
    });
  }
}

// ================================================================
//  TRADES (raw legs from tastytrade CSV)
// ================================================================
export async function appendTrades(rows) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: 'Trades!A1',
    valueInputOption: 'RAW',
    requestBody: { values: rows }
  });
  return rows.length;
}

export async function getTrades() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Trades!A:P'
  });
  return res.data.values || [];
}

export async function clearTrades() {
  const sheets = getSheets();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID(),
    range: 'Trades!A2:P'
  });
}

// ================================================================
//  TRADE TRACKER (grouped positions)
// ================================================================
export async function writeTradeTracker(rows) {
  const sheets = getSheets();
  // Clear existing data (keep header)
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID(),
    range: 'TradeTracker!A2:L'
  });
  if (rows.length > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: 'TradeTracker!A2',
      valueInputOption: 'RAW',
      requestBody: { values: rows }
    });
  }
  return rows.length;
}

export async function getTradeTracker() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'TradeTracker!A:L'
  });
  return res.data.values || [];
}

export async function appendTradeTrackerRow(row) {
  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: 'TradeTracker!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

export async function updateTradeTrackerRow(rowIndex, updates) {
  const sheets = getSheets();
  // Read current row
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `TradeTracker!A${rowIndex}:L${rowIndex}`
  });
  const current = res.data.values?.[0] || [];
  // Headers: Order#(0), EntryDate(1), ExpiryDate(2), CloseDate(3), Strategy(4),
  //          Underlying(5), Qty(6), NetCredit(7), TotalP&L(8), W/L(9), CumulBA(10), Status(11)
  const row = [...current];
  while (row.length < 12) row.push('');
  if (updates.entryDate !== undefined) row[1] = updates.entryDate;
  if (updates.expiryDate !== undefined) row[2] = updates.expiryDate;
  if (updates.closeDate !== undefined) row[3] = updates.closeDate;
  if (updates.strategy !== undefined) row[4] = updates.strategy;
  if (updates.underlying !== undefined) row[5] = updates.underlying;
  if (updates.qty !== undefined) row[6] = updates.qty;
  if (updates.netCredit !== undefined) row[7] = updates.netCredit;
  if (updates.totalPnl !== undefined) {
    row[8] = updates.totalPnl;
    row[9] = parseFloat(updates.totalPnl) >= 0 ? 'Win' : 'Loss';
  }
  if (updates.status !== undefined) row[11] = updates.status;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `TradeTracker!A${rowIndex}:L${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

export async function deleteTradeTrackerRow(rowIndex) {
  const sheets = getSheets();
  // Get the sheet ID for TradeTracker tab
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID() });
  const tab = spreadsheet.data.sheets.find(s => s.properties.title === 'TradeTracker');
  if (!tab) throw new Error('TradeTracker tab not found');
  const sheetId = tab.properties.sheetId;
  // Delete the row (rowIndex is 1-based)
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex - 1, // 0-based
            endIndex: rowIndex        // exclusive
          }
        }
      }]
    }
  });
}

// ================================================================
//  DECISIONS (logged from decision engine)
// ================================================================
export async function logDecision(decision) {
  const sheets = getSheets();
  const row = [
    decision.timestamp || new Date().toISOString(),
    decision.engine || '0DTE',
    decision.underlying || '',
    decision.strategy || '',
    decision.direction || '',
    decision.contracts || 0,
    decision.kellyDollar || '',
    decision.popMargin || '',
    decision.setupScore || '',
    decision.setupGrade || '',
    decision.regime || '',
    decision.wingStrikes || '',
    decision.marketBehaviour || '',
    decision.notes || '',
    decision.price || '',
    decision.vix || '',
    decision.vix1d || '',
    decision.iv || '',
    decision.ivr || '',
    decision.em || '',
    '',  // Matched Trade -- filled during CSV comparison
    'Open',  // Status
    '',  // Close Date
    '',  // Close Price
    '',  // Actual P&L
    ''   // Trade Notes
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: 'Decisions!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
  return row;
}

export async function getDecisions() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Decisions!A:Z'
  });
  return res.data.values || [];
}

// ================================================================
//  BATTING AVERAGE / STATS
// ================================================================
export async function updateBattingAverage(stats) {
  const sheets = getSheets();
  const values = [
    ['Total Trades', stats.totalTrades || 0],
    ['Batting Average', stats.battingAvg || 0],
    ['Avg Win', stats.avgWin || 0],
    ['Avg Loss', stats.avgLoss || 0],
    ['Expectancy', stats.expectancy || 0],
    ['Total P&L', stats.totalPnl || 0]
  ];
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: 'BattingAverage!A2',
    valueInputOption: 'RAW',
    requestBody: { values }
  });
}

export async function getBattingAverage() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'BattingAverage!A:B'
  });
  const rows = res.data.values || [];
  const stats = {};
  rows.slice(1).forEach(([key, val]) => {
    if (key) stats[key.replace(/\s/g, '')] = isNaN(val) ? val : parseFloat(val);
  });
  return stats;
}

// ================================================================
//  JOURNAL (daily P&L entries)
// ================================================================
export async function appendJournalEntry(entry) {
  const sheets = getSheets();
  const row = [
    entry.date,
    entry.dayPnl || 0,
    entry.tradesCount || 0,
    entry.winCount || 0,
    entry.lossCount || 0,
    entry.notes || '',
    entry.weekNumber || ''
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID(),
    range: 'Journal!A1',
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

export async function getJournal() {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Journal!A:G'
  });
  return res.data.values || [];
}

// ================================================================
//  TRADE TICKET LIFECYCLE
// ================================================================
export async function closeTradeTicket(rowIndex, closeData) {
  const sheets = getSheets();
  // Columns: V=Status(22), W=Close Date(23), X=Close Price(24), Y=Actual P&L(25)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `Decisions!V${rowIndex}:Y${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[
      'Closed',
      closeData.closeDate || new Date().toISOString().split('T')[0],
      closeData.closePrice || '',
      closeData.actualPnl || 0
    ]] }
  });
}

export async function updateTradeNotes(rowIndex, notes) {
  const sheets = getSheets();
  // Column Z = Trade Notes (26)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `Decisions!Z${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[notes]] }
  });
}

export async function updateTradeStatus(rowIndex, status) {
  const sheets = getSheets();
  // Column V = Status (22)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `Decisions!V${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[status]] }
  });
}

// ================================================================
//  UPDATE TRACKER STRATEGY -- manual categorisation
// ================================================================
export async function updateTrackerStrategy(rowIndex, strategy) {
  const sheets = getSheets();
  // Column E = Strategy (OIC) = column 5 (1-based)
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `TradeTracker!E${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[strategy]] }
  });
}

// Also update the raw Trades sheet for matching legs
export async function updateTradesStrategy(orderId, strategy) {
  const sheets = getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: 'Trades!A:P'
  });
  const rows = res.data.values || [];
  // Find rows with this order ID (column B = index 1) and update strategy (column C = index 2)
  const updates = [];
  rows.forEach((row, i) => {
    if (i === 0) return; // skip header
    const oid = (row[1] || '').trim();
    // Check if any of the order IDs match
    if (orderId.split(',').some(id => oid.includes(id.trim()))) {
      updates.push({ range: `Trades!C${i + 1}`, values: [[strategy]] });
    }
  });
  if (updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: {
        valueInputOption: 'RAW',
        data: updates
      }
    });
  }
  return updates.length;
}

// ================================================================
//  UTILITY -- calculate stats from TradeTracker data
// ================================================================
export function calculateStats(trackerRows) {
  // Skip header row
  const data = trackerRows.slice(1);
  if (!data.length) return { totalTrades: 0, battingAvg: 0, avgWin: 0, avgLoss: 0, expectancy: 0, totalPnl: 0 };

  const withPnl = data.filter(r => r[8] && parseFloat(r[8]) !== 0);
  const wins = withPnl.filter(r => parseFloat(r[8]) > 0);
  const losses = withPnl.filter(r => parseFloat(r[8]) < 0);

  const totalTrades = withPnl.length;
  const battingAvg = totalTrades > 0 ? wins.length / totalTrades : 0;
  const avgWin = wins.length > 0
    ? wins.reduce((s, r) => s + parseFloat(r[8]), 0) / wins.length : 0;
  const avgLoss = losses.length > 0
    ? losses.reduce((s, r) => s + parseFloat(r[8]), 0) / losses.length : 0;
  const expectancy = battingAvg * avgWin + (1 - battingAvg) * avgLoss;
  const totalPnl = withPnl.reduce((s, r) => s + parseFloat(r[8]), 0);

  return {
    totalTrades,
    battingAvg: Math.round(battingAvg * 1000) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    totalPnl: Math.round(totalPnl * 100) / 100
  };
}

// ================================================================
//  GOOGLE DRIVE — DOCUMENT MANAGEMENT
// ================================================================
const DOC_FOLDER_NAME = 'Options Tracker Docs';
let docFolderId = null;

function getDrive() {
  return google.drive({ version: 'v3', auth: authClient });
}

async function ensureDocFolder() {
  if (docFolderId) return docFolderId;
  const drive = getDrive();
  // Check if folder already exists
  const res = await drive.files.list({
    q: `name='${DOC_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive'
  });
  if (res.data.files.length > 0) {
    docFolderId = res.data.files[0].id;
    return docFolderId;
  }
  // Create folder
  const folder = await drive.files.create({
    requestBody: {
      name: DOC_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder'
    },
    fields: 'id'
  });
  docFolderId = folder.data.id;
  return docFolderId;
}

export async function uploadDocument(fileBuffer, filename, mimeType, metadata) {
  const drive = getDrive();
  const folderId = await ensureDocFolder();
  const { Readable } = await import('stream');
  const stream = new Readable();
  stream.push(fileBuffer);
  stream.push(null);

  const file = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
      description: JSON.stringify(metadata || {})
    },
    media: {
      mimeType,
      body: stream
    },
    fields: 'id,name,mimeType,size,createdTime,webViewLink'
  });
  return file.data;
}

export async function listDocuments() {
  const drive = getDrive();
  const folderId = await ensureDocFolder();
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id,name,mimeType,size,createdTime,webViewLink,description)',
    orderBy: 'createdTime desc',
    pageSize: 100
  });
  return res.data.files.map(f => {
    let meta = {};
    try { meta = JSON.parse(f.description || '{}'); } catch (e) {}
    return { ...f, meta };
  });
}

export async function deleteDocument(fileId) {
  const drive = getDrive();
  await drive.files.delete({ fileId });
}

export async function getDocumentUrl(fileId) {
  const drive = getDrive();
  // Make the file viewable by anyone with the link
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' }
  });
  const file = await drive.files.get({
    fileId,
    fields: 'webViewLink,webContentLink'
  });
  return file.data;
}
