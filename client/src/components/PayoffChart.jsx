// ================================================================
//  PAYOFF CHART — one chart for every ticket (Nov 2026)
//
//  Replaces the 45DTE "Payoff over time" chart and the 0DTE "Payoff at expiry"
//  diagram. Built on engine/payoffCurve.js (Black-Scholes per leg at its own expiry
//  and IV), so the maths is the one the rest of the engine already trusts.
//
//  What is on it, and why:
//    • BOLD BLUE = P&L on the day / at the time you actually close: the 21-DTE (or
//      front-leg) close for 45DTE, the time exit for 0DTE. Expiry is the thin
//      reference line; "now" is dotted. The green / red zones fill under the bold
//      curve, because that is the P&L you realise.
//    • Expected-move bands (±1σ, ±2σ) and a probability bell under the price axis,
//      sized to the time from now to the evaluated moment — not to expiry.
//    • Strike blocks on the axis: short legs red, long green.
//    • Break-even diamonds, target (and stop, if given) as dashed P&L lines.
//    • The live price from the TWS stream when there is one (live/useLive.js), with
//      today's high–low; else the engine's spot.
//    • Hover any price: P&L at the evaluated moment, at expiry and now.
//    • Time scrubber (now → close → expiry) and an IV what-if (−2 / 0 / +2 points).
//
//  Per contract throughout, like the engine's payoff. Win chance here is P(profit)
//  on the evaluated date from this curve; the engine's own Max-loss chance stays
//  where it is defined (one definition per number), so it is not redrawn here.
// ================================================================
import React, { useMemo, useState, useEffect, useRef } from 'react';
import { curveAt, probProfit, pnlAt, positionValue, HARD_CLOSE_DTE, RATE } from '../engine/payoffCurve';
import { addDaysYmd, fmtExpiry } from '../utils/expiries';
import { useLiveQuote, useFreshness } from '../live/useLive';
import FreshDot from './FreshDot';

const W = 760, CH = 300, PAD = { top: 18, right: 16, left: 60 };
const BELL_TOP = CH + 8, BELL_H = 30, STRIKE_Y = BELL_TOP + BELL_H + 6, AXIS_Y = STRIKE_Y + 44;
const H = AXIS_Y + 8;
const C = {
  green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)',
  purple: 'var(--c-bc8cff)', text: 'var(--c-e6edf3)', soft: 'var(--c-a8b2be)', grey: 'var(--c-8b949e)',
  dim: 'var(--c-6e7681)', line: 'var(--c-30363d)', line2: 'var(--c-21262d)', bg: 'var(--c-0d1117)',
};
const MONO = 'JetBrains Mono, SF Mono, Menlo, monospace';
const money = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString();
const signed = v => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString();
const kfmt = v => (v < 0 ? '−' : '') + (Math.abs(v) >= 1000 ? (Math.abs(v) / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'K' : String(Math.round(Math.abs(v))));
const px2 = v => Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const niceStep = raw => { const m = 10 ** Math.floor(Math.log10(raw || 1)); return [1, 2, 2.5, 5, 10].map(k => k * m).find(s => s >= raw) || raw; };

// 0DTE time runs in TRADING time: an hour of the session carries 1/(6.5 × 252) of a
// year's variance, not 1/8760. VIX1D over calendar hours put 1σ to the close near 17
// SPX points when the day's expected move was ±40 — trading time lines the bands up
// with the EM. Intraday legs carry `dte` in these units (days of calendar-year time),
// so the Black-Scholes in payoffCurve.js needs no change.
export const INTRADAY_DAYS_PER_HOUR = 365 / (6.5 * 252);
const hoursOf = days => days / INTRADAY_DAYS_PER_HOUR;

/** NY clock time at `days` into an intraday chart whose expiry (16:00) is `toBell` away. */
function etAt(days, toBell) {
  const m = Math.round(16 * 60 - hoursOf(toBell - days) * 60);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

/** Strike blocks: one per strike+right (a BWB body is one block, ×2), staggered when close. */
export function strikeBlocks(cl, x) {
  const map = new Map();
  for (const l of cl) {
    const k = `${l.strike}${l.right}`;
    const prev = map.get(k) || { strike: l.strike, right: l.right, net: 0 };
    prev.net += l.sign * (l.qty || 1);
    map.set(k, prev);
  }
  const blocks = [...map.values()].filter(b => b.net !== 0).sort((a, b) => a.strike - b.strike);
  const lastX = [-Infinity, -Infinity];
  return blocks.map(b => {
    const bx = x(b.strike);
    const row = bx - lastX[0] >= 50 ? 0 : bx - lastX[1] >= 50 ? 1 : 0;
    lastX[row] = bx;
    return { ...b, x: bx, row };
  });
}

/** Nearest listed strike for this right (snap.P / snap.C), else the nearest grid step. */
export function snapStrike(price, right, snap) {
  const list = snap && Array.isArray(snap[right]) && snap[right].length ? snap[right] : null;
  if (list) return list.reduce((b, k) => (Math.abs(k - price) < Math.abs(b - price) ? k : b), list[0]);
  const step = snap && snap.step > 0 ? snap.step : 1;
  return Math.round(price / step) * step;
}
/** The next listed strike (or grid step) above (dir +1) or below (dir −1). */
export function stepStrike(strike, right, dir, snap) {
  const list = snap && Array.isArray(snap[right]) && snap[right].length ? [...snap[right]].sort((a, b) => a - b) : null;
  if (list) {
    const next = dir > 0 ? list.find(k => k > strike + 1e-9) : [...list].reverse().find(k => k < strike - 1e-9);
    return next != null ? next : strike;
  }
  const step = snap && snap.step > 0 ? snap.step : 1;
  return +(strike + dir * step).toFixed(4);
}
/** The legs with one strike+right block moved, and the entry re-priced by the model
 *  difference at today, so the edge over fair value carries over. */
export function movedLegs(cl, net, from, right, to, spot) {
  const moved = cl.map(l => (l.strike === from && l.right === right ? { ...l, strike: to } : l));
  const dv = spot > 0 ? positionValue(moved, spot, 0) - positionValue(cl, spot, 0) : 0;
  return { cl: moved, net: net - dv };
}

export default function PayoffChart({ cl: clIn, net: netIn, netSource, spot, lo, hi, sigmaNear, nearDte, closeDay,
  todayYmd, isTimeSpread, underlying, divYield, closeDte = HARD_CLOSE_DTE, target, targets, stop,
  closeOptions, closeLeg, onCloseDte, exitSim, intraday = false, closeEt = '', scopeNote = '',
  onStrikeChange, strikeSnap, ghost, hero = false }) {
  // Hero (Vision): chart type a quarter larger, so axis and strike labels read at 13 px
  // rather than 10 at the ticket's width (24 Nov 2026).
  const fs = n => (hero ? Math.round(n * 1.25 * 10) / 10 : n);
  // hero (Vision ticket, Nov 2026): the P&L at the moment shown leads, big, with Now /
  // close / Expiry as one segmented pill, and four large facts under the chart.
  // onStrikeChange(legIdx, strike): strike blocks drag (snapping to strikeSnap: { P, C, step })
  //   and arrow keys step them; the curves preview while dragging, the engine re-runs on drop.
  // ghost: { cl, net, label } — another structure drawn dashed for comparison.
  const svgRef = useRef(null);
  const [drag, setDrag] = useState(null);   // { strike, right, to, legIdx[] }
  const moving = drag && drag.to !== drag.strike;
  const view = useMemo(() => (moving ? movedLegs(clIn, netIn, drag.strike, drag.right, drag.to, spot) : { cl: clIn, net: netIn }),
    [clIn, netIn, moving, drag, spot]);
  const cl = view.cl, net = view.net;
  // scopeNote: replaces "Per contract." when the curves are a whole position (manage view).
  // target: { dollars, label } — the 45DTE rule's profit target per contract.
  // targets: [{ pnl, label, color }] — 0DTE target lines (the old diagram's list).
  // stop: { dollars (negative), label } — drawn "info only".
  const [day, setDay] = useState(closeDay);
  const [band, setBand] = useState(intraday ? 0 : 2);
  const [ivShift, setIvShift] = useState(0);
  const [hoverPx, setHoverPx] = useState(null);
  useEffect(() => { setDay(closeDay); }, [closeDay, nearDte]);
  useEffect(() => {
    if (!drag) return undefined;
    const esc = e => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [drag]);
  const d = Math.min(Math.max(0, day), nearDte);
  const maxLegDte = Math.max(...cl.map(l => l.dte));

  // Live price from the TWS stream, when it is actually arriving.
  const q = useLiveQuote(underlying ? String(underlying).toUpperCase() : null);
  const fresh = useFreshness(q);
  const livePx = q && fresh !== 'off' && (q.mark ?? q.last) > 0 ? (q.mark ?? q.last) : null;
  const px = livePx || spot;

  const curves = useMemo(() => {
    const opts = { net, lo, hi, volShift: ivShift };
    const sel = curveAt(cl, { ...opts, days: d });
    const now = d === 0 ? null : curveAt(cl, { ...opts, days: 0 });
    const exp = d >= nearDte ? null : curveAt(cl, { ...opts, days: nearDte });
    const hasTime = d < maxLegDte && band > 0;
    const up = hasTime ? curveAt(cl, { ...opts, days: d, volShift: ivShift + band }) : null;
    const dn = hasTime ? curveAt(cl, { ...opts, days: d, volShift: ivShift - band }) : null;
    return { sel, now, exp, up, dn };
  }, [cl, net, lo, hi, d, nearDte, band, ivShift, maxLegDte]);

  // The comparison: the structure before the drag, else the hovered/pinned alternative.
  const ghostIn = moving ? { cl: clIn, net: netIn, label: `before (${drag.strike}${drag.right})` } : ghost && Array.isArray(ghost.cl) && ghost.cl.length ? ghost : null;
  const ghostCurve = useMemo(() => (ghostIn ? curveAt(ghostIn.cl, { net: ghostIn.net, lo, hi, days: Math.min(d, Math.min(...ghostIn.cl.map(l => l.dte))), volShift: ivShift }) : null),
    [ghostIn, lo, hi, d, ivShift]);   // eslint-disable-line react-hooks/exhaustive-deps
  const tgtLines = [
    ...(target && target.dollars > 0 ? [{ pnl: target.dollars, label: `target ${money(target.dollars)}`, color: C.green, long: target.label }] : []),
    ...((targets || []).filter(t => t && t.pnl > 0 && isFinite(t.pnl)).map(t => ({ pnl: t.pnl, label: t.label, color: t.color || C.green }))),
  ];
  const stopLine = stop && stop.dollars < 0 && isFinite(stop.dollars) ? stop.dollars : null;
  const all = [curves.sel, curves.now, curves.exp, curves.up, curves.dn, ghostCurve].filter(Boolean);
  const pnls = all.flatMap(c => c.points.map(p => p.pnl)).concat(tgtLines.map(t => t.pnl), stopLine != null ? [stopLine] : []);
  const minPnl = Math.min(0, ...pnls), maxPnl = Math.max(0, ...pnls);
  const range = (maxPnl - minPnl) || 1;
  const pad = range * 0.06;
  const yLo = minPnl - pad, yHi = maxPnl + pad;
  const cW = W - PAD.left - PAD.right, cH = CH - PAD.top;
  const x = p => PAD.left + (p - lo) / (hi - lo) * cW;
  const y = v => PAD.top + cH - (v - yLo) / (yHi - yLo) * cH;
  const path = c => c.points.map((p, i) => (i ? 'L' : 'M') + x(p.price).toFixed(1) + ',' + y(p.pnl).toFixed(1)).join('');
  const zeroY = y(0);
  const bandPath = curves.up && curves.dn
    ? path(curves.up) + curves.dn.points.slice().reverse().map(p => 'L' + x(p.price).toFixed(1) + ',' + y(p.pnl).toFixed(1)).join('') + 'Z'
    : null;
  const selArea = path(curves.sel) + `L${x(hi).toFixed(1)},${zeroY.toFixed(1)}L${x(lo).toFixed(1)},${zeroY.toFixed(1)}Z`;

  const step = niceStep(range / 4);
  const yTicks = []; for (let v = Math.ceil(minPnl / step) * step; v <= maxPnl + 1e-9; v += step) yTicks.push(v);
  const xStep = niceStep((hi - lo) / 6);
  const xTicks = []; for (let v = Math.ceil(lo / xStep) * xStep; v <= hi; v += xStep) xTicks.push(v);

  const sel = curves.sel;
  const pop = probProfit(sel, px, sigmaNear, d);   // same price as the marker and the bands
  const atPx = pnlAt(cl, px, net, d, ivShift);
  const nowPx = pnlAt(cl, px, net, 0, ivShift);
  const dateYmd = intraday ? todayYmd : addDaysYmd(todayYmd, Math.round(d));
  const left = nearDte - d;
  const isClose = Math.abs(d - closeDay) < 1e-9 && nearDte > (intraday ? 0 : closeDte);
  const label = intraday
    ? (d === 0 ? 'Now' : d >= nearDte ? 'Expiry 16:00' : isClose ? `${closeEt || 'exit'} close` : `${etAt(d, nearDte)} ET`)
    : (d === 0 ? 'Today' : d >= nearDte ? (isTimeSpread ? 'Near expiry' : 'Expiry') : isClose ? `${closeDte}-DTE close` : 'Chosen date');

  // Expected move to the evaluated moment, at the near leg's IV.
  const sigPts = spot > 0 && d > 0 ? spot * Math.max(0.01, sigmaNear + ivShift / 100) * Math.sqrt(d / 365) : 0;
  const blocks = strikeBlocks(cl, x);
  const bes = sel.breakevens;

  const hover = hoverPx != null ? {
    sel: pnlAt(cl, hoverPx, net, d, ivShift),
    exp: d >= nearDte ? null : pnlAt(cl, hoverPx, net, nearDte, ivShift),
    now: d === 0 ? null : pnlAt(cl, hoverPx, net, 0, ivShift),
  } : null;

  const priceAt = clientX => {
    const svg = svgRef.current; if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const sx = (clientX - rect.left) / rect.width * W;
    return { sx, price: lo + (sx - PAD.left) / cW * (hi - lo) };
  };
  const onMove = e => {
    const p = priceAt(e.clientX); if (!p) return;
    if (drag) {
      const to = snapStrike(Math.min(hi, Math.max(lo, p.price)), drag.right, strikeSnap);
      if (to > 0 && to !== drag.to) setDrag(g => ({ ...g, to }));
      return;
    }
    if (p.sx < PAD.left || p.sx > W - PAD.right) { setHoverPx(null); return; }
    setHoverPx(p.price);
  };
  const commit = (g, to) => { if (onStrikeChange && g && to !== g.strike) g.legIdx.forEach(i => onStrikeChange(i, to)); };
  const onUp = () => { if (drag) { commit(drag, drag.to); setDrag(null); } };
  const legIdxOf = b => [...new Set(clIn.map((l, i) => (l.strike === b.strike && l.right === b.right ? (l.legIdx ?? i) : null)).filter(i => i != null))];
  const startDrag = (b, e) => {
    if (!onStrikeChange) return;
    e.preventDefault(); e.stopPropagation();
    try { svgRef.current && svgRef.current.setPointerCapture && svgRef.current.setPointerCapture(e.pointerId); } catch (err) { /* jsdom */ }
    setHoverPx(null);
    setDrag({ strike: b.strike, right: b.right, to: b.strike, legIdx: legIdxOf(b) });
  };
  const onBlockKey = (b, e) => {
    if (!onStrikeChange || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const to = stepStrike(b.strike, b.right, e.key === 'ArrowRight' ? 1 : -1, strikeSnap);
    commit({ strike: b.strike, legIdx: legIdxOf(b) }, to);
  };
  // What the drag changes, in the chart's own numbers.
  const dragFacts = moving ? (() => {
    const before = curveAt(clIn, { net: netIn, lo, hi, days: d, volShift: ivShift });
    return {
      popBefore: probProfit(before, px, sigmaNear, d), pnlBefore: pnlAt(clIn, px, netIn, d, ivShift),
      netBefore: netIn, maxLossBefore: before.maxLoss,
    };
  })() : null;

  const btn = on => ({ padding: '3px 10px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid ' + (on ? 'var(--c-2f81f7)' : C.line), background: on ? 'var(--c-0d1a2b)' : 'transparent', color: on ? C.blue : 'var(--c-c9d1d9)' });
  const closeLabel = intraday
    ? `${closeEt || 'Exit'} close`
    : nearDte > closeDte ? `${closeDte}-DTE close · ${fmtExpiry(addDaysYmd(todayYmd, closeDay))}` : `Close now (inside ${closeDte} DTE)`;
  const sliderStep = intraday ? INTRADAY_DAYS_PER_HOUR / 12 : 1;   // 5 minutes / 1 day

  const heroWhen = intraday
    ? (d === 0 ? 'now' : d >= nearDte ? 'expiry' : isClose ? `the ${closeEt || 'exit'} close` : `${etAt(d, nearDte)} ET`)
    : (d === 0 ? 'today' : d >= nearDte ? (isTimeSpread ? 'near expiry' : 'expiry') : isClose ? `the ${closeDte}-DTE close` : fmtExpiry(dateYmd));
  const seg = on => ({ border: 'none', borderRadius: 999, padding: '8px 16px', font: 'inherit', fontSize: 14, fontWeight: 500, cursor: 'pointer',
    background: on ? 'rgba(255,255,255,0.26)' : 'transparent', color: on ? '#fff' : 'rgba(255,255,255,0.84)', boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,0.35)' : 'none' });
  return (
    <div data-testid="payoff-time-chart" data-chart="payoff">
      {hero && (
        <div data-testid="payoff-hero" style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
          <div style={{ flex: '1 1 280px', minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>P&amp;L at {heroWhen}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginTop: 2 }}>
              <span data-testid="payoff-hero-pnl" className="num" style={{ fontSize: 54, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.05, color: atPx >= 0 ? '#ffffff' : '#ffa39a' }}>{signed(atPx)}</span>
              <span className="num" style={{ fontSize: 15, color: 'rgba(255,255,255,0.86)' }}>at {livePx ? 'live' : 'spot'} {px2(px)} · max {signed(sel.maxProfit)}</span>
            </div>
          </div>
          <div role="group" aria-label="When" style={{ display: 'inline-flex', gap: 2, padding: 4, borderRadius: 999, background: 'rgba(0,0,0,0.16)', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.18)' }}>
            <button type="button" aria-pressed={d === 0} style={seg(d === 0)} onClick={() => setDay(0)}>{intraday ? 'Now' : 'Today'}</button>
            <button type="button" aria-pressed={isClose} style={seg(isClose)} onClick={() => setDay(closeDay)}>{intraday ? (closeEt || 'Exit') : `${closeDte} DTE`}</button>
            <button type="button" aria-pressed={d >= nearDte} style={seg(d >= nearDte)} onClick={() => setDay(nearDte)}>Expiry</button>
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        {!hero && <>
        <button type="button" style={btn(d === 0)} onClick={() => setDay(0)}>{intraday ? 'Now' : 'Today'}</button>
        <button type="button" style={btn(isClose)} onClick={() => setDay(closeDay)}>{closeLabel}</button>
        <button type="button" style={btn(d >= nearDte)} onClick={() => setDay(nearDte)}>
          {intraday ? 'Expiry 16:00' : `${isTimeSpread ? 'Near expiry' : 'Expiry'} · ${fmtExpiry(addDaysYmd(todayYmd, nearDte))}`}</button>
        </>}
        {Array.isArray(closeOptions) && onCloseDte && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, color: C.soft }} data-testid="close-dte-toggle">
            Close at
            {closeOptions.map(c => (
              <button key={c} type="button" onClick={() => onCloseDte(c)} style={btn(closeDte === c)}>
                {c} DTE{c === closeOptions[0] && closeLeg ? ` (${closeLeg})` : ''}
              </button>
            ))}
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.soft }} data-testid="iv-whatif">
          IV
          {[-2, 0, 2].map(v => (
            <button key={v} type="button" aria-pressed={ivShift === v} onClick={() => setIvShift(v)} style={btn(ivShift === v)}>
              {v === 0 ? 'now' : (v > 0 ? '+' : '−') + Math.abs(v)}
            </button>
          ))}
        </span>
        <label style={{ fontSize: 12, color: C.soft, display: 'flex', alignItems: 'center', gap: 6 }}>
          Vol band ±
          <select value={band} onChange={e => setBand(+e.target.value)}
            style={{ background: C.bg, color: C.text, border: `1px solid ${C.line}`, borderRadius: 6, fontSize: 12, padding: '2px 4px' }}>
            {[0, 1, 2, 3, 5].map(v => <option key={v} value={v}>{v} pt</option>)}
          </select>
        </label>
      </div>
      <input type="range" min={0} max={nearDte} step={sliderStep} value={d} onChange={e => setDay(+e.target.value)}
        aria-label={intraday ? 'Time from now' : 'Days from today'} style={{ width: '100%', accentColor: C.blue }} />
      <div style={{ position: 'relative', fontSize: 11, color: C.grey, height: 14, marginBottom: 4 }}>
        <span style={{ position: 'absolute', left: 0 }}>{intraday ? `now ${etAt(0, nearDte)}` : 'today'}</span>
        {nearDte > 0 && closeDay > 0 && closeDay < nearDte && (
          <span style={{ position: 'absolute', left: `${closeDay / nearDte * 100}%`, transform: 'translateX(-50%)', color: C.amber }}>
            ▲ {intraday ? closeEt || etAt(closeDay, nearDte) : `${closeDte} DTE`}</span>
        )}
        <span style={{ position: 'absolute', right: 0 }}>{intraday ? '16:00' : isTimeSpread ? 'near exp' : 'expiry'}</span>
      </div>

      {moving && dragFacts && (
        <div data-testid="drag-preview" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 12.5, padding: '6px 10px', marginBottom: 6,
          borderRadius: 8, border: `1px solid ${C.blue}`, background: 'color-mix(in srgb, var(--c-58a6ff) 10%, transparent)', color: C.text }}>
          <b className="mono">{drag.strike}{drag.right} → {drag.to}{drag.right}</b>
          <span>Win chance {dragFacts.popBefore == null ? '—' : Math.round(dragFacts.popBefore * 100) + '%'} → <b>{pop == null ? '—' : Math.round(pop * 100) + '%'}</b></span>
          <span>P&L {label.toLowerCase()} {signed(dragFacts.pnlBefore)} → <b>{signed(atPx)}</b></span>
          <span>Max loss {money(dragFacts.maxLossBefore)} → <b>{money(sel.maxLoss)}</b></span>
          <span>Entry {Math.abs(dragFacts.netBefore).toFixed(2)} → <b>{Math.abs(net).toFixed(2)} {net >= 0 ? 'cr' : 'db'}</b> (model)</span>
          <span style={{ color: C.grey }}>Release to re-run the engine · Esc cancels</span>
        </div>
      )}
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', touchAction: 'none', cursor: drag ? 'ew-resize' : undefined }}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}
        onMouseLeave={() => { if (!drag) setHoverPx(null); }} role="img"
        aria-label={`P&L at ${label}: max ${money(sel.maxProfit)}, breakevens ${bes.join(', ') || 'none'}`}>
        <defs>
          <clipPath id="pc-above"><rect x={PAD.left} y={PAD.top} width={cW} height={Math.max(0, zeroY - PAD.top)} /></clipPath>
          <clipPath id="pc-below"><rect x={PAD.left} y={zeroY} width={cW} height={Math.max(0, PAD.top + cH - zeroY)} /></clipPath>
          <clipPath id="pc-plot"><rect x={PAD.left} y={PAD.top} width={cW} height={cH} /></clipPath>
        </defs>
        {/* expected move to the evaluated moment */}
        {sigPts > 0 && [2, 1].map(k => {
          const a = x(Math.max(lo, px - k * sigPts)), b = x(Math.min(hi, px + k * sigPts));
          return b > a ? <rect key={'em' + k} data-testid={`em-band-${k}`} x={a} y={PAD.top} width={b - a} height={cH}
            fill={C.blue} opacity={k === 1 ? 0.08 : 0.045} /> : null;
        })}
        {yTicks.map(v => (
          <g key={'y' + v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? C.dim : C.line2} strokeWidth={v === 0 ? 1 : 0.6} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize={fs(10.5)} fill={C.grey} fontFamily={MONO}>{kfmt(v)}</text>
          </g>
        ))}
        <path d={selArea} fill="color-mix(in srgb, var(--c-3fb950) 18%, transparent)" clipPath="url(#pc-above)" />
        <path d={selArea} fill="color-mix(in srgb, var(--c-f85149) 15%, transparent)" clipPath="url(#pc-below)" />
        {bandPath && <path d={bandPath} fill="color-mix(in srgb, var(--c-58a6ff) 16%, transparent)" stroke="none" />}
        {tgtLines.map((t, i) => (
          <g key={'t' + i}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t.pnl)} y2={y(t.pnl)} stroke={t.color} strokeWidth="1.1" strokeDasharray="6 4" />
            <text x={W - PAD.right - 4} y={y(t.pnl) - 4} textAnchor="end" fontSize={fs(10.5)} fill={t.color} fontFamily={MONO}>{t.label}</text>
          </g>
        ))}
        {stopLine != null && (
          <g data-testid="stop-line">
            <line x1={PAD.left} x2={W - PAD.right} y1={y(stopLine)} y2={y(stopLine)} stroke={C.red} strokeWidth="1.1" strokeDasharray="6 4" />
            <text x={PAD.left + 6} y={y(stopLine) - 4} fontSize={fs(10.5)} fill={C.red} fontFamily={MONO}>stop {money(stopLine)} · info only</text>
          </g>
        )}
        <g clipPath="url(#pc-plot)">
          {curves.exp && <path d={path(curves.exp)} fill="none" stroke={C.soft} strokeWidth="1.4" opacity="0.8" />}
          {curves.now && <path d={path(curves.now)} fill="none" stroke={C.purple} strokeWidth="1.6" strokeDasharray="1.5 4" strokeLinecap="round" />}
          {ghostCurve && <path data-testid="ghost-curve" d={path(ghostCurve)} fill="none" stroke={C.text} strokeWidth="1.6" strokeDasharray="7 5" opacity="0.55" />}
          <path data-testid="close-curve" d={path(sel)} fill="none" stroke={C.blue} strokeWidth="2.6" strokeLinejoin="round" />
        </g>
        {bes.map((b, i) => {
          const bx = x(b), up = i % 2 === 1 && bes.length > 1 && Math.abs(bx - x(bes[i - 1])) < 70;
          return (
            <g key={'be' + b} data-testid="breakeven">
              <path d={`M${bx},${zeroY - 6}L${bx + 6},${zeroY}L${bx},${zeroY + 6}L${bx - 6},${zeroY}Z`} fill={C.amber} />
              <text x={bx} y={up ? zeroY - 10 : zeroY + 18} textAnchor="middle" fontSize={fs(10.5)} fill={C.amber} fontFamily={MONO}>{px2(b)}</text>
            </g>
          );
        })}
        {/* today's range, then the price */}
        {q && q.high > 0 && q.low > 0 && q.high >= q.low && (
          <g data-testid="today-range">
            <rect x={x(Math.max(lo, q.low))} y={PAD.top - 12} width={Math.max(2, x(Math.min(hi, q.high)) - x(Math.max(lo, q.low)))} height="4" rx="2" fill={C.text} opacity="0.35" />
          </g>
        )}
        {px > 0 && px >= lo && px <= hi && (
          <g data-testid="price-marker">
            <line x1={x(px)} x2={x(px)} y1={PAD.top} y2={PAD.top + cH} stroke={C.text} strokeWidth="1.4" opacity="0.85" />
            <circle cx={x(px)} cy={Math.min(PAD.top + cH, Math.max(PAD.top, y(atPx)))} r="5" fill={C.blue} stroke={C.bg} strokeWidth="2" />
          </g>
        )}
        {hover && (
          <g data-testid="cursor">
            <line x1={x(hoverPx)} x2={x(hoverPx)} y1={PAD.top} y2={PAD.top + cH} stroke={C.grey} strokeWidth="0.8" strokeDasharray="3 3" />
            <circle cx={x(hoverPx)} cy={y(hover.sel)} r="3.5" fill={C.blue} />
            {(() => {
              const bx = x(hoverPx) < W - PAD.right - 200 ? x(hoverPx) + 10 : x(hoverPx) - 200;
              const rows = [[`${label}`, hover.sel, C.blue], hover.exp != null ? ['expiry', hover.exp, C.soft] : null, hover.now != null ? [intraday ? 'now' : 'today', hover.now, C.purple] : null].filter(Boolean);
              return (
                <g>
                  <rect x={bx} y={PAD.top + 6} width="190" height={22 + rows.length * 17} rx="8" fill="var(--c-161b22)" stroke={C.line} opacity="0.96" />
                  <text x={bx + 10} y={PAD.top + 23} fontSize={fs(11.5)} fontWeight="700" fill={C.text} fontFamily={MONO}>at {px2(hoverPx)}</text>
                  {rows.map(([k, v, col], i) => (
                    <text key={k} x={bx + 10} y={PAD.top + 40 + i * 17} fontSize={fs(11)} fill={col} fontFamily={MONO}>{k}  {signed(v)}</text>
                  ))}
                </g>
              );
            })()}
          </g>
        )}
        {/* probability of where price is at the evaluated moment */}
        {sigPts > 0 && (() => {
          const n = 120, base = BELL_TOP + BELL_H;
          const pts = [];
          for (let i = 0; i <= n; i++) { const p = lo + (hi - lo) * i / n; const z = (p - px) / sigPts; pts.push(`${x(p).toFixed(1)},${(base - BELL_H * Math.exp(-z * z / 2)).toFixed(1)}`); }
          return (
            <g data-testid="prob-bell">
              <polyline points={`${x(lo)},${base} ${pts.join(' ')} ${x(hi)},${base}`} fill={C.blue} fillOpacity="0.12" stroke={C.blue} strokeWidth="1.1" />
              {[-2, -1, 1, 2].map(k => {
                const kx = x(px + k * sigPts);
                return kx > PAD.left && kx < W - PAD.right ? (
                  <g key={k}><line x1={kx} x2={kx} y1={BELL_TOP} y2={base} stroke={C.blue} strokeWidth="0.8" opacity="0.5" />
                    <text x={kx} y={BELL_TOP - 1} textAnchor="middle" fontSize={fs(9.5)} fill={C.grey} fontFamily={MONO}>{k > 0 ? '+' : '−'}{Math.abs(k)}σ</text></g>
                ) : null;
              })}
            </g>
          );
        })()}
        {/* strike blocks */}
        {blocks.map(b => (
          <g key={`${b.strike}${b.right}`} data-testid="strike-block" data-side={b.net < 0 ? 'short' : 'long'}
            {...(onStrikeChange ? { role: 'slider', tabIndex: 0, 'aria-label': `${b.net < 0 ? 'Short' : 'Long'} ${b.strike} ${b.right === 'P' ? 'put' : 'call'} — drag or use the arrow keys to move it`,
              'aria-valuenow': b.strike, onPointerDown: e => startDrag(b, e), onKeyDown: e => onBlockKey(b, e), style: { cursor: 'ew-resize', outline: 'none' } } : {})}>
            <rect x={b.x - 24} y={STRIKE_Y + b.row * 19} width="48" height="16" rx="5" fill={b.net < 0 ? C.red : C.green} opacity="0.9"
              stroke={moving && b.strike === drag.to && b.right === drag.right ? C.text : 'none'} strokeWidth="1.5" />
            <text x={b.x} y={STRIKE_Y + b.row * 19 + 12} textAnchor="middle" fontSize={fs(10)} fontWeight="700" fill="#ffffff" fontFamily={MONO}>
              {b.net < 0 ? '−' : '+'}{Math.abs(b.net) > 1 ? Math.abs(b.net) + '×' : ''}{b.strike}{b.right}</text>
          </g>
        ))}
        {xTicks.map(v => (
          <text key={'x' + v} x={x(v)} y={AXIS_Y} textAnchor="middle" fontSize={fs(10.5)} fill={C.grey} fontFamily={MONO}>{Math.round(v)}</text>
        ))}
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11.5, color: C.grey, margin: '4px 0 10px', alignItems: 'center' }}>
        <span><span style={{ color: C.blue }}>━</span> {label}</span>
        {curves.now && <span><span style={{ color: C.purple }}>┈</span> {intraday ? 'Now' : 'Today'}</span>}
        {curves.exp && <span><span style={{ color: C.soft }}>─</span> {isTimeSpread ? 'Near expiry' : 'Expiry'}</span>}
        {bandPath && <span><span style={{ color: C.blue }}>▆</span> IV ±{band} pts</span>}
        {sigPts > 0 && <span><span style={{ color: C.blue, opacity: 0.6 }}>▮</span> ±1σ / ±2σ to {intraday ? etAt(d, nearDte) : 'this date'}</span>}
        <span data-testid="price-source" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          {livePx ? <FreshDot state={fresh} ts={q && q.ts} /> : <span style={{ color: C.text }}>┃</span>}
          {livePx ? `Live ${px2(livePx)}` : `Spot ${px2(spot)}`}
        </span>
        {ivShift !== 0 && <span style={{ color: C.amber }}>IV {ivShift > 0 ? '+' : '−'}{Math.abs(ivShift)} pts on every leg</span>}
        {ghostCurve && <span data-testid="ghost-legend"><span style={{ color: C.text, opacity: 0.6 }}>╌</span> {ghostIn.label}</span>}
        {onStrikeChange && !drag && <span style={{ color: C.dim }}>drag a strike to move it</span>}
      </div>

      {hero ? (
        <div data-testid="payoff-facts" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', textAlign: 'center', gap: 8, margin: '6px 0 12px' }}>
          {[
            [bes.length ? (bes.length > 1 ? bes.map(b => Math.round(b).toLocaleString()).join(' · ') : px2(bes[0])) : 'none', bes.length > 1 ? 'Break-evens' : 'Break-even', '#ffffff'],
            [sigPts > 0 ? `±${Math.round(sigPts)} pts` : '—', `1σ to ${intraday ? (d > 0 ? etAt(d, nearDte) : 'now') : (d > 0 ? fmtExpiry(dateYmd) : 'today')}`, '#ffffff'],
            [pop == null ? '—' : Math.round(pop * 100) + '%', 'Win chance', '#7ee2a0'],
            [money(sel.maxLoss), 'Max loss', '#ffa39a'],
          ].map(([v, k, col]) => (
            <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <span className="num" style={{ fontSize: bes.length > 1 && k.startsWith('Break') ? 17 : 22, fontWeight: 600, color: col, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v}</span>
              <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.8)' }}>{k}</span>
            </div>
          ))}
        </div>
      ) : (
      <div data-testid="payoff-facts" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', borderTop: `1px solid ${C.line2}`, borderBottom: `1px solid ${C.line2}`, marginBottom: 10 }}>
        <Fact k={`P&L ${intraday ? 'at ' + label : 'on ' + label}`} v={signed(atPx)} c={atPx >= 0 ? C.green : C.red} sub={`at ${livePx ? 'live' : 'spot'} ${px2(px)}`} />
        {d > 0 && <Fact k={intraday ? 'P&L now' : 'P&L today'} v={signed(nowPx)} c={nowPx >= 0 ? C.green : C.red} sub="mark-to-model" />}
        <Fact k="Win chance" v={pop == null ? '—' : (pop * 100).toFixed(0) + '%'} c={C.text} sub={`P(profit) ${intraday ? 'at ' + label : 'on this date'}`} />
        <Fact k={bes.length > 1 ? 'Break-evens' : 'Break-even'} v={bes.length ? bes.map(b => px2(b)).join(' · ') : 'none'} c={C.amber} />
        <Fact k="Max profit" v={money(sel.maxProfit)} c={C.green} sub="in this window" />
        <Fact k="Max loss" v={money(sel.maxLoss)} c={C.red} sub="in this window" />
      </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ fontSize: 13 }}>
        <Row k={`${label} · ${fmtExpiry(dateYmd)}`} v={intraday ? (d >= nearDte ? 'expiry' : `${Math.max(0, hoursOf(left)).toFixed(1)} h to the bell`) : (d >= nearDte ? 'expiry' : `${Math.round(left)} DTE left`)} />
        {(target && target.dollars > 0) ? (() => {
          const tgt = target.dollars, bandT = targetBand(sel, tgt);
          return <Row k={`Target ${money(tgt)} ${intraday ? 'at ' + label : 'on this date'}`} c={bandT ? C.green : C.amber}
            v={bandT ? `${Math.round(bandT[0])}–${Math.round(bandT[1])}` : `not reachable (best ${money(sel.maxProfit)})`} />;
        })() : null}
      </div>

      {exitSim && (
        <div data-testid="exit-sim" style={{ marginTop: 10, padding: '8px 10px', borderRadius: 8, background: C.bg, border: `1px solid ${C.line2}`, fontSize: 12.5, color: 'var(--c-c9d1d9)', lineHeight: 1.55 }}>
          <b style={{ color: C.text }}>Managed trade</b> — {exitSim.paths.toLocaleString()} simulated paths, each closed at the
          {target && target.dollars > 0 ? ` ${money(target.dollars)} target` : ' target'} or at {closeDte} DTE:
          {' '}POP <b style={{ color: C.text }}>{(exitSim.pop * 100).toFixed(0)}%</b>
          {target && target.dollars > 0 && <> · target hit <b style={{ color: C.text }}>{(exitSim.pTarget * 100).toFixed(0)}%</b></>}
          {' '}· avg win <span style={{ color: C.green }}>{money(exitSim.avgWin)}</span>
          {' '}· avg loss <span style={{ color: C.red }}>{money(-exitSim.avgLoss)}</span>
          {' '}· EV <b style={{ color: exitSim.ev >= 0 ? C.green : C.red }}>{money(exitSim.ev)}</b>
          <div style={{ color: C.grey, fontSize: 11.5 }}>
            Price moves at the near leg's IV ({(sigmaNear * 100).toFixed(1)}%) and every leg keeps its IV — a calendar's edge from back-month IV rising, or IV crush on the front, is not in this number.
          </div>
        </div>
      )}
      {!intraday && nearDte <= closeDte && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: C.amber }}>
          ⚠ The near expiry is {nearDte} days out — already inside the {closeDte}-DTE close. By the playbook this trade closes now.
        </div>
      )}
      {!intraday && isTimeSpread && nearDte > closeDte && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: C.soft }}>
          A time spread makes most of its money in the last weeks of the near leg. Closed at {closeDte} DTE it banks the
          {' '}{money(curveAt(cl, { net, lo, hi, days: closeDay }).maxProfit)} peak shown, not the
          {' '}{money(curveAt(cl, { net, lo, hi, days: nearDte }).maxProfit)} at near expiry.
        </div>
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontSize: 12, color: C.grey, cursor: 'pointer' }}>How this chart is drawn</summary>
        <div style={{ marginTop: 6, fontSize: 11.5, color: C.grey, lineHeight: 1.5 }}>
          Black-Scholes per leg at its own expiry and IV ({cl.map(l => `${l.sign < 0 ? 'S' : 'L'} ${l.strike}${l.right} ${intraday ? hoursOf(l.dte).toFixed(1) + 'h' : (Number.isInteger(l.dte) ? l.dte : l.dte.toFixed(1)) + 'd'} ${(l.iv * 100).toFixed(1)}%`).join(' · ')}),
          {' '}rate {(RATE * 100).toFixed(1)}%, div {((divYield || 0) * 100).toFixed(1)}%, IVs held constant{ivShift ? ` and shifted ${ivShift > 0 ? '+' : '−'}${Math.abs(ivShift)} pts` : ''}.
          {' '}Entry {netSource === 'ticket' ? `at the ticket's net ${net >= 0 ? 'credit' : 'debit'} ${Math.abs(net).toFixed(2)}` : `at model fair ${Math.abs(net).toFixed(2)} ${net >= 0 ? 'credit' : 'debit'} — enter the fill to anchor it`}.
          {' '}Win chance is lognormal at {(sigmaNear * 100).toFixed(1)}% IV; the bands and the bell use the same IV over the time from now to the moment shown{intraday ? ', counted in trading time (6.5 h × 252 days a year)' : ''}.
          {' '}{scopeNote || 'Per contract.'}
        </div>
      </details>
    </div>
  );
}

// Price band where the curve is at or above the target (outermost crossings).
function targetBand(curve, tgt) {
  const ok = curve.points.filter(p => p.pnl >= tgt);
  if (!ok.length) return null;
  return [ok[0].price, ok[ok.length - 1].price];
}

function Fact({ k, v, c, sub }) {
  return (
    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey }}>{k}</span>
      <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: c }}>{v}</span>
      {sub ? <span style={{ fontSize: 11.5, color: C.grey }}>{sub}</span> : null}
    </div>
  );
}

function Row({ k, v, c }) {
  return (
    <div className="flex justify-between py-1 border-b border-[var(--c-21262d)]">
      <span style={{ color: C.soft }}>{k}</span>
      <span className="mono" style={{ color: c || C.text, fontWeight: 600 }}>{v}</span>
    </div>
  );
}
