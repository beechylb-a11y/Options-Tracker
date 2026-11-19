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
import { alpha } from '../utils/theme';
import { accountColor, accountName, useAccountsList } from '../utils/accountColors';
import { recordMarks } from '../live/markLog';

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
// liveMark: the legs' value now from the push stream (Σ qty × mid per share); when
// given, the P&L is re-marked with it between check-ups. (Nov 2026.)
export function boardRow(r, { chain = null, expiry = null, check = null, liveMark = null } = {}) {
  const pos = normalisePosition(r);
  // Only a ticket with NOTHING filled is "working". A part-filled one is a live
  // position for the contracts that filled, plus an order still resting for the rest —
  // IWM showed WORKING, "order resting", no P&L with 7 of 9 contracts on. (Oct 2026.)
  const qf = r.qtyFilled === '' || r.qtyFilled == null ? null : n(r.qtyFilled);
  const working = r.status === STATUS.WORKING || (r.status === STATUS.PART_FILLED && !(qf > 0));
  const resting = qf != null ? Math.max(0, n(r.qty) - qf) : 0;
  const rv = check && check.review;
  const m = (rv && rv.metrics) || {};
  const action = working ? 'working' : rv && rv.action !== 'unknown' ? rv.action : (rv ? 'unknown' : 'open');
  const tone = working ? 'purple' : rv ? rv.tone : 'grey';
  const label = working ? 'Working' : action === 'open' ? 'Open' : ACTION_LABEL[action] || action;
  const banked = (chain ? chain.banked : 0) + n(r.realisedPnl);
  const qOpen = n(r.qtyOpen) || n(r.qty);
  const live$ = liveMark != null && m.ncd != null && qOpen > 0 && !working ? Math.round((liveMark + m.ncd) * 100 * qOpen) : null;
  const ticketPnl = live$ != null ? live$ : m.pnl$ != null ? m.pnl$ : null;
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
    key: r.ticketRef, r, check, action, tone, label, account: r.account || '',
    startYmd: (expiry && expiry.startYmd) || (r.entryDate ? String(r.entryDate).slice(0, 10).replace(/-/g, '') : null), headline: rv && rv.action !== 'unknown' ? rv.headline : null,
    underlying: pos.underlying, strikes: parseStrikes(r.legs || ''), strategy, qtyOpen, qty: n(r.qty),
    engine: pos.engine, is45: /45/.test(pos.engine || ''), is0: /0DTE/i.test(pos.engine || ''), resting,
    minutesToExit: m.minutesToExit, exitEt: m.exitEt, minutesToBell: m.minutesToBell, minutesToLastCall: m.minutesToLastCall, settle: m.settle, phase: m.phase,
    expiry: exp, dte, closeYmd, daysToClose, daysHeld: m.daysHeld, planDays: m.planDays, events: m.events || [],
    banked, chain, ticketPnl, posPnl: ticketPnl != null ? ticketPnl + banked : null, pnlSource: live$ != null ? 'stream' : m.pnl$ != null ? 'check-up' : null,
    // The check-up's own numbers when it ran (so this row and the card under it are
    // the same figures); the shared exit lines otherwise. Both read the same entry
    // and the same saved plan.
    stop: m.stop$ != null ? banked + m.stop$ : st ? banked + st.loss : null,
    target: m.target$ != null ? banked + m.target$ : tg ? banked + tg.gain : null, stopLine: st, targetLine: tg,
    entry: entryOf(r), risk: liveRiskOf(r), working,
    legs: check && check.legs, spot: check && check.spot, shorts: m.shorts || [], ncdPos,
    nextStep: rv && rv.steps && rv.steps[0],
    // Why there is no verdict, in words ("no quote for 762C"), and TWS holding the
    // position at other strikes than the ticket says. (Nov 2026.)
    quoteErr: check && check.quoteErr ? check.quoteErr : null,
    mismatch: check && check.mismatch ? check.mismatch : null,
  };
}

const TONES = { green: C.green, amber: C.amber, red: C.red, grey: 'var(--c-a8b2be)', purple: 'var(--c-bc8cff)' };

function Badge({ row }) {
  if (row.action === 'working' || row.action === 'open') {
    const fg = TONES[row.tone] || TONES.grey;
    return (
      <span data-testid="board-action" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8,
        fontWeight: 800, fontSize: 13, letterSpacing: '.03em', textTransform: 'uppercase', color: fg, background: alpha(fg, '1f'), border: `1.5px solid ${fg}` }}>
        {row.action === 'working' ? <Hourglass size={15} strokeWidth={2.5} /> : null}{row.label}
      </span>
    );
  }
  return <span data-testid="board-action"><ActionBadge action={row.action} tone={row.tone} label={row.label} /></span>;
}

/**
 * P&L toward the exit lines, whole position (Nov 2026). Zero sits in the middle: the
 * left half fills toward the stop, the right half toward the target, each to its own
 * scale, with the share of the way written beside the number. No fill when unpriced.
 */
export function exitProgress(now, stop, target) {
  if (now == null) return null;
  if (now >= 0) return target != null && target > 0 ? { side: 'target', frac: Math.min(1, now / target) } : null;
  return stop != null && stop < 0 ? { side: 'stop', frac: Math.min(1, now / stop) } : null;
}
function ExitMeter({ row, narrow }) {
  const { posPnl: now, stop, target } = row;
  const pg = exitProgress(now, stop, target);
  const col = now == null ? C.grey : now >= 0 ? C.green : C.red;
  const half = 50;
  const x0 = pg ? (pg.side === 'target' ? half : half - pg.frac * half) : half;
  const x1 = pg ? (pg.side === 'target' ? half + pg.frac * half : half) : half;
  return (
    <div data-testid="board-pnl" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="mono" data-testid="board-pnl-value" data-source={row.pnlSource || ''}
          title={row.pnlSource === 'stream' ? 'Marked live from the TWS stream' : row.pnlSource === 'check-up' ? 'From the last check-up' : ''}
          style={{ fontSize: narrow ? 20 : 21, fontWeight: 800, lineHeight: 1, color: col }}>{now != null ? money(now) : '—'}</span>
        <span data-testid="board-progress" style={{ fontSize: 12, color: C.grey, whiteSpace: 'nowrap' }}>
          {pg ? `${Math.round(pg.frac * 100)}% to ${pg.side}` : row.chain ? <>banked <span style={{ color: row.banked >= 0 ? C.green : C.red }}>{money(row.banked)}</span></> : `risk $${Math.round(row.risk).toLocaleString()}`}
        </span>
      </div>
      {stop == null && target == null ? <span style={{ color: C.dim, fontSize: 12 }}>no exit plan</span> : (
        <div data-testid="board-meter" title={`stop ${money(stop)} · now ${money(now)} · target ${money(target)} — whole position`}>
          <div style={{ position: 'relative', height: 16 }}>
            <div style={{ position: 'absolute', left: 0, width: '50%', top: 5, height: 6, borderRadius: 3, background: alpha(C.red, '38') }} />
            <div style={{ position: 'absolute', left: '50%', right: 0, top: 5, height: 6, borderRadius: 3, background: alpha(C.green, '38') }} />
            {pg && <div style={{ position: 'absolute', left: `${x0}%`, width: `${Math.max(1, x1 - x0)}%`, top: 5, height: 6, borderRadius: 3, background: col }} />}
            <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: 16, marginLeft: -1, background: C.text, opacity: 0.7 }} />
            {pg && <div style={{ position: 'absolute', left: `${pg.side === 'target' ? x1 : x0}%`, top: 1, width: 14, height: 14, marginLeft: -7, borderRadius: '50%',
              background: '#ffffff', border: `3px solid ${col}`, boxSizing: 'border-box' }} />}
          </div>
          <div className="mono" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginTop: 2, gap: 6, color: C.grey }}>
            <span>{stop != null ? `stop ${money(stop)}` : ''}</span>
            <span>{target != null ? `target ${money(target)}` : ''}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * How far price is from trouble, in one line (Nov 2026). A credit position measures to
 * its nearest short strike (where tastylive-style management starts); a debit one to
 * its nearest break-even. Positive = the safe side.
 */
export function cushionOf({ legs, spot, credit, breakevens = [] }) {
  const s = Number(spot);
  if (!(s > 0)) return null;
  const pct = d => (Math.abs(d) / s * 100).toFixed(1);
  if (credit) {
    const shorts = (legs || []).filter(l => l.qty < 0 && (l.right === 'P' || l.right === 'C'));
    if (!shorts.length) return null;
    const ds = shorts.map(l => ({ l, d: l.right === 'P' ? s - l.strike : l.strike - s })).sort((a, b) => a.d - b.d);
    const { l, d } = ds[0];
    const name = `${l.strike}${l.right}`;
    return d >= 0
      ? { ok: true, text: `${d.toFixed(2)} ${l.right === 'P' ? 'above' : 'below'} the ${name} · ${pct(d)}%` }
      : { ok: false, text: `${Math.abs(d).toFixed(2)} through the ${name} · ${pct(d)}%` };
  }
  if (!breakevens.length) return null;
  const b = [...breakevens].sort((x, y) => Math.abs(s - x) - Math.abs(s - y))[0];
  const lo = Math.min(...breakevens), hi = Math.max(...breakevens);
  const inside = breakevens.length >= 2 ? s >= lo && s <= hi : null;
  const d = Math.abs(s - b);
  return { ok: inside !== false, text: `${d.toFixed(2)} ${inside === false ? 'outside' : 'from'} the ${b.toFixed(2)} break-even · ${pct(d)}%` };
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
  const cush = cushionOf({ legs: row.legs, spot: strip.spot.value, credit: row.ncdPos != null && row.ncdPos > 0, breakevens: strip.breakevens.map(b => b.value) });
  return (
    <div ref={ref} data-testid="board-strip">
      <svg width={w} height={H} role="img" aria-label={`${row.underlying} ${strip.spot.value} ${strip.spot.inProfit ? 'inside' : 'outside'} the break-evens`}>
        {strip.zone && <rect x={X(strip.zone.x0)} y={14} width={Math.max(1, X(strip.zone.x1) - X(strip.zone.x0))} height={10} rx="2"
          fill="color-mix(in srgb, var(--c-3fb950) 18%, transparent)" stroke="color-mix(in srgb, var(--c-3fb950) 55%, transparent)" />}
        <line x1="4" x2={w - 4} y1="19" y2="19" stroke={C.line} strokeWidth="2" />
        {uniq.map((k, i) => {
          const s2 = shortOf(k);
          const col = k.short ? (s2 && s2.tested ? C.red : s2 && s2.pressured ? C.amber : 'var(--c-f0883e)') : 'var(--c-6e7681)';
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
      {cush && <div data-testid="board-cushion" className="mono" style={{ fontSize: 11.5, color: cush.ok ? C.grey : C.red, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{cush.text}</div>}
    </div>
  );
}

// 0DTE: hours to the 15:00 exit (to the bell once past it), and how it settles.
function ClockRing0({ row }) {
  const toExit = row.minutesToExit, toBell = row.minutesToBell;
  const pastExit = toExit != null && toExit <= 0;
  // Past 15:00 the clock runs to the last moment to act: 15:45 for anything that
  // settles into shares, the bell for cash-settled.
  const toEnd = row.settle === 'shares' ? row.minutesToLastCall : toBell;
  const mins = toExit == null ? null : pastExit ? Math.max(0, toEnd ?? toBell) : toExit;
  const r = 15, c = 2 * Math.PI * r;
  const used = mins == null ? 0 : Math.max(0.04, Math.min(1, 1 - mins / (pastExit ? (row.settle === 'shares' ? 45 : 60) : 330)));
  const col = mins == null ? C.grey : pastExit || mins <= 30 ? (row.settle === 'shares' && pastExit ? C.red : C.amber) : C.blue;
  const txt = mins == null ? '0d' : mins >= 60 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
  return (
    <div data-testid="board-time" style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      title={row.settle === 'cash' ? 'Cash settled — no assignment' : row.settle === 'shares' ? 'Settles into shares — close by 15:45' : ''}>
      <svg width="40" height="40" viewBox="0 0 40 40">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--c-21262d)" strokeWidth="5" />
        <circle cx="20" cy="20" r={r} fill="none" stroke={col} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${c * used} ${c}`} transform="rotate(-90 20 20)" />
        <text x="20" y="24" textAnchor="middle" fontSize={txt.length > 3 ? 10 : 11.5} fontWeight="800" fill={C.text} fontFamily="JetBrains Mono,monospace">{txt}</text>
      </svg>
      <div style={{ fontSize: 11.5, lineHeight: 1.35, color: C.grey }}>
        <div className="mono" style={{ color: col, fontWeight: 700 }}>{pastExit ? (row.exitEt && row.exitEt !== '15:00' ? `past ${row.exitEt} exit` : row.settle === 'shares' ? 'out by 15:45' : 'bell 16:00') : `exit ${row.exitEt || '15:00'}`}</div>
        <div>{row.settle === 'cash' ? 'cash settled' : row.settle === 'shares' ? 'into shares' : ''}</div>
      </div>
    </div>
  );
}

/**
 * Open → today → manage line → expiry on one bar (Nov 2026), with the trade's events
 * as diamonds. Replaces the ring, which showed days left but not where in the trade
 * you are or what comes before expiry.
 */
export function timelineOf(row, todayYmd) {
  if (!row.expiry || !row.startYmd) return null;
  const total = daysBetweenYmd(row.startYmd, row.expiry);
  if (!(total > 0)) return null;
  const at = y => Math.max(0, Math.min(1, daysBetweenYmd(row.startYmd, y) / total));
  const evYmd = e => String(e.date || '').slice(0, 10).replace(/-/g, '');
  return {
    now: at(todayYmd),
    manage: row.closeYmd ? at(row.closeYmd) : null,
    managePassed: row.closeYmd ? todayYmd >= row.closeYmd : false,
    events: (row.events || []).filter(e => /^\d{8}$/.test(evYmd(e)) && evYmd(e) >= row.startYmd && evYmd(e) <= row.expiry)
      .map(e => ({ x: at(evYmd(e)), label: `${e.label || shortEvent(e)} ${fmtYmd(evYmd(e))}` })),
  };
}
function TimeRing({ row }) {
  if (row.is0) return <ClockRing0 row={row} />;
  const days = row.dte;
  if (days == null) return <span style={{ color: C.dim, fontSize: 12 }}>—</span>;
  const tl = timelineOf(row, tradingSession().yyyymmdd);
  const toClose = row.daysToClose;
  const col = days <= 0 || (toClose != null && toClose < 0) ? C.red : toClose != null && toClose <= 5 ? C.amber : TONES[row.tone] && row.tone !== 'grey' ? TONES[row.tone] : C.blue;
  const sub = row.closeYmd ? (toClose != null && toClose < 0 ? 'past the manage line' : `manage ${fmtYmd(row.closeYmd)}`) : `expires ${fmtYmd(row.expiry)}`;
  return (
    <div data-testid="board-time" style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}
      title={(row.events || []).map(e => `${e.label} ${e.date}`).join(' · ')}>
      <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: C.text }}>{days <= 0 ? 'expires today' : `${days}d left`}</span>
      {tl && (
        <div style={{ position: 'relative', height: 18 }}>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 8, height: 5, borderRadius: 3, background: 'var(--c-30363d)' }} />
          <div style={{ position: 'absolute', left: 0, width: `${Math.max(2, tl.now * 100)}%`, top: 8, height: 5, borderRadius: 3, background: col }} />
          {tl.manage != null && <div title="21 DTE manage line" style={{ position: 'absolute', left: `${tl.manage * 100}%`, top: 3, width: 2, height: 15, marginLeft: -1, background: C.text, opacity: tl.managePassed ? 0.4 : 0.9 }} />}
          {tl.events.map((e, i) => <div key={i} title={e.label} style={{ position: 'absolute', left: `${e.x * 100}%`, top: 0, width: 7, height: 7, marginLeft: -3.5, background: C.amber, transform: 'rotate(45deg)' }} />)}
          <div style={{ position: 'absolute', left: `${tl.now * 100}%`, top: 4, width: 12, height: 12, marginLeft: -6, borderRadius: '50%', background: '#ffffff', border: `3px solid ${col}`, boxSizing: 'border-box' }} />
        </div>
      )}
      <span className="mono" style={{ fontSize: 11.5, color: toClose != null && toClose < 0 ? C.amber : C.grey, whiteSpace: 'nowrap' }}>{sub}</span>
    </div>
  );
}

// The one thing to do, from the verdict. Everything else lives in the ⋯ menu.
function primaryOf(row) {
  const a = row.action;
  if (a === 'working') return { text: 'Enter fills', act: 'reconcile', col: 'var(--c-bc8cff)' };
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
    ...(!row.working && row.resting > 0 ? [['Enter fills', 'reconcile']] : []),
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

// The 0DTE check-up, opened under its row: the verdict's advice — what the clock and
// the settlement style mean for this position right now.
function Card0({ row }) {
  const rv = row.check && row.check.review;
  if (!rv) return null;
  const m = rv.metrics || {};
  const col = TONES[rv.tone] || TONES.grey;
  return (
    <div data-testid="card0" style={{ border: `1px solid ${C.line}`, borderLeft: `4px solid ${col}`, borderRadius: 10, padding: 12, background: C.panel }}>
      <div style={{ color: col, fontWeight: 700, fontSize: 14 }}>{rv.headline}</div>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13, color: 'var(--c-c9d1d9)', lineHeight: 1.5 }}>
        {rv.steps.map((t, i) => <li key={i}>{t}</li>)}
      </ul>
      <div className="mono" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: C.grey, marginTop: 8 }}>
        {m.closePrice != null && <span>close now @{m.closePrice.toFixed(2)} {m.isCredit ? 'db' : 'cr'}</span>}
        {m.atExpiry$ != null && <span>if it settles here {m.atExpiry$ >= 0 ? '+' : '−'}${Math.abs(m.atExpiry$).toLocaleString()}</span>}
        {m.max$ != null && <span>max +${m.max$.toLocaleString()}</span>}
        <span>{m.settle === 'cash' ? 'cash settled' : 'settles into shares'}</span>
      </div>
    </div>
  );
}

function BoardRow({ row, on, narrow, accounts }) {
  const [open, setOpen] = useState(false);
  const pr = primaryOf(row);
  const accent = TONES[row.tone] || TONES.grey;
  const acctCol = accountColor(row.account, accounts);
  const multi = (accounts || []).length > 1;
  // Two lines (Nov 2026): what it is, then the contract — strikes, size, expiry.
  const title = (
    <div style={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 12 }}>
      <span aria-hidden="true" data-testid="board-symbol" style={{ flex: 'none', width: 40, height: 40, borderRadius: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#f1e4d6', color: '#1f1e1c', fontWeight: 700, fontSize: 11.5, boxShadow: `0 0 0 3px ${acctCol}`, marginTop: 2 }}>{String(row.underlying || '').slice(0, 4)}</span>
      <div style={{ minWidth: 0 }}>
        <div data-testid="board-title" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, lineHeight: 1.25 }}>
          <span style={{ color: 'var(--c-ffffff)', fontWeight: 800, fontSize: narrow ? 17 : 17.5 }}>{row.underlying}</span>
          <span style={{ color: C.text, fontWeight: 500, fontSize: 14.5 }}>{row.strategy}</span>
        </div>
        <div data-testid="board-spec" className="mono" style={{ fontSize: 13, color: 'var(--c-c9d1d9)', marginTop: 2 }}>
          {row.strikes.join(' / ')} · {row.qtyOpen} ct{row.expiry ? ` · ${fmtYmd(row.expiry)}` : ''}
          {row.chain && <span data-testid="board-banked"> · banked <span style={{ color: row.banked >= 0 ? C.green : C.red }}>{money(row.banked)}</span></span>}
        </div>
        {multi && row.account && (
          <div data-testid="board-account" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: acctCol, marginTop: 3 }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: acctCol }} />{accountName(row.account, accounts)}
          </div>
        )}
        <div style={{ fontSize: 12, color: row.headline ? accent : C.grey, marginTop: 3 }}>
          {row.headline || (row.working ? `order resting${row.entry ? ` · lmt ${row.entry.price.toFixed(2)}` : ''}`
            : row.quoteErr ? <span data-testid="board-quote-err" style={{ color: C.amber }}>{row.quoteErr}</span>
            : row.check ? ((row.check.review && row.check.review.headline) || 'no live quote') : (row.is45 || row.is0) ? 'checking…' : 'no live check')}
          {!row.working && row.resting > 0 && (
            <span data-testid="board-resting" style={{ marginLeft: 8, padding: '1px 7px', whiteSpace: 'nowrap', display: 'inline-block', borderRadius: 5, fontSize: 11, fontWeight: 700, color: 'var(--c-bc8cff)', border: '1px solid var(--c-8957e5)' }}>+{row.resting} resting</span>
          )}
        </div>
        {row.mismatch && (
          <div data-testid="board-mismatch" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 5, fontSize: 12, color: C.amber }}>
            <span className="mono" style={{ whiteSpace: "nowrap" }}>⚠ TWS {row.mismatch.tws} ≠ ticket {row.mismatch.ticket}</span>
            <button data-testid="board-fix-strikes" onClick={e => { e.stopPropagation(); on('fix-strikes', row.r, row.mismatch); }}
              style={{ padding: '2px 8px', borderRadius: 6, fontSize: 11.5, fontWeight: 700, color: C.amber, background: 'transparent', border: `1px solid ${C.amber}` }}>
              Fix ticket
            </button>
          </div>
        )}
      </div>
    </div>
  );
  const button = (
    <button data-testid="board-primary" onClick={e => { e.stopPropagation(); if (pr.act === 'expand') setOpen(o => !o); else on(pr.act, row.r); }}
      style={{ padding: '7px 12px', borderRadius: 8, fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap',
        color: pr.act === 'expand' ? pr.col : 'var(--c-on-accent)', background: pr.act === 'expand' ? 'transparent' : pr.col, border: `1.5px solid ${pr.col}` }}>
      {pr.text}{pr.act === 'expand' ? (open ? ' ▴' : ' ▾') : ''}
    </button>
  );
  return (
    <div data-testid="board-row" data-action={row.action} style={{ minWidth: 0, borderRadius: 10, background: C.bg, borderTop: `1px solid ${C.line}`, borderRight: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}`, borderLeft: `4px solid ${accent}` }}>
      <div onClick={() => row.check && setOpen(o => !o)} style={{ cursor: row.check ? 'pointer' : 'default', padding: narrow ? 12 : '12px 14px',
        display: 'grid', alignItems: 'center', gap: narrow ? 10 : 16,
        gridTemplateColumns: narrow ? 'minmax(0, 1fr)' : '120px minmax(230px, 1.5fr) minmax(170px, 1fr) minmax(170px, 1fr) minmax(140px, 0.8fr) auto' }}>
        {narrow ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Badge row={row} /><span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>{button}<Menu row={row} on={on} /></span></div>
            {title}
            <ExitMeter row={row} narrow />
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 14, alignItems: 'center' }}><MiniStrip row={row} /><TimeRing row={row} /></div>
          </>
        ) : (
          <>
            <Badge row={row} />{title}<ExitMeter row={row} /><MiniStrip row={row} /><TimeRing row={row} />
            <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>{button}<Menu row={row} on={on} /></span>
          </>
        )}
      </div>
      {open && row.check && (
        <div data-testid="board-checkup" style={{ padding: '0 10px 10px' }}>{row.is0 ? <Card0 row={row} /> : <CheckupCard row={row.check} />}</div>
      )}
    </div>
  );
}

/**
 * Rows by account, in the Settings order, each group keeping its urgency order (Nov
 * 2026). One account (or none tagged) → a single untitled group.
 */
export function groupByAccount(rows, accounts = []) {
  const ids = [...new Set(rows.map(r => r.account || ''))];
  if (ids.length <= 1) return [{ id: null, rows }];
  const order = id => { const i = accounts.findIndex(a => a.id === id); return i < 0 ? 999 : i; };
  return ids.sort((a, b) => order(a) - order(b)).map(id => {
    const rs = rows.filter(r => (r.account || '') === id);
    const live = rs.filter(r => r.posPnl != null);
    return { id, rows: rs, pnl: live.length ? live.reduce((t, r) => t + r.posPnl, 0) : null, priced: live.length,
      risk: rs.reduce((t, r) => t + r.risk, 0) };
  });
}
function GroupHead({ g, accounts }) {
  const a = accounts.find(x => x.id === g.id);
  const col = accountColor(g.id, accounts);
  const bank = a ? Number(a.bankroll) || 0 : 0;
  const cap = a ? Number(a.maxOpenRisk) || 0 : 0;
  return (
    <div data-testid="board-group-head" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 18px', padding: '2px 4px' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 700, color: C.text }}>
        <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 6, background: col }} />{g.id ? accountName(g.id, accounts) : 'No account'}
        <span style={{ fontWeight: 400, color: C.grey }}>· {g.rows.length} open</span>
      </span>
      <span className="mono" style={{ fontSize: 14, fontWeight: 800, color: g.pnl == null ? C.grey : g.pnl >= 0 ? C.green : C.red }}>{g.pnl == null ? '—' : money(g.pnl)}</span>
      <span className="mono" style={{ fontSize: 12.5, color: C.grey }}>
        risk ${Math.round(g.risk).toLocaleString()}{cap ? ` of $${Math.round(cap).toLocaleString()} cap` : ''}{bank ? ` · ${(g.risk / bank * 100).toFixed(0)}% of bank` : ''}
      </span>
      {cap > 0 && (
        <span aria-hidden="true" style={{ position: 'relative', flex: '1 1 120px', maxWidth: 220, height: 5, borderRadius: 3, background: 'var(--c-30363d)' }}>
          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${Math.min(100, g.risk / cap * 100)}%`, borderRadius: 3, background: g.risk > cap ? C.red : col }} />
        </span>
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
  const accounts = useAccountsList();
  // Keep today's position P&L per ticket, for the Dashboard tile's day-by-day colours.
  const markSig = rows.map(r => `${r.key}:${r.posPnl == null ? '' : Math.round(r.posPnl)}`).join('|');
  useEffect(() => { recordMarks(rows, tradingSession().yyyymmdd); }, [markSig]);   // eslint-disable-line react-hooks/exhaustive-deps
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
      {groupByAccount(sorted, accounts).map(g => (
        <div key={g.id || 'one'} data-testid={g.id != null ? 'board-group' : undefined} style={{ display: 'grid', gap: 8, marginTop: g.id != null ? 14 : 0 }}>
          {g.id != null && <GroupHead g={g} accounts={accounts} narrow={narrow} />}
          {g.rows.map(row => <BoardRow key={row.key} row={row} on={on} narrow={narrow} accounts={accounts} />)}
        </div>
      ))}
    </div>
  );
}
