// ── One open trade, drawn (Oct 2026) ──
//
// The payoff of the contracts open, across the underlying's price: at expiry, now,
// and at the planned exit (0DTE: 15:00 New York today; 45DTE: the close-by DTE) —
// with the break-evens, the strikes, the move the market is pricing for the time
// left, and the target and stop as P&L levels. Pure; the panel fetches and draws.
//
// Values are $ for the open contracts (all contracts for an order still working,
// "if filled"), from the same Black-Scholes and IV choice as Portfolio Risk:
// each leg's live IV, else the ticket's IV, else VIX1D.

import { holdingValue, yearsToExpiry, ivFor, etWall, plannedExit } from './portfolio.js';
import { valueAtExpiry } from './shadow.js';

const EXIT_MIN = 15 * 60;
const daysUntilExit0 = (now) => {
  const w = etWall(now);
  return w.min < EXIT_MIN ? (EXIT_MIN - w.min) / 1440 : null;
};

/**
 * @param p     a buildBook() entry (legs, pos.ncd, engine, expiry, strategy, live, qty)
 * @param legs  legs with live IV where quoted (positionRisk().legs), else p.legs
 * @param spot  underlying now
 * @returns null without legs or a price, else
 *   { lo, hi, xs, expiry[], now[], exit[] | null, exitLabel, breakevens, strikes,
 *     sd (1σ move to expiry, points), lots, ifFilled, nowAt(S), exitAt(S), expiryAt(S) }
 */
export function payoffSeries(p, legs, spot, { now = new Date(), points = 181 } = {}) {
  if (!p || !legs || !legs.length || !(spot > 0)) return null;
  const ncd = Number(p.pos && p.pos.ncd) || 0;
  const ifFilled = !(p.live > 0);
  const lots = (p.live > 0 ? p.live : (p.qty || 1)) * 100;
  const pp = { ...p, live: lots / 100 };

  // The move left: the nearest expiry, at the average leg IV.
  const nearExp = legs.map(l => String(l.expiry)).sort()[0];
  const T = yearsToExpiry(nearExp, now);
  const ivAvg = legs.reduce((a, l) => a + ivFor(pp, l).iv, 0) / legs.length;
  const sd = spot * (ivAvg / 100) * Math.sqrt(Math.max(T, 1 / (365 * 1440)));

  const ks = legs.map(l => Number(l.strike));
  const kLo = Math.min(...ks), kHi = Math.max(...ks);
  const width = Math.max(kHi - kLo, spot * 0.004);
  let lo = Math.min(kLo, spot - 2.2 * sd), hi = Math.max(kHi, spot + 2.2 * sd);
  const pad = Math.max((hi - lo) * 0.08, width * 0.35);
  lo = Math.max(0.01, lo - pad); hi += pad;

  const expiryAt = S => (valueAtExpiry(legs, S) + ncd) * lots;
  const nowAt = S => (holdingValue(pp, legs, S, { now }) + ncd) * lots;
  let exitDays = null, exitLabel = null;
  if (p.engine === '0DTE') {
    const d = daysUntilExit0(now);
    if (d != null && d > 0) { exitDays = d; exitLabel = 'At 15:00'; }
  } else {
    const closeYmd = plannedExit(p);
    if (closeYmd) {
      const w = etWall(now);
      const days = Math.round((Date.UTC(+closeYmd.slice(0, 4), +closeYmd.slice(4, 6) - 1, +closeYmd.slice(6, 8))
        - Date.UTC(+w.ymd.slice(0, 4), +w.ymd.slice(4, 6) - 1, +w.ymd.slice(6, 8))) / 86400000);
      if (days > 0) { exitDays = days; exitLabel = `At the planned close (${closeYmd.slice(6, 8)}/${closeYmd.slice(4, 6)})`; }
    }
  }
  const exitAt = exitDays != null ? (S => (holdingValue(pp, legs, S, { now, days: exitDays }) + ncd) * lots) : null;

  const xs = [];
  for (let i = 0; i < points; i++) xs.push(lo + (hi - lo) * i / (points - 1));
  const exp = xs.map(expiryAt), nw = xs.map(nowAt), ex = exitAt ? xs.map(exitAt) : null;

  // Break-evens at expiry: where the expiry line crosses zero.
  const breakevens = [];
  for (let i = 1; i < xs.length; i++) {
    if ((exp[i - 1] < 0) !== (exp[i] < 0) && exp[i] !== exp[i - 1]) {
      breakevens.push(xs[i - 1] + (xs[i] - xs[i - 1]) * (0 - exp[i - 1]) / (exp[i] - exp[i - 1]));
    }
  }
  const strikes = [];
  legs.forEach(l => { if (!strikes.some(s => s.strike === l.strike && s.right === l.right)) strikes.push({ strike: Number(l.strike), right: l.right, qty: l.qty }); });
  return {
    lo, hi, xs, expiry: exp, now: nw, exit: ex, exitLabel, breakevens, strikes, sd, lots: lots / 100, ifFilled,
    // the extremes sit on strikes, which the grid need not hit
    maxProfit: Math.max(...exp, ...ks.map(expiryAt)), maxLoss: Math.min(...exp, ...ks.map(expiryAt)),
    nowAt, exitAt, expiryAt,
  };
}

/**
 * Where price sits. For spreads and condors: the nearest short, in points and σ
 * (+ = still out of the money). For a fly or iron fly, whose shorts sit together at
 * the body: the distance from the body, which is where it wants price.
 */
export function whereIsPrice(series, spot) {
  if (!series) return null;
  const shorts = series.strikes.filter(s => s.qty < 0);
  const be = series.breakevens;
  const inside = be.length >= 2 ? spot >= be[0] && spot <= be[be.length - 1] : series.expiryAt(spot) >= 0;
  const sp = shorts.filter(s => s.right === 'P').map(s => s.strike), sc = shorts.filter(s => s.right === 'C').map(s => s.strike);
  const ks = [...new Set(shorts.map(s => s.strike))];
  const body = ks.length === 1 || (sp.length && sc.length && Math.max(...sp) >= Math.min(...sc));
  if (body && shorts.length) {
    const k = ks.length === 1 ? ks[0] : (Math.max(...sp) + Math.min(...sc)) / 2;
    const away = Math.abs(spot - k);
    return { near: { strike: k, right: '', body: true, away }, nearSd: series.sd > 0 ? away / series.sd : null, inside };
  }
  const near = shorts.map(s => ({ ...s, away: s.right === 'P' ? spot - s.strike : s.strike - spot }))
    .sort((a, b) => a.away - b.away)[0] || null;
  return { near, nearSd: near && series.sd > 0 ? near.away / series.sd : null, inside };
}
