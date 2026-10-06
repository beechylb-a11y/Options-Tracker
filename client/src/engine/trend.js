// ── 45DTE trend read (Oct 2026) ──
//
// The 0DTE engine reads today's session: VWAP, range used, 5m/2h ATR, the ES
// overnight. None of it means anything to a trade held three to six weeks. This
// reads the slow backdrop from daily bars instead:
//
//   direction   close vs the 20- and 50-day SMA, and the 20-day's slope over 10 sessions
//   strength    ADX(14), Wilder — below 20 a range, 20–25 developing, above 25 trending
//   stretch     (close − SMA20) ÷ σ of the last 20 closes — |z| > 2 is stretched
//   acceptance  share of the last 10 closes above the SMA20 (the daily VWAP-acceptance)
//   realised    HV10 ÷ HV60 — below 0.7 coiled, above 1.3 expanding
//
// The outlook it sets is the engine's `outlook`: a directional call needs the MAs
// stacked AND the 20-day sloping that way AND ADX ≥ 20. Anything less is neutral —
// a weak trend is a range for a 45-day premium seller. Thresholds are conventions
// to calibrate against logged 45DTE trades, not measured edges.
//
// Input: bars as [yyyymmdd, open, high, low, close] (the bridge's `daily`), oldest
// first. Every output is a ratio or a % so a proxy (SPY for SPX) reads the same.

export const TREND_ADX_RANGE = 20;
export const TREND_ADX_TREND = 25;
export const STRETCH_Z = 2;
export const HV_COILED = 0.7;
export const HV_EXPANDING = 1.3;

const sma = (xs, n, end = xs.length) => {
  if (end < n) return null;
  let s = 0; for (let i = end - n; i < end; i++) s += xs[i];
  return s / n;
};
function stdev(xs) {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}
// Annualised close-to-close vol over the last n returns, in %.
export function realisedVol(closes, n) {
  if (!closes || closes.length < n + 1) return null;
  const r = [];
  for (let i = closes.length - n; i < closes.length; i++) r.push(Math.log(closes[i] / closes[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * 252) * 100;
}

// Wilder ADX. Needs about 2n + 1 bars to settle; returns null with fewer.
export function adx(highs, lows, closes, n = 14) {
  const len = closes.length;
  if (len < 2 * n + 1) return null;
  const tr = [], pdm = [], mdm = [];
  for (let i = 1; i < len; i++) {
    const up = highs[i] - highs[i - 1], dn = lows[i - 1] - lows[i];
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  }
  let atr = tr.slice(0, n).reduce((a, b) => a + b, 0);
  let pS = pdm.slice(0, n).reduce((a, b) => a + b, 0);
  let mS = mdm.slice(0, n).reduce((a, b) => a + b, 0);
  const dxs = [];
  let pdi = 0, mdi = 0;
  for (let i = n; i <= tr.length; i++) {
    if (i > n) {
      atr = atr - atr / n + tr[i - 1];
      pS = pS - pS / n + pdm[i - 1];
      mS = mS - mS / n + mdm[i - 1];
    }
    pdi = atr > 0 ? 100 * pS / atr : 0;
    mdi = atr > 0 ? 100 * mS / atr : 0;
    dxs.push(pdi + mdi > 0 ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0);
  }
  if (dxs.length < n) return null;
  let a = dxs.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dxs.length; i++) a = (a * (n - 1) + dxs[i]) / n;
  return { adx: a, plusDI: pdi, minusDI: mdi };
}

export function computeTrend(bars) {
  const rows = (bars || []).filter(b => Array.isArray(b) && b[4] > 0);
  if (rows.length < 30) return null;
  const highs = rows.map(b => +b[2]), lows = rows.map(b => +b[3]), closes = rows.map(b => +b[4]);
  const last = closes[closes.length - 1];
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const s20prior = sma(closes, 20, closes.length - 10);
  const slope20 = s20 != null && s20prior ? (s20 / s20prior - 1) * 100 : null;      // % over 10 sessions
  const sd20 = stdev(closes.slice(-20));
  const z20 = sd20 > 0 ? (last - s20) / sd20 : 0;
  const lastTen = closes.slice(-10);
  // acceptance: each of the last 10 closes against the 20-day SMA as it stood that day
  let above = 0;
  for (let k = 0; k < lastTen.length; k++) {
    const end = closes.length - (lastTen.length - 1 - k);
    const m = sma(closes, 20, end);
    if (m != null && closes[end - 1] > m) above++;
  }
  const accept10 = above / lastTen.length;
  const a = adx(highs, lows, closes, 14);
  const hv10 = realisedVol(closes, 10), hv60 = realisedVol(closes, 60);
  const hvRatio = hv10 != null && hv60 > 0 ? hv10 / hv60 : null;

  const stackedUp = s50 != null && last > s20 && s20 > s50 && slope20 > 0;
  const stackedDn = s50 != null && last < s20 && s20 < s50 && slope20 < 0;
  const adxV = a ? a.adx : null;
  const strength = adxV == null ? 'unknown' : adxV < TREND_ADX_RANGE ? 'range' : adxV <= TREND_ADX_TREND ? 'developing' : 'trending';
  const strongEnough = adxV != null && adxV >= TREND_ADX_RANGE;
  const outlook = stackedUp && strongEnough ? 'bullish' : stackedDn && strongEnough ? 'bearish' : 'neutral';
  const lean = stackedUp ? 'up' : stackedDn ? 'down' : 'mixed';
  const stretch = z20 >= STRETCH_Z ? 'stretched up' : z20 <= -STRETCH_Z ? 'stretched down' : 'normal';
  const hvRegime = hvRatio == null ? 'unknown' : hvRatio < HV_COILED ? 'coiled' : hvRatio > HV_EXPANDING ? 'expanding' : 'steady';

  const why = outlook !== 'neutral'
    ? `MAs stacked ${lean}, 20-day ${slope20 >= 0 ? 'rising' : 'falling'} ${Math.abs(slope20).toFixed(1)}%, ADX ${adxV.toFixed(0)}`
    : lean !== 'mixed' && !strongEnough
      ? `MAs lean ${lean} but ADX ${adxV != null ? adxV.toFixed(0) : '—'} is a range`
      : 'MAs not stacked — no trend to lean on';

  const r1 = x => x == null ? null : +x.toFixed(1);
  const r2 = x => x == null ? null : +x.toFixed(2);
  return {
    outlook, lean, strength, stretch, hvRegime, why,
    asOf: rows[rows.length - 1][0], bars: rows.length,
    pctVs20: s20 ? r2((last / s20 - 1) * 100) : null,
    pctVs50: s50 ? r2((last / s50 - 1) * 100) : null,
    slope20: r2(slope20), z20: r2(z20), accept10: r2(accept10),
    adx: r1(adxV), plusDI: a ? r1(a.plusDI) : null, minusDI: a ? r1(a.minusDI) : null,
    hv10: r1(hv10), hv60: r1(hv60), hvRatio: r2(hvRatio),
  };
}

// One line for a scan cell / ticket readout.
export function trendLabel(t) {
  if (!t) return '';
  const dir = t.outlook === 'bullish' ? 'Bullish' : t.outlook === 'bearish' ? 'Bearish' : 'Neutral';
  return `${dir} · ADX ${t.adx != null ? t.adx.toFixed(0) : '—'} ${t.strength}`;
}

// Does a position's delta fight the trend? +1 with, −1 against, 0 neutral/flat.
export function trendFit(t, positionDelta) {
  if (!t || t.outlook === 'neutral' || !isFinite(positionDelta) || Math.abs(positionDelta) < 1) return 0;
  const want = t.outlook === 'bullish' ? 1 : -1;
  return Math.sign(positionDelta) === want ? 1 : -1;
}
