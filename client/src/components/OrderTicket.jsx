import React, { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { startCloseVolSnapshot } from '../utils/volSnapshot';
import {
  normalisePosition, targetToPrice, priceToTarget, pnlAt, feesFor, ibkrLines,
  ladder, LADDER_PRESETS, rollSummary, snap, defaultTick, loadPlan, savePlan, round2, stopToPrice
} from '../utils/ticketMath';
import TicketHelp, { OFFSET_TIP } from './TicketHelp';

// SELL ticket — modelled on the IBKR order ticket. Two jobs:
//
//   Close   scale out of ONE buy-in in tranches. Each row is a working limit
//           (qty, % of max profit ⇄ limit price ⇄ $), mark it Filled with the fill
//           price and it is written as its own row in Closes; the rest stay on the
//           ticket as the plan for next time. Replaces the one-tranche-at-a-time
//           "Partial close" toggle, which is still how the server records them.
//   Roll    45DTE: take the old legs off and put the new ones on as one combo.
//           Realises P&L on the old ticket for the rolled qty and logs a NEW
//           ticket for the new legs, linked in both notes, so the realised result
//           and the new risk are never blended into one number.
//
// Works the same for paper and TWS accounts — nothing here needs the bridge. For
// TWS accounts the fill fetch is offered alongside, as a cross-check.
//
// props: position (Journal decision row OR OpenPositions row), onClose, onDone
const inp = {
  padding: '6px 8px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 13, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%'
};
const lbl = { fontSize: 11.5, color: '#a8b2be', display: 'block', marginBottom: 3 };
const MANUAL_ACCOUNT_PREFIXES = ['papertrade'];

function readCommission() {
  try { const v = parseFloat(localStorage.getItem('commissionPerLeg')); return isFinite(v) ? v : 0.65; }
  catch (e) { return 0.65; }
}

export default function OrderTicket({ position, onClose, onDone, initialTab }) {
  const pos = useMemo(() => normalisePosition(position), [position]);
  const tick = defaultTick(pos.underlying);
  const side = pos.isCredit ? 'db' : 'cr';                      // side the CLOSE prices on
  const isManual = MANUAL_ACCOUNT_PREFIXES.some(p => pos.account.toLowerCase().startsWith(p));
  const is45 = /45/.test(pos.engine);
  const [tab, setTab] = useState(initialTab || 'close');
  const [commission, setCommission] = useState(readCommission());
  const [closeDate, setCloseDate] = useState(new Date().toISOString().split('T')[0]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  // ── tranche rows ────────────────────────────────────────────────────────
  // Seeded from the plan saved at entry (engine profit-taker ladder) when there is
  // one; otherwise a sensible ladder for the engine. Plans store {qty, pct}; the
  // limit is re-derived so an edited Max Profit can never leave a stale price.
  const mkRow = (qty, pct) => ({ qty, pct, price: snap(targetToPrice(pos, pct), tick), status: 'Working', fill: '' });
  const [rows, setRows] = useState(() => {
    const saved = loadPlan(pos.timestamp);
    const src = saved?.rows?.length ? saved.rows : ladder(pos.qtyOpen || 1, (is45 ? LADDER_PRESETS['45DTE'] : LADDER_PRESETS['0DTE']).pcts);
    // Trim the plan to what is still open. Contracts closed since the plan was
    // saved came off the FRONT of the ladder (the nearest targets fill first), so
    // skip that many from the front and keep the runners.
    const planned = saved?.rows?.length ? (saved.openAtSave ?? pos.qty) : pos.qtyOpen;
    let skip = Math.max(0, planned - (pos.qtyOpen || 0)), left = pos.qtyOpen || 0; const out = [];
    for (const r of src) {
      let q = r.qty; const s = Math.min(skip, q); skip -= s; q -= s;
      q = Math.min(q, left); if (q <= 0) continue; left -= q; out.push(mkRow(q, r.pct));
    }
    return out.length ? out : [mkRow(pos.qtyOpen || 1, 50)];
  });
  const [stopPct, setStopPct] = useState(() => loadPlan(pos.timestamp)?.stopPct ?? '');

  const setRow = (i, patch) => setRows(rs => rs.map((r, j) => j === i ? { ...r, ...patch } : r));
  const onPct = (i, v) => { const pct = parseFloat(v); setRow(i, { pct: v, price: isFinite(pct) ? snap(targetToPrice(pos, pct), tick) : '' }); };
  const onPrice = (i, v) => { const p = parseFloat(v); const t = isFinite(p) ? priceToTarget(pos, p) : null; setRow(i, { price: v, pct: t != null ? round2(t) : '' }); };
  const applyPreset = key => setRows(ladder(pos.qtyOpen || 1, LADDER_PRESETS[key].pcts).map(r => mkRow(r.qty, r.pct)));

  const allocated = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);
  const overAllocated = allocated > pos.qtyOpen;
  const filled = rows.filter(r => r.status === 'Filled' && Number(r.qty) > 0);
  const rowFill = r => parseFloat(r.status === 'Filled' && r.fill !== '' ? r.fill : r.price);
  const rowNet = r => { const q = Number(r.qty) || 0, p = rowFill(r); return isFinite(p) ? pnlAt(pos, p, q) - feesFor(q, pos.legs, commission) : 0; };
  const planNet = rows.reduce((a, r) => a + rowNet(r), 0);
  const filledNet = filled.reduce((a, r) => a + rowNet(r), 0);
  const stopPrice = stopPct !== '' && isFinite(parseFloat(stopPct)) ? snap(stopToPrice(pos, parseFloat(stopPct)), tick) : null;

  // Vol snapshot + TWS fills, both best-effort, both started on open.
  const snapRef = useRef({});
  useEffect(() => { snapRef.current = startCloseVolSnapshot(pos.underlying, { expiry: pos.engine === '0DTE' ? pos.entryDate : '' }); // eslint-disable-next-line
  }, []);
  const [fills, setFills] = useState(null);
  async function fetchFills() {
    const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
    if (!bridgeUrl) { setMsg({ err: true, text: 'Set IBKR Bridge URL in Settings first.' }); return; }
    try {
      const d = await (await fetch(bridgeUrl + '/api/executions', { headers: { 'ngrok-skip-browser-warning': '1' } })).json();
      const sym = pos.underlying;
      setFills((d.fills || []).filter(f => (f.symbol || '').toUpperCase() === sym));
    } catch (e) { setMsg({ err: true, text: 'TWS fetch failed: ' + e.message }); }
  }

  function persistPlan(remaining, openAfter) {
    const rowsOut = remaining.map(r => ({ qty: Number(r.qty) || 0, pct: parseFloat(r.pct) || 0 }));
    savePlan(pos.timestamp, { rows: rowsOut, stopPct, openAtSave: openAfter });
  }

  async function recordFills() {
    if (!filled.length || overAllocated) return;
    setBusy(true); setMsg(null);
    const snapV = snapRef.current || {};
    try {
      // Sequential, never parallel: the server counts prior tranches to work out
      // what is still open, so two in flight would both see the same open qty.
      for (let i = 0; i < filled.length; i++) {
        const r = filled[i], q = Number(r.qty), p = rowFill(r);
        const fees = feesFor(q, pos.legs, commission);
        const n = rows.indexOf(r) + 1;
        await api.closeTicket(pos.ticketRef, {
          closeDate, closePrice: p, qtyClosed: q, fees,
          actualPnl: round2(pnlAt(pos, p, q) - fees),
          notes: [`T${n} ${parseFloat(r.pct).toFixed(0)}% target @ ${parseFloat(r.price).toFixed(2)} ${side}`, notes].filter(Boolean).join(' — '),
          account: pos.account,
          ...(i === 0 ? {
            sessionHigh: snapV.sessionHigh ?? null, sessionLow: snapV.sessionLow ?? null,
            closeVix: snapV.closeVix ?? null, closeIV: snapV.closeIV ?? null,
            closeUnderlyingPrice: snapV.closeUnderlyingPrice ?? null, closeVix1d: snapV.closeVix1d ?? null
          } : {})
        });
      }
      persistPlan(rows.filter(r => r.status !== 'Filled'), pos.qtyOpen - filled.reduce((a, r) => a + Number(r.qty), 0));
      onDone && onDone();
    } catch (e) {
      setMsg({ err: true, text: 'Close failed part-way: ' + e.message + ' — check Open positions before retrying; tranches already written stay written.' });
    }
    setBusy(false);
  }

  // ── roll ────────────────────────────────────────────────────────────────
  const oldStrikes = pos.legs.split(/[\/|,\s]+/).map(Number).filter(x => x > 0);
  const [roll, setRoll] = useState({
    qty: pos.qtyOpen || 1, closeAt: '', openAt: '', openSide: pos.isCredit ? 'cr' : 'db',
    expiry: '', strikes: oldStrikes.map(String)
  });
  const rq = Math.min(Number(roll.qty) || 0, pos.qtyOpen);
  const closeAt = parseFloat(roll.closeAt), openAtAbs = parseFloat(roll.openAt);
  const openNcd = isFinite(openAtAbs) ? (roll.openSide === 'cr' ? openAtAbs : -openAtAbs) : null;
  const rs = isFinite(closeAt) && openNcd != null ? rollSummary(pos, rq, closeAt, openNcd) : null;
  const rollFees = feesFor(rq, pos.legs, commission) * 2;         // two sides of the combo
  const newLegs = roll.strikes.join(' / ');
  const changedLegs = roll.strikes.filter((s, i) => Number(s) !== oldStrikes[i]).length;

  async function recordRoll() {
    if (!rs || rq <= 0) return;
    setBusy(true); setMsg(null);
    const snapV = snapRef.current || {};
    const halfFees = feesFor(rq, pos.legs, commission);
    try {
      const oldRef = pos.ticketRef;
      await api.closeTicket(oldRef, {
        closeDate, closePrice: closeAt, qtyClosed: rq, fees: halfFees,
        actualPnl: round2(rs.realised - halfFees),
        notes: [`ROLLED → ${newLegs}${roll.expiry ? ' exp ' + roll.expiry : ''} @ ${openAtAbs.toFixed(2)} ${roll.openSide} (net roll ${rs.net >= 0 ? rs.net.toFixed(2) + ' cr' : Math.abs(rs.net).toFixed(2) + ' db'})`, notes].filter(Boolean).join(' — '),
        account: pos.account,
        sessionHigh: snapV.sessionHigh ?? null, sessionLow: snapV.sessionLow ?? null,
        closeVix: snapV.closeVix ?? null, closeIV: snapV.closeIV ?? null,
        closeUnderlyingPrice: snapV.closeUnderlyingPrice ?? null, closeVix1d: snapV.closeVix1d ?? null
      });
      await api.logDecision({
        engine: pos.engine || '45DTE', underlying: pos.underlying,
        strategy: `${pos.underlying} - ${pos.strategy} - ${rq} contract${rq !== 1 ? 's' : ''}`,
        direction: 'Roll', contracts: rq, wingStrikes: newLegs, engineStrikes: newLegs,
        netCreditDebit: openNcd,
        // Max profit/risk are left blank on purpose: they depend on leg types and
        // widths the roll ticket does not model. Open the new legs in the engine
        // for those; % targets fall back to the entry credit meanwhile.
        notes: `Rolled from TICKET-${oldRef} (${pos.legs}, entry ${Math.abs(pos.ncd).toFixed(2)} ${pos.isCredit ? 'cr' : 'db'}). `
          + `Closed old @ ${closeAt.toFixed(2)} ${side}, realised ${fmt$(rs.realised - halfFees)} on ${rq}. `
          + `Opened new @ ${openAtAbs.toFixed(2)} ${roll.openSide}${roll.expiry ? ', exp ' + roll.expiry : ''}. `
          + `Net roll ${rs.net >= 0 ? rs.net.toFixed(2) + ' cr' : Math.abs(rs.net).toFixed(2) + ' db'}; cumulative basis ${rs.cumulative.toFixed(2)} ${rs.cumulative >= 0 ? 'cr' : 'db'}.`
          + (notes ? '\n\n--- My notes ---\n' + notes : ''),
        account: pos.account, timestamp: new Date().toISOString(),
        price: snapV.closeUnderlyingPrice || '', vix: snapV.closeVix || '',
        dte: '45DTE', expiryDate: roll.expiry || ''
      });
      onDone && onDone();
    } catch (e) {
      setMsg({ err: true, text: 'Roll failed: ' + e.message + ' — if the old tranche was written but the new ticket was not, log the new legs from the engine.' });
    }
    setBusy(false);
  }

  const Tab = ({ id, children }) => (
    <button onClick={() => setTab(id)} style={{
      padding: '6px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', border: 'none',
      borderBottom: `2px solid ${tab === id ? (id === 'close' ? '#f85149' : '#d29922') : 'transparent'}`,
      background: 'transparent', color: tab === id ? '#e6edf3' : '#8b949e'
    }}>{children}</button>
  );

  const noEntry = pos.ncd == null || pos.ncd === 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, width: 720, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* Header — IBKR-style: symbol, structure, position line */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>
              <span style={{ background: '#2d0f11', color: '#f85149', borderRadius: 4, padding: '1px 7px', fontSize: 12, marginRight: 8 }}>SELL</span>
              {pos.underlying} · {pos.strategy}
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: '#a8b2be', marginTop: 4 }}>
              {pos.legs || '—'} · {pos.engine || '—'} · opened {pos.entryDate || '—'} · {pos.account || 'no account'}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#a8b2be', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 6, marginBottom: 12 }}>
          {[
            ['Open / Qty', `${pos.qtyOpen} / ${pos.qty}`],
            ['Entry', noEntry ? '—' : `${Math.abs(pos.ncd).toFixed(2)} ${pos.isCredit ? 'cr' : 'db'}`],
            ['Max profit / ct', pos.maxProfitPerContract ? fmt$(pos.maxProfitPerContract) : `${fmt$(Math.abs(pos.ncd || 0) * 100)}*`],
            ['Banked', pos.realised ? fmt$(pos.realised) : '—'],
            ['Close prices as', pos.isCredit ? 'DEBIT' : 'CREDIT'],
          ].map(([k, v]) => (
            <div key={k} style={{ background: '#0d1117', borderRadius: 6, padding: '6px 8px' }}>
              <div style={{ fontSize: 11, color: '#8b949e' }}>{k}</div>
              <div className="mono" style={{ fontSize: 14, fontWeight: 700, color: '#e6edf3' }}>{v}</div>
            </div>
          ))}
        </div>
        {!pos.maxProfitPerContract && !noEntry && (
          <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: -6, marginBottom: 10 }}>
            * No Max Profit on this ticket — targets use the entry {pos.isCredit ? 'credit' : 'debit'} as the base. Right for credit spreads; understates a debit fly.
          </div>
        )}
        {noEntry && (
          <div style={{ padding: 8, borderRadius: 6, background: '#1f1a0d', border: '1px solid #9e6a03', color: '#d29922', fontSize: 12.5, marginBottom: 10 }}>
            This ticket has no Net Debit/Credit, so targets and P&L can't be derived. Enter P&L by hand via the Journal close, or re-log from the engine.
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #21262d', marginBottom: 12 }}>
          <Tab id="close">Close · scale out</Tab>
          <Tab id="roll">Roll{is45 ? ' · 45DTE' : ''}</Tab>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#a8b2be' }}>
            Comm / leg / ct
            <input type="number" step="0.01" value={commission} style={{ ...inp, width: 64 }}
              onChange={e => { setCommission(e.target.value); try { localStorage.setItem('commissionPerLeg', e.target.value); } catch (x) { /* */ } }} />
          </div>
        </div>

        {tab === 'close' && (<>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: '#8b949e' }}>Ladder:</span>
            {Object.entries(LADDER_PRESETS).map(([k, p]) => (
              <button key={k} onClick={() => applyPreset(k)} style={{ fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #30363d', background: 'transparent', color: '#c9d1d9', cursor: 'pointer' }}>{p.label}</button>
            ))}
            <button onClick={() => setRows(r => [...r, mkRow(Math.max(1, pos.qtyOpen - allocated), 50)])}
              style={{ fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #2f81f7', background: 'transparent', color: '#58a6ff', cursor: 'pointer' }}>+ Tranche</button>
            {!isManual && (
              <button onClick={fetchFills} style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 8px', borderRadius: 5, border: '1px solid #2f81f7', background: '#0d1a2e', color: '#58a6ff', cursor: 'pointer' }}>⚡ TWS fills</button>
            )}
          </div>

          <table className="w-full" style={{ fontSize: 13, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: '#8b949e', fontSize: 11.5, textAlign: 'left' }}>
                <th style={{ padding: 4 }}>#</th><th style={{ padding: 4, width: 60 }}>Qty</th>
                <th style={{ padding: 4, width: 80 }}>% max</th><th style={{ padding: 4, width: 92 }}>LMT {side}</th>
                <th style={{ padding: 4 }}>Status</th><th style={{ padding: 4, width: 92 }}>Fill @</th>
                <th style={{ padding: 4, textAlign: 'right' }}>Net P&L</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const net = rowNet(r);
                const p = parseFloat(r.price);
                const ib = isFinite(p) && !noEntry ? ibkrLines(pos, p) : null;
                return (
                  <React.Fragment key={i}>
                    <tr style={{ borderTop: '1px solid #21262d' }}>
                      <td style={{ padding: 4, color: '#8b949e' }}>T{i + 1}</td>
                      <td style={{ padding: 4 }}><input type="number" min="1" value={r.qty} onChange={e => setRow(i, { qty: e.target.value })} style={inp} /></td>
                      <td style={{ padding: 4 }}><input type="number" step="5" value={r.pct} onChange={e => onPct(i, e.target.value)} style={inp} /></td>
                      <td style={{ padding: 4 }}><input type="number" step={tick} value={r.price} onChange={e => onPrice(i, e.target.value)} style={inp} /></td>
                      <td style={{ padding: 4 }}>
                        <button onClick={() => setRow(i, { status: r.status === 'Filled' ? 'Working' : 'Filled', fill: r.fill || r.price })}
                          style={{ fontSize: 12, fontWeight: 700, padding: '4px 10px', borderRadius: 5, cursor: 'pointer', border: '1px solid',
                            borderColor: r.status === 'Filled' ? '#238636' : '#9e6a03',
                            background: r.status === 'Filled' ? '#0d2818' : '#1f1a0d',
                            color: r.status === 'Filled' ? '#3fb950' : '#d29922' }}>{r.status}</button>
                      </td>
                      <td style={{ padding: 4 }}>
                        <input type="number" step={tick} disabled={r.status !== 'Filled'} value={r.status === 'Filled' ? r.fill : ''}
                          placeholder="—" onChange={e => setRow(i, { fill: e.target.value })} style={{ ...inp, opacity: r.status === 'Filled' ? 1 : 0.4 }} />
                      </td>
                      <td className="mono" style={{ padding: 4, textAlign: 'right', fontWeight: 700, color: pnlColor(net) }}>{fmt$(net)}</td>
                      <td style={{ padding: 4 }}>
                        <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} title="Remove tranche"
                          style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}>×</button>
                      </td>
                    </tr>
                    {ib && (
                      <tr><td></td><td colSpan={7} className="mono" style={{ padding: '0 4px 6px', fontSize: 11.5, color: '#8b949e' }}>
                        <span title={`${OFFSET_TIP}\n\nThis row: offset ${ib.offset >= 0 ? '+' : ''}${ib.offset.toFixed(2)} = ${ib.offsetPctOfEntry != null ? ib.offsetPctOfEntry.toFixed(0) : '—'}% of entry.`} style={{ cursor: 'help' }}>IBKR: {ib.buyConv}</span>{pos.isCredit ? ` · or ${ib.sellConv}` : ''}
                      </td></tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 10, alignItems: 'end' }}>
            <div>
              <label style={lbl}>Stop (loss as % of entry)</label>
              <input type="number" step="25" value={stopPct} placeholder={pos.isCredit ? 'e.g. 100' : 'e.g. 50'} title={pos.isCredit ? '100 = buy back at 2x the credit' : '50 = sell at half what you paid'} onChange={e => setStopPct(e.target.value)} style={inp} />
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: stopPrice != null ? '#f85149' : '#8b949e' }}>
              {stopPrice != null ? <>Stop LMT {stopPrice.toFixed(2)} {side} · {fmt$(pnlAt(pos, stopPrice, pos.qtyOpen) - feesFor(pos.qtyOpen, pos.legs, commission))} on {pos.qtyOpen}</> : 'No stop set'}
            </div>
            <div>
              <label style={lbl}>Close date</label>
              <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inp} />
            </div>
          </div>

          <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: '#0d1117', border: `1px solid ${overAllocated ? '#da3633' : '#21262d'}`, display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 13 }}>
            <span>Allocated <b className="mono" style={{ color: overAllocated ? '#f85149' : '#e6edf3' }}>{allocated} / {pos.qtyOpen}</b></span>
            <span>If all fill <b className="mono" style={{ color: pnlColor(planNet) }}>{fmt$(planNet)}</b></span>
            <span>Recording now <b className="mono" style={{ color: pnlColor(filledNet) }}>{filled.length} tranche{filled.length !== 1 ? 's' : ''} · {fmt$(filledNet)}</b></span>
            {overAllocated && <span style={{ color: '#f85149' }}>More contracts than are open.</span>}
          </div>

          {fills && (
            <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: '#0d1117', border: '1px solid #21262d', fontSize: 12.5 }}>
              {fills.length === 0 ? <span style={{ color: '#a8b2be' }}>No {pos.underlying} fills today.</span> : fills.map((f, i) => (
                <div key={i} className="mono" style={{ color: '#c9d1d9' }}>
                  <span style={{ color: f.side === 'BOT' ? '#3fb950' : '#f85149' }}>{f.side}</span> {f.qty}x {f.strike}{f.right} @{f.price?.toFixed(2)}
                  {f.realizedPnl && f.realizedPnl < 1e300 ? <span style={{ color: pnlColor(f.realizedPnl) }}> {fmt$(f.realizedPnl)}</span> : null}
                </div>
              ))}
            </div>
          )}
        </>)}

        {tab === 'roll' && (<>
          <div style={{ fontSize: 12.5, color: '#a8b2be', marginBottom: 10, lineHeight: 1.5 }}>
            One combo in TWS, two records here: the old ticket banks its P&amp;L on the rolled contracts, and the new legs open as a new ticket linked back to it. Change only the strikes that move — untested legs just carry across.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <div><label style={lbl}>Contracts to roll</label>
              <input type="number" min="1" max={pos.qtyOpen} value={roll.qty} onChange={e => setRoll(r => ({ ...r, qty: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>Close old @ ({side})</label>
              <input type="number" step={tick} value={roll.closeAt} onChange={e => setRoll(r => ({ ...r, closeAt: e.target.value }))} style={inp} /></div>
            <div><label style={lbl}>Open new @</label>
              <div style={{ display: 'flex', gap: 4 }}>
                <input type="number" step={tick} value={roll.openAt} onChange={e => setRoll(r => ({ ...r, openAt: e.target.value }))} style={inp} />
                <select value={roll.openSide} onChange={e => setRoll(r => ({ ...r, openSide: e.target.value }))} style={{ ...inp, width: 56 }}>
                  <option value="cr">cr</option><option value="db">db</option>
                </select>
              </div></div>
            <div><label style={lbl}>New expiry</label>
              <input type="date" value={roll.expiry} onChange={e => setRoll(r => ({ ...r, expiry: e.target.value }))} style={inp} /></div>
          </div>

          <div style={{ marginTop: 12 }}>
            <label style={lbl}>Legs — old → new ({changedLegs} moved)</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {oldStrikes.length === 0 && <span style={{ fontSize: 12.5, color: '#d29922' }}>No strikes on this ticket — type the new legs into the notes.</span>}
              {oldStrikes.map((s, i) => {
                const moved = Number(roll.strikes[i]) !== s;
                return (
                  <div key={i} style={{ background: '#0d1117', border: `1px solid ${moved ? '#d29922' : '#21262d'}`, borderRadius: 6, padding: 6, width: 110 }}>
                    <div className="mono" style={{ fontSize: 11.5, color: '#8b949e' }}>{s} →</div>
                    <input type="number" value={roll.strikes[i]} onChange={e => setRoll(r => { const st = [...r.strikes]; st[i] = e.target.value; return { ...r, strikes: st }; })}
                      style={{ ...inp, color: moved ? '#d29922' : '#e6edf3' }} />
                  </div>
                );
              })}
            </div>
          </div>

          {rs && (
            <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: '#0d1117', border: '1px solid #21262d', fontSize: 13, lineHeight: 1.7 }}>
              <div>Realised on old ({rq}): <b className="mono" style={{ color: pnlColor(rs.realised) }}>{fmt$(rs.realised - rollFees / 2)}</b> <span style={{ color: '#8b949e' }}>after {fmt$(rollFees / 2, 2)} comm</span></div>
              <div>Net roll: <b className="mono" style={{ color: rs.net >= 0 ? '#3fb950' : '#f85149' }}>{Math.abs(rs.net).toFixed(2)} {rs.net >= 0 ? 'credit' : 'debit'}</b> per share · {fmt$(rs.net * 100 * rq)} on {rq}</div>
              <div className="mono" style={{ color: '#a8b2be' }}>IBKR roll combo: {rs.net >= 0 ? `SELL @ ${rs.net.toFixed(2)}  (or BUY @ −${rs.net.toFixed(2)})` : `BUY @ ${Math.abs(rs.net).toFixed(2)}`}</div>
              <div>Cumulative basis after roll: <b className="mono">{Math.abs(rs.cumulative).toFixed(2)} {rs.cumulative >= 0 ? 'cr' : 'db'}</b> <span style={{ color: '#8b949e' }}>(entry {Math.abs(pos.ncd || 0).toFixed(2)} {pos.isCredit ? 'cr' : 'db'} ± this roll)</span></div>
              {rq < pos.qtyOpen && <div style={{ color: '#d29922' }}>{pos.qtyOpen - rq} contract{pos.qtyOpen - rq > 1 ? 's' : ''} stay on the old legs.</div>}
            </div>
          )}
          <div style={{ marginTop: 10, width: 200 }}>
            <label style={lbl}>Roll date</label>
            <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} style={inp} />
          </div>
        </>)}

        <div style={{ marginTop: 10 }}>
          <label style={lbl}>Notes</label>
          <textarea rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder={tab === 'roll' ? 'Why roll? Tested side, delta, days left…' : 'Why this exit?'}
            style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </div>

        <TicketHelp kind="sell" />

        {msg && <div style={{ marginTop: 8, fontSize: 12.5, color: msg.err ? '#f85149' : '#3fb950' }}>{msg.text}</div>}

        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {tab === 'close' ? (<>
            <button onClick={recordFills} disabled={busy || !filled.length || overAllocated || noEntry}
              style={{ flex: 1, padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', background: '#da3633', color: '#fff', opacity: busy || !filled.length || overAllocated || noEntry ? 0.45 : 1 }}>
              {busy ? 'Recording…' : filled.length ? `Record ${filled.reduce((a, r) => a + Number(r.qty), 0)} filled of ${pos.qtyOpen} · ${fmt$(filledNet)}` : 'Mark a tranche Filled to record it'}
            </button>
            <button onClick={() => { persistPlan(rows.filter(r => r.status !== 'Filled'), pos.qtyOpen); setMsg({ text: 'Plan saved — it reopens with this ticket.' }); }}
              style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#c9d1d9', fontSize: 13, cursor: 'pointer' }}>Save plan</button>
          </>) : (
            <button onClick={recordRoll} disabled={busy || !rs || rq <= 0 || noEntry}
              style={{ flex: 1, padding: '9px 16px', borderRadius: 8, border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer', background: '#9e6a03', color: '#fff', opacity: busy || !rs || rq <= 0 || noEntry ? 0.45 : 1 }}>
              {busy ? 'Rolling…' : rs ? `Roll ${rq} · bank ${fmt$(rs.realised - rollFees / 2)} · new ticket ${Math.abs(openNcd).toFixed(2)} ${roll.openSide}` : 'Enter close and open prices'}
            </button>
          )}
          <button onClick={onClose} style={{ padding: '9px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#a8b2be', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
