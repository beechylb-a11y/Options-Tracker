// ── Butterfly profit band in the market's units (Oct 2026) ──
//
// A fly's profit band in points says little on its own: 4 points is wide at 15:30
// and thin at 10:00. What matters is the band against the move still to come (the
// remaining SD, from the straddle) and against the day's whole expected range.
//
//   halfSD   band half-width ÷ the remaining SD ("±0.8 SD")
//   pInside  chance the close lands where the fly makes money (normal, zero drift,
//            remaining SD) — the mass of every profitable stretch, so a BWB whose
//            credit side never loses is counted too
//   pctOfDay band width ÷ today's full ±EM range (2 × the session SD)
//
// Net: the typed fill when there is one, otherwise the fly's fair debit in the same
// normal model — flagged, because the band moves with the price paid.

const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return s * y;
}
// Normal-model (Bachelier) value at expiry of a call / put with terminal sd s.
function callN(S, K, s) { const d = (S - K) / s; return (S - K) * N(d) + s * Math.exp(-d * d / 2) / Math.sqrt(2 * Math.PI); }
function putN(S, K, s) { return callN(S, K, s) - (S - K); }

const parse = legs => (legs || []).map(l => {
  const lb = String(l.label || '').toLowerCase();
  return { k: +l.strike, call: lb.includes('call'), q: (lb.includes('short') || lb.includes('sell') ? -1 : 1) * (/x2\b/.test(lb) ? 2 : 1) };
}).filter(l => isFinite(l.k));

export function flyBand({ legs, price, sdLeft, sdDay, net }) {
  const L = parse(legs);
  if (L.length < 3 || !(price > 0) || !(sdLeft > 0)) return null;
  const intrinsic = x => L.reduce((a, l) => a + l.q * Math.max(0, l.call ? x - l.k : l.k - x), 0);
  const fair = L.reduce((a, l) => a + l.q * (l.call ? callN(price, l.k, sdLeft) : putN(price, l.k, sdLeft)), 0);
  const typed = isFinite(net) && net !== 0;
  const n = typed ? net : -fair;                               // per share, + credit / − debit
  const ks = L.map(l => l.k);
  const lo = Math.min(...ks, price) - 4 * sdLeft, hi = Math.max(...ks, price) + 4 * sdLeft;
  const steps = 800, dx = (hi - lo) / steps;
  const pts = [];
  for (let i = 0; i <= steps; i++) { const x = lo + i * dx; pts.push({ x, pnl: intrinsic(x) + n }); }
  // profitable mass and the band containing the best point
  const F = x => N((x - price) / sdLeft);
  let pInside = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i - 1].pnl > 0 && pts[i].pnl > 0) pInside += F(pts[i].x) - F(pts[i - 1].x);
  if (pts[0].pnl > 0) pInside += F(pts[0].x);
  if (pts[pts.length - 1].pnl > 0) pInside += 1 - F(pts[pts.length - 1].x);
  let best = 0;
  pts.forEach((p, i) => { if (p.pnl > pts[best].pnl) best = i; });
  if (!(pts[best].pnl > 0)) return { typed, net: n, pInside: 0, lo: null, hi: null, width: 0, halfSD: 0, pctOfDay: 0, sdLeft, sdDay: sdDay || null };
  let a = best, b = best;
  while (a > 0 && pts[a - 1].pnl > 0) a--;
  while (b < pts.length - 1 && pts[b + 1].pnl > 0) b++;
  const cross = (i, j) => { const p = pts[i], q = pts[j]; return p.x + (p.pnl / (p.pnl - q.pnl)) * (q.x - p.x); };
  const bandLo = a > 0 ? cross(a - 1, a) : -Infinity;
  const bandHi = b < pts.length - 1 ? cross(b, b + 1) : Infinity;
  const width = isFinite(bandLo) && isFinite(bandHi) ? bandHi - bandLo : Infinity;
  return {
    typed, net: +n.toFixed(2), sdLeft, sdDay: sdDay || null,
    lo: isFinite(bandLo) ? +bandLo.toFixed(2) : null, hi: isFinite(bandHi) ? +bandHi.toFixed(2) : null,
    width: isFinite(width) ? +width.toFixed(2) : null,
    halfSD: isFinite(width) ? +(width / 2 / sdLeft).toFixed(2) : null,
    pInside: +Math.min(1, Math.max(0, pInside)).toFixed(3),
    pctOfDay: isFinite(width) && sdDay > 0 ? +(width / (2 * sdDay)).toFixed(2) : null,
  };
}

export const BAND_THIN_PCT_OF_DAY = 0.30;
