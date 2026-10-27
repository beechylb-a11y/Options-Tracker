// ── Open positions board (Dashboard, Oct 2026) ──
//
// The Dashboard's table answered "what did I log" — opened-at, entry, a stop written
// as "buy back @4.40 −$220" — and not "how is it doing and what do I do". It had no
// live P&L, no strikes, no expiry and no verdict, while the 45DTE check-up a click
// away knew all of them. This board is one row per position, read left to right:
//
//   verdict · what it is · P&L · stop→target · where price is · time · the one action
//
// Every number comes from the same place as the check-up card (one shared pass,
// runCheckup) and the same exit lines as the table (utils/positionLines), so the two
// screens cannot disagree. Click a row to open the full check-up card under it.

import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, ChevronDown, ChevronUp, RefreshCw, Zap, Hourglass, AlertTriangle } from 'lucide-react';
import { ActionBadge, C, fmtYmd, shortEvent } from './CheckupVisual';
import { ACTION_LABEL, CheckupCard } from './Checkup45';
import { positionStrip } from '../engine/positionPlan';
import { normalisePosition } from '../utils/ticketMath';
import { parseStrikes } from '../utils/positionMatch';
import { stopOf, targetOf, entryOf, liveRiskOf } from '../utils/positionLines';
import { daysBetweenYmd } from '../utils/ticketExpiry';
import { tradingSession } from '../engine/session';
import { STATUS } from '../engine/fills';

const money = v => (v == null || !isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString());
const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
function ymdAdd(y, k) {
  const d = new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)) + k * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Most urgent first: anything that says act, then watch, then the quiet ones.
const URGENCY = { close: 0, 'close-or-roll': 0, 'roll-short': 1, 'roll-out': 1, 'roll-untested': 1, 'take-profit': 1,
  watch: 2, working: 3, hold: 4, open: 5, unknown: 6 };
export const needsAction = a => URGENCY[a] != null && URGENCY[a] <= 1;

/** Everything one row shows, from the open-position row, its roll chain, expiry and check-up. */
export function boardRow(r, { chain = null, expiry = null, check = null } = {}) {
  const pos = normalisePosition(r);
  const working = r.status === STATUS.WORKING || r.status === STATUS.PART_FILLED;
  const rv = check && check.review;
  const m = (rv && rv.metrics) || {};
  const action = working ? 'working' : rv && rv.action !== 'unknown' ? rv.action : (rv ? 'unknown' : 'open');
  const tone = working ? 'purple' : rv ? rv.tone : 'grey';
  const label = working ? 'Working' : action === 'open' ? 'Open' : ACTION_LABEL[action] || action;
  const banked = (chain ? chain.banked : 0) + n(r.realisedPnl);
  const ticketPnl = m.pnl$ != null ? m.pnl$ : null;
  const st = stopOf(r), tg = targetOf(r);
  const today = tradingSession().yyyymmdd;
  const exp = (m.nearExp) || (expiry && expiry.expiry) || null;
  const dte = exp ? daysBetweenYmd(today, exp) : null;
  const closeYmd = m.nearExp && m.closeDte != null ? ymdAdd(m.nearExp, -m.closeDte) : null;
  const daysToClose = closeYmd ? daysBetweenYmd(today, closeYmd) : null;
  const qtyOpen = n(r.qtyOpen) || n(r.qty);
  const ncdPos = m.ncd != null ? m.ncd + (qtyOpen ? banked / (100 * qtyOpen) : 0) : null;
  const strategy = String(pos.strategy || '').replace(/\s*-\s*Normal\b/i, '');
  return {
    key: r.ticketRef, r, check, action, tone, label, headline: rv && rv.action !== 'unknown' ? rv.headline : null,
    underlying: pos.underlying, strikes: parseStrikes(r.legs || ''), strategy, qtyOpen, qty: n(r.qty),
    engine: pos.engine, is45: /45/.test(pos.engine || ''),
    expiry: exp, dte, closeYmd, daysToClose, daysHeld: m.daysHeld, planDays: m.planDays, events: m.events || [],
    banked, chain, ticketPnl, posPnl: ticketPnl != null ? ticketPnl + banked : null,
    // The check-up's own numbers when it ran (so this row and the card under it are
    // the same figures); the shared exit lines otherwise. Both read the same entry
    // and the same saved plan.
    stop: m.stop$ != null ? banked + m.stop$ : st ? banked + st.loss : null,
    target: m.target$ != null ? banked + m.target$ : tg ? banked + tg.gain : null, stopLine: st, targetLine: tg,
    entry: entryOf(r), risk: liveRiskOf(r), working,
    legs: check && check.legs, spot: check && check.spot, shorts: m.shorts || [], ncdPos,
    nextStep: rv && rv.steps && rv.steps[0],
  };
}

const TONES = { green: C.green, amber: C.amber, red: C.red, grey: '#a8b2be', purple: '#bc8cff' };

function Badge({ row }) {
  if (row.action === 'working' || row.action === 'open') {
    const fg = TONES[row.tone] || TONES.grey;
    return (
      <span data-testid="board-action" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8,
        fontWeight: 800, fontSize: 13, letterSpacing: '.03em', textTransform: 'uppercase', color: fg, background: fg + '1f', border: `1.5px solid ${fg}` }}>
        {row.action === 'working' ? <Hourglass size={15} strokeWidth={2.5} /> : null}{row.label}
      </span>
    );
  }
  return <span data-testid="board-action"><ActionBadge action={row.action} tone={row.tone} label={row.label} /></span>;
}

/** stop ◀━━━━━┿━━●━━━━▶ target, whole position; no dot when there is no live mark. */
function MiniMeter({ row }) {
  const { posPnl: now, stop, target } = row;
  if (stop == null && target == null) return <span style={{ color: C.dim, fontSize: 12 }}>no exit plan</span>;
  const xs = [stop ?? 0, target ?? 0, 0, now ?? 0];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const P = v => ((v - lo) / Math.max(1, hi - lo)) * 100;
  const col = now == null ? C.grey : now >= 0 ? C.green : C.red;
  return (
    <div data-testid="board-meter" title={`stop ${money(stop)} · now ${money(now)} · target ${money(target)} — whole position`}>
      <div style={{ position: 'relative', height: 16 }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 6, height: 5, borderRadius: 3,
          background: `linear-gradient(90deg, ${C.red} 0%, ${C.red}55 ${P(0)}%, ${C.green}55 ${P(0)}%, ${C.green} 100%)` }} />
        <div style={{ position: 'absolute', left: `${P(0)}%`, top: 2, width: 2, height: 13, background: C.text, opacity: 0.5, marginLeft: -1 }} />
        {now != null && <div style={{ position: 'absolute', left: `${P(now)}%`, top: 1, width: 14, height: 14, marginLeft: -7, borderRadius: '50%',
          background: col, border: `2px solid ${C.bg}`, boxShadow: `0 0 0 2px ${col}55` }} />}
      </div>
      <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 2, gap: 6 }}>
        <span style={{ color: C.red }}>{stop != null ? money(stop) : ''}</span>
        <span style={{ color: C.green }}>{target != null ? money(target) : ''}</span>
      </div>
    </div>
  );
}

/** Shorts, longs, the green profit zone and price — at a glance. */
function MiniStrip({ row }) {
  const ref = useRef(null);
  const [w, setW] = useState(180);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => ref.current && setW(Math.max(120, ref.current.clientWidth)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const tested = row.shorts.find(s => s.tested);
  const strip = row.legs && row.spot > 0 && row.ncdPos != null
    ? positionStrip({ legs: row.legs, spot: row.spot, ncd: row.ncdPos, testedStrike: tested ? tested.strike : null }) : null;
  if (!strip) {
    return <div ref={ref} style={{ color: C.dim, fontSize: 12 }}>{row.is45 ? 'no live price' : row.strikes.join(' / ')}</div>;
  }
  const H = 40, X = f => 4 + f * (w - 8);
  const shortOf = k => row.shorts.find(s => s.strike === k.strike && s.right === k.right);
  const uniq = [];
  strip.strikes.forEach(k => { if (!uniq.some(u => u.strike === k.strike && u.right === k.right)) uniq.push(k); });
  return (
    <div ref={ref} data-testid="board-strip">
      <svg width={w} height={H} role="img" aria-label={`${row.underlying} ${strip.spot.value} ${strip.spot.inProfit ? 'inside' : 'outside'} the break-evens`}>
        {strip.zone && <rect x={X(strip.zone.x0)} y={14} width={Math.max(1, X(strip.zone.x1) - X(strip.zone.x0))} height={10} rx="2"
          fill="rgba(63,185,80,0.18)" stroke="rgba(63,185,80,0.55)" />}
        <line x1="4" x2={w - 4} y1="19" y2="19" stroke={C.line} strokeWidth="2" />
        {uniq.map((k, i) => {
          const s2 = shortOf(k);
          const col = k.short ? (s2 && s2.tested ? C.red : s2 && s2.pressured ? C.amber : '#f0883e') : '#6e7681';
          return (
            <g key={i}>
              <rect x={X(k.x) - (k.short ? 1.75 : 1)} y={k.short ? 9 : 12} width={k.short ? 3.5 : 2} height={k.short ? 20 : 14} fill={col} rx="1" />
              {k.short && <text x={X(k.x)} y={H - 1} fontSize="10" textAnchor="middle" fill={col} fontFamily="JetBrains Mono,monospace">{k.strike}{k.right}</text>}
            </g>
          );
        })}
        <circle cx={X(strip.spot.x)} cy="19" r="5.5" fill={strip.spot.inProfit ? C.text : C.red} stroke={C.bg} strokeWidth="2" />
        <text x={Math.min(w - 20, Math.max(20, X(strip.spot.x)))} y="8" fontSize="10.5" fontWeight="700" textAnchor="middle" fill={C.text}
          fontFamily="JetBrains Mono,monospace">{strip.spot.value}</text>
      </svg>
    </div>
  );
}

function TimeRing({ row }) {
  const days = row.daysToClose != null ? row.daysToClose : row.dte;
  const label = row.daysToClose != null ? `close by ${fmtYmd(row.closeYmd)}` : row.dte != null ? (row.dte <= 0 ? 'expires today' : `expires ${fmtYmd(row.expiry)}`) : '';
  if (days == null) return <span style={{ color: C.dim, fontSize: 12 }}>—</span>;
  const span = row.planDays || (row.daysToClose != null ? Math.max(days, 1) + (row.daysHeld || 0) : Math.max(days, 1));
  const used = span ? Math.max(0.04, Math.min(1, 1 - days / span)) : 0;
  const r = 15, c = 2 * Math.PI * r;
  const col = days <= 0 ? C.red : days <= 5 ? C.amber : C.blue;
  const ev = (row.events || []).filter(e => !row.closeYmd || String(e.date || '').replace(/-/g, '') <= row.closeYmd);
  return (
    <div data-testid="board-time" style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={label}>
      <svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={r} fill="none" stroke="#21262d" strokeWidth="5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={col} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * used} ${c}`} transform="rotate(-90 20 20)" />
        <text x="20" y="24" textAnchor="middle" fontSize="11.5" fontWeight="800" fill={C.text} fontFamily="JetBrains Mono,monospace">{Math.max(0, days)}d</text>
      </svg>
      <div style={{ fontSize: 11.5, lineHeight: 1.35, color: C.grey }}>
        <div className="mono" style={{ color: col, fontWeight: 700 }}>{row.closeYmd ? fmtYmd(row.closeYmd) : fmtYmd(row.expiry)}</div>
        {ev.length > 0 && <div style={{ color: C.amber, display: 'flex', alignItems: 'center', gap: 3 }} title={ev.map(e => `${e.label} ${e.date}`).join(' · ')}>
          <Zap size={11} />{ev.slice(0, 2).map(e => shortEvent(e).split(' ')[0]).join(' ')}</div>}
      </div>
    </div>
  );
}

// The one thing to do, from the verdict. Everything else lives in the ⋯ menu.
function primaryOf(row) {
  const a = row.action;
  if (a === 'working') return { text: 'Enter fills', act: 'reconcile', col: '#bc8cff' };
  if (a === 'close' || a === 'close-or-roll') return { text: a === 'close' ? 'Close' : 'Close or roll', act: 'sell', col: C.red };
  if (a === 'take-profit') return { text: 'Take profit', act: 'sell', col: C.green };
  if (/^roll/.test(a)) return { text: 'Roll', act: 'roll', col: C.amber };
  return { text: 'Check-up', act: 'expand', col: C.blue };
}

function Menu({ row, on }) {
  const [open, setOpen] = useState(false);
  const items = [
    ['Details', 'details'], ['Edit', 'edit'],
    ...(row.working ? [['Cancel order', 'cancel']] : [['Sell', 'sell']]),
    ...(!row.working && row.is45 ? [['Roll', 'roll']] : []),
  ];
  return (
    <span style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
      <button data-testid="board-menu" onClick={() => setOpen(o => !o)} aria-label="More actions"
        style={{ padding: 6, borderRadius: 6, border: `1px solid ${C.line}`, color: C.grey, display: 'inline-flex' }}><MoreHorizontal size={16} /></button>
      {open && (
        <div style={{ position: 'absolute', right: 0, top: 34, zIndex: 30, background: C.panel, border: `1px solid ${C.line}`, borderRadius: 8,
          minWidth: 140, boxShadow: '0 8px 24px rgba(0,0,0,.5)', overflow: 'hidden' }}>
          {items.map(([t, k]) => (
            <button key={k} data-testid={`board-menu-${k}`} onClick={() => { setOpen(false); on(k, row.r); }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px', fontSize: 13, color: k === 'sell' || k === 'cancel' ? C.red : C.text }}>{t}</button>
          ))}
        </div>
      )}
    </span>
  );
}

function BoardRow({ row, on, narrow }) {
  const [open, setOpen] = useState(false);
  const pr = primaryOf(row);
  const accent = TONES[row.tone] || TONES.grey;
  const pnlCol = row.posPnl == null ? C.grey : row.posPnl >= 0 ? C.green : C.red;
  const title = (
    <div style={{ minWidth: 0 }}>
      <div data-testid="board-title" className="mono" style={{ color: '#fff', fontWeight: 800, fontSize: narrow ? 16.5 : 16, lineHeight: 1.3,
        display: 'flex', flexWrap: 'wrap', columnGap: 10 }}>
        <span style={{ whiteSpace: 'nowrap' }}>{row.underlying} {row.strikes.join('/')}</span>
        <span style={{ whiteSpace: 'nowrap' }}>{row.strategy}</span>
        <span style={{ whiteSpace: 'nowrap' }}>{row.qtyOpen} ct</span>
        {row.expiry && <span style={{ whiteSpace: 'nowrap' }}>{fmtYmd(row.expiry)}</span>}
      </div>
      <div style={{ fontSize: 12, color: row.headline ? accent : C.grey, marginTop: 2 }}>
        {row.headline || (row.working ? `order resting${row.entry ? ` · lmt ${row.entry.price.toFixed(2)}` : ''}` : row.is45 ? 'no check-up yet' : `${row.engine || ''} · ${row.entry ? `${row.entry.side} ${row.entry.price.toFixed(2)}` : ''}`)}
      </div>
    </div>
  );
  const pnl = (
    <div data-testid="board-pnl" style={{ textAlign: narrow ? 'left' : 'right' }}>
      <div className="mono" style={{ fontSize: 22, fontWeight: 800, lineHeight: 1, color: pnlCol }}>{row.posPnl != null ? money(row.posPnl) : '—'}</div>
      <div className="mono" style={{ fontSize: 11, color: C.grey, marginTop: 3, whiteSpace: 'nowrap' }}>
        {row.chain ? <>banked <span style={{ color: row.banked >= 0 ? C.green : C.red }}>{money(row.banked)}</span></> : `risk $${Math.round(row.risk).toLocaleString()}`}
      </div>
    </div>
  );
  const button = (
    <button data-testid="board-primary" onClick={e => { e.stopPropagation(); if (pr.act === 'expand') setOpen(o => !o); else on(pr.act, row.r); }}
      style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
        color: pr.act === 'expand' ? pr.col : '#0d1117', background: pr.act === 'expand' ? 'transparent' : pr.col, border: `1.5px solid ${pr.col}` }}>
      {pr.text}{pr.act === 'expand' ? (open ? ' ▴' : ' ▾') : ''}
    </button>
  );
  return (
    <div data-testid="board-row" data-action={row.action} style={{ minWidth: 0, borderRadius: 10, background: C.bg, borderTop: `1px solid ${C.line}`, borderRight: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`, borderLeft: `4px solid ${accent}` }}>
      <div onClick={() => row.check && setOpen(o => !o)} style={{ cursor: row.check ? 'pointer' : 'default', padding: narrow ? 12 : '12px 14px',
        display: 'grid', alignItems: 'center', gap: narrow ? 10 : 16,
        gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '128px minmax(220px, 1.6fr) 104px minmax(150px, 1fr) minmax(150px, 1fr) 104px auto' }}>
        {narrow ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Badge row={row} /><span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{button}<Menu row={row} on={on} /></span></div>
            {title}
            <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 14, alignItems: 'center' }}>{pnl}<MiniMeter row={row} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'center' }}><MiniStrip row={row} /><TimeRing row={row} /></div>
          </>
        ) : (
          <>
            <Badge row={row} />{title}{pnl}<MiniMeter row={row} /><MiniStrip row={row} /><TimeRing row={row} />
            <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>{button}<Menu row={row} on={on} /></span>
          </>
        )}
      </div>
      {open && row.check && (
        <div data-testid="board-checkup" style={{ padding: '0 10px 10px' }}><CheckupCard row={row.check} /></div>
      )}
    </div>
  );
}

/**
 * @param rows      board rows (boardRow output), any order
 * @param on        (action, openRow) — details | edit | sell | roll | cancel | reconcile
 */
export default function PositionBoard({ rows, on, cap = null, checkedAt = null, checking = false, onRecheck, checkErr = '' }) {
  const ref = useRef(null);
  const [w, setW] = useState(1200);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => ref.current && setW(ref.current.clientWidth));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  const narrow = w < 900;
  const sorted = [...rows].sort((a, b) => (URGENCY[a.action] ?? 9) - (URGENCY[b.action] ?? 9) || (a.daysToClose ?? a.dte ?? 99) - (b.daysToClose ?? b.dte ?? 99));
  const live = rows.filter(r => r.posPnl != null);
  const pnl = live.reduce((a, r) => a + r.posPnl, 0);
  const risk = rows.reduce((a, r) => a + r.risk, 0);
  const banked = rows.reduce((a, r) => a + r.banked, 0);
  const act = rows.filter(r => needsAction(r.action) || r.action === 'watch').length;
  const Stat = ({ k, v, col, testid, sub }) => (
    <div data-testid={testid} style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey }}>{k}</span>
      <span className="mono" style={{ fontSize: 18, fontWeight: 800, color: col || C.text }}>{v}{sub && <span style={{ fontSize: 11.5, color: C.grey, fontWeight: 500 }}> {sub}</span>}</span>
    </div>
  );
  return (
    <div className="card" ref={ref} data-testid="position-board">
      <div style={{ display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap', gap: narrow ? 14 : 28, marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.text, alignSelf: 'center' }}>Open positions <span style={{ color: C.grey, fontWeight: 400 }}>· {rows.length}</span></span>
        <Stat k="Open P&L" testid="board-total-pnl" v={live.length ? money(pnl) : '—'} col={!live.length ? C.grey : pnl >= 0 ? C.green : C.red}
          sub={live.length && live.length < rows.length ? `${live.length} of ${rows.length} priced` : ''} />
        <Stat k="Risk" testid="board-total-risk" v={`$${Math.round(risk).toLocaleString()}`} sub={cap ? `of $${Number(cap).toLocaleString()} · ${Math.round(risk / cap * 100)}%` : ''} />
        {banked !== 0 && <Stat k="Banked" v={money(banked)} col={banked >= 0 ? C.green : C.red} />}
        {act > 0 && (
          <span data-testid="board-attention" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: C.amber, fontWeight: 700, fontSize: 13, alignSelf: 'center' }}>
            <AlertTriangle size={15} /> {act} need{act === 1 ? 's' : ''} a look
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12, color: C.grey, alignSelf: 'center' }}>
          {checkErr ? <span style={{ color: C.amber }}>{checkErr}</span> : checkedAt ? <>checked {checkedAt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })}</> : null}
          {onRecheck && <button onClick={onRecheck} disabled={checking} data-testid="board-recheck" title="Re-run the check-up"
            style={{ display: 'inline-flex', padding: 5, borderRadius: 6, border: `1px solid ${C.line}`, color: C.blue }}>
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} /></button>}
        </span>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        {sorted.map(row => <BoardRow key={row.key} row={row} on={on} narrow={narrow} />)}
      </div>
    </div>
  );
}
