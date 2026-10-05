import pg from 'pg';
import { unitsFromTicket, resolveClosePnl } from '../client/src/utils/commission.js';

// ================================================================
//  DATABASE SERVICE (Supabase Postgres)
//  Replaces the Google Sheets backend (Sep 2026). Every export keeps the exact
//  signature and return shape the Sheets version had, so index.js and the client
//  did not have to change: tab reads still come back as [headerRow, ...rows] of
//  strings, and a row is still addressed by its 1-based "sheet row" number
//  (header = row 1). That number lives in each table's row_no column, which is
//  what keeps Closes.ticket_ref -> Decisions row references valid.
//
//  Tables live in the `options` schema of the Supabase project and are accessed
//  with a dedicated role (options_app) that can see nothing else in the project.
// ================================================================

// ---- Connection ----
const url = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)|host=\/|^postgres(ql)?:\/\/[^@]*$/.test(url);
export const pool = new pg.Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});
pool.on('error', (e) => console.error('[DB] idle client error:', e.message));

async function q(text, params) {
  return pool.query(text, params);
}
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ---- Tab definitions: [db column, original sheet header] in sheet column order ----
const C = (pairs) => pairs.map(([col, header]) => ({ col, header }));
export const TABS = {
  Trades: { table: 'trades', cols: C([
    ['date_time', 'Date/Time'], ['order_no', 'Order #'], ['strategy_oic', 'Strategy (OIC)'],
    ['underlying', 'Underlying'], ['instrument_type', 'Instrument Type'], ['description', 'Description'],
    ['subcode', 'Subcode'], ['symbol', 'Symbol'], ['expiry', 'Expiry'], ['strike', 'Strike'],
    ['call_put', 'Call/Put'], ['quantity', 'Quantity'], ['avg_price', 'Avg Price'], ['fees', 'Fees'],
    ['net_value', 'Net Value'], ['currency', 'Currency']]) },
  TradeTracker: { table: 'trade_tracker', cols: C([
    ['order_no', 'Order #'], ['entry_date', 'Entry Date'], ['expiry_date', 'Expiry Date'],
    ['close_date', 'Close Date'], ['strategy_oic', 'Strategy (OIC)'], ['underlying', 'Underlying'],
    ['qty', 'Qty'], ['net_credit_usd', 'Net Credit ($)'], ['total_pnl_usd', 'Total P&L ($)'],
    ['win_loss', 'W / L'], ['cumul_ba_pct', 'Cumul BA (%)'], ['status', 'Status'], ['account', 'Account']]) },
  Decisions: { table: 'decisions', cols: C([
    ['timestamp', 'Timestamp'], ['engine', 'Engine'], ['underlying', 'Underlying'], ['strategy', 'Strategy'],
    ['direction', 'Direction'], ['contracts', 'Contracts'], ['kelly_usd', 'Kelly $'], ['pop_margin', 'POP Margin'],
    ['setup_score', 'Setup Score'], ['setup_grade', 'Setup Grade'], ['regime', 'Regime'],
    ['wing_strikes', 'Wing Strikes'], ['market_behaviour', 'Market Behaviour'], ['notes', 'Notes'],
    ['price', 'Price'], ['vix', 'VIX'], ['vix1d', 'VIX1D'], ['iv', 'IV'], ['ivr', 'IVR'], ['em', 'EM'],
    ['matched_trade', 'Matched Trade'], ['status', 'Status'], ['close_date', 'Close Date'],
    ['close_price', 'Close Price'], ['actual_pnl', 'Actual P&L'], ['trade_notes', 'Trade Notes'],
    ['account', 'Account'], ['delta', 'Delta'], ['theta', 'Theta'], ['gamma', 'Gamma'], ['vega', 'Vega'],
    ['close_iv', 'Close IV'], ['close_vix', 'Close VIX'], ['net_debit_credit', 'Net Debit/Credit'],
    ['max_risk', 'Max Risk'], ['max_profit', 'Max Profit'], ['ev', 'EV'], ['confidence', 'Confidence'],
    ['p_max_loss', 'P(max loss)'], ['em_basis', 'EM Basis'], ['cushion_em', 'Cushion EM'],
    ['session_high', 'Session High'], ['session_low', 'Session Low'], ['ivx_open', 'IVx Open'],
    ['underlying_price_close', 'Underlying Price Close'], ['vix1d_close', 'VIX1D Close'],
    ['engine_strikes', 'Engine Strikes'], ['vwap_anchored', 'VWAP Anchored'], ['vwap_roll30', 'VWAP Roll30'],
    ['vwap_roll30_prior', 'VWAP Roll30 Prior'], ['vwap_acceptance', 'VWAP Acceptance'],
    ['vwap_trend', 'VWAP Trend'], ['vwap_dist_em', 'VWAP Dist EM'],
    ['strike_method', 'Strike Method'], ['short_deltas', 'Short Deltas'], ['implied_pop', 'Implied POP']]) },
  Journal: { table: 'journal', cols: C([
    ['date', 'Date'], ['day_pnl', 'Day P&L'], ['trades_count', 'Trades Count'], ['win_count', 'Win Count'],
    ['loss_count', 'Loss Count'], ['notes', 'Notes'], ['week_number', 'Week Number']]) },
  Closes: { table: 'closes', cols: C([
    ['close_id', 'Close ID'], ['ticket_ref', 'Ticket Ref'], ['ticket_timestamp', 'Ticket Timestamp'],
    ['engine', 'Engine'], ['underlying', 'Underlying'], ['strategy', 'Strategy'], ['entry_date', 'Entry Date'],
    ['close_date', 'Close Date'], ['qty_closed', 'Qty Closed'], ['qty_remaining', 'Qty Remaining'],
    ['close_price', 'Close Price'], ['pnl_usd', 'P&L ($)'], ['fees_usd', 'Fees ($)'], ['account', 'Account'],
    ['notes', 'Notes']]) },
  TradeLog: { table: 'trade_log', cols: C([
    ['ticket_ref', 'Ticket Ref'], ['entry_date', 'Entry Date'], ['entry_time', 'Entry Time'],
    ['engine', 'Engine'], ['underlying', 'Underlying'], ['strategy', 'Strategy'], ['legs', 'Legs'],
    ['qty', 'Qty'], ['entry_price', 'Entry Price'], ['max_risk', 'Max Risk'], ['max_profit', 'Max Profit'],
    ['ev', 'EV'], ['confidence', 'Confidence'], ['qty_closed', 'Qty Closed'], ['qty_open', 'Qty Open'],
    ['avg_exit', 'Avg Exit'], ['realised_pnl', 'Realised P&L'], ['r_multiple', 'R Multiple'],
    ['status', 'Status'], ['tranches', 'Tranches'], ['last_close', 'Last Close'], ['account', 'Account']]) }
};

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const T = (tab) => {
  const d = TABS[tab];
  if (!d) throw new Error(`Unknown tab ${tab}`);
  return d;
};

// A cell as the Sheets API would have handed it back: a string. Blank -> null in
// the database, '' on the way out.
function toDb(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return isFinite(v) ? String(v) : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
function rowToArray(r, cols) {
  const arr = cols.map(c => (r[c.col] == null ? '' : r[c.col]));
  // Sheets trims trailing empty cells; so do we, so row.length checks behave the same.
  while (arr.length && arr[arr.length - 1] === '') arr.pop();
  return arr;
}

// Whole tab as [header, ...rows]; rows[i] is sheet row i+1. Gaps come back as [].
async function readTab(tab, client = pool) {
  const { table, cols } = T(tab);
  const res = await client.query(
    `select row_no, ${cols.map(c => qi(c.col)).join(', ')} from options.${qi(table)} order by row_no`);
  const out = [cols.map(c => c.header)];
  for (const r of res.rows) {
    const i = r.row_no - 1;
    while (out.length < i) out.push([]);
    out[i] = rowToArray(r, cols);
  }
  return out;
}

async function readRow(tab, rowNo, client = pool) {
  const { table, cols } = T(tab);
  const res = await client.query(
    `select ${cols.map(c => qi(c.col)).join(', ')} from options.${qi(table)} where row_no = $1`, [rowNo]);
  return res.rows[0] ? cols.map(c => (res.rows[0][c.col] == null ? '' : res.rows[0][c.col])) : [];
}

async function insertRows(client, tab, startRowNo, rows) {
  const { table, cols } = T(tab);
  if (!rows.length) return;
  const colList = ['row_no', ...cols.map(c => c.col)].map(qi).join(', ');
  // Chunk so a large CSV import stays under the parameter limit.
  const per = cols.length + 1;
  const chunk = Math.max(1, Math.floor(60000 / per));
  for (let s = 0; s < rows.length; s += chunk) {
    const part = rows.slice(s, s + chunk);
    const params = [];
    const tuples = part.map((row, k) => {
      const vals = [startRowNo + s + k, ...cols.map((_, j) => toDb(row[j]))];
      const base = params.length;
      params.push(...vals);
      return '(' + vals.map((_, j) => '$' + (base + j + 1)).join(', ') + ')';
    });
    await client.query(`insert into options.${qi(table)} (${colList}) values ${tuples.join(', ')}`, params);
  }
}

// values.append equivalent: rows go after the last used row.
async function appendRows(tab, rows) {
  const { table } = T(tab);
  return tx(async (client) => {
    await client.query(`lock table options.${qi(table)} in share row exclusive mode`);
    const r = await client.query(`select coalesce(max(row_no), 1) as m from options.${qi(table)}`);
    const start = Number(r.rows[0].m) + 1;
    await insertRows(client, tab, start, rows);
    return start;
  });
}

// values.update equivalent for a run of cells on one row, starting at column
// index startCol (0 = column A). Creates the row if it does not exist.
async function setCells(tab, rowNo, startCol, values, client = pool) {
  const { table, cols } = T(tab);
  const targets = values.map((v, i) => ({ col: cols[startCol + i]?.col, v }))
    .filter(t => t.col);
  if (!targets.length) return;
  const colList = ['row_no', ...targets.map(t => t.col)].map(qi).join(', ');
  const ph = ['$1', ...targets.map((_, i) => '$' + (i + 2))].join(', ');
  const upd = targets.map(t => `${qi(t.col)} = excluded.${qi(t.col)}`).join(', ');
  await client.query(
    `insert into options.${qi(table)} (${colList}) values (${ph})
     on conflict (row_no) do update set ${upd}, updated_at = now()`,
    [rowNo, ...targets.map(t => toDb(t.v))]);
}

// clear + write from row 2: the whole data area is replaced atomically.
async function replaceData(tab, rows) {
  const { table } = T(tab);
  await tx(async (client) => {
    await client.query(`delete from options.${qi(table)}`);
    await insertRows(client, tab, 2, rows);
  });
  return rows.length;
}

// deleteDimension equivalent: remove the row and shift everything below up one.
async function deleteRowShift(tab, rowNo) {
  const { table } = T(tab);
  await tx(async (client) => {
    await client.query(`delete from options.${qi(table)} where row_no = $1`, [rowNo]);
    // Two steps so the primary key never sees a transient duplicate.
    await client.query(`update options.${qi(table)} set row_no = row_no + 1000000 where row_no > $1`, [rowNo]);
    await client.query(`update options.${qi(table)} set row_no = row_no - 1000001 where row_no > 1000000`);
  });
}

// ================================================================
//  STRUCTURE -- seed defaults (replaces ensureSheetStructure)
// ================================================================
const CONFIG_DEFAULTS = [
  ['currentBankroll', '3000'],
  ['startingBankroll', '3000'],
  ['maxDailyLoss', '300'],
  ['maxOpenRisk', '450'],
  ['riskPerContract', '435'],
  ['winAmount', '65'],
  ['accounts', '[]']
];
const BA_METRICS = ['Total Trades', 'Batting Average', 'Avg Win', 'Avg Loss', 'Expectancy', 'Total P&L'];

export async function ensureDatabase() {
  await q('select 1 from options.config limit 1');
  const n = await q('select count(*)::int as n from options.config');
  if (n.rows[0].n === 0) {
    for (let i = 0; i < CONFIG_DEFAULTS.length; i++) {
      await q('insert into options.config (key, value, sort_order) values ($1, $2, $3) on conflict do nothing',
        [CONFIG_DEFAULTS[i][0], CONFIG_DEFAULTS[i][1], i + 1]);
    }
  }
  for (let i = 0; i < BA_METRICS.length; i++) {
    await q('insert into options.batting_average (metric, value, sort_order) values ($1, $2, $3) on conflict do nothing',
      [BA_METRICS[i], '0', i + 1]);
  }
}

// ================================================================
//  AUTH -- Supabase Auth, single-user allowlist
// ================================================================
const SUPABASE_URL = () => process.env.SUPABASE_URL;
const SUPABASE_KEY = () => process.env.SUPABASE_PUBLISHABLE_KEY;

export function publicAuthConfig() {
  return { supabaseUrl: SUPABASE_URL() || '', publishableKey: SUPABASE_KEY() || '' };
}

// Supabase REST calls made AS the signed-in user (their JWT), so Auth and the
// Storage bucket policies decide what is allowed. The server holds no
// service/secret key. Plain fetch on purpose: @supabase/supabase-js refuses to
// construct on Node 20 (no native WebSocket), which is what Railway runs.
async function sbFetch(path, token, opts = {}) {
  const res = await fetch(`${SUPABASE_URL()}${path}`, {
    ...opts,
    headers: { apikey: SUPABASE_KEY(), Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!res.ok) {
    const msg = (body && (body.message || body.msg || body.error_description || body.error)) || res.statusText;
    const err = new Error(String(msg));
    err.status = res.status;
    throw err;
  }
  return body;
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

const tokenCache = new Map(); // token -> { email, until }
let allowCache = { at: 0, emails: new Set() };

async function allowedEmails() {
  if (Date.now() - allowCache.at < 60000) return allowCache.emails;
  const r = await q('select email from options.allowed_users');
  allowCache = { at: Date.now(), emails: new Set(r.rows.map(x => x.email.toLowerCase())) };
  return allowCache.emails;
}

// Returns the user's email if the token is valid AND on the allowlist, else null.
export async function verifyUser(token) {
  if (!token) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.email;
  let user;
  try { user = await sbFetch('/auth/v1/user', token); }
  catch (e) { if (e.status === 401 || e.status === 403) return null; throw e; }
  if (!user?.email) return null;
  const email = user.email.toLowerCase();
  if (!(await allowedEmails()).has(email)) return null;
  tokenCache.set(token, { email, until: Date.now() + 5 * 60 * 1000 });
  if (tokenCache.size > 200) tokenCache.clear();
  return email;
}

// ================================================================
//  CONFIG
// ================================================================
// Config values may be simple formulas carried over from the sheet, e.g.
// maxDailyLoss = "=currentBankroll*0.2". They are evaluated on read so the
// derived limits keep tracking the bankroll exactly as the sheet did.
function evalConfig(raw) {
  const out = {};
  const resolving = new Set();
  const val = (key) => {
    if (key in out) return out[key];
    let v = raw[key];
    if (typeof v === 'string' && v.startsWith('=')) {
      if (resolving.has(key)) return '#REF!';
      resolving.add(key);
      const expr = v.slice(1).replace(/[A-Za-z_][A-Za-z0-9_]*/g, (name) => {
        const r = val(name);
        const n = parseFloat(r);
        return isNaN(n) ? 'NaN' : `(${n})`;
      });
      resolving.delete(key);
      if (/^[-+*/().\d\seNa]+$/.test(expr)) {
        try {
          // eslint-disable-next-line no-new-func
          const n = Function(`"use strict"; return (${expr});`)();
          v = isFinite(n) ? String(Number(n.toPrecision(12))) : '#VALUE!';
        } catch (e) { v = '#ERROR!'; }
      } else v = '#ERROR!';
    }
    out[key] = v;
    return v;
  };
  Object.keys(raw).forEach(val);
  return out;
}

export async function getConfig() {
  const res = await q('select key, value from options.config order by sort_order, key');
  const raw = {};
  res.rows.forEach(r => { if (r.key) raw[r.key] = r.value == null ? '' : r.value; });
  const vals = evalConfig(raw);
  const config = {};
  Object.entries(vals).forEach(([key, val]) => {
    // Same coercion the sheet version applied (note: isNaN('') is false -> NaN
    // is avoided by keeping blank as '').
    config[key] = (val === '' || isNaN(val)) ? val : parseFloat(val);
  });
  return config;
}

export async function updateConfig(key, value) {
  await q(
    `insert into options.config (key, value, sort_order)
     values ($1, $2, (select coalesce(max(sort_order), 0) + 1 from options.config))
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, toDb(value) ?? '']);
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
  const rows = await getTradeTracker();
  let updated = 0;
  for (let i = 1; i < rows.length; i++) {
    const currentAccount = rows[i][12] || '';
    if (!currentAccount || force) {
      await setCells('TradeTracker', i + 1, 12, [accountId]);
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
    await tx(async (client) => {
      for (let k = 0; k < newColumn.length; k++) await setCells('TradeTracker', k + 2, 12, newColumn[k], client);
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
    updates.push({ rowNum, value: newId });
    preview.push({ row: rowNum, timestamp: ts, from: existing || '(blank)', to: newId });
  });

  if (!dryRun && updates.length > 0) {
    await tx(async (client) => {
      for (const u of updates) await setCells('Decisions', u.rowNum, 26, [u.value], client);
    });
  }

  return { dryRun, updated: updates.length, monthId, defaultId, preview };
}

// ================================================================
//  TRADES (raw legs from tastytrade CSV)
// ================================================================
export async function appendTrades(rows) {
  await appendRows('Trades', rows);
  return rows.length;
}

export async function getTrades() {
  return readTab('Trades');
}

export async function clearTrades() {
  await q('delete from options.trades');
}

// ================================================================
//  TRADE TRACKER (grouped positions)
// ================================================================
export async function writeTradeTracker(rows) {
  return replaceData('TradeTracker', rows);
}

export async function getTradeTracker() {
  return readTab('TradeTracker');
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
  await appendRows('TradeTracker', [row]);
}

export async function updateTradeTrackerRow(rowIndex, updates) {
  const current = await readRow('TradeTracker', rowIndex);
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
  await setCells('TradeTracker', rowIndex, 0, row);
}

export async function deleteTradeTrackerRow(rowIndex) {
  await deleteRowShift('TradeTracker', rowIndex);
}

// ================================================================
//  DECISIONS (logged from decision engine)
// ================================================================
export async function logDecision(decision) {
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
    '',  // AT VIX1D Close -- filled at close
    decision.engineStrikes ?? '',  // AU Engine Strikes -- pre-edit suggestion (Wing Strikes = final)
    // -- AV-BA: VWAP inputs and reads at entry (see DECISION_VWAP_HEADERS) --
    decision.vwapAnchored ?? '',     // AV cumulative session VWAP, index scale
    decision.vwapRoll30 ?? '',       // AW VWAP of the last 30 min
    decision.vwapRoll30Prior ?? '',  // AX VWAP of the 30 min before that
    decision.vwapAccept ?? '',       // AY 0..1, share of last 12 bars closing above VWAP
    decision.vwapTrend ?? '',        // AZ e.g. "mild rising +0.62EM30 confirmed"
    decision.vwapDistEM ?? '',       // BA price-to-VWAP distance as % of session EM
    // -- BB-BD: strike method (R-49, Oct 2026) --
    decision.strikeMethod ?? '',     // BB 'EM' | 'Delta' | 'Delta (estimated)' | 'Manual'
    decision.shortDeltas ?? '',      // BC e.g. "6650P 16Δ / 6760C 14Δ" at log time
    decision.impliedPop ?? ''        // BD % — 1 − Σ short |Δ|, credit structures only
  ];
  await appendRows('Decisions', [row]);
  return row;
}

export async function getDecisions() {
  return readTab('Decisions');
}

// ================================================================
//  BATTING AVERAGE / STATS
// ================================================================
export async function updateBattingAverage(stats) {
  const values = [
    ['Total Trades', stats.totalTrades || 0],
    ['Batting Average', stats.battingAvg || 0],
    ['Avg Win', stats.avgWin || 0],
    ['Avg Loss', stats.avgLoss || 0],
    ['Expectancy', stats.expectancy || 0],
    ['Total P&L', stats.totalPnl || 0]
  ];
  await tx(async (client) => {
    for (let i = 0; i < values.length; i++) {
      await client.query(
        `insert into options.batting_average (metric, value, sort_order) values ($1, $2, $3)
         on conflict (metric) do update set value = excluded.value, updated_at = now()`,
        [values[i][0], toDb(values[i][1]) ?? '0', i + 1]);
    }
  });
}

export async function getBattingAverage() {
  const res = await q('select metric, value from options.batting_average order by sort_order, metric');
  const stats = {};
  res.rows.forEach(({ metric: key, value: val }) => {
    if (key) stats[key.replace(/\s/g, '')] = isNaN(val) ? val : parseFloat(val);
  });
  return stats;
}

// ================================================================
//  JOURNAL (daily P&L entries)
// ================================================================
export async function appendJournalEntry(entry) {
  const row = [
    entry.date,
    entry.dayPnl || 0,
    entry.tradesCount || 0,
    entry.winCount || 0,
    entry.lossCount || 0,
    entry.notes || '',
    entry.weekNumber || ''
  ];
  await appendRows('Journal', [row]);
}

export async function getJournal() {
  return readTab('Journal');
}

// ================================================================
//  TRADE TICKET LIFECYCLE
// ================================================================
// ════════════════════════════════════════════════════════════════════════
//  TRADE LOG — one row per position (materialised from Decisions + Closes)
// ════════════════════════════════════════════════════════════════════════
// Pure so it can be tested without a spreadsheet. Columns are resolved BY NAME
// from the header row — Decisions has grown from 27 to 47 columns in two months
// and positional reads are how that becomes a silent data corruption.
// Which US trading session a stored instant belongs to, and the ET wall clock of
// that instant. Mirrors client/src/engine/session.js — the rule has to be identical
// in both places or a printed ticket and its trade-log row disagree about the date.
//
// Decisions timestamps are UTC instants. Taking .split('T')[0] read the UTC date,
// which for an engine run from Australia in the US evening is the session that had
// already finished. Market holidays are not handled here either; see the client.
export function etSessionParts(iso) {
  if (!iso) return { date: '', time: '' };
  const at = new Date(iso);
  if (isNaN(at)) return { date: '', time: '' };
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short'
  });
  const p = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  const hour = p.hour === '24' ? '00' : p.hour;          // en-CA renders midnight as 24
  const time = `${hour}:${p.minute}`;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const afterClose = Number(hour) >= 16;

  let date = `${p.year}-${p.month}-${p.day}`;
  if (afterClose || dow === 0 || dow === 6) {
    // Roll to the next weekday. Built from the ET calendar date at midday so the
    // arithmetic cannot slip a day across a DST boundary.
    const d = new Date(`${date}T12:00:00Z`);
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    date = d.toISOString().slice(0, 10);
  }
  return { date, time };
}

export function projectTradeLog(decRows, closeRows) {
  const H = decRows[0] || [];
  const ix = name => H.indexOf(name);
  const c = {
    ts: ix('Timestamp'), engine: ix('Engine'), und: ix('Underlying'),
    strat: ix('Strategy'), qty: ix('Contracts'), legs: ix('Wing Strikes'),
    status: ix('Status'), acct: ix('Account'), net: ix('Net Debit/Credit'),
    risk: ix('Max Risk'), profit: ix('Max Profit'), ev: ix('EV'),
    conf: ix('Confidence'),
    // Pre-tranche history. Everything closed before the Closes tab existed was
    // recorded straight onto the Decisions row and has no tranche to derive from.
    closeDate: ix('Close Date'), closePrice: ix('Close Price'),
    actualPnl: ix('Actual P&L'),
  };
  // tranches grouped by ticket ref (Closes col B)
  const byTicket = new Map();
  for (const r of (closeRows || []).slice(1)) {
    const k = String(r[1]);
    if (!byTicket.has(k)) byTicket.set(k, []);
    byTicket.get(k).push(r);
  }
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return isFinite(n) ? n : null; };
  const out = [];
  for (let i = 1; i < decRows.length; i++) {
    const d = decRows[i];
    if (!d || !d[c.ts]) continue;
    const ref = i + 1;                       // 1-based sheet row, matches Closes
    const tr = byTicket.get(String(ref)) || [];
    const qty = num(d[c.qty]) || 0;
    let qtyClosed = tr.reduce((a, r) => a + (num(r[8]) || 0), 0);
    let pnl = tr.reduce((a, r) => a + (num(r[11]) || 0), 0);
    let notional = tr.reduce((a, r) => a + (num(r[8]) || 0) * (num(r[10]) || 0), 0);
    let lastClose = tr.length ? tr.map(r => String(r[7] || '')).sort().pop() : '';
    const maxRisk = num(d[c.risk]);
    const ts = String(d[c.ts] || '');
    const et = etSessionParts(ts);
    let status = qtyClosed <= 0 ? 'Open' : (qtyClosed >= qty ? 'Closed' : 'Partial');

    // A ticket the Decisions row already calls Closed, with no tranche rows, is
    // pre-tranche history. Without this it projects as Open — and forty finished
    // trades reappearing as live positions, carrying their full max risk into the
    // "risk live" total, is worse than having no trade log at all. (Sep 2026.)
    const decStatus = String(d[c.status] ?? '').trim();
    if (!tr.length && /^(closed|expired|stopped\s*out)$/i.test(decStatus)) {
      qtyClosed = qty;
      pnl = num(d[c.actualPnl]) || 0;
      notional = qty * (num(d[c.closePrice]) || 0);
      lastClose = String(d[c.closeDate] ?? '');
      status = 'Closed';
    }

    out.push([
      ref,
      et.date,
      et.time,
      d[c.engine] ?? '', d[c.und] ?? '', d[c.strat] ?? '', d[c.legs] ?? '',
      qty,
      c.net >= 0 ? (d[c.net] ?? '') : '',
      c.risk >= 0 ? (d[c.risk] ?? '') : '',
      c.profit >= 0 ? (d[c.profit] ?? '') : '',
      c.ev >= 0 ? (d[c.ev] ?? '') : '',
      c.conf >= 0 ? (d[c.conf] ?? '') : '',
      qtyClosed,
      Math.max(0, qty - qtyClosed),
      // Legacy rows often have a P&L but no close price; a blank reads honestly,
      // a 0.0000 reads as "closed at zero".
      (qtyClosed > 0 && notional > 0) ? +(notional / qtyClosed).toFixed(4) : '',
      qtyClosed > 0 ? +pnl.toFixed(2) : '',
      // R multiple against the risk actually taken on the closed portion, so a
      // half-closed winner is not flattered by the whole position's risk.
      (qtyClosed > 0 && maxRisk > 0 && qty > 0)
        ? +(pnl / (maxRisk * (qtyClosed / qty))).toFixed(2) : '',
      status,
      tr.length,
      lastClose,
      d[c.acct] ?? ''
    ]);
  }
  return out;
}

// Overwrite the table with the projection. The only thing that keeps the three
// tables from drifting apart.
export async function rebuildTradeLog() {
  const [decRows, closeRows] = await Promise.all([getDecisions(), getCloses()]);
  const rows = projectTradeLog(decRows, closeRows);
  await replaceData('TradeLog', rows);
  return rows.length;
}

export async function getTradeLog() {
  return readTab('TradeLog');
}

// Open and partially-closed positions, each with its tranches attached. This is
// what the UI needs and it is derived, never stored.
export async function getOpenPositions() {
  const [decRows, closeRows] = await Promise.all([getDecisions(), getCloses()]);
  const rows = projectTradeLog(decRows, closeRows);
  const byTicket = new Map();
  for (const r of closeRows.slice(1)) {
    const k = String(r[1]);
    if (!byTicket.has(k)) byTicket.set(k, []);
    byTicket.get(k).push({
      closeId: r[0], closeDate: r[7], qtyClosed: Number(r[8]) || 0,
      qtyRemaining: Number(r[9]) || 0, closePrice: r[10],
      pnl: Number(r[11]) || 0, fees: r[12], notes: r[14] || ''
    });
  }
  const K = ['ticketRef','entryDate','entryTime','engine','underlying','strategy','legs',
    'qty','entryPrice','maxRisk','maxProfit','ev','confidence','qtyClosed','qtyOpen',
    'avgExit','realisedPnl','rMultiple','status','tranches','lastClose','account'];
  return rows
    .filter(r => r[18] !== 'Closed')
    .map(r => {
      const o = {}; K.forEach((k, i) => { o[k] = r[i]; });
      o.closes = byTicket.get(String(r[0])) || [];
      // Full ISO timestamp of the ticket — the key the engine's exit plan is saved
      // under at log time, so the sell ticket opens with the ladder set at entry.
      o.timestamp = (decRows[Number(r[0]) - 1] || [])[0] || '';
      return o;
    });
}

// ════════════════════════════════════════════════════════════════════════
//  CLOSES — one row per tranche (the sale log)
// ════════════════════════════════════════════════════════════════════════
export async function getCloses() {
  return readTab('Closes');
}

// Every tranche recorded against one ticket, oldest first.
// Every close as an object, for the tax report: date, account, net P&L, commission.
export async function getClosesList() {
  const rows = await getCloses();
  const h = rows[0] || [];
  return rows.slice(1).map(r => {
    const o = {}; h.forEach((k, i) => { o[k] = r[i] ?? ''; }); return o;
  });
}

export async function getClosesForTicket(ticketRef) {
  const rows = await getCloses();
  const want = String(ticketRef);
  return rows.slice(1).filter(r => String(r[1]) === want);
}

export async function appendClose(c) {
  const row = [
    c.closeId || ('C' + Date.now()),
    c.ticketRef ?? '',
    c.ticketTimestamp || '',
    c.engine || '',
    c.underlying || '',
    c.strategy || '',
    c.entryDate || '',
    c.closeDate || new Date().toISOString().split('T')[0],
    c.qtyClosed ?? '',
    c.qtyRemaining ?? '',
    c.closePrice ?? '',
    c.pnl ?? 0,
    c.fees ?? '',
    c.account || '',
    c.notes || ''
  ];
  await appendRows('Closes', [row]);
  return row;
}

// Blend the tranches into the single set of numbers the Decisions row holds.
// Close Price is quantity-weighted -- a straight average would let a 1-lot scratch
// cancel a 5-lot winner. P&L is a plain sum. Exported for the tests.
export function blendCloses(tranches) {
  let qty = 0, notional = 0, pnl = 0;
  for (const t of tranches) {
    const q = Number(t.qtyClosed) || 0, p = Number(t.closePrice);
    const l = Number(t.pnl) || 0;
    qty += q;
    if (isFinite(p)) notional += q * p;
    pnl += l;
  }
  return {
    qty,
    closePrice: qty > 0 ? +(notional / qty).toFixed(4) : null,
    pnl: +pnl.toFixed(2)
  };
}

export async function closeTradeTicket(rowIndex, closeData) {

  // ── tranche accounting ──────────────────────────────────────────────────
  // qtyClosed absent means "close whatever is left", which is the old behaviour
  // and what every existing caller wants.
  const decRows = await getDecisions();
  const decRow = decRows[rowIndex - 1] || [];
  const totalQty = Number(decRow[5]) || 1;              // F = Contracts
  const prior = await getClosesForTicket(rowIndex);
  const priorQty = prior.reduce((a, r) => a + (Number(r[8]) || 0), 0);
  const openQty = Math.max(0, totalQty - priorQty);
  const reqQty = Number(closeData.qtyClosed);
  const qtyClosed = (isFinite(reqQty) && reqQty > 0) ? Math.min(reqQty, openQty) : openQty;
  const qtyRemaining = Math.max(0, openQty - qtyClosed);

  // ── commission (Oct 2026) ── Every tranche is stored NET of its round-trip
  // commission (its share of the entry plus the close), with the commission in
  // Closes.fees_usd, so the log, the tracker and the tax report all read one
  // number and gross is always net + fees. Callers send grossPnl or netPnl; fees
  // they don't know are estimated from the ticket's contracts and the account rate.
  const pnl = resolveClosePnl({
    grossPnl: closeData.grossPnl, netPnl: closeData.netPnl, actualPnl: closeData.actualPnl,
    fees: closeData.fees, units: unitsFromTicket(decRow[11], decRow[3]),
    qty: qtyClosed, rate: closeData.commissionRate
  });
  const feeNote = pnl.feesSource === 'estimate' ? `commission est. $${pnl.fees.toFixed(2)}` : '';

  await appendClose({
    ticketRef: rowIndex,
    ticketTimestamp: decRow[0] || '',
    engine: decRow[1] || '',
    underlying: decRow[2] || '',
    strategy: decRow[3] || '',
    entryDate: (decRow[0] || '').split('T')[0],
    closeDate: closeData.closeDate,
    qtyClosed,
    qtyRemaining,
    closePrice: closeData.closePrice ?? '',
    pnl: pnl.net,
    fees: pnl.fees,
    account: closeData.account || decRow[26] || '',
    notes: [closeData.notes || '', feeNote].filter(Boolean).join(' — ')
  });

  // The Decisions row carries the BLENDED result across every tranche so far, so
  // the ticket keeps reading as one trade. Status stays 'Partial' until the last
  // contract is out -- which is also what stops the endpoint's duplicate guard
  // from rejecting the second tranche.
  const all = [...prior.map(r => ({ qtyClosed: r[8], closePrice: r[10], pnl: r[11] })),
               { qtyClosed, closePrice: closeData.closePrice, pnl: pnl.net }];
  const blended = blendCloses(all);

  // Columns: V=Status(22), W=Close Date(23), X=Close Price(24), Y=Actual P&L(25)
  await setCells('Decisions', rowIndex, 21, [
      qtyRemaining > 0 ? 'Partial' : 'Closed',
      closeData.closeDate || new Date().toISOString().split('T')[0],
      blended.closePrice ?? (closeData.closePrice || ''),
      blended.pnl
    ]);
  // Close IV (AF) + Close VIX (AG) -- optional, written only if captured at close
  if (closeData.closeIV != null || closeData.closeVix != null) {
    await setCells('Decisions', rowIndex, 31, [
        closeData.closeIV ?? '',
        closeData.closeVix ?? ''
      ]);
  }
  // Session High (AP) + Low (AQ) -- what the day ACTUALLY did, so realised range can be
  // compared with the expected move the ticket was priced on without re-reading a chart.
  // Same best-effort contract as Close VIX: absent bridge -> blank, close still proceeds.
  if (closeData.sessionHigh != null || closeData.sessionLow != null) {
    await setCells('Decisions', rowIndex, 41, [
        closeData.sessionHigh ?? '',
        closeData.sessionLow ?? ''
      ]);
  }
  // Underlying Price Close (AS) + VIX1D Close (AT) -- the rest of the close vol
  // snapshot. Same best-effort contract: absent bridge -> blank, close proceeds.
  if (closeData.closeUnderlyingPrice != null || closeData.closeVix1d != null) {
    await setCells('Decisions', rowIndex, 44, [
        closeData.closeUnderlyingPrice ?? '',
        closeData.closeVix1d ?? ''
      ]);
  }
  // What the caller needs to tell the user: how much went, how much is left, and
  // the blended position-level result so far.
  return { qtyClosed, qtyRemaining, totalQty, fullyClosed: qtyRemaining === 0,
           blendedClosePrice: blended.closePrice, totalPnl: blended.pnl,
           tranche: { gross: pnl.gross, fees: pnl.fees, net: pnl.net, feesSource: pnl.feesSource } };
}

// Backfill vol-snapshot fields on an ALREADY-CLOSED decision row. Used by the
// reconcile "Accept & close" path, which closes instantly and lets the bridge
// snapshot land a few seconds later. Fill-only-blank: an existing value in any
// cell is never overwritten, so a normal close's data always wins.
export async function backfillDecisionVol(rowIndex, snap) {
  const cur = await readRow('Decisions', rowIndex);
  // Column indexes: AF=31 Close IV, AG=32 Close VIX, AP=41 Session High,
  // AQ=42 Session Low, AS=44 Underlying Price Close, AT=45 VIX1D Close.
  const CELLS = [
    { idx: 31, val: snap.closeIV },
    { idx: 32, val: snap.closeVix },
    { idx: 41, val: snap.sessionHigh },
    { idx: 42, val: snap.sessionLow },
    { idx: 44, val: snap.closeUnderlyingPrice },
    { idx: 45, val: snap.closeVix1d }
  ];
  const data = CELLS.filter(c => c.val != null && c.val !== '' && !(cur[c.idx] != null && cur[c.idx] !== ''));
  if (!data.length) return { updated: 0 };
  await tx(async (client) => {
    for (const c of data) await setCells('Decisions', rowIndex, c.idx, [c.val], client);
  });
  return { updated: data.length };
}

export async function updateTradeNotes(rowIndex, notes) {
  // Column Z = Trade Notes (index 25)
  await setCells('Decisions', rowIndex, 25, [notes]);
}

export async function updateTradeStatus(rowIndex, status) {
  // Column V = Status (index 21)
  await setCells('Decisions', rowIndex, 21, [status]);
}

// ================================================================
//  UPDATE TRACKER STRATEGY -- manual categorisation
// ================================================================
export async function updateTrackerStrategy(rowIndex, strategy) {
  // Column E = Strategy (OIC) (index 4)
  await setCells('TradeTracker', rowIndex, 4, [strategy]);
}

// Also update the raw Trades table for matching legs
export async function updateTradesStrategy(orderId, strategy) {
  const rows = await getTrades();
  // Find rows with this order ID (column B = index 1) and update strategy (column C = index 2)
  const targets = [];
  rows.forEach((row, i) => {
    if (i === 0) return; // skip header
    const oid = (row[1] || '').trim();
    if (orderId.split(',').some(id => oid.includes(id.trim()))) targets.push(i + 1);
  });
  if (targets.length > 0) {
    await q('update options.trades set strategy_oic = $1, updated_at = now() where row_no = any($2::int[])',
      [strategy, targets]);
  }
  return targets.length;
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
//  DOCUMENTS — Supabase Storage (bucket options-docs) + options.documents
//  Storage calls run as the signed-in user; bucket policies only admit
//  allowlisted users. Return shapes mirror what the Drive version returned.
// ================================================================
const DOC_BUCKET = 'options-docs';

function docOut(r) {
  return {
    id: r.id,
    name: r.name,
    mimeType: r.mime_type,
    size: r.size != null ? String(r.size) : undefined,
    createdTime: new Date(r.created_at).toISOString(),
    description: JSON.stringify(r.meta || {}),
    meta: r.meta || {}
  };
}

export async function uploadDocument(fileBuffer, filename, mimeType, metadata, userToken) {
  const safe = String(filename || 'file').replace(/[^\w.\- ]+/g, '_').slice(-120);
  const path = `${new Date().toISOString().slice(0, 10)}/${Date.now()}-${safe}`;
  try {
    await sbFetch(`/storage/v1/object/${DOC_BUCKET}/${encPath(path)}`, userToken, {
      method: 'POST',
      headers: { 'Content-Type': mimeType || 'application/octet-stream', 'x-upsert': 'false' },
      body: fileBuffer
    });
  } catch (e) { throw new Error('Storage upload failed: ' + e.message); }
  const r = await q(
    `insert into options.documents (name, mime_type, size, storage_path, meta)
     values ($1, $2, $3, $4, $5) returning *`,
    [filename, mimeType, fileBuffer?.length ?? null, path, metadata || {}]);
  return docOut(r.rows[0]);
}

export async function listDocuments() {
  const r = await q('select * from options.documents order by created_at desc limit 100');
  return r.rows.map(docOut);
}

export async function deleteDocument(fileId, userToken) {
  const r = await q('select storage_path from options.documents where id = $1', [fileId]);
  if (!r.rows[0]) return;
  try {
    await sbFetch(`/storage/v1/object/${DOC_BUCKET}`, userToken, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: [r.rows[0].storage_path] })
    });
  } catch (e) { throw new Error('Storage delete failed: ' + e.message); }
  await q('delete from options.documents where id = $1', [fileId]);
}

// Short-lived signed link instead of Drive's "anyone with the link" sharing.
export async function getDocumentUrl(fileId, userToken) {
  const r = await q('select storage_path from options.documents where id = $1', [fileId]);
  if (!r.rows[0]) throw new Error('Document not found');
  let data;
  try {
    data = await sbFetch(`/storage/v1/object/sign/${DOC_BUCKET}/${encPath(r.rows[0].storage_path)}`, userToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: 3600 })
    });
  } catch (e) { throw new Error('Could not create link: ' + e.message); }
  const url = `${SUPABASE_URL()}/storage/v1${data.signedURL || data.signedUrl}`;
  return { webViewLink: url, webContentLink: url };
}
