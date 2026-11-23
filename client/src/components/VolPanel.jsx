import React from 'react';
import { VOL_LIMITS } from '../engine/volWatch';
import { accountColor, accountName } from '../utils/accountColors';
import { IvChip } from './PositionBoard';

// Risk page › Volatility (Nov 2026): the market read, each open trade's IV against
// entry with its vega, and since-entry P&L split into price, time, IV and the rest.
const C = { text: 'var(--c-e6edf3)', muted: 'var(--c-8b949e)', faint: 'var(--c-6e7681)', border: 'var(--c-30363d)',
  green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-e3b341)', blue: 'var(--c-58a6ff)', track: 'var(--c-21262d)' };
const $ = v => (v == null || !Number.isFinite(v) ? '—' : (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString());
const pts = v => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

function SplitBar({ s }) {
  if (!s) return <span style={{ color: C.faint }}>—</span>;
  const parts = [['Price', s.price], ['Time', s.time], ['IV', s.iv], ['Other', s.other]];
  const mx = Math.max(1, ...parts.map(([, v]) => Math.abs(v)));
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '46px 1fr 62px', gap: '3px 8px', alignItems: 'center', fontSize: 11.5 }}>
      {parts.map(([k, v]) => (
        <React.Fragment key={k}>
          <span style={{ color: C.muted }}>{k}</span>
          <div style={{ position: 'relative', height: 7, borderRadius: 4, background: C.track }}>
            <div style={{ position: 'absolute', top: 0, bottom: 0, [v >= 0 ? 'left' : 'right']: '50%', width: `${Math.abs(v) / mx * 50}%`, borderRadius: 4, background: v >= 0 ? C.green : C.red }} />
            <div style={{ position: 'absolute', left: '50%', top: -2, bottom: -2, width: 1, background: C.faint }} />
          </div>
          <span className="mono" style={{ textAlign: 'right', color: v >= 0 ? C.green : C.red }}>{$(v)}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

export default function VolPanel({ market, book, positions, accounts }) {
  const m = market || {};
  const rows = [...(positions || [])].sort((a, b) => ({ red: 2, amber: 1 }[b.tone] || 0) - ({ red: 2, amber: 1 }[a.tone] || 0));
  return (
    <div data-testid="vol-panel">
      <div className="flex gap-5 flex-wrap mb-3 text-[13px]" style={{ color: C.muted }}>
        <span>VIX <b className="mono" style={{ color: C.text }}>{m.vix ? m.vix.toFixed(2) : '—'}</b>{m.pct != null && <span className="mono" style={{ color: m.pct > 0 ? C.amber : C.green }}> {m.pct >= 0 ? '+' : ''}{m.pct.toFixed(1)}%</span>} vs close</span>
        <span>VIX1D <b className="mono" style={{ color: C.text }}>{m.vix1d ? m.vix1d.toFixed(2) : '—'}</b></span>
        <span>VIX ÷ VIX3M <b className="mono" style={{ color: m.term >= 1 ? C.red : C.text }}>{m.term ? m.term.toFixed(2) : '—'}</b>{m.term >= 1 ? ' backwardation' : m.term ? ' contango' : ''}</span>
        <span>Book vega <b className="mono" style={{ color: C.text }}>{$(book && book.vega)}</b> per IV point</span>
        {book && book.today != null && <span>VIX move today ≈ <b className="mono" style={{ color: book.today < 0 ? C.red : C.green }}>{$(book.today)}</b></span>}
      </div>
      {rows.length === 0 ? <div className="text-[13px]" style={{ color: C.muted }}>Nothing open.</div> : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: C.faint }}>
              {['Position', 'IV at entry → now', '', 'Vega /pt', 'Theta /day', 'Since entry: why P&L moved'].map((h, i) => (
                <th key={i} className="text-left font-medium pb-2 px-2 text-[12px]">{h}</th>))}
            </tr></thead>
            <tbody>
              {rows.map(v => (
                <tr key={v.key} style={{ borderTop: `1px solid ${C.border}` }} data-testid={`vol-row-${v.key}`}>
                  <td className="px-2 py-2 align-top"><b style={{ color: C.text }}>{v.underlying}</b> <span style={{ color: C.muted }}>{v.strategy}</span>
                    {v.account && <div className="text-[11.5px]" style={{ color: accountColor(v.account, accounts) }}>{accountName(v.account, accounts)}</div>}</td>
                  <td className="px-2 py-2 align-top mono">{v.ivEntry != null ? `${v.ivEntry.toFixed(1)} → ${v.ivNow.toFixed(1)}` : '—'}
                    <div className="text-[11px]" style={{ color: C.faint }}>{v.basis ? `by ${v.basis}` : 'no IV at entry or no live quote'}</div></td>
                  <td className="px-2 py-2 align-top">{v.tone ? <IvChip v={v} /> : v.dIv != null ? <span className="mono" style={{ color: C.muted }}>{pts(v.dIv)}</span> : null}
                    {v.reasons.length > 0 && <div className="text-[11px] mt-1" style={{ color: C.muted, maxWidth: 220 }}>{v.reasons.join(' · ')}</div>}</td>
                  <td className="px-2 py-2 align-top mono">{$(v.vega)}{v.vegaPnl != null && <div className="text-[11px]" style={{ color: v.vegaPnl < 0 ? C.red : C.green }}>{$(v.vegaPnl)} from IV</div>}</td>
                  <td className="px-2 py-2 align-top mono">{$(v.theta)}</td>
                  <td className="px-2 py-2 align-top" style={{ minWidth: 260 }}><SplitBar s={v.split} />
                    {v.split && <div className="text-[11px] mt-1" style={{ color: C.faint }}>P&amp;L {$(v.split.pnl)} over {v.split.days} d · rough split on today's greeks</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="text-[12px] mt-3" style={{ color: C.faint }} data-testid="vol-limits">
        Amber: VIX +{VOL_LIMITS.vixPct.amber}% (or +{VOL_LIMITS.vixPts.amber} pts) since the close · trade IV +{VOL_LIMITS.ivPts.amber} pts (or +{VOL_LIMITS.ivPct.amber}%) against it · IV move ≥ {VOL_LIMITS.thetaDays.amber} days of theta · IV move ≥ {VOL_LIMITS.bookVegaPct.amber}% of net liq · 0DTE VIX1D +{VOL_LIMITS.vix1dPct.amber}% since entry.
        Red: VIX +{VOL_LIMITS.vixPct.red}% · VIX ≥ VIX3M · IV +{VOL_LIMITS.ivPts.red} pts · ≥ {VOL_LIMITS.bookVegaPct.red}% of net liq. Short-vega trades warn on a rise, long-vega on a fall.
      </div>
    </div>
  );
}
