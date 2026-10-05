import React, { useState, useEffect, useRef } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { startCloseVolSnapshot } from '../utils/volSnapshot';
import { unitsFromTicket, roundTripCommission, pnlFromFills } from '../utils/commission';
import { useCommissionRate } from '../utils/useCommissionRate';

import { inferLegs, fetchReplay, buildPack, downloadPack, yyyymmdd } from '../utils/replay';

// Pull the value series and save the postmortem pack.
//
// This runs AFTER the close is written and never blocks or fails it — the sheet is
// the record, the pack is a convenience. It runs at close time rather than on demand
// because IBKR stops serving historical bars for an option once it expires: a pack
// you forgot to pull on the day can never be pulled at all.
async function capturePack(trade, form, toast) {
  let bridgeUrl = '';
  try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
  if (!bridgeUrl) return;

  const inferred = inferLegs(trade['Wing Strikes'], trade.Strategy);
  if (!inferred) return;                       // not a three-strike structure

  const entryTs = trade.Timestamp || '';
  const expiry = yyyymmdd(trade.expiryDate || form.closeDate || entryTs);
  const date = yyyymmdd(form.closeDate || entryTs);
  if (!expiry || !date) return;

  try {
    const replay = await fetchReplay(bridgeUrl, {
      underlying: trade.Underlying, expiry, date, legs: inferred.legs,
    });
    downloadPack(buildPack({ decision: trade, closes: [], replay, legsInferred: inferred }));
    if (toast) toast('Replay saved — drop it in TradePrints', 'success');
  } catch (e) {
    // Expected whenever TWS is shut or the contract has already expired. Say so
    // once and move on; the close itself is already safely written.
    if (toast) toast('Replay unavailable: ' + e.message, 'warn');
  }
}

export default function CloseTradeModal({ trade, type, onClose, onClosed, toast }) {
  const [closing, setClosing] = useState(false);
  const [partial, setPartial] = useState(false);
  const [fetchingTWS, setFetchingTWS] = useState(false);
  const [twsFills, setTwsFills] = useState(null);
  const [form, setForm] = useState({
    closeDate: new Date().toISOString().split('T')[0],
    closePnl: '',
    closePrice: '',
    partialQty: '',
    notes: '',
    fees: ''
  });
  // Engine tickets record P&L AFTER commission (Oct 2026): this form takes the TWS
  // "Net Total" (before commission) and the "Comm" figure, and shows the net that
  // will be recorded. Tracker rows (CSV imports) are already net and keep one box.
  const isTicket = type !== 'tracker';
  const [feesEdited, setFeesEdited] = useState(false);

  const underlying = trade.Underlying || trade.underlying || '';
  const strategy = trade['Strategy (OIC)'] || trade.Strategy || '';
  const qty = parseInt(trade.Qty || trade.Contracts || 1);
  const entryCredit = parseFloat(trade['Net Credit ($)'] || 0);

  // Accounts with no live TWS fills to fetch (paper / manual). For these the
  // modal shows manual-entry fields mirroring what the fetch would populate,
  // instead of a fetch button that would always come back empty.
  const acct = (trade.Account || trade.account || '').toLowerCase();
  const MANUAL_ACCOUNT_PREFIXES = ['papertrade']; // extend if other accounts don't use TWS
  const isManualAccount = MANUAL_ACCOUNT_PREFIXES.some(p => acct.startsWith(p));

  // Derive P&L on the contracts ACTUALLY being closed. This used the whole
  // position qty, so a 1-of-3 tranche auto-filled three contracts' P&L —
  // harmless while every close was all-or-nothing, a 3x overstatement written
  // straight into the sale log once closes became tranched. (Sep 2026.)
  const effectiveQty = f =>
    (partial && Number(f.partialQty) > 0) ? Math.min(Number(f.partialQty), qty) : qty;
  const acctRate = useCommissionRate(trade.Account || trade.account || '');
  const ticketUnits = unitsFromTicket(trade['Wing Strikes'], trade.Strategy);
  const estFees = f => ticketUnits > 0 ? roundTripCommission(ticketUnits, effectiveQty(f), acctRate) : 0;
  useEffect(() => {
    if (!isTicket || feesEdited) return;
    setForm(f => ({ ...f, fees: estFees(f) ? String(estFees(f)) : '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acctRate, partial, form.partialQty, feesEdited]);
  const derivePnl = (f, cp) => {
    if (!isManualAccount || cp === '' || cp == null || isNaN(parseFloat(cp))) return null;
    const perContractEntry = qty ? entryCredit / qty : entryCredit;
    const d = Math.round((perContractEntry - parseFloat(cp)) * effectiveQty(f) * 100) / 100;
    return isNaN(d) ? null : String(d);
  };

  // Fetch executions from TWS bridge
  async function fetchFromTWS() {
    setFetchingTWS(true);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { alert('Set IBKR Bridge URL in Settings first'); setFetchingTWS(false); return; }

      const resp = await fetch(bridgeUrl + '/api/executions', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const data = await resp.json();

      if (!data.fills || data.fills.length === 0) {
        setTwsFills([]);
        setFetchingTWS(false);
        return;
      }

      // Filter fills matching this trade's underlying
      const sym = underlying.toUpperCase();
      const matchingFills = data.fills.filter(f => {
        const fillSym = (f.symbol || '').toUpperCase();
        return fillSym === sym || fillSym === 'SPY' && sym === 'SPX' || fillSym === 'IWM' && sym === 'RUT';
      });

      setTwsFills(matchingFills);

      // Split the fills the way TWS's Trades summary does: Net Total, Comm, net.
      // (The old sum took commission off IBKR's realised P&L, which is already net.)
      const split = pnlFromFills(matchingFills);
      if (split) {
        if (isTicket) {
          setFeesEdited(true);
          setForm(f => ({ ...f, closePnl: String(split.gross), fees: String(split.commission) }));
        } else if (split.net !== 0) {
          setForm(f => ({ ...f, closePnl: String(split.net) }));
        }
      }
    } catch (e) {
      alert('Failed to fetch from TWS: ' + e.message);
    }
    setFetchingTWS(false);
  }

  // Best-effort snapshot of the volatility environment at close (spot, VIX,
  // VIX1D, expiry IVx, session range). Fired ONCE when the modal opens, so the
  // bridge gets the seconds the user spends on the form to answer; at confirm we
  // attach whatever arrived. Bridge down / no data → blanks, close proceeds
  // exactly as before. 0DTE tickets use their open-date as the expiry for the
  // IVx leg; otherwise Expiry Date if the row carries one, else IVx is skipped.
  const closeSnapRef = useRef({});
  useEffect(() => {
    if (type === 'tracker') return; // tracker closes write no vol columns
    const expiry = (trade.Engine === '0DTE')
      ? (trade.Timestamp || '').split('T')[0]
      : (trade['Expiry Date'] || '');
    closeSnapRef.current = startCloseVolSnapshot(underlying, { expiry });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleClose() {
    setClosing(true);
    try {
      if (type === 'tracker') {
        await api.closeTrade(trade._rowIndex, {
          closeDate: form.closeDate,
          closePnl: form.closePnl,
          closePrice: form.closePrice,
          notes: form.notes,
          partial,
          partialQty: partial ? form.partialQty : null
        });
      } else {
        const snap = closeSnapRef.current || {};
        await api.closeTicket(trade._rowIndex, {
          closeDate: form.closeDate,
          closePrice: form.closePrice,
          grossPnl: form.closePnl,
          fees: form.fees === '' ? null : form.fees,
          // The partial toggle already existed but only reached the TRACKER path --
          // a ticket closed in tranches wrote the whole position out on the first
          // exit. Each tranche now lands as its own row in Closes and the ticket
          // stays 'Partial' until the last contract is out. (Sep 2026.)
          qtyClosed: partial && form.partialQty ? Number(form.partialQty) : null,
          notes: form.notes || '',
          sessionHigh: snap.sessionHigh ?? null,
          sessionLow: snap.sessionLow ?? null,
          account: trade.Account || '',
          closeVix: snap.closeVix ?? null,
          closeIV: snap.closeIV ?? null,
          closeUnderlyingPrice: snap.closeUnderlyingPrice ?? null,
          closeVix1d: snap.closeVix1d ?? null
        });
      }
      if (onClosed) onClosed();
      // Best-effort, after the write. Deliberately not awaited into the failure
      // path above: a missing pack must never look like a failed close.
      capturePack(trade, form, toast);
    } catch (e) {
      alert('Error closing trade: ' + e.message);
    }
    setClosing(false);
  }

  const pnl = (parseFloat(form.closePnl) || 0) - (isTicket ? (parseFloat(form.fees) || 0) : 0);

  return (
    <div style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)'}}
      onClick={onClose}>
      <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:12,padding:24,width:480,maxHeight:'90vh',overflow:'auto'}}
        onClick={e => e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h3 style={{fontSize:16,fontWeight:700,color:'#e6edf3'}}>Close Trade</h3>
          <button onClick={onClose} style={{background:'none',border:'none',color:'#a8b2be',cursor:'pointer',fontSize:18}}>×</button>
        </div>

        {/* Trade summary */}
        <div style={{background:'#0d1117',borderRadius:8,padding:12,marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:600,color:'#e6edf3'}}>{underlying} — {strategy}</div>
          <div style={{fontSize:13,color:'#a8b2be',marginTop:4}}>
            Qty: {qty} | Entry credit: {entryCredit ? fmt$(entryCredit) : '—'} | Entry: {trade['Entry Date'] || trade.Timestamp?.split('T')[0] || '—'}
          </div>
        </div>

        {/* TWS fetch button (live accounts) OR manual-entry note (paper) */}
        {isManualAccount ? (
          <div style={{marginBottom:12,padding:10,borderRadius:8,background:'#0d1117',border:'1px dashed #30363d'}}>
            <div style={{fontSize:13,fontWeight:600,color:'#d29922',marginBottom:4}}>Manual close (paper / non-TWS account)</div>
            <div style={{fontSize:12.5,color:'#a8b2be',lineHeight:1.5}}>
              No TWS fills to fetch for this account — enter the close details below as they would have been filled: the <b style={{color:'#c9d1d9'}}>close price</b> (net credit/debit to exit) and the resulting <b style={{color:'#c9d1d9'}}>realised P&amp;L</b>. Entry credit was {entryCredit ? fmt$(entryCredit) : '—'} on {qty} contract{qty>1?'s':''}.
            </div>
          </div>
        ) : (
          <button onClick={fetchFromTWS} disabled={fetchingTWS}
            style={{width:'100%',padding:'8px 16px',borderRadius:8,border:'1px solid #2f81f7',background:'#0d1a2e',color:'#58a6ff',fontSize:13,fontWeight:600,cursor:'pointer',marginBottom:12,opacity:fetchingTWS?0.5:1}}>
            {fetchingTWS ? 'Fetching from TWS...' : '⚡ Fetch P&L from TWS'}
          </button>
        )}

        {/* TWS fills display */}
        {twsFills !== null && (
          <div style={{marginBottom:12,padding:8,borderRadius:6,background:'#0d1117',border:'1px solid #21262d'}}>
            {twsFills.length === 0 ? (
              <div style={{fontSize:12.5,color:'#a8b2be'}}>No fills found for {underlying} today</div>
            ) : (
              <>
                <div style={{fontSize:12,color:'#a8b2be',marginBottom:6}}>TWS fills for {underlying} today:</div>
                {twsFills.map((f, i) => (
                  <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'3px 0',borderBottom:i < twsFills.length-1?'1px solid #21262d':'none'}}>
                    <div style={{fontSize:12.5,color:'#c9d1d9'}}>
                      <span style={{color:f.side==='BOT'?'#3fb950':'#f85149',fontWeight:600}}>{f.side}</span>
                      {' '}{f.qty}x {f.symbol}
                      {f.strike > 0 && <span style={{color:'#a8b2be'}}> {f.strike}{f.right}</span>}
                      {f.expiry && <span style={{color:'#8b949e'}}> {f.expiry}</span>}
                    </div>
                    <div style={{fontSize:12.5,fontFamily:'JetBrains Mono,monospace'}}>
                      <span style={{color:'#c9d1d9'}}>@{f.price?.toFixed(2)}</span>
                      {f.realizedPnl && f.realizedPnl < 1e300 && (
                        <span style={{marginLeft:8,color:pnlColor(f.realizedPnl)}}>{fmt$(f.realizedPnl)}</span>
                      )}
                    </div>
                  </div>
                ))}
                {pnl !== 0 && <div style={{fontSize:12,color:'#3fb950',marginTop:6}}>✓ P&L auto-filled from TWS fills</div>}
              </>
            )}
          </div>
        )}

        {/* Partial toggle */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <button onClick={() => setPartial(false)}
            style={{padding:'4px 12px',borderRadius:6,fontSize:13,fontWeight:600,border:'1px solid',
              borderColor: !partial ? '#238636' : '#30363d',
              background: !partial ? '#0d2818' : 'transparent',
              color: !partial ? '#3fb950' : '#a8b2be',cursor:'pointer'}}>Full close</button>
          <button onClick={() => setPartial(true)}
            style={{padding:'4px 12px',borderRadius:6,fontSize:13,fontWeight:600,border:'1px solid',
              borderColor: partial ? '#d29922' : '#30363d',
              background: partial ? '#1f1a0d' : 'transparent',
              color: partial ? '#d29922' : '#a8b2be',cursor:'pointer'}}>Partial close</button>
        </div>

        {/* Form */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div>
            <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}>Close date</label>
            <input type="date" value={form.closeDate} onChange={e => setForm(f => ({...f, closeDate: e.target.value}))}
              style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,outline:'none'}} />
          </div>
          <div>
            <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}
              title={isTicket ? 'TWS Trades › Summary › Net Total' : 'Already after commission, like the imported rows'}>{isTicket ? 'P&L before commission ($)' : 'Realised P&L ($)'}</label>
            <input type="number" step="any" value={form.closePnl} onChange={e => setForm(f => ({...f, closePnl: e.target.value}))}
              placeholder="e.g. 150 or -200"
              style={{width:'100%',padding:'6px 10px',borderRadius:6,fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none',
                border:`1px solid ${pnl > 0 ? '#238636' : pnl < 0 ? '#da3633' : '#30363d'}`,
                background: pnl > 0 ? '#0d2818' : pnl < 0 ? '#2d0f0f' : '#0d1117',
                color: pnl > 0 ? '#3fb950' : pnl < 0 ? '#f85149' : '#e6edf3'}} />
          </div>
          <div>
            <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}>Close price {isManualAccount ? '(net credit/debit to close)' : '(optional)'}</label>
            <input type="number" step="any" value={form.closePrice} onChange={e => {
                const cp = e.target.value;
                setForm(f => {
                  const next = { ...f, closePrice: cp };
                  // For manual accounts, derive P&L from entry vs close price.
                  // Credit strategy: P&L = (entry credit − close debit) × qty × 100.
                  // entryCredit here is already in $ for the position; closePrice
                  // is per-contract net. Best-effort auto-fill; user can override.
                  const derived = derivePnl(next, cp);
                  if (derived != null) next.closePnl = derived;
                  return next;
                });
              }}
              placeholder="Net credit/debit to close"
              style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none'}} />
          </div>
          {isTicket && (
            <div>
              <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}
                title="TWS Trades › Summary › Comm — open and close together. Pre-filled from the account rate.">Commission, round trip ($)</label>
              <input type="number" step="any" value={form.fees} onChange={e => { setFeesEdited(true); setForm(f => ({ ...f, fees: e.target.value })); }}
                placeholder="TWS Comm"
                style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none'}} />
            </div>
          )}
          {partial && (
            <div>
              <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}>Contracts to close</label>
              <input type="number" value={form.partialQty} onChange={e => setForm(f => {
                  const next = { ...f, partialQty: e.target.value };
                  const d = derivePnl(next, next.closePrice);
                  if (d != null) next.closePnl = d;
                  return next;
                })}
                placeholder={`1 to ${qty}`} min="1" max={qty}
                style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none'}} />
            </div>
          )}
        </div>

        <div style={{marginTop:12}}>
          <label style={{fontSize:12,color:'#a8b2be',display:'block',marginBottom:4}}>Notes (optional)</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))}
            placeholder="Why did you close? What happened?"
            rows={2}
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,outline:'none',resize:'vertical'}} />
        </div>

        {/* P&L preview */}
        {form.closePnl && (
          <div style={{marginTop:12,padding:8,borderRadius:6,background:pnl >= 0 ? '#0d2818' : '#2d0f0f',border:`1px solid ${pnl >= 0 ? '#238636' : '#da3633'}`}}>
            <span style={{fontSize:13,color:'#a8b2be'}}>{isTicket ? 'Recorded after commission: ' : 'Result: '}</span>
            <span style={{fontSize:16,fontWeight:700,fontFamily:'JetBrains Mono,monospace',color:pnlColor(pnl)}}>{fmt$(pnl)}</span>
            <span style={{fontSize:13,color:'#a8b2be',marginLeft:8}}>{pnl >= 0 ? 'Win' : 'Loss'}</span>
            {partial && form.partialQty && <span style={{fontSize:13,color:'#d29922',marginLeft:8}}>({form.partialQty} of {qty} contracts)</span>}
          </div>
        )}

        {/* Actions */}
        <div style={{display:'flex',gap:8,marginTop:16}}>
          <button onClick={handleClose} disabled={closing || !form.closePnl}
            style={{flex:1,padding:'8px 16px',borderRadius:8,border:'none',fontWeight:600,fontSize:13,cursor:'pointer',
              background: partial ? '#9e6a03' : '#238636', color:'#fff', opacity: closing || !form.closePnl ? 0.5 : 1}}>
            {closing ? 'Closing...' : partial ? `Close ${form.partialQty || '?'} contracts` : 'Close trade'}
          </button>
          <button onClick={onClose}
            style={{padding:'8px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#a8b2be',fontSize:13,cursor:'pointer'}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
