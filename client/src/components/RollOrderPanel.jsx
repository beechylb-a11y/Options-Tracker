import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Copy, Check } from 'lucide-react';
import { api } from '../utils/api';
import { legsFromNotes, matchTicketLegs } from '../utils/positionMatch';
import { tradingSession } from '../engine/session';
import { buildRollOrder, priceRollOrder, rollOrderText, fmtExp } from '../engine/rollOrder';

// ── The roll order, ready to place (Oct 2026) ──
// The legs that move, each with its action, live bid / ask / mid, the price of the
// whole roll at mid and at natural, a limit to send, and the order written out for
// TWS. "Use these prices" fills the two record fields below from the same quotes.

const C = { text: '#e6edf3', muted: '#8b949e', faint: '#6e7681', border: '#30363d', panel: '#0d1117',
  buy: '#3fb950', sell: '#f85149', amber: '#d29922', blue: '#58a6ff' };
const snapTo = (x, t) => Math.round(x / t) * t;

async function getJson(url, ms = 30000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal }); return JSON.parse(await r.text()); }
  catch (e) { return { error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

export default function RollOrderPanel({ pos, roll, oldStrikes, lots, tick = 0.01, onUse, onShape, onPrice, onLegs }) {
  const [oldLegs, setOldLegs] = useState(null);       // per lot, signed
  const [legSrc, setLegSrc] = useState('');
  const [quotes, setQuotes] = useState(null);
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState('');
  const [copied, setCopied] = useState(false);
  let bridgeUrl = '';
  try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }

  // The position's legs: the Legs line logged with the ticket, else TWS.
  useEffect(() => {
    let dead = false;
    (async () => {
      const decs = await Promise.resolve().then(() => api.getDecisions()).catch(() => []);
      const d = (decs || []).find(x => (pos.timestamp && x.Timestamp === pos.timestamp) || Number(x._rowIndex) === Number(pos.ticketRef));
      const fromNotes = d ? legsFromNotes(d.Notes) : null;
      if (fromNotes && !dead) { setOldLegs(fromNotes); setLegSrc('ticket'); return; }
      if (!bridgeUrl) { if (!dead) { setOldLegs([]); setLegSrc('none'); } return; }
      const p = await getJson(bridgeUrl + '/api/positions', 12000);
      const m = matchTicketLegs({ underlying: pos.underlying, strikes: pos.legs, strategy: pos.strategy, qtyOpen: pos.qtyOpen,
        todayYmd: tradingSession().yyyymmdd }, p && Array.isArray(p.raw) ? p.raw : []);
      if (!dead) { setOldLegs(m.legs || []); setLegSrc(m.legs ? 'TWS' : 'none'); }
    })();
    return () => { dead = true; };
  }, [pos.ticketRef]);   // eslint-disable-line react-hooks/exhaustive-deps

  const order = useMemo(() => buildRollOrder({ oldLegs: oldLegs || [], oldStrikes, newStrikes: roll.strikes,
    newExpiry: roll.expiry, lots: Math.max(1, lots || 1) }), [oldLegs, oldStrikes, roll.strikes, roll.expiry, lots]);
  const key = JSON.stringify(order.legs.map(l => [l.action, l.strike, l.right, l.expiry]));

  // Tell the ticket whether every leg moves (rolling out in time does), so its record
  // step does not ask for a carried-leg price that has no carried leg.
  useEffect(() => { onShape && onShape({ allMoved: order.all, carried: order.carried.length }); }, [order.all, order.carried.length]);   // eslint-disable-line react-hooks/exhaustive-deps

  const timer = useRef(null);
  async function pull() {
    if (!order.legs.length || !bridgeUrl) return;
    setStatus('Asking TWS for quotes…');
    const g = await getJson(`${bridgeUrl}/api/option-greeks?underlying=${encodeURIComponent(pos.underlying)}&expiry=${order.legs[0].expiry}&legs=`
      + encodeURIComponent(JSON.stringify(order.legs.map(l => ({ strike: l.strike, right: l.right, qty: 1, expiry: l.expiry })))), 40000);
    if (!g || g.error || !Array.isArray(g.legs)) { setQuotes(null); setStatus(`No quotes: ${(g && g.error) || 'no reply'}`); return; }
    setQuotes(g.legs.map(x => (x && x.greeks) || {}));
    setStatus(`Quotes ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}`);
  }
  useEffect(() => {
    setQuotes(null);
    clearTimeout(timer.current);
    if (order.legs.length) timer.current = setTimeout(pull, 700);
    return () => clearTimeout(timer.current);
  }, [key]);   // eslint-disable-line react-hooks/exhaustive-deps

  const price = quotes ? priceRollOrder(order.legs, quotes, lots) : null;
  // The ticket draws the before/after picture from these: the legs held now, and the
  // roll's mid (per share, + credit) once quoted.
  useEffect(() => { onLegs && oldLegs && onLegs(oldLegs); }, [oldLegs]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onPrice && onPrice(price && price.complete ? price.mid : null); }, [quotes, key]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (price && price.complete) setLimit(snapTo(price.mid, tick).toFixed(2)); }, [quotes]);   // eslint-disable-line react-hooks/exhaustive-deps
  const lim = parseFloat(limit);
  const text = order.legs.length ? rollOrderText({ underlying: pos.underlying, legs: order.legs, price, limit: Number.isFinite(lim) ? lim : null, lots }) : '';

  function use() {
    if (!price || !price.complete) return;
    // The record fields take the close in close-side units and the open with its side.
    const close = pos.isCredit ? -price.closeMid : price.closeMid;
    onUse({ closeAt: Math.abs(close).toFixed(2), openAt: Math.abs(price.openMid).toFixed(2), openSide: price.openMid >= 0 ? 'cr' : 'db' });
  }

  if (oldLegs == null) return <div style={{ fontSize: 12.5, color: C.muted, marginTop: 12 }}>Finding the position's legs…</div>;
  if (!oldLegs.length) {
    return <div data-testid="roll-order-nolegs" style={{ fontSize: 12.5, color: C.amber, marginTop: 12 }}>
      The legs of this position aren't known (no Legs line on the ticket{bridgeUrl ? ', and TWS shows no position at these strikes' : ', and no bridge set'}), so the roll order can't be built. The record fields below still work.
    </div>;
  }
  const net = Number.isFinite(lim) ? lim : price && price.complete ? price.mid : null;
  return (
    <div data-testid="roll-order" style={{ marginTop: 12, border: `1px solid ${C.border}`, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#161b22', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' }}>
        <b style={{ color: C.text, fontSize: 13.5 }}>Roll order</b>
        <span style={{ fontSize: 12, color: C.muted }}>{order.legs.length / 2} leg{order.legs.length / 2 === 1 ? '' : 's'} move{order.carried.length ? ` · ${order.carried.length} carr${order.carried.length === 1 ? 'ies' : 'y'} across` : ''} · legs from {legSrc}</span>
        <button onClick={pull} disabled={!bridgeUrl || !order.legs.length} className="flex items-center gap-1" data-testid="roll-quotes"
          style={{ marginLeft: 'auto', fontSize: 12.5, color: C.blue }}><RefreshCw size={12} /> {bridgeUrl ? 'Refresh quotes' : 'No bridge set'}</button>
      </div>
      {!order.legs.length ? (
        <div style={{ padding: 12, fontSize: 12.5, color: C.muted }}>Change a strike or the expiry above and the order builds here.</div>
      ) : (<>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: C.faint, fontSize: 11.5, textAlign: 'right' }}>
            <th style={{ textAlign: 'left', padding: '6px 12px', fontWeight: 400 }}>Leg</th>
            <th style={{ fontWeight: 400 }}>Bid</th><th style={{ fontWeight: 400 }}>Ask</th><th style={{ fontWeight: 400, paddingRight: 12 }}>Mid</th>
          </tr></thead>
          <tbody>
            {order.legs.map((l, i) => {
              const q = quotes && quotes[i];
              const mid = q && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
              const col = l.action === 'BUY' ? C.buy : C.sell;
              const open = l.role === 'open';
              return (
                <tr key={i} data-testid="roll-leg" style={{ borderTop: `1px solid #21262d`, background: open ? 'rgba(88,166,255,0.06)' : 'transparent' }}>
                  <td style={{ padding: '6px 12px' }}>
                    <span className="mono" style={{ fontWeight: 800, color: col, display: 'inline-block', width: 40 }}>{l.action}</span>
                    <span className="mono" style={{ color: C.text }}>{l.qty} × {pos.underlying} {fmtExp(l.expiry)} <b>{l.strike}{l.right}</b></span>
                    <span style={{ marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 4, color: open ? C.blue : C.muted, border: `1px solid ${open ? '#1f6feb' : C.border}` }}>
                      {open ? `open · was ${l.from}` : 'close'}</span>
                  </td>
                  <td className="mono" style={{ textAlign: 'right', color: l.action === 'SELL' ? C.text : C.faint }}>{q && q.bid > 0 ? q.bid.toFixed(2) : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right', color: l.action === 'BUY' ? C.text : C.faint }}>{q && q.ask > 0 ? q.ask.toFixed(2) : '—'}</td>
                  <td className="mono" style={{ textAlign: 'right', paddingRight: 12, color: C.muted }}>{mid != null ? mid.toFixed(2) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ padding: '10px 12px', borderTop: `1px solid ${C.border}`, background: C.panel }}>
          {price && price.complete ? (
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div data-testid="roll-net">
                <div style={{ fontSize: 11.5, color: C.muted }}>Roll at mid, per combo</div>
                <div className="mono" style={{ fontSize: 22, fontWeight: 800, color: price.mid >= 0 ? C.buy : C.amber }}>
                  {Math.abs(price.mid).toFixed(2)} {price.mid >= 0 ? 'CREDIT' : 'DEBIT'}</div>
                <div style={{ fontSize: 11.5, color: C.faint }}>
                  close {Math.abs(price.closeMid).toFixed(2)} {price.closeMid >= 0 ? 'cr' : 'db'} · open {Math.abs(price.openMid).toFixed(2)} {price.openMid >= 0 ? 'cr' : 'db'} · natural {price.natural.toFixed(2)}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11.5, color: C.muted }}>Limit to send (+ credit / − debit)</div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="number" step={tick} value={limit} onChange={e => setLimit(e.target.value)} data-testid="roll-limit"
                    style={{ width: 90, padding: '5px 8px', borderRadius: 6, border: `1px solid ${C.border}`, background: '#161b22', color: C.text }} className="mono" />
                  <button onClick={() => setLimit(snapTo(price.mid, tick).toFixed(2))} style={{ fontSize: 12, color: C.blue }}>mid</button>
                  <button onClick={() => setLimit(snapTo((price.mid + price.natural) / 2, tick).toFixed(2))} style={{ fontSize: 12, color: C.blue }}>halfway</button>
                  <button onClick={() => setLimit(snapTo(price.natural, tick).toFixed(2))} style={{ fontSize: 12, color: C.blue }}>natural</button>
                </div>
                <div style={{ fontSize: 11.5, color: C.faint, marginTop: 2 }}>
                  {net != null ? `$${Math.abs(net * 100 * lots).toLocaleString(undefined, { maximumFractionDigits: 0 })} ${net >= 0 ? 'taken in' : 'paid'} on ${lots} contract${lots === 1 ? '' : 's'}` : ''}
                  {price.mid < 0 && pos.isCredit ? ' · a roll for a debit is a new bet — close instead?' : ''}
                </div>
              </div>
              <button onClick={use} data-testid="roll-use" style={{ marginLeft: 'auto', padding: '7px 12px', borderRadius: 8, border: '1px solid #9e6a03', color: '#e3b341', fontSize: 12.5 }}>
                Use these prices below</button>
            </div>
          ) : <div style={{ fontSize: 12.5, color: C.muted }}>{status || (bridgeUrl ? 'Waiting for quotes…' : 'Set the bridge URL in Settings for live quotes.')}</div>}
          {price && price.complete && status && <div style={{ fontSize: 11, color: C.faint, marginTop: 4 }}>{status}</div>}
        </div>
        <div style={{ borderTop: `1px solid ${C.border}`, padding: '8px 12px', background: '#010409' }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 11.5, color: C.muted }}>To place in TWS</span>
            <button onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch (e) { /* no clipboard */ } }}
              className="flex items-center gap-1" style={{ marginLeft: 'auto', fontSize: 12, color: C.blue }} data-testid="roll-copy">
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy'}</button>
          </div>
          <pre data-testid="roll-text" className="mono" style={{ margin: 0, fontSize: 12, color: '#c9d1d9', whiteSpace: 'pre-wrap' }}>{text}</pre>
        </div>
      </>)}
    </div>
  );
}
