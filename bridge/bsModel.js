// Greeks from the quote when TWS sends none (Nov 2026).
//
// TWS's option model needs a live underlying price. On a login without real-time
// index data (the paper account: SPX/XSP arrive delayed) it streams the option's
// bid and ask but never a model-greeks tick, so /api/option-greeks answered "No
// Greeks returned" with the prices sitting right there. This backs the implied vol
// out of the mid and computes the greeks with Black–Scholes, on calendar time to
// the 16:00 New York close — the same clock IB's own model uses — and the caller
// marks them as computed, not TWS's.

const SQRT2PI = Math.sqrt(2 * Math.PI);
const pdf = x => Math.exp(-0.5 * x * x) / SQRT2PI;
function cdf(x) {
  // Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function bsPrice(S, K, T, sigma, right, r = 0.04, q = 0) {
  if (!(T > 0) || !(sigma > 0)) return Math.max(0, right === 'P' ? K - S : S - K);
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v, d2 = d1 - v;
  return right === 'P'
    ? K * Math.exp(-r * T) * cdf(-d2) - S * Math.exp(-q * T) * cdf(-d1)
    : S * Math.exp(-q * T) * cdf(d1) - K * Math.exp(-r * T) * cdf(d2);
}

/** Implied vol by bisection; null when the price is outside the no-arbitrage band. */
export function impliedVol(price, S, K, T, right, r = 0.04, q = 0) {
  if (!(price > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;
  const intrinsic = Math.max(0, right === 'P' ? K * Math.exp(-r * T) - S * Math.exp(-q * T) : S * Math.exp(-q * T) - K * Math.exp(-r * T));
  if (price <= intrinsic + 1e-6) return null;
  let lo = 0.005, hi = 5;
  if (bsPrice(S, K, T, hi, right, r, q) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(S, K, T, mid, right, r, q) > price) hi = mid; else lo = mid;
    if (hi - lo < 1e-6) break;
  }
  return (lo + hi) / 2;
}

/** Years from `now` to 16:00 New York on expiry YYYYMMDD (calendar time, floored at 1 min). */
export function yearsToClose(expiry, now = new Date()) {
  const s = String(expiry || '');
  if (!/^\d{8}$/.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(4, 6) - 1, d = +s.slice(6, 8);
  // 16:00 NY in UTC: 21:00 in winter (EST), 20:00 in summer (EDT).
  const probe = new Date(Date.UTC(y, m, d, 12));
  const nyHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(probe));
  const offset = 12 - nyHour;                         // 5 (EST) or 4 (EDT)
  const close = Date.UTC(y, m, d, 16 + offset, 0, 0);
  const ms = close - now.getTime();
  if (ms <= -60000) return null;                      // already expired
  return Math.max(ms, 60000) / (365 * 24 * 3600 * 1000);
}

/**
 * The /api/option-greeks greeks shape from a quote: { iv (%), delta, gamma, theta (per day),
 * vega (per vol point), optPrice, undPrice, tickType: 'bs' } or null when it can't be done.
 */
export function greeksFromQuote({ bid, ask, last, und, strike, right, expiry, now = new Date(), r = 0.04, q = 0 }) {
  const S = Number(und), K = Number(strike), R = String(right || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  const mid = bid != null && ask != null && ask >= bid && ask > 0 ? (Number(bid) + Number(ask)) / 2 : Number(last) > 0 ? Number(last) : null;
  const T = yearsToClose(expiry, now);
  if (!(S > 0) || !(K > 0) || !(mid > 0) || !(T > 0)) return null;
  const sigma = impliedVol(mid, S, K, T, R, r, q);
  if (!sigma) {
    // Deep in the money at its intrinsic, or a 0.01 wing: delta is ±1 or 0, no vol.
    const itm = R === 'P' ? K > S : S > K;
    return { iv: null, delta: itm ? (R === 'P' ? -1 : 1) : 0, gamma: 0, theta: 0, vega: 0, optPrice: +mid.toFixed(2), undPrice: +S.toFixed(2), tickType: 'bs' };
  }
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / v, d2 = d1 - v;
  const eq = Math.exp(-q * T), er = Math.exp(-r * T);
  const delta = R === 'P' ? eq * (cdf(d1) - 1) : eq * cdf(d1);
  const gamma = eq * pdf(d1) / (S * v);
  const vega = S * eq * pdf(d1) * Math.sqrt(T) / 100;
  const thetaYr = R === 'P'
    ? -S * eq * pdf(d1) * sigma / (2 * Math.sqrt(T)) + r * K * er * cdf(-d2) - q * S * eq * cdf(-d1)
    : -S * eq * pdf(d1) * sigma / (2 * Math.sqrt(T)) - r * K * er * cdf(d2) + q * S * eq * cdf(d1);
  return {
    iv: +(sigma * 100).toFixed(2), delta: +delta.toFixed(4), gamma: +gamma.toFixed(5),
    theta: +(thetaYr / 365).toFixed(4), vega: +vega.toFixed(4),
    optPrice: +mid.toFixed(2), undPrice: +S.toFixed(2), tickType: 'bs',
  };
}

/**
 * Spot implied by put–call parity at one strike: S = (C − P + K·e^(−rT))·e^(qT).
 * Real-time option quotes give a real-time underlying even when the index itself
 * only arrives delayed (Nov 2026). Null without both mids.
 */
export function parityspot({ call, put, strike, expiry, now = new Date(), r = 0.04, q = 0 }) {
  const mid = x => (x && x.bid != null && x.ask != null && x.ask >= x.bid && x.ask > 0 ? (x.bid + x.ask) / 2 : null);
  const C = mid(call), P = mid(put), K = Number(strike), T = yearsToClose(expiry, now);
  if (C == null || P == null || !(K > 0) || !(T > 0)) return null;
  const S = (C - P + K * Math.exp(-r * T)) * Math.exp(q * T);
  return S > 0 ? S : null;
}

/** New York trading date (YYYYMMDD) and whether the regular session is open now. */
export function nyRth(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(now).map(x => [x.type, x.value]));
  const min = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const wk = !['Sat', 'Sun'].includes(p.weekday);
  return { ymd: `${p.year}${p.month}${p.day}`, open: wk && min >= 570 && min < 960 };
}

// Underlyings with an expiry every weekday, and their strike grid near the money.
export const DAILY_GRID = { SPX: 5, XSP: 1, SPY: 1, QQQ: 1, IWM: 1 };
