import React, { useState } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';

export default function CloseTradeModal({ trade, type, onClose, onClosed }) {
  const [closing, setClosing] = useState(false);
  const [partial, setPartial] = useState(false);
  const [fetchingTWS, setFetchingTWS] = useState(false);
  const [twsFills, setTwsFills] = useState(null);
  const [form, setForm] = useState({
    closeDate: new Date().toISOString().split('T')[0],
    closePnl: '',
    closePrice: '',
    partialQty: '',
    notes: ''
  });

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

      // Auto-calculate total P&L from matching fills
      if (matchingFills.length > 0) {
        const totalPnl = matchingFills.reduce((s, f) => {
          const pnl = f.realizedPnl && f.realizedPnl < 1e300 ? f.realizedPnl : 0;
          return s + pnl;
        }, 0);
        const totalComm = matchingFills.reduce((s, f) => s + (f.commission || 0), 0);
        const netPnl = Math.round((totalPnl - totalComm) * 100) / 100;

        if (netPnl !== 0) {
          setForm(f => ({ ...f, closePnl: netPnl.toString() }));
        }
      }
    } catch (e) {
      alert('Failed to fetch from TWS: ' + e.message);
    }
    setFetchingTWS(false);
  }

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
        await api.closeTicket(trade._rowIndex, {
          closeDate: form.closeDate,
          closePrice: form.closePrice,
          actualPnl: form.closePnl,
          account: trade.Account || ''
        });
      }
      if (onClosed) onClosed();
    } catch (e) {
      alert('Error closing trade: ' + e.message);
    }
    setClosing(false);
  }

  const pnl = parseFloat(form.closePnl) || 0;

  return (
    <div style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)'}}
      onClick={onClose}>
      <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:12,padding:24,width:480,maxHeight:'90vh',overflow:'auto'}}
        onClick={e => e.stopPropagation()}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h3 style={{fontSize:16,fontWeight:700,color:'#e6edf3'}}>Close Trade</h3>
          <button onClick={onClose} style={{background:'none',border:'none',color:'#8b949e',cursor:'pointer',fontSize:18}}>×</button>
        </div>

        {/* Trade summary */}
        <div style={{background:'#0d1117',borderRadius:8,padding:12,marginBottom:16}}>
          <div style={{fontSize:14,fontWeight:600,color:'#e6edf3'}}>{underlying} — {strategy}</div>
          <div style={{fontSize:12,color:'#8b949e',marginTop:4}}>
            Qty: {qty} | Entry credit: {entryCredit ? fmt$(entryCredit) : '—'} | Entry: {trade['Entry Date'] || trade.Timestamp?.split('T')[0] || '—'}
          </div>
        </div>

        {/* TWS fetch button (live accounts) OR manual-entry note (paper) */}
        {isManualAccount ? (
          <div style={{marginBottom:12,padding:10,borderRadius:8,background:'#0d1117',border:'1px dashed #30363d'}}>
            <div style={{fontSize:12,fontWeight:600,color:'#d29922',marginBottom:4}}>Manual close (paper / non-TWS account)</div>
            <div style={{fontSize:11,color:'#8b949e',lineHeight:1.5}}>
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
              <div style={{fontSize:11,color:'#8b949e'}}>No fills found for {underlying} today</div>
            ) : (
              <>
                <div style={{fontSize:10,color:'#8b949e',marginBottom:6}}>TWS fills for {underlying} today:</div>
                {twsFills.map((f, i) => (
                  <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'3px 0',borderBottom:i < twsFills.length-1?'1px solid #21262d':'none'}}>
                    <div style={{fontSize:11,color:'#c9d1d9'}}>
                      <span style={{color:f.side==='BOT'?'#3fb950':'#f85149',fontWeight:600}}>{f.side}</span>
                      {' '}{f.qty}x {f.symbol}
                      {f.strike > 0 && <span style={{color:'#8b949e'}}> {f.strike}{f.right}</span>}
                      {f.expiry && <span style={{color:'#484f58'}}> {f.expiry}</span>}
                    </div>
                    <div style={{fontSize:11,fontFamily:'JetBrains Mono,monospace'}}>
                      <span style={{color:'#c9d1d9'}}>@{f.price?.toFixed(2)}</span>
                      {f.realizedPnl && f.realizedPnl < 1e300 && (
                        <span style={{marginLeft:8,color:pnlColor(f.realizedPnl)}}>{fmt$(f.realizedPnl)}</span>
                      )}
                    </div>
                  </div>
                ))}
                {pnl !== 0 && <div style={{fontSize:10,color:'#3fb950',marginTop:6}}>✓ P&L auto-filled from TWS fills</div>}
              </>
            )}
          </div>
        )}

        {/* Partial toggle */}
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
          <button onClick={() => setPartial(false)}
            style={{padding:'4px 12px',borderRadius:6,fontSize:12,fontWeight:600,border:'1px solid',
              borderColor: !partial ? '#238636' : '#30363d',
              background: !partial ? '#0d2818' : 'transparent',
              color: !partial ? '#3fb950' : '#8b949e',cursor:'pointer'}}>Full close</button>
          <button onClick={() => setPartial(true)}
            style={{padding:'4px 12px',borderRadius:6,fontSize:12,fontWeight:600,border:'1px solid',
              borderColor: partial ? '#d29922' : '#30363d',
              background: partial ? '#1f1a0d' : 'transparent',
              color: partial ? '#d29922' : '#8b949e',cursor:'pointer'}}>Partial close</button>
        </div>

        {/* Form */}
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
          <div>
            <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Close date</label>
            <input type="date" value={form.closeDate} onChange={e => setForm(f => ({...f, closeDate: e.target.value}))}
              style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,outline:'none'}} />
          </div>
          <div>
            <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Realised P&L ($)</label>
            <input type="number" step="any" value={form.closePnl} onChange={e => setForm(f => ({...f, closePnl: e.target.value}))}
              placeholder="e.g. 150 or -200"
              style={{width:'100%',padding:'6px 10px',borderRadius:6,fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none',
                border:`1px solid ${pnl > 0 ? '#238636' : pnl < 0 ? '#da3633' : '#30363d'}`,
                background: pnl > 0 ? '#0d2818' : pnl < 0 ? '#2d0f0f' : '#0d1117',
                color: pnl > 0 ? '#3fb950' : pnl < 0 ? '#f85149' : '#e6edf3'}} />
          </div>
          <div>
            <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Close price {isManualAccount ? '(net credit/debit to close)' : '(optional)'}</label>
            <input type="number" step="any" value={form.closePrice} onChange={e => {
                const cp = e.target.value;
                setForm(f => {
                  const next = { ...f, closePrice: cp };
                  // For manual accounts, derive P&L from entry vs close price.
                  // Credit strategy: P&L = (entry credit − close debit) × qty × 100.
                  // entryCredit here is already in $ for the position; closePrice
                  // is per-contract net. Best-effort auto-fill; user can override.
                  if (isManualAccount && cp !== '' && !isNaN(parseFloat(cp))) {
                    const closeVal = parseFloat(cp);
                    const perContractEntry = qty ? entryCredit / qty : entryCredit;
                    const pnlPerContract = perContractEntry - closeVal;
                    const derived = Math.round(pnlPerContract * qty * 100) / 100;
                    if (!isNaN(derived)) next.closePnl = String(derived);
                  }
                  return next;
                });
              }}
              placeholder="Net credit/debit to close"
              style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none'}} />
          </div>
          {partial && (
            <div>
              <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Contracts to close</label>
              <input type="number" value={form.partialQty} onChange={e => setForm(f => ({...f, partialQty: e.target.value}))}
                placeholder={`1 to ${qty}`} min="1" max={qty}
                style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:13,fontFamily:'JetBrains Mono,monospace',outline:'none'}} />
            </div>
          )}
        </div>

        <div style={{marginTop:12}}>
          <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Notes (optional)</label>
          <textarea value={form.notes} onChange={e => setForm(f => ({...f, notes: e.target.value}))}
            placeholder="Why did you close? What happened?"
            rows={2}
            style={{width:'100%',padding:'6px 10px',borderRadius:6,border:'1px solid #30363d',background:'#0d1117',color:'#e6edf3',fontSize:12,outline:'none',resize:'vertical'}} />
        </div>

        {/* P&L preview */}
        {form.closePnl && (
          <div style={{marginTop:12,padding:8,borderRadius:6,background:pnl >= 0 ? '#0d2818' : '#2d0f0f',border:`1px solid ${pnl >= 0 ? '#238636' : '#da3633'}`}}>
            <span style={{fontSize:12,color:'#8b949e'}}>Result: </span>
            <span style={{fontSize:16,fontWeight:700,fontFamily:'JetBrains Mono,monospace',color:pnlColor(pnl)}}>{fmt$(pnl)}</span>
            <span style={{fontSize:12,color:'#8b949e',marginLeft:8}}>{pnl >= 0 ? 'Win' : 'Loss'}</span>
            {partial && form.partialQty && <span style={{fontSize:12,color:'#d29922',marginLeft:8}}>({form.partialQty} of {qty} contracts)</span>}
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
            style={{padding:'8px 16px',borderRadius:8,border:'1px solid #30363d',background:'transparent',color:'#8b949e',fontSize:13,cursor:'pointer'}}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
