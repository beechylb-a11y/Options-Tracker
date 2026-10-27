// ── Check-up card, visual first (Oct 2026) ──
//
// The card read as a page of prose: two stops, two P&Ls, a plan chart whose labels
// sat on each other, and the one thing the decision is about — where price sits
// against the strikes — near the bottom. This is the top of the card now:
//
//   verdict badge · whole-position P&L
//   three gauges   P&L between stop and target · cushion to the nearest short · clock
//   price map      the position's payoff at expiry, strikes, price, and the range price
//                  is likely to cover before the time stop
//   triggers       the prices and the date that change the call
//   ≤ 3 reasons    as icons
//
// Everything is the WHOLE position (banked rolls included) unless a label says ticket.
// The old charts and text stay one click away under Details.

import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, RefreshCw, Target, Clock, Zap, Crosshair,
  TrendingUp, TrendingDown, Activity, ArrowRight, Eye, CircleDollarSign } from 'lucide-react';
import { positionStrip, valueAt } from '../engine/positionPlan';

export const C = { green: '#3fb950', red: '#f85149', amber: '#e3b341', blue: '#58a6ff', grey: '#8b949e', text: '#e6edf3', dim: '#6e7681', line: '#30363d', bg: '#0d1117', panel: '#161b22' };
const money = v => v == null || !isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtYmd = y => (y && String(y).length === 8 ? `${+String(y).slice(6, 8)} ${MON[+String(y).slice(4, 6) - 1]}` : '—');
const px = v => (Math.abs(v) >= 1000 ? v.toFixed(0) : v >= 100 ? v.toFixed(1) : v.toFixed(2));

const ACTION_ICON = {
  'take-profit': CircleDollarSign, hold: CheckCircle2, watch: Eye, 'roll-untested': RefreshCw, 'roll-out': RefreshCw,
  'roll-short': RefreshCw, close: XCircle, 'close-or-roll': AlertTriangle, unknown: AlertTriangle,
};
const TONE_FG = { green: C.green, amber: C.amber, red: C.red, grey: '#a8b2be' };

export function ActionBadge({ action, tone, label }) {
  const Icon = ACTION_ICON[action] || AlertTriangle;
  const fg = TONE_FG[tone] || TONE_FG.grey;
  return (
    <span data-testid="checkup-action" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 8,
      fontWeight: 800, fontSize: 14, letterSpacing: '.03em', textTransform: 'uppercase', color: fg,
      background: fg + '1f', border: `1.5px solid ${fg}` }}>
      <Icon size={17} strokeWidth={2.5} />{label}
    </span>
  );
}

/** ● 8 Oct ─ +$447 ─● 15 Oct ─ +$634 ─● 23 Oct ─ now */
export function RollTimeline({ chain, entryYmd }) {
  if (!chain) return null;
  const nodes = chain.links.map(l => ({ y: l.entryYmd, gain: l.realised, title: `${l.strikes || 'TICKET-' + l.ref} · rolled ${fmtYmd(l.closeYmd)}` }));
  return (
    <div data-testid="roll-history" className="mono" style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: C.grey, marginTop: 4, flexWrap: 'wrap' }}>
      {nodes.map((n, i) => (
        <React.Fragment key={i}>
          <span title={n.title} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.grey, display: 'inline-block' }} />{fmtYmd(n.y)}
          </span>
          <span style={{ color: n.gain >= 0 ? C.green : C.red }}>─ rolled {fmtYmd(chain.links[i].closeYmd)} {money(n.gain)} ─</span>
        </React.Fragment>
      ))}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.text }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.blue, display: 'inline-block' }} />{fmtYmd(entryYmd)} → now
      </span>
    </div>
  );
}

function Gauge({ icon: Icon, title, children, testid }) {
  return (
    <div data-testid={testid} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '10px 12px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey, marginBottom: 6 }}>
        <Icon size={13} />{title}
      </div>
      {children}
    </div>
  );
}

/**
 * P&L between stop and target, whole position. When the ticket was rolled, the bar is
 * built up the way the trade went: one row per earlier ticket (what it banked when it was
 * rolled, green gain / red loss, with the roll trade's own net credit or debit as a pill),
 * then the open ticket, then the position — every row on the same scale, so each segment
 * starts where the last one ended and the dot lands at the end of the last.
 *
 *   ↻ 15 Oct  CR 0.89  ─────■■■■■            +$447
 *   ↻ 23 Oct  CR 1.54           ■■■■■■■      +$634
 *   ● open             ■■■■■■■■■■■■■■■■      −$1,165
 *   position  stop ◀──────●────┊plan──▶ target  −$84
 */
export function PnlMeter({ now, stop, target, plan, steps }) {
  const [boxRef, boxW] = useWidth();
  if (now == null) return <Gauge icon={Target} title="P&L" testid="gauge-pnl"><div style={{ color: C.grey, fontSize: 13 }}>no live mark</div></Gauge>;
  const rows = [];
  let cum = 0;
  for (const st of steps || []) {
    if (st.v == null || !isFinite(st.v)) continue;
    rows.push({ ...st, from: cum, to: cum + st.v });
    cum += st.v;
  }
  const xs = [stop ?? now, target ?? now, now, 0, plan ?? 0, ...rows.flatMap(r => [r.from, r.to])];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const P = v => ((v - lo) / Math.max(1, hi - lo)) * 100;
  const col = now >= 0 ? C.green : C.red;
  const wide = rows.length > 1;
  const zero = <div title="$0" style={{ position: 'absolute', left: `${P(0)}%`, top: -3, bottom: -3, width: 1.5, background: C.text, opacity: 0.35, marginLeft: -0.75 }} />;
  const bar = (
    <div style={{ position: 'relative', height: 18 }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 6, borderRadius: 3,
        background: `linear-gradient(90deg, ${C.red} 0%, ${C.red}55 ${P(0)}%, ${C.green}55 ${P(0)}%, ${C.green} 100%)` }} />
      <div title="$0" style={{ position: 'absolute', left: `${P(0)}%`, top: 1, width: 2, height: 16, background: C.text, opacity: 0.6, marginLeft: -1 }} />
      {plan != null && <div title={`plan ${money(plan)} — time decay alone`} style={{ position: 'absolute', left: `${P(plan)}%`, top: -2, marginLeft: -5,
        width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: `7px solid ${C.blue}` }} />}
      <div style={{ position: 'absolute', left: `${P(now)}%`, top: 2, width: 14, height: 14, marginLeft: -7, borderRadius: '50%',
        background: col, border: `2px solid ${C.bg}`, boxShadow: `0 0 0 2px ${col}55` }} />
    </div>
  );
  const ends = (
    <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4, gap: 10, flexWrap: 'wrap' }}>
      <span style={{ color: C.red }}>{stop != null ? `stop ${money(stop)}` : ''}</span>
      {plan != null && <span style={{ color: C.blue }}>▾ plan {money(plan)}</span>}
      <span style={{ color: C.green }}>{target != null ? `target ${money(target)}` : ''}</span>
    </div>
  );
  if (!wide) {
    return (
      <Gauge icon={Target} title="P&L · stop → target" testid="gauge-pnl">
        <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: col, lineHeight: 1 }}>{money(now)}</div>
        <div style={{ marginTop: 10 }}>{bar}</div>
        {ends}
      </Gauge>
    );
  }
  // Wide: label · pill · track · amount on one row. Narrow (phone): label, pill and
  // amount on a line, the track full width under it — a 40px track says nothing.
  const narrow = boxW != null && boxW < 560;
  const grid = { display: 'grid', gridTemplateColumns: '74px 62px minmax(0,1fr) 70px', alignItems: 'center', columnGap: 10 };
  const Label = ({ r }) => (
    <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12.5, fontWeight: 700, color: r.kind === 'open' ? C.text : C.grey }}>
      {r.kind === 'open' ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.blue, display: 'inline-block' }} /> : <RefreshCw size={12} strokeWidth={2.6} />}
      {r.label}
    </span>
  );
  const Pill = ({ r }) => (r.net != null && isFinite(r.net) ? (
    <span data-testid="roll-net" title={r.netTitle || ''} className="mono" style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 5, fontSize: 11, fontWeight: 800,
      color: r.net >= 0 ? C.green : C.red, background: (r.net >= 0 ? C.green : C.red) + '22', border: `1px solid ${(r.net >= 0 ? C.green : C.red)}88` }}>
      {r.net >= 0 ? 'CR' : 'DR'} {Math.abs(r.net).toFixed(2)}
    </span>) : null);
  const Track = ({ r, i }) => {
    const c = r.v >= 0 ? C.green : C.red;
    const L = Math.min(P(r.from), P(r.to)), Wd = Math.max(1.2, Math.abs(P(r.to) - P(r.from)));
    return (
      <div style={{ position: 'relative', height: 12 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 5, height: 2, background: C.line, borderRadius: 1 }} />
        {zero}
        {i > 0 && <div style={{ position: 'absolute', left: `${P(r.from)}%`, top: -7, height: 7, borderLeft: `1px dashed ${C.dim}` }} />}
        <div style={{ position: 'absolute', left: `${L}%`, width: `${Wd}%`, top: 0, height: 12, borderRadius: 3, background: c, opacity: r.kind === 'open' ? 0.95 : 0.85 }} />
      </div>
    );
  };
  const Amt = ({ v, size = 13 }) => <span className="mono" style={{ textAlign: 'right', fontSize: size, fontWeight: 800, color: v >= 0 ? C.green : C.red }}>{money(v)}</span>;
  const posLabel = <span style={{ fontSize: 12, fontWeight: 800, color: C.text, textTransform: 'uppercase', letterSpacing: '.04em' }}>Position</span>;
  return (
    <div ref={boxRef} style={{ gridColumn: '1 / -1' }}>
      <Gauge icon={Target} title="P&L · how the position got here · stop → target" testid="gauge-pnl">
        <div data-testid="roll-history" style={{ display: 'grid', rowGap: narrow ? 6 : 7 }}>
          {rows.map((r, i) => narrow ? (
            <div key={i} title={r.title || ''} data-testid="pnl-step" style={{ display: 'grid', rowGap: 3 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Label r={r} /><Pill r={r} /><span style={{ marginLeft: 'auto' }}><Amt v={r.v} /></span></div>
              <Track r={r} i={i} />
            </div>
          ) : (
            <div key={i} style={grid} title={r.title || ''} data-testid="pnl-step">
              <Label r={r} /><span><Pill r={r} /></span><Track r={r} i={i} /><Amt v={r.v} />
            </div>
          ))}
          {narrow ? (
            <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8, marginTop: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center' }}>{posLabel}<span style={{ marginLeft: 'auto' }}><Amt v={now} size={18} /></span></div>
              <div style={{ marginTop: 4 }}>{bar}</div>
              {ends}
            </div>
          ) : (
            <>
              <div style={{ ...grid, borderTop: `1px solid ${C.line}`, paddingTop: 8, marginTop: 2 }}>
                {posLabel}<span /><div>{bar}</div><Amt v={now} size={18} />
              </div>
              <div style={grid}><span /><span /><div>{ends}</div><span /></div>
            </>
          )}
        </div>
      </Gauge>
    </div>
  );
}

/** Points to the nearest short, and the same in σ as five blocks. */
export function CushionGauge({ near }) {
  if (!near) return <Gauge icon={Crosshair} title="Cushion" testid="gauge-cushion"><div style={{ color: C.grey, fontSize: 13 }}>no short strike</div></Gauge>;
  const through = near.cushion < 0;
  const sd = near.cushionSd != null ? Math.abs(near.cushionSd) : null;
  const col = through || near.tested ? C.red : near.pressured ? C.amber : C.green;
  const blocks = Math.max(through || near.tested ? 1 : 0, sd == null ? 0 : [0.25, 0.5, 1, 1.5, 2].filter(t => sd >= t).length);
  return (
    <Gauge icon={Crosshair} title={`Cushion · ${near.strike}${near.right} short`} testid="gauge-cushion">
      <div className="mono" style={{ fontSize: 24, fontWeight: 800, color: col, lineHeight: 1 }}>
        {through ? '−' : ''}{Math.abs(near.cushion).toFixed(1)}<span style={{ fontSize: 13, fontWeight: 600, color: C.grey }}> pts {through ? 'through' : near.right === 'P' ? 'above' : 'below'}</span>
      </div>
      <div style={{ display: 'flex', gap: 3, marginTop: 10 }}>
        {[0, 1, 2, 3, 4].map(i => <div key={i} style={{ flex: 1, height: 8, borderRadius: 2, background: i < blocks ? col : '#21262d' }} />)}
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 4, color: C.grey }}>
        <span>{sd != null ? `${sd.toFixed(1)}σ` : ''}</span>
        <span>{near.absDelta != null ? `${Math.round(near.absDelta * 100)}Δ` : ''}{near.tested ? ' · tested' : near.pressured ? ' · pressured' : ''}</span>
      </div>
    </Gauge>
  );
}

/** Ring: share of the planned hold used; centre: days to the time stop; ⚡ events before it. */
export function ClockGauge({ daysHeld, planDays, daysToClose, closeYmd, events }) {
  const used = planDays ? Math.max(0, Math.min(1, (daysHeld || 0) / planDays)) : 0;
  const r = 20, c = 2 * Math.PI * r;
  const col = daysToClose <= 0 ? C.red : daysToClose <= 5 ? C.amber : C.blue;
  return (
    <Gauge icon={Clock} title="Time" testid="gauge-clock">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <svg width="54" height="54" viewBox="0 0 54 54" role="img" aria-label={`${daysToClose} days to the time stop`}>
          <circle cx="27" cy="27" r={r} fill="none" stroke="#21262d" strokeWidth="6" />
          <circle cx="27" cy="27" r={r} fill="none" stroke={col} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={`${c * used} ${c}`} transform="rotate(-90 27 27)" />
          <text x="27" y="31" textAnchor="middle" fontSize="13" fontWeight="800" fill={C.text} fontFamily="JetBrains Mono,monospace">{Math.max(0, daysToClose ?? 0)}d</text>
        </svg>
        <div style={{ fontSize: 12, color: C.grey, lineHeight: 1.5 }}>
          <div>close by <b className="mono" style={{ color: col }}>{fmtYmd(closeYmd)}</b></div>
          {events && events.length > 0 && (
            <div title={events.map(e => `${e.label} ${e.date}`).join(' · ')} style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.amber }}>
              <Zap size={12} />{events.slice(0, 2).map(e => shortEvent(e)).join(' · ')}{events.length > 2 ? ` +${events.length - 2}` : ''}
            </div>
          )}
        </div>
      </div>
    </Gauge>
  );
}
function shortEvent(e) {
  const l = String(e.label || '');
  const name = /FOMC/i.test(l) ? 'FOMC' : /CPI/.test(l) ? 'CPI' : /PCE/.test(l) ? 'PCE' : /payroll|Employment Sit/i.test(l) ? 'NFP'
    : /GDP/.test(l) ? 'GDP' : /PPI/.test(l) ? 'PPI' : l.split(/[ (]/)[0];
  const d = String(e.date || '');
  return `${name} ${d.length >= 10 ? `${+d.slice(8, 10)}/${+d.slice(5, 7)}` : d}`;
}

/**
 * The hero picture: the whole position's payoff at expiry (green above $0, red below),
 * the strikes, price, and the band price is likely to cover (±1σ) by the time stop.
 */
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(null);
  useEffect(() => {
    if (!ref.current) return undefined;
    const set = () => setW(ref.current ? ref.current.clientWidth : null);
    set();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(set);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function PriceMap(props) {
  const [ref, width] = useWidth();
  return <div ref={ref} data-testid="price-map" style={{ marginTop: 12, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 10, padding: '8px 0 2px' }}>
    <PriceMapSvg {...props} width={width ? width - 2 : null} />
  </div>;
}

function PriceMapSvg({ legs, spot, ncdPos, qty, shorts, sdStop, closeYmd, underlying, width }) {
  const strip = positionStrip({ legs, spot, ncd: ncdPos });
  if (!strip) return null;
  const q = Math.max(1, qty || 1);
  const lo = Math.min(strip.lo, sdStop ? spot - sdStop * 1.15 : strip.lo), hi = Math.max(strip.hi, sdStop ? spot + sdStop * 1.15 : strip.hi);
  // Drawn at the container's real width, so the labels stay readable on a phone
  // instead of shrinking with a fixed 1000-wide picture.
  const W = Math.max(300, width || 1000), H = 178, L = W < 600 ? 56 : 70, R = 14, top = 26, base = 122;
  const fs = W < 600 ? 11.5 : 13;
  const X = v => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const pnl = S => (valueAt(legs, S) + ncdPos) * 100 * q;
  const N = 240, pts = [];
  for (let i = 0; i <= N; i++) { const S = lo + (hi - lo) * i / N; pts.push([S, pnl(S)]); }
  const vMax = Math.max(1, ...pts.map(p => p[1])), vMin = Math.min(-1, ...pts.map(p => p[1]));
  const zeroY = top + (vMax / (vMax - vMin)) * (base - top);
  const Y = v => top + ((vMax - v) / (vMax - vMin)) * (base - top);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join(' ');
  const area = `${line} L${X(hi).toFixed(1)},${zeroY.toFixed(1)} L${X(lo).toFixed(1)},${zeroY.toFixed(1)} Z`;
  const nowPnl = pnl(spot);
  const uniq = [];
  legs.forEach(l => { if (!uniq.some(u => u.strike === l.strike && u.right === l.right)) uniq.push(l); });
  const shortOf = l => (shorts || []).find(s => s.strike === l.strike && s.right === l.right);
  const id = 'pm' + Math.round(spot * 100) + q;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block' }}
        aria-label={`${underlying} at ${spot}: position ${nowPnl >= 0 ? 'in profit' : 'at a loss'} at expiry at this price`}>
        <defs>
          <clipPath id={id + 'u'}><rect x="0" y="0" width={W} height={zeroY} /></clipPath>
          <clipPath id={id + 'd'}><rect x="0" y={zeroY} width={W} height={H} /></clipPath>
        </defs>
        {/* likely range by the time stop */}
        {sdStop > 0 && <>
          <rect x={X(spot - sdStop)} y={top - 14} width={X(spot + sdStop) - X(spot - sdStop)} height={base - top + 14} fill={C.blue} opacity="0.08" rx="4" />
          <text x={X(spot - sdStop) + 8} y={base - 8} fontSize={fs} fill={C.blue} textAnchor="start" opacity="0.95">↔ likely range to {fmtYmd(closeYmd)} (±1σ)</text>
        </>}
        {/* payoff at expiry */}
        <path d={area} fill={C.green} opacity="0.28" clipPath={`url(#${id}u)`} />
        <path d={area} fill={C.red} opacity="0.28" clipPath={`url(#${id}d)`} />
        <path d={line} fill="none" stroke={C.text} strokeWidth="2" opacity="0.75" />
        <line x1={L} x2={W - R} y1={zeroY} y2={zeroY} stroke="#484f58" strokeWidth="1" />
        <text x={L - 8} y={Y(vMax) + 5} fontSize={fs} fill={C.green} textAnchor="end" fontFamily="JetBrains Mono,monospace">{money(vMax)}</text>
        <text x={L - 8} y={zeroY + 5} fontSize={fs} fill={C.grey} textAnchor="end">$0</text>
        <text x={L - 8} y={Y(vMin) + 5} fontSize={fs} fill={C.red} textAnchor="end" fontFamily="JetBrains Mono,monospace">{money(vMin)}</text>
        {/* break-evens */}
        {strip.breakevens.map((b, i) => (
          <g key={'b' + i}>
            <circle cx={X(b.value)} cy={zeroY} r="4" fill={C.bg} stroke={C.green} strokeWidth="2" />
          </g>
        ))}
        {/* strikes on the axis */}
        <line x1={L} x2={W - R} y1={base + 18} y2={base + 18} stroke={C.line} strokeWidth="2" />
        {uniq.map((l, i) => {
          const s = shortOf(l);
          const col = l.qty < 0 ? (s && (s.tested || s.itm) ? C.red : s && s.pressured ? C.amber : '#f0883e') : C.blue;
          return (
            <g key={'k' + i}>
              <line x1={X(l.strike)} x2={X(l.strike)} y1={base + 10} y2={base + 26} stroke={col} strokeWidth={l.qty < 0 ? 4 : 3} />
              <text x={X(l.strike)} y={base + 44} fontSize={fs} fill={col} textAnchor="middle" fontFamily="JetBrains Mono,monospace" fontWeight={l.qty < 0 ? 700 : 400}>{l.strike}{l.right}</text>
            </g>
          );
        })}
        {/* price */}
        <line x1={X(spot)} x2={X(spot)} y1={top - 16} y2={base + 18} stroke={C.text} strokeWidth="1.5" strokeDasharray="3 3" />
        <circle cx={X(spot)} cy={Y(nowPnl)} r="7" fill={nowPnl >= 0 ? C.green : C.red} stroke={C.bg} strokeWidth="2.5" />
        <circle cx={X(spot)} cy={base + 18} r="8" fill={C.text} stroke={C.bg} strokeWidth="2.5" />
        <g transform={`translate(${Math.min(W - R - 70, Math.max(L + 70, X(spot)))}, ${top - 4})`}>
          <rect x="-66" y="-17" width="132" height="22" rx="11" fill={C.text} />
          <text x="0" y="-1" fontSize="14" fontWeight="800" fill={C.bg} textAnchor="middle" fontFamily="JetBrains Mono,monospace">{underlying} {px(spot)}</text>
        </g>
      </svg>
    </div>
  );
}

/** ✕ below 703 · ✓ 703–741 · ✕ above 741 · ⏱ 30 Oct — the prices and the date that change the call. */
export function Triggers({ legs, ncdPos, spot, closeYmd }) {
  const strip = positionStrip({ legs, spot, ncd: ncdPos });
  if (!strip) return null;
  const be = strip.breakevens.map(b => b.value);
  const pnl = S => valueAt(legs, S) + ncdPos;
  const lowOk = pnl(strip.lo) > 0, highOk = pnl(strip.hi) > 0;
  const items = [];
  const r = v => Math.round(v);
  if (be.length >= 2) {
    items.push(lowOk ? { ok: true, t: `below ${r(be[0])}` } : { ok: false, t: `below ${r(be[0])}` });
    items.push({ ok: !lowOk, t: `${r(be[0])}–${r(be[be.length - 1])}`, main: true });
    items.push(highOk ? { ok: true, t: `above ${r(be[be.length - 1])}` } : { ok: false, t: `above ${r(be[be.length - 1])}` });
  } else if (be.length === 1) {
    items.push({ ok: lowOk, t: `below ${r(be[0])}` });
    items.push({ ok: highOk, t: `above ${r(be[0])}` });
  }
  return (
    <div data-testid="triggers" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
      <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey, marginRight: 2 }}>at expiry</span>
      {items.map((it, i) => (
        <span key={i} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 7, fontSize: 13, fontWeight: 700,
          color: it.ok ? C.green : C.red, background: (it.ok ? C.green : C.red) + '17', border: `1px solid ${(it.ok ? C.green : C.red)}66` }}>
          {it.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}{it.t}
        </span>
      ))}
      {closeYmd && <span className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 7, fontSize: 13, fontWeight: 700,
        color: C.amber, background: C.amber + '17', border: `1px solid ${C.amber}66` }}><Clock size={14} />close {fmtYmd(closeYmd)}</span>}
    </div>
  );
}

/** At most three reasons, as icons with a few words each. */
export function reasonChips({ shorts, events, ivChange, shortVega, trendFit, warnings }) {
  const out = [];
  (shorts || []).filter(s => s.tested || s.itm || s.pressured).sort((a, b) => a.cushion - b.cushion).forEach(s => out.push({
    icon: Crosshair, col: s.tested || s.itm ? C.red : C.amber,
    t: `${s.strike}${s.right}${s.absDelta != null ? ` ${Math.round(s.absDelta * 100)}Δ` : ''}${s.itm ? ' ITM' : s.tested ? ' tested' : ''}` }));
  if (events && events.length) out.push({ icon: Zap, col: C.amber, t: events.slice(0, 2).map(shortEvent).join(' · ') });
  if (ivChange && Math.abs(ivChange) >= 1) {
    const against = shortVega ? ivChange > 0 : ivChange < 0;
    out.push({ icon: ivChange > 0 ? TrendingUp : TrendingDown, col: against ? C.amber : C.green, t: `IV ${ivChange > 0 ? '+' : ''}${ivChange}` });
  }
  if ((warnings || []).some(w => /vol expanding/i.test(w))) out.push({ icon: Activity, col: C.amber, t: 'realised vol rising' });
  if (trendFit < 0) out.push({ icon: TrendingDown, col: C.amber, t: 'trend against you' });
  return out.slice(0, 3);
}
export function Reasons({ chips }) {
  if (!chips.length) return null;
  return (
    <div data-testid="reasons" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
      {chips.map((c, i) => {
        const I = c.icon;
        return <span key={i} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 7, fontSize: 12.5,
          color: c.col, background: C.panel, border: `1px solid ${C.line}` }}><I size={13} />{c.t}</span>;
      })}
    </div>
  );
}

export function NextStep({ text }) {
  if (!text) return null;
  return (
    <div data-testid="next-step" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 10, padding: '8px 10px', borderRadius: 8,
      background: '#0c1d36', border: '1px solid #1f6feb55', fontSize: 13.5, color: C.text }}>
      <ArrowRight size={16} color={C.blue} style={{ flexShrink: 0, marginTop: 1 }} />
      <span><span style={{ color: C.blue, fontWeight: 700 }}>Next: </span>{text}</span>
    </div>
  );
}
