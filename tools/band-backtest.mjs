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

// ── Sweep: wing width × exit time ────────────────────────────────────────────
// The point of this sweep is NOT to find the highest hit rate. A narrower band always
// hits less and a later exit always hits more, and neither fact tells you what to trade.
// What it reports instead is what the structure is WORTH at the exit, because that is
// the number a quote has to beat.
//
// Two corrections that the headline P&L above does not make:
//
//   1. A fly at its body before expiry is worth LESS than its intrinsic — price can
//      still leave. Using the expiry payoff at a 15:45 price overstates what you could
//      actually sell it for, and the error grows the earlier you exit. So the value at
//      each exit is computed with the time still to run, not as if it were 16:00.
//   2. Wider wings cost more. Comparing wing widths at one fixed debit is meaningless,
//      so each cell reports fair value and its share of the wing width, which IS
//      comparable across widths.
//
// Remaining volatility is scaled from the sample's own measured sigma by √time, so it
// comes from your data rather than from an assumption about QQQ.
if (args.includes('--sweep')) {
  // Robust sigma over the entry→exit window: the median of |move| is 0.6745σ for a
  // normal, and unlike a standard deviation it is not dragged around by the 17-point day.
  const sigWindow = moves[Math.floor(0.5 * (moves.length - 1))] / 0.6745;
  const toMin = s => (+s.slice(0, 2)) * 60 + (+s.slice(3, 5));
  const entryMin = toMin(ENTRY), closeMin = 16 * 60;
  const windowMin = toMin(EXIT) - entryMin;

  // E[max(0, W − |Y|)] for Y ~ N(m, s), by Simpson. Deterministic, so the table does
  // not wobble between runs the way a Monte Carlo one would.
  const flyValue = (m, W, s) => {
    if (s <= 1e-9) return Math.max(0, W - Math.abs(m));
    const n = 200, a = -W, b = W, h = (b - a) / n;
    const f = y => (W - Math.abs(y)) * Math.exp(-((y - m) ** 2) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
    let acc = f(a) + f(b);
    for (let i = 1; i < n; i++) acc += f(a + i * h) * (i % 2 ? 4 : 2);
    return acc * h / 3;
  };

  const EXITS = ['13:00', '14:00', '14:30', '15:00', '15:30', '15:45', '15:55'];
  const WINGS = [2, 3, 4, 5, 6];

  // Hit rate by exit needs the price AT that exit, so re-walk the sessions.
  console.log(`\n\nSWEEP — measured σ over ${ENTRY}→${EXIT} is ${sigWindow.toFixed(2)} pts\n`);
  console.log(`Band ±${half} hit rate by exit time`);
  const exitRows = {};
  for (const ex of EXITS) {
    const rs = [];
    for (const [day, bars] of sessions) {
      const a = bars.get(ENTRY), z = bars.get(ex);
      if (a != null && z != null) rs.push(z - a);
    }
    if (!rs.length) continue;
    exitRows[ex] = rs;
    const h = rs.filter(m => Math.abs(m) <= half).length;
    console.log(`  ${ex}  ${String(h).padStart(3)}/${String(rs.length).padStart(3)}  ${(100 * h / rs.length).toFixed(1).padStart(5)}%`);
  }

  console.log(`\nFly fair value AT EXIT — body at the ${ENTRY} price. This is the breakeven debit:`);
  console.log(`pay less than the number in the cell and you have an edge, pay more and you do not.\n`);
  console.log('  wing │ ' + EXITS.map(e => e.padStart(7)).join(' ') + '   (share of wing width)');
  console.log('  ─────┼' + '─'.repeat(EXITS.length * 8 + 24));
  for (const W of WINGS) {
    const cells = [], shares = [];
    for (const ex of EXITS) {
      const rs = exitRows[ex];
      if (!rs) { cells.push('     — '); continue; }
      const remain = Math.max(0, closeMin - toMin(ex));
      const s = sigWindow * Math.sqrt(remain / Math.max(1, windowMin));
      const fv = rs.reduce((acc, m) => acc + flyValue(m, W, s), 0) / rs.length;
      cells.push(fv.toFixed(2).padStart(7));
      shares.push(Math.round(100 * fv / W));
    }
    const mid = shares.length ? `${Math.min(...shares)}–${Math.max(...shares)}%` : '';
    console.log(`  ±${String(W).padEnd(3)} │ ` + cells.join(' ') + `   ${mid}`);
  }
  console.log(`\n  Later exits are worth more here only because less time remains for price to`);
  console.log(`  leave the body — that is decay you collect, not a better trade. What decides`);
  console.log(`  it is the gap between these numbers and the quote you can actually fill.`);
  console.log(`  Note 15:55 ≈ expiry: holding QQQ that late risks assignment on ITM shorts.`);
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
