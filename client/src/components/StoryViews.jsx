import React, { useEffect, useRef, useState, useMemo } from 'react';
import { fmt$ } from '../utils/format';
import {
  equitySeries, maxDrawdown, calibration, structureEdge, rHistogram, structureGrid,
  dailyPnl, dayStats, heatCells, monthPace, weekCards, fmtDay,
} from '../utils/tradeStory';
import { rollChain } from '../engine/rollChain';

// Story views (Nov 2026): Trades, Journal and Analytics as pictures that answer one
// question each, with the tables one tab away. Drawn in plain SVG at the measured
// width so the type stays its real size. Colours come from the theme tokens, so the
// same charts read in night, day and Vision.

const C = {
  ink: 'var(--c-e6edf3)', muted: 'var(--c-a8b2be)', faint: 'var(--c-8b949e)',
  up: 'var(--c-3fb950)', down: 'var(--c-f85149)', blue: 'var(--c-58a6ff)', blueSolid: 'var(--c-1f6feb)',
  grid: 'rgba(140,140,140,0.28)', track: 'rgba(140,140,140,0.18)',
};
const money = v => { const r = Math.round(v); return (r < 0 ? '−' : '+') + '$' + Math.abs(r).toLocaleString('en-US'); };
const rTxt = r => (r == null ? '—' : (r >= 0 ? '+' : '−') + Math.abs(r).toFixed(2) + 'R');

function useWidth(min = 280) {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = () => setW(Math.max(min, Math.floor(el.getBoundingClientRect().width)));
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min]);
  return [ref, w || 720];
}

export function Eyebrow({ children }) {
  return <div className="story-eyebrow text-[11.5px] font-semibold uppercase tracking-[0.08em] text-text-muted mb-1">{children}</div>;
}
export function StoryCard({ eyebrow, title, sub, right, children, testid, className = '' }) {
  return (
    <div className={`card story-card ${className}`} data-testid={testid}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
          {title && <h3 className="story-title text-[19px] font-semibold text-text leading-tight">{title}</h3>}
          {sub && <p className="text-[13px] text-text-muted mt-1 leading-snug">{sub}</p>}
        </div>
        {right}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
export function Insight({ children }) {
  return <div className="story-insight mt-3 rounded-2xl px-4 py-3 text-[13px] leading-relaxed text-text" style={{ background: 'rgba(0,0,0,0.14)' }}>{children}</div>;
}
export function Tile({ label, value, sub, color }) {
  return (
    <div className="story-tile rounded-2xl px-4 py-3 border border-bg-border" style={{ background: 'rgba(255,255,255,0.05)' }}>
      <div className="text-[12.5px] text-text-muted">{label}</div>
      <div className="text-[22px] font-semibold num leading-tight" style={color ? { color } : undefined}>
        {value} {sub && <span className="text-[12.5px] font-normal text-text-muted">{sub}</span>}
      </div>
    </div>
  );
}
function Pill({ tone, children }) {
  const bg = tone === 'up' ? 'rgba(126,226,160,0.16)' : tone === 'down' ? 'rgba(255,163,154,0.16)' : tone === 'warn' ? 'rgba(255,212,121,0.16)' : 'rgba(140,140,140,0.16)';
  const fg = tone === 'up' ? C.up : tone === 'down' ? C.down : tone === 'warn' ? 'var(--c-e3b341)' : C.ink;
  return <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[12px] font-semibold num whitespace-nowrap" style={{ background: bg, color: fg }}>{children}</span>;
}
function Empty({ children }) {
  return <div className="py-8 text-center text-sm text-text-faint">{children}</div>;
}

// ── Trades · Idea 1: every trade on one line ──
export function EquityRiver({ trades, onOpen }) {
  const [ref, W] = useWidth();
  const [hover, setHover] = useState(null);
  const s = useMemo(() => equitySeries(trades), [trades]);
  const dd = useMemo(() => maxDrawdown(s), [s]);
  if (!s.length) return <div ref={ref}><Empty>No closed engine trades yet.</Empty></div>;
  const H = 280, P = { l: 14, r: 14, t: 28, b: 18 };
  const ys = s.map(p => p.cum), y0 = Math.min(0, ...ys), y1 = Math.max(0, ...ys);
  const X = i => P.l + (s.length === 1 ? 0.5 : i / (s.length - 1)) * (W - P.l - P.r);
  const Y = v => H - P.b - (v - y0) / ((y1 - y0) || 1) * (H - P.t - P.b);
  const path = s.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(p.cum).toFixed(1)}`).join(' ');
  const area = `${path} L${X(s.length - 1)} ${Y(0)} L${X(0)} ${Y(0)} Z`;
  const rOf = t => Math.max(3.5, Math.min(12, Math.sqrt(t.risk || 250) / 4));
  const big = s.filter(p => Math.abs(p.trade.pnl) >= Math.max(1000, (y1 - y0) * 0.15)).slice(-4);
  const h = hover != null ? s[hover] : null;
  return (
    <div ref={ref} className="relative" data-testid="equity-river">
      <svg width={W} height={H} role="img" aria-label="Cumulative P&L by trade">
        <line x1={P.l} x2={W - P.r} y1={Y(0)} y2={Y(0)} stroke={C.grid} strokeDasharray="4 5" />
        {dd.dd < 0 && dd.from != null && (
          <rect x={X(Math.max(0, dd.from))} y={P.t - 8} width={Math.max(2, X(dd.to) - X(Math.max(0, dd.from)))} height={H - P.t - P.b + 8} fill="rgba(255,163,154,0.08)" />
        )}
        <path d={area} fill="rgba(106,168,255,0.14)" />
        <path d={path} fill="none" stroke={C.blue} strokeWidth="2.5" />
        {s.map((p, i) => (
          <circle key={p.trade.ref + '-' + i} cx={X(i)} cy={Y(p.cum)} r={rOf(p.trade)}
            fill={p.trade.pnl >= 0 ? C.ink : C.down} stroke="rgba(0,0,0,0.25)" style={{ cursor: onOpen ? 'pointer' : 'default' }}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onClick={() => onOpen?.(p.trade)} />
        ))}
        {big.map(p => {
          const x = X(p.i), end = x > W * 0.78;
          return <text key={'l' + p.i} x={end ? x - 14 : x + 12} y={p.trade.pnl < 0 ? Y(p.cum) + 24 : Y(p.cum) - 12} textAnchor={end ? 'end' : 'start'}
            fill={C.ink} fontSize="13" fontWeight="600">{p.trade.und} {p.trade.family.toLowerCase()} {money(p.trade.pnl)}</text>;
        })}
      </svg>
      {h && (
        <div className="absolute pointer-events-none rounded-xl px-3 py-2 text-[12.5px] shadow-lg border border-bg-border"
          style={{ left: Math.min(W - 220, Math.max(0, X(h.i) - 100)), top: Math.max(0, Y(h.cum) - 74), background: 'rgba(40,38,36,0.92)', color: '#fff', width: 210 }}>
          <div className="font-semibold">#{h.trade.ref} {h.trade.und} {h.trade.family} · {h.trade.qty} ct</div>
          <div>{fmtDay(h.trade.closeDate)} · {money(h.trade.pnl)} · {rTxt(h.trade.r)}</div>
          <div style={{ opacity: 0.8 }}>Running total {money(h.cum)}</div>
        </div>
      )}
      {dd.dd < 0 && <div className="text-[12.5px] text-text-muted mt-1">Shaded: the deepest drawdown, {money(dd.dd)} from the high.</div>}
    </div>
  );
}

// ── Trades · Idea 2: did good tickets make money? ──
export function ConfidenceScatter({ trades }) {
  const [ref, W] = useWidth();
  const pts = (trades || []).filter(t => t.conf != null && t.r != null);
  if (pts.length < 3) return <div ref={ref}><Empty>Not enough scored tickets yet.</Empty></div>;
  const H = 320, P = 36;
  const rMax = Math.max(1.5, ...pts.map(t => Math.abs(t.r))) * 1.08;
  const X = c => P + c / 100 * (W - 2 * P), Y = r => H / 2 - r / rMax * (H / 2 - P);
  const sz = t => Math.max(4.5, Math.min(14, Math.sqrt(t.risk || 250) / 4));
  const topConf = [...pts].sort((a, b) => b.conf - a.conf)[0];
  const label = [...pts].sort((a, b) => Math.abs(b.r) - Math.abs(a.r)).slice(0, 2).concat(topConf).filter((t, i, a) => a.indexOf(t) === i);
  const lo = pts.filter(t => t.conf < 50), hi = pts.filter(t => t.conf >= 50);
  const avg = a => (a.length ? a.reduce((x, t) => x + t.r, 0) / a.length : 0);
  const q = (txt, x, y, anchor = 'start') => <text x={x} y={y} textAnchor={anchor} fill={C.muted} fontSize="12">{txt}</text>;
  return (
    <div ref={ref} data-testid="confidence-scatter">
      <svg width={W} height={H} role="img" aria-label="Engine confidence against result in R">
        <rect x={X(50)} y={P - 8} width={X(100) - X(50)} height={H / 2 - P + 8} fill="rgba(126,226,160,0.07)" />
        <rect x={X(0)} y={H / 2} width={X(50) - X(0)} height={H / 2 - P + 8} fill="rgba(255,163,154,0.07)" />
        <line x1={P} x2={W - P} y1={H / 2} y2={H / 2} stroke={C.grid} />
        <line x1={X(50)} x2={X(50)} y1={P - 8} y2={H - P + 8} stroke={C.grid} strokeDasharray="4 4" />
        {q('Long shot that paid', X(1), P + 4)}{q('Good call, paid', X(51), P + 4)}
        {q('Weak ticket, lost', X(1), H - P)}{q('Good call, lost', X(51), H - P)}
        {pts.map(t => <circle key={t.ref} cx={X(t.conf)} cy={Y(t.r)} r={sz(t)} fill={t.r >= 0 ? C.ink : C.down} fillOpacity="0.9" stroke="rgba(0,0,0,0.25)"><title>{`#${t.ref} ${t.und} ${t.family} · ${t.conf}/100 · ${rTxt(t.r)} · ${money(t.pnl)}`}</title></circle>)}
        {(() => { const used = []; return label.map(t => {
          const right = X(t.conf) > W * 0.7;
          const below = t === topConf && !label.slice(0, 2).includes(t);
          const x = right ? X(t.conf) - sz(t) - 6 : X(t.conf) + sz(t) + 6;
          let y = below ? Y(t.r) + sz(t) + 16 : Y(t.r) + 4;
          while (used.some(u => Math.abs(u.y - y) < 15 && Math.abs(u.x - x) < 220)) y += 15;   // no stacked labels
          used.push({ x, y });
          return <text key={'l' + t.ref} x={x} y={y} textAnchor={right ? 'end' : 'start'} fill={C.ink} fontSize="12">{t.und} {t.family.toLowerCase()} {t.conf}/100 · {rTxt(t.r)}</text>;
        }); })()}
        <text x={P} y={H - 8} fill={C.faint} fontSize="11">0</text>
        <text x={W - P} y={H - 8} textAnchor="end" fill={C.faint} fontSize="11">100 · engine confidence at entry</text>
      </svg>
      <Insight>
        <b>Read it:</b> tickets scored under 50 averaged {rTxt(avg(lo))} over {lo.length}; 50 and above averaged {rTxt(avg(hi))} over {hi.length}.
        {avg(lo) >= avg(hi) ? ' The score is not separating winners from losers yet — treat it as context, not a grade, until it does.' : ' Higher scores are paying more, as they should.'}
      </Insight>
    </div>
  );
}

// ── Trades · Idea 3: trade cards ──
function MiniPayoff({ family }) {
  const f = String(family || '').toLowerCase();
  const d = /fly|bwb/.test(f) ? 'M0 44 L110 44 L150 8 L190 44 L300 44'
    : /condor/.test(f) ? 'M0 46 L70 46 L105 12 L195 12 L230 46 L300 46'
      : /bear call|bear put/.test(f) ? 'M0 12 L130 12 L180 46 L300 46'
        : 'M0 46 L120 46 L170 12 L300 12';
  return (
    <svg width="100%" height="50" viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden="true">
      <line x1="0" x2="300" y1="30" y2="30" stroke={C.grid} strokeDasharray="3 4" />
      <path d={d} fill="none" stroke={C.blue} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
export function TradeCards({ trades, decisions = [], closes = [], limit = 8 }) {
  const byRef = useMemo(() => new Map((decisions || []).map(d => [String(d._rowIndex), d])), [decisions]);
  const recent = [...(trades || [])].reverse().slice(0, limit);
  if (!recent.length) return <Empty>No closed engine trades yet.</Empty>;
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }} data-testid="trade-cards">
      {recent.map(t => {
        const chain = byRef.get(t.ref) ? rollChain(byRef.get(t.ref), { decisions, closes }) : null;
        return (
          <div key={t.ref} className="story-tile rounded-2xl border border-bg-border px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)' }} data-testid="trade-card">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full grid place-items-center text-[11px] font-bold shrink-0" style={{ background: '#f1e4d6', color: '#2a2622' }}>{t.und}</div>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-[14.5px] truncate">{t.family} · {t.qty} ct</div>
                <div className="text-[12px] text-text-muted">#{t.ref} · {t.engine} · {fmtDay(t.closeDate)}</div>
              </div>
              <Pill tone={t.pnl >= 0 ? 'up' : 'down'}>{money(t.pnl)}</Pill>
            </div>
            <div className="mt-2"><MiniPayoff family={t.family} /></div>
            <div className="flex justify-between text-[12px] text-text-muted"><span>{rTxt(t.r)}{t.legs ? ` · ${t.legs}` : ''}</span><span>{t.conf != null ? `Engine ${t.conf}/100` : 'No score'}</span></div>
            {chain && (
              <div className="mt-2 rounded-xl px-3 py-2 text-[12px] leading-snug" style={{ background: 'rgba(0,0,0,0.14)' }}>
                Rolled {chain.rolls}×: {chain.links.map(l => `#${l.ref} ${money(l.realised)}`).join(' → ')} → #{t.ref} {money(t.pnl)}. Position total {money(chain.banked + t.pnl)}.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Journal · Idea 1: the year at a glance ──
export function YearHeatmap({ trades, fromISO, toISO }) {
  const [ref, W] = useWidth();
  const byDay = useMemo(() => dailyPnl(trades), [trades]);
  const st = useMemo(() => dayStats(byDay), [byDay]);
  const hc = useMemo(() => heatCells(byDay, fromISO, toISO), [byDay, fromISO, toISO]);
  const left = 24, top = 22;
  const cw = Math.max(10, Math.min(44, Math.floor((W - left) / hc.cols)));
  const H = top + 5 * cw;
  const maxAbs = Math.max(300, ...Object.values(byDay).map(Math.abs));
  const fill = v => {
    if (v == null) return 'rgba(140,140,140,0.16)';
    const a = Math.min(1, Math.abs(v) / (maxAbs * 0.6));
    return v >= 0 ? `rgba(126,226,160,${0.25 + 0.7 * a})` : `rgba(255,163,154,${0.3 + 0.65 * a})`;
  };
  return (
    <div ref={ref} data-testid="year-heatmap">
      <svg width={W} height={H} role="img" aria-label="Daily P&L heatmap">
        {hc.months.map(m => <text key={m.label + m.col} x={left + m.col * cw} y={13} fill={C.muted} fontSize="12">{m.label}</text>)}
        {['M', 'T', 'W', 'T', 'F'].map((d, i) => <text key={i} x={4} y={top + i * cw + cw / 2 + 4} fill={C.faint} fontSize="11">{d}</text>)}
        {hc.cells.map(c => (
          <rect key={c.date} x={left + c.col * cw} y={top + c.row * cw} width={cw - 4} height={cw - 4} rx={Math.min(6, cw / 5)} fill={fill(c.pnl)}>
            <title>{`${fmtDay(c.date)}: ${c.pnl == null ? 'no close' : money(c.pnl)}`}</title>
          </rect>
        ))}
      </svg>
      <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
        <Tile label="Best day" value={st.best ? money(st.best.pnl) : '—'} sub={st.best?.label} />
        <Tile label="Worst day" value={st.worst ? money(st.worst.pnl) : '—'} sub={st.worst?.label} color={st.worst && st.worst.pnl < 0 ? C.down : undefined} />
        <Tile label="Green days" value={`${st.green} of ${st.days}`} />
        <Tile label="Longest green streak" value={`${st.streak.n} trade days`} sub={st.streak.label ? 'from ' + st.streak.label : ''} />
      </div>
    </div>
  );
}

// ── Journal · Idea 2: pace to the month's target ──
export function MonthPace({ trades, monthISO, target, todayISO }) {
  const [ref, W] = useWidth();
  const byDay = useMemo(() => dailyPnl(trades), [trades]);
  const p = useMemo(() => monthPace(byDay, monthISO, target, todayISO), [byDay, monthISO, target, todayISO]);
  const H = 230, P = 30;
  const lo = Math.min(0, ...p.points.map(x => x.cum), p.projected), hi = Math.max(p.target, p.projected, ...p.points.map(x => x.cum), 1);
  const X = d => P + (d - 1) / ((p.daysIn - 1) || 1) * (W - 2 * P);
  const Y = v => H - P - (v - lo) / ((hi - lo) || 1) * (H - 2 * P);
  const path = p.points.map((x, i) => `${i ? 'L' : 'M'}${X(x.day)} ${Y(x.cum)}`).join(' ');
  const last = p.points[p.points.length - 1];
  const monthName = new Date(monthISO + '-15T12:00:00Z').toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' });
  return (
    <div ref={ref} data-testid="month-pace">
      <div className="text-[19px] font-semibold mb-1">{monthName}: {p.gap > 0 ? `behind by ${fmt$(p.gap)}` : `ahead by ${fmt$(-p.gap)}`}</div>
      <p className="text-[13px] text-text-muted">Running total against the {fmt$(p.target)} target. The dotted end is where today's pace lands by the {p.daysIn}th: about {fmt$(p.projected)}.</p>
      <svg width={W} height={H} className="mt-2" role="img" aria-label="Month to date against target">
        <line x1={P} x2={W - P} y1={Y(0)} y2={Y(0)} stroke={C.grid} />
        {p.target > 0 && <><line x1={X(1)} y1={Y(0)} x2={X(p.daysIn)} y2={Y(p.target)} stroke={C.muted} strokeDasharray="5 5" />
          <text x={X(p.daysIn)} y={Y(p.target) - 8} textAnchor="end" fill={C.muted} fontSize="12">target {fmt$(p.target)}</text></>}
        {path && <path d={path} fill="none" stroke={C.blue} strokeWidth="3" />}
        {last && <>
          <line x1={X(last.day)} y1={Y(last.cum)} x2={X(p.daysIn)} y2={Y(p.projected)} stroke={C.blue} strokeDasharray="3 5" strokeWidth="2" />
          <circle cx={X(last.day)} cy={Y(last.cum)} r="6" fill={C.ink} />
          <text x={X(last.day) + (X(last.day) > W * 0.7 ? -10 : 10)} y={Y(last.cum) - 10} textAnchor={X(last.day) > W * 0.7 ? 'end' : 'start'} fill={C.ink} fontSize="13" fontWeight="600">{fmt$(last.cum)} today</text>
        </>}
      </svg>
    </div>
  );
}

// ── Journal · Idea 3: weeks as stories ──
export function WeekCards({ trades, cutoff = '12:00' }) {
  const weeks = useMemo(() => weekCards(trades, { cutoff, limit: 4 }), [trades, cutoff]);
  if (!weeks.length) return <Empty>No closed engine trades yet.</Empty>;
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }} data-testid="week-cards">
      {weeks.map(w => (
        <div key={w.monday} className="story-tile rounded-2xl border border-bg-border px-4 py-3" style={{ background: 'rgba(255,255,255,0.05)' }}>
          <div className="flex justify-between items-baseline"><span className="text-[13px] text-text-muted">{w.label}</span><Pill tone={w.total >= 0 ? 'up' : 'down'}>{money(w.total)}</Pill></div>
          <div className="mt-2 flex flex-col gap-1">
            {w.trades.slice(0, 5).map(t => (
              <div key={t.ref} className="flex justify-between text-[13px]"><span className="text-text-muted truncate">{t.und} {t.family.toLowerCase()}</span><span className="num" style={{ color: t.pnl >= 0 ? C.up : C.down }}>{money(t.pnl)}</span></div>
            ))}
            {w.trades.length > 5 && <div className="text-[12px] text-text-faint">+{w.trades.length - 5} more</div>}
          </div>
          {w.early.of > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Pill tone={w.early.kept === w.early.of ? null : 'warn'}>{w.early.kept === w.early.of ? '✓' : '!'} 0DTE entry by {cutoff} · {w.early.kept} of {w.early.of}</Pill>
            </div>
          )}
          {w.late.length > 0 && <div className="mt-1.5 text-[12px] text-text-muted">Late: {w.late.map(t => `#${t.ref} ${t.und} at ${t.entryTime}`).join(', ')}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Analytics · Idea 1: where the edge is ──
export function EdgeBars({ trades }) {
  const rows = useMemo(() => structureEdge(trades, 2), [trades]);
  if (!rows.length) return <Empty>Not enough closed trades per structure yet.</Empty>;
  const mx = Math.max(1, ...rows.map(r => Math.max(r.winPart, -r.lossPart)));
  const fly = rows.find(r => r.name === 'Asym fly');
  return (
    <div data-testid="edge-bars">
      <div className="grid items-center gap-x-3 text-[12px] text-text-faint pb-1" style={{ gridTemplateColumns: 'minmax(110px,150px) 1fr 1fr 80px' }}>
        <span /><span className="text-right">loses per trade</span><span>wins per trade</span><span className="text-right">expectancy</span>
      </div>
      {rows.map(r => (
        <div key={r.name} className="grid items-center gap-x-3 py-1.5" style={{ gridTemplateColumns: 'minmax(110px,150px) 1fr 1fr 80px' }}
          title={`${r.n} trades · ${r.wins} won, avg ${fmt$(r.avgWin)} · ${r.losses} lost, avg ${fmt$(r.avgLoss)} · total ${fmt$(r.total)}`}>
          <div className="text-[14px] truncate">{r.name} <span className="text-text-faint text-[12px]">{r.n}</span></div>
          <div className="flex justify-end"><div style={{ height: 14, width: `${-r.lossPart / mx * 100}%`, background: C.down, borderRadius: '7px 0 0 7px', opacity: 0.85 }} /></div>
          <div><div style={{ height: 14, width: `${r.winPart / mx * 100}%`, background: C.ink, opacity: 0.85, borderRadius: '0 7px 7px 0' }} /></div>
          <div className="num text-right font-semibold" style={{ color: r.expectancy >= 0 ? C.ink : C.down }}>{money(r.expectancy)}</div>
        </div>
      ))}
      {fly && fly.wins > 0 && fly.losses > 0 && (
        <Insight>The asymmetric fly — {fly.n} trades — wins {Math.round(fly.wins / fly.n * 100)}% of the time with an average win of {fmt$(fly.avgWin)}; one average loss ({fmt$(fly.avgLoss)}) {(() => { const k = Math.round(-fly.avgLoss / fly.avgWin * 10) / 10; return k <= 1.15 ? 'is about the size of one average win.' : `takes ${k.toFixed(1).replace(/\.0$/, '')} average wins to make back.`; })()}</Insight>
      )}
    </div>
  );
}

// ── Analytics · Idea 2: is the engine calibrated? ──
export function CalibrationBars({ trades }) {
  const b = useMemo(() => calibration(trades), [trades]);
  const scored = b.reduce((a, x) => a + x.n, 0);
  if (scored < 4) return <Empty>Not enough scored tickets yet.</Empty>;
  const climbs = b.filter(x => x.n).every((x, i, a) => i === 0 || x.avgR >= a[i - 1].avgR - 0.02);
  const best = [...b].filter(x => x.n).sort((p, q) => q.avgR - p.avgR)[0];
  return (
    <div data-testid="calibration">
      <div className="flex gap-3 items-end">
        {b.map(x => (
          <div key={x.label} className="flex-1 flex flex-col items-center gap-2">
            <div className="num font-semibold text-[15px]">{x.n ? rTxt(x.avgR) : '—'}</div>
            <div className="w-14 rounded-2xl overflow-hidden flex items-end" style={{ height: 160, background: C.track }}>
              <div style={{ width: '100%', height: `${x.win * 100}%`, background: `linear-gradient(180deg, ${C.blue}, ${C.blueSolid})` }} />
            </div>
            <div className="text-[13.5px]">{x.label}</div>
            <div className="text-[12px] text-text-muted">{x.n ? `${Math.round(x.win * 100)}% won · ${x.n}` : 'none'}</div>
          </div>
        ))}
      </div>
      <Insight>{climbs ? 'Average R climbs with the score — the engine is ranking trades the right way.'
        : `They don't climb: the ${best.label} band has the best average R. Re-weight the score on its own results, or read it as context, not a grade.`}</Insight>
    </div>
  );
}

// ── Analytics · Idea 3: results in R ──
export function RHistogram({ trades }) {
  const bins = useMemo(() => rHistogram(trades), [trades]);
  const mx = Math.max(1, ...bins.map(b => b.n));
  const rs = (trades || []).filter(t => t.r != null);
  const bigLoss = rs.filter(t => t.r <= -0.5).length, bigWin = rs.filter(t => t.r >= 0.5).length;
  if (!rs.length) return <Empty>No R multiples yet.</Empty>;
  return (
    <div data-testid="r-histogram">
      <div className="flex gap-2 items-end" style={{ height: 230 }}>
        {bins.map((b, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-1 justify-end h-full">
            <div className="text-[12px] text-text-muted">{b.n || ''}</div>
            <div style={{ width: '100%', height: `${b.n / mx * 190}px`, minHeight: b.n ? 4 : 0, borderRadius: `${Math.min(8, b.n / mx * 95)}px ${Math.min(8, b.n / mx * 95)}px 3px 3px`, background: b.lo < 0 ? C.down : b.hi === Infinity ? C.blue : C.ink, opacity: 0.85 }} />
            <div className="text-[11px] text-text-faint whitespace-nowrap">{b.hi === Infinity ? `${b.lo}+` : `${b.lo > 0 ? '+' : ''}${b.lo}`}</div>
          </div>
        ))}
      </div>
      <Insight>{bigLoss} loss{bigLoss === 1 ? '' : 'es'} ran past −0.5R; {bigWin} win{bigWin === 1 ? '' : 's'} got past +0.5R. {bigLoss > bigWin ? 'Wins are taken early and some losses run — the profit-target and time-exit rules are where the money is.' : 'Winners are being allowed to run as far as the losers.'}</Insight>
    </div>
  );
}

// ── Analytics · Idea 4: structure × underlying ──
export function StructureGrid({ trades }) {
  const g = useMemo(() => structureGrid(trades), [trades]);
  if (!g.rows.length) return <Empty>No closed trades yet.</Empty>;
  const cols = `minmax(100px,130px) repeat(${g.cols.length}, minmax(60px,1fr))`;
  return (
    <div data-testid="structure-grid">
      <div className="grid gap-1.5 text-[12px] text-text-muted mb-1.5" style={{ gridTemplateColumns: cols }}><span />{g.cols.map(c => <span key={c} className="text-center">{c}</span>)}</div>
      {g.rows.map(r => (
        <div key={r} className="grid gap-1.5 mb-1.5" style={{ gridTemplateColumns: cols }}>
          <div className="text-[13.5px] self-center truncate">{r}</div>
          {g.cols.map(c => {
            const x = g.cell(r, c);
            if (!x) return <div key={c} className="rounded-xl" style={{ height: 46, background: 'rgba(140,140,140,0.08)' }} />;
            const a = Math.min(1, Math.abs(x.total) / 1500);
            return (
              <div key={c} className="rounded-xl flex flex-col items-center justify-center" title={`${r} on ${c}: ${x.n} trades, ${fmt$(x.total)}`}
                style={{ height: 46, background: x.total >= 0 ? `rgba(126,226,160,${0.15 + 0.55 * a})` : `rgba(255,163,154,${0.2 + 0.55 * a})` }}>
                <div className="num text-[13px] font-semibold">{money(x.total)}</div>
                <div className="text-[11px] opacity-80">{x.n}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// Text tabs for a page's views (Story · Table). Large type, a short bar under the
// one that is on — the Vision tab style, and plain enough for the other themes.
export function ViewTabs({ value, onChange, options, testid }) {
  return (
    // A nav of buttons, not role="tablist": Vision turns every tablist into a segmented well.
    <nav aria-label="View" className="story-tabs flex gap-6 mb-4" data-testid={testid}>
      {options.map(([id, label]) => (
        <button key={id} type="button" aria-current={value === id ? 'page' : undefined} onClick={() => onChange(id)}
          className={`story-tab relative pb-2 text-[17px] font-medium transition-colors ${value === id ? 'text-text' : 'text-text-muted hover:text-text'}`}>
          {label}
          {value === id && <span className="absolute left-0 bottom-0 h-[3px] w-5 rounded-full bg-current" />}
        </button>
      ))}
    </nav>
  );
}
