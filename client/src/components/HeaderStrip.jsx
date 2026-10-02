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

// Bridge controls (Oct 2026): the dot opens a small menu to reconnect to TWS or
// restart the bridge process, so a TWS restart no longer means a trip to Terminal.
// Both only work while the bridge process and its ngrok tunnel are up — if the
// bridge itself is unreachable there is nothing on the other end to ask.
function BridgeControl({ state, title, onAction, busy, note, mode }) {
  const [open, setOpen] = useState(false);
  const color = state === 'ok' ? 'bg-green' : state === 'warn' ? 'bg-amber' : state === 'off' ? 'bg-bg-border' : 'bg-red';
  const btn = 'w-full text-left px-3 py-1.5 text-[12.5px] rounded hover:bg-bg-hover disabled:opacity-50';
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} title={title} className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${color} ${busy ? 'animate-pulse' : ''}`} />
        <span className="text-[12.5px] text-text-muted">Bridge</span>
        {state === 'ok' && mode === 'paper' && (
          <span className="text-[11px] px-1.5 rounded" style={{ background: '#1f1a0d', color: '#d29922', border: '1px solid #9e6a03' }}>PAPER</span>
        )}
        <span className="text-[12.5px] text-text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 p-2 rounded-lg border border-bg-border bg-bg-card shadow-lg z-30"
          onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-1 text-[12px] text-text-muted leading-snug">{busy || note || title}</div>
          <button className={btn} disabled={!!busy || state === 'off'} onClick={() => onAction('reconnect')}>
            ↻ Reconnect to TWS
            <div className="text-[11px] text-text-faint">Use after TWS restarts or re-logs in</div>
          </button>
          <button className={btn} disabled={!!busy || state === 'off'} onClick={() => onAction('restart')}>
            ⟳ Restart bridge
            <div className="text-[11px] text-text-faint">Reloads the bridge code (after a pull) — back in ~10 s</div>
          </button>
          {state === 'err' && (
            <div className="px-3 pt-1 text-[11.5px] text-red leading-snug">
              Bridge unreachable: the Mac, the bridge or ngrok is down. It restarts itself if it crashed; if the Mac was asleep, wake it.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ state, label, title }) {
  const color =
    state === 'ok' ? 'bg-green' :
    state === 'warn' ? 'bg-amber' :
    state === 'off' ? 'bg-bg-border' : 'bg-red';
  return (
    <div className="flex items-center gap-1.5" title={title}>
      <div className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-[12.5px] text-text-muted">{label}</span>
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
  const [bridgeBusy, setBridgeBusy] = useState('');
  const [bridgeMode, setBridgeMode] = useState('');
  const [bridgeNote, setBridgeNote] = useState('');
  const [pingTick, setPingTick] = useState(0);
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
        if (d.ok && d.connected) {
          setBridgeState('ok');
          setBridgeMode(d.mode || '');
          setBridgeTitle(`Bridge up, connected to ${d.app || 'TWS'}${d.mode ? ' · ' + d.mode : ''}`
            + (d.accounts && d.accounts.length ? ` (${d.accounts.join(', ')})` : '')
            + (d.mode === 'paper' ? ' — positions and fills are the PAPER account\'s' : ''));
        }
        else if (d.ok) { setBridgeMode(''); setBridgeState('warn'); setBridgeTitle('Bridge up, TWS not connected'
          + (d.reconnecting ? ' — retrying automatically' : '') + (d.lastError ? ': ' + d.lastError : '')); }
        else { setBridgeState('err'); setBridgeTitle('Bridge unhealthy'); }
      } catch (e) {
        if (!stop) { setBridgeState('err'); setBridgeTitle('Bridge unreachable: ' + e.message); }
      }
    }
    ping();
    const id = setInterval(ping, 60 * 1000);
    return () => { stop = true; clearInterval(id); };
  }, [pingTick]);

  async function bridgeAction(kind) {
    const url = (localStorage.getItem('bridgeUrl') || '').replace(/\/+$/, '');
    if (!url) return;
    const H = { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' };
    setBridgeNote('');
    try {
      if (kind === 'reconnect') {
        setBridgeBusy('Reconnecting to TWS…');
        const d = await fetch(url + '/api/reconnect', { method: 'POST', headers: H }).then(r => r.json());
        setBridgeNote(d.connected ? 'Reconnected to TWS.' : 'TWS did not answer: ' + (d.error || 'unknown') + ' — it will keep retrying.');
      } else {
        setBridgeBusy('Restarting bridge…');
        await fetch(url + '/api/restart', { method: 'POST', headers: H }).catch(() => {});
        // launchd brings it back; wait for a health answer from the NEW process.
        let back = null;
        for (let i = 0; i < 15 && !back; i++) {
          await new Promise(r => setTimeout(r, 2000));
          try { back = await fetch(url + '/api/health', { headers: H }).then(r => r.json()); } catch (e) { back = null; }
        }
        setBridgeNote(back ? (back.connected ? 'Bridge restarted, TWS connected.' : 'Bridge restarted; connecting to TWS…')
          : 'Bridge did not come back within 30 s — check the Mac.');
      }
    } catch (e) {
      setBridgeNote('Failed: ' + e.message);
    }
    setBridgeBusy('');
    setPingTick(t => t + 1);
  }

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
            Sign in
          </button>
        ) : null}

        {authenticated && (
          <>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] text-text-faint uppercase tracking-wider">Today</span>
              <span className="mono text-sm font-bold" style={{ color: pnlColor(todayPnl) }}>{fmt$(todayPnl)}</span>
            </div>

            {maxDailyLoss > 0 && (
              <div className="flex items-center gap-1.5" title={`Daily loss used: ${fmt$(todayPnl < 0 ? Math.abs(todayPnl) : 0)} of ${fmt$(maxDailyLoss)} cap`}>
                <span className="text-[12px] text-text-faint uppercase tracking-wider">Loss cap</span>
                <div className="w-16 h-1.5 bg-bg rounded-full overflow-hidden">
                  <div className={`h-full ${gaugeColor}`} style={{ width: `${lossUsedPct}%` }} />
                </div>
                <span className="text-[12.5px] text-text-muted mono">{Math.round(lossUsedPct)}%</span>
              </div>
            )}

            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] text-text-faint uppercase tracking-wider">Open</span>
              <span className="mono text-sm font-bold text-text">{openCount}</span>
            </div>
          </>
        )}

        <div className="flex-1" />

        <button
          onClick={handleRefresh}
          className="flex items-center gap-1.5 text-[12.5px] text-text-muted hover:text-text transition-colors"
          title="Refresh all data"
        >
          <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
          {lastSynced ? `Synced ${clockFmt(lastSynced)}` : 'Not synced'}
        </button>

        <StatusDot state={sheetsState} label="DB" title={sheetsState === 'ok' ? 'Database reachable' : sheetsState === 'off' ? 'Not signed in' : 'Database fetch failed'} />
        <BridgeControl state={bridgeState} title={bridgeTitle} onAction={bridgeAction} busy={bridgeBusy} note={bridgeNote} mode={bridgeMode} />
      </div>
    </div>
  );
}
