import React, { useEffect, useMemo, useState } from 'react';
import { fmt$ } from '../utils/format';
import { COL, nyISODate, todayPnlOf } from '../utils/stats';
import { closedPnlEvents, journalSummary } from '../utils/benchmark';
import { DEFAULT_WATCHLIST, loadWatchlist } from '../utils/watchlist';
import { useLiveQuote } from '../live/useLive';

// Vision Dashboard top row (Nov 2026): three headline cards over the boards that were
// already there. Every number comes from a helper another screen already uses, so
// nothing here can disagree with the header, the Journal or the Engine:
//   P&L today  — todayPnlOf (the header's "Today"), last 7 trading days as bars
//   This month — journalSummary (the Journal's month vs benchmark), as a ring
//   Watching   — the watchlist's pinned / 0DTE symbols, live from the TWS stream

const DAYS = 7;

/** Closed P&L per NY trading day, oldest first, for the last `n` days that had trades
 *  plus today (so today always shows, even before the first close). */
export function recentDays(closedTrades, n = DAYS, now = new Date()) {
  const by = {};
  for (const t of closedTrades) {
    const d = String(t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').split('T')[0];
    if (!d) continue;
    by[d] = (by[d] || 0) + (parseFloat(t[COL.TOTAL_PNL]) || 0);
  }
  const today = nyISODate(now);
  if (!(today in by)) by[today] = 0;
  return Object.keys(by).filter(d => d <= today).sort().slice(-n).map(d => ({ date: d, pnl: Math.round(by[d] * 100) / 100, today: d === today }));
}

/** Month-to-date P&L against the monthly target, as the ring reads it. */
export function monthRing(summary) {
  const m = summary && summary.month;
  if (!m) return { pnl: 0, target: 0, frac: 0, pct: null };
  const target = m.targetAmt > 0 ? m.targetAmt : 0;
  const frac = target > 0 ? Math.max(0, Math.min(1, m.pnl / target)) : 0;
  return { pnl: m.pnl, target, frac, pct: target > 0 ? (m.pnl / target) * 100 : null, targetPct: m.targetPct, trades: m.trades, wins: m.wins, losses: m.losses };
}

/** The symbols the Watching card shows: pinned first, then the rest of the 0DTE list. */
export function watchSymbols(list, max = 5) {
  const items = (list && list.items) || [];
  const pinned = items.filter(i => i.pin).map(i => i.sym);
  const rest = items.filter(i => !i.pin && i.on0).map(i => i.sym);
  return [...new Set([...pinned, ...rest])].slice(0, max);
}

function Ring({ frac, size = 132, children }) {
  const r = (size - 14) / 2, c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="12" />
        {frac > 0 && <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#vis-ring-blue)" strokeWidth="12" strokeLinecap="round"
          strokeDasharray={`${(c * frac).toFixed(1)} ${c.toFixed(1)}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />}
        <defs><linearGradient id="vis-ring-blue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a9cdff" /><stop offset="1" stopColor="#3d82f0" /></linearGradient></defs>
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>{children}</div>
    </div>
  );
}

function DayBars({ days }) {
  const max = Math.max(1, ...days.map(d => Math.abs(d.pnl)));
  return (
    <div data-testid="vis-day-bars" style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 72 }}>
      {days.map(d => {
        const h = Math.max(4, Math.round(Math.abs(d.pnl) / max * 64));
        const bg = d.today ? 'linear-gradient(180deg,#a9cdff,#3d82f0)'
          : d.pnl < 0 ? 'linear-gradient(180deg, rgba(255,179,171,0.75), rgba(255,179,171,0.25))'
          : 'linear-gradient(180deg, rgba(255,255,255,0.55), rgba(255,255,255,0.10))';
        const day = new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', timeZone: 'UTC' });
        return (
          <div key={d.date} title={`${d.date}: ${fmt$(d.pnl)}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <span style={{ width: '100%', maxWidth: 16, height: h, borderRadius: 8, background: bg }} />
            <span style={{ fontSize: 11.5, color: 'var(--c-a8b2be)' }}>{d.today ? 'Today' : day}</span>
          </div>
        );
      })}
    </div>
  );
}

function WatchTile({ sym }) {
  const q = useLiveQuote(sym);
  const px = q && (q.last ?? q.mark);
  const chg = px != null && q.close ? (px / q.close - 1) * 100 : null;
  return (
    <div data-testid={`vis-watch-${sym}`} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 4px' }}>
      <span aria-hidden="true" style={{ width: 40, height: 40, borderRadius: 20, flex: 'none', display: 'grid', placeItems: 'center', fontSize: 11.5, fontWeight: 700,
        color: '#1c1b19', background: 'linear-gradient(160deg, rgba(255,255,255,0.92), rgba(255,255,255,0.62))' }}>{sym.slice(0, 4)}</span>
      <span style={{ fontSize: 15, fontWeight: 600 }}>{sym}</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 15, fontWeight: 600 }}>{px != null ? Number(px).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</span>
      <span style={{ minWidth: 62, textAlign: 'right', fontSize: 12.5, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
        color: chg == null ? 'var(--c-a8b2be)' : chg >= 0 ? 'var(--c-3fb950)' : 'var(--c-f85149)',
        background: chg == null ? 'transparent' : chg >= 0 ? 'rgba(134,239,172,0.14)' : 'rgba(255,179,171,0.14)' }}>
        {chg == null ? 'no quote' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
      </span>
    </div>
  );
}

export default function VisionDashHero({ closedTrades, tracker, decisions, account, accounts }) {
  const [watch, setWatch] = useState(DEFAULT_WATCHLIST);
  useEffect(() => { let live = true; loadWatchlist().then(r => { if (live && r && r.list) setWatch(r.list); }).catch(() => {}); return () => { live = false; }; }, []);
  const today = useMemo(() => todayPnlOf(closedTrades), [closedTrades]);
  const todayCount = useMemo(() => { const d = nyISODate(); return closedTrades.filter(t => String(t[COL.CLOSE_DATE] || t[COL.ENTRY_DATE] || '').startsWith(d)).length; }, [closedTrades]);
  const days = useMemo(() => recentDays(closedTrades), [closedTrades]);
  const ring = useMemo(() => {
    const now = new Date();
    return monthRing(journalSummary(account, accounts, closedPnlEvents(tracker, decisions), now.getFullYear(), now.getMonth()));
  }, [account, accounts, tracker, decisions]);
  const syms = watchSymbols(watch);
  const label = { fontSize: 13, color: 'var(--c-a8b2be)' };
  const monthName = new Date().toLocaleDateString('en-AU', { month: 'long' });

  return (
    <div data-testid="vis-hero" className="vis-hero">
      <section className="card" data-testid="vis-today">
        <span style={label}>P&amp;L today</span>
        <span data-testid="vis-today-value" style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.1,
          color: today > 0 ? 'var(--c-3fb950)' : today < 0 ? 'var(--c-f85149)' : 'var(--c-ffffff)' }}>{fmt$(today)}</span>
        <span style={{ ...label, marginTop: -4 }}>closed today · {todayCount} trade{todayCount === 1 ? '' : 's'}</span>
        <div style={{ flex: 1 }} />
        <DayBars days={days} />
      </section>

      <section className="card" data-testid="vis-month">
        <span style={label}>{monthName} vs target</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flex: 1 }}>
          <Ring frac={ring.frac}>
            <span data-testid="vis-month-pct" style={{ fontSize: 28, fontWeight: 600, lineHeight: 1 }}>{ring.pct == null ? '—' : `${Math.round(ring.pct)}%`}</span>
            <span style={{ fontSize: 11.5, color: 'var(--c-a8b2be)', marginTop: 4 }}>of target</span>
          </Ring>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <span data-testid="vis-month-pnl" style={{ fontSize: 28, fontWeight: 600, color: ring.pnl > 0 ? 'var(--c-3fb950)' : ring.pnl < 0 ? 'var(--c-f85149)' : 'var(--c-ffffff)' }}>{fmt$(ring.pnl)}</span>
            <span style={label}>{ring.target > 0 ? `of ${fmt$(ring.target)} (${Number(ring.targetPct || 0).toFixed(0)}% a month)` : 'no target set'}</span>
            <span style={label}>{ring.trades || 0} closed · {ring.wins || 0}W / {ring.losses || 0}L</span>
          </div>
        </div>
      </section>

      <section className="card" data-testid="vis-watching">
        <span style={label}>Watching</span>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {syms.length ? syms.map(s => <WatchTile key={s} sym={s} />) : <span style={label}>Nothing on the watchlist.</span>}
        </div>
      </section>
    </div>
  );
}
