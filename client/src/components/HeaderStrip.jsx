import React, { useState, useEffect, useCallback } from 'react';
import GlassSurface from './GlassSurface';
import { useGlassOn, useVisionOn } from './ThemeToggle';
import { RefreshCw } from 'lucide-react';
import { api, clearApiCache } from '../utils/api';
import { fmt$, pnlColor } from '../utils/format';
import { mergeClosedTrades, todayPnlOf, filterTracker } from '../utils/stats';
import { marketClock } from '../engine/marketClock';
import ThemeToggle from './ThemeToggle';
import FreshDot from './FreshDot';
import { useLiveQuote, useLiveConnection, useFreshness } from '../live/useLive';
import { reconnectLiveFeed } from '../live/liveFeed';
import { ScanChip } from './ScanProgress';

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
function BridgeControl({ state, title, onAction, busy, note, mode, liveLine }) {
  const [open, setOpen] = useState(false);
  const color = state === 'ok' ? 'bg-green' : state === 'warn' ? 'bg-amber' : state === 'off' ? 'bg-bg-border' : 'bg-red';
  const btn = 'w-full text-left px-3 py-1.5 text-[12.5px] rounded hover:bg-bg-hover disabled:opacity-50';
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} title={title} className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${color} ${busy ? 'animate-pulse' : ''}`} />
        <span className="text-[12.5px] text-text-muted">Bridge</span>
        {state === 'ok' && mode === 'paper' && (
          <span className="text-[11px] px-1.5 rounded" style={{ background: 'var(--c-1f1a0d)', color: 'var(--c-d29922)', border: '1px solid var(--c-9e6a03)' }}>PAPER</span>
        )}
        <span className="text-[12.5px] text-text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 p-2 rounded-lg border border-bg-border bg-bg-card shadow-lg z-30"
          onMouseLeave={() => setOpen(false)}>
          <div className="px-3 py-1 text-[12px] text-text-muted leading-snug">{busy || note || title}</div>
          {liveLine && <div data-testid="live-line" className="px-3 pb-1 text-[12px] text-text-faint leading-snug">{liveLine}</div>}
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

// Header layout (Nov 2026): three recessed wells — Market, Today, System — each stat a
// small caps label over its value, so the strip reads in columns instead of one run
// of words. With Settings › Glass on the strip is a deep glass bar and the wells are
// grooves cut into it (styles/glass.css: .hdr-well).
export function HdrStat({ label, value, sub, color, testid, title, children }) {
  return (
    <div className="hdr-stat" data-testid={testid} title={title}>
      <span className="hdr-label">{label}</span>
      <span className="hdr-value">
        {children || <span className="mono" style={color ? { color } : undefined}>{value}</span>}
        {sub != null && sub !== '' && <span className="hdr-sub">{sub}</span>}
      </span>
    </div>
  );
}
export function HdrWell({ testid, children, grow = false }) {
  return <div className="hdr-well" data-testid={testid} style={grow ? { flex: '1 1 auto' } : undefined}>{children}</div>;
}

// New York date and time, and where the session stands (Oct 2026). Ticks every
// 15 s; the tooltip gives your own clock alongside.
const CLOCK_TONE = {
  green: { fg: 'var(--c-3fb950)', bg: 'var(--c-0f2417)', border: 'var(--c-238636)' },
  amber: { fg: 'var(--c-e3b341)', bg: 'var(--c-1f1a0d)', border: 'var(--c-9e6a03)' },
  blue: { fg: 'var(--c-58a6ff)', bg: 'var(--c-0c1d36)', border: 'var(--c-1f6feb)' },
  grey: { fg: 'var(--c-a8b2be)', bg: 'var(--c-161b22)', border: 'var(--c-30363d)' },
};
export function NyClock({ stacked = false }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);
  const c = marketClock(now);
  const t = CLOCK_TONE[c.tone] || CLOCK_TONE.grey;
  const local = now.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  if (stacked) {
    return (
      <HdrStat testid="ny-clock" title={`New York ${c.date} ${c.time} · your time ${local}${c.detail ? ' · ' + c.detail : ''}`}
        label={<>New York <span data-testid="ny-status" className="hdr-pill" style={{ color: t.fg, background: t.bg, borderColor: t.border }}>{c.status}</span></>}
        value={c.time} sub={<><span className="hdr-mid">{c.date}</span>{c.detail ? <span className="hdr-wide"> · {c.detail}</span> : null}</>} />
    );
  }
  return (
    <div className="flex items-center gap-2" data-testid="ny-clock" title={`New York ${c.date} ${c.time} · your time ${local}`}>
      <span className="text-[12px] text-text-faint uppercase tracking-wider">NY</span>
      <span className="mono text-sm font-bold text-text">{c.time}</span>
      <span className="text-[12.5px] text-text-muted">{c.date}</span>
      <span data-testid="ny-status" className="text-[11px] font-bold px-1.5 py-0.5 rounded"
        style={{ color: t.fg, background: t.bg, border: `1px solid ${t.border}`, letterSpacing: '0.04em' }}>{c.status}</span>
      <span className="text-[12px] text-text-muted hidden xl:inline">{c.detail}</span>
    </div>
  );
}

// SPX from the live stream (Nov 2026): price, change on the day and how live it is.
export function LivePrice({ symbol = 'SPX', stacked = false }) {
  const q = useLiveQuote(symbol);
  const fresh = useFreshness(q);
  const px = q && (q.mark ?? q.last);
  if (!(px > 0)) return null;
  const chg = q.close > 0 ? (px - q.close) / q.close * 100 : null;
  if (stacked) {
    return (
      <HdrStat testid="live-price" label={<>{symbol} <FreshDot state={fresh} ts={q.ts} /></>}
        value={px.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        sub={chg != null ? <span style={{ color: chg >= 0 ? 'var(--c-3fb950)' : 'var(--c-f85149)' }}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(2)}%</span> : null} />
    );
  }
  return (
    <div className="flex items-center gap-1.5" data-testid="live-price">
      <span className="text-[12px] text-text-faint uppercase tracking-wider">{symbol}</span>
      <span className="mono text-sm font-bold text-text">{px.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      {chg != null && <span className="mono text-[12px]" style={{ color: chg >= 0 ? 'var(--c-3fb950)' : 'var(--c-f85149)' }}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(2)}%</span>}
      <FreshDot state={fresh} ts={q.ts} />
    </div>
  );
}

// Vision chips (Nov 2026): one line each, white ink, colour only in the small pill.
function VisClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 15000); return () => clearInterval(id); }, []);
  const c = marketClock(now);
  const local = now.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <span className="vis-chip" data-testid="ny-clock" title={`New York ${c.date} ${c.time} · your time ${local}${c.detail ? ' · ' + c.detail : ''}`}>
      <span className="vis-chip-label">NY</span>
      <span className="vis-chip-value">{c.time}</span>
      <span data-testid="ny-status" className={`vis-delta ${c.tone === 'green' ? 'up' : c.tone === 'amber' ? 'warn' : ''}`}>{c.status}</span>
    </span>
  );
}
function VisPrice({ symbol }) {
  const q = useLiveQuote(symbol);
  const fresh = useFreshness(q);
  const px = q && (q.mark ?? q.last);
  if (!(px > 0)) return null;
  const chg = q.close > 0 ? (px - q.close) / q.close * 100 : null;
  return (
    <span className="vis-chip" data-testid="live-price">
      <span className="vis-chip-label">{symbol}</span>
      <span className="vis-chip-value">{px.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
      {chg != null && <span className={`vis-delta ${chg >= 0 ? 'up' : 'down'}`}>{chg >= 0 ? '+' : '−'}{Math.abs(chg).toFixed(2)}%</span>}
      <FreshDot state={fresh} ts={q.ts} />
    </span>
  );
}

// What the live stream says, for the bridge menu and its dot.
export function liveSummary(live) {
  if (live.connection === 'off') return '';
  if (live.connection !== 'open') return `Live stream ${live.connection === 'connecting' ? 'connecting…' : 'down' + (live.error ? ': ' + live.error : '')}`;
  const s = live.status || {};
  return `Live stream on · ${s.lines ?? 0} of ${s.maxLines ?? '?'} data lines`
    + (s.refused ? ` · ${s.refused} refused (budget full)` : '')
    + (s.farmOk === false ? ' · TWS lost its data farm' : '');
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

// Vision (Nov 2026): no bar at all — the page title as a large text tab and the
// wells as pills, sitting straight on the shell. A plain div, so the refraction
// filter GlassSurface mounts doesn't paint a bar back in.
function HeaderWrap({ vision, glassOn, children }) {
  if (vision) return <div data-testid="header-strip" className="vis-top hdr-glass">{children}</div>;
  return (
    <GlassSurface data-testid="header-strip" className={glassOn ? 'hdr-glass top-0 z-20' : 'sticky top-0 z-20 bg-bg-card/95 backdrop-blur border-b border-bg-border'}
      glassStyle={{ position: 'sticky', borderRadius: 18, margin: '12px 12px 0 0' }}>
      {children}
    </GlassSurface>
  );
}

export default function HeaderStrip({ authenticated, account, accounts, onAccountChange, onGlobalRefresh, onLogin, title, onOpenEngine }) {
  const visionOn = useVisionOn();
  const glassOn = useGlassOn();
  const [tracker, setTracker] = useState([]);
  const [decisions, setDecisions] = useState([]);
  const [config, setConfig] = useState(null);
  const [lastSynced, setLastSynced] = useState(null);
  const [engineOpen, setEngineOpen] = useState(0);   // open engine tickets (Shadowbook)
  const [engineWorking, setEngineWorking] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetsState, setSheetsState] = useState(authenticated ? 'ok' : 'off');
  const [bridgeState, setBridgeState] = useState('off');
  const bridgeStateRaw = bridgeState;
  const [bridgeBusy, setBridgeBusy] = useState('');
  const [bridgeMode, setBridgeMode] = useState('');
  const [bridgeNote, setBridgeNote] = useState('');
  const [pingTick, setPingTick] = useState(0);
  const [bridgeTitle, setBridgeTitle] = useState('Bridge URL not configured');
  const live = useLiveConnection();

  const loadData = useCallback(() => {
    if (!authenticated) return;
    Promise.all([
      api.getTracker().catch(() => null),
      api.getDecisions().catch(() => []),
      api.getStats(account).catch(() => null),
      Promise.resolve().then(() => api.getOpenPositions(account)).catch(() => null),
    ]).then(([t, d, s, op]) => {
      if (Array.isArray(op)) {
        setEngineOpen(op.filter(r => Number(r.qtyOpen) > 0).length);
        // Working = an order with nothing filled yet; the board lists it too, so say so.
        setEngineWorking(op.filter(r => !(Number(r.qtyOpen) > 0) && !(Number(r.qtyFilled) > 0) && Number(r.qty) > 0).length);
      }
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
    reconnectLiveFeed();
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
  // Open = imported trades still open + Shadowbook tickets with contracts open. It
  // counted the imported tracker alone and read OPEN 0 with two condors on. (Oct 2026.)
  const openCount = filterTracker(tracker, account, accounts).filter(t => t.Status === 'Open').length + engineOpen;
  const maxDailyLoss = Number(config?.maxDailyLoss) || 0;
  const lossUsedPct = maxDailyLoss > 0 && todayPnl < 0
    ? Math.min(100, Math.abs(todayPnl) / maxDailyLoss * 100) : 0;
  const gaugeColor = lossUsedPct >= 80 ? 'bg-red' : lossUsedPct >= 50 ? 'bg-amber' : 'bg-green';

  // Vision (Nov 2026, second pass): the six wells were the busiest thing on screen and
  // not in the design. One slim row instead — the page title as a text tab, then a
  // single glass pill of inline stats, then the account, sync, feeds and theme. Same
  // data, same controls, a third of the height. The row has a frosted backing so the
  // page no longer shows through it when you scroll.
  if (visionOn) {
    const bridgeState = live.connection === 'open' ? (live.status.connected ? 'ok' : 'warn') : bridgeStateRaw;
    return (
      <div data-testid="header-strip" className="vis-top vis-top--compact hdr-glass">
        {title && <div className="vis-title" data-testid="vision-title">{title}</div>}
        <div className="vis-chips" data-testid="header-row">
          <VisClock />
          <VisPrice symbol="SPX" />
          {authenticated && <>
            <span className="vis-chip" data-testid="hdr-pnl" title="Realised P&L today">
              <span className="vis-chip-label">Today</span>
              {todayPnl ? <span className={`vis-delta ${todayPnl > 0 ? 'up' : 'down'}`}>{fmt$(todayPnl)}</span> : <span className="vis-chip-value">{fmt$(0)}</span>}
            </span>
            {maxDailyLoss > 0 && (
              <span className="vis-chip" data-testid="hdr-losscap" title={`Daily loss used: ${fmt$(todayPnl < 0 ? Math.abs(todayPnl) : 0)} of ${fmt$(maxDailyLoss)} cap`}>
                <span className="vis-chip-label">Loss cap</span>
                <span className="vis-meter"><span style={{ width: `${Math.max(lossUsedPct, 3)}%`, background: lossUsedPct >= 80 ? '#ffa39a' : lossUsedPct >= 50 ? '#ffd479' : '#fff' }} /></span>
                <span className="vis-chip-value">{Math.round(lossUsedPct)}%</span>
              </span>
            )}
            <span className="vis-chip" data-testid="hdr-open">
              <span className="vis-chip-label">Open</span><span className="vis-chip-value">{openCount}</span>
              {engineWorking > 0 && <span className="vis-chip-label">· {engineWorking} working</span>}
            </span>
          </>}
          <ScanChip onOpen={onOpenEngine} />
        </div>
        <div className="flex-1" />
        <div className="vis-chips vis-chips--tools" data-testid="hdr-system">
          {authenticated && accounts.length > 0 ? (
            <select value={account} onChange={e => onAccountChange(e.target.value)} className="hdr-select vis-select" aria-label="Account">
              <option value="all">All accounts</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          ) : !authenticated ? (
            <button onClick={onLogin} className="px-3 py-1 bg-accent text-white text-xs font-medium rounded-full">Sign in</button>
          ) : null}
          <button onClick={handleRefresh} className="vis-chip vis-chip-btn" aria-label="Refresh all data"
            title={`Refresh all data${lastSynced ? ' · last synced ' + clockFmt(lastSynced) : ''}`}>
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            <span className="vis-chip-value">{lastSynced ? clockFmt(lastSynced) : '—'}</span>
          </button>
          <span className="vis-chip">
            <StatusDot state={sheetsState} label="DB" title={sheetsState === 'ok' ? 'Database reachable' : sheetsState === 'off' ? 'Not signed in' : 'Database fetch failed'} />
            <BridgeControl state={bridgeState}
              title={live.connection === 'open' && !live.status.connected ? 'Bridge up, TWS not connected — retrying automatically' : bridgeTitle}
              onAction={bridgeAction} busy={bridgeBusy} note={bridgeNote}
              mode={live.connection === 'open' ? (live.status.mode || bridgeMode) : bridgeMode}
              liveLine={liveSummary(live)} />
          </span>
          <ThemeToggle />
        </div>
      </div>
    );
  }

  return (
    <HeaderWrap vision={visionOn} glassOn={glassOn}>
      {visionOn && title && <div className="vis-title" data-testid="vision-title">{title}</div>}
      <div className="hdr-row" data-testid="header-row">
        <HdrWell testid="hdr-market">
          <NyClock stacked />
          <LivePrice symbol="SPX" stacked />
        </HdrWell>

        {authenticated && (
          <HdrWell testid="hdr-today">
            <HdrStat testid="hdr-pnl" label="Today" value={fmt$(todayPnl)} color={pnlColor(todayPnl)} />
            {maxDailyLoss > 0 && (
              <HdrStat testid="hdr-losscap" label="Loss cap" title={`Daily loss used: ${fmt$(todayPnl < 0 ? Math.abs(todayPnl) : 0)} of ${fmt$(maxDailyLoss)} cap`}>
                <span className="hdr-meter"><span className={gaugeColor} style={{ width: `${Math.max(lossUsedPct, 2)}%` }} /></span>
                <span className="mono hdr-sub" style={{ marginLeft: 0 }}>{Math.round(lossUsedPct)}%<span className="hdr-wide"> of {fmt$(maxDailyLoss)}</span></span>
              </HdrStat>
            )}
            <HdrStat testid="hdr-open" label="Open" value={openCount}
              sub={engineWorking > 0 ? <span style={{ color: 'var(--c-bc8cff)' }}>{engineWorking} working</span> : null} />
          </HdrWell>
        )}

        <div className="flex-1" />

        <HdrWell testid="hdr-system">
          {authenticated && accounts.length > 0 ? (
            <HdrStat label="Account">
              <select value={account} onChange={e => onAccountChange(e.target.value)} className="hdr-select" aria-label="Account">
                <option value="all">All accounts</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </HdrStat>
          ) : !authenticated ? (
            <button onClick={onLogin} className="px-3 py-1 bg-accent hover:bg-accent-hover text-white text-xs font-medium rounded-lg transition-colors">
              Sign in
            </button>
          ) : null}
          <HdrStat label="Synced">
            <button onClick={handleRefresh} className="flex items-center gap-1.5 hover:text-text transition-colors"
              title={`Refresh all data${lastSynced ? ' · last synced ' + clockFmt(lastSynced) : ''}`}>
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
              <span className="mono hdr-mid">{lastSynced ? clockFmt(lastSynced) : '—'}</span>
            </button>
          </HdrStat>
          <HdrStat label="Feeds">
            <span className="flex items-center gap-3">
              <StatusDot state={sheetsState} label="DB" title={sheetsState === 'ok' ? 'Database reachable' : sheetsState === 'off' ? 'Not signed in' : 'Database fetch failed'} />
              <BridgeControl
                // The stream knows within a second when TWS drops; the 60 s heartbeat is the fallback.
                state={live.connection === 'open' ? (live.status.connected ? 'ok' : 'warn') : bridgeState}
                title={live.connection === 'open' && !live.status.connected ? 'Bridge up, TWS not connected — retrying automatically' : bridgeTitle}
                onAction={bridgeAction} busy={bridgeBusy} note={bridgeNote}
                mode={live.connection === 'open' ? (live.status.mode || bridgeMode) : bridgeMode}
                liveLine={liveSummary(live)} />
            </span>
          </HdrStat>
          <ThemeToggle />
        </HdrWell>
      </div>
    </HeaderWrap>
  );
}
