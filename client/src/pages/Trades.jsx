import React, { useState, useEffect, useRef } from 'react';
import { Upload, Filter, ChevronDown, ChevronUp, RefreshCw, AlertTriangle, Check } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';

export default function Trades({ authenticated }) {
  const [tracker, setTracker] = useState([]);
  const [rawTrades, setRawTrades] = useState([]);
  const [filter, setFilter] = useState('All');
  const [tickerFilter, setTickerFilter] = useState('');
  const [expandedRow, setExpandedRow] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uncategorised, setUncategorised] = useState([]);
  const [showReview, setShowReview] = useState(false);
  const [savingRow, setSavingRow] = useState(null);
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
      const result = await api.uploadCSV(file);
      setUploadResult(result);
      await loadData();
    } catch (err) {
      setUploadResult({ error: err.message });
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  const filters = ['All', 'Open', 'Closed', 'Expired', 'Assigned', 'Cash Settled'];
  const filtered = tracker.filter(t => {
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
          <label className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg cursor-pointer transition-colors">
            <Upload size={14} />
            {uploading ? 'Uploading...' : 'Upload CSV'}
            <input ref={fileRef} type="file" accept=".csv" onChange={handleUpload} className="hidden" disabled={uploading} />
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
                          <TradeTicket trade={t} legs={getLegsForTrade(t)} />
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

function TradeTicket({ trade, legs }) {
  const pnl = parseFloat(trade['Total P&L ($)']) || 0;
  return (
    <div className="grid grid-cols-2 gap-4 fade-in">
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
  );
}
