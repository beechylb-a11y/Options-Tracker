// ── Suggested changes from settled verdicts (Oct 2026, learning loop step 3) ──
//
// The engine does not retune itself. This reads the settled shadow verdicts and
// proposes changes for a person to approve, each with its evidence:
//   • a blocker whose blocked trades made money (or confirmation that one earns its keep)
//   • a better gamma move-cost block level
//   • a minimum edge score worth enforcing
//   • an EV model that is too pessimistic or too optimistic
// A threshold is only proposed when it wins OUT OF SAMPLE: chosen on the earlier
// two-thirds of verdicts (by date), then checked on the latest third against the
// current setting. Nothing is proposed from fewer than SUGGEST_N settled verdicts.

import { calibrate, outcomeOf } from './calibration.js';
import { MOVE_COST_BANDS } from './calc0dte.js';

export const SUGGEST_N = 30;
const MIN_SIDE = 10;               // allowed trades needed in each half to judge a threshold

const chrono = rows => [...rows].sort((a, b) => String(a.session_date + a.first_seen).localeCompare(String(b.session_date + b.first_seen)));
const sumR = list => list.reduce((a, o) => a + o.R, 0);

/** Pick the threshold that maximises total R on the train set, check it on the test set. */
export function thresholdTest(outs, { candidates, allow, current }) {
  const data = chrono(outs.map(o => ({ ...o.row, _o: o })));
  const cut = Math.floor(data.length * 2 / 3);
  const train = data.slice(0, cut).map(r => r._o), test = data.slice(cut).map(r => r._o);
  if (train.length < MIN_SIDE || test.length < MIN_SIDE) return null;
  const score = (set, t) => { const k = set.filter(o => allow(o.row, t)); return { n: k.length, R: sumR(k), avg: k.length ? sumR(k) / k.length : null }; };
  let best = null;
  for (const t of candidates) {
    const s = score(train, t);
    if (s.n < MIN_SIDE) continue;
    if (!best || s.R > best.train.R + 1e-9) best = { t, train: s };
  }
  if (!best) return null;
  const cur = { train: score(train, current), test: score(test, current) };
  return { best: best.t, current, train: { best: best.train, current: cur.train }, test: { best: score(test, best.t), current: cur.test } };
}

const fmtR = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + 'R';

export function suggestions(rows, { outcome = 'managed' } = {}) {
  const out = [], waiting = [];
  const settled = (rows || []).map(r => outcomeOf(r, outcome)).filter(o => o && Number.isFinite(o.R));

  // 1. Blockers.
  for (const g of calibrate(rows, 'blocker', { outcome })) {
    if (g.n < SUGGEST_N || !g.R || g.R.lo == null) { waiting.push({ what: `Blocker “${g.key}”`, n: g.n }); continue; }
    if (g.R.lo > 0) out.push({ id: 'blk:' + g.key, tone: 'change', title: `Loosen or retire “${g.key}”`,
      evidence: `The ${g.n} trades it stopped averaged ${fmtR(g.R.m)} (95% ${fmtR(g.R.lo)} to ${fmtR(g.R.hi)}), win rate ${(g.winRate.p * 100).toFixed(0)}%. It is blocking winners.` });
    else if (g.R.hi < 0) out.push({ id: 'blk:' + g.key, tone: 'keep', title: `Keep “${g.key}”`,
      evidence: `The ${g.n} trades it stopped averaged ${fmtR(g.R.m)} (95% ${fmtR(g.R.lo)} to ${fmtR(g.R.hi)}). It is doing its job.` });
  }

  // 2. Gamma move-cost block level (0DTE short gamma).
  const shortG = settled.filter(o => o.row.engine === '0DTE' && Number.isFinite(Number(o.row.move_cost)) && Number((o.row.inputs || {}).gamma) < 0);
  if (shortG.length >= SUGGEST_N) {
    const t = thresholdTest(shortG, { candidates: [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 99], current: MOVE_COST_BANDS.block,
      allow: (r, th) => Number(r.move_cost) <= th });
    if (t && t.best !== t.current && t.test.best.R > t.test.current.R) {
      out.push({ id: 'gamma', tone: 'change',
        title: t.best >= 99 ? 'Drop the gamma move-cost block' : `Move the gamma block from ${t.current} to ${t.best}`,
        evidence: `Chosen on the earlier ${Math.floor(shortG.length * 2 / 3)} short-gamma verdicts, then checked on the latest ${shortG.length - Math.floor(shortG.length * 2 / 3)}: `
          + `${fmtR(t.test.best.R)} total (${t.test.best.n} trades) against ${fmtR(t.test.current.R)} (${t.test.current.n}) at the current ${t.current}.` });
    } else if (t) out.push({ id: 'gamma', tone: 'keep', title: `Keep the gamma block at ${t.current}`,
      evidence: `No other level beat it on the latest third of ${shortG.length} short-gamma verdicts.` });
  } else waiting.push({ what: 'Gamma move-cost block level', n: shortG.length });

  // 3. Minimum edge score.
  const scored = settled.filter(o => Number.isFinite(Number(o.row.edge_score)));
  if (scored.length >= SUGGEST_N) {
    const t = thresholdTest(scored, { candidates: [0, 40, 50, 55, 60, 65, 70, 75, 80], current: 0,
      allow: (r, th) => Number(r.edge_score) >= th });
    if (t && t.best > 0 && t.test.best.R > t.test.current.R) out.push({ id: 'edge', tone: 'change',
      title: `Pass on tickets with an edge score under ${t.best}`,
      evidence: `On the latest third, tickets at ${t.best}+ made ${fmtR(t.test.best.R)} total (${t.test.best.n}) against ${fmtR(t.test.current.R)} for all of them (${t.test.current.n}).` });
  } else waiting.push({ what: 'Minimum edge score', n: scored.length });

  // 4. EV model direction.
  const ev = g => calibrate(rows, 'ev', { outcome }).find(x => x.key === g);
  const neg = ev('EV ≤ 0'), pos = ev('EV > 0');
  if (neg && neg.n >= SUGGEST_N && neg.R && neg.R.lo > 0) out.push({ id: 'ev-neg', tone: 'change', title: 'The EV model is too pessimistic',
    evidence: `${neg.n} tickets it priced at EV ≤ 0 averaged ${fmtR(neg.R.m)} (95% ${fmtR(neg.R.lo)} to ${fmtR(neg.R.hi)}). Its loss or capture assumptions are too harsh.` });
  if (pos && pos.n >= SUGGEST_N && pos.R && pos.R.hi < 0) out.push({ id: 'ev-pos', tone: 'change', title: 'The EV model is too optimistic',
    evidence: `${pos.n} tickets it priced at EV > 0 averaged ${fmtR(pos.R.m)} (95% ${fmtR(pos.R.lo)} to ${fmtR(pos.R.hi)}).` });
  if ((!neg || neg.n < SUGGEST_N) && (!pos || pos.n < SUGGEST_N)) waiting.push({ what: 'EV model check', n: Math.max(neg ? neg.n : 0, pos ? pos.n : 0) });

  return { suggestions: out, waiting, settled: settled.length };
}
