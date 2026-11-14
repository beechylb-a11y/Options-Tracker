// ── Live price → Net, Win, Risk and POP (Nov 2026) ──
//
// The four numbers that used to be copied from TWS's Strategy Builder, worked out from
// the quotes Fetch from TWS already returns (each leg's bid, ask and model IV).
//
//   Net     the combo mid. Buying the combo as the legs define it pays the ask on the
//           longs and takes the bid on the shorts; the mid sits between. Credit > 0.
//   Win     the most the position makes at expiry, per contract ($), at that net.
//   Risk    the most it loses at expiry, per contract ($), positive. Exact arithmetic:
//           an expiry payoff is straight lines between the strikes.
//   POP     the chance the underlying finishes where the payoff is above zero. Each
//           breakeven's probability uses the implied vol AT that price (interpolated
//           between the legs' own IVs) plus the skew correction (the slope of the
//           smile), which a lognormal on one vol misses: put skew moves probability out
//           into the far left tail, so a near-the-money breakeven is a little MORE
//           likely to hold than flat vol says, and a far one less.
//           TWS has its own vol surface, so expect a point or two of difference.
//
// Only for structures whose legs share one expiry. A calendar or diagonal still has
// time value in the far leg when the near one expires; the app's model fills those.
// Pure — no React, no bridge.

import { normCdf, RATE, divYieldOf } from './payoffCurve.js';

const round2 = x => Math.round(x * 100) / 100;

/** Per-leg quotes → combo bid/ask (cost to BUY the combo; credit structures are negative). */
export function comboQuote(legs) {
  let bid = 0, ask = 0;
  if (!Array.isArray(legs) || !legs.length) return null;
  for (const l of legs) {
    const b = Number(l.bid), a = Number(l.ask), q = Number(l.qty);
    if (!isFinite(b) || !isFinite(a) || !q || a < b) return null;
    ask += q > 0 ? q * a : q * b;
    bid += q > 0 ? q * b : q * a;
  }
  return { bid: round2(bid), ask: round2(ask), mid: round2((bid + ask) / 2), spread: round2(ask - bid) };
}

const intrinsic = (l, S) => (l.right === 'C' ? Math.max(0, S - l.strike) : Math.max(0, l.strike - S));
/** P&L per share at expiry, credit-positive net. */
export const payoffAt = (legs, net, S) => legs.reduce((v, l) => v + l.qty * intrinsic(l, S), net);

/**
 * Max win / max loss at expiry and the breakevens.
 * @returns { win, risk ($ per contract, risk positive; null = unlimited), breakevens, regions: [[lo, hi]] where P&L > 0 }
 */
export function expiryPayoff(legs, net) {
  const ks = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
  const pts = [0, ...ks];
  const vals = pts.map(S => payoffAt(legs, net, S));
  // Beyond the top strike the slope is the calls' net quantity.
  const slopeUp = legs.reduce((s, l) => s + (l.right === 'C' ? l.qty : 0), 0);
  const top = ks[ks.length - 1];
  const far = top * 4;
  pts.push(far); vals.push(payoffAt(legs, net, far));
  const finite = vals.slice(0, -1);
  const win = slopeUp > 0 ? null : Math.max(...finite, vals[vals.length - 1]) * 100;
  const risk = slopeUp < 0 ? null : -Math.min(...finite, vals[vals.length - 1]) * 100;
  // Profit regions on the piecewise-linear payoff.
  const regions = [], breakevens = [];
  let start = vals[0] > 0 ? 0 : null;
  for (let i = 1; i < pts.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if ((a > 0) !== (b > 0)) {
      const x = pts[i - 1] + (a / (a - b)) * (pts[i] - pts[i - 1]);
      breakevens.push(round2(x));
      if (a <= 0) start = x; else { regions.push([start, x]); start = null; }
    }
  }
  if (start != null) regions.push([start, Infinity]);
  return { win: win == null ? null : Math.round(win), risk: risk == null ? null : Math.round(Math.max(0, risk)), breakevens, regions };
}

/** The smile through the legs' own IVs (% → decimal), linear in strike, flat beyond. */
export function smile(legs) {
  const by = new Map();
  for (const l of legs) {
    const iv = Number(l.iv);
    if (!(iv > 0)) continue;
    const a = by.get(l.strike) || [];
    a.push(iv / 100); by.set(l.strike, a);
  }
  const pts = [...by.entries()].map(([k, a]) => [k, a.reduce((s, x) => s + x, 0) / a.length]).sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  return K => {
    if (K <= pts[0][0]) return { iv: pts[0][1], slope: 0 };
    for (let i = 1; i < pts.length; i++) {
      if (K <= pts[i][0]) {
        const [k0, v0] = pts[i - 1], [k1, v1] = pts[i];
        const s = (v1 - v0) / (k1 - k0);
        return { iv: v0 + s * (K - k0), slope: s };
      }
    }
    return { iv: pts[pts.length - 1][1], slope: 0 };
  };
}

/** P(S_T > K) under the smile: N(d2) less vega × dσ/dK (undiscounted) — the call-spread digital. */
export function probAbove(K, S, T, sm, r = RATE, q = 0) {
  if (!(K > 0)) return 1;
  if (!isFinite(K)) return 0;
  const { iv, slope } = sm(K);
  const sT = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * iv * iv) * T) / sT, d2 = d1 - sT;
  const phi = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  const vega = S * Math.exp(-q * T) * phi * Math.sqrt(T);
  const p = normCdf(d2) - vega * slope / Math.exp(-r * T);
  return Math.max(0, Math.min(1, p));
}

export function popAtExpiry(legs, net, S, T, { r = RATE, q = 0 } = {}) {
  const sm = smile(legs);
  if (!sm || !(S > 0) || !(T > 0)) return null;
  const { regions } = expiryPayoff(legs, net);
  let p = 0;
  for (const [lo, hi] of regions) p += probAbove(lo, S, T, sm, r, q) - probAbove(hi, S, T, sm, r, q);
  return Math.max(0, Math.min(1, p));
}

/** Years from `now` to 16:00 New York on expiry yyyymmdd (calendar time). */
export function yearsToExpiry(ymd, now = new Date()) {
  if (!/^\d{8}$/.test(String(ymd || ''))) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(now).map(p => [p.type, p.value]));
  const nowEt = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const exp = Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8), 16, 0, 0);
  const ms = exp - nowEt;
  return ms > 0 ? ms / (365 * 864e5) : 0;
}

/**
 * Everything the Sizing fields need from one Fetch from TWS.
 * @param quoteLegs  [{ strike, right, qty (signed per lot), expiry?, bid, ask, iv (%) }]
 * @param opts.net   credit-positive net to price Win/Risk/POP at (default: the mid)
 * @param opts.spot  underlying price
 * @param opts.T     years to expiry (0DTE outside the session: the session's hours)
 * @returns null when the quotes are incomplete, else
 *   { combo, net, cashType, exact, win, risk, pop, breakevens, why }
 */
export function livePrice(quoteLegs, { net, spot, T, underlying } = {}) {
  const legs = (quoteLegs || []).map(l => ({ strike: Number(l.strike), right: String(l.right || '').toUpperCase()[0], qty: Number(l.qty),
    expiry: l.expiry ? String(l.expiry) : '', bid: l.bid, ask: l.ask, iv: l.iv })).filter(l => l.strike > 0 && l.qty);
  const combo = comboQuote(legs);
  if (!combo) return null;
  const n = net != null && isFinite(net) && net !== 0 ? Number(net) : -combo.mid;
  const out = { combo, net: round2(n), cashType: n >= 0 ? 'credit' : 'debit', exact: true, win: null, risk: null, pop: null, breakevens: [], why: '' };
  const exps = new Set(legs.map(l => l.expiry).filter(Boolean));
  if (exps.size > 1) return { ...out, exact: false, why: 'two expiries — the model prices win, risk and POP for time spreads' };
  const ep = expiryPayoff(legs, n);
  out.win = ep.win; out.risk = ep.risk; out.breakevens = ep.breakevens;
  if (ep.win == null) out.why = 'unlimited upside';
  if (ep.risk == null) out.why = 'unlimited risk — size it by hand';
  const p = popAtExpiry(legs, n, spot, T, { q: divYieldOf(underlying) });
  out.pop = p == null ? null : Math.round(p * 1000) / 10;
  return out;
}
