import React, { useState, useEffect } from 'react';
import { Zap, FileText, ChevronDown, ChevronUp, GitCompare, Check, X, DollarSign, Edit3, Clock, Save } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';
import EnginePanel from '../components/EnginePanel';
import { calc0DTE } from '../engine/calc0dte';
import { calc45DTE } from '../engine/calc45dte';

export default function DecisionEngine({ authenticated, account, accounts }) {
  const [mode, setMode] = useState('0dte');
  const [decisions, setDecisions] = useState([]);
  const [panel, setPanel] = useState(null); // 'log' | 'compare' | null
  const [comparison, setComparison] = useState(null);
  const [compLoading, setCompLoading] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [toast, setToast] = useState(null);

  // Close ticket state
  const [closingIdx, setClosingIdx] = useState(null);
  const [closeForm, setCloseForm] = useState({ closeDate: '', closePrice: '', actualPnl: '' });

  // Notes edit state
  const [editingNotesIdx, setEditingNotesIdx] = useState(null);
  const [notesText, setNotesText] = useState('');
  const [saving, setSaving] = useState(false);

  // Manual ticket state
  const [showManual, setShowManual] = useState(false);
  const [manualForm, setManualForm] = useState({
    underlying: '', strategy: '', expiry: '', entryDate: new Date().toISOString().split('T')[0],
    winAmount: '', riskPerContract: '', contracts: '1', notes: ''
  });
  const [manualSaving, setManualSaving] = useState(false);

  function loadDecisions() {
    if (!authenticated) return Promise.resolve();
    return api.getDecisions().then(rows => {
      if (rows && rows.length > 1) {
        const headers = rows[0];
        const data = rows.slice(1).map((row, idx) => {
          const obj = { _rowIndex: idx + 2, _raw: row };
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        }).reverse();
        setDecisions(data);
      }
    }).catch(() => {});
  }

  useEffect(() => { loadDecisions(); }, [authenticated]);

  // Handle native engine log trade
  function handleEngineLog(data) {
    api.logDecision(data)
      .then(result => {
        if (result.ok) {
          showToast('Trade logged to Options Tracker', 'success');
          loadDecisions();
        }
      })
      .catch(err => showToast('Error: ' + err.message, 'error'));
  }

  function showToast(msg, type) {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleCloseTicket(dec) {
    setSaving(true);
    try {
      const result = await api.closeTicket(dec._rowIndex, closeForm);
      console.log('[CLOSE TICKET RESULT]', result);
      showToast('Trade ticket closed', 'success');
      setClosingIdx(null);
      setCloseForm({ closeDate: '', closePrice: '', actualPnl: '' });
      // Small delay to let Google Sheets propagate the write
      await new Promise(r => setTimeout(r, 500));
      await loadDecisions();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setSaving(false);
  }

  async function handleSaveNotes(dec) {
    setSaving(true);
    try {
      await api.updateTicketNotes(dec._rowIndex, notesText);
      showToast('Notes saved', 'success');
      setEditingNotesIdx(null);
      loadDecisions();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setSaving(false);
  }

  async function loadComparison() {
    setCompLoading(true);
    try { setComparison(await api.getComparison()); } catch (e) { console.error(e); }
    setCompLoading(false);
  }

  async function handleManualTicket() {
    setManualSaving(true);
    try {
      const f = manualForm;
      await api.logDecision({
        engine: 'Manual',
        underlying: f.underlying,
        strategy: f.underlying + ' - ' + f.strategy + ' - ' + f.contracts + (f.contracts === '1' ? ' contract' : ' contracts'),
        direction: 'Trade',
        contracts: parseInt(f.contracts) || 1,
        kellyDollar: '',
        popMargin: '',
        setupScore: '',
        setupGrade: 'Manual entry',
        regime: '',
        wingStrikes: '',
        marketBehaviour: '',
        notes: f.notes,
        price: '',
        vix: '',
        vix1d: '',
        iv: '',
        ivr: '',
        em: '',
        timestamp: new Date(f.entryDate + 'T12:00:00').toISOString(),
        // Extra fields for the ticket
        expiry: f.expiry,
        winAmount: f.winAmount,
        riskPerContract: f.riskPerContract
      });
      showToast('Manual trade ticket created', 'success');
      setShowManual(false);
      setManualForm({
        underlying: '', strategy: '', expiry: '', entryDate: new Date().toISOString().split('T')[0],
        winAmount: '', riskPerContract: '', contracts: '1', notes: ''
      });
      loadDecisions();
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
    setManualSaving(false);
  }

  const openTickets = decisions.filter(d => d.Status !== 'Closed' && d._raw?.[21] !== 'Closed');
  const closedTickets = decisions.filter(d => d.Status === 'Closed' || d._raw?.[21] === 'Closed');

  const [prefillData, setPrefillData] = useState(null);
  function handleSelectFromScan(underlying, data) {
    setPrefillData({ underlying, ...data });
    setPanel(null);
  }

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-display text-2xl font-bold">Decision Engine</h2>
          <p className="text-text-muted text-sm mt-0.5">Pre-trade analysis, trade tickets & performance tracking</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex border border-bg-border rounded-lg overflow-hidden">
            <button onClick={() => setMode('0dte')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${mode === '0dte' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              <Zap size={14} className="inline mr-1" /> 0DTE
            </button>
            <button onClick={() => setMode('45dte')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${mode === '45dte' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              45 DTE
            </button>
          </div>
          <button onClick={() => { setPanel(panel === 'log' ? null : 'log'); }}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${panel === 'log' ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            <FileText size={14} /> Tickets ({decisions.length})
          </button>
          <button onClick={() => setShowManual(!showManual)}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${showManual ? 'border-green bg-green/10 text-green' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            + Manual
          </button>
          <button onClick={() => { setPanel(panel === 'compare' ? null : 'compare'); if (!comparison) loadComparison(); }}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${panel === 'compare' ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            <GitCompare size={14} /> Compare
          </button>
          <button onClick={() => setPanel(panel === 'multiscan' ? null : 'multiscan')}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${panel === 'multiscan' ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            <Zap size={14} /> Multi-scan
          </button>
        </div>
      </div>

      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-lg text-sm font-medium fade-in ${
          toast.type === 'success' ? 'bg-green-bg border border-green text-green' : 'bg-red-bg border border-red text-red'}`}>
          {toast.msg}
        </div>
      )}

      {/* MANUAL TRADE TICKET */}
      {showManual && (
        <div className="card mb-4 fade-in">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text">Create manual trade ticket</h3>
            <button onClick={() => setShowManual(false)} className="text-text-faint hover:text-text">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Entry date</label>
              <input type="date" value={manualForm.entryDate}
                onChange={e => setManualForm(f => ({ ...f, entryDate: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Underlying</label>
              <select value={manualForm.underlying}
                onChange={e => setManualForm(f => ({ ...f, underlying: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent">
                <option value="">Select...</option>
                {['SPY','QQQ','SPX','NVDA','TSLA','AAPL','IWM','VIX','AMZN','MSFT','AMD','META','INTC','GOOGL','SLV','GLD','HYG','TLT','MSTR','PLTR'].map(t =>
                  <option key={t} value={t}>{t}</option>
                )}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Strategy</label>
              <select value={manualForm.strategy}
                onChange={e => setManualForm(f => ({ ...f, strategy: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent">
                <option value="">Select...</option>
                <optgroup label="Credit strategies">
                  <option>Iron Condor - Normal</option>
                  <option>Iron Butterfly</option>
                  <option>Chicken Condor</option>
                  <option>Bull Put Spread</option>
                  <option>Bear Call Spread</option>
                  <option>Jade Lizard</option>
                  <option>Short Strangle</option>
                  <option>Short Straddle</option>
                  <option>Covered Call</option>
                  <option>Naked Put</option>
                  <option>Naked Call</option>
                </optgroup>
                <optgroup label="Debit strategies">
                  <option>Long Condor - Reversed</option>
                  <option>Standard Butterfly</option>
                  <option>Broken Wing Butterfly</option>
                  <option>Asymmetric Butterfly</option>
                  <option>Bull Call Spread</option>
                  <option>Bear Put Spread</option>
                  <option>Long Straddle</option>
                  <option>Long Strangle</option>
                  <option>Long Call</option>
                  <option>Long Put</option>
                </optgroup>
                <optgroup label="45 DTE">
                  <option>Credit Spread</option>
                  <option>Calendar Spread</option>
                  <option>Diagonal Spread</option>
                  <option>Ratio Spread</option>
                </optgroup>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Expiry date</label>
              <input type="date" value={manualForm.expiry}
                onChange={e => setManualForm(f => ({ ...f, expiry: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
            </div>
          </div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Win amount ($)</label>
              <input type="number" step="0.01" value={manualForm.winAmount}
                onChange={e => setManualForm(f => ({ ...f, winAmount: e.target.value }))}
                placeholder="e.g. 65"
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Risk per contract ($)</label>
              <input type="number" step="0.01" value={manualForm.riskPerContract}
                onChange={e => setManualForm(f => ({ ...f, riskPerContract: e.target.value }))}
                placeholder="e.g. 435"
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Contracts</label>
              <input type="number" min="1" value={manualForm.contracts}
                onChange={e => setManualForm(f => ({ ...f, contracts: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Notes (optional)</label>
              <input type="text" value={manualForm.notes}
                onChange={e => setManualForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Entry rationale..."
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent" />
            </div>
          </div>
          <button onClick={handleManualTicket} disabled={manualSaving || !manualForm.underlying || !manualForm.strategy}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-green-dim hover:bg-green text-white rounded-lg transition-colors disabled:opacity-50">
            <Check size={14} /> {manualSaving ? 'Creating...' : 'Create ticket'}
          </button>
        </div>
      )}

      {/* TRADE TICKETS PANEL */}
      {panel === 'log' && (
        <div className="card mb-4 fade-in" style={{ maxHeight: '500px', overflowY: 'auto' }}>
          {/* Open tickets */}
          {openTickets.length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs text-text-faint uppercase tracking-wider mb-2 flex items-center gap-2">
                <Clock size={12} /> Open tickets ({openTickets.length})
              </h3>
              {openTickets.map((dec, i) => {
                const globalIdx = decisions.indexOf(dec);
                const expanded = expandedIdx === globalIdx;
                const isClosing = closingIdx === globalIdx;
                const isEditingNotes = editingNotesIdx === globalIdx;
                const stratParts = (dec.Strategy || '').split(' - ');
                const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : dec.Strategy;

                return (
                  <div key={globalIdx} className="border border-bg-border rounded-lg mb-2 overflow-hidden">
                    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-bg-hover cursor-pointer transition-colors"
                      onClick={() => setExpandedIdx(expanded ? null : globalIdx)}>
                      <div className="w-2 h-2 rounded-full bg-accent flex-shrink-0" />
                      <span className="mono text-xs text-text-muted w-10">{dec.Engine}</span>
                      <span className="text-xs text-text-muted mono w-16">
                        {dec.Timestamp ? new Date(dec.Timestamp).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : ''}
                      </span>
                      <span className="text-sm font-medium">{dec.Underlying}</span>
                      <span className="text-xs text-text-muted flex-1">{stratName}</span>
                      <span className={`text-xs font-medium ${dec.Direction === 'Trade' ? 'text-green' : dec.Direction === 'Trade with caution' ? 'text-amber' : 'text-red'}`}>
                        {dec.Direction === 'Trade' ? '✓ Go' : dec.Direction === 'Trade with caution' ? '⚠ Caution' : '✗ No'}
                      </span>
                      <span className="mono text-xs text-text-faint">{dec['Setup Score']}</span>
                      {expanded ? <ChevronUp size={14} className="text-text-faint" /> : <ChevronDown size={14} className="text-text-faint" />}
                    </div>

                    {expanded && (
                      <div className="px-3 py-3 bg-bg border-t border-bg-border fade-in">
                        <div className="grid grid-cols-3 gap-4 text-sm mb-3">
                          <div className="space-y-1">
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-1">Entry details</div>
                            <Row label="Strategy" value={stratName} />
                            <Row label="Direction" value={dec.Direction} />
                            <Row label="Contracts" value={dec.Contracts} />
                            <Row label="Kelly $" value={dec['Kelly $']} />
                            <Row label="POP Margin" value={dec['POP Margin']} />
                            <Row label="Price" value={dec.Price ? '$' + dec.Price : '--'} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-1">Setup quality</div>
                            <Row label="Score" value={dec['Setup Score']} />
                            <Row label="Grade" value={dec['Setup Grade']} />
                            <Row label="Regime" value={dec.Regime} />
                            <Row label="VIX" value={dec.VIX} />
                            <Row label="IV" value={dec.IV} />
                            <Row label="IVR" value={dec.IVR} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-1">Strikes & behaviour</div>
                            <Row label="Strikes" value={dec['Wing Strikes']} />
                            <div className="text-xs text-text-muted italic mt-1">{dec['Market Behaviour']}</div>
                            {dec['Trade Notes'] && (
                              <div className="mt-2 p-2 bg-bg-card rounded text-xs text-text-muted">{dec['Trade Notes']}</div>
                            )}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 pt-2 border-t border-bg-border">
                          <button onClick={(e) => { e.stopPropagation(); setClosingIdx(isClosing ? null : globalIdx); setCloseForm({ closeDate: new Date().toISOString().split('T')[0], closePrice: '', actualPnl: '' }); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-dim hover:bg-green text-white rounded-lg transition-colors">
                            <DollarSign size={12} /> Close ticket
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); setEditingNotesIdx(isEditingNotes ? null : globalIdx); setNotesText(dec['Trade Notes'] || dec.Notes || ''); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-bg-border text-text-muted rounded-lg hover:bg-bg-hover transition-colors">
                            <Edit3 size={12} /> {isEditingNotes ? 'Cancel' : 'Notes'}
                          </button>
                        </div>

                        {/* Close ticket form */}
                        {isClosing && (
                          <div className="mt-3 p-3 bg-bg-card border border-bg-border rounded-lg fade-in">
                            <div className="text-xs text-text-faint uppercase tracking-wider mb-2">Close this trade ticket</div>
                            <div className="grid grid-cols-3 gap-3">
                              <div>
                                <label className="text-[10px] text-text-muted block mb-1">Close date</label>
                                <input type="date" value={closeForm.closeDate} onChange={e => setCloseForm(f => ({ ...f, closeDate: e.target.value }))}
                                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div>
                                <label className="text-[10px] text-text-muted block mb-1">Close price ($)</label>
                                <input type="number" step="0.01" value={closeForm.closePrice} onChange={e => setCloseForm(f => ({ ...f, closePrice: e.target.value }))}
                                  placeholder="e.g. 0.05" className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div>
                                <label className="text-[10px] text-text-muted block mb-1">Actual P&L ($)</label>
                                <input type="number" step="0.01" value={closeForm.actualPnl} onChange={e => setCloseForm(f => ({ ...f, actualPnl: e.target.value }))}
                                  placeholder="e.g. 65 or -435" className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                            </div>
                            <button onClick={() => handleCloseTicket(dec)} disabled={saving}
                              className="mt-2 flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-green-dim hover:bg-green text-white rounded-lg transition-colors disabled:opacity-50">
                              <Check size={12} /> {saving ? 'Saving...' : 'Confirm close'}
                            </button>
                          </div>
                        )}

                        {/* Notes editor */}
                        {isEditingNotes && (
                          <div className="mt-3 p-3 bg-bg-card border border-bg-border rounded-lg fade-in">
                            <textarea value={notesText} onChange={e => setNotesText(e.target.value)} rows={3}
                              placeholder="Entry rationale, adjustments, lessons learned..."
                              className="w-full px-3 py-2 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent resize-y" />
                            <button onClick={() => handleSaveNotes(dec)} disabled={saving}
                              className="mt-2 flex items-center gap-1.5 px-4 py-1.5 text-xs font-medium bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
                              <Save size={12} /> {saving ? 'Saving...' : 'Save notes'}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Closed tickets */}
          {closedTickets.length > 0 && (
            <div>
              <h3 className="text-xs text-text-faint uppercase tracking-wider mb-2 flex items-center gap-2">
                <Check size={12} /> Closed tickets ({closedTickets.length})
              </h3>
              {closedTickets.map((dec, i) => {
                const globalIdx = decisions.indexOf(dec);
                const expanded = expandedIdx === globalIdx;
                const pnl = parseFloat(dec['Actual P&L']) || 0;
                const stratParts = (dec.Strategy || '').split(' - ');
                const stratName = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : dec.Strategy;

                return (
                  <div key={globalIdx} className="border border-bg-border rounded-lg mb-1 overflow-hidden">
                    <div className="flex items-center gap-3 px-3 py-2 hover:bg-bg-hover cursor-pointer transition-colors"
                      onClick={() => setExpandedIdx(expanded ? null : globalIdx)}>
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${pnl >= 0 ? 'bg-green' : 'bg-red'}`} />
                      <span className="mono text-xs text-text-muted w-10">{dec.Engine}</span>
                      <span className="text-xs text-text-muted mono w-16">
                        {dec.Timestamp ? new Date(dec.Timestamp).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : ''}
                      </span>
                      <span className="text-sm font-medium">{dec.Underlying}</span>
                      <span className="text-xs text-text-muted flex-1">{stratName}</span>
                      <span className="mono text-sm font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
                      <span className={`badge text-[10px] ${pnl >= 0 ? 'badge-green' : 'badge-red'}`}>{pnl >= 0 ? 'Win' : 'Loss'}</span>
                      {expanded ? <ChevronUp size={14} className="text-text-faint" /> : <ChevronDown size={14} className="text-text-faint" />}
                    </div>
                    {expanded && (
                      <div className="px-3 py-3 bg-bg border-t border-bg-border fade-in">
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div className="space-y-1">
                            <Row label="Strategy" value={stratName} />
                            <Row label="Contracts" value={dec.Contracts} />
                            <Row label="Entry price" value={dec.Price ? '$' + dec.Price : '--'} />
                            <Row label="Close date" value={fmtDate(dec['Close Date'])} />
                            <Row label="Close price" value={dec['Close Price'] ? '$' + dec['Close Price'] : '--'} />
                          </div>
                          <div className="space-y-1">
                            <Row label="Setup score" value={dec['Setup Score']} />
                            <Row label="Setup grade" value={dec['Setup Grade']} />
                            <Row label="Regime" value={dec.Regime} />
                            <Row label="Kelly $" value={dec['Kelly $']} />
                            <Row label="POP Margin" value={dec['POP Margin']} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[10px] text-text-faint uppercase">Actual P&L</div>
                            <div className="mono text-xl font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</div>
                            {dec['Trade Notes'] && (
                              <div className="mt-2 p-2 bg-bg-card rounded text-xs text-text-muted">{dec['Trade Notes']}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {decisions.length === 0 && (
            <div className="py-8 text-center text-text-faint text-sm">
              No trade tickets yet. Click "Log trade" in the decision engine to create one.
            </div>
          )}
        </div>
      )}

      {/* COMPARISON PANEL */}
      {panel === 'multiscan' && (
        <MultiScanPanel mode={mode} onSelect={handleSelectFromScan} />
      )}

      {panel === 'compare' && (
        <div className="card mb-4 fade-in" style={{ maxHeight: '500px', overflowY: 'auto' }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-medium text-text">Decision Engine vs Actual Results</h3>
              <p className="text-xs text-text-muted mt-0.5">Auto-matched by underlying + date + strategy</p>
            </div>
            {comparison?.summary && (
              <div className="flex items-center gap-4">
                <Stat label="Matched" value={`${comparison.summary.totalMatched}/${comparison.summary.totalDecisions}`} />
                <Stat label="Accuracy" value={`${comparison.summary.engineAccuracy}%`}
                  cls={comparison.summary.engineAccuracy >= 60 ? 'text-green' : comparison.summary.engineAccuracy >= 40 ? 'text-amber' : 'text-red'} />
                <Stat label="Engine P&L" value={fmt$(comparison.summary.enginePnl)}
                  cls={comparison.summary.enginePnl >= 0 ? 'text-green' : 'text-red'} />
              </div>
            )}
          </div>
          {compLoading ? (
            <div className="py-8 text-center text-text-muted text-sm">Loading...</div>
          ) : comparison?.matches?.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-faint text-[10px] uppercase tracking-wider">
                  <th className="text-left py-2 px-2">Date</th>
                  <th className="text-left py-2 px-2">Ticker</th>
                  <th className="text-left py-2 px-2">Engine said</th>
                  <th className="text-center py-2 px-2">Direction</th>
                  <th className="text-left py-2 px-2">Actual</th>
                  <th className="text-right py-2 px-2">P&L</th>
                  <th className="text-center py-2 px-2">Result</th>
                  <th className="text-center py-2 px-2">✓</th>
                </tr>
              </thead>
              <tbody>
                {comparison.matches.map((m, i) => {
                  const pnl = m.matchedTrade?.totalPnl || 0;
                  const stratParts = (m.decision.strategy || '').split(' - ');
                  const engineStrat = stratParts.length > 1 ? stratParts.slice(1, -1).join(' - ') : m.decision.strategy;
                  return (
                    <tr key={i} className="table-row">
                      <td className="py-2 px-2 text-text-muted mono text-xs">{m.decision.timestamp ? new Date(m.decision.timestamp).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : ''}</td>
                      <td className="py-2 px-2 font-medium">{m.decision.underlying}</td>
                      <td className="py-2 px-2 text-text-muted text-xs">{engineStrat}</td>
                      <td className="py-2 px-2 text-center">
                        <span className={`text-xs font-medium ${m.decision.direction === 'Trade' ? 'text-green' : m.decision.direction === 'Trade with caution' ? 'text-amber' : 'text-red'}`}>
                          {m.decision.direction === 'Trade' ? '✓' : m.decision.direction === 'Trade with caution' ? '⚠' : '✗'}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-xs">{m.matchedTrade?.strategy || <span className="text-text-faint">--</span>}</td>
                      <td className="py-2 px-2 text-right mono font-medium" style={{ color: m.matchedTrade ? pnlColor(pnl) : '#484f58' }}>
                        {m.matchedTrade ? fmt$(pnl) : '--'}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {m.matchedTrade?.wl && <span className={`badge text-[10px] ${m.matchedTrade.wl === 'Win' ? 'badge-green' : 'badge-red'}`}>{m.matchedTrade.wl}</span>}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {m.matched ? <Check size={12} className="text-green inline" /> : <X size={12} className="text-text-faint inline" />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="py-8 text-center text-text-faint text-sm">Log decisions and upload a CSV to see comparison.</div>
          )}
        </div>
      )}

      {/* Native Decision Engine */}
      <EnginePanel mode={mode} onLogTrade={handleEngineLog}
        accountConfig={accounts?.find(a => a.id === account) || {}}
        prefillData={prefillData} onPrefillConsumed={() => setPrefillData(null)} />
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between">
      <span className="text-text-muted text-xs">{label}</span>
      <span className="text-text text-xs font-medium text-right max-w-[180px] truncate">{value || '--'}</span>
    </div>
  );
}

function MultiScanPanel({ mode, onSelect }) {
  const is0 = mode === '0dte';
  const [underlyings, setUnderlyings] = useState(['SPX', 'SPY', 'QQQ']);
  const [scanning, setScanning] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [manualData, setManualData] = useState({});
  const [showInputs, setShowInputs] = useState(false);

  const inputFields = [
    { key: 'price', label: 'Price' },
    { key: 'high', label: 'Day High' },
    { key: 'low', label: 'Day Low' },
    { key: 'cashOpen', label: 'Open' },
    { key: 'em', label: 'EM' },
    { key: 'atr', label: 'ATR 1 Day' },
    { key: 'atr5', label: 'ATR 5m' },
    { key: 'atr2h', label: 'ATR 2h' },
    { key: 'vix', label: 'VIX' },
    { key: 'vix1d', label: 'VIX1D' },
    { key: 'vwap5', label: 'VWAP 5' },
    { key: 'vwap5_30', label: 'VWAP 5 -30m' },
    { key: 'vwap15', label: 'VWAP 15' },
    { key: 'vwap15_30', label: 'VWAP 15 -30m' },
    { key: 'esClose', label: 'ES Pre-open' },
    { key: 'priorDayClose', label: 'ES Prior Close' },
    { key: 'esOvernightHigh', label: 'ES O/N High' },
    { key: 'esOvernightLow', label: 'ES O/N Low' },
    { key: 'esEM', label: 'ES EM' },
  ];

  function getVal(underlying, key) {
    return manualData[underlying]?.[key] ?? '';
  }

  function setVal(underlying, key, value) {
    setManualData(prev => ({
      ...prev,
      [underlying]: { ...(prev[underlying] || {}), [key]: value }
    }));
  }

  function buildInputs(underlying) {
    const m = manualData[underlying] || {};
    const scaleV = (v) => {
      const p = parseFloat(m.price) || 0;
      if (underlying === 'SPX' && p > 1000 && v > 0 && v < p * 0.3) return v * 10;
      return v;
    };
    return {
      price: parseFloat(m.price) || 0,
      high: parseFloat(m.high) || 0,
      low: parseFloat(m.low) || 0,
      cashOpen: parseFloat(m.cashOpen) || 0,
      em: parseFloat(m.em) || 0,
      atr: parseFloat(m.atr) || 0,
      atr5: parseFloat(m.atr5) || 0,
      atr2h: parseFloat(m.atr2h) || 0,
      vix: parseFloat(m.vix) || 0,
      vix1d: parseFloat(m.vix1d) || 0,
      vwap5: scaleV(parseFloat(m.vwap5) || 0),
      vwap5_30: scaleV(parseFloat(m.vwap5_30) || 0),
      vwap15: scaleV(parseFloat(m.vwap15) || 0),
      vwap15_30: scaleV(parseFloat(m.vwap15_30) || 0),
      esClose: parseFloat(m.esClose) || 0,
      priorDayClose: parseFloat(m.priorDayClose) || 0,
      esOvernightHigh: parseFloat(m.esOvernightHigh) || 0,
      esOvernightLow: parseFloat(m.esOvernightLow) || 0,
      esEM: parseFloat(m.esEM) || 0,
    };
  }

  async function handleScan() {
    setScanning(true);
    setError('');
    const bridgeUrl = localStorage.getItem('bridgeUrl') || '';

    try {
      // Fetch from bridge if available
      if (bridgeUrl) {
        const fetches = underlyings.filter(u => u).map(underlying =>
          fetch(bridgeUrl + '/api/market-data?underlying=' + underlying, {
            headers: { 'ngrok-skip-browser-warning': '1' }
          }).then(r => r.json()).then(data => ({ underlying, data }))
          .catch(() => ({ underlying, data: null }))
        );
        const marketData = await Promise.all(fetches);
        // Merge bridge data into manualData (bridge fills, manual overrides)
        marketData.forEach(({ underlying, data }) => {
          if (data && data.price > 0) {
            const existing = manualData[underlying] || {};
            const merged = {};
            inputFields.forEach(f => {
              // Manual entry takes precedence over bridge data
              merged[f.key] = existing[f.key] || (data[f.key] != null ? String(data[f.key]) : '');
            });
            setManualData(prev => ({ ...prev, [underlying]: merged }));
          }
        });
      }

      // Small delay to let state update
      await new Promise(r => setTimeout(r, 100));
    } catch (e) {
      console.error('Bridge fetch error:', e);
    }

    // Run engine for each underlying using current manualData
    runEngine();
    setScanning(false);
  }

  function runEngine() {
    try {
      const engineResults = underlyings.filter(u => u).map(underlying => {
        const inp = buildInputs(underlying);
        if (!inp.price) return { underlying, error: 'No price', result: null, data: inp };
        try {
          const result = is0 ? calc0DTE({
            ...inp, gamStrike: 0, bankroll: 3000, startBR: 3000, risk: 0,
            maxLoss: 300, win: 0, maxOpen: 450, pop: 0, theta: 0, delta: 0,
            gamma: 0, hours: 6.5, underlying, overrideStrategy: null
          }) : calc45DTE({
            price: inp.price, ivr: 0, iv: 0, hv: 0, vix: inp.vix,
            ivFront: 0, ivBack: 0, skew: 0, dte: 45, pop: 0, win: 0, risk: 0,
            bankroll: 3000, startBR: 3000, maxLoss: 300, maxOpen: 450, bpr: 0,
            theta: 0, vega: 0, delta: 0, underlying, termBias: 'contango',
            outlook: 'neutral', overrideStrategy: null
          });
          return { underlying, result, data: inp };
        } catch (e) {
          return { underlying, error: e.message, result: null, data: inp };
        }
      });

      engineResults.sort((a, b) => (b.result?.setupScore || 0) - (a.result?.setupScore || 0));
      setResults(engineResults);
    } catch (e) {
      setError('Engine error: ' + e.message);
    }
  }

  // Re-run engine when manual data changes
  function handleRecalc() { runEngine(); }

  return (
    <div className="card mb-4 fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-white">Multi-Underlying Scan</h3>
          <p className="text-xs text-text-muted mt-0.5">Compare setups across underlyings — pick the best trade of the day</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowInputs(!showInputs)}
            className={`px-3 py-2 text-xs border rounded-lg transition-colors ${showInputs ? 'border-accent bg-accent/10 text-accent' : 'border-[#30363d] text-[#8b949e] hover:bg-[#161b22]'}`}>
            {showInputs ? 'Hide inputs' : 'Show inputs'}
          </button>
          <button onClick={handleRecalc} disabled={!results}
            className="px-3 py-2 text-xs border border-[#30363d] rounded-lg text-[#8b949e] hover:bg-[#161b22] disabled:opacity-30">
            Recalculate
          </button>
          <button onClick={handleScan} disabled={scanning}
            className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
            <Zap size={14} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Scanning...' : 'Scan all'}
          </button>
        </div>
      </div>

      {/* Underlying selector */}
      <div className="flex gap-2 mb-4">
        {underlyings.map((u, i) => (
          <div key={i} className="flex items-center gap-1">
            <select value={u} onChange={e => {
              const next = [...underlyings]; next[i] = e.target.value; setUnderlyings(next);
            }} className="px-2 py-1.5 bg-[#0d1117] border border-[#30363d] rounded text-xs text-white outline-none">
              {['SPX','SPY','QQQ','IWM','AAPL','TSLA','AMZN','MSFT','NVDA','META','GOOGL'].map(s =>
                <option key={s} value={s}>{s}</option>
              )}
            </select>
            {underlyings.length > 2 && (
              <button onClick={() => setUnderlyings(underlyings.filter((_, j) => j !== i))}
                className="text-[#484f58] hover:text-red text-xs">×</button>
            )}
          </div>
        ))}
        {underlyings.length < 5 && (
          <button onClick={() => setUnderlyings([...underlyings, 'IWM'])}
            className="px-2 py-1.5 border border-dashed border-[#30363d] rounded text-xs text-[#484f58] hover:text-white">+</button>
        )}
      </div>

      {error && <div className="text-sm text-red mb-3">{error}</div>}

      {/* Manual input grid */}
      {showInputs && (
        <div className="mb-4 overflow-x-auto fade-in">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[9px] text-[#8b949e] uppercase tracking-wider">
                <th className="text-left py-1 px-1 w-28">Input</th>
                {underlyings.map((u, i) => (
                  <th key={i} className="text-center py-1 px-1 text-white text-sm font-bold">{u}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {inputFields.map(f => (
                <tr key={f.key} className="border-t border-[#21262d]">
                  <td className="py-1 px-1 text-[#8b949e] text-[10px]">{f.label}</td>
                  {underlyings.map((u, i) => (
                    <td key={i} className="py-1 px-1">
                      <input type="number" step="any" value={getVal(u, f.key)}
                        onChange={e => setVal(u, f.key, e.target.value)}
                        placeholder="—"
                        className="w-full px-2 py-1 bg-[#0d1117] border border-[#21262d] rounded text-[11px] text-white mono outline-none focus:border-[#2f81f7] text-center" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Results comparison table */}
      {results && results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] text-[#8b949e] uppercase tracking-wider">
                <th className="text-left py-2 px-2"></th>
                {results.map((r, i) => (
                  <th key={i} className="text-center py-2 px-3" style={{minWidth:140}}>
                    <span className="text-white text-sm font-bold">{r.underlying}</span>
                    {i === 0 && r.result && r.result.setupScore > 0 && <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded bg-green/10 text-green font-semibold">BEST</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { label: 'Strategy', render: r => r.result?.legStrat || r.result?.bestStrat || r.error || '--' },
                { label: 'Setup score', render: r => {
                  const s = r.result?.setupScore || 0;
                  const col = s >= 85 ? '#3fb950' : s >= 70 ? '#2f81f7' : s >= 50 ? '#d29922' : '#f85149';
                  return <span style={{color:col}}>{s}/100 <span style={{fontSize:10,fontWeight:400}}>{r.result?.setup||''}</span></span>;
                }},
                { label: 'Direction', render: r => <span style={{color: r.result?.dirScore > 0 ? '#3fb950' : r.result?.dirScore < 0 ? '#f85149' : '#c9d1d9'}}>{r.result?.dirLabel || '--'}</span> },
                { label: 'Move consumed', render: r => r.result?.moveConsumed !== undefined ? (r.result.moveConsumed * 100).toFixed(0) + '%' : '--' },
                { label: 'Regime', render: r => <span style={{fontSize:11,color:'#c9d1d9'}}>{r.result?.regime || '--'}</span> },
                { label: 'Compression', render: r => r.result?.comp != null ? r.result.comp.toFixed(2) : '--' },
                { label: 'Trend', render: r => <span style={{color: r.result?.trendPattern === 'continuation' ? '#3fb950' : r.result?.trendPattern === 'reversal' ? '#d29922' : '#c9d1d9'}}>{r.result?.trendPattern || '--'}</span> },
                { label: 'VWAP slope', render: r => {
                  const s = r.result?.slope5;
                  return <span style={{color: s?.direction === 'rising' ? '#3fb950' : s?.direction === 'falling' ? '#f85149' : '#c9d1d9'}}>{s?.strength || '--'} {s?.direction && s.direction !== 'unknown' ? '(' + s.direction + ')' : ''}{r.result?.confirmed ? ' ✓' : r.result?.diverges ? ' ✗' : ''}</span>;
                }},
                { label: 'Price', render: r => r.data?.price || '--' },
                { label: 'VIX', render: r => r.data?.vix || '--' },
                { label: 'Decision', render: r => {
                  const d = r.result?.decision || '--';
                  const col = d === 'Trade' ? '#3fb950' : d === 'Trade with caution' ? '#d29922' : '#f85149';
                  return <span style={{color:col,fontWeight:700}}>{d}</span>;
                }},
                { label: '', render: (r, underlying) => {
                  if (!r.result || !r.data?.price) return null;
                  return <button onClick={(e) => { e.stopPropagation(); onSelect && onSelect(r.underlying, r.data); }}
                    style={{padding:'4px 12px',borderRadius:6,border:'1px solid #238636',background:'transparent',color:'#3fb950',fontSize:11,fontWeight:600,cursor:'pointer'}}>
                    Use →
                  </button>;
                }},
              ].map((row, ri) => (
                <tr key={ri} className="border-t border-[#21262d]">
                  <td className="py-2 px-2 text-[#8b949e]">{row.label}</td>
                  {results.map((r, i) => (
                    <td key={i} className="py-2 px-3 text-center mono text-xs">{row.render(r)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!results && !scanning && (
        <div className="py-8 text-center text-[#484f58] text-sm">
          Select underlyings and click "Scan all" to fetch data, or "Show inputs" to enter manually
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, cls }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-text-faint uppercase">{label}</div>
      <div className={`text-sm font-bold mono ${cls || ''}`}>{value}</div>
    </div>
  );
}
