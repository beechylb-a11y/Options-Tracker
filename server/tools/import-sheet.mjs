// One-time (re-runnable) import of the old Google Sheet into Supabase.
//
//   1. In Google Sheets: File -> Download -> Microsoft Excel (.xlsx)
//   2. DATABASE_URL="postgresql://options_app.<ref>:<pw>@<pooler-host>:5432/postgres" \
//        node server/tools/import-sheet.mjs "~/Downloads/Options tracker.xlsx" [--replace] [--dry-run]
//
// Without --replace it refuses to touch a table that already has rows, so it can
// never silently overwrite trades logged after cutover. Every row keeps its sheet
// row number (row_no), which is what Closes.ticket_ref and the UI's rowIndex use.
import XLSX from 'xlsx';
import { pool, TABS } from '../db.js';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
const REPLACE = args.includes('--replace');
const DRY = args.includes('--dry-run');
if (!file) { console.error('usage: node server/tools/import-sheet.mjs <file.xlsx> [--replace] [--dry-run]'); process.exit(1); }

const wb = XLSX.readFile(file.replace(/^~/, process.env.HOME), { cellFormula: true });

// A cell as the Sheets API returned it (FORMATTED_VALUE, all "General" format).
const str = (c) => {
  if (!c || c.v === undefined || c.v === null) return '';
  if (typeof c.v === 'boolean') return c.v ? 'TRUE' : 'FALSE';
  if (typeof c.v === 'number') return String(c.v);
  return String(c.v);
};
function sheetRows(name) {
  const ws = wb.Sheets[name];
  if (!ws || !ws['!ref']) return [];
  const range = XLSX.utils.decode_range(ws['!ref']);
  const out = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = 0; c <= range.e.c; c++) row.push(str(ws[XLSX.utils.encode_cell({ r, c })]));
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

const plan = [];
for (const [tab, def] of Object.entries(TABS)) {
  const rows = sheetRows(tab);
  if (!rows.length) { plan.push({ tab, table: def.table, rows: [] }); continue; }
  const header = rows[0];
  // Guard: the sheet's columns must line up with the table's, in order.
  header.forEach((h, i) => {
    if (h && def.cols[i] && h !== def.cols[i].header) throw new Error(`${tab} column ${i + 1}: sheet has "${h}", table expects "${def.cols[i].header}"`);
    if (h && !def.cols[i]) throw new Error(`${tab}: sheet has extra column "${h}"`);
  });
  plan.push({ tab, table: def.table, rows: rows.slice(1) });
}

// Config: formulas like =B2*0.2 are rewritten to reference keys (=currentBankroll*0.2).
const cfgWs = wb.Sheets.Config;
const cfg = [];
if (cfgWs) {
  const rng = XLSX.utils.decode_range(cfgWs['!ref']);
  const keyAt = {};
  for (let r = 1; r <= rng.e.r; r++) keyAt[`B${r + 1}`] = str(cfgWs[`A${r + 1}`]);
  for (let r = 1; r <= rng.e.r; r++) {
    const key = str(cfgWs[`A${r + 1}`]);
    if (!key || key === 'googleTokens') continue;
    const cell = cfgWs[`B${r + 1}`];
    let value = cell?.f ? '=' + cell.f.replace(/\$?B\$?(\d+)/g, (m, n) => keyAt[`B${n}`] || m) : str(cell);
    cfg.push([key, value, r]);
  }
}
const ba = sheetRows('BattingAverage').slice(1).filter(r => r[0]);

console.log('Sheet contents:');
plan.forEach(p => console.log(`  ${p.tab.padEnd(13)} ${String(p.rows.length).padStart(4)} rows -> options.${p.table}`));
console.log(`  Config        ${String(cfg.length).padStart(4)} keys`);
console.log(`  BattingAvg    ${String(ba.length).padStart(4)} metrics`);
if (DRY) { console.log('\n--dry-run: nothing written.'); await pool.end(); process.exit(0); }

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const p of [...plan, { table: 'config' }, { table: 'batting_average' }]) {
    const n = (await client.query(`select count(*)::int n from options."${p.table}"`)).rows[0].n;
    if (n > 0 && !REPLACE) throw new Error(`options.${p.table} already has ${n} rows. Re-run with --replace to overwrite.`);
    await client.query(`delete from options."${p.table}"`);
  }
  for (const p of plan) {
    const def = TABS[p.tab];
    const cols = ['row_no', ...def.cols.map(c => c.col)];
    for (let i = 0; i < p.rows.length; i++) {
      const row = p.rows[i];
      const vals = [i + 2, ...def.cols.map((_, j) => (row[j] === undefined || row[j] === '') ? null : row[j])];
      await client.query(
        `insert into options."${p.table}" (${cols.map(c => `"${c}"`).join(',')}) values (${vals.map((_, k) => '$' + (k + 1)).join(',')})`,
        vals);
    }
  }
  for (const [key, value, order] of cfg) {
    await client.query('insert into options.config (key, value, sort_order) values ($1, $2, $3)', [key, value, order]);
  }
  for (let i = 0; i < ba.length; i++) {
    await client.query('insert into options.batting_average (metric, value, sort_order) values ($1, $2, $3)', [ba[i][0], ba[i][1] || '0', i + 1]);
  }
  await client.query('COMMIT');
  console.log('\nImported. Row counts now:');
  for (const p of plan) {
    const n = (await client.query(`select count(*)::int n from options."${p.table}"`)).rows[0].n;
    console.log(`  options.${p.table.padEnd(14)} ${n}${n === p.rows.length ? '' : '  <-- MISMATCH'}`);
  }
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('\nImport failed, nothing written:', e.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
