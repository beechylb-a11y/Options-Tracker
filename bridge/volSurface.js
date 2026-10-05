// ================================================================
//  Vol surface — pure helpers for GET /api/vol-surface (Oct 2026)
//  No IB plumbing here, so every number the endpoint returns can be checked
//  without TWS running. index.js does the fetching and calls these.
// ================================================================

// Day count between two YYYYMMDD strings (b − a), calendar days.
export function daysBetween(a, b) {
  const t = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((t(b) - t(a)) / 86400000);
}

// Today in New York as YYYYMMDD — the date the option chain's DTE is counted from,
// whatever timezone the bridge's Mac is in (Melbourne).
export function nyToday(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replace(/-/g, '');
}

export function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// The listed expiry closest to a target date. Ties go to the later expiry (more
// time, never less). `minDte` keeps the front month off the very short end, where
// a few days of gamma swamps the vol reading.
export function nearestExpiry(expirations, target, today, minDte = 0) {
  let best = null, bestGap = Infinity;
  for (const e of expirations) {
    const dte = daysBetween(today, e);
    if (dte < minDte) continue;
    const gap = Math.abs(daysBetween(target, e));
    if (gap < bestGap || (gap === bestGap && e > best)) { best = e; bestGap = gap; }
  }
  return best;
}

// Fallback when the chain lookup fails: the Friday nearest the target. Every
// optionable underlying here lists Fridays (SPXW, SPY, QQQ, IWM, XSP, RUTW).
export function fridayNear(target) {
  const d = new Date(Date.UTC(+target.slice(0, 4), +target.slice(4, 6) - 1, +target.slice(6, 8)));
  const dow = d.getUTCDay();                  // 0 Sun … 5 Fri
  // Sun −2, Mon −3, Tue +3, Wed +2, Thu +1, Fri 0, Sat −1
  d.setUTCDate(d.getUTCDate() + (dow <= 1 ? -(dow + 2) : 5 - dow));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function nearestStrike(strikes, x, inc = 1) {
  if (Array.isArray(strikes) && strikes.length) {
    let best = strikes[0];
    for (const k of strikes) if (Math.abs(k - x) < Math.abs(best - x)) best = k;
    return best;
  }
  return Math.round(x / inc) * inc;
}

// Strike whose Black-Scholes delta is `absDelta` (put or call), at vol `sigma`
// (decimal) and `T` years. z = N⁻¹(1 − absDelta) = 0.6745 for 25Δ. Skew means the
// real 25Δ put sits further out than this flat-vol estimate, so the endpoint
// fetches a second strike past it and interpolates (see interpAtDelta).
const Z25 = 0.6744897501960817;
export function strikeForDelta(spot, sigma, T, right, z = Z25) {
  const sT = sigma * Math.sqrt(T);
  const drift = 0.5 * sigma * sigma * T;
  return right === 'P' ? spot * Math.exp(-z * sT + drift) : spot * Math.exp(z * sT + drift);
}

// IV at exactly |delta| = target from two fetched strikes, linear in delta.
// Outside the bracket it takes the nearer point rather than extrapolating — a
// 25Δ read off a 31Δ and a 28Δ strike is worth more as "28Δ" than as a guess.
export function interpAtDelta(points, target = 0.25) {
  const pts = (points || []).filter(p => p && p.iv > 0 && p.delta != null && isFinite(p.delta))
    .map(p => ({ ...p, ad: Math.abs(p.delta) }));
  if (!pts.length) return null;
  if (pts.length === 1) return { iv: pts[0].iv, delta: pts[0].ad, strike: pts[0].strike, interpolated: false };
  pts.sort((a, b) => a.ad - b.ad);
  const lo = pts[0], hi = pts[pts.length - 1];
  if (target <= lo.ad) return { iv: lo.iv, delta: lo.ad, strike: lo.strike, interpolated: false };
  if (target >= hi.ad) return { iv: hi.iv, delta: hi.ad, strike: hi.strike, interpolated: false };
  const w = (target - lo.ad) / (hi.ad - lo.ad);
  return { iv: lo.iv + w * (hi.iv - lo.iv), delta: target, strike: lo.strike + w * (hi.strike - lo.strike), interpolated: true };
}

// Term structure from ~30-day vs ~90-day ATM IV — the same ratio as VIX/VIX3M.
// Calm markets sit near 0.85–0.92; a ratio above 1 means near-dated vol is priced
// over far-dated, which is stress. The flat band stops a 0.98 read from earning
// full contango points or a 1.01 read from tripping the backwardation blocker.
export const TERM_FLAT_LO = 0.95, TERM_FLAT_HI = 1.02;
export function termBiasFromIV(front, back) {
  if (!(front > 0) || !(back > 0)) return { bias: '', ratio: null };
  const ratio = front / back;
  const bias = ratio > TERM_FLAT_HI ? 'backwardation' : ratio >= TERM_FLAT_LO ? 'flat' : 'contango';
  return { bias, ratio: +ratio.toFixed(3) };
}

// IV Rank and percentile from a daily series of IB's 30-day IV (decimals or %).
// Rank = where today sits between the 52-week low and high; percentile = share of
// days below today. Both are reported because they disagree after a spike: one
// 40-vol day pins the rank low for a year, the percentile shrugs it off.
export function ivRankStats(series) {
  const v = (series || []).filter(x => x > 0 && isFinite(x));
  if (v.length < 20) return null;
  const cur = v[v.length - 1];
  const lo = Math.min(...v), hi = Math.max(...v);
  const rank = hi > lo ? (cur - lo) / (hi - lo) * 100 : 50;
  const below = v.filter(x => x < cur).length;
  return { current: cur, low: lo, high: hi, rank: +rank.toFixed(1), pctl: +(below / v.length * 100).toFixed(1), days: v.length };
}

// Close-to-close realised vol (annualised, %) over the last `n` returns. Only used
// when IB's own HISTORICAL_VOLATILITY series comes back empty.
export function realisedVol(closes, n = 30) {
  const c = (closes || []).filter(x => x > 0);
  if (c.length < n + 1) return null;
  const tail = c.slice(-(n + 1));
  const r = [];
  for (let i = 1; i < tail.length; i++) r.push(Math.log(tail[i] / tail[i - 1]));
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  const varr = r.reduce((s, x) => s + (x - m) * (x - m), 0) / (r.length - 1);
  return +(Math.sqrt(varr) * Math.sqrt(252) * 100).toFixed(2);
}

export const avgIV = (a, b) => (a > 0 && b > 0) ? (a + b) / 2 : (a > 0 ? a : b > 0 ? b : null);
