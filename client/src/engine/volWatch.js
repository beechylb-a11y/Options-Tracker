// Volatility watch (Nov 2026).
// For trades whose main risk is a change in implied volatility — short premium above
// all — the price can sit still while the P&L moves. Three reads:
//   market:   VIX against its prior close, VIX1D, and VIX ÷ VIX3M (above 1 = backwardation)
//   position: IV now against IV at entry, leg by leg where the ticket logged them,
//             and today's P&L split into price, time, IV and the rest
//   book:     total vega and what the VIX move has cost it
// Tones: null (quiet) · 'amber' (watch) · 'red' (act). Short-vega trades warn when IV
// rises, long-vega ones when it falls; near vega-neutral ones stay quiet.

export const VOL_LIMITS = {
  vixPct: { amber: 15, red: 25 },     // VIX up % since the prior close
  vixPts: { amber: 3 },               // … or points
  term: { red: 1.0 },                 // VIX ÷ VIX3M
  ivPts: { amber: 5, red: 10 },       // position IV since entry, against the trade
  ivPct: { amber: 25, red: 50 },
  thetaDays: { amber: 5 },            // the IV move has cost ≥ 5 days of the trade's theta
  bookVegaPct: { amber: 0.5, red: 1 },// today's vega P&L, % of net liq
  vix1dPct: { amber: 20 },            // 0DTE: VIX1D since entry
};
const RANK = { null: 0, amber: 1, red: 2 };
export const worst = (...t) => t.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), null);
const px = q => (q ? (q.last ?? q.mark ?? null) : null);
const avg = xs => { const v = xs.filter(x => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function marketVol({ vix, vix1d, vix3m } = {}) {
  const now = px(vix), close = vix && vix.close;
  const pts = now > 0 && close > 0 ? now - close : null;
  const pct = pts != null ? (pts / close) * 100 : null;
  const v3 = px(vix3m);
  const term = now > 0 && v3 > 0 ? now / v3 : null;
  const reasons = [];
  let tone = null;
  if (pct != null && pct >= VOL_LIMITS.vixPct.red) { tone = 'red'; reasons.push(`VIX up ${pct.toFixed(0)}% since the close`); }
  else if (pct != null && (pct >= VOL_LIMITS.vixPct.amber || pts >= VOL_LIMITS.vixPts.amber)) { tone = 'amber'; reasons.push(`VIX up ${pct.toFixed(0)}% (${pts >= 0 ? '+' : ''}${pts.toFixed(1)} pts) since the close`); }
  if (term != null && term >= VOL_LIMITS.term.red) { tone = 'red'; reasons.push(`VIX above VIX3M (${term.toFixed(2)}): backwardation`); }
  return { vix: now, vixClose: close || null, pts, pct, vix1d: px(vix1d), vix1dClose: (vix1d && vix1d.close) || null, vix3m: v3, term, tone, reasons };
}

const legKey = l => `${+l.strike}${String(l.right || '').toUpperCase()}`;

// One position: r is a positionRisk result (r.p = the book entry).
export function positionVol(r, { market, todayMs = Date.now() } = {}) {
  if (!r || !r.p) return null;
  const p = r.p, e = p.entry || {};
  const legs = (r.legs || []).filter(l => Number.isFinite(l.iv) && l.iv > 0);
  let ivEntry = null, ivNow = null, basis = null;
  if (e.legIvs && legs.length) {
    const pairs = legs.map(l => [e.legIvs[legKey(l)], l.iv]).filter(([a]) => a > 0);
    if (pairs.length) { ivEntry = avg(pairs.map(x => x[0])); ivNow = avg(pairs.map(x => x[1])); basis = 'legs'; }
  }
  if (ivEntry == null && legs.length && (e.ivx > 0 || e.iv > 0)) {
    ivEntry = e.ivx > 0 ? e.ivx : e.iv; ivNow = avg(legs.map(l => l.iv)); basis = e.ivx > 0 ? 'expiry IV' : 'underlying IV, skew not removed';
  }
  const g = r.greeks || {};
  const vega = Number.isFinite(g.vega) ? g.vega : null, theta = Number.isFinite(g.theta) ? g.theta : null;
  const dIv = ivEntry != null && ivNow != null ? ivNow - ivEntry : null;
  const dIvPct = dIv != null && ivEntry > 0 ? (dIv / ivEntry) * 100 : null;
  const shortVega = vega != null ? vega < 0 : !!(p.pos && p.pos.isCredit);
  const neutral = vega != null && theta != null && Math.abs(vega) < 0.25 * Math.abs(theta);
  const against = dIv == null ? null : shortVega ? dIv : -dIv;
  const againstPct = dIvPct == null ? null : shortVega ? dIvPct : -dIvPct;
  let tone = null; const reasons = [];
  if (!neutral && against != null) {
    if (against >= VOL_LIMITS.ivPts.red || againstPct >= VOL_LIMITS.ivPct.red) { tone = 'red'; reasons.push(`IV ${dIv >= 0 ? '+' : ''}${dIv.toFixed(1)} pts since entry, against the trade`); }
    else if (against >= VOL_LIMITS.ivPts.amber || againstPct >= VOL_LIMITS.ivPct.amber) { tone = 'amber'; reasons.push(`IV ${dIv >= 0 ? '+' : ''}${dIv.toFixed(1)} pts since entry, against the trade`); }
  }
  // Days of theta the IV move has cost (Nov 2026): at 45 DTE vega is normally several
  // times theta, so the ratio alone says nothing; what matters is how much decay the
  // move has already wiped out.
  const thetaDays = !neutral && against > 0 && vega != null && theta && Math.abs(theta) > 0 ? Math.abs(vega * dIv) / Math.abs(theta) : null;
  if (thetaDays != null && thetaDays >= VOL_LIMITS.thetaDays.amber) {
    tone = worst(tone, 'amber'); reasons.push(`the IV move has cost ${Math.round(thetaDays)} days of theta`);
  }
  let vix1dPct = null;
  if (p.engine === '0DTE' && e.vix1d > 0 && market && market.vix1d > 0) {
    vix1dPct = ((market.vix1d - e.vix1d) / e.vix1d) * 100;
    if (shortVega && vix1dPct >= VOL_LIMITS.vix1dPct.amber) { tone = worst(tone, 'amber'); reasons.push(`VIX1D up ${vix1dPct.toFixed(0)}% since entry`); }
  }
  // Since-entry split of the P&L: price (delta + half gamma), time (theta × days),
  // IV (vega × IV change), and what is left. Today's greeks on the whole hold, so
  // it is a rough split, labelled as one.
  let split = null;
  if (Number.isFinite(r.pnl) && r.spot > 0 && e.spot > 0) {
    const ds = r.spot - e.spot;
    const ymd = String(e.ymd || '');
    const days = ymd.length === 8 ? Math.max(0, Math.round((todayMs - Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))) / 86400000)) : 0;
    const price = (g.delta || 0) * ds + 0.5 * (g.gamma || 0) * ds * ds;
    const time = (theta || 0) * days;
    const iv = vega != null && dIv != null ? vega * dIv : 0;
    split = { price, time, iv, other: r.pnl - price - time - iv, pnl: r.pnl, days };
  }
  return { key: p.key, underlying: p.underlying, strategy: p.strategy, engine: p.engine, account: p.row && p.row.account,
    ivEntry, ivNow, dIv, dIvPct, basis, vega, theta, shortVega, neutral, vix1dPct, thetaDays, tone, reasons, split,
    vegaPnl: vega != null && dIv != null ? vega * dIv : null };
}

// The book: total vega, what the VIX move since the close has cost it (≈ vega × VIX
// points, as if every IV moved with VIX), and the worst tone.
export function bookVol(positions, market, netLiq) {
  const list = (positions || []).filter(Boolean);
  const vega = list.reduce((s, x) => s + (x.vega || 0), 0);
  const today = market && market.pts != null && list.length ? vega * market.pts : null;
  const todayPct = today != null && netLiq > 0 ? (today / netLiq) * 100 : null;
  let tone = market ? market.tone : null; const reasons = market ? [...market.reasons] : [];
  if (todayPct != null && todayPct <= -VOL_LIMITS.bookVegaPct.red) { tone = 'red'; reasons.push(`the IV move has cost about ${Math.abs(todayPct).toFixed(1)}% of net liq today`); }
  else if (todayPct != null && todayPct <= -VOL_LIMITS.bookVegaPct.amber) { tone = worst(tone, 'amber'); reasons.push(`the IV move has cost about ${Math.abs(todayPct).toFixed(1)}% of net liq today`); }
  const flagged = list.filter(x => x.tone);
  if (flagged.length) tone = worst(tone, flagged.some(x => x.tone === 'red') ? 'red' : 'amber');
  return { vega, today, todayPct, tone, reasons, flagged, n: list.length };
}
