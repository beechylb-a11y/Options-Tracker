import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';

// Open and partially-closed positions, each expandable to its tranches.
//
// Until closes were tranched there was nothing to look at: a position was either
// absent from the log or finished. A half-closed trade is the one state where you
// genuinely cannot reconstruct where you stand from the ticket alone, because the
// ticket shows the blended result and says nothing about what is still at risk.
// (Sep 2026.)
//
// compact — Dashboard mode: totals plus one line per position, no tranche detail.
export default function OpenPositions({ authenticated, account, compact = false }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    let dead = false;
    setLoading(true);
    api.getOpenPositions(account)
      .then(d => { if (!dead) { setRows(Array.isArray(d) ? d : []); setErr(null); } })
      .catch(e => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [authenticated, account]);

  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  // Risk still live is the OPEN portion only — the closed contracts cannot lose
  // any more, and counting them would overstate exposure on every partial.
  const openRisk = rows.reduce((a, r) =>
    a + (n(r.qty) > 0 ? n(r.maxRisk) * (n(r.qtyOpen) / n(r.qty)) : 0), 0);
  const realised = rows.reduce((a, r) => a + n(r.realisedPnl), 0);
  const partials = rows.filter(r => r.status === 'Partial').length;

  if (loading) return <div className="card"><div className="text-text-muted text-sm">Loading open positions…</div></div>;
  if (err) return <div className="card"><div className="text-red text-sm">Open positions: {err}</div></div>;

  if (!rows.length) {
    return (
      <div className="card">
        <div className="flex items-center justify-between">
          <span className="text-sm" style={{ fontWeight: 600 }}>Open positions</span>
          <span className="text-text-muted text-sm">Nothing open</span>
        </div>
      </div>
    );
  }

  const Pill = ({ s }) => (
    <span className="badge" style={{
      background: s === 'Partial' ? '#1f1a0d' : '#0d1a2e',
      color: s === 'Partial' ? '#d29922' : '#2f81f7'
    }}>{s}</span>
  );
  const money = v => (n(v) >= 0 ? '+$' : '−$') + Math.abs(n(v)).toFixed(0);

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="text-sm" style={{ fontWeight: 600 }}>
          Open positions
          <span className="text-text-muted" style={{ fontWeight: 400 }}>
            {' '}· {rows.length}{partials > 0 && ` · ${partials} part-closed`}
          </span>
        </span>
        <span className="text-sm mono" style={{ display: 'flex', gap: 16 }}>
          <span><span className="text-text-muted">Risk live </span>
            <b>${openRisk.toFixed(0)}</b></span>
          {realised !== 0 && (
            <span><span className="text-text-muted">Banked </span>
              <b className={realised >= 0 ? 'win' : 'loss'}>{money(realised)}</b></span>
          )}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-faint text-[12px] uppercase tracking-wider">
              <th className="text-left py-2 pr-2">Opened</th>
              <th className="text-left py-2 pr-2">Position</th>
              {!compact && <th className="text-left py-2 pr-2">Legs</th>}
              <th className="text-right py-2 pr-2">Open / Qty</th>
              <th className="text-right py-2 pr-2">Risk live</th>
              {!compact && <th className="text-right py-2 pr-2">Avg exit</th>}
              <th className="text-right py-2 pr-2">Banked</th>
              <th className="text-left py-2 pl-2">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isOpen = !!open[r.ticketRef];
              const liveRisk = n(r.qty) > 0 ? n(r.maxRisk) * (n(r.qtyOpen) / n(r.qty)) : 0;
              const expandable = !compact && (r.closes || []).length > 0;
              return (
                <React.Fragment key={r.ticketRef}>
                  <tr
                    onClick={() => expandable && setOpen(o => ({ ...o, [r.ticketRef]: !o[r.ticketRef] }))}
                    style={{ borderTop: '1px solid #21262d', cursor: expandable ? 'pointer' : 'default' }}
                    title={expandable ? (isOpen ? 'Hide tranches' : `Show ${r.closes.length} tranche${r.closes.length > 1 ? 's' : ''}`) : ''}>
                    <td className="py-2 pr-2 text-text-muted">{r.entryDate} <span className="text-text-faint">{r.entryTime}</span></td>
                    <td className="py-2 pr-2">
                      {expandable && <span className="text-text-faint">{isOpen ? '▾ ' : '▸ '}</span>}
                      <b>{r.underlying}</b> <span className="text-text-muted">{r.strategy}</span>
                    </td>
                    {!compact && <td className="py-2 pr-2 mono text-text-muted">{r.legs}</td>}
                    <td className="py-2 pr-2 text-right mono">
                      <b>{r.qtyOpen}</b><span className="text-text-muted"> / {r.qty}</span>
                    </td>
                    <td className="py-2 pr-2 text-right mono">${liveRisk.toFixed(0)}</td>
                    {!compact && <td className="py-2 pr-2 text-right mono text-text-muted">{r.avgExit === '' ? '—' : r.avgExit}</td>}
                    <td className={'py-2 pr-2 text-right mono ' + (n(r.realisedPnl) >= 0 ? 'win' : 'loss')}>
                      {r.realisedPnl === '' ? '—' : money(r.realisedPnl)}
                    </td>
                    <td className="py-2 pl-2"><Pill s={r.status} /></td>
                  </tr>
                  {isOpen && r.closes.map((c, i) => (
                    <tr key={c.closeId || i} style={{ background: '#0d1117' }}>
                      <td className="py-1.5 pr-2 text-text-faint text-[12px]">{c.closeDate}</td>
                      <td className="py-1.5 pr-2 text-text-muted text-[12px]" colSpan={compact ? 1 : 2}>
                        &nbsp;&nbsp;&nbsp;tranche {i + 1}{c.notes ? ` — ${c.notes}` : ''}
                      </td>
                      <td className="py-1.5 pr-2 text-right mono text-[12px]">{c.qtyClosed}</td>
                      <td className="py-1.5 pr-2 text-right mono text-[12px] text-text-muted">@ {c.closePrice}</td>
                      {!compact && <td className="py-1.5 pr-2"></td>}
                      <td className={'py-1.5 pr-2 text-right mono text-[12px] ' + (c.pnl >= 0 ? 'win' : 'loss')}>{money(c.pnl)}</td>
                      <td className="py-1.5 pl-2"></td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
