#!/usr/bin/env node
/**
 * vwap-backtest.mjs — does the VWAP read actually predict anything?
 *
 *   node tools/vwap-backtest.mjs
 *   node tools/vwap-backtest.mjs --url https://options-tracker-production.up.railway.app
 *   node tools/vwap-backtest.mjs --file decisions.json      (a saved /api/decisions payload)
 *
 * WHY THIS EXISTS
 * The Aug 2026 VWAP rework replaced a cumulative-VWAP slope (which decayed with the
 * clock and duplicated the distance criterion) with rolling 30-minute windows plus
 * acceptance. That change was justified on measurement grounds — the old signal was
 * demonstrably a function of time of day — but it was NOT justified on P&L, because
 * no VWAP number had ever been written to the Decisions sheet. There was nothing to
 * test against. Columns AV:BA now persist them; this script is what reads them back.
 *
 * WHAT IT WILL AND WILL NOT TELL YOU
 * It reports discrimination as AUC — the probability that a randomly chosen winning
 * trade scored higher on the signal than a randomly chosen losing one. 0.50 is a
 * coin flip. It ALWAYS prints the confidence interval alongside, and it refuses to
 * call a winner when the interval spans 0.50. Directional signals of this kind live
 * around 0.55; separating that from noise needs roughly 500 closed trades, and
 * separating two such signals from EACH OTHER needs a few thousand. Those numbers
 * are printed too, so the sample size is never left implicit.
 */

const args = process.argv.slice(2);
const argOf = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const BASE = argOf('--url', 'https://options-tracker-production.up.railway.app');
const FILE = argOf('--file', null);

// ── Load ────────────────────────────────────────────────────────────────────
async function load() {
  if (FILE) {
    const { readFileSync } = await import('node:fs');
    return JSON.parse(readFileSync(FILE, 'utf8'));
  }
  const res = await fetch(`${BASE}/api/decisions`);
  if (!res.ok) throw new Error(`${BASE}/api/decisions -> HTTP ${res.status}`);
  return res.json();
}

// The endpoint may hand back objects keyed by header, or raw sheet rows.
// Normalise both into one shape, keyed by the header names the sheet uses.
function normalise(payload) {
  const rows = Array.isArray(payload) ? payload : (payload.data || payload.rows || []);
  if (!rows.length) return [];
  if (Array.isArray(rows[0])) {
    const header = rows[0].map(h => String(h).trim());
    return rows.slice(1).map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
  }
  return rows;
}

const num = v => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── Statistics ──────────────────────────────────────────────────────────────
// AUC by direct pair counting, ties credited half — the tie handling matters here
// because bucketed signals (flat/mild/strong) produce a great many ties.
function auc(scoresPos, scoresNeg) {
  let n = 0;
  for (const p of scoresPos) for (const q of scoresNeg) n += p > q ? 1 : p === q ? 0.5 : 0;
  return n / (scoresPos.length * scoresNeg.length);
}
// Hanley & McNeil standard error.
function seAUC(A, n1, n0) {
  const Q1 = A / (2 - A), Q2 = 2 * A * A / (1 + A);
  return Math.sqrt((A * (1 - A) + (n1 - 1) * (Q1 - A * A) + (n0 - 1) * (Q2 - A * A)) / (n1 * n0));
}
function nNeededVs50(A) {
  for (let n = 20; n <= 20000; n += 2) {
    const n1 = Math.round(n / 2), n0 = n - n1;
    if (Math.abs(A - 0.5) >= 1.96 * seAUC(0.5, n1, n0) + 0.842 * seAUC(A, n1, n0)) return n;
  }
  return null;
}

function report(name, pos, neg) {
  if (pos.length < 2 || neg.length < 2) {
    console.log(`  ${name.padEnd(26)} not enough outcomes on both sides (${pos.length}W / ${neg.length}L)`);
    return;
  }
  const A = auc(pos, neg);
  const ci = 1.96 * seAUC(A, pos.length, neg.length);
  const lo = Math.max(0, A - ci), hi = Math.min(1, A + ci);
  const verdict = lo > 0.5 ? 'predictive'
    : hi < 0.5 ? 'INVERTED — predictive with the sign flipped'
    : 'indistinguishable from a coin flip';
  console.log(`  ${name.padEnd(26)} AUC ${A.toFixed(3)}  95% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]  ${verdict}`);
  if (lo <= 0.5 && hi >= 0.5) {
    const need = nNeededVs50(A === 0.5 ? 0.57 : A);
    if (need) console.log(`  ${''.padEnd(26)} at this effect size you would need ~${need} closed trades to tell`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
const payload = await load();
const all = normalise(payload);
console.log(`\nDecisions loaded: ${all.length}`);

const zero = all.filter(r => String(r['Engine'] ?? r.engine ?? '').includes('0DTE'));
const closed = zero.filter(r => {
  const s = String(r['Status'] ?? r.status ?? '').toLowerCase();
  return s && s !== 'open' && num(r['Actual P&L'] ?? r.actualPnl) != null;
});
console.log(`0DTE: ${zero.length}    closed with a P&L: ${closed.length}`);

const withVwap = closed.filter(r => (r['VWAP Trend'] ?? r.vwapTrend ?? '') !== '');
console.log(`  of those, carrying the VWAP block (AV:BA): ${withVwap.length}`);

if (withVwap.length < 20) {
  console.log(`
NOT ENOUGH DATA — no result will be reported.

  Trades usable for this test : ${withVwap.length}
  Needed to show a signal of this kind beats a coin flip : ~530
  Needed to show one such signal beats another          : ~2900

  Anything computed on ${withVwap.length} trades would have a confidence interval
  roughly +/- 0.2 wide on a quantity whose whole plausible range is 0.5 to 0.6.
  It would not be a weak answer, it would be no answer, and reading a number off
  it is how a coin flip gets promoted to a rule.

  Rows logged before the Aug 2026 rework carry no VWAP data at all — the columns
  did not exist — so history cannot be back-filled from the sheet. It can only be
  reconstructed from 5-minute bars for each entry timestamp, which means a bridge
  running against TWS with historical data permissions. Until then this script
  will keep reporting exactly this.
`);
  process.exit(0);
}

// ── The tests, once there is enough data to run them ────────────────────────
const win = r => num(r['Actual P&L'] ?? r.actualPnl) > 0;
const pos = withVwap.filter(win), neg = withVwap.filter(r => !win(r));
console.log(`\n${pos.length} winners / ${neg.length} losers\n`);

// Parse "mild rising +0.62EM30 confirmed" back into its parts.
function parseTrend(s) {
  const t = String(s);
  const m = t.match(/(-?\d+\.\d+)EM30/);
  return {
    strength: /strong/.test(t) ? 2 : /mild/.test(t) ? 1 : 0,
    signed: m ? parseFloat(m[1]) : 0,
    confirmed: /confirmed/.test(t) ? 1 : /diverges/.test(t) ? -1 : 0,
  };
}
const f = {
  'trend strength':      r => parseTrend(r['VWAP Trend'] ?? r.vwapTrend).strength,
  'trend shift (signed)':r => Math.abs(parseTrend(r['VWAP Trend'] ?? r.vwapTrend).signed),
  'acceptance one-sided':r => { const a = num(r['VWAP Acceptance'] ?? r.vwapAccept); return a == null ? 0.5 : Math.abs(a - 0.5) * 2; },
  'confirmed vs diverges':r => parseTrend(r['VWAP Trend'] ?? r.vwapTrend).confirmed,
  'distance from VWAP':  r => num(r['VWAP Dist EM'] ?? r.vwapDistEM) ?? 0,
  'setup score (control)':r => num(r['Setup Score'] ?? r.setupScore) ?? 0,
};
console.log('Discrimination against realised P&L:');
for (const [name, fn] of Object.entries(f)) report(name, pos.map(fn), neg.map(fn));

console.log(`
Read 'setup score (control)' first. It is the whole scorecard, and if IT cannot
separate winners from losers on this sample, no single component of it will
either, and the VWAP rows below it are noise being read as signal.
`);
