#!/usr/bin/env node
/**
 * band-backtest.mjs — how often does price stay inside a band from entry to exit?
 *
 *   node tools/band-backtest.mjs
 *   node tools/band-backtest.mjs --underlying QQQ --entry 11:35 --exit 15:45 --band 4 --months 3
 *   node tools/band-backtest.mjs --wing 3 --debit 1        # also model the fly's P&L
 *
 * Anchors on the entry-time price each day, then asks where price was at exit time.
 * Needs the bridge running against TWS: node tools/band-backtest.mjs --url http://localhost:3333
 *
 * WHAT A BAND HIT RATE IS AND IS NOT
 * "Price finished inside the band" is NOT the same as "the butterfly made money", and
 * the gap is not small. Three reasons, all of which cost you money in the same direction:
 *
 *   1. A butterfly pays max profit only AT the body. Landing just inside a breakeven
 *      returns roughly nothing. The hit rate counts that as a win; your account does not.
 *   2. You paid a debit. A fly whose breakevens sit 4 points apart is not free, and the
 *      hit rate has to clear the debit before the structure is worth doing at all.
 *   3. Exit at 15:45 is not settlement at 16:00. Fifteen minutes of 0DTE gamma remain,
 *      and that is precisely when a pinned position is least stable.
 *
 * So the hit rate is an upper bound on how often this works, not an estimate of edge.
 * Pass --wing and --debit and the script will also compute the actual expiry payoff of
 * a long fly (body at entry price, wings at ±wing, cost = debit), which is the number
 * that decides whether the trade is worth taking.
 */

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const URL_BASE   = arg('--url', 'http://localhost:3333');
const UNDERLYING = arg('--underlying', 'QQQ').toUpperCase();
const ENTRY      = arg('--entry', '11:35');
const EXIT       = arg('--exit', '15:45');
const BAND       = parseFloat(arg('--band', '4'));      // total width; half each side
const MONTHS     = parseInt(arg('--months', '3'), 10);
const BAR        = arg('--bar', '5 mins');
const WING       = arg('--wing', null) != null ? parseFloat(arg('--wing', null)) : null;
const DEBIT      = arg('--debit', null) != null ? parseFloat(arg('--debit', null)) : null;

const half = BAND / 2;

// ── Fetch ────────────────────────────────────────────────────────────────────
const url = `${URL_BASE}/api/history?underlying=${UNDERLYING}&months=${MONTHS}&barSize=${encodeURIComponent(BAR)}`;
console.log(`Fetching ${MONTHS}m of ${BAR} bars for ${UNDERLYING}…`);
let data;
try {
  const res = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  data = await res.json();
} catch (e) {
  console.error(`\nCould not reach the bridge at ${URL_BASE}: ${e.message}`);
  console.error('Is it running, and is TWS connected?  curl -s ' + URL_BASE + '/api/health');
  process.exit(1);
}
if (data.error) { console.error('Bridge error: ' + data.error); process.exit(1); }
if (data.errors) data.errors.forEach(e => console.error('  ⚠ ' + e));
console.log(`Got ${data.count} bars, ${data.first} → ${data.last}\n`);

// ── Group into sessions ──────────────────────────────────────────────────────
// Bar timestamps are "yyyymmdd  hh:mm:ss" in EXCHANGE-local time (US/Eastern here),
// not UTC. Parsing them as dates would silently shift them; split the string instead.
const sessions = new Map();
for (const b of data.bars) {
  const m = /^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2})/.exec(String(b.date));
  if (!m) continue;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  const hhmm = `${m[4]}:${m[5]}`;
  if (!sessions.has(day)) sessions.set(day, new Map());
  sessions.get(day).set(hhmm, b.close);
}

const rows = [];
const missing = [];
for (const [day, bars] of [...sessions.entries()].sort()) {
  const a = bars.get(ENTRY), z = bars.get(EXIT);
  // A session missing either leg is DROPPED, not filled with a nearby bar. Half-days
  // and outages are exactly the sessions where a substituted price would be most wrong.
  if (a == null || z == null) { missing.push(day); continue; }
  rows.push({ day, anchor: a, close: z, move: z - a });
}

if (!rows.length) {
  console.error(`No session had both a ${ENTRY} and a ${EXIT} bar. Check the bar size divides those times.`);
  process.exit(1);
}

// ── Band hit rate ────────────────────────────────────────────────────────────
const inBand = rows.filter(r => Math.abs(r.move) <= half);
const moves = rows.map(r => Math.abs(r.move)).sort((x, y) => x - y);
const pct = q => moves[Math.floor(q * (moves.length - 1))];
const mean = rows.reduce((s, r) => s + r.move, 0) / rows.length;

// Wilson interval — a normal approximation misleads badly on small samples near the
// extremes, and this sample is small.
function wilson(k, n) {
  const p = k / n, z = 1.96, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const w = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - w), Math.min(1, c + w)];
}
const [lo, hi] = wilson(inBand.length, rows.length);

console.log(`${UNDERLYING}  ${ENTRY} → ${EXIT} ET   ${rows.length} sessions` +
  (missing.length ? `  (${missing.length} dropped for missing bars)` : ''));
console.log(`\nBand ±${half} (${BAND} wide, centred on the ${ENTRY} price)`);
console.log(`  finished inside : ${inBand.length}/${rows.length} = ${(100 * inBand.length / rows.length).toFixed(1)}%`);
console.log(`  95% CI          : ${(100 * lo).toFixed(1)}% – ${(100 * hi).toFixed(1)}%`);
console.log(`\n|move| from ${ENTRY} to ${EXIT}, in points`);
console.log(`  median ${pct(0.5).toFixed(2)}   75th ${pct(0.75).toFixed(2)}   90th ${pct(0.9).toFixed(2)}   max ${moves[moves.length - 1].toFixed(2)}`);
console.log(`  mean SIGNED move ${mean >= 0 ? '+' : ''}${mean.toFixed(3)} — a drift far from zero means the anchor is biased, not that the band is wrong`);

// ── Actual butterfly payoff ──────────────────────────────────────────────────
if (WING != null && DEBIT != null) {
  const payoff = m => Math.max(0, WING - Math.abs(m)) - DEBIT;   // long fly at expiry
  const pnl = rows.map(r => payoff(r.move));
  const total = pnl.reduce((s, x) => s + x, 0);
  const wins = pnl.filter(x => x > 0).length;
  const be = WING - DEBIT;
  console.log(`\nLong butterfly — body at the ${ENTRY} price, wings ±${WING}, debit ${DEBIT.toFixed(2)}`);
  console.log(`  breakevens      : ±${be.toFixed(2)} (${(2 * be).toFixed(2)} wide)`);
  console.log(`  profitable      : ${wins}/${rows.length} = ${(100 * wins / rows.length).toFixed(1)}%`);
  console.log(`  mean P&L / trade: ${total / rows.length >= 0 ? '+' : ''}${(total / rows.length).toFixed(3)} pts  (×100 = $${(100 * total / rows.length).toFixed(0)} per contract)`);
  console.log(`  total over ${rows.length}  : ${total >= 0 ? '+' : ''}${total.toFixed(2)} pts`);
  console.log(`  worst / best    : ${Math.min(...pnl).toFixed(2)} / ${Math.max(...pnl).toFixed(2)}`);
  console.log(`\n  The debit is an ASSUMPTION, not a fill. Change --debit and this flips sign`);
  console.log(`  long before the hit rate moves at all — that is where the edge actually lives.`);
} else {
  console.log(`\nPass --wing and --debit to model the real fly payoff. The band hit rate above`);
  console.log(`is an upper bound on how often this works, not an estimate of profit.`);
}

// ── Month by month, to see whether it is stable or one good stretch ──────────
const byMonth = new Map();
for (const r of rows) {
  const k = r.day.slice(0, 7);
  if (!byMonth.has(k)) byMonth.set(k, []);
  byMonth.get(k).push(r);
}
if (byMonth.size > 1) {
  console.log(`\nBy month (a single good stretch is not an edge)`);
  for (const [k, rs] of [...byMonth.entries()].sort()) {
    const h = rs.filter(r => Math.abs(r.move) <= half).length;
    console.log(`  ${k}  ${String(h).padStart(2)}/${String(rs.length).padStart(2)} inside  ${(100 * h / rs.length).toFixed(0).padStart(3)}%`);
  }
}
