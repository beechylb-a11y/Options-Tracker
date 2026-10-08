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

// ── Sweep: what the structure is worth, measured rather than modelled ───────
//
// WHAT THIS ANSWERS, AND WHAT IT CANNOT.
//
// The first version of this sweep printed a fair value per wing width PER EXIT TIME
// and invited you to read the row left to right for a best time to get out. That was
// a mistake, and not a small one: the row is flat BY IDENTITY, not by accident.
//
// The quantity in each cell is the average over sessions of E[payoff | price at that
// exit]. By the law of total expectation that averages back to E[payoff] whatever
// exit you pick, so every column must agree up to estimation error. The first run's
// mild wiggle (±2 reading 0.57 / 0.60 / 0.55 / 0.59 / 0.66 / 0.63 / 0.53) was the
// modelling error, not a signal. Nothing about exit TIMING can come out of a mean.
//
// So the table has been split in two, and the distributional assumption dropped:
//
//   1. ONE fair value per wing width — the mean expiry payoff over the sample itself,
//      with no normal, no sigma and no √time scaling. This is the breakeven debit.
//      It is the only number here a quote has to beat.
//
//   2. HOW OFTEN a given gain is actually on the screen at each exit. That is a
//      question about the DISTRIBUTION of the mark, which the mean throws away, and
//      it is what an exit rule ("take half at +50%") actually needs.
//
// The mark at an exit is E[payoff | price there], evaluated against the empirical
// pool of same-exit→close moves from the sample rather than a normal. The previous
// version scaled a median-derived sigma by √time, which understated the tails badly:
// the sample's 90th percentile |move| was 5.43 against the 3.60 a normal with that
// median implies. Every modelled cell was therefore biased high. The comparison
// column below prints that bias as a number instead of hiding it.
if (args.includes('--sweep')) {
  const EXITS = ['13:00', '14:00', '14:30', '15:00', '15:30', '15:45', '15:55'];
  const WINGS = [2, 3, 4, 5, 6];

  // Settlement proxy: the last bar of each session. A session that ends early — half
  // day, outage, feed gap — is dropped rather than having a midday price treated as
  // a close, because those are exactly the days where the substitution is most wrong.
  const S = [];
  const shortDays = [];
  for (const [day, bars] of [...sessions.entries()].sort()) {
    const a = bars.get(ENTRY);
    if (a == null) continue;
    const last = [...bars.keys()].sort().pop();
    if (last < '15:50') { shortDays.push(day); continue; }
    S.push({ day, anchor: a, close: bars.get(last), bars });
  }
  if (!S.length) {
    console.error('\nNo session had both an entry bar and a bar at or after 15:50.');
  } else {

  const flyAt = (dist, W) => Math.max(0, W - Math.abs(dist));
  const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

  console.log(`\n\nSWEEP — ${S.length} sessions with a ${ENTRY} bar and a settlement bar`
    + (shortDays.length ? `  (${shortDays.length} short session${shortDays.length === 1 ? '' : 's'} dropped)` : ''));

  // ── 1 · Fair value, measured ───────────────────────────────────────────────
  // Body at the entry price, held to settlement. The mean of the realised payoff IS
  // the fair value, so no model is involved and no tail is assumed.
  const totals = S.map(d => d.close - d.anchor);
  const fv = {}, fvSe = {};
  for (const W of WINGS) {
    const pay = totals.map(m => flyAt(m, W));
    fv[W] = avg(pay);
    // The standard error matters more here than anywhere else in this script. A fly's
    // payoff is mostly zeros with occasional large values, so the mean of 64 of them
    // is not a precise number, and quoting "33% of wing width" to two figures without
    // this is false precision. Run more --months to shrink it.
    fvSe[W] = Math.sqrt(avg(pay.map(x => (x - fv[W]) ** 2)) / Math.max(1, pay.length - 1));
  }

  // The old modelled number, kept only so the cost of the normal assumption is
  // visible. Robust sigma: median |move| / 0.6745 is the normal relationship, and
  // unlike a standard deviation it is not dragged around by one violent day.
  const absT = totals.map(Math.abs).sort((x, y) => x - y);
  const sigRobust = absT[Math.floor(0.5 * (absT.length - 1))] / 0.6745;
  const flyNormal = (W, s) => {
    if (s <= 1e-9) return W;
    const n = 400, a = -W, b = W, h = (b - a) / n;
    const f = y => flyAt(y, W) * Math.exp(-(y * y) / (2 * s * s)) / (s * Math.sqrt(2 * Math.PI));
    let acc = f(a) + f(b);
    for (let i = 1; i < n; i++) acc += f(a + i * h) * (i % 2 ? 4 : 2);
    return acc * h / 3;
  };

  console.log(`\nFAIR VALUE — body at the ${ENTRY} price, held to settlement. This is the breakeven`);
  console.log(`debit: pay less than this and you have an edge, pay more and you do not.\n`);
  // Header, rule and rows all built from one list of widths, so a column cannot drift
  // out of line when a figure changes width.
  const COLS = [['wing', 6], ['measured', 10], ['± se', 8], ['share of wing', 15],
                ['normal model', 14], ['its error', 11]];
  const rule = COLS.map(c => '─'.repeat(c[1])).join('┼');
  console.log('  ' + COLS.map(c => c[0].padStart(c[1] - 1) + ' ').join('│'));
  console.log('  ' + rule);
  for (const W of WINGS) {
    const mdl = flyNormal(W, sigRobust);
    const err = fv[W] > 1e-9 ? 100 * (mdl - fv[W]) / fv[W] : 0;
    const cells = [
      '±' + W,
      fv[W].toFixed(2),
      '±' + fvSe[W].toFixed(2),
      (100 * fv[W] / W).toFixed(1) + '%',
      mdl.toFixed(2),
      (err >= 0 ? '+' : '−') + Math.abs(err).toFixed(0) + '%',
    ];
    console.log('  ' + cells.map((v, i) => v.padStart(COLS[i][1] - 1) + ' ').join('│'));
  }
  // The DIRECTION of the model's error is an empirical question, so it is measured and
  // reported rather than asserted. An earlier version of this block printed a
  // conclusion as static text and the data then disagreed with it, which is a worse
  // failure than printing nothing: the text is what gets read and remembered.
  const errs = WINGS.map(W => fv[W] > 1e-9 ? (flyNormal(W, sigRobust) - fv[W]) / fv[W] : 0);
  const meanErr = avg(errs);
  const p90 = absT[Math.floor(0.9 * (absT.length - 1))];
  console.log(`\n  Robust σ over ${ENTRY}→settlement is ${sigRobust.toFixed(2)} pts. Tails: the 90th percentile |move|`);
  console.log(`  is ${p90.toFixed(2)} against the ${(1.645 * sigRobust).toFixed(2)} a normal with that σ implies`
    + ` (${p90 > 1.645 * sigRobust ? 'fatter' : 'thinner'} by ${Math.abs(100 * (p90 / (1.645 * sigRobust) - 1)).toFixed(0)}%).`);
  console.log(`  On this sample the normal model reads ${Math.abs(meanErr) < 0.03 ? 'within a few percent of'
    : meanErr > 0 ? `${(100 * meanErr).toFixed(0)}% HIGH against` : `${(-100 * meanErr).toFixed(0)}% LOW against`} the measured value.`);
  console.log(`  Fat tails cut both ways on a butterfly — they put more weight far from the body`);
  console.log(`  AND more right on it — so the sign cannot be reasoned out, only measured. The`);
  console.log(`  measured column needs no σ at all: it is the realised payoff, averaged.`);

  // ── 2 · When a gain is actually available ──────────────────────────────────
  // The mark at an exit is E[payoff | price there]. Taken against the empirical pool
  // of same-exit→close moves, so the only assumption left is that the move BEFORE the
  // exit and the move AFTER it are independent — which is reported, not assumed.
  const MULT = parseFloat(arg('--gain', '1.5'));
  const perExit = {};
  for (const ex of EXITS) {
    const have = S.filter(d => d.bars.get(ex) != null);
    if (have.length < 10) continue;
    const m = have.map(d => d.bars.get(ex) - d.anchor);        // entry → exit
    const r = have.map(d => d.close - d.bars.get(ex));         // exit → settlement
    const mM = avg(m), mR = avg(r);
    const cov = avg(m.map((x, i) => (x - mM) * (r[i] - mR)));
    const sM = Math.sqrt(avg(m.map(x => (x - mM) ** 2))), sR = Math.sqrt(avg(r.map(x => (x - mR) ** 2)));
    perExit[ex] = { have, m, r, n: have.length, corr: (sM > 0 && sR > 0) ? cov / (sM * sR) : 0 };
  }

  console.log(`\nWHEN A ${((MULT - 1) * 100).toFixed(0)}% GAIN IS ON THE SCREEN — share of sessions where the mark at that`);
  console.log(`exit is at least ${MULT}× the fair value above. A mean cannot answer this; only the`);
  console.log(`spread of outcomes can, which is why the single-number table sits separately.\n`);
  const cols = Object.keys(perExit);
  console.log('  wing │ ' + cols.map(e => e.padStart(7)).join(' '));
  console.log('  ─────┼' + '─'.repeat(cols.length * 8));
  const towerGap = {}, towerGapAbs = {};
  for (const ex of cols) towerGapAbs[ex] = {};
  const unreachable = [];
  for (const W of WINGS) {
    const cells = [];
    // A fly can never mark above its wing width, so a target above that is not rare —
    // it is impossible, and printing 0% for it would read as "almost never" when the
    // truth is "never". This is the practical bite of the fair-value table: once fair
    // value passes 1/MULT of the wing, that gain is off the menu at any exit.
    const target = MULT * fv[W];
    const impossible = target >= W;
    if (impossible) unreachable.push(W);
    for (const ex of cols) {
      const { m, r } = perExit[ex];
      // Mark per session, against every residual in the pool. The full cross product
      // rather than a random resample, so the figure is deterministic — a bootstrap
      // that wobbles between runs invites re-running it until it agrees with you.
      const marks = m.map(mi => avg(r.map(rj => flyAt(mi + rj, W))));
      towerGapAbs[ex][W] = Math.abs(avg(marks) - fv[W]);
      towerGap[ex] = Math.max(towerGap[ex] || 0, towerGapAbs[ex][W] / Math.max(1e-9, fv[W]));
      if (impossible) { cells.push('    n/a'); continue; }
      const hits = marks.filter(v => v >= target).length;
      cells.push(`${(100 * hits / marks.length).toFixed(0)}%`.padStart(7));
    }
    console.log(`  ±${String(W).padEnd(3)} │ ` + cells.join(' '));
  }
  if (unreachable.length) {
    console.log(`\n  n/a — at ${unreachable.map(W => '±' + W).join(', ')} fair value already exceeds ${(100 / MULT).toFixed(0)}% of the wing width,`);
    console.log(`  and a fly cannot mark above its wing. A ${((MULT - 1) * 100).toFixed(0)}% gain on a fairly-priced entry at those`);
    console.log(`  widths is arithmetically unavailable, at any exit — not rare, impossible.`);
  }

  // The identity check. If the mean mark at an exit did NOT come back to the fair
  // value, something is wrong with the pooling — not with the market.
  // Expressed in standard errors, not percent. The gap is dominated by the error on
  // fv itself — fv is a mean of 64 mostly-zero payoffs, while each exit's figure pools
  // 64×64 pairs — so a gap of a fraction of one se is agreement, and quoting it as a
  // percentage made a correct result look like a discrepancy.
  const worstGap = Math.max(...WINGS.map(W =>
    (towerGap[cols[0]] != null ? 0 : 0) + Math.max(...cols.map(ex => towerGapAbs[ex][W] / Math.max(1e-9, fvSe[W])))));
  console.log(`\n  Identity check: the MEAN mark at every exit returns to the fair value above,`);
  console.log(`  worst gap ${worstGap.toFixed(2)}× the se on fair value — agreement. That is the law of total`);
  console.log(`  expectation: a flat row across exit times is FORCED and says nothing about when`);
  console.log(`  to get out. Only the spread of outcomes does, which is the table above.`);
  console.log(`  Independence of before/after move, corr: `
    + cols.map(e => `${e} ${perExit[e].corr >= 0 ? '+' : ''}${perExit[e].corr.toFixed(2)}`).join('  '));
  console.log(`  Far from zero means days that trend keep trending, and pooling residuals across`);
  console.log(`  sessions then overstates how often the body is still in reach.`);
  console.log(`\n  Note 15:55 ≈ settlement: holding ${UNDERLYING} that late risks assignment on ITM shorts.`);

  // ── Band hit rate by exit, with its own error bar ──────────────────────────
  console.log(`\nBand ±${half} hit rate by exit — shown with a standard error, because at this sample`);
  console.log(`size the wiggles between adjacent exits are smaller than the noise.`);
  for (const ex of cols) {
    const { m, n } = perExit[ex];
    const h = m.filter(v => Math.abs(v) <= half).length;
    const p = h / n, se = Math.sqrt(p * (1 - p) / n);
    console.log(`  ${ex}  ${String(h).padStart(3)}/${String(n).padStart(3)}  ${(100 * p).toFixed(1).padStart(5)}% ± ${(100 * se).toFixed(1)}`);
  }
  }
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
