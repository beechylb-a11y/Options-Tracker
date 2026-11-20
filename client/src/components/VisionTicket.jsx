// ================================================================
//  VISION TICKET — the Decision Engine ticket as one board (Nov 2026)
//
//  In Vision the top of a ticket is three columns, like the reference board:
//    left    the verdict (built by EnginePanel: ring, title, why, the four numbers,
//            strikes and expiry)
//    middle  the payoff as the hero (PayoffChart hero mode), then the combo's live
//            market and TWS what-if as two cards
//    right   your choices as bars (hover to ghost the curve, click to switch), a live
//            tile per leg, and what needs you, folded to one line
//  Everything here is presentation over values EnginePanel already has; Solid and
//  Glass keep the old stacked layout.
// ================================================================
import React, { useState } from 'react';
import FreshDot from './FreshDot';
import { LiveCombo, WhatIfBlock, useWhatIf } from './MarketCard';
import { useLiveWatch, useLegKeys, useLiveQuotes, useLiveConnection } from '../live/useLive';
import { freshnessOf } from '../live/liveStore';
import { marketClock } from '../engine/marketClock';

const MONO = 'JetBrains Mono, SF Mono, Menlo, monospace';
const INK2 = 'rgba(255,255,255,0.86)', INK3 = 'rgba(255,255,255,0.78)';
const UP = '#7ee2a0', DOWN = '#ffa39a', WARN = '#ffd479', BLUE = '#6aa8ff';
const f2 = v => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(2));

export function VCard({ children, testid, style, className = '' }) {
  return <section data-testid={testid} className={`card vis-eng-card ${className}`} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, ...style }}>{children}</section>;
}
function Caps({ children, style }) {
  return <span style={{ fontSize: 13, fontWeight: 500, color: INK3, ...style }}>{children}</span>;
}

// ── Your choices, as bars ──
// Alternatives are priced at the model's fair value for their own strikes, so the
// honest comparisons are reward to risk and the chance of a max loss; EV needs your
// fill and POP and only exists for the ticket itself.
export const CHOICE_METRICS = {
  rr: { label: 'R:R', of: c => c.rr, fmt: v => `${v.toFixed(2)}×`, better: 'higher' },
  pml: { label: 'Max loss', of: c => c.pml, fmt: v => `${(v * 100).toFixed(1)}%`, better: 'lower' },
};
export function choiceBars(choices, metric) {
  const m = CHOICE_METRICS[metric] || CHOICE_METRICS.rr;
  const vals = choices.map(c => { const v = m.of(c); return v != null && isFinite(v) ? v : null; });
  const max = Math.max(0, ...vals.filter(v => v != null));
  return choices.map((c, i) => ({ c, v: vals[i], h: vals[i] == null || max <= 0 ? 0 : Math.max(0.06, vals[i] / max), txt: vals[i] == null ? '—' : m.fmt(vals[i]) }));
}
const shortName = n => String(n || '').replace(/\s*-\s*Normal\b/i, '').replace(/butterfly/i, 'fly').replace(/spread/i, 'sprd').replace(/Iron condor/i, 'Condor');
export function VisionChoices({ choices, onHover, onSwitch, onAll, total }) {
  const [metric, setMetric] = useState('rr');
  const bars = choiceBars(choices, metric);
  const seg = on => ({ border: 'none', borderRadius: 999, padding: '6px 13px', font: 'inherit', fontSize: 13, fontWeight: 500, cursor: 'pointer',
    background: on ? 'rgba(255,255,255,0.26)' : 'transparent', color: on ? '#fff' : INK2 });
  return (
    <VCard testid="vis-choices">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0, fontSize: 21, fontWeight: 500, flex: 1 }}>Your choices</h3>
        <div role="group" aria-label="Compare by" style={{ display: 'inline-flex', gap: 2, padding: 4, borderRadius: 999, background: 'rgba(0,0,0,0.16)' }}>
          {Object.entries(CHOICE_METRICS).map(([k, m]) => <button key={k} type="button" aria-pressed={metric === k} style={seg(metric === k)} onClick={() => setMetric(k)}>{m.label}</button>)}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: 200, padding: '4px 4px 0' }}>
        {bars.map(({ c, h, txt }) => {
          const bad = c.rating === 'POOR';
          const fill = c.isCur ? `linear-gradient(180deg, #8fb8ff, ${BLUE})` : bad ? 'linear-gradient(180deg, rgba(255,163,154,0.75), rgba(255,163,154,0.45))' : 'linear-gradient(180deg, rgba(255,255,255,0.42), rgba(255,255,255,0.22))';
          return (
            <button key={c.name} type="button" data-testid="vis-choice" data-current={c.isCur ? '1' : '0'}
              title={`${c.name}${c.isCur ? ' — this ticket' : ' — click to switch, hover to compare on the payoff'}`}
              onMouseEnter={() => onHover && !c.isCur && onHover(c.name)} onMouseLeave={() => onHover && onHover(null)}
              onFocus={() => onHover && !c.isCur && onHover(c.name)} onBlur={() => onHover && onHover(null)}
              onClick={() => !c.isCur && onSwitch && onSwitch(c.name)}
              style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
                border: 'none', background: 'transparent', padding: 0, cursor: c.isCur ? 'default' : 'pointer', color: '#fff', font: 'inherit' }}>
              <span className="num" style={{ fontSize: 13, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: c.isCur ? 'rgba(255,255,255,0.18)' : 'transparent' }}>{txt}</span>
              <span aria-hidden="true" style={{ width: '100%', maxWidth: 76, height: `${Math.round(h * 140)}px`, minHeight: 8, borderRadius: 14, background: fill,
                boxShadow: c.isCur ? '0 10px 24px -8px rgba(61,130,240,0.6)' : 'inset 0 1px 0 rgba(255,255,255,0.3)' }} />
            </button>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 14, padding: '0 4px' }}>
        {bars.map(({ c }) => <span key={c.name} style={{ flex: 1, minWidth: 0, textAlign: 'center', fontSize: 13.5, fontWeight: c.isCur ? 600 : 400, color: c.isCur ? '#fff' : INK2,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortName(c.name)}</span>)}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: INK3 }}>
        <span style={{ flex: 1 }}>{CHOICE_METRICS[metric].better === 'lower' ? 'Lower is better. ' : 'Higher is better. '}Hover a bar to ghost its curve on the payoff.</span>
        {onAll && <button type="button" onClick={onAll} style={{ border: 'none', background: 'none', color: '#fff', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 13 }}>All {total}</button>}
      </div>
    </VCard>
  );
}

// ── A live tile per leg ──
export function LegTiles({ underlying, legs }) {
  const watch = (legs || []).map(l => ({ underlying, expiry: l.expiry, strike: l.strike, right: l.right, qty: Number(l.qty) || 0 }));
  useLiveWatch(watch);
  const keys = useLegKeys(watch);
  const quotes = useLiveQuotes();
  const { connection, status } = useLiveConnection();
  if (!watch.length || connection === 'off') return null;
  const now = Date.now();
  const phase = marketClock(new Date(now)).phase;
  const ctx = { now, connection, bridgeConnected: status.connected !== false, farmOk: status.farmOk !== false, marketOpen: phase === 'open' || phase === 'late' };
  return (
    <div data-testid="vis-leg-tiles" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}>
      {watch.map((l, i) => {
        const q = quotes[keys[i]] || {};
        const st = freshnessOf(q.ts ? q : null, ctx);
        const name = `${l.qty < 0 ? '−' : '+'}${Math.abs(l.qty) > 1 ? Math.abs(l.qty) + '×' : ''}${l.strike}${l.right}`;
        return (
          <div key={keys[i] || i} data-testid="vis-leg-tile" className="card vis-eng-card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className="num" style={{ fontSize: 15, fontWeight: 600, color: l.qty < 0 ? DOWN : UP }}>{name}</span>
              <span style={{ flex: 1 }} /><FreshDot state={st} ts={q.ts} size={8} />
            </div>
            <span className="num" style={{ fontSize: 22, fontWeight: 600, whiteSpace: 'nowrap' }}>{f2(q.bid)} × {f2(q.ask)}</span>
            <span className="num" style={{ fontSize: 13, color: INK2 }}>Δ {q.delta == null ? '—' : (q.delta >= 0 ? '+' : '−') + Math.abs(q.delta).toFixed(2)} · {q.ts ? (st === 'live' ? 'live' : st) : 'waiting'}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── The combo's market now, and TWS what-if, as two cards ──
export function ComboCard({ underlying, legs, entry, isCredit, onGoToOrder, whyNot }) {
  return (
    <VCard testid="vis-combo">
      <Caps>Market · live from TWS</Caps>
      <h3 style={{ margin: 0, fontSize: 21, fontWeight: 500 }}>Combo now</h3>
      {legs && legs.length ? <LiveCombo underlying={underlying} legs={legs} entry={entry} isCredit={isCredit} />
        : <span style={{ fontSize: 13.5, color: INK2 }}>{whyNot || 'Live prices appear once the structure has listed strikes.'}</span>}
      {onGoToOrder && (
        <button type="button" data-testid="go-to-order" onClick={onGoToOrder}
          style={{ marginTop: 'auto', height: 46, borderRadius: 23, border: 'none', font: 'inherit', fontSize: 14.5, fontWeight: 600, cursor: 'pointer', color: '#24221f', background: '#ffffff' }}>
          Order and exit plan ↓
        </button>
      )}
    </VCard>
  );
}
export function WhatIfCard({ underlying, legs, lots, entry, isCredit }) {
  const st = useWhatIf({ underlying, legs, lots, entry, isCredit });
  return (
    <VCard testid="vis-what-if">
      <Caps>TWS what-if</Caps>
      <h3 style={{ margin: 0, fontSize: 21, fontWeight: 500 }}>Before you send</h3>
      {st.s === 'idle'
        ? <span style={{ fontSize: 13.5, color: INK2 }}>TWS is asked for margin and commission once the bridge is connected and the ticket has a price.</span>
        : <WhatIfBlock st={st} />}
    </VCard>
  );
}

// ── What needs you, folded to one line until opened ──
export function NeedsCard({ count, first, tone, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!count && !children) return null;
  const col = tone === 'bad' ? DOWN : count ? WARN : UP;
  return (
    <VCard testid="vis-needs">
      <button type="button" data-testid="vis-needs-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 14, border: 'none', background: 'none', padding: 0, color: '#fff', font: 'inherit', textAlign: 'left', cursor: 'pointer' }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 52, height: 52, borderRadius: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `color-mix(in srgb, ${col} 24%, transparent)`, color: col, fontSize: 22, fontWeight: 700 }}>{count ? '!' : '✓'}</span>
        <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 17, fontWeight: 600 }}>{count ? `${count} thing${count > 1 ? 's' : ''} need${count > 1 ? '' : 's'} you` : 'Nothing needs you'}</span>
          {first && <span style={{ fontSize: 13.5, color: INK2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: open ? 'unset' : 2, WebkitBoxOrient: 'vertical' }}>{first}</span>}
        </span>
        <span aria-hidden="true" style={{ flex: 'none', width: 44, height: 44, borderRadius: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(255,255,255,0.14)', transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>
      </button>
      {open && children}
    </VCard>
  );
}

export const VISION_COLORS = { UP, DOWN, WARN, BLUE, INK2, INK3, MONO };
