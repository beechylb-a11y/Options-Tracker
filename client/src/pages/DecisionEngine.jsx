import React, { useState, useEffect, useCallback } from 'react';
import { ExternalLink, Zap, FileText, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';

const ENGINE_URL = 'https://script.google.com/macros/s/AKfycbyaO8BnJaLjcoiVM5_HEr6XW6d4X-PzglitQOe_HmoiFQrpqCatllID6bajXnmj-6Co/exec';

export default function DecisionEngine({ authenticated }) {
  const [mode, setMode] = useState('0dte');
  const [decisions, setDecisions] = useState([]);
  const [showLog, setShowLog] = useState(false);
  const [expandedDecision, setExpandedDecision] = useState(null);
  const [toast, setToast] = useState(null);

  // Load existing decisions
  useEffect(() => {
    if (!authenticated) return;
    api.getDecisions().then(rows => {
      if (rows && rows.length > 1) {
        const headers = rows[0];
        const data = rows.slice(1).map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = row[i] || ''; });
          return obj;
        }).reverse(); // newest first
        setDecisions(data);
      }
    }).catch(() => {});
  }, [authenticated]);

  // Listen for postMessage from the embedded decision engine iframe
  useEffect(() => {
    function handleMessage(event) {
      if (!event.data || event.data.type !== 'LOG_TRADE') return;
      const data = event.data.data;
      if (!data) return;

      // Post to our API
      api.logDecision(data)
        .then(result => {
          if (result.ok) {
            setToast({ msg: 'Trade logged to Options Tracker', type: 'success' });
            // Refresh decisions list
            api.getDecisions().then(rows => {
              if (rows && rows.length > 1) {
                const headers = rows[0];
                const d = rows.slice(1).map(row => {
                  const obj = {};
                  headers.forEach((h, i) => { obj[h] = row[i] || ''; });
                  return obj;
                }).reverse();
                setDecisions(d);
              }
            });
          }
        })
        .catch(err => {
          setToast({ msg: 'Error logging trade: ' + err.message, type: 'error' });
        });

      setTimeout(() => setToast(null), 3000);
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-display text-2xl font-bold">Decision Engine</h2>
          <p className="text-text-muted text-sm mt-0.5">Pre-trade analysis and strategy selection</p>
        </div>
        <div className="flex items-center gap-3">
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
          <button onClick={() => setShowLog(!showLog)}
            className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${showLog ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            <FileText size={14} />
            Trade Log ({decisions.length})
          </button>
          <a href={ENGINE_URL} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm border border-bg-border rounded-lg hover:bg-bg-hover transition-colors text-text-muted">
            <ExternalLink size={14} />
            Open in new tab
          </a>
        </div>
      </div>

      {/* Toast notification */}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-lg text-sm font-medium fade-in ${
          toast.type === 'success' ? 'bg-green-bg border border-green text-green' : 'bg-red-bg border border-red text-red'
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Decision Log Panel */}
      {showLog && (
        <div className="card mb-4 fade-in" style={{ maxHeight: '400px', overflowY: 'auto' }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-text-muted">Decision Log — {decisions.length} entries</h3>
          </div>
          {decisions.length > 0 ? (
            <div className="space-y-1">
              {decisions.map((d, i) => {
                const expanded = expandedDecision === i;
                return (
                  <div key={i}>
                    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-bg-hover cursor-pointer transition-colors"
                      onClick={() => setExpandedDecision(expanded ? null : i)}>
                      <span className="text-xs text-text-faint mono w-14">{d.Engine || '0DTE'}</span>
                      <span className="text-xs text-text-muted mono w-28">
                        {d.Timestamp ? new Date(d.Timestamp).toLocaleDateString('en-AU', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : ''}
                      </span>
                      <span className="text-sm font-medium flex-1">{d.Strategy || '--'}</span>
                      <span className={`text-xs font-medium ${
                        d.Direction === 'Trade' ? 'text-green' : d.Direction === 'Trade with caution' ? 'text-amber' : 'text-red'
                      }`}>
                        {d.Direction || '--'}
                      </span>
                      <span className="text-xs text-text-muted">{d['Setup Score'] || ''}</span>
                      {expanded ? <ChevronUp size={14} className="text-text-faint" /> : <ChevronDown size={14} className="text-text-faint" />}
                    </div>
                    {expanded && (
                      <div className="px-3 py-3 bg-bg rounded-lg mb-1 fade-in">
                        <div className="grid grid-cols-3 gap-4 text-sm">
                          <div>
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Trade details</div>
                            <div className="space-y-1">
                              <Row label="Engine" value={d.Engine} />
                              <Row label="Underlying" value={d.Underlying} />
                              <Row label="Strategy" value={d.Strategy} />
                              <Row label="Direction" value={d.Direction} />
                              <Row label="Contracts" value={d.Contracts} />
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Sizing & setup</div>
                            <div className="space-y-1">
                              <Row label="Kelly $" value={d['Kelly $']} />
                              <Row label="POP Margin" value={d['POP Margin']} />
                              <Row label="Setup Score" value={d['Setup Score']} />
                              <Row label="Setup Grade" value={d['Setup Grade']} />
                              <Row label="Regime" value={d.Regime} />
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] text-text-faint uppercase tracking-wider mb-2">Strikes & behaviour</div>
                            <div className="space-y-1">
                              <Row label="Wing Strikes" value={d['Wing Strikes']} />
                              <Row label="Behaviour" value={d['Market Behaviour']} />
                              <Row label="Notes" value={d.Notes} />
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-8 text-center text-text-faint text-sm">
              No decisions logged yet. Use the "Log trade" button in the decision engine to record entries.
            </div>
          )}
        </div>
      )}

      {/* Embedded decision engine */}
      <div className="card p-0 overflow-hidden" style={{ height: showLog ? 'calc(100vh - 540px)' : 'calc(100vh - 140px)' }}>
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
      <span className="text-text-muted">{label}</span>
      <span className="text-text font-medium text-right max-w-[200px] truncate">{value || '--'}</span>
    </div>
  );
}
