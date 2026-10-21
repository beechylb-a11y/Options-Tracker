import React, { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { ticketExpiry, daysBetweenYmd } from '../utils/ticketExpiry';
import { strategyName } from '../utils/positionMatch';
import { tradingSession } from '../engine/session';
import { exitRuleFor } from '../engine/data';
import { marketClock } from '../engine/marketClock';

// ── Upcoming expiries (Oct 2026) ──
// Every open and working ticket with its days to expiry, nearest first. It used to
// read the old TastyTrade tracker, which no engine trade is in, so it sat empty.
// Expiry comes from the ticket's Legs line, TWS (when the bridge answers), the
// ticket it was rolled from, or — for a 0DTE — its session.

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = y => `${+y.slice(6, 8)} ${MON[+y.slice(4, 6) - 1]}`;
const addDays = (y, n) => {
  const d = new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)) + n * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
const TONE = { red: ['#2d0f11', '#f85149'], amber: ['#1f1a0d', '#e3b341'], blue: ['#0c1d36', '#58a6ff'], grey: ['#161b22', '#a8b2be'] };

/** One row's badge and note from its expiry, engine and the clock. */
export function expiryRow({ expiry, engine, strategy, todayYmd, clock }) {
  if (!expiry) return { dte: null, badge: '?', tone: 'grey', note: 'expiry not known — log the legs, or open it with the bridge on' };
  const dte = daysBetweenYmd(todayYmd, expiry);
  if (dte < 0) return { dte, badge: 'expired', tone: 'red', note: `expired ${fmt(expiry)} — record the close` };
  if (dte === 0) {
    const ph = clock && clock.phase;
    return { dte, badge: 'today', tone: 'red',
      note: ph === 'late' || ph === 'after' ? 'past the 0DTE exit — close it'
        : ph === 'open' ? clock.detail.split(' · ')[0]
        : 'expires today — exit by 15:00 New York' };
  }
  if (/45/.test(engine || '')) {
    const rule = exitRuleFor('45DTE', strategy);
    const closeDte = rule.closeDte || 21;
    const left = dte - closeDte;
    const closeOn = addDays(expiry, -closeDte);
    if (left <= 0) return { dte, badge: `${dte}d`, tone: 'red', note: `past the ${closeDte}-DTE close — manage or close now` };
    return { dte, badge: `${dte}d`, tone: left <= 5 ? 'amber' : 'blue', note: `close by ${fmt(closeOn)} (${closeDte} DTE) — in ${left}d` };
  }
  return { dte, badge: `${dte}d`, tone: dte <= 2 ? 'amber' : 'blue', note: `expires ${fmt(expiry)}` };
}

export default function UpcomingExpiries({ authenticated, account }) {
  const [rows, setRows] = useState(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id); }, []);

  useEffect(() => {
    if (!authenticated) return;
    let dead = false;
    (async () => {
      const [open, decisions] = await Promise.all([
        Promise.resolve().then(() => api.getOpenPositions(account)).catch(() => []),
        Promise.resolve().then(() => api.getDecisions()).catch(() => []),
      ]);
      // TWS legs, when the bridge answers quickly: the expiry of a ticket logged
      // without a Legs line. Never waited on for long.
      let raw = null;
      let bridgeUrl = '';
      try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
      if (bridgeUrl) {
        try {
          const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
          const r = await fetch(bridgeUrl + '/api/positions', { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
          clearTimeout(t);
          const d = JSON.parse(await r.text());
          raw = Array.isArray(d.raw) ? d.raw : null;
        } catch (e) { raw = null; }
      }
      const todayYmd = tradingSession().yyyymmdd;
      const list = (Array.isArray(open) ? open : []).map(o => {
        const d = (decisions || []).find(x => (o.timestamp && x.Timestamp === o.timestamp) || Number(x._rowIndex) === Number(o.ticketRef));
        const e = d ? ticketExpiry(d, decisions, { raw, todayYmd, qtyOpen: Number(o.qtyOpen) || 1 }) : null;
        return { key: o.ticketRef, underlying: o.underlying, strategy: strategyName(o.strategy) || o.strategy, engine: o.engine,
          legs: o.legs, qtyOpen: o.qtyOpen, status: o.status, expiry: e ? e.expiry : null, source: e ? e.source : null };
      });
      if (!dead) setRows(list);
    })();
    return () => { dead = true; };
  }, [authenticated, account]);

  const todayYmd = tradingSession(now).yyyymmdd;
  const clock = marketClock(now);
  const shown = (rows || []).map(r => ({ ...r, ...expiryRow({ ...r, todayYmd, clock }) }))
    .sort((a, b) => (a.dte == null) - (b.dte == null) || (a.dte ?? 0) - (b.dte ?? 0));

  return (
    <div className="card" data-testid="upcoming-expiries">
      <h3 className="text-sm font-medium text-text-muted mb-3">Upcoming Expiries</h3>
      {rows == null ? <div className="text-text-faint text-sm">Loading…</div>
        : !shown.length ? <div className="text-text-faint text-sm py-6 text-center">No open trades</div>
        : (
          <div className="space-y-2">
            {shown.map(r => {
              const [bg, fg] = TONE[r.tone] || TONE.grey;
              return (
                <div key={r.key} data-testid="expiry-row" className="flex items-center gap-2"
                  title={`${r.underlying} ${r.strategy} · ${r.legs || ''}${r.expiry ? ` · expiry from ${r.source === 'legs' ? 'the logged legs' : r.source === 'tws' ? 'TWS' : r.source === 'roll' ? 'the ticket it was rolled from' : 'its session'}` : ''}`}>
                  <span className="mono text-[12px] font-bold rounded px-1.5 py-0.5 text-center" style={{ background: bg, color: fg, minWidth: 52 }}>{r.badge}</span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] truncate"><b>{r.underlying}</b> <span className="text-text-muted">{r.strategy}</span>
                      {r.status === 'Working' && <span className="text-[11px] ml-1" style={{ color: '#bc8cff' }}>working</span>}</div>
                    <div className="text-[11.5px]" style={{ color: r.tone === 'red' || r.tone === 'amber' ? fg : '#8b949e' }}>
                      {r.expiry ? `${fmt(r.expiry)} · ` : ''}{r.note}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      <div className="text-[11px] text-text-faint mt-3">New York {clock.time} {clock.date} · {clock.status.toLowerCase()}</div>
    </div>
  );
}
