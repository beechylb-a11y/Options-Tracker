import React, { useState, useEffect, useRef } from 'react';
import { Upload, Filter, ChevronDown, ChevronUp, RefreshCw, AlertTriangle, Check, Edit3, Trash2, Save, X } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor, filterByAccount } from '../utils/format';

export default function Trades({ authenticated, account, accounts }) {
  const [tracker, setTracker] = useState([]);
  const [rawTrades, setRawTrades] = useState([]);
  const [filter, setFilter] = useState('All');
  const [tickerFilter, setTickerFilter] = useState('');
  const [expandedRow, setExpandedRow] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [uploadAccount, setUploadAccount] = useState(account || '');

  // Sync upload account with sidebar selection
  useEffect(() => {
    if (account && account !== 'all') setUploadAccount(account);
  }, [account]);
  const [loading, setLoading] = useState(true);
  const [uncategorised, setUncategorised] = useState([]);
  const [showReview, setShowReview] = useState(false);
  const [savingRow, setSavingRow] = useState(null);
  const [editingRow, setEditingRow] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [saving, setSaving] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState(null);
  const [compareFilter, setCompareFilter] = useState('all');
  const compareRef = useRef();
  const fileRef = useRef();

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    loadData();
  }, [authenticated]);

  async function loadData() {
    setLoading(true);
    try {
      const [t, r, u] = await Promise.all([
        api.getTracker().catch(() => []),
        api.getTrades().catch(() => []),
        api.getUncategorised().catch(() => [])
      ]);
      setTracker(t);
      setRawTrades(r);
      setUncategorised(u);
    } catch (e) { console.error(e); }
    setLoading(false);
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    try {
      const result = await api.uploadCSV(file, uploadAccount);
      setUploadResult(result);
      await loadData();
    } catch (err) {
      setUploadResult({ error: err.message });
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  const filters = ['All', 'Open', 'Closed', 'Expired', 'Assigned', 'Cash Settled'];
  const accountFiltered = filterByAccount(tracker, account);
  const filtered = accountFiltered.filter(t => {
    if (filter !== 'All' && t.Status !== filter) return false;
    if (tickerFilter && !t.Underlying?.toLowerCase().includes(tickerFilter.toLowerCase())) return false;
    return true;
  });

  // Get legs for a specific trade (matching by Order #)
  function getLegsForTrade(trade) {
    const oids = (trade['Order #'] || '').split(',').map(s => s.trim());
    return rawTrades.filter(row => {
      const rowOid = row[1]; // Order # column
      return oids.some(oid => rowOid && rowOid.includes(oid));
    });
  }

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Trades</h2>
        <p className="text-text-muted">Connect Google to view and upload trades.</p>
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Trades</h2>
          <p className="text-text-muted text-sm mt-0.5">{tracker.length} positions tracked</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={loadData} className="flex items-center gap-2 px-3 py-2 text-sm border border-bg-border rounded-lg hover:bg-bg-hover transition-colors">
            <RefreshCw size={14} />
            Refresh
          </button>
          {accounts && accounts.length > 0 && (
            <select value={uploadAccount} onChange={e => setUploadAccount(e.target.value)}
              className="px-2 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-xs text-white outline-none">
              <option value="">No account</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          )}
          <label className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg cursor-pointer transition-colors">
            <Upload size={14} />
            {uploading ? 'Uploading...' : 'Upload CSV'}
            <input ref={fileRef} type="file" accept=".csv" onChange={handleUpload} className="hidden" disabled={uploading} />
          </label>
          <label className="flex items-center gap-2 px-3 py-2 text-sm border border-bg-border rounded-lg hover:bg-bg-hover cursor-pointer transition-colors text-text-muted">
            {comparing ? 'Comparing...' : 'Compare CSV'}
            <input ref={compareRef} type="file" accept=".csv" className="hidden" disabled={comparing}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setComparing(true);
                try {
                  const result = await api.compareCSV(file);
                  setCompareResult(result);
                } catch (err) { setCompareResult({ error: err.message }); }
                setComparing(false);
                if (compareRef.current) compareRef.current.value = '';
              }} />
          </label>
        </div>
      </div>

      {/* Upload result */}
      {uploadResult && (
        <div className={`card mb-4 text-sm ${uploadResult.error ? 'border-red' : 'border-green'}`}>
          {uploadResult.error
            ? <span className="text-red">{uploadResult.error}</span>
            : <span className="text-green">Uploaded: {uploadResult.rawRows} rows parsed, {uploadResult.trackerWritten} positions tracked. BA: {uploadResult.stats?.battingAvg}%</span>
          }
        </div>
      )}

      {/* CSV Compare Results */}
      {compareResult && !compareResult.error && (
        <div className="card mb-4 fade-in">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text flex items-center gap-2">
              CSV Comparison Results
            </h3>
            <button onClick={() => setCompareResult(null)} className="text-text-faint hover:text-text"><X size={14} /></button>
          </div>
          {/* Summary KPIs */}
          <div className="grid grid-cols-5 gap-2 mb-3">
            <div className="text-center p-2 rounded-lg border border-bg-border">
              <div className="text-lg font-bold mono text-text">{compareResult.summary.total}</div>
              <div className="text-[10px] text-text-faint">Total</div>
            </div>
            <div className="text-center p-2 rounded-lg border border-green/30 bg-green/5">
              <div className="text-lg font-bold mono text-green">{compareResult.summary.matched}</div>
              <div className="text-[10px] text-text-faint">Matched</div>
            </div>
            <div className="text-center p-2 rounded-lg border border-amber/30 bg-amber/5">
              <div className="text-lg font-bold mono text-amber">{compareResult.summary.mismatched}</div>
              <div className="text-[10px] text-text-faint">Mismatched</div>
            </div>
            <div className="text-center p-2 rounded-lg border border-accent/30 bg-accent/5">
              <div className="text-lg font-bold mono text-accent">{compareResult.summary.csvOnly}</div>
              <div className="text-[10px] text-text-faint">CSV only</div>
            </div>
            <div className="text-center p-2 rounded-lg border border-red/30 bg-red/5">
              <div className="text-lg font-bold mono text-red">{compareResult.summary.trackerOnly}</div>
              <div className="text-[10px] text-text-faint">Tracker only</div>
            </div>
          </div>
          {compareResult.summary.totalPnlDiff !== 0 && (
            <div className="text-xs text-text-muted mb-3">Total P&L difference: <span className="mono font-bold" style={{ color: pnlColor(compareResult.summary.totalPnlDiff) }}>{fmt$(compareResult.summary.totalPnlDiff)}</span></div>
          )}
          {/* Filter */}
          <div className="flex gap-1.5 mb-3">
            {[['all','All'],['mismatch','Mismatched'],['csv_only','CSV only'],['tracker_only','Tracker only'],['match','Matched']].map(([v,l]) => (
              <button key={v} onClick={() => setCompareFilter(v)}
                className={`px-2.5 py-1 text-[10px] rounded-lg border transition-colors ${compareFilter === v ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-faint hover:bg-bg-hover'}`}>{l}</button>
            ))}
          </div>
          {/* Results table */}
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-card">
                <tr className="text-text-faint text-[9px] uppercase tracking-wider">
                  <th className="text-left py-1.5 pr-2">Status</th>
                  <th className="text-left py-1.5 pr-2">Date</th>
                  <th className="text-left py-1.5 pr-2">Ticker</th>
                  <th className="text-left py-1.5 pr-2">Strategy</th>
                  <th className="text-right py-1.5 pr-2">CSV P&L</th>
                  <th className="text-right py-1.5 pr-2">Tracker P&L</th>
                  <th className="text-right py-1.5">Diff</th>
                </tr>
              </thead>
              <tbody>
                {compareResult.results
                  .filter(r => compareFilter === 'all' || r.status === compareFilter)
                  .map((r, i) => {
                    const badgeCls = r.status === 'match' ? 'badge-green' : r.status === 'mismatch' ? 'badge-amber' : r.status === 'csv_only' ? 'badge-blue' : 'badge-red';
                    const csv = r.csv;
                    const ex = r.existing;
                    return (
                      <tr key={i} className="border-b border-bg-border last:border-0">
                        <td className="py-1.5 pr-2"><span className={`badge text-[8px] ${badgeCls}`}>{r.status.replace('_', ' ')}</span></td>
                        <td className="py-1.5 pr-2 mono text-text-muted">{csv?.entryDate || (ex?.['Entry Date'] || '').split('T')[0]}</td>
                        <td className="py-1.5 pr-2 font-medium">{csv?.underlying || ex?.Underlying}</td>
                        <td className="py-1.5 pr-2 text-text-muted">{r.diffs?.strategy ? <><span className="text-amber">{r.diffs.strategy.csv}</span> / <span className="text-text-faint">{r.diffs.strategy.existing}</span></> : (csv?.strategy || ex?.['Strategy (OIC)'])}</td>
                        <td className="py-1.5 pr-2 text-right mono" style={{ color: csv ? pnlColor(csv.totalPnl) : '#484f58' }}>{csv ? fmt$(csv.totalPnl) : '--'}</td>
                        <td className="py-1.5 pr-2 text-right mono" style={{ color: ex ? pnlColor(parseFloat(ex['Total P&L ($)']) || 0) : '#484f58' }}>{ex ? fmt$(parseFloat(ex['Total P&L ($)']) || 0) : '--'}</td>
                        <td className="py-1.5 text-right mono font-medium" style={{ color: Math.abs(r.pnlDiff) >= 1 ? pnlColor(r.pnlDiff) : '#484f58' }}>{Math.abs(r.pnlDiff) >= 1 ? fmt$(r.pnlDiff) : '—'}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {compareResult?.error && (
        <div className="card mb-4 text-sm border-red"><span className="text-red">{compareResult.error}</span></div>
      )}

      {/* Uncategorised trades review */}
      {uncategorised.length > 0 && (
        <div className="mb-4">
          <button onClick={() => setShowReview(!showReview)}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${
              showReview ? 'border-amber bg-amber-bg text-amber' : 'border-amber/50 text-amber hover:bg-amber-bg'
            }`}>
            <AlertTriangle size={14} />
            {uncategorised.length} uncategorised trade{uncategorised.length !== 1 ? 's' : ''} — click to review
          </button>
        </div>
      )}

      {showReview && uncategorised.length > 0 && (
        <div className="card mb-4 fade-in" style={{ maxHeight: '400px', overflowY: 'auto' }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="text-sm font-medium text-text">Manual Strategy Assignment</h3>
              <p className="text-xs text-text-muted mt-0.5">These trades couldn't be auto-classified. Select the correct strategy.</p>
            </div>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-faint text-[10px] uppercase tracking-wider">
                <th className="text-left py-2 px-2">Date</th>
                <th className="text-left py-2 px-2">Ticker</th>
                <th className="text-left py-2 px-2">Current</th>
                <th className="text-right py-2 px-2">P&L</th>
                <th className="text-left py-2 px-2">Assign strategy</th>
                <th className="text-center py-2 px-2">Save</th>
              </tr>
            </thead>
            <tbody>
              {uncategorised.map((t, i) => {
                const pnl = parseFloat(t['Total P&L ($)']) || 0;
                return (
                  <tr key={i} className="table-row">
                    <td className="py-2 px-2 text-text-muted mono text-xs">{fmtDate(t['Entry Date'])}</td>
                    <td className="py-2 px-2 font-medium">{t.Underlying}</td>
                    <td className="py-2 px-2 text-text-faint text-xs">{t['Strategy (OIC)'] || '(none)'}</td>
                    <td className="py-2 px-2 text-right mono" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</td>
                    <td className="py-2 px-2">
                      <select
                        id={`strat-${i}`}
                        defaultValue=""
                        className="w-full px-2 py-1 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent"
                      >
                        <option value="">Select...</option>
                        <optgroup label="Credit strategies">
                          <option value="Short Iron Condor">Iron Condor (Short)</option>
                          <option value="Short Iron Butterfly">Iron Butterfly (Short)</option>
                          <option value="Bull Put Spread">Bull Put Spread</option>
                          <option value="Bear Call Spread">Bear Call Spread</option>
                          <option value="Short Strangle">Short Strangle</option>
                          <option value="Short Straddle">Short Straddle</option>
                          <option value="Covered Call">Covered Call</option>
                          <option value="Cash-Secured Put">Cash-Secured Put</option>
                          <option value="Naked Put">Naked Put</option>
                          <option value="Naked Call">Naked Call</option>
                        </optgroup>
                        <optgroup label="Debit strategies">
                          <option value="Long Call Butterfly">Long Call Butterfly</option>
                          <option value="Long Put Butterfly">Long Put Butterfly</option>
                          <option value="Long Iron Condor">Long Condor</option>
                          <option value="Bull Call Spread">Bull Call Spread</option>
                          <option value="Bear Put Spread">Bear Put Spread</option>
                          <option value="Long Straddle">Long Straddle</option>
                          <option value="Long Strangle">Long Strangle</option>
                          <option value="Long Call">Long Call</option>
                          <option value="Long Put">Long Put</option>
                        </optgroup>
                        <optgroup label="Other">
                          <option value="Collar">Collar</option>
                          <option value="Protective Put">Protective Put</option>
                          <option value="Long Call Calendar Spread">Call Calendar</option>
                          <option value="Long Put Calendar Spread">Put Calendar</option>
                          <option value="Long Ratio Call Spread">Ratio Call Spread</option>
                          <option value="Long Ratio Put Spread">Ratio Put Spread</option>
                        </optgroup>
                      </select>
                    </td>
                    <td className="py-2 px-2 text-center">
                      <button
                        disabled={savingRow === i}
                        onClick={async () => {
                          const sel = document.getElementById(`strat-${i}`);
                          const strategy = sel?.value;
                          if (!strategy) return;
                          setSavingRow(i);
                          try {
                            await api.categoriseTrade(t._rowIndex, strategy, t['Order #']);
                            // Remove from list
                            setUncategorised(prev => prev.filter((_, idx) => idx !== i));
                            // Refresh tracker
                            const updated = await api.getTracker();
                            setTracker(updated);
                          } catch (e) { console.error(e); }
                          setSavingRow(null);
                        }}
                        className="p-1 rounded hover:bg-bg-hover transition-colors text-green disabled:opacity-50"
                      >
                        {savingRow === i ? '...' : <Check size={14} />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex border border-bg-border rounded-lg overflow-hidden">
          {filters.map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${filter === f ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              {f}
            </button>
          ))}
        </div>
        <div className="relative">
          <Filter size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-faint" />
          <input
            type="text" placeholder="Filter ticker..."
            value={tickerFilter} onChange={e => setTickerFilter(e.target.value)}
            className="pl-8 pr-3 py-1.5 text-sm bg-bg border border-bg-border rounded-lg text-text placeholder-text-faint focus:border-accent outline-none"
          />
        </div>
      </div>

      {/* Trade Table */}
      {loading ? (
        <div className="text-text-muted text-sm py-8 text-center">Loading trades...</div>
      ) : filtered.length > 0 ? (
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-faint text-[11px] uppercase tracking-wider bg-bg">
                <th className="text-left py-3 px-4"></th>
                <th className="text-left py-3 px-4">Date</th>
                <th className="text-left py-3 px-4">Ticker</th>
                <th className="text-left py-3 px-4">Strategy</th>
                <th className="text-center py-3 px-4">Qty</th>
                <th className="text-right py-3 px-4">Credit</th>
                <th className="text-right py-3 px-4">P&L</th>
                <th className="text-center py-3 px-4">W/L</th>
                <th className="text-left py-3 px-4">Status</th>
                <th className="text-left py-3 px-4">DTE</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t, i) => {
                const pnl = parseFloat(t['Total P&L ($)']) || 0;
                const credit = parseFloat(t['Net Credit ($)']) || 0;
                const isOpen = t.Status === 'Open';
                const expanded = expandedRow === i;
                const dte = t['Expiry Date'] ? Math.ceil((new Date(t['Expiry Date']) - new Date()) / (1000 * 60 * 60 * 24)) : '';

                return (
                  <React.Fragment key={i}>
                    <tr className="table-row cursor-pointer" onClick={() => setExpandedRow(expanded ? null : i)}>
                      <td className="py-2.5 px-4 text-text-faint">
                        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </td>
                      <td className="py-2.5 px-4 text-text-muted mono text-xs">{fmtDate(t['Entry Date'])}</td>
                      <td className="py-2.5 px-4 font-medium">{t.Underlying}</td>
                      <td className="py-2.5 px-4 text-text-muted">{t['Strategy (OIC)']}</td>
                      <td className="py-2.5 px-4 text-center mono">{t.Qty}</td>
                      <td className="py-2.5 px-4 text-right mono" style={{ color: pnlColor(credit) }}>{fmt$(credit)}</td>
                      <td className="py-2.5 px-4 text-right mono font-medium" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</td>
                      <td className="py-2.5 px-4 text-center">
                        {t['W / L'] && <span className={`badge ${t['W / L'] === 'Win' ? 'badge-green' : 'badge-red'}`}>{t['W / L']}</span>}
                      </td>
                      <td className="py-2.5 px-4">
                        <span className={`badge ${isOpen ? 'badge-blue' : t.Status === 'Assigned' ? 'badge-amber' : 'badge-green'}`}>
                          {t.Status}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 mono text-xs text-text-muted">
                        {isOpen && dte ? <span className={dte <= 3 ? 'text-red' : dte <= 7 ? 'text-amber' : ''}>{dte}d</span> : ''}
                      </td>
                    </tr>
                    {/* Expanded trade ticket */}
                    {expanded && (
                      <tr>
                        <td colSpan="10" className="bg-bg p-4">
                          {deleting === i ? (
                            <div className="fade-in text-center py-4">
                              <p className="text-sm text-text mb-2">Delete this trade?</p>
                              <p className="text-xs text-text-muted mb-3">{t.Underlying} — {t['Strategy (OIC)']} — {fmt$(parseFloat(t['Total P&L ($)']) || 0)}</p>
                              <div className="flex gap-2 justify-center">
                                <button onClick={() => setDeleting(null)}
                                  className="px-4 py-1.5 text-xs border border-bg-border rounded-lg hover:bg-bg-hover text-text-muted">Cancel</button>
                                <button onClick={async () => {
                                  setSaving(true);
                                  try {
                                    await api.deleteTrade(t._rowIndex);
                                    setDeleting(null);
                                    setExpandedRow(null);
                                    await loadData();
                                  } catch (e) { console.error(e); }
                                  setSaving(false);
                                }} disabled={saving}
                                  className="px-4 py-1.5 text-xs bg-red-dim hover:bg-red text-white rounded-lg disabled:opacity-50">
                                  {saving ? 'Deleting...' : 'Confirm delete'}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <TradeTicket trade={t} legs={getLegsForTrade(t)} tradeIdx={i}
                              editingRow={editingRow} editForm={editForm} setEditForm={setEditForm} saving={saving}
                              onEdit={(action, idx) => {
                                if (action === null) { setEditingRow(null); return; }
                                if (action === 'save') {
                                  (async () => {
                                    setSaving(true);
                                    try {
                                      await api.updateTrade(t._rowIndex, editForm);
                                      setEditingRow(null);
                                      await loadData();
                                    } catch (e) { console.error(e); }
                                    setSaving(false);
                                  })();
                                  return;
                                }
                                // Start editing
                                setEditForm({
                                  underlying: action.Underlying || '',
                                  strategy: action['Strategy (OIC)'] || '',
                                  entryDate: (action['Entry Date'] || '').split('T')[0],
                                  closeDate: (action['Close Date'] || '').split('T')[0],
                                  expiryDate: (action['Expiry Date'] || '').split('T')[0],
                                  totalPnl: action['Total P&L ($)'] || '',
                                  netCredit: action['Net Credit ($)'] || '',
                                  qty: action.Qty || '',
                                  status: action.Status || 'Open'
                                });
                                setEditingRow(idx);
                              }}
                              onDelete={(trade, idx) => setDeleting(idx)}
                            />
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="card text-center py-12">
          <p className="text-text-faint mb-4">No trades to show</p>
          <p className="text-text-muted text-sm">Upload a TastyTrade Activity CSV to import your trading history</p>
        </div>
      )}
    </div>
  );
}

function TradeTicket({ trade, legs, onEdit, onDelete, editingRow, editForm, setEditForm, saving, tradeIdx }) {
  const pnl = parseFloat(trade['Total P&L ($)']) || 0;
  const isEditing = editingRow === tradeIdx;

  return (
    <div className="fade-in">
      {!isEditing ? (
        <div className="grid grid-cols-2 gap-4">
          <div>
            <h4 className="text-xs text-text-faint uppercase tracking-wider mb-2">Trade Details</h4>
            <div className="grid grid-cols-2 gap-y-1.5 text-sm">
              <span className="text-text-muted">Entry</span><span className="mono">{fmtDate(trade['Entry Date'])}</span>
              <span className="text-text-muted">Expiry</span><span className="mono">{fmtDate(trade['Expiry Date'])}</span>
              <span className="text-text-muted">Close</span><span className="mono">{fmtDate(trade['Close Date'])}</span>
              <span className="text-text-muted">Strategy</span><span>{trade['Strategy (OIC)']}</span>
              <span className="text-text-muted">Underlying</span><span className="font-medium">{trade.Underlying}</span>
              <span className="text-text-muted">Status</span><span>{trade.Status}</span>
              <span className="text-text-muted">Net credit</span><span className="mono" style={{ color: pnlColor(parseFloat(trade['Net Credit ($)'])) }}>{fmt$(parseFloat(trade['Net Credit ($)']))}</span>
              <span className="text-text-muted">Total P&L</span><span className="mono font-bold text-base" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => onEdit(trade, tradeIdx)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-bg-border rounded-lg hover:bg-bg-hover text-text-muted transition-colors">
                <Edit3 size={12} /> Edit
              </button>
              <button onClick={() => onDelete(trade, tradeIdx)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-red/30 rounded-lg hover:bg-red/10 text-red transition-colors">
                <Trash2 size={12} /> Delete
              </button>
            </div>
          </div>
          <div>
            <h4 className="text-xs text-text-faint uppercase tracking-wider mb-2">Individual Legs</h4>
            {legs.length > 0 ? (
              <div className="space-y-1">
                {legs.map((leg, i) => (
                  <div key={i} className="flex items-center gap-3 text-xs py-1 border-b border-bg-border last:border-0">
                    <span className="text-text-faint w-16">{(leg[0] || '').split(' ')[0]}</span>
                    <span className="text-text-muted flex-1">{leg[5]}</span>
                    <span className="mono" style={{ color: pnlColor(parseFloat(leg[14])) }}>{fmt$(parseFloat(leg[14]))}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-text-faint text-xs">No leg detail available</p>
            )}
          </div>
        </div>
      ) : (
        <div className="fade-in">
          <h4 className="text-xs text-text-faint uppercase tracking-wider mb-3">Edit Trade</h4>
          <div className="grid grid-cols-4 gap-3">
            <EditField label="Underlying" value={editForm.underlying} onChange={v => setEditForm(f => ({ ...f, underlying: v }))} />
            <EditField label="Strategy" value={editForm.strategy} onChange={v => setEditForm(f => ({ ...f, strategy: v }))} />
            <EditField label="Entry Date" value={editForm.entryDate} onChange={v => setEditForm(f => ({ ...f, entryDate: v }))} type="date" />
            <EditField label="Close Date" value={editForm.closeDate} onChange={v => setEditForm(f => ({ ...f, closeDate: v }))} type="date" />
            <EditField label="Expiry Date" value={editForm.expiryDate} onChange={v => setEditForm(f => ({ ...f, expiryDate: v }))} type="date" />
            <EditField label="Total P&L ($)" value={editForm.totalPnl} onChange={v => setEditForm(f => ({ ...f, totalPnl: v }))} type="number" />
            <EditField label="Net Credit ($)" value={editForm.netCredit} onChange={v => setEditForm(f => ({ ...f, netCredit: v }))} type="number" />
            <EditField label="Qty" value={editForm.qty} onChange={v => setEditForm(f => ({ ...f, qty: v }))} type="number" />
            <div>
              <label className="text-[10px] text-text-muted block mb-1">Status</label>
              <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent">
                <option value="Open">Open</option>
                <option value="Closed">Closed</option>
                <option value="Expired">Expired</option>
                <option value="Assigned">Assigned</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={() => onEdit(null, null)} disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-bg-border rounded-lg hover:bg-bg-hover text-text-muted transition-colors">
              <X size={12} /> Cancel
            </button>
            <button onClick={() => onEdit('save', tradeIdx)} disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-50">
              <Save size={12} /> {saving ? 'Saving...' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function EditField({ label, value, onChange, type = 'text' }) {
  return (
    <div>
      <label className="text-[10px] text-text-muted block mb-1">{label}</label>
      <input type={type} step={type === 'number' ? '0.01' : undefined} value={value || ''}
        onChange={e => onChange(e.target.value)}
        className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
    </div>
  );
}
