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
import { STRATEGY_CASH_TYPE } from './data.js';
import { learnSuggestions } from './learn.js';

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

  // 2b. WHICH RULER the gamma block should measure against (Oct 2026).
  //
  // The block above tests the LEVEL. This tests the measure itself, because the two
  // SPX and IWM tickets of 12 Oct suggested the level may not be the problem.
  //
  // move cost is ½|Γ|σ²/|Θ| and σ is ATR ÷ 1.6 — a typical FULL day's range, drawn
  // from a 14-session average that includes overnight gaps. A 0DTE opened at 11:35
  // and closed at 15:45 is never exposed to that. On those two tickets ATR ran 2.7×
  // and 2.1× the market's own price for the remaining session, and both blocked at
  // 5.79 and 7.14 against a limit of 2.0; on the straddle's ruler they read 0.81 and
  // 1.66, which is "low" and a warn.
  //
  // Which ruler actually separates winners from losers is an empirical question and
  // is left to the data. Three measures are fitted and tested the same way, from
  // fields already stored, so nothing new has to be captured:
  //
  //   atr       as recorded — a full day's realised range
  //   horizon   the same, scaled to the hours the position was exposed for. Cost
  //             goes as σ², and σ as √t, so the scale factor is linear in time.
  //   implied   ½|Γ|·sdLeft²/|Θ| — the market's own remaining-session move
  //
  // A caveat the winner has to be read against: the measure is meant to compare
  // REALISED against IMPLIED, so `implied` puts implied on both sides and is biased
  // toward reading ~1 whatever the market does. If it wins it may be winning by
  // being uninformative, and `horizon` is the safer change of the two.
  const FULL_SESSION_TO_BELL = 6.5;
  const rulerOf = {
    atr: r => Number(r.move_cost),
    horizon: r => {
      const h = Number((r.inputs || {}).hoursToBell ?? (r.inputs || {}).hours);
      const mc = Number(r.move_cost);
      return (Number.isFinite(h) && h > 0 && Number.isFinite(mc))
        ? mc * Math.min(1, h / FULL_SESSION_TO_BELL) : null;
    },
    implied: r => {
      const i = r.inputs || {};
      const g = Math.abs(Number(i.gamma)), th = Math.abs(Number(i.theta)), sd = Number(i.sdLeft);
      return (g > 0 && th > 0 && sd > 0) ? 0.5 * g * sd * sd / th : null;
    },
  };
  const LEVELS = [1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0, 99];
  const rulerRuns = [];
  for (const [name, f] of Object.entries(rulerOf)) {
    const rows = shortG.filter(o => Number.isFinite(f(o.row)));
    if (rows.length < SUGGEST_N) continue;
    const t = thresholdTest(rows, { candidates: LEVELS, current: MOVE_COST_BANDS.block,
      allow: (r, th) => f(r) <= th });
    if (t) rulerRuns.push({ name, n: rows.length, t });
  }
  if (rulerRuns.length >= 2) {
    const best = rulerRuns.reduce((a, b) => (b.t.test.best.R > a.t.test.best.R ? b : a));
    const atrRun = rulerRuns.find(x => x.name === 'atr');
    const line = x => `${x.name} at ${x.t.best}: ${fmtR(x.t.test.best.R)} over ${x.t.test.best.n}`;
    if (best.name !== 'atr' && atrRun && best.t.test.best.R > atrRun.t.test.best.R + 1e-9) {
      out.push({ id: 'gamma-ruler', tone: 'change',
        title: `Measure gamma cost against the ${best.name === 'horizon' ? 'hours the trade is actually exposed' : "market's remaining-session move"}, not a full day's ATR`,
        evidence: `On the latest third, ${rulerRuns.map(line).join('; ')}. `
          + (best.name === 'implied'
            ? 'Read with care: this ruler puts implied on both sides of the ratio, so it may be winning by saying less.'
            : 'Same measure, scaled to the window the position is open for.') });
    } else out.push({ id: 'gamma-ruler', tone: 'keep', title: "Keep measuring gamma cost against ATR",
      evidence: `No other ruler beat it out of sample — ${rulerRuns.map(line).join('; ')}.` });
  } else waiting.push({ what: 'Which ruler the gamma block uses', n: shortG.length });

  // 3. Minimum edge score.
  const scored = settled.filter(o => Number.isFinite(Number(o.row.edge_score)));
  if (scored.length >= SUGGEST_N) {
    const t = thresholdTest(scored, { candidates: [0, 40, 50, 55, 60, 65, 70, 75, 80], current: 0,
      allow: (r, th) => Number(r.edge_score) >= th });
    if (t && t.best > 0 && t.test.best.R > t.test.current.R) out.push({ id: 'edge', tone: 'change',
      title: `Pass on tickets with an edge score under ${t.best}`,
      evidence: `On the latest third, tickets at ${t.best}+ made ${fmtR(t.test.best.R)} total (${t.test.best.n}) against ${fmtR(t.test.current.R)} for all of them (${t.test.current.n}).` });
  } else waiting.push({ what: 'Minimum edge score', n: scored.length });

  // 4. A minimum IV rank for selling premium (Oct 2026).
  //
  // Every short-premium rule in the tastylive/Sosnoff material is conditioned on IV
  // rank — above 20 for a vertical, above 30 for most, above 30–50 for condors and
  // strangles. The engine already SCORES IV rank (25 setup points) and warns below
  // 25, but nothing stops a sale into cheap vol: the QQQ condor of 8 Oct went on at
  // IVR 26.9 and scored 54/100 Moderate.
  //
  // Whether that threshold is right HERE is not something a video can settle, so it
  // is not hard-coded as a gate. It is registered as a candidate and tested the same
  // way every other threshold is — fitted on the earlier two-thirds, made to prove
  // itself on the latest third, against today's behaviour of no floor at all.
  const creditSales = settled.filter(o => {
    if (o.row.engine !== '45DTE') return false;
    const ivr = Number((o.row.inputs || {}).ivr);
    if (!Number.isFinite(ivr) || ivr <= 0) return false;
    const strat = String(o.row.strategy || '');
    return STRATEGY_CASH_TYPE[strat] === 'credit'
      || /condor|credit spread|jade|iron butterfly|short strangle|short put|bull put|bear call/i.test(strat);
  });
  if (creditSales.length >= SUGGEST_N) {
    const t = thresholdTest(creditSales, { candidates: [0, 20, 25, 30, 35, 40, 50], current: 0,
      allow: (r, th) => Number((r.inputs || {}).ivr) >= th });
    if (t && t.best > 0 && t.test.best.R > t.test.current.R) out.push({ id: 'ivr', tone: 'change',
      title: `Pass on selling premium below IV rank ${t.best}`,
      evidence: `On the latest third, credit structures entered at IVR ${t.best}+ made ${fmtR(t.test.best.R)} total `
        + `(${t.test.best.n} trades) against ${fmtR(t.test.current.R)} for all of them (${t.test.current.n}).` });
    else if (t) out.push({ id: 'ivr', tone: 'keep', title: 'No IV rank floor is earning its place',
      evidence: `Across ${creditSales.length} credit sales, no minimum IV rank beat taking them all on the latest third.` });
  } else waiting.push({ what: 'Minimum IV rank for credit structures', n: creditSales.length });

  // 5. EV model direction.
  const ev = g => calibrate(rows, 'ev', { outcome }).find(x => x.key === g);
  const neg = ev('EV ≤ 0'), pos = ev('EV > 0');
  if (neg && neg.n >= SUGGEST_N && neg.R && neg.R.lo > 0) out.push({ id: 'ev-neg', tone: 'change', title: 'The EV model is too pessimistic',
    evidence: `${neg.n} tickets it priced at EV ≤ 0 averaged ${fmtR(neg.R.m)} (95% ${fmtR(neg.R.lo)} to ${fmtR(neg.R.hi)}). Its loss or capture assumptions are too harsh.` });
  if (pos && pos.n >= SUGGEST_N && pos.R && pos.R.hi < 0) out.push({ id: 'ev-pos', tone: 'change', title: 'The EV model is too optimistic',
    evidence: `${pos.n} tickets it priced at EV > 0 averaged ${fmtR(pos.R.m)} (95% ${fmtR(pos.R.lo)} to ${fmtR(pos.R.hi)}).` });
  if ((!neg || neg.n < SUGGEST_N) && (!pos || pos.n < SUGGEST_N)) waiting.push({ what: 'EV model check', n: Math.max(neg ? neg.n : 0, pos ? pos.n : 0) });

  // 6. Strike distance × exit for 0DTE credit spreads, learned from our own sessions.
  const ls = learnSuggestions(rows, { minN: SUGGEST_N });
  out.push(...ls.suggestions); waiting.push(...ls.waiting);

  return { suggestions: out, waiting, settled: settled.length };
}
