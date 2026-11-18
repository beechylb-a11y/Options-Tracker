// ================================================================
//  MARKET CARD — the trade's live market next to its payoff (Nov 2026)
//
//  Everything on it streams from TWS through the bridge's live book (live/):
//    • the combo's market now: mid, crossing the spread and the far side, against
//      the limit you are about to stage
//    • each leg: bid, ask, mark, delta, theta, IV, and how live it is
//    • TWS what-if: the margin and commission the ENTRY would cost, asked of TWS
//      itself (order.whatIf — a preview TWS answers and never routes), re-asked when
//      the legs, size, price or account change
//  and one button down to the order (the exit plan card) where staging happens.
// ================================================================
import React, { useEffect, useState } from 'react';
import FreshDot from './FreshDot';
import { useLiveWatch, useLegKeys, useLiveQuotes, useFreshness, useLiveConnection } from '../live/useLive';
import { comboQuote, freshnessOf } from '../live/liveStore';
import { bridgeBase } from '../live/liveFeed';
import { marketClock } from '../engine/marketClock';

const C = { green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)',
  grey: 'var(--c-8b949e)', soft: 'var(--c-a8b2be)', text: 'var(--c-e6edf3)', line: 'var(--c-30363d)', line2: 'var(--c-21262d)', bg: 'var(--c-0d1117)' };
const MONO = 'JetBrains Mono, SF Mono, Menlo, monospace';
const CAPS = { fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey };
const ACCT_KEY = 'stage-account-v1';
const HDR = { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' };
const $ = v => (v == null ? '—' : (v < 0 ? '−$' : '$') + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: Math.abs(v) < 100 && v % 1 ? 2 : 0 }));
const f2 = v => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(2));

/**
 * The combo's market right now, streamed from TWS: mid, crossing the spread and the
 * far side, against the limit. legs: [{ strike, right, qty (signed per lot), expiry }].
 */
export function LiveCombo({ underlying, legs, entry, isCredit }) {
  const watch = (legs || []).map(l => ({ underlying, expiry: l.expiry, strike: l.strike, right: l.right, qty: Number(l.qty) || 0 }));
  useLiveWatch(watch);
  const keys = useLegKeys(watch);
  const quotes = useLiveQuotes();
  const { connection } = useLiveConnection();
  const legQ = keys.map(k => quotes[k]);
  const c = comboQuote(keys.map((k, i) => ({ key: k, qty: watch[i].qty })), quotes);
  const oldest = legQ.every(q => q && q.ts) ? Math.min(...legQ.map(q => q.ts)) : 0;
  const fresh = useFreshness(oldest ? { ts: oldest, delayed: legQ.some(q => q.delayed) } : null);
  if (!watch.length || connection === 'off') return null;
  const box = { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 13 };
  if (!c.complete) {
    return <div data-testid="live-combo" style={{ ...box, color: C.grey }}><FreshDot state={connection === 'open' ? 'stale' : 'off'} />
      {connection === 'open' ? 'Waiting for TWS quotes on every leg…' : 'Live stream not connected — market prices will appear when it is.'}</div>;
  }
  // Shown the way the ticket reads it: a credit trade as credits.
  const s = isCredit ? 1 : -1;
  const sideTxt = v => `${Math.abs(v).toFixed(2)} ${v * s >= 0 ? (isCredit ? 'cr' : 'db') : (isCredit ? 'db' : 'cr')}`;
  const edge = Number.isFinite(entry) ? Math.round((entry - c.mid * s) * 100) / 100 : null;
  return (
    <div data-testid="live-combo" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', textAlign: 'center' }}>
        {[['Crossing', c.natural, C.soft], ['Mid', c.mid, C.text], ['Far side', c.far, C.soft]].map(([k, v, col], i) => (
          <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2, borderLeft: i ? `1px solid ${C.line2}` : 'none' }}>
            <span style={CAPS}>{k}</span>
            <span style={{ fontFamily: MONO, fontSize: i === 1 ? 17 : 15, fontWeight: i === 1 ? 800 : 600, color: col }}>{sideTxt(v)}</span>
          </div>
        ))}
      </div>
      <div style={{ ...box, justifyContent: 'center', color: C.soft, fontSize: 12.5 }}>
        <FreshDot state={fresh} ts={oldest} />
        {edge != null && <span data-testid="live-combo-edge">{limitVsMid(entry, edge, isCredit)}</span>}
      </div>
    </div>
  );
}

/**
 * Your limit against the mid, in the words that matter: asking for more than the
 * market (a credit above the mid, a debit below it) may not fill; the other way
 * fills easily but gives the difference away.
 */
export function limitVsMid(entry, edge, isCredit) {
  if (edge === 0) return `your limit ${entry.toFixed(2)} is at the mid`;
  const above = edge > 0;
  const greedy = isCredit ? above : !above;
  return `your limit ${entry.toFixed(2)} is ${Math.abs(edge).toFixed(2)} ${above ? 'above' : 'below'} the mid — `
    + (greedy ? 'may not fill' : `fills easily, gives up ${Math.abs(edge).toFixed(2)}`);
}

/** Each leg's live quote and greeks. */
export function LiveLegs({ underlying, legs }) {
  const watch = (legs || []).map(l => ({ underlying, expiry: l.expiry, strike: l.strike, right: l.right, qty: Number(l.qty) || 0 }));
  const keys = useLegKeys(watch);
  const quotes = useLiveQuotes();
  const { connection, status } = useLiveConnection();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(id); }, []);
  if (!watch.length || connection === 'off') return null;
  const phase = marketClock(new Date(now)).phase;
  const ctx = { now, connection, bridgeConnected: status.connected !== false, farmOk: status.farmOk !== false, marketOpen: phase === 'open' || phase === 'late' };
  const th = (t, al = 'right') => <th scope="col" style={{ ...CAPS, padding: '6px 4px', textAlign: al, fontWeight: 500 }}>{t}</th>;
  const td = (v, extra = {}) => <td style={{ padding: '6px 4px', fontFamily: MONO, textAlign: 'right', color: C.soft, ...extra }}>{v}</td>;
  let dSum = 0, tSum = 0, gOk = true;
  const rows = watch.map((l, i) => {
    const q = quotes[keys[i]] || {};
    if (q.delta == null || q.theta == null) gOk = false; else { dSum += l.qty * q.delta; tSum += l.qty * q.theta; }
    return (
      <tr key={keys[i]} style={{ borderTop: `1px solid ${C.line2}` }}
        title={[q.theta != null ? `theta ${q.theta.toFixed(2)}` : '', q.iv != null ? `IV ${q.iv.toFixed(1)}%` : ''].filter(Boolean).join(' · ')}>
        <td style={{ padding: '6px 4px', color: l.qty < 0 ? C.red : C.green, fontWeight: 600, whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6 }}>
          <FreshDot state={freshnessOf(q.ts ? q : null, ctx)} ts={q.ts} size={6} />
          {l.qty < 0 ? 'Short' : 'Long'}{Math.abs(l.qty) > 1 ? ` ×${Math.abs(l.qty)}` : ''} {l.strike}{l.right}</td>
        {td(`${f2(q.bid)} × ${f2(q.ask)}`, { whiteSpace: 'nowrap' })}{td(f2(q.mark), { color: C.text, fontWeight: 700 })}
        {td(q.delta == null ? '—' : (q.delta >= 0 ? '+' : '−') + Math.abs(q.delta).toFixed(2))}
      </tr>
    );
  });
  return (
    <div data-testid="live-legs" style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
        <thead><tr>{th('Leg', 'left')}{th('Bid × Ask')}{th('Mark')}{th('Delta')}</tr></thead>
        <tbody>
          {rows}
          {gOk && (
            <tr style={{ borderTop: `1px solid ${C.line2}` }}>
              <td style={{ padding: '6px 4px', color: C.text, fontWeight: 700 }}>Per lot</td>
              {td(`theta ${(tSum >= 0 ? '+' : '−') + Math.abs(tSum).toFixed(2)}`, { color: C.text })}<td />
              {td((dSum >= 0 ? '+' : '−') + Math.abs(dSum).toFixed(2), { color: C.text, fontWeight: 700 })}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Ask TWS what the entry would cost in margin and commission. Re-asks (after a short
 * pause) when the legs, size, price or account change, while the bridge is connected.
 */
export function useWhatIf({ underlying, legs, lots, entry, isCredit, enabled = true }) {
  const [st, setSt] = useState({ s: 'idle' });
  const { connection, status } = useLiveConnection();
  let account = '';
  try { account = localStorage.getItem(ACCT_KEY) || ''; } catch { /* private */ }
  const ready = enabled && connection === 'open' && status.connected && Array.isArray(legs) && legs.length >= 2 && lots >= 1 && entry > 0 && !!underlying;
  const sig = JSON.stringify([underlying, legs, lots, entry, isCredit, account]);
  useEffect(() => {
    if (!ready) { setSt({ s: 'idle' }); return undefined; }
    let dead = false;
    const t = setTimeout(async () => {
      setSt(prev => ({ ...prev, s: 'busy' }));
      try {
        const r = await fetch(bridgeBase() + '/api/what-if', { method: 'POST', headers: HDR,
          body: JSON.stringify({ underlying, legs, lots, side: isCredit ? 'credit' : 'debit', entry, account: account || undefined }) });
        let j = null; try { j = await r.json(); } catch { j = null; }
        if (dead) return;
        if (r.status === 404) throw new Error('The bridge is on old code — git pull on the Mac and restart it');
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || `bridge said ${r.status}`);
        setSt({ s: 'ok', w: j.whatIf, excess: j.excessAfter, at: Date.now() });
      } catch (e) { if (!dead) setSt({ s: 'err', msg: e.message || String(e) }); }
    }, 1200);
    return () => { dead = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, ready]);
  return st;
}

export function WhatIfBlock({ st }) {
  if (!st || st.s === 'idle') return null;
  const row = (k, v, col = C.text) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: `1px solid ${C.line2}`, fontSize: 13, color: C.soft }}>
      <span>{k}</span><span style={{ fontFamily: MONO, color: col }}>{v}</span>
    </div>
  );
  const w = st.w || {};
  const comm = w.commission != null ? w.commission : w.minCommission != null && w.maxCommission != null ? (w.minCommission + w.maxCommission) / 2 : null;
  return (
    <div data-testid="what-if" style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ ...CAPS, paddingBottom: 4 }}>TWS what-if {st.s === 'busy' ? '· asking…' : ''}</span>
      {st.s === 'err' ? <div style={{ fontSize: 12.5, color: C.amber }}>{st.msg}</div> : (
        <>
          {row('Margin required', $(w.initMarginChange))}
          {row('Commission and fees', comm == null ? '—' : $(comm) + (w.commission == null && comm != null ? ' (est.)' : ''))}
          {st.excess != null && row('Excess liquidity after', $(st.excess), st.excess < 0 ? C.red : C.text)}
          {w.warning ? <div style={{ fontSize: 12.5, color: C.amber, paddingTop: 4 }}>{w.warning}</div> : null}
        </>
      )}
    </div>
  );
}

export default function MarketCard({ underlying, legs, lots, entry, isCredit, onGoToOrder, whyNot }) {
  const st = useWhatIf({ underlying, legs, lots, entry, isCredit });
  const { connection } = useLiveConnection();
  return (
    <section data-testid="market-card" className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0, flex: '1 1 auto', width: '100%', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>Market</span>
        <span style={{ flex: 1 }} />
        {connection !== 'open' && <span style={{ fontSize: 12, color: C.grey }}>{connection === 'off' ? 'set the bridge URL for live prices' : 'live stream ' + connection}</span>}
      </div>
      {legs && legs.length ? (
        <>
          <LiveCombo underlying={underlying} legs={legs} entry={entry} isCredit={isCredit} />
          <LiveLegs underlying={underlying} legs={legs} />
          <WhatIfBlock st={st} />
        </>
      ) : <div style={{ fontSize: 13, color: C.grey }}>{whyNot || 'Live prices appear once the structure has listed strikes.'}</div>}
      {onGoToOrder && (
        <button type="button" data-testid="go-to-order" onClick={onGoToOrder}
          style={{ marginTop: 'auto', padding: '10px 14px', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer',
            border: '1px solid var(--c-2f81f7)', background: 'color-mix(in srgb, var(--c-2f81f7) 18%, transparent)', color: 'var(--c-ffffff)' }}>
          Order and exit plan ↓
        </button>
      )}
    </section>
  );
}
