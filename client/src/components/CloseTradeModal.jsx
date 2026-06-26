import React, { useState } from 'react';
import { api } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';

export default function CloseTradeModal({ trade, type, onClose, onClosed }) {
  // type: 'tracker' (TradeTracker row) or 'ticket' (Decision engine ticket)
  const [closing, setClosing] = useState(false);
  const [partial, setPartial] = useState(false);
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
        // Decision ticket
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
    <div style={{position:'fixed',inset:0,zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',background:'rgba(0,0,0,0.6)'}}>
      <div style={{background:'#161b22',border:'1px solid #30363d',borderRadius:12,padding:24,width:420,maxHeight:'90vh',overflow:'auto'}}>
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
            <label style={{fontSize:10,color:'#8b949e',display:'block',marginBottom:4}}>Close price (optional)</label>
            <input type="number" step="any" value={form.closePrice} onChange={e => setForm(f => ({...f, closePrice: e.target.value}))}
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
