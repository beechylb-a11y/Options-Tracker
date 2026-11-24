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
import React, { useState, useEffect, useRef } from 'react';
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
const shortName = n => String(n || '').replace(/\s*-\s*Normal\b/i, '').replace(/butterfly/i, 'fly');
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
      {/* One row per structure (24 Nov 2026): name, bar, value — reads at a glance and
          fits a third of the ticket's width, where the columns needed half. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {bars.map(({ c, h, txt }) => {
          const bad = c.rating === 'POOR';
          const fill = c.isCur ? `linear-gradient(90deg, ${BLUE}, #8fb8ff)` : bad ? 'linear-gradient(90deg, rgba(255,163,154,0.55), rgba(255,163,154,0.85))' : 'linear-gradient(90deg, rgba(255,255,255,0.35), rgba(255,255,255,0.75))';
          return (
            <button key={c.name} type="button" data-testid="vis-choice-row" data-current={c.isCur ? '1' : '0'}
              title={`${c.name}${c.isCur ? ' — this ticket' : ' — click to switch, hover to compare on the payoff'}`}
              onMouseEnter={() => onHover && !c.isCur && onHover(c.name)} onMouseLeave={() => onHover && onHover(null)}
              onFocus={() => onHover && !c.isCur && onHover(c.name)} onBlur={() => onHover && onHover(null)}
              onClick={() => !c.isCur && onSwitch && onSwitch(c.name)}
              style={{ display: 'grid', gridTemplateColumns: 'minmax(96px, 128px) 1fr 58px', alignItems: 'center', gap: 10, padding: '6px 4px', border: 'none', borderRadius: 12,
                background: 'transparent', cursor: c.isCur ? 'default' : 'pointer', color: '#fff', font: 'inherit', textAlign: 'left' }}>
              <span style={{ fontSize: 14, fontWeight: c.isCur ? 700 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{shortName(c.name)}</span>
              <span aria-hidden="true" style={{ height: 14, borderRadius: 7, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${Math.round(h * 100)}%`, borderRadius: 7, background: fill }} />
              </span>
              <span data-testid="vis-choice" data-current={c.isCur ? '1' : '0'} className="num" style={{ fontSize: 14, fontWeight: 600, textAlign: 'right' }}>{txt}</span>
            </button>
          );
        })}
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

// ================================================================
//  The ticket in decision order (24 Nov 2026)
//    A  decision bar    — can I? the verdict, the one thing in the way, its fix
//    B  the numbers     — six big figures beside a small edge ring
//    C  payoff + price  — built in EnginePanel (PriceMap lives there)
//    D  choices         — horizontal bars
//    E  legs            — one live table instead of a tile per leg
//    F  TWS             — combo and what-if as one card; a line when offline
//  plus the data-in chip: what is coming in from TWS, and when.
// ================================================================

const TONE = {
  bad: { fg: DOWN, bg: 'rgba(255,163,154,0.20)', edge: 'rgba(255,163,154,0.45)' },
  warn: { fg: WARN, bg: 'rgba(255,212,121,0.16)', edge: 'rgba(255,212,121,0.40)' },
  pass: { fg: '#ffc08a', bg: 'rgba(255,192,138,0.16)', edge: 'rgba(255,192,138,0.40)' },
  good: { fg: UP, bg: 'rgba(126,226,160,0.14)', edge: 'rgba(126,226,160,0.35)' },
};
export const toneOf = t => TONE[t] || TONE.good;

/** A: the verdict, the first thing in the way (or why it's fine) and that thing's own buttons. */
export function DecisionBar({ word, tone, title, detail, more, onMore, children }) {
  const t = toneOf(tone);
  return (
    <section data-testid="vis-decision" className="card vis-eng-card vis-decision"
      style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '14px 18px', borderColor: t.edge,
        background: `linear-gradient(160deg, ${t.bg}, rgba(255,255,255,0.05))` }}>
      <span data-testid="vis-decision-word" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 14px', borderRadius: 999, fontSize: 14.5, fontWeight: 600,
        background: t.bg, color: t.fg, whiteSpace: 'nowrap' }}><span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: '50%', background: t.fg }} />{word}</span>
      <div style={{ flex: '1 1 320px', minWidth: 0 }}>
        {title && <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{title}</div>}
        {detail && <div style={{ fontSize: 13.5, color: INK2, lineHeight: 1.45, marginTop: 2 }}>{detail}</div>}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        {children}
        {more > 0 && <button type="button" data-testid="vis-decision-more" onClick={onMore}
          style={{ border: 'none', background: 'none', color: '#fff', textDecoration: 'underline', cursor: 'pointer', font: 'inherit', fontSize: 13.5 }}>+{more} more</button>}
      </div>
    </section>
  );
}

/** A value that flashes blue for a second when it changes and `on` (TWS fed it). */
export function useFlash(value, on) {
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value && on && prev.current != null) {
      setFlash(true);
      const h = setTimeout(() => setFlash(false), 1100);
      prev.current = value;
      return () => clearTimeout(h);
    }
    prev.current = value;
    return undefined;
  }, [value, on]);
  return flash;
}

/** The ticket's net in the title row: flashes blue when TWS replaces it. */
export function NetFlash({ value, on }) {
  const flash = useFlash(value, on);
  return <span data-testid="vis-net-value" className="num" style={{ fontSize: 22, fontWeight: 600, padding: '0 6px', borderRadius: 8,
    transition: 'background 900ms ease', background: flash ? 'rgba(106,168,255,0.38)' : 'transparent' }}>{value}</span>;
}

/** Where one number came from: TWS (blue, with the time), typed (amber), target, model (grey). */
export function SourceTag({ tag }) {
  if (!tag) return null;
  const c = tag.kind === 'tws' ? { bg: '#3d82f0', fg: '#fff' } : tag.kind === 'typed' ? { bg: 'rgba(255,212,121,0.18)', fg: WARN }
    : tag.kind === 'target' ? { bg: 'rgba(255,212,121,0.18)', fg: WARN } : { bg: 'rgba(255,255,255,0.13)', fg: INK2 };
  return <span data-testid="source-tag" data-kind={tag.kind} className="num"
    style={{ display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{tag.text}</span>;
}

/** One figure in the numbers card. */
export function BigNum({ label, value, sub, tag, color, testid, flashOn }) {
  const flash = useFlash(value, flashOn);
  return (
    <div data-testid={testid} className="vis-num" style={{ borderRadius: 18, padding: '13px 15px', background: 'rgba(0,0,0,0.14)', minWidth: 0 }}>
      <div style={{ fontSize: 13, color: INK3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</div>
      <div className="num" style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em', whiteSpace: 'nowrap', color: color || '#fff', lineHeight: 1.2, marginTop: 2,
        borderRadius: 8, transition: 'background 900ms ease', background: flash ? 'rgba(106,168,255,0.35)' : 'transparent', display: 'inline-block', padding: '0 4px', marginLeft: -4 }}>{value}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
        {sub && <span style={{ fontSize: 12.5, color: INK3, lineHeight: 1.35, flex: '1 1 auto', minWidth: 0 }}>{sub}</span>}
        <SourceTag tag={tag} />
      </div>
    </div>
  );
}

/** B: the edge ring with its one-line read, then six numbers. */
export function NumbersCard({ ring, read, readSub, items }) {
  return (
    <VCard testid="vis-numbers" style={{ gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ flex: 'none' }}>{ring}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.3 }}>{read}</div>
          {readSub && <div style={{ fontSize: 13, color: INK3, lineHeight: 1.4 }}>{readSub}</div>}
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        {items.map(it => <BigNum key={it.testid || it.label} {...it} />)}
      </div>
    </VCard>
  );
}

/** E: the legs as one live table. */
export function LegTable({ underlying, legs }) {
  const watch = (legs || []).map(l => ({ underlying, expiry: l.expiry, strike: l.strike, right: l.right, qty: Number(l.qty) || 0 }));
  useLiveWatch(watch);
  const keys = useLegKeys(watch);
  const quotes = useLiveQuotes();
  const { connection, status } = useLiveConnection();
  if (!watch.length) return null;
  const now = Date.now();
  const phase = marketClock(new Date(now)).phase;
  const ctx = { now, connection, bridgeConnected: status.connected !== false, farmOk: status.farmOk !== false, marketOpen: phase === 'open' || phase === 'late' };
  const td = { padding: '7px 0', fontSize: 14, borderTop: '1px solid rgba(255,255,255,0.08)' };
  return (
    <VCard testid="vis-legs">
      <Caps>Legs · live from TWS</Caps>
      <table className="num" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr style={{ fontSize: 12, color: INK3, textAlign: 'right' }}>
          <th style={{ textAlign: 'left', fontWeight: 500 }}>Leg</th><th style={{ fontWeight: 500 }}>Bid × Ask</th><th style={{ fontWeight: 500 }}>Δ</th><th style={{ fontWeight: 500 }}>IV</th><th style={{ width: 18 }} />
        </tr></thead>
        <tbody>
          {watch.map((l, i) => {
            const q = quotes[keys[i]] || {};
            const st = connection === 'off' ? 'off' : freshnessOf(q.ts ? q : null, ctx);
            const name = `${l.qty < 0 ? '−' : '+'}${Math.abs(l.qty) > 1 ? Math.abs(l.qty) + '×' : ''}${l.strike}${l.right}`;
            const iv = q.iv != null && isFinite(q.iv) ? (q.iv > 3 ? q.iv : q.iv * 100) : null;
            return (
              <tr key={keys[i] || i} data-testid="vis-leg-row" style={{ textAlign: 'right' }}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600, color: l.qty < 0 ? DOWN : UP }}>{name}</td>
                <td style={td}>{q.ts ? `${f2(q.bid)} × ${f2(q.ask)}` : <span style={{ color: INK3 }}>{connection === 'off' ? 'no stream' : 'waiting'}</span>}</td>
                <td style={td}>{q.delta == null ? '—' : (q.delta >= 0 ? '' : '−') + Math.abs(q.delta).toFixed(2)}</td>
                <td style={td}>{iv == null ? '—' : iv.toFixed(1)}</td>
                <td style={{ ...td, paddingLeft: 8 }}><FreshDot state={st} ts={q.ts} size={7} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </VCard>
  );
}

/** F: the combo's market and TWS what-if in one card — one line while TWS is not connected. */
export function TwsCard({ underlying, legs, lots, entry, isCredit, whyNot, onGoToOrder, onWhatIf }) {
  const { connection, status } = useLiveConnection();
  const st = useWhatIf({ underlying, legs, lots, entry, isCredit });
  useEffect(() => { if (onWhatIf) onWhatIf(st.s); }, [st.s, onWhatIf]);
  const up = connection === 'open' && status.connected !== false;
  return (
    <VCard testid="vis-tws">
      <Caps>TWS · combo and what-if</Caps>
      {!up ? (
        <span data-testid="vis-tws-offline" style={{ fontSize: 13.5, color: INK2 }}>
          {connection === 'connecting' ? 'Connecting to TWS…' : connection === 'open' ? 'Bridge up, TWS not connected' : 'TWS not connected'} — the combo's market and the what-if appear when it is.
        </span>
      ) : <>
        <div data-testid="vis-combo">
          {legs && legs.length ? <LiveCombo underlying={underlying} legs={legs} entry={entry} isCredit={isCredit} />
            : <span style={{ fontSize: 13.5, color: INK2 }}>{whyNot || 'Live prices appear once the structure has listed strikes.'}</span>}
        </div>
        <div data-testid="vis-what-if" style={{ borderTop: '1px solid rgba(255,255,255,0.12)', paddingTop: 8 }}>
          {st.s === 'idle' ? <span style={{ fontSize: 13, color: INK3 }}>What-if asks TWS for margin and commission once the ticket has a price.</span> : <WhatIfBlock st={st} />}
        </div>
      </>}
      {onGoToOrder && (
        <button type="button" data-testid="go-to-order" onClick={onGoToOrder}
          style={{ marginTop: 'auto', height: 40, borderRadius: 20, border: 'none', font: 'inherit', fontSize: 14, fontWeight: 600, cursor: 'pointer', color: '#24221f', background: '#ffffff' }}>
          Order and exit plan ↓
        </button>
      )}
    </VCard>
  );
}

// ── Data in: the chip at the top right of the ticket and the panel behind it ──
const INB = {
  receiving: { dot: BLUE, pulse: true }, live: { dot: UP, pulse: true }, stale: { dot: WARN, pulse: false }, offline: { dot: 'rgba(255,255,255,0.45)', pulse: false },
};
const FEED = {
  pulling: { col: BLUE, moving: true }, live: { col: UP, moving: true }, done: { col: UP }, stale: { col: WARN }, fallback: { col: WARN },
  waiting: { col: 'rgba(255,255,255,0.45)' }, off: { col: 'rgba(255,255,255,0.3)' },
};
export function DataInChip({ status }) {
  const [open, setOpen] = useState(false);
  if (!status) return null;
  const k = INB[status.state] || INB.offline;
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" data-testid="data-in-chip" data-state={status.state} aria-expanded={open} onClick={() => setOpen(o => !o)}
        title="What is coming in from TWS — click for each feed"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '7px 14px', borderRadius: 999, border: '1px solid rgba(255,255,255,0.16)',
          background: 'rgba(255,255,255,0.12)', color: '#fff', font: 'inherit', fontSize: 13.5, cursor: 'pointer', maxWidth: 460 }}>
        <span aria-hidden="true" className={k.pulse ? 'scan-dot' : ''} style={{ width: 10, height: 10, borderRadius: '50%', background: k.dot, flex: 'none' }} />
        <b style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{status.title}</b>
        {status.sub && <span style={{ color: INK2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>· {status.sub}</span>}
      </button>
      {open && (
        <div data-testid="data-in-panel" role="dialog" aria-label="Data in from TWS"
          style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 40, width: 440, padding: '14px 16px', borderRadius: 22,
            background: 'rgba(58,55,51,0.96)', border: '1px solid rgba(255,255,255,0.18)', boxShadow: '0 24px 48px -16px rgba(0,0,0,0.6)', backdropFilter: 'blur(24px)' }}>
          <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: INK3, marginBottom: 6 }}>Data in from TWS</div>
          {status.feeds.map(f => {
            const s = FEED[f.state] || FEED.off;
            return (
              <div key={f.key} data-testid={'data-in-' + f.key} data-state={f.state}
                style={{ display: 'grid', gridTemplateColumns: '130px 1fr 120px', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{f.label}</span>
                <span style={{ position: 'relative', height: 7, borderRadius: 4, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
                  {s.moving ? <span className="data-in-shimmer" style={{ background: `linear-gradient(90deg, transparent, ${s.col}, transparent)` }} />
                    : <span style={{ position: 'absolute', inset: 0, background: s.col, opacity: f.state === 'waiting' || f.state === 'off' ? 0.35 : 0.6 }} />}
                </span>
                <span className="num" style={{ fontSize: 12.5, textAlign: 'right', color: f.state === 'stale' || f.state === 'fallback' ? WARN : INK2 }}>{f.when}</span>
              </div>
            );
          })}
          <div style={{ fontSize: 12.5, color: INK3, marginTop: 8, lineHeight: 1.45 }}>Moving = arriving now · solid = in (time shown) · amber = old or a fallback (delayed, frozen, last close).</div>
        </div>
      )}
    </div>
  );
}

export const VISION_COLORS = { UP, DOWN, WARN, BLUE, INK2, INK3, MONO };
