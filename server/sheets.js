import { google } from 'googleapis';

// ================================================================
//  GOOGLE SHEETS SERVICE
//  Handles all interactions with the Google Sheet backend.
//  Sheet tabs: Config | Trades | TradeTracker | Decisions | BattingAverage | Journal
// ================================================================

let sheetsClient = null;
let authClient = null;

// ---- Auth setup ----
let onTokensRefreshed = null; // callback set by index.js to persist refreshed tokens
let currentTokens = null;     // last-known full token set (incl. refresh_token)

export function initAuth(credentials) {
  authClient = new google.auth.OAuth2(
    credentials.clientId,
    credentials.clientSecret,
    credentials.redirectUri
  );
  // The google-auth library auto-refreshes the access token when it expires and
  // emits a 'tokens' event. The refresh response does NOT include refresh_token,
  // so we merge it back in and hand the full set to the persistence callback.
  authClient.on('tokens', (tokens) => {
    currentTokens = {
      ...(currentTokens || {}),
      ...tokens,
      refresh_token: tokens.refresh_token || currentTokens?.refresh_token
    };
    if (onTokensRefreshed) {
      Promise.resolve(onTokensRefreshed(currentTokens)).catch(() => {});
    }
  });
  return authClient;
}

// Register a callback invoked whenever tokens are refreshed (for persistence).
export function setOnTokensRefreshed(cb) {
  onTokensRefreshed = cb;
}

export function getAuthUrl() {
  return authClient.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
}

export async function handleAuthCallback(code) {
  const { tokens } = await authClient.getToken(code);
  currentTokens = { ...tokens };
  authClient.setCredentials(tokens);
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
  return tokens;
}

export function setTokens(tokens) {
  // Preserve an existing refresh_token if a partial token set is passed in.
  currentTokens = {
    ...(currentTokens || {}),
    ...tokens,
    refresh_token: tokens.refresh_token || currentTokens?.refresh_token
  };
  authClient.setCredentials(currentTokens);
  sheetsClient = google.sheets({ version: 'v4', auth: authClient });
}

// Read-only accessor for the current full token set.
export function getCurrentTokens() {
  return currentTokens;
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
    ['winAmount', '65'],
    ['accounts', '[]']
  ],
  Trades: [['Date/Time', 'Order #', 'Strategy (OIC)', 'Underlying', 'Instrument Type',
    'Description', 'Subcode', 'Symbol', 'Expiry', 'Strike', 'Call/Put',
    'Quantity', 'Avg Price', 'Fees', 'Net Value', 'Currency']],
  TradeTracker: [['Order #', 'Entry Date', 'Expiry Date', 'Close Date', 'Strategy (OIC)',
    'Underlying', 'Qty', 'Net Credit ($)', 'Total P&L ($)', 'W / L',
    'Cumul BA (%)', 'Status', 'Account']],
  Decisions: [['Timestamp', 'Engine', 'Underlying', 'Strategy', 'Direction', 'Contracts',
    'Kelly $', 'POP Margin', 'Setup Score', 'Setup Grade', 'Regime',
    'Wing Strikes', 'Market Behaviour', 'Notes',
    'Price', 'VIX', 'VIX1D', 'IV', 'IVR', 'EM', 'Matched Trade',
    'Status', 'Close Date', 'Close Price', 'Actual P&L', 'Trade Notes', 'Account',
    'Delta', 'Theta', 'Gamma', 'Vega', 'Close IV', 'Close VIX',
    // AH-AQ (Aug 2026). The log recorded Kelly $ and Setup Score but NOT the numbers
    // that define the trade or the engine's own verdict on it, so every review had to
    // reopen the ticket PDF and re-key them by hand -- and "did the EV gate predict the
    // outcome" could only be asked through Kelly $ as a proxy. Appended after Close VIX
    // so no existing column index moves.
    'Net Debit/Credit', 'Max Risk', 'Max Profit', 'EV', 'Confidence',
    'P(max loss)', 'EM Basis', 'Cushion EM', 'Session High', 'Session Low',
    // AR-AT (Aug 2026): vol-snapshot completion for implied-vs-realized and
    // vega-attribution reviews. The OPEN side mostly already lives in
    // Price/VIX/VIX1D/IV/IVR/EM (cols O-T); IVx Open adds the one thing those
    // lack, the expiry-specific IV of the structure at log time. The CLOSE side
    // completes Close IV (=IVx at close) / Close VIX with the close spot and
    // VIX1D. Strictly appended — no existing column index moves.
    'IVx Open', 'Underlying Price Close', 'VIX1D Close']],
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
    const isNew = !existingTabs.includes(tabName);
    if (isNew) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SHEET_ID(),
        requestBody: {
          requests: [{ addSheet: { properties: { title: tabName } } }]
        }
      });
    }

    if (tabName === 'Config') {
      if (isNew) {
        // Only write full Config (headers + defaults) for brand new tabs
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID(),
          range: `${tabName}!A1`,
          valueInputOption: 'RAW',
          requestBody: { values: headerData }
        });
      }
      // For existing Config, never overwrite — data rows contain user settings
    } else {
      // For all other tabs, update header row only (row 1)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `${tabName}!A1`,
        valueInputOption: 'RAW',
        requestBody: { values: [headerData[0]] }
      });
    }
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
  } else {
    // Key doesn't exist, append it
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID(),
      range: 'Config!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [[key, value]] }
    });
  }
}

// Account format: [{ id, name, bankroll, startingBankroll, maxDailyLoss, maxOpenRisk }]
export async function getAccounts() {
  const config = await getConfig();
  const raw = config.accounts;
  if (!raw) {
    console.log('[ACCOUNTS] WARNING: no "accounts" key found in Config sheet. '
      + 'Config keys present: ' + Object.keys(config).join(', '));
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.log('[ACCOUNTS] WARNING: Config "accounts" is not an array.');
      return [];
    }
    return parsed;
  } catch (e) {
    // Never silently swallow this — an empty account list looks like data loss.
    console.log('[ACCOUNTS] ERROR: failed to parse Config "accounts" JSON:', e.message);
    console.log('[ACCOUNTS] Raw value starts with:', String(raw).slice(0, 120));
    return [];
  }
}

export async function saveAccounts(accounts) {
  await updateConfig('accounts', JSON.stringify(accounts));
}

export async function backfillAccountColumn(accountId, force = false) {
  const sheets = getSheets();
  const rows = await getTradeTracker();
  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const currentAccount = rows[i][12] || '';
    if (!currentAccount || force) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: `TradeTracker!M${i + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[accountId]] }
      });
      updated++;
    }
  }
  return updated;
}

// One-time data-repair migration: re-tag the Account column (col M) by date.
// Rule (per user): trades whose effective date falls in the target month/year
// go to `monthAccountName`; everything else goes to `defaultAccountName`.
// Effective date = Entry Date (col B) if present, else Close Date (col D).
// Resolves account names -> ids from the configured accounts list (the filter
// matches on id). Pass dryRun=true to preview without writing.
export async function retagAccountsByDate({
  monthAccountName,        // e.g. 'PaperTrade'
  defaultAccountName,      // e.g. 'TastyTrade'
  year,                    // e.g. 2026
  month,                   // 1-12, e.g. 6 for June
  dryRun = false
}) {
  const accounts = await getAccounts();
  const findId = (name) => {
    const a = accounts.find(x =>
      x.name?.toLowerCase() === name.toLowerCase() ||
      x.id?.toLowerCase() === name.toLowerCase()
    );
    return a ? a.id : null;
  };
  const monthId = findId(monthAccountName);
  const defaultId = findId(defaultAccountName);
  if (!monthId) throw new Error(`Account "${monthAccountName}" not found in config. Configured: ${accounts.map(a => a.name).join(', ')}`);
  if (!defaultId) throw new Error(`Account "${defaultAccountName}" not found in config. Configured: ${accounts.map(a => a.name).join(', ')}`);

  const sheets = getSheets();
  const rows = await getTradeTracker();
  const dataRows = rows.slice(1);

  const newColumn = [];          // values for M2..Mn
  const preview = [];            // human-readable summary
  let monthCount = 0, defaultCount = 0;

  const inTargetMonth = (dateStr) => {
    if (!dateStr) return false;
    // Accept YYYY-MM-DD (the format in the sheet). Be defensive about parsing.
    const m = /^(\d{4})-(\d{2})/.exec(String(dateStr).trim());
    if (!m) return false;
    return Number(m[1]) === year && Number(m[2]) === month;
  };

  dataRows.forEach((row, idx) => {
    const entryDate = row[1] || '';   // col B
    const closeDate = row[3] || '';   // col D
    const effective = entryDate || closeDate;
    const isTargetMonth = inTargetMonth(effective);
    const newId = isTargetMonth ? monthId : defaultId;
    newColumn.push([newId]);
    if (isTargetMonth) monthCount++; else defaultCount++;
    preview.push({
      row: idx + 2,
      order: row[0] || '',
      entryDate, closeDate,
      effective,
      from: row[12] || '(blank)',
      to: newId,
      account: isTargetMonth ? monthAccountName : defaultAccountName
    });
  });

  if (!dryRun && newColumn.length > 0) {
    // Single batch write to M2:M{n} — one API call, not N.
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `TradeTracker!M2:M${newColumn.length + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: newColumn }
    });
  }

  return {
    dryRun,
    totalRows: newColumn.length,
    monthAccount: { name: monthAccountName, id: monthId, count: monthCount },
    defaultAccount: { name: defaultAccountName, id: defaultId, count: defaultCount },
    target: `${year}-${String(month).padStart(2, '0')}`,
    preview
  };
}

// Companion migration for the Decisions sheet. Account is col 27 (index 26 = AA).
// Only fills tickets whose Account is blank (so it won't clobber correctly-tagged
// ones), keyed on the ticket Timestamp (col A) date. Same rule as the tracker.
export async function retagDecisionAccountsByDate({
  monthAccountName, defaultAccountName, year, month, onlyBlank = true, dryRun = false
}) {
  const accounts = await getAccounts();
  const findId = (name) => {
    const a = accounts.find(x =>
      x.name?.toLowerCase() === name.toLowerCase() || x.id?.toLowerCase() === name.toLowerCase());
    return a ? a.id : null;
  };
  const monthId = findId(monthAccountName);
  const defaultId = findId(defaultAccountName);
  if (!monthId || !defaultId) throw new Error(`Account name not found. Configured: ${accounts.map(a => a.name).join(', ')}`);

  const sheets = getSheets();
  const rows = await getDecisions();
  const dataRows = rows.slice(1);
  const inTargetMonth = (s) => {
    const m = /^(\d{4})-(\d{2})/.exec(String(s || '').trim());
    return m && Number(m[1]) === year && Number(m[2]) === month;
  };

  const updates = []; // { range, value }
  const preview = [];
  dataRows.forEach((row, idx) => {
    const existing = row[26] || '';
    if (onlyBlank && existing) return; // leave correctly-tagged tickets alone
    const ts = row[0] || '';
    const closeDate = row[22] || ''; // Close Date col 23 (index 22)
    const effective = (ts.split('T')[0]) || closeDate;
    const newId = inTargetMonth(effective) ? monthId : defaultId;
    const rowNum = idx + 2;
    updates.push({ range: `Decisions!AA${rowNum}`, value: newId });
    preview.push({ row: rowNum, timestamp: ts, from: existing || '(blank)', to: newId });
  });

  if (!dryRun && updates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID(),
      requestBody: {
        valueInputOption: 'RAW',
        data: updates.map(u => ({ range: u.range, values: [[u.value]] }))
      }
    });
  }

  return { dryRun, updated: updates.length, monthId, defaultId, preview };
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
    range: 'TradeTracker!A2:M'
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
    range: 'TradeTracker!A:M'
  });
  return res.data.values || [];
}

// Per-strategy realized expectancy from closed TradeTracker rows. Used by the
// engines to switch EV from estimated capture-fractions to measured numbers
// once enough history exists. P&L is normalized per-contract (divided by Qty)
// because the engines reason per-contract. Optionally filter by account.
// Returns { [strategyName]: { trades, wins, losses, winRate, avgWin, avgLoss, totalPnl } }.
export async function getStrategyHistory(account = null) {
  const rows = await getTradeTracker();
  const out = {};
  // Canonicalize broker (OIC) strategy names to the engine's archetype names so
  // real imported trades accumulate under the same key the engine queries
  // (historyByStrategy[legStrat] is an exact string lookup). Without this a
  // "Bull Call Spread" from the importer never joins the engine's "Bull call spread"
  // bucket - a capitalisation difference alone is enough to keep MEASURED-mode EV
  // switched off forever, leaving the model stuck on estimated capture fractions.
  //
  // Only structures whose engine archetype is unambiguous are mapped. Deliberately
  // NOT mapped, because the CSV geometry cannot tell them apart from something else:
  //   - Chicken condor (asymmetry lives in short-strike placement vs spot, not in
  //     the leg pattern, so it is indistinguishable from a plain condor on paper)
  //   - long call/put condors, short flies, Long Iron Butterfly (debit reversed fly)
  //
  // Legacy rows imported before the csvParser wing-symmetry fix say
  // "Long Call Butterfly" for every fly including BWBs; those keep mapping to
  // Standard butterfly. Re-importing the broker CSV re-classifies them correctly.
  // (Fix Jul 2026.)
  const STRATEGY_ALIASES = {
    'long call butterfly':             'Standard butterfly',
    'long put butterfly':              'Standard butterfly',
    'long call asymmetric butterfly':  'Asymmetric butterfly',
    'long put asymmetric butterfly':   'Asymmetric butterfly',
    'long call broken wing butterfly': 'Broken wing butterfly',
    'long put broken wing butterfly':  'Broken wing butterfly',
    'short iron butterfly':            'Iron butterfly',
    'long iron condor':                'Iron Condor - Normal',
    'short iron condor':               'Long Condor - Reversed',
    'bull call spread':                'Bull call spread',
    'bear call spread':                'Bear call spread',
    'bull put spread':                 'Bull put spread',
    'bear put spread':                 'Bear put spread',
    'long call calendar spread':       'Calendar spread',
    'long put calendar spread':        'Calendar spread',
    'short ratio call spread':         'Ratio spread',
    'short ratio put spread':          'Ratio spread'
  };
  // Strategy names may carry a moneyness band suffix on verticals, e.g.
  // 'Bull Call Spread (ITM)'. Strip it for the alias lookup and put it back on the
  // canonical name, so the alias table stays 17 entries instead of 17 x 3 and any
  // future band comes through for free. (Jul 2026.)
  const canonicalStrategy = (name) => {
    const raw = name.trim();
    const m = raw.match(/^(.*?)\s*\((ITM|ATM|OTM)\)$/i);
    const base = m ? m[1] : raw;
    const band = m ? ` (${m[2].toUpperCase()})` : '';
    const mapped = STRATEGY_ALIASES[base.toLowerCase()];
    return mapped ? mapped + band : raw;
  };
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const strategy = canonicalStrategy((r[4] || '').trim());
    const qty = Math.abs(parseFloat(r[6])) || 1;
    const pnl = parseFloat(r[8]);
    const status = (r[11] || '').trim();
    const rowAccount = r[12] || '';
    if (!strategy) continue;
    if (isNaN(pnl)) continue;                      // only rows with a realized P&L
    if (status && status.toLowerCase() === 'open') continue; // closed only
    if (account && rowAccount !== account) continue;

    const perContract = pnl / qty;
    if (!out[strategy]) {
      out[strategy] = { trades: 0, wins: 0, losses: 0, _winSum: 0, _lossSum: 0, totalPnl: 0 };
    }
    const s = out[strategy];
    s.trades += 1;
    s.totalPnl += pnl;
    if (perContract >= 0) { s.wins += 1; s._winSum += perContract; }
    else { s.losses += 1; s._lossSum += Math.abs(perContract); }
  }
  // Finalize averages
  Object.values(out).forEach(s => {
    s.winRate = s.trades > 0 ? s.wins / s.trades : 0;
    s.avgWin = s.wins > 0 ? s._winSum / s.wins : 0;
    s.avgLoss = s.losses > 0 ? s._lossSum / s.losses : 0;
    delete s._winSum; delete s._lossSum;
  });
  return out;
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
    range: `TradeTracker!A${rowIndex}:M${rowIndex}`
  });
  const current = res.data.values?.[0] || [];
  // Headers: Order#(0), EntryDate(1), ExpiryDate(2), CloseDate(3), Strategy(4),
  //          Underlying(5), Qty(6), NetCredit(7), TotalP&L(8), W/L(9), CumulBA(10), Status(11), Account(12)
  const row = [...current];
  while (row.length < 13) row.push('');
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
  if (updates.account !== undefined) row[12] = updates.account;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID(),
    range: `TradeTracker!A${rowIndex}:M${rowIndex}`,
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
// The vol-snapshot columns AR:AT ('IVx Open', 'Underlying Price Close',
// 'VIX1D Close') were appended in Aug 2026; sheets created before then stop at
// AQ. Before any write that targets them, read row 1 and — only if AR1:AT1 do
// not already hold the expected names — write those three header cells. A1:AQ1
// is never touched, so existing columns can neither move nor be overwritten.
// Runs once per process (cached on success) and is strictly best-effort: a
// failure here must never block a log or a close.
const DECISION_VOL_HEADERS = ['IVx Open', 'Underlying Price Close', 'VIX1D Close'];
let decisionVolHeadersEnsured = false;
async function ensureDecisionVolHeaders() {
  if (decisionVolHeadersEnsured) return;
  try {
    const sheets = getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID(),
      range: 'Decisions!1:1'
    });
    const header = (res.data.values && res.data.values[0]) || [];
    const ok = DECISION_VOL_HEADERS.every((h, i) => header[43 + i] === h); // AR = col 44 (idx 43)
    if (!ok) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID(),
        range: 'Decisions!AR1:AT1',
        valueInputOption: 'RAW',
        requestBody: { values: [DECISION_VOL_HEADERS] }
      });
    }
    decisionVolHeadersEnsured = true;
  } catch (e) { /* retried on the next write */ }
}

export async function logDecision(decision) {
  const sheets = getSheets();
  await ensureDecisionVolHeaders();
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
    '',  // Trade Notes
    decision.account || '',  // Account
    decision.delta ?? '',   // Delta  (open, net position delta)
    decision.theta ?? '',   // Theta  (open)
    decision.gamma ?? '',   // Gamma  (open)
    decision.vega ?? '',    // Vega   (open)
    '',  // Close IV  -- filled at close
    '',  // Close VIX -- filled at close
    // -- AH-AQ: the trade as priced, and the engine's verdict on it --
    decision.netCreditDebit ?? '',  // AH per-share net; negative = debit paid
    decision.maxRisk ?? '',         // AI $ at true max loss, all contracts
    decision.maxProfit ?? '',       // AJ $
    decision.ev ?? '',              // AK the number the edge gate actually used
    decision.confidence ?? '',      // AL Trade Confidence 0-100
    decision.pMaxLoss ?? '',        // AM %
    decision.pMaxLossBasis ?? '',   // AN e.g. "VIX1D EM 5.0 -> sigma 4.5"
    decision.cushionEM ?? '',       // AO nearest wing / remaining EM at entry
    '',  // AP Session High -- filled at close
    '',  // AQ Session Low  -- filled at close
    decision.ivxOpen ?? '',  // AR IVx Open -- expiry-specific IV at log time
    '',  // AS Underlying Price Close -- filled at close
    ''   // AT VIX1D Close -- filled at close
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
    range: 'Decisions!A:AT'  // 46 cols: Close IV/VIX (AF:AG) + priced-trade block (AH:AQ) + vol snapshot (AR:AT)
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
  await ensureDecisionVolHeaders();
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
  // Close IV (AF) + Close VIX (AG) -- optional, written only if captured at close
  if (closeData.closeIV != null || closeData.closeVix != null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `Decisions!AF${rowIndex}:AG${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[
        closeData.closeIV ?? '',
        closeData.closeVix ?? ''
      ]] }
    });
  }
  // Session High (AP) + Low (AQ) -- what the day ACTUALLY did, so realised range can be
  // compared with the expected move the ticket was priced on without re-reading a chart.
  // Same best-effort contract as Close VIX: absent bridge -> blank, close still proceeds.
  if (closeData.sessionHigh != null || closeData.sessionLow != null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `Decisions!AP${rowIndex}:AQ${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[
        closeData.sessionHigh ?? '',
        closeData.sessionLow ?? ''
      ]] }
    });
  }
  // Underlying Price Close (AS) + VIX1D Close (AT) -- the rest of the close vol
  // snapshot. Same best-effort contract: absent bridge -> blank, close proceeds.
  if (closeData.closeUnderlyingPrice != null || closeData.closeVix1d != null) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID(),
      range: `Decisions!AS${rowIndex}:AT${rowIndex}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[
        closeData.closeUnderlyingPrice ?? '',
        closeData.closeVix1d ?? ''
      ]] }
    });
  }
}

// Backfill vol-snapshot fields on an ALREADY-CLOSED decision row. Used by the
// reconcile "Accept & close" path, which closes instantly and lets the bridge
// snapshot land a few seconds later. Fill-only-blank: an existing value in any
// cell is never overwritten, so a normal close's data always wins.
export async function backfillDecisionVol(rowIndex, snap) {
  const sheets = getSheets();
  await ensureDecisionVolHeaders();
  // One read covering AF..AT; offsets within it:
  // AF=0 Close IV, AG=1 Close VIX, AP=10 Session High, AQ=11 Session Low,
  // AS=13 Underlying Price Close, AT=14 VIX1D Close.
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID(),
    range: `Decisions!AF${rowIndex}:AT${rowIndex}`
  });
  const cur = (res.data.values && res.data.values[0]) || [];
  const CELLS = [
    { col: 'AF', idx: 0,  val: snap.closeIV },
    { col: 'AG', idx: 1,  val: snap.closeVix },
    { col: 'AP', idx: 10, val: snap.sessionHigh },
    { col: 'AQ', idx: 11, val: snap.sessionLow },
    { col: 'AS', idx: 13, val: snap.closeUnderlyingPrice },
    { col: 'AT', idx: 14, val: snap.closeVix1d }
  ];
  const data = CELLS
    .filter(c => c.val != null && c.val !== '' && !(cur[c.idx] != null && cur[c.idx] !== ''))
    .map(c => ({ range: `Decisions!${c.col}${rowIndex}`, values: [[c.val]] }));
  if (!data.length) return { updated: 0 };
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID(),
    requestBody: { valueInputOption: 'RAW', data }
  });
  return { updated: data.length };
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

// ================================================================
//  GMAIL — TASTYTRADE EMAIL SCANNING
// ================================================================
function getGmail() {
  return google.gmail({ version: 'v1', auth: authClient });
}

export async function scanTastyTradeEmails(maxResults = 50, afterDate = null) {
  const gmail = getGmail();
  
  // Build search query for TastyTrade emails
  let query = 'from:tastytrade.com subject:(order OR confirmation OR assigned OR exercised)';
  if (afterDate) query += ` after:${afterDate}`;
  
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });

  const messages = res.data.messages || [];
  const parsed = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id,
      format: 'full'
    });

    const headers = full.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const date = headers.find(h => h.name === 'Date')?.value || '';
    
    // Get body text
    let body = '';
    if (full.data.payload.body?.data) {
      body = Buffer.from(full.data.payload.body.data, 'base64').toString('utf-8');
    } else if (full.data.payload.parts) {
      const textPart = full.data.payload.parts.find(p => p.mimeType === 'text/plain');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      } else {
        // Try HTML part and strip tags
        const htmlPart = full.data.payload.parts.find(p => p.mimeType === 'text/html');
        if (htmlPart?.body?.data) {
          body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
            .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
        }
      }
    }

    const result = parseTastyTradeEmail(subject, body, date, msg.id);
    if (result) parsed.push(result);
  }

  return parsed;
}

function parseTastyTradeEmail(subject, body, date, messageId) {
  const emailDate = new Date(date).toISOString();

  // Type 1: Order fill confirmation
  if (body.includes('Your order #') && body.includes('Fill Details')) {
    return parseOrderFill(body, emailDate, messageId);
  }

  // Type 2: Assignment/Exercise
  if (body.includes('exercised and/or been assigned') || body.includes('Assigned') || body.includes('Exercised')) {
    return parseAssignment(body, emailDate, messageId);
  }

  // Type 3: Daily confirmation (future — return null for now)
  return null;
}

function parseOrderFill(body, emailDate, messageId) {
  const result = {
    type: 'order_fill',
    messageId,
    emailDate,
    orderId: '',
    symbol: '',
    orderType: '',
    creditDebit: '',
    amount: 0,
    legs: [],
    fillDate: ''
  };

  // Extract order number
  const orderMatch = body.match(/order #(\d+)/i);
  if (orderMatch) result.orderId = orderMatch[1];

  // Extract symbol
  const symbolMatch = body.match(/Symbol\s+(\w+)/);
  if (symbolMatch) result.symbol = symbolMatch[1];

  // Extract order type (Limit @ X.XX Credit/Debit)
  const orderTypeMatch = body.match(/Order Type\s+(.*?)(?:\n|Fill)/s);
  if (orderTypeMatch) {
    result.orderType = orderTypeMatch[1].trim();
    const amountMatch = result.orderType.match(/([\d.]+)\s+(Credit|Debit)/i);
    if (amountMatch) {
      result.amount = parseFloat(amountMatch[1]);
      result.creditDebit = amountMatch[2].toLowerCase();
    }
  }

  // Parse fill legs: "Sold/Bought QTY SYMBOL DATE Call/Put STRIKE @ PRICE"
  const legPattern = /(Sold|Bought)\s+(\d+)\s+(\w+)\s+(\d{2}\/\d{2}\/\d{2})\s+(Call|Put)\s+([\d.]+)\s+@\s+([\d.]+)/gi;
  let match;
  const legMap = {};
  while ((match = legPattern.exec(body)) !== null) {
    const key = `${match[1]}_${match[3]}_${match[4]}_${match[5]}_${match[6]}`;
    if (!legMap[key]) {
      legMap[key] = {
        action: match[1], // Sold or Bought
        qty: parseInt(match[2]),
        symbol: match[3],
        expiry: match[4],
        type: match[5], // Call or Put
        strike: parseFloat(match[6]),
        price: parseFloat(match[7])
      };
    }
    // Duplicate fills (same leg listed twice) — keep first occurrence
  }
  result.legs = Object.values(legMap);

  // Extract fill date from first leg
  const fillDateMatch = body.match(/Filled at:\s+(.+?)(?:\n|$)/);
  if (fillDateMatch) {
    try { result.fillDate = new Date(fillDateMatch[1].trim()).toISOString(); } catch (e) {}
  }

  // Detect strategy from legs
  result.strategy = detectStrategy(result.legs);

  return result;
}

function parseAssignment(body, emailDate, messageId) {
  const result = {
    type: 'assignment',
    messageId,
    emailDate,
    legs: [],
    symbol: '',
    strategy: 'Assignment/Exercise'
  };

  // Parse: "Assigned/Exercised QTY SYMBOL DATE STRIKE Calls/Puts"
  const legPattern = /(Assigned|Exercised)\s+(\d+)\s+(\w+)\s+([\d-]+)\s+([\d.]+)\s+(Calls?|Puts?)/gi;
  let match;
  while ((match = legPattern.exec(body)) !== null) {
    result.legs.push({
      action: match[1],
      qty: parseInt(match[2]),
      symbol: match[3],
      expiry: match[4],
      strike: parseFloat(match[5]),
      type: match[6].replace(/s$/, '') // "Calls" -> "Call"
    });
    if (!result.symbol) result.symbol = match[3];
  }

  return result;
}

function detectStrategy(legs) {
  if (legs.length === 0) return 'Unknown';
  
  const sold = legs.filter(l => l.action === 'Sold');
  const bought = legs.filter(l => l.action === 'Bought');
  const allCalls = legs.every(l => l.type === 'Call');
  const allPuts = legs.every(l => l.type === 'Put');
  const hasCalls = legs.some(l => l.type === 'Call');
  const hasPuts = legs.some(l => l.type === 'Put');
  
  // 2-leg structures
  if (legs.length === 2) {
    if (sold.length === 1 && bought.length === 1) {
      if (allCalls) {
        return sold[0].strike > bought[0].strike ? 'Bear Call Spread' : 'Bull Call Spread';
      }
      if (allPuts) {
        return sold[0].strike < bought[0].strike ? 'Bull Put Spread' : 'Bear Put Spread';
      }
    }
  }
  
  // 3-leg structures (butterfly family)
  if (legs.length === 3 && (allCalls || allPuts)) {
    const sortedStrikes = legs.map(l => l.strike).sort((a, b) => a - b);
    const soldQty = sold.reduce((s, l) => s + l.qty, 0);
    const boughtQty = bought.reduce((s, l) => s + l.qty, 0);
    
    if (soldQty === 2 && boughtQty === 2) {
      // Check wing widths
      const lowerWidth = sortedStrikes[1] - sortedStrikes[0];
      const upperWidth = sortedStrikes[2] - sortedStrikes[1];
      if (Math.abs(lowerWidth - upperWidth) < 0.5) return 'Standard Butterfly';
      return 'Broken Wing Butterfly';
    }
  }
  
  // 4-leg structures
  if (legs.length === 4 && hasCalls && hasPuts) {
    const callLegs = legs.filter(l => l.type === 'Call');
    const putLegs = legs.filter(l => l.type === 'Put');
    if (callLegs.length === 2 && putLegs.length === 2) {
      // Iron condor or iron butterfly
      const callStrikes = callLegs.map(l => l.strike).sort((a, b) => a - b);
      const putStrikes = putLegs.map(l => l.strike).sort((a, b) => a - b);
      if (callStrikes[0] === putStrikes[1]) return 'Iron Butterfly';
      return 'Iron Condor - Normal';
    }
  }
  
  // Fallback
  if (legs.length === 4 && (allCalls || allPuts)) return 'Long Condor - Reversed';
  return `${legs.length}-leg ${allCalls ? 'Call' : allPuts ? 'Put' : 'Mixed'} structure`;
}
