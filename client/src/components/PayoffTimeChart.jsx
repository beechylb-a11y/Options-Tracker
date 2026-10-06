// ================================================================
//  PAYOFF OVER TIME — 45DTE (Oct 2026)
//  TWS-style performance graph: today (dotted), any chosen date (solid, with a
//  ±vol band), and expiry for reference. Opens on the 21-DTE hard close, because
//  that is the curve a 45DTE trade actually realises — expiry is never reached.
//  Calendars and diagonals work too: each leg is valued at its own expiry.
// ================================================================
import React, { useMemo, useState, useEffect } from 'react';
import { curveAt, probProfit, pnlAt, HARD_CLOSE_DTE, RATE } from '../engine/payoffCurve';
import { addDaysYmd, fmtExpiry } from '../utils/expiries';

const W = 520, H = 250, PAD = { top: 14, right: 14, bottom: 30, left: 56 };
const money = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString();
const kfmt = v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'K' : String(Math.round(v));

export default function PayoffTimeChart({ cl, net, netSource, spot, lo, hi, sigmaNear, nearDte, closeDay,
  todayYmd, isTimeSpread, underlying, divYield, closeDte = HARD_CLOSE_DTE, target, closeOptions, closeLeg, onCloseDte }) {
  // target: { dollars, label } — the strategy's profit target per contract (EXIT_RULES).
  const [day, setDay] = useState(closeDay);
  const [band, setBand] = useState(2);
  const [hoverPx, setHoverPx] = useState(null);
  // A new structure or expiry moves the close day; follow it unless the user has
  // moved the slider somewhere still valid.
  useEffect(() => { setDay(closeDay); }, [closeDay, nearDte]);
  const d = Math.min(Math.max(0, day), nearDte);
  const maxLegDte = Math.max(...cl.map(l => l.dte));

  const curves = useMemo(() => {
    const opts = { net, lo, hi };
    const sel = curveAt(cl, { ...opts, days: d });
    const today = d === 0 ? null : curveAt(cl, { ...opts, days: 0 });
    const exp = d === nearDte ? null : curveAt(cl, { ...opts, days: nearDte });
    const hasTime = d < maxLegDte && band > 0;
    const up = hasTime ? curveAt(cl, { ...opts, days: d, volShift: band }) : null;
    const dn = hasTime ? curveAt(cl, { ...opts, days: d, volShift: -band }) : null;
    return { sel, today, exp, up, dn };
  }, [cl, net, lo, hi, d, nearDte, band, maxLegDte]);

  const all = [curves.sel, curves.today, curves.exp, curves.up, curves.dn].filter(Boolean);
  const tgt = target && target.dollars > 0 ? target.dollars : null;
  const pnls = all.flatMap(c => c.points.map(p => p.pnl)).concat(tgt != null ? [tgt] : []);
  const minPnl = Math.min(0, ...pnls), maxPnl = Math.max(0, ...pnls);
  const range = (maxPnl - minPnl) || 1;
  const cW = W - PAD.left - PAD.right, cH = H - PAD.top - PAD.bottom;
  const x = p => PAD.left + (p - lo) / (hi - lo) * cW;
  const y = v => PAD.top + cH - (v - minPnl) / range * cH;
  const path = c => c.points.map((p, i) => (i ? 'L' : 'M') + x(p.price).toFixed(1) + ',' + y(p.pnl).toFixed(1)).join('');
  const zeroY = y(0);
  const bandPath = curves.up && curves.dn
    ? path(curves.up) + curves.dn.points.slice().reverse().map(p => 'L' + x(p.price).toFixed(1) + ',' + y(p.pnl).toFixed(1)).join('') + 'Z'
    : null;
  const selArea = path(curves.sel) + `L${x(hi).toFixed(1)},${zeroY.toFixed(1)}L${x(lo).toFixed(1)},${zeroY.toFixed(1)}Z`;

  // y ticks: 4-5 round steps
  const step = (() => { const raw = range / 4; const m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(k => k * m).find(s => s >= raw) || raw; })();
  const yTicks = []; for (let v = Math.ceil(minPnl / step) * step; v <= maxPnl + 1e-9; v += step) yTicks.push(v);
  const xStep = (() => { const raw = (hi - lo) / 6; const m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(k => k * m).find(s => s >= raw) || raw; })();
  const xTicks = []; for (let v = Math.ceil(lo / xStep) * xStep; v <= hi; v += xStep) xTicks.push(v);

  const sel = curves.sel;
  const pop = probProfit(sel, spot, sigmaNear, d);
  const atSpot = pnlAt(cl, spot, net, d);
  const dateYmd = addDaysYmd(todayYmd, d);
  const left = nearDte - d;
  const isClose = d === closeDay && nearDte > closeDte;
  const label = d === 0 ? 'Today' : d === nearDte ? (isTimeSpread ? 'Near expiry' : 'Expiry') : isClose ? `${closeDte}-DTE close` : 'Chosen date';
  const hoverVals = hoverPx != null ? {
    sel: pnlAt(cl, hoverPx, net, d),
    today: d === 0 ? null : pnlAt(cl, hoverPx, net, 0),
  } : null;

  const onMove = e => {
    const svg = e.currentTarget; const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width * W;
    if (px < PAD.left || px > W - PAD.right) { setHoverPx(null); return; }
    setHoverPx(lo + (px - PAD.left) / cW * (hi - lo));
  };

  const btn = on => ({ padding: '3px 10px', borderRadius: 6, fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
    border: '1px solid ' + (on ? '#2f81f7' : '#30363d'), background: on ? '#0d1a2b' : 'transparent', color: on ? '#58a6ff' : '#c9d1d9' });
  const closeLabel = nearDte > closeDte ? `${closeDte}-DTE close · ${fmtExpiry(addDaysYmd(todayYmd, closeDay))}` : `Close now (inside ${closeDte} DTE)`;

  return (
    <div data-testid="payoff-time-chart">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" style={btn(d === 0)} onClick={() => setDay(0)}>Today</button>
        <button type="button" style={btn(d === closeDay)} onClick={() => setDay(closeDay)}>{closeLabel}</button>
        <button type="button" style={btn(d === nearDte)} onClick={() => setDay(nearDte)}>
          {isTimeSpread ? 'Near expiry' : 'Expiry'} · {fmtExpiry(addDaysYmd(todayYmd, nearDte))}</button>
        {Array.isArray(closeOptions) && onCloseDte && (
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 12, color: '#a8b2be' }} data-testid="close-dte-toggle">
            Close at
            {closeOptions.map(c => (
              <button key={c} type="button" onClick={() => onCloseDte(c)} style={btn(closeDte === c)}>
                {c} DTE{c === closeOptions[0] && closeLeg ? ` (${closeLeg})` : ''}
              </button>
            ))}
          </span>
        )}
        <label style={{ marginLeft: 'auto', fontSize: 12, color: '#a8b2be', display: 'flex', alignItems: 'center', gap: 6 }}>
          Vol band ±
          <select value={band} onChange={e => setBand(+e.target.value)}
            style={{ background: '#0d1117', color: '#e6edf3', border: '1px solid #30363d', borderRadius: 6, fontSize: 12, padding: '2px 4px' }}>
            {[0, 1, 2, 3, 5].map(v => <option key={v} value={v}>{v} pt</option>)}
          </select>
        </label>
      </div>
      <input type="range" min={0} max={nearDte} step={1} value={d} onChange={e => setDay(+e.target.value)}
        aria-label="Days from today" style={{ width: '100%', accentColor: '#58a6ff' }} />
      <div style={{ position: 'relative', fontSize: 11, color: '#8b949e', height: 14, marginBottom: 4 }}>
        <span style={{ position: 'absolute', left: 0 }}>today</span>
        {nearDte > closeDte && (
          <span style={{ position: 'absolute', left: `${closeDay / nearDte * 100}%`, transform: 'translateX(-50%)', color: '#d29922' }}>▲ {closeDte} DTE</span>
        )}
        <span style={{ position: 'absolute', right: 0 }}>{isTimeSpread ? 'near exp' : 'expiry'}</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', touchAction: 'none' }}
        onMouseMove={onMove} onMouseLeave={() => setHoverPx(null)} role="img"
        aria-label={`P&L at ${label}: max ${money(sel.maxProfit)}, breakevens ${sel.breakevens.join(', ') || 'none'}`}>
        <defs>
          <clipPath id="ptc-above"><rect x={PAD.left} y={PAD.top} width={cW} height={Math.max(0, zeroY - PAD.top)} /></clipPath>
          <clipPath id="ptc-below"><rect x={PAD.left} y={zeroY} width={cW} height={Math.max(0, PAD.top + cH - zeroY)} /></clipPath>
        </defs>
        {yTicks.map(v => (
          <g key={'y' + v}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke={v === 0 ? '#6e7681' : '#21262d'} strokeWidth={v === 0 ? 1 : 0.6} />
            <text x={PAD.left - 6} y={y(v) + 3.5} textAnchor="end" fontSize="10.5" fill="#8b949e" fontFamily="JetBrains Mono,monospace">{kfmt(v)}</text>
          </g>
        ))}
        {xTicks.map(v => (
          <text key={'x' + v} x={x(v)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="#8b949e" fontFamily="JetBrains Mono,monospace">{Math.round(v)}</text>
        ))}
        <path d={selArea} fill="rgba(63,185,80,0.14)" clipPath="url(#ptc-above)" />
        <path d={selArea} fill="rgba(248,81,73,0.12)" clipPath="url(#ptc-below)" />
        {bandPath && <path d={bandPath} fill="rgba(88,166,255,0.16)" stroke="none" />}
        {curves.exp && <path d={path(curves.exp)} fill="none" stroke="#6e7681" strokeWidth="1.2" strokeDasharray="5 4" />}
        {tgt != null && (
          <g>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(tgt)} y2={y(tgt)} stroke="#3fb950" strokeWidth="1" strokeDasharray="6 3" />
            <text x={W - PAD.right - 2} y={y(tgt) - 4} textAnchor="end" fontSize="10.5" fill="#3fb950" fontFamily="JetBrains Mono,monospace">target {money(tgt)}</text>
          </g>
        )}
        {curves.today && <path d={path(curves.today)} fill="none" stroke="#a8b2be" strokeWidth="1.6" strokeDasharray="1.5 4" strokeLinecap="round" />}
        <path d={path(sel)} fill="none" stroke="#e6edf3" strokeWidth="2" />
        {spot > 0 && spot >= lo && spot <= hi && (
          <line x1={x(spot)} x2={x(spot)} y1={PAD.top} y2={PAD.top + cH} stroke="#2f81f7" strokeWidth="1" strokeDasharray="4 3" />
        )}
        {sel.breakevens.map(b => <circle key={b} cx={x(b)} cy={zeroY} r="3.5" fill="#d29922" />)}
        {hoverPx != null && (
          <g>
            <line x1={x(hoverPx)} x2={x(hoverPx)} y1={PAD.top} y2={PAD.top + cH} stroke="#8b949e" strokeWidth="0.8" />
            <circle cx={x(hoverPx)} cy={y(hoverVals.sel)} r="3" fill="#e6edf3" />
            <text x={Math.min(x(hoverPx) + 6, W - PAD.right - 120)} y={PAD.top + 12} fontSize="11" fill="#e6edf3" fontFamily="JetBrains Mono,monospace">
              {Math.round(hoverPx)}: {money(hoverVals.sel)}{hoverVals.today != null ? `  (today ${money(hoverVals.today)})` : ''}
            </text>
          </g>
        )}
      </svg>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11.5, color: '#8b949e', margin: '4px 0 10px' }}>
        <span><span style={{ color: '#e6edf3' }}>━</span> {label}</span>
        {curves.today && <span><span style={{ color: '#a8b2be' }}>┈</span> Today</span>}
        {curves.exp && <span><span style={{ color: '#6e7681' }}>╌</span> {isTimeSpread ? 'Near expiry' : 'Expiry'}</span>}
        {bandPath && <span><span style={{ color: '#58a6ff' }}>▆</span> IV ±{band} pts</span>}
        <span><span style={{ color: '#2f81f7' }}>┆</span> Spot</span>
        {tgt != null && <span><span style={{ color: '#3fb950' }}>╌</span> Target{target.label ? ` (${target.label})` : ''}</span>}
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1" style={{ fontSize: 13 }}>
        <Row k={`${label} · ${fmtExpiry(dateYmd)}`} v={d === nearDte ? 'expiry' : `${left} DTE left`} />
        <Row k="P&L at spot" v={money(atSpot)} c={atSpot >= 0 ? '#3fb950' : '#f85149'} />
        <Row k="Max profit (window)" v={money(sel.maxProfit)} c="#3fb950" />
        <Row k="Max loss (window)" v={money(sel.maxLoss)} c="#f85149" />
        <Row k="Breakevens" v={sel.breakevens.length ? sel.breakevens.map(Math.round).join(' / ') : 'none'} />
        <Row k="P(profit) on this date" v={pop == null ? '—' : (pop * 100).toFixed(0) + '%'} />
        {tgt != null && (() => {
          const band = targetBand(sel, tgt);
          return <Row k={`Target ${money(tgt)} on this date`} c={band ? '#3fb950' : '#d29922'}
            v={band ? `${Math.round(band[0])}–${Math.round(band[1])}` : `not reachable (best ${money(sel.maxProfit)})`} />;
        })()}
      </div>

      {nearDte <= closeDte && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#d29922' }}>
          ⚠ The near expiry is {nearDte} days out — already inside the {closeDte}-DTE close. By the playbook this trade closes now.
        </div>
      )}
      {isTimeSpread && nearDte > closeDte && (
        <div style={{ marginTop: 8, fontSize: 12.5, color: '#a8b2be' }}>
          A time spread makes most of its money in the last weeks of the near leg. Closed at {closeDte} DTE it banks the
          {' '}{money(curveAt(cl, { net, lo, hi, days: closeDay }).maxProfit)} peak shown, not the
          {' '}{money(curveAt(cl, { net, lo, hi, days: nearDte }).maxProfit)} at near expiry.
        </div>
      )}
      <div style={{ marginTop: 8, fontSize: 11.5, color: '#8b949e', lineHeight: 1.5 }}>
        Black-Scholes per leg at its own expiry and IV ({cl.map(l => `${l.sign < 0 ? 'S' : 'L'} ${l.strike}${l.right} ${l.dte}d ${(l.iv * 100).toFixed(1)}%`).join(' · ')}),
        {' '}rate {(RATE * 100).toFixed(1)}%, div {((divYield || 0) * 100).toFixed(1)}%, IVs held constant.
        {' '}Entry {netSource === 'ticket' ? `at the ticket's net ${net >= 0 ? 'credit' : 'debit'} ${Math.abs(net).toFixed(2)}` : `at model fair ${Math.abs(net).toFixed(2)} ${net >= 0 ? 'credit' : 'debit'} — enter the fill to anchor it`}.
        {' '}P(profit) is lognormal at {(sigmaNear * 100).toFixed(1)}% IV.
      </div>
    </div>
  );
}

// Price band where the curve is at or above the target (outermost crossings).
function targetBand(curve, tgt) {
  const ok = curve.points.filter(p => p.pnl >= tgt);
  if (!ok.length) return null;
  return [ok[0].price, ok[ok.length - 1].price];
}

function Row({ k, v, c }) {
  return (
    <div className="flex justify-between py-1 border-b border-[#21262d]">
      <span style={{ color: '#a8b2be' }}>{k}</span>
      <span className="mono" style={{ color: c || '#e6edf3', fontWeight: 600 }}>{v}</span>
    </div>
  );
}
