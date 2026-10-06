// ================================================================
//  PAYOFF CURVE — position P&L at ANY date, not just expiry (Oct 2026)
//  Pure functions — no DOM access.
//
//  The old payoff (legsPayoff) is intrinsic value at one expiry. That cannot draw
//  a calendar or diagonal: when the near leg expires the far leg still has time
//  value, so intrinsic maths gives a meaningless line. It also cannot show where a
//  45DTE trade actually ends — the hard close at 21 DTE, 24 days before expiry.
//
//  Here every leg is valued with Black-Scholes at its own remaining time and its
//  own IV, and at intrinsic once that time runs out. Same model TWS's Performance
//  Graph uses; TWS has its own surface, rates and dividends, so expect a few % of
//  difference at a calendar's peak, not a different shape.
//
//  Assumptions, stated once:
//    • a flat rate and dividend yield (RATE / DIV_YIELD below). Over 45-75 days the
//      forward drift is worth ~10-30 SPX points on an ATM call, so leaving it out
//      would mis-state a calendar's debit and peak; getting it to the nearest 1%
//      is enough
//    • sticky-strike vol: each leg keeps its IV as price and time move; volShift
//      moves every leg in parallel (the band on the chart)
//    • European exercise (SPX/XSP are; for ETF calls/puts early exercise only
//      matters deep in the money)
// ================================================================

export const HARD_CLOSE_DTE = 21;
export const RATE = 0.04;   // risk-free, annual. Edit here if rates move a lot.
// Continuous dividend yield by underlying; anything unlisted gets DEFAULT_DIV.
export const DIV_YIELD = { SPX: 0.013, XSP: 0.013, SPY: 0.013, QQQ: 0.006, IWM: 0.013, RUT: 0.013, NDX: 0.006 };
const DEFAULT_DIV = 0.012;
export const divYieldOf = u => DIV_YIELD[String(u || '').toUpperCase()] ?? DEFAULT_DIV;

export function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 via erf; |error| < 1.5e-7, plenty for a P&L chart.
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

// Black-Scholes-Merton value per share. T in years, sigma/r/q decimal.
// T<=0 → intrinsic.
export function bsPrice(S, K, T, sigma, right, r = 0, q = 0) {
  const call = right === 'C';
  if (!(S > 0) || !(K > 0)) return 0;
  if (!(T > 0) || !(sigma > 0)) return call ? Math.max(0, S - K) : Math.max(0, K - S);
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sT, d2 = d1 - sT;
  const dS = S * Math.exp(-q * T), dK = K * Math.exp(-r * T);
  return call ? dS * normCdf(d1) - dK * normCdf(d2) : dK * normCdf(-d2) - dS * normCdf(-d1);
}

// Parse engine legs into valued legs. opts:
//   dteOf(leg)  → calendar days to that leg's expiry (required)
//   ivOf(leg)   → IV in % for that leg, or null to fall back to opts.baseIV
//   baseIV      → % used when a leg has no IV of its own
//   rate, divYield → decimals (default RATE, DEFAULT_DIV)
// Returns null when the legs can't be valued (no IV anywhere, no strikes).
export function curveLegs(legs, { dteOf, ivOf, baseIV, rate = RATE, divYield = DEFAULT_DIV } = {}) {
  if (!Array.isArray(legs) || !legs.length) return null;
  const use = (legs.length === 4 && String(legs[0]?.label || '').includes('VIX')) ? legs.slice(0, 2) : legs;
  const out = [];
  for (const l of use) {
    if (!isFinite(l.strike)) continue;
    const lb = String(l.label || '').toLowerCase();
    const iv = (ivOf && ivOf(l)) || baseIV;
    const dte = dteOf ? dteOf(l) : null;
    if (!(iv > 0) || !(dte >= 0)) return null;
    out.push({ strike: +l.strike, right: lb.includes('put') ? 'P' : 'C',
      sign: (lb.includes('short') || lb.includes('sell')) ? -1 : 1,
      qty: /x2\b/.test(lb) ? 2 : 1, dte, iv: iv / 100, r: rate, q: divYield, label: l.label });
  }
  return out.length ? out : null;
}

// Position value per share at underlying S, `days` calendar days from now.
export function positionValue(cl, S, days, volShift = 0) {
  let v = 0;
  for (const l of cl) {
    const T = (l.dte - days) / 365;
    v += l.sign * l.qty * bsPrice(S, l.strike, T, Math.max(0.01, l.iv + volShift / 100), l.right, l.r || 0, l.q || 0);
  }
  return v;
}

// First expiry among the legs (the near leg of a time spread) and the day the
// 45DTE playbook closes it: 21 DTE before that expiry, or today if already inside.
export function nearDte(cl) { return Math.min(...cl.map(l => l.dte)); }
export function closeDay(cl, hardClose = HARD_CLOSE_DTE) { return Math.max(0, nearDte(cl) - hardClose); }

// Price window: strikes and spot, padded by 2.5 SD of the move to the near expiry.
export function priceRange(cl, spot, baseIV) {
  const ks = cl.map(l => l.strike).concat(spot > 0 ? [spot] : []);
  const ref = spot > 0 ? spot : (Math.min(...ks) + Math.max(...ks)) / 2;
  const sd = ref * ((baseIV || 20) / 100) * Math.sqrt(Math.max(nearDte(cl), 1) / 365);
  const pad = Math.max(2.5 * sd, (Math.max(...ks) - Math.min(...ks)) * 0.6, ref * 0.01);
  return [Math.max(0.01, Math.min(...ks) - pad), Math.max(...ks) + pad];
}

// Entry net per share, credit > 0. A debit structure typed as a positive number
// (TWS shows debits positive) is flipped; 'varies' keeps the sign as typed. With
// nothing typed the model's own fair value at spot stands in, flagged.
export function entryNet(cl, spot, typed, cashType) {
  const n = parseFloat(typed);
  if (isFinite(n) && n !== 0) {
    const v = cashType === 'debit' ? -Math.abs(n) : cashType === 'credit' ? Math.abs(n) : n;
    return { net: v, source: 'ticket' };
  }
  if (spot > 0) return { net: -positionValue(cl, spot, 0), source: 'model' };
  return { net: null, source: 'none' };
}

// P&L curve (per contract, $) at `days` from now. Same shape as legsPayoff so the
// cards and price map can take it as is.
export function curveAt(cl, { net, days = 0, volShift = 0, lo, hi, n = 160 }) {
  const points = [];
  for (let i = 0; i <= n; i++) {
    const px = lo + (hi - lo) * i / n;
    points.push({ price: px, pnl: (positionValue(cl, px, days, volShift) + net) * 100 });
  }
  const pnls = points.map(p => p.pnl);
  const breakevens = [];
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1], p1 = points[i];
    if ((p0.pnl < 0 && p1.pnl >= 0) || (p0.pnl >= 0 && p1.pnl < 0)) {
      const t = p0.pnl / (p0.pnl - p1.pnl);
      breakevens.push(+(p0.price + t * (p1.price - p0.price)).toFixed(1));
    }
  }
  return { points, breakevens, maxProfit: Math.max(...pnls), maxLoss: Math.min(...pnls), shapeOnly: false, days, volShift };
}

// Lognormal probability that price at `days` lands where the curve is positive.
// Zero drift; sigma is the ATM IV to that horizon (decimal). Sums the mass of
// every profitable stretch between grid points, so it handles one, two or more
// breakevens without special cases.
export function probProfit(curve, spot, sigma, days, mu = 0) {
  if (!curve || !(spot > 0) || !(sigma > 0)) return null;
  const t = days / 365;
  if (!(t > 0)) return null;
  const sT = sigma * Math.sqrt(t);
  const F = x => x <= 0 ? 0 : normCdf((Math.log(x / spot) - (mu - 0.5 * sigma * sigma) * t) / sT);
  const pts = curve.points;
  let p = 0;
  // tails beyond the window take the sign of the end points
  if (pts[0].pnl > 0) p += F(pts[0].price);
  if (pts[pts.length - 1].pnl > 0) p += 1 - F(pts[pts.length - 1].price);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.pnl > 0 && b.pnl > 0) p += F(b.price) - F(a.price);
    else if (a.pnl > 0 || b.pnl > 0) {
      const x = a.price + (a.pnl / (a.pnl - b.pnl)) * (b.price - a.price); // crossing
      p += a.pnl > 0 ? F(x) - F(a.price) : F(b.price) - F(x);
    }
  }
  return Math.max(0, Math.min(1, p));
}

// P&L at one price (nearest grid point is not good enough for a readout).
export function pnlAt(cl, S, net, days, volShift = 0) {
  return (positionValue(cl, S, days, volShift) + net) * 100;
}

// Total-variance interpolation between two ATM IVs (%), for a leg whose expiry
// sits between (or beyond) the two points the vol surface measured.
export function ivAtDte(d, d1, iv1, d2, iv2) {
  if (!(iv1 > 0)) return iv2 > 0 ? iv2 : null;
  if (!(iv2 > 0) || !(d2 > d1) || !(d1 > 0)) return iv1;
  const w1 = (iv1 / 100) ** 2 * d1, w2 = (iv2 / 100) ** 2 * d2;
  const dd = Math.max(1, d);
  const w = w1 + (w2 - w1) * (dd - d1) / (d2 - d1);
  return w > 0 ? Math.sqrt(w / dd) * 100 : iv1;
}

// Outcome of holding the position to `days` under a lognormal price (zero drift,
// ATM vol `sigma` decimal): probability of profit, average win and average loss
// in $ per contract. Winners are capped at `cap` (the profit target — you would
// have closed there), so the average win is what a managed trade banks.
// This is how the engine prices a trade TWS gives no POP for (calendars and
// diagonals — two expiries): POP, win and loss all come from the same curve.
// (Oct 2026.)
// mu = annual drift; pass the pricing carry (rate − dividend yield) so a trade
// entered at the model's own fair value comes out at EV ≈ 0 rather than biased by
// the drift the option prices already contain.
export function curveOutcome(curve, spot, sigma, days, cap = Infinity, mu = 0) {
  if (!curve || !(spot > 0) || !(sigma > 0) || !(days > 0)) return null;
  const t = days / 365, sT = sigma * Math.sqrt(t);
  const F = x => x <= 0 ? 0 : normCdf((Math.log(x / spot) - (mu - 0.5 * sigma * sigma) * t) / sT);
  const pts = curve.points;
  let pW = 0, sW = 0, pL = 0, sL = 0;
  const add = (mass, pnl) => {
    if (!(mass > 0)) return;
    if (pnl > 0) { pW += mass; sW += mass * Math.min(pnl, cap); }
    else if (pnl < 0) { pL += mass; sL += mass * -pnl; }
  };
  add(F(pts[0].price), pts[0].pnl);
  add(1 - F(pts[pts.length - 1].price), pts[pts.length - 1].pnl);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if ((a.pnl > 0) === (b.pnl > 0) || a.pnl === 0 || b.pnl === 0) {
      add(F(b.price) - F(a.price), (a.pnl + b.pnl) / 2);
    } else {                                    // breakeven inside: split at the crossing
      const x = a.price + (a.pnl / (a.pnl - b.pnl)) * (b.price - a.price);
      add(F(x) - F(a.price), a.pnl / 2);
      add(F(b.price) - F(x), b.pnl / 2);
    }
  }
  const tot = pW + pL;
  if (!(tot > 0)) return null;
  return { pop: pW / tot, avgWin: pW > 0 ? sW / pW : 0, avgLoss: pL > 0 ? sL / pL : 0,
    ev: (sW - sL) / tot };
}

// Small seeded PRNG (mulberry32) + Box-Muller, so a simulation gives the same
// answer every render for the same inputs.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// The managed trade, path by path (Oct 2026): price walks daily (lognormal, vol
// `sigma`, drift `mu`); the position is revalued with Black-Scholes each day; it
// closes at `target` $ the first day P&L reaches it, else at `closeDay`. Returns
// POP (finished green), P(target hit), average win, average loss and EV in $ per
// contract. This is the trade the playbook actually runs — target or time stop —
// which a single end-of-period curve can't price: a path that tags the target and
// then falls back still banked the target.
export function simulateExit(cl, { net, spot, sigma, mu = 0, closeDay, target = Infinity, paths = 1000, seed = 7 }) {
  if (!cl || !(spot > 0) || !(sigma > 0) || !(closeDay >= 1) || net == null) return null;
  const rand = rng(seed);
  const dt = 1 / 365, drift = (mu - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt);
  let wins = 0, hits = 0, sW = 0, sL = 0, nL = 0;
  const half = Math.ceil(paths / 2);
  for (let p = 0; p < half; p++) {
    // antithetic pair: same shocks, opposite sign — halves the noise for free
    const z = [];
    for (let d = 0; d < closeDay; d++) {
      const u1 = Math.max(1e-12, rand()), u2 = rand();
      z.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
    }
    for (const sgn of [1, -1]) {
      let S = spot, pnl = 0, hit = false;
      for (let d = 1; d <= closeDay; d++) {
        S *= Math.exp(drift + vol * sgn * z[d - 1]);
        pnl = (positionValue(cl, S, d) + net) * 100;
        if (pnl >= target) { pnl = target; hit = true; break; }
      }
      if (hit) hits++;
      if (pnl > 0) { wins++; sW += pnl; } else { nL++; sL += -pnl; }
    }
  }
  const n = half * 2;
  return { pop: wins / n, pTarget: hits / n, avgWin: wins ? sW / wins : 0, avgLoss: nL ? sL / nL : 0,
    ev: (sW - sL) / n, paths: n, closeDay };
}
