import React, { useState, useEffect } from 'react';
import { ExternalLink, Zap, FileText, ChevronDown, ChevronUp, GitCompare, Check, X, DollarSign, Edit3, Clock, Save } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';

const ENGINE_URL = 'https://script.google.com/macros/s/AKfycbyaO8BnJaLjcoiVM5_HEr6XW6d4X-PzglitQOe_HmoiFQrpqCatllID6bajXnmj-6Co/exec';

export default function DecisionEngine({ authenticated }) {
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
    if (!authenticated) return;
    api.getDecisions().then(rows => {
      if (rows && rows.length > 1) {
        const headers = rows[0];
        const data = rows.slice(1).map((row, idx) => {
          const obj = { _rowIndex: idx + 2 };
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        }).reverse();
        setDecisions(data);
      }
    }).catch(() => {});
  }

  useEffect(() => { loadDecisions(); }, [authenticated]);

  // Listen for postMessage from iframe
  useEffect(() => {
    function handleMessage(event) {
      if (!event.data || event.data.type !== 'LOG_TRADE') return;
      api.logDecision(event.data.data)
        .then(result => {
          if (result.ok) {
            showToast('Trade logged to Options Tracker', 'success');
            loadDecisions();
          }
        })
        .catch(err => showToast('Error: ' + err.message, 'error'));
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  function showToast(msg, type) {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleCloseTicket(dec) {
    setSaving(true);
    try {
      await api.closeTicket(dec._rowIndex, closeForm);
      showToast('Trade ticket closed', 'success');
      setClosingIdx(null);
      setCloseForm({ closeDate: '', closePrice: '', actualPnl: '' });
      loadDecisions();
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

  const openTickets = decisions.filter(d => d.Status !== 'Closed');
  const closedTickets = decisions.filter(d => d.Status === 'Closed');

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
          <a href={ENGINE_URL} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm border border-bg-border rounded-lg hover:bg-bg-hover transition-colors text-text-muted">
            <ExternalLink size={14} />
          </a>
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

      {/* Embedded engine */}
      <div className="card p-0 overflow-hidden" style={{ height: panel ? 'calc(100vh - 540px)' : 'calc(100vh - 140px)' }}>
        <iframe
          src={ENGINE_URL + (mode === '45dte' ? '?mode=45' : '')}
          style={{ width: '100%', height: '100%', border: 'none', background: '#0d1117', borderRadius: '12px' }}
          title="Decision Engine"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
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

function Stat({ label, value, cls }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-text-faint uppercase">{label}</div>
      <div className={`text-sm font-bold mono ${cls || ''}`}>{value}</div>
    </div>
  );
}
