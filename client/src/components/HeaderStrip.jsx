import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { api, clearApiCache } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { mergeClosedTrades, todayPnlOf, filterTracker } from '../utils/stats';

// Persistent context strip: account switcher, today P&L, daily-loss gauge,
// open-position count, data freshness + global refresh, Sheets/bridge status.
// Data comes through the same cached api + stats helpers the pages use, so
// the strip and the pages always agree.

const clockFmt = ts =>
  ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '--:--';

function StatusDot({ state, label, title }) {
  const color =
    state === 'ok' ? 'bg-green' :
    state === 'warn' ? 'bg-amber' :
    state === 'off' ? 'bg-bg-border' : 'bg-red';
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <div className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-[11px] text-text-muted">{label}</span>
    </div>
  );
}

export default function HeaderStrip({ authenticated, account, accounts, onAccountChange, onGlobalRefresh, onLogin }) {
  const [tracker, setTracker] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [config, setConfig] = useState(null);
  const [lastSynced, setLastSynced] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetsState, setSheetsState] = useState(authenticated ? 'ok' : 'off');
  const [bridgeState, setBridgeState] = useState('off');
  const [bridgeTitle, setBridgeTitle] = useState('Bridge URL not configured');

  const loadData = useCallback(() => {
    if (!authenticated) return;
    Promise.all([
      api.getTracker().catch(() => null),
      api.getDecisions().catch(() => []),
      api.getStats(account).catch(() => null)
    ]).then(([t, d, s]) => {
      if (t === null) { setSheetsState('err'); return; }
      setSheetsState('ok');
      setTracker(t);
      setDecisions(Array.isArray(d) && d.length > 0 && d[0]._rowIndex !== undefined ? d : []);
      if (s?.config) setConfig(s.config);
      setLastSynced(Date.now());
    });
  }, [authenticated, account]);

  // Initial + account-change load (cache makes this cheap alongside page fetches)
  useEffect(() => { loadData(); }, [loadData]);

  // Passive re-sync every 60s
  useEffect(() => {
    if (!authenticated) return;
    const id = setInterval(loadData, 60 * 1000);
    return () => clearInterval(id);
  }, [authenticated, loadData]);

  // Bridge heartbeat every 60s
  useEffect(() => {
    let stop = false;
    async function ping() {
      const url = (localStorage.getItem('bridgeUrl') || '').replace(/\/+$/, '');
      if (!url) { setBridgeState('off'); setBridgeTitle('Bridge URL not configured (Settings)'); return; }
      try {
        const r = await fetch(url + '/api/health', { headers: { 'ngrok-skip-browser-warning': '1' } });
        const d = await r.json();
        if (stop) return;
        if (d.ok && d.connected) { setBridgeState('ok'); setBridgeTitle('Bridge up, TWS connected'); }
        else if (d.ok) { setBridgeState('warn'); setBridgeTitle('Bridge up, TWS not connected'); }
        else { setBridgeState('err'); setBridgeTitle('Bridge unhealthy'); }
      } catch (e) {
        if (!stop) { setBridgeState('err'); setBridgeTitle('Bridge unreachable: ' + e.message); }
      }
    }
    ping();
    const id = setInterval(ping, 60 * 1000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  async function handleRefresh() {
    setRefreshing(true);
    clearApiCache();
    loadData();
    onGlobalRefresh?.();
    setTimeout(() => setRefreshing(false), 600);
  }

  const closedTrades = mergeClosedTrades(tracker, decisions, account, accounts);
  const todayPnl = todayPnlOf(closedTrades);
  const openCount = filterTracker(tracker, account, accounts).filter(t => t.Status === 'Open').length;
  const maxDailyLoss = Number(config?.maxDailyLoss) || 0;
  const lossUsedPct = maxDailyLoss > 0 && todayPnl < 0
    ? Math.min(100, Math.abs(todayPnl) / maxDailyLoss * 100) : 0;
  const gaugeColor = lossUsedPct >= 80 ? 'bg-red' : lossUsedPct >= 50 ? 'bg-amber' : 'bg-green';

  return (
    <div className="sticky top-0 z-20 bg-bg-card/95 backdrop-blur border-b border-bg-border">
      <div className="max-w-[1400px] mx-auto px-6 h-12 flex items-center gap-5">
        {authenticated && accounts.length > 0 ? (
          <select
            value={account}
            onChange={e => onAccountChange(e.target.value)}
            className="px-2 py-1 bg-bg border border-bg-border rounded-lg text-xs font-medium text-text outline-none focus:border-accent"
          >
            <option value="all">All accounts</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        ) : !authenticated ? (
          <button onClick={onLogin} className="px-3 py-1 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg transition-colors">
            Connect Google
          </button>
        ) : null}

        {authenticated && (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] text-text-faint uppercase tracking-wider">Today</span>
              <span className="mono text-sm font-bold" style={{ color: pnlColor(todayPnl) }}>{fmt$(todayPnl)}</span>
            </div>

            {maxDailyLoss > 0 && (
              <div className="flex items-center gap-1.5" title={`Daily loss used: ${fmt$(todayPnl < 0 ? Math.abs(todayPnl) : 0)} of ${fmt$(maxDailyLoss)} cap`}>
                <span className="text-[10px] text-text-faint uppercase tracking-wider">Loss cap</span>
                <div className="w-16 h-1.5 bg-bg rounded-full overflow-hidden">
                  <div className={`h-full ${gaugeColor}`} style={{ width: `${lossUsedPct}%` }} />
                </div>
                <span className="text-[11px] text-text-muted mono">{Math.round(lossUsedPct)}%</span>
              </div>
            )}

            <div className="flex items-baseline gap-1.5">
              <span className="text-[10px] text-text-faint uppercase tracking-wider">Open</span>
              <span className="mono text-sm font-bold text-text">{openCount}</span>
            </div>
          </>
        )}

        <div className="flex-1" />

        <button
          onClick={handleRefresh}
          className="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text transition-colors"
          title="Refresh all data"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {lastSynced ? `Synced ${clockFmt(lastSynced)}` : 'Not synced'}
        </button>

        <StatusDot state={sheetsState} label="Sheets" title={sheetsState === 'ok' ? 'Google Sheets reachable' : sheetsState === 'off' ? 'Not connected' : 'Sheets fetch failed'} />
        <StatusDot state={bridgeState} label="Bridge" title={bridgeTitle} />
      </div>
    </div>
  );
}
