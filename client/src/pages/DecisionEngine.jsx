import React, { useState, useEffect, useRef } from 'react';
import { directionBadge } from '../utils/stats';
import { settleShadows } from '../utils/shadowSettle';
import { Zap, Timer, CalendarDays, Radar, Stethoscope, FileText, ListChecks, ChevronDown, ChevronUp, GitCompare, Check, X, DollarSign, Edit3, Clock, Save, MoreHorizontal } from 'lucide-react';
import { bucketTickets, dayPnl } from '../utils/ticketBuckets';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';
import EnginePanel from '../components/EnginePanel';
import WatchlistPanel from '../components/WatchlistPanel';
import { INDEX_SYMBOLS, ETF_SYMBOLS, assetClassOf, loadWatchlist, saveWatchlist, normalise as normaliseWatch, cachedIvr, cachedChains,
  fetchIvr, checkChain, fetchEarnings, rankWatchlist, groupList, DEFAULT_WATCHLIST, WATCH_MAX } from '../utils/watchlist';
import Checkup45 from '../components/Checkup45';
import { trendLabel } from '../engine/trend';
import { SCAN_FIELDS, VOL_SCAN_KEYS, fetchScanData, computeScan, newScanCache } from '../utils/multiScan';
import { loadScans, saveScans } from '../utils/scanStore';
import { scanStore, initProgress, applyEvent, setScanStopper, useScanStatus } from '../utils/scanStatus';
import { ScanPill, ScanBubbles } from '../components/ScanProgress';
import { tradingSession, sessionDateOf, sessionLabelOf, lastSessionDate } from '../engine/session';
import { startCloseVolSnapshot } from '../utils/volSnapshot';
import OrderTicket from '../components/OrderTicket';
import { commissionRate, unitsFromTicket, roundTripCommission } from '../utils/commission';
import { useBook45 } from '../live/useBook45';
import { useAccountSummary } from '../components/CapitalPanel';
import { matchAccount, bpBand } from '../utils/capital';
import { streamPrice, useLiveQuotesEvery } from '../live/streamQuotes';
const TONE_HEX = { green: 'var(--c-3fb950)', amber: 'var(--c-e3b341)', red: 'var(--c-f85149)', blue: 'var(--c-58a6ff)', grey: 'var(--c-8b949e)' };

// ── Trade tabs (Aug 2026) ──
// One mounted EnginePanel per tab, inactive ones hidden with display:none so
// their state survives a switch. Snapshots are kept in a ref and written to
// localStorage so a browser refresh does not lose a half-built ticket.
const TABS_KEY = 'ot-engine-tabs-v1';
// 0DTE inputs go stale overnight; restoring yesterday's numbers under today's
// date would be worse than starting clean.
const TABS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const clockOf = ts => {
  if (!ts) return '';
  const d = new Date(ts);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const agoOf = (ts, now) => {
  if (!ts) return '';
  const t = new Date(ts).getTime();
  if (!isFinite(t)) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  return sec < 60 ? sec + 's ago' : sec < 3600 ? Math.round(sec / 60) + 'm ago' : Math.round(sec / 3600) + 'h ago';
};

// Ticker + expiry. 0DTE expires the day the tab was opened; 45DTE is that day
// plus whatever DTE the panel is carrying.
// Dated by the NEW YORK session the tab was opened for, not the computer's date:
// a tab opened at 02:00 in Melbourne during Monday's session is Monday's. (Oct 2026.)
function tabLabel(mode, underlying, createdAt, dte) {
  const u = underlying || 'SPX';
  const d = new Date(sessionDateOf(new Date(createdAt || Date.now()).toISOString()) + 'T12:00:00');
  if (mode !== '0dte') {
    const n = parseFloat(dte);
    d.setDate(d.getDate() + (isFinite(n) && n > 0 ? Math.round(n) : 45));
  }
  return u + ' ' + d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

// ── Mode identity (Oct 2026) ──
// 0DTE is amber with a timer, 45DTE is blue with a calendar — on the mode
// switch, the multi-scan, its results, its Open buttons, the tab chips and the
// banner over the ticket. A 0DTE scan opened as a 45DTE ticket (the scan kept
// its 0DTE results after the mode was switched) is the mistake this prevents.
export const MODE_UI = {
  '0dte': { short: '0DTE', long: '0DTE \u00b7 expires today', fg: 'var(--c-e3b341)', solid: 'var(--c-d29922)', bg: 'var(--c-1f1a0d)', border: 'var(--c-9e6a03)', Icon: Timer },
  '45dte': { short: '45DTE', long: '45DTE \u00b7 about six weeks', fg: 'var(--c-58a6ff)', solid: 'var(--c-2f81f7)', bg: 'var(--c-0c1d36)', border: 'var(--c-1f6feb)', Icon: CalendarDays },
};
const modeUi = m => MODE_UI[m === '0dte' ? '0dte' : '45dte'];
function ModeBadge({ mode, size = 'sm', testid }) {
  const u = modeUi(mode);
  const big = size === 'lg';
  return (
    <span data-testid={testid} data-mode={mode} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: big ? '3px 9px' : '1px 6px',
      borderRadius: 5, fontSize: big ? 12.5 : 11, fontWeight: 700, letterSpacing: '.02em', color: u.fg, background: u.bg, border: `1px solid ${u.border}` }}>
      <u.Icon size={big ? 13 : 11} /> {u.short}
    </span>
  );
}

// ── Tab groups (Oct 2026): 0DTE / 45DTE × Indices / ETFs / Stocks, 5 tickets each ──
// Indices are cash-settled and European (no assignment, 60/40 tax). ETFs and single
// stocks both trade as shares with assignment and dividend risk, but behave very
// differently (an index-tracking ETF vs one company's earnings), so each gets its own
// group — and its own default scan list.
// The symbol classes live with the watchlist now (Nov 2026); re-exported for old imports.
export { INDEX_SYMBOLS, ETF_SYMBOLS, assetClassOf };
export const TAB_GROUP_MAX = 5;
const CLASS_LABEL = { index: 'Indices', etf: 'ETFs', stock: 'Stocks' };
const CLASS_DEFAULT = { index: 'SPX', etf: 'SPY', stock: 'AAPL' };
// Default scan lists per class (editable per group, remembered in this browser).
export const SCAN_DEFAULTS = { index: ['SPX', 'XSP'], etf: ['SPY', 'QQQ', 'IWM'], stock: ['AAPL', 'NVDA', 'TSLA', 'AMD'] };
export const CLASSES = ['index', 'etf', 'stock'];
export const GROUPS = [['0dte', 'index'], ['0dte', 'etf'], ['0dte', 'stock'], ['45dte', 'index'], ['45dte', 'etf'], ['45dte', 'stock']];
const groupKey = (m, c) => `${m === '0dte' ? '0dte' : '45dte'}|${c}`;
const tabUnd = t => (t && (t.und || (t.seed && t.seed.underlying))) || 'SPX';
export const groupOfTab = t => groupKey(t.mode, assetClassOf(tabUnd(t)));
const SCAN_LISTS_KEY = 'ot-scan-underlyings-v1';
const SCAN_FRESH_MS = 15 * 60 * 1000;            // a scan older than this asks to be re-run

// A ticket nobody has worked on: not from a scan, no fill, no sizing, no structure or
// strike override. These are what used to sit in every group as a blank "SPX" tab;
// they are dropped on load and when a scan opens a ticket in their group.
export function isBlankTab(t, st) {
  if (t.seed && t.seed._scanMode) return false;
  const s = st || t.state;
  if (!s) return true;
  if (s.overrideStrat || (s.overrideStrikes && Object.keys(s.overrideStrikes).length) || s.loggedAt) return false;
  const typed = b => b && ['netCreditDebit', 'win', 'risk', 'pop'].some(k => b[k] !== '' && b[k] != null && parseFloat(b[k]) !== 0);
  return !typed(s.i0) && !typed(s.i45);
}

function newTab(mode, seed) {
  const createdAt = Date.now();
  const und = seed && seed.underlying;
  const id = 'tab' + createdAt + '-' + Math.round(Math.random() * 10000);
  return { id, mode: mode || '0dte', createdAt, seed: seed || null, state: null, und: und || null,
           label: tabLabel(mode || '0dte', und, createdAt, seed && seed.dte) };
}

function loadTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(TABS_KEY) || 'null');
    if (!raw || !Array.isArray(raw.tabs)) return null;
    if (!raw.savedAt || Date.now() - raw.savedAt > TABS_MAX_AGE_MS) return null;
    const tabs = raw.tabs.filter(t => t && t.id && !isBlankTab(t));
    const g = raw.group && GROUPS.some(([m, c]) => groupKey(m, c) === raw.group) ? raw.group : null;
    return { tabs, activeId: raw.activeId && tabs.some(t => t.id === raw.activeId) ? raw.activeId : (tabs[0] ? tabs[0].id : null), group: g };
  } catch (e) { return null; }
}
function loadScanLists() {
  try { return JSON.parse(localStorage.getItem(SCAN_LISTS_KEY)) || {}; } catch (e) { return {}; }
}

export default function DecisionEngine({ authenticated, account, accounts }) {
  // The open 45DTE book against the greek limits, for the tickets' warnings. Rounded
  // so the ticket only re-scores when the book really moves, not on every tick.
  const book45Raw = useBook45(account, { enabled: !!authenticated });
  const book45Key = book45Raw ? [Math.round(book45Raw.theta), Math.round(book45Raw.spxDelta1 / 5), book45Raw.netLiq, Math.round(book45Raw.spyPrice || 0)].join('|') : '';
  const book45 = React.useMemo(() => book45Raw, [book45Key]); // eslint-disable-line react-hooks/exhaustive-deps
  // TWS net liq and margin for the ticket's account → the buying power cap in sizing
  // (Nov 2026). Only when one account is picked and it is linked to a TWS account.
  let bridgeUrlNow = '';
  try { bridgeUrlNow = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
  const summary = useAccountSummary(authenticated ? bridgeUrlNow : '', 60000);
  const vixStream = useLiveQuotesEvery(30000);
  const vixNow = streamPrice('VIX', vixStream);
  const capRec = React.useMemo(() => {
    if (!summary.accounts || !account || account === 'all') return null;
    const hit = Object.entries(summary.accounts).find(([id]) => { const a = matchAccount(id, accounts || []); return a && a.id === account; });
    return hit ? hit[1] : null;
  }, [summary.accounts, account, accounts]);
  const bandHi = bpBand(vixNow).hi;
  const capital = React.useMemo(() => (capRec ? { netLiq: capRec.netLiq, initMargin: capRec.initMargin || 0, vix: vixNow || null } : null),
    [capRec && Math.round(capRec.netLiq / 50), capRec && Math.round((capRec.initMargin || 0) / 50), bandHi]); // eslint-disable-line react-hooks/exhaustive-deps
  const restored = React.useMemo(() => loadTabs(), []);
  // No blank ticket by default (Oct 2026): a group starts empty until a scan opens a
  // ticket or + Trade adds one.
  const [tabs, setTabs] = useState(() => (restored ? restored.tabs : []));
  const [activeId, setActiveId] = useState(() => (restored ? restored.activeId : null));
  // The group on screen is its own state now — a group can be empty.
  const [activeGroup, setActiveGroup] = useState(() => (restored && restored.group)
    || (restored && restored.tabs.find(t => t.id === restored.activeId) ? groupOfTab(restored.tabs.find(t => t.id === restored.activeId)) : groupKey('0dte', 'index')));
  const [groupMode, groupClass] = activeGroup.split('|');
  const mode = groupMode;
  const groupTabs = tabs.filter(t => groupOfTab(t) === activeGroup);
  const activeTab = groupTabs.find(t => t.id === activeId) || groupTabs[0] || null;
  const groupCount = g => tabs.filter(t => groupOfTab(t) === g).length;

  // Live panel state, held in a ref: a keystroke in one tab must not re-render
  // the others. Only the tab LABEL is promoted into React state.
  const panelStateRef = useRef({});
  // Per-tab verdicts, reported up by each panel. Kept out of `tabs` so that a score
  // ticking over cannot rewrite the tab objects (and therefore localStorage) on every
  // keystroke — this is derived, disposable data.
  const [summaries, setSummaries] = useState({});
  function handlePanelSummary(id, sum) {
    setSummaries(prev => {
      const old = prev[id];
      if (old && old.confidence === sum.confidence && old.ready === sum.ready
        && old.blocked === sum.blocked && old.tier === sum.tier
        && old.composite === sum.composite && old.grade === sum.grade) return prev;
      return { ...prev, [id]: sum };
    });
  }

  // Tab order, best first, by composite score, within the group on screen. Ranking
  // only kicks in once EVERY ticket in the group is priced; until then insertion order.
  const rankable = groupTabs.length > 1 && groupTabs.every(t => summaries[t.id] && summaries[t.id].ready);
  const orderedTabs = React.useMemo(() => {
    if (!rankable) return groupTabs;
    return groupTabs.slice().sort((a, b) => {
      const sa = summaries[a.id], sb = summaries[b.id];
      if (sb.composite !== sa.composite) return sb.composite - sa.composite;
      if (sb.confidence !== sa.confidence) return sb.confidence - sa.confidence;
      return a.createdAt - b.createdAt;          // stable for ties
    });
  }, [tabs, summaries, rankable, activeGroup]);
  // Last ticket looked at in each group, so switching groups returns to it.
  const lastInGroup = useRef({});
  if (activeTab) lastInGroup.current[activeGroup] = activeTab.id;

  function handlePanelState(id, st) {
    panelStateRef.current[id] = st;
    setTabs(prev => {
      const i = prev.findIndex(t => t.id === id);
      if (i < 0) return prev;
      const t = prev[i];
      const inp = t.mode === '0dte' ? st.i0 : st.i45;
      const lab = tabLabel(t.mode, inp && inp.underlying, t.createdAt, st.i45 && st.i45.dte);
      const und = (inp && inp.underlying) || t.und || null;
      if (lab === t.label && und === t.und) return prev;
      const next = prev.slice();
      next[i] = { ...t, label: lab, und };
      return next;
    });
  }
  // A ticket whose underlying changes class (typing QQQ into an SPX ticket) moves to
  // that group; the screen follows it.
  // Settle shadow verdicts whose expiry has passed (Oct 2026) — quietly, once per
  // visit, when the bridge is set. Analytics shows the results.
  useEffect(() => {
    if (!authenticated) return;
    const t = setTimeout(() => { settleShadows(account).catch(() => {}); }, 8000);
    return () => clearTimeout(t);
  }, [authenticated, account]);
  useEffect(() => {
    const t = tabs.find(x => x.id === activeId);
    if (t && groupOfTab(t) !== activeGroup && activeTab == null) setActiveGroup(groupOfTab(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  function closeTab(id) {
    const i = tabs.findIndex(t => t.id === id);
    if (i < 0) return;
    const next = tabs.filter(t => t.id !== id);
    delete panelStateRef.current[id];
    if (id === (activeTab && activeTab.id)) {
      const sameGroup = next.filter(t => groupOfTab(t) === activeGroup);
      setActiveId(sameGroup[0] ? sameGroup[0].id : null);
    }
    setTabs(next);
  }
  // A group holds at most TAB_GROUP_MAX tickets; a sixth is refused with a toast
  // rather than closing one you may still be working on.
  function groupFull(m, und, list) {
    const g = groupKey(m, assetClassOf(und || 'SPX'));
    if ((list || tabs).filter(t => groupOfTab(t) === g).length < TAB_GROUP_MAX) return false;
    const [gm, gc] = g.split('|');
    showToast(`${modeUi(gm).short} · ${CLASS_LABEL[gc]} already has ${TAB_GROUP_MAX} tickets — close one first`, 'error');
    return true;
  }
  // opts.dropBlanks: a scan pick clears the untouched tickets in its group first.
  function addTab(seed, m, opts) {
    const mm = m || mode;
    const und = (seed && seed.underlying) || null;
    const g = groupKey(mm, assetClassOf(und || 'SPX'));
    let base = tabs;
    if (opts && opts.dropBlanks) {
      base = tabs.filter(t => !(groupOfTab(t) === g && isBlankTab(t, panelStateRef.current[t.id])));
      tabs.filter(t => !base.includes(t)).forEach(t => { delete panelStateRef.current[t.id]; });
    }
    if (groupFull(mm, und, base)) return null;
    const t = newTab(mm, seed || null);
    setTabs([...base, t]);
    setActiveId(t.id);
    setActiveGroup(g);
    return t;
  }

  // Open a tab that starts from an ALREADY-BUILT panel state rather than a seed.
  // Structure comparison uses it: each compared structure becomes its own tab.
  function addStateTab(state, m, tag) {
    const createdAt = Date.now();
    const mode2 = m || mode;
    const und = (state && (mode2 === '0dte' ? state.i0 : state.i45) && (mode2 === '0dte' ? state.i0 : state.i45).underlying)
      || (state && state.i0 && state.i0.underlying)
      || (state && state.i45 && state.i45.underlying) || null;
    if (groupFull(mode2, und)) return null;
    const t = {
      id: 'tab' + createdAt + '-' + Math.round(Math.random() * 10000),
      mode: mode2, createdAt, seed: null, state: state || null, und,
      label: tabLabel(mode2, und, createdAt, state && state.i45 && state.i45.dte)
             + (tag ? ' \u00b7 ' + tag : '')
    };
    setTabs(prev => [...prev, t]);
    setActiveId(t.id);
    setActiveGroup(groupKey(mode2, assetClassOf(und || 'SPX')));
    return t;
  }

  // Show a group: its last-viewed ticket, or nothing — no blank ticket is made.
  function openGroup(m, c) {
    const g = groupKey(m, c);
    const inGroup = tabs.filter(t => groupOfTab(t) === g);
    const target = inGroup.find(t => t.id === lastInGroup.current[g]) || inGroup[0];
    setActiveGroup(g);
    setActiveId(target ? target.id : null);
  }

  // Show results from the "Scan done" card (from any page): open the group the best
  // result came from and bring its scan panel into view. The request waits in the scan
  // store, so it still works when the card was clicked on another page and the Engine
  // mounts afterwards.
  const showHandled = useRef(null);
  const scanForShow = useScanStatus();
  const showReq = scanForShow && scanForShow.showReq;
  useEffect(() => {
    if (!showReq || showHandled.current === showReq) return;
    showHandled.current = showReq;
    const g = scanForShow.summary && scanForShow.summary.group;
    if (g && g.includes('|')) { const [m, c] = g.split('|'); openGroup(m, c); }
    setPanel('multiscan');   // declared further down; the effect runs after render, so it is set by then
    setTimeout(() => {
      const el = document.querySelector('[data-testid="multiscan"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }, [showReq]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close every ticket in the group on screen. Two-step: the first click arms it.
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!confirmClear) return;
    const h = setTimeout(() => setConfirmClear(false), 4000);
    return () => clearTimeout(h);
  }, [confirmClear]);
  function clearAllTabs() {
    tabs.filter(x => groupOfTab(x) === activeGroup).forEach(x => { delete panelStateRef.current[x.id]; });
    setTabs(tabs.filter(x => groupOfTab(x) !== activeGroup));
    setActiveId(null);
    setConfirmClear(false);
  }

  // Persist on every tab change and on a slow timer (panel edits live in the
  // ref, so they would otherwise never reach storage).
  useEffect(() => {
    const save = () => {
      try {
        localStorage.setItem(TABS_KEY, JSON.stringify({
          savedAt: Date.now(),
          activeId: activeId || null, group: activeGroup,
          tabs: tabs.map(t => ({ id: t.id, mode: t.mode, label: t.label, createdAt: t.createdAt, und: t.und || null,
                                 seed: t.seed, state: panelStateRef.current[t.id] || t.state || null })),
        }));
      } catch (e) { /* private mode / quota — not worth breaking the page over */ }
    };
    save();
    const h = setInterval(save, 5000);
    return () => clearInterval(h);
  }, [tabs, activeId, activeGroup]);

  // ── Scans, per group (Oct 2026) ──
  // Lifted out of the panel so results survive closing it, every group keeps its own,
  // and "Scan everything" can fill all six. { [groupKey]: { results, meta, scannedAt, manualData } }
  // Kept in this browser too (utils/scanStore.js), so leaving the page or refreshing
  // does not lose them; results are recomputed from the stored inputs. (Nov 2026.)
  const [scans, setScans] = useState(() => loadScans());
  useEffect(() => { saveScans(scans); }, [scans]);
  // ── Watchlist (Nov 2026) ──
  // One list in the database drives every scan group: each group scans the names of its
  // asset class that the mode's ranking puts in the top N (utils/watchlist.js). The
  // per-group lists this browser used to keep are folded in once, on first load.
  const [watch, setWatch] = useState(() => ({ ...DEFAULT_WATCHLIST, items: DEFAULT_WATCHLIST.items.map(x => ({ ...x })) }));
  const [wlIvr, setWlIvr] = useState(() => cachedIvr());
  const [wlChain, setWlChain] = useState(() => cachedChains());
  const [wlEarn, setWlEarn] = useState({});
  const [wlIvrBusy, setWlIvrBusy] = useState(false);
  const [wlIvrAt, setWlIvrAt] = useState(null);
  const [wlSave, setWlSave] = useState(null);
  const wlSaveTimer = useRef(null);
  const bridgeOf = () => { try { return localStorage.getItem('bridgeUrl') || ''; } catch (e) { return ''; } };
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    loadWatchlist(loadScanLists()).then(({ list, stored }) => {
      if (!live) return;
      setWatch(list);
      if (!stored) saveWatchlist(list).catch(() => {});
    });
    return () => { live = false; };
  }, [authenticated]);
  function changeWatch(next) {
    const w = normaliseWatch(next) || next;
    setWatch(w);
    setWlSave('saving');
    clearTimeout(wlSaveTimer.current);
    wlSaveTimer.current = setTimeout(() => {
      saveWatchlist(w).then(() => setWlSave('saved')).catch(() => setWlSave('error'));
    }, 600);
  }
  async function refreshIvr(force) {
    const url = bridgeOf();
    const syms = watch.items.filter(x => x.on45).map(x => x.sym);
    if (!url || !syms.length) return;
    setWlIvrBusy(true);
    try {
      setWlIvr(await fetchIvr(url, syms, { force }));
      setWlIvrAt(new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }));
    } catch (e) { if (force) showToast('IVR read failed: ' + e.message, 'error'); }
    setWlIvrBusy(false);
  }
  const wlKey = watch.items.map(x => x.sym + (x.on0 ? '0' : '') + (x.on45 ? '4' : '')).join(',');
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    refreshIvr(false);
    fetchEarnings(watch.items.filter(x => x.on45).map(x => x.sym)).then(m => { if (live) setWlEarn(m); }).catch(() => {});
    // The chain check: once per name per day, one at a time (IBKR pacing).
    const url = bridgeOf();
    if (url) (async () => {
      for (const x of watch.items) {
        if (!live) return;
        if (cachedChains()[x.sym]) continue;
        try { const c = await checkChain(url, x.sym); if (live) setWlChain(prev => ({ ...prev, [x.sym]: c })); } catch (e) { /* bridge down: leave unknown */ }
      }
    })();
    return () => { live = false; };
  }, [authenticated, wlKey]);
  const wlCtx = { ivr: wlIvr, earn: wlEarn, chain: wlChain };
  const rank0 = rankWatchlist('0dte', watch, wlCtx);
  const rank45 = rankWatchlist('45dte', watch, wlCtx);
  const scanLists = Object.fromEntries(GROUPS.map(([m, c]) => [groupKey(m, c), groupList(m === '0dte' ? rank0 : rank45, c)]));
  const [scanBusy, setScanBusy] = useState({});
  const [master, setMaster] = useState(null);       // { i, n, label } while Scan everything runs
  // A scan keeps running when you leave the page; coming back, the store still knows.
  const scanState = useScanStatus();
  const scanRunning = !!(scanState && scanState.running);
  const [scanNow, setScanNow] = useState(() => Date.now());
  useEffect(() => { const h = setInterval(() => setScanNow(Date.now()), 15000); return () => clearInterval(h); }, []);
  // Progress (Nov 2026): every name's stages go to the shared scan store, which the
  // pill, the bubbles, the rail badge, the header chip and the top line all read.
  // Stop aborts between names; a name already asking TWS finishes its call.
  const scanAbort = useRef(null);
  const groupLabelOf = g => { const [m, c] = g.split('|'); return `${CLASS_LABEL[c] || c} · ${modeUi(m).short}`; };
  function finishProgress({ stopped = false, results = [], names = 0, final = true, group = null } = {}) {
    scanStore.update(p => {
      if (!p) return p;
      const secs = Math.max(1, Math.round((Date.now() - (p.firstStartedAt || p.startedAt)) / 1000));
      const best = results.find(r => r && r.result);
      const errs = results.filter(r => r && r.error && !r.noExpiryToday);
      return final ? {
        ...p, running: false, finishedAt: Date.now(), stopped,
        summary: { stopped, names: names || p.order.length, secs,
          best: best ? `${best.underlying} ${best.result.setupScore}/100` : null,
          // The group Show results opens: the best result's (Scan everything), else the one scanned.
          group: (best && best._group) || group,
          needs: errs.length ? `${errs.length} with no data (${errs.slice(0, 2).map(r => r.underlying).join(', ')})` : '' },
      } : p;
    });
  }
  async function runGroupScan(g, cache, typed, opts = {}) {
    const [m] = g.split('|');
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    const own = !opts.signal;                       // a single-group scan owns its stop control
    const ctl = own ? new AbortController() : null;
    if (own) { scanAbort.current = ctl; setScanStopper(() => ctl.abort()); }
    const signal = opts.signal || ctl.signal;
    setScanBusy(b => ({ ...b, [g]: true }));
    let out = { results: [], names: 0 };
    try {
      const list = scanLists[g] || [];
      if (!list.length) {
        setScans(prev => ({ ...prev, [g]: { results: [], meta: {}, scannedAt: new Date().toISOString(), manualData: {}, empty: true, list: [] } }));
        return out;
      }
      const prev = scanStore.get();
      scanStore.set({ ...initProgress({ mode: m, list, label: groupLabelOf(g), master: opts.master || null }),
        firstStartedAt: opts.master && prev && prev.running ? (prev.firstStartedAt || prev.startedAt) : Date.now() });
      const { mergedData, meta, pulledAt } = await fetchScanData({ mode: m, underlyings: list, manualData: typed || {}, bridgeUrl, cache,
        signal, onProgress: ev => scanStore.update(p => applyEvent(p, ev)) });
      const results = computeScan(m, list, mergedData);
      setScans(prev2 => ({ ...prev2, [g]: { results, meta, scannedAt: pulledAt, manualData: mergedData, list } }));
      out = { results, names: list.length };
      if (own) finishProgress({ results, names: list.length, group: g });
    } catch (e) {
      if (e && e.name === 'AbortError') { if (own) finishProgress({ stopped: true, group: g }); out.stopped = true; }
      else { showToast('Scan failed: ' + e.message, 'error'); if (own) scanStore.update(p => (p ? { ...p, running: false } : p)); }
    }
    setScanBusy(b => { const o = { ...b }; delete o[g]; return o; });
    if (own) setScanStopper(null);
    return out;
  }
  async function runAllScans() {
    const cache = newScanCache();
    const ctl = new AbortController();
    scanAbort.current = ctl; setScanStopper(() => ctl.abort());
    const all = []; let names = 0, stopped = false;
    for (let i = 0; i < GROUPS.length; i++) {
      const [m, c] = GROUPS[i];
      setMaster({ i: i + 1, n: GROUPS.length, label: `${modeUi(m).short} · ${CLASS_LABEL[c]}` });
      const r = await runGroupScan(groupKey(m, c), cache, null, { signal: ctl.signal, master: { i: i + 1, n: GROUPS.length } });
      all.push(...(r.results || []).map(x => ({ ...x, _group: groupKey(m, c) }))); names += r.names || 0;
      if (r.stopped || ctl.signal.aborted) { stopped = true; break; }
    }
    setMaster(null);
    setScanStopper(null);
    all.sort((a, b) => (b.result?.setupScore || 0) - (a.result?.setupScore || 0));
    finishProgress({ stopped, results: all, names });
  }
  function recalcGroup(g, manualData) {
    const [m] = g.split('|');
    const list = scanLists[g] || [];
    setScans(prev => ({ ...prev, [g]: { ...(prev[g] || {}), manualData, list, results: computeScan(m, list, manualData),
      scannedAt: (prev[g] && prev[g].scannedAt) || new Date().toISOString(), meta: (prev[g] && prev[g].meta) || {} } }));
  }

  const [decisions, setDecisions] = useState([]);
  const [strategyHistory, setStrategyHistory] = useState(null);
  // Realised capture per engine × strategy (Oct 2026) — the engines blend their
  // assumed capture fractions toward it.
  const [captureStats, setCaptureStats] = useState(null);
  const [panel, setPanel] = useState(null); // 'log' | 'compare' | 'checkup' | 'watchlist' | 'multiscan' | null
  // What is actually on (Nov 2026): the trade log's open positions and working
  // orders, and the closes, for the status strip and the ticket log's tabs.
  const [positions, setPositions] = useState([]);
  const [closesAll, setClosesAll] = useState([]);
  const [logTab, setLogTab] = useState('open');
  const [menu, setMenu] = useState(null);           // 'more' | 'scan' | null
  const [comparison, setComparison] = useState(null);
  const [compLoading, setCompLoading] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState(null);
  const [toast, setToast] = useState(null);

  // SELL ticket (tranches / roll) for an open engine ticket. The Decisions row
  // does not carry what has already been closed, so the Closes tab is read when
  // the ticket opens. { dec, tab, qtyClosed, realised } | null
  const [orderTicket, setOrderTicket] = useState(null);
  async function openOrderTicket(dec, tab) {
    let qtyClosed = 0, realised = 0;
    try {
      const closes = await api.getCloses();
      const mine = (closes || []).filter(c => String(c['Ticket Ref']) === String(dec._rowIndex));
      qtyClosed = mine.reduce((a, c) => a + (parseFloat(c['Qty Closed']) || 0), 0);
      realised = mine.reduce((a, c) => a + (parseFloat(c['P&L ($)']) || 0), 0);
    } catch (e) { /* no Closes read -> treat as nothing closed yet */ }
    setOrderTicket({ dec, tab, qtyClosed, realised });
  }
  const hasEntryPrice = d => { const v = parseFloat(d?.['Net Debit/Credit']); return isFinite(v) && v !== 0; };

  // Close ticket state (quick close -- kept for tickets with no Net Debit/Credit)
  const [closingIdx, setClosingIdx] = useState(null);
  // Close form mirrors the TWS Trades summary: Net Total (before commission), Comm,
  // and the net the app records. Commission pre-fills from the account rate. (Oct 2026.)
  const [closeForm, setCloseForm] = useState({ closeDate: '', closePrice: '', grossPnl: '', fees: '' });
  const estCloseFees = dec => roundTripCommission(
    unitsFromTicket(dec['Wing Strikes'], dec.Strategy),
    parseInt(dec.Contracts) || 1,
    commissionRate((accounts || []).find(a => a.id === (dec.Account || account))));
  // Vol snapshot at close: started when the close form opens (so the bridge has
  // the seconds the user spends typing to answer), read at confirm. Best-effort
  // only — an empty object means blanks in the sheet, never a blocked close.
  const closeSnapRef = useRef({});
  const [reconciling, setReconciling] = useState(false);
  const [reconcileResults, setReconcileResults] = useState(null);

  async function handleReconcile() {
    setReconciling(true);
    setReconcileResults(null);
    try {
      const bridgeUrl = localStorage.getItem('bridgeUrl') || '';
      if (!bridgeUrl) { alert('Set IBKR Bridge URL in Settings first'); setReconciling(false); return; }

      const resp = await fetch(bridgeUrl + '/api/executions', { headers: { 'ngrok-skip-browser-warning': '1' } });
      const data = await resp.json();

      if (!data.fills || data.fills.length === 0) {
        setReconcileResults({ matches: [], unmatchedCount: 0 });
        setReconciling(false);
        return;
      }

      const result = await api.reconcile(data.fills);
      setReconcileResults(result);
    } catch (e) {
      alert('Reconcile failed: ' + e.message);
    }
    setReconciling(false);
  }

  // Notes edit state
  const [editingNotesIdx, setEditingNotesIdx] = useState(null);
  const [notesText, setNotesText] = useState('');
  const [saving, setSaving] = useState(false);


  function loadDecisions() {
    if (!authenticated) return Promise.resolve();
    return api.getDecisions().then(data => {
      if (Array.isArray(data) && data.length > 0) {
        // Check if server returned parsed objects or raw arrays
        if (data[0]._rowIndex !== undefined) {
          // Pre-parsed objects from server
          setDecisions([...data].reverse());
        } else if (Array.isArray(data[0])) {
          // Raw arrays (legacy) — parse manually
          const headers = data[0];
          const rows = data.slice(1).map((row, idx) => {
            const obj = { _rowIndex: idx + 2, _raw: row };
            headers.forEach((h, i) => { obj[h] = row[i] || ''; });
            return obj;
          }).reverse();
          setDecisions(rows);
        }
      }
    }).catch(() => {});
  }

  useEffect(() => { loadDecisions(); }, [authenticated]);
  function loadLive() {
    if (!authenticated) return;
    if (api.getOpenPositions) Promise.resolve().then(() => api.getOpenPositions(account)).then(r => setPositions(Array.isArray(r) ? r : [])).catch(() => setPositions([]));
    if (api.getCloses) Promise.resolve().then(() => api.getCloses(account)).then(r => setClosesAll(Array.isArray(r) ? r : [])).catch(() => setClosesAll([]));
  }
  useEffect(() => { loadLive(); }, [authenticated, account, decisions.length]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const h = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(h); document.removeEventListener('click', close); };
  }, [menu]);

  // Per-strategy realized history powers measured-mode EV. Scoped to the
  // selected account; re-fetched when the account changes.
  useEffect(() => {
    if (!authenticated) return;
    api.getStrategyHistory(account)
      .then(res => setStrategyHistory(res?.history || null))
      .catch(() => setStrategyHistory(null));
    if (api.getCaptureStats) api.getCaptureStats(account)
      .then(res => setCaptureStats(res?.stats || null))
      .catch(() => setCaptureStats(null));
  }, [authenticated, account]);

  // Handle native engine log trade
  // Returns the promise (resolving true only on a confirmed write) so the panel can
  // show its "Logged HH:MM" state on the real outcome rather than on the click. A
  // response without ok — previously silent — now surfaces and resolves false, so the
  // button cannot claim a trade was recorded when it was not.
  function handleEngineLog(data) {
    return api.logDecision(data)
      .then(result => {
        if (result && result.ok) {
          showToast('Trade logged to Shadowbook', 'success');
          loadDecisions();
          return true;
        }
        showToast('Log failed: the sheet did not confirm the write', 'error');
        return false;
      })
      .catch(err => { showToast('Error: ' + err.message, 'error'); return false; });
  }

  function showToast(msg, type) {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  async function handleCloseTicket(dec) {
    setSaving(true);
    try {
      const snap = closeSnapRef.current || {};
      const result = await api.closeTicket(dec._rowIndex, {
        ...closeForm, account: account || '',
        closeVix: snap.closeVix ?? null, closeIV: snap.closeIV ?? null,
        closeUnderlyingPrice: snap.closeUnderlyingPrice ?? null,
        closeVix1d: snap.closeVix1d ?? null,
        sessionHigh: snap.sessionHigh ?? null, sessionLow: snap.sessionLow ?? null
      });
      console.log('[CLOSE TICKET RESULT]', result);
      showToast('Trade ticket closed', 'success');
      setClosingIdx(null);
      setCloseForm({ closeDate: '', closePrice: '', grossPnl: '', fees: '' });
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


  const accountDecisions = (!account || account === 'all') ? decisions : decisions.filter(d => {
    // d.Account is now populated (Account is col 27 in the Decisions header).
    // _raw[26] is a defensive fallback for tickets written before the header existed.
    const decAccount = d.Account || d._raw?.[26] || '';
    return decAccount === account || !decAccount;
  });
  // Open = a position on; Working = sent, nothing filled; Cancelled never counts as open.
  const buckets = bucketTickets(accountDecisions, positions);
  const openTickets = buckets.open;
  const workingTickets = buckets.working;
  const closedTickets = buckets.closed;
  const cancelledTickets = buckets.cancelled;
  const posByRef = new Map(positions.map(p => [String(p.ticketRef), p]));
  const open45 = openTickets.filter(d => /45/.test(String(d.Engine || '')));
  const sessionDay = lastSessionDate();
  const today = dayPnl(closesAll, sessionDay, account);
  const logList = { open: openTickets, working: workingTickets, closed: closedTickets, cancelled: cancelledTickets }[logTab] || openTickets;
  const hasBridge = () => { try { return !!localStorage.getItem('bridgeUrl'); } catch (e) { return false; } };
  function scanThisGroup() {
    if (panel === 'multiscan' && !hasBridge()) { setPanel(null); return; }
    setPanel('multiscan');
    if (hasBridge() && !scanBusy[activeGroup] && !master && !scanRunning) runGroupScan(activeGroup);
  }
  const stratOf = d => { const p = (d.Strategy || '').split(' - '); return p.length > 1 ? p.slice(1, -1).join(' - ') : (d.Strategy || ''); };

  // A scan pick opens its OWN tab and leaves the scan panel up, so you can take
  // one candidate, then another, without losing the first. It opens in the mode
  // the SCAN ran in — never the mode the header happens to show now.
  function handleSelectFromScan(underlying, data, meta, scanMode) {
    const m = scanMode || mode;
    addTab({ underlying, ...(data || {}), _meta: meta || null, _scanMode: m }, m, { dropBlanks: true });
  }

  // The mode switch moves to the same class of group in the other mode.
  function switchMode(m) {
    if (m === mode) return;
    openGroup(m, groupClass);
  }

  return (
    <div className="fade-in">
      {/* Header (Nov 2026): row 1 — where am I (mode + class), what can I do (scan), tools;
          row 2 — what is live (open positions, working orders, today's P&L). The ticket
          log, the TWS reconcile and Engine vs actual live in the ⋯ menu. */}
      <div className="mb-3">
        <h2 className="page-title font-display text-2xl font-bold">Decision Engine</h2>
        <p className="text-text-muted text-sm mt-0.5">Pick a group, scan it, act on what needs you.</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-3" data-testid="header-controls">
        <div className="flex border border-bg-border rounded-lg overflow-hidden" data-testid="mode-switch">
          {['0dte', '45dte'].map(m => {
            const u = modeUi(m), on = mode === m;
            return (
              <button key={m} onClick={() => switchMode(m)} data-testid={'mode-' + m} data-on={on ? '1' : '0'}
                title={on ? `Showing ${u.short} · ${CLASS_LABEL[groupClass]}` : `Show ${u.short} · ${CLASS_LABEL[groupClass]}`}
                className="px-4 py-2 text-sm font-medium transition-colors flex items-center gap-1.5"
                style={on ? { background: u.solid, color: 'var(--c-on-accent)', fontWeight: 700 } : { color: u.fg, background: 'transparent' }}>
                <u.Icon size={14} /> {u.short}
              </button>
            );
          })}
        </div>
        {/* The three groups of this mode. The count is the tickets open in that group. */}
        <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--c-161b22)', border: '1px solid var(--c-30363d)' }} data-testid="tab-groups">
          {['index', 'etf', 'stock'].map(gc => {
            const gm = mode, g = groupKey(gm, gc), n = groupCount(g), on = g === activeGroup, u = modeUi(gm);
            const sc = scans[g];
            const age = sc && sc.scannedAt ? scanNow - new Date(sc.scannedAt).getTime() : null;
            const dot = scanBusy[g] ? 'var(--c-58a6ff)' : age == null ? null : age < SCAN_FRESH_MS ? 'var(--c-3fb950)' : 'var(--c-d29922)';
            const best = sc && sc.results && sc.results[0] && sc.results[0].result ? sc.results[0] : null;
            return (
              <button key={g} data-testid={'group-' + gm + '-' + gc} data-on={on ? '1' : '0'} onClick={() => openGroup(gm, gc)}
                title={`${u.short} · ${CLASS_LABEL[gc]} — ${n} of ${TAB_GROUP_MAX} tickets`
                  + (scanBusy[g] ? ' · scanning…' : age == null ? ' · not scanned yet' : ` · scanned ${clockOf(sc.scannedAt)} (${agoOf(sc.scannedAt, scanNow)})${age >= SCAN_FRESH_MS ? ' — rescan' : ''}${best ? ` · best ${best.underlying} ${best.result.setupScore}/100` : ''}`)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 7, fontSize: 13, fontWeight: on ? 700 : 500,
                  background: on ? u.bg : 'transparent', color: on ? u.fg : 'var(--c-a8b2be)', boxShadow: on ? `inset 0 0 0 1px ${u.border}` : 'none' }}>
                {CLASS_LABEL[gc]}
                {dot && <span data-testid={'scan-dot-' + gm + '-' + gc} style={{ width: 7, height: 7, borderRadius: '50%', background: dot }} />}
                <span className="mono" style={{ fontSize: 11, padding: '0 5px', borderRadius: 4, background: 'var(--c-0d1117)',
                  color: n > TAB_GROUP_MAX ? 'var(--c-f85149)' : n ? (on ? u.fg : 'var(--c-c9d1d9)') : 'var(--c-6e7681)' }}>{n}/{TAB_GROUP_MAX}</span>
              </button>
            );
          })}
        </div>
        <div className="flex-1" />
        {/* Scan: this group, or all six from the caret. */}
        {(scanRunning || master || Object.keys(scanBusy).length > 0) && <ScanPill />}
        <div className="relative flex" data-testid="scan-split" style={(scanRunning || master || Object.keys(scanBusy).length > 0) ? { display: 'none' } : undefined}>
          <button onClick={scanThisGroup} data-testid="multiscan-toggle" disabled={!!master}
            title={`Scan ${modeUi(mode).short} · ${CLASS_LABEL[groupClass]} — ${(scanLists[activeGroup] || []).join(', ') || 'no names'}`}
            className="flex items-center gap-2 px-3 py-2 text-sm font-semibold rounded-l-lg text-white disabled:opacity-60"
            style={{ background: modeUi(mode).bg, border: `1px solid ${modeUi(mode).border}` }}>
            <Radar size={14} className={master || scanBusy[activeGroup] ? 'animate-spin' : ''} />
            {master ? `Scanning ${master.i}/${master.n}…` : `Scan ${modeUi(mode).short} · ${CLASS_LABEL[groupClass]}`}
          </button>
          <button onClick={e => { e.stopPropagation(); setMenu(menu === 'scan' ? null : 'scan'); }} data-testid="scan-menu" aria-label="More scan options"
            className="px-2 py-2 text-sm rounded-r-lg text-white" style={{ background: modeUi(mode).bg, border: `1px solid ${modeUi(mode).border}`, borderLeft: 'none' }}>
            <ChevronDown size={14} />
          </button>
          {menu === 'scan' && (
            <div className="absolute right-0 top-full mt-1 z-30 rounded-lg p-1" style={{ background: 'var(--c-161b22)', border: '1px solid var(--c-30363d)', minWidth: 280, boxShadow: '0 10px 30px rgba(0,0,0,.4)' }}>
              <button onClick={() => { setMenu(null); setPanel('multiscan'); runAllScans(); }} disabled={!!master} data-testid="scan-everything"
                className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-bg-hover flex justify-between gap-3">
                Scan all six groups <span className="text-text-faint text-xs">0DTE + 45DTE</span>
              </button>
            </div>
          )}
        </div>
        <button onClick={() => setPanel(panel === 'watchlist' ? null : 'watchlist')} data-testid="watchlist-toggle"
          title="The names both engines scan — up to 20, top 10 scanned"
          className={`flex items-center gap-2 px-3 py-2 text-sm border rounded-lg transition-colors ${panel === 'watchlist' ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
          <ListChecks size={14} /> Watchlist <span className="mono" style={{ fontSize: 11.5 }}>{watch.items.length}</span>
        </button>
        <div className="relative">
          <button onClick={e => { e.stopPropagation(); setMenu(menu === 'more' ? null : 'more'); }} data-testid="more-menu" aria-label="Ticket log, reconcile, engine vs actual"
            className={`flex items-center px-3 py-2 text-sm border rounded-lg transition-colors ${['log', 'compare'].includes(panel) ? 'border-accent bg-accent/10 text-accent' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}>
            <MoreHorizontal size={16} />
          </button>
          {menu === 'more' && (
            <div className="absolute right-0 top-full mt-1 z-30 rounded-lg p-1" style={{ background: 'var(--c-161b22)', border: '1px solid var(--c-30363d)', minWidth: 320, boxShadow: '0 10px 30px rgba(0,0,0,.4)' }}>
              {[
                ['log-open', <><FileText size={13} /> Ticket log</>, `${accountDecisions.length} · open / working / closed / cancelled`, () => { setPanel('log'); setLogTab('open'); }],
                ['reconcile', <>⚡ Reconcile with TWS</>, 'match today’s fills to tickets', () => { setPanel('log'); setLogTab('open'); handleReconcile(); }],
                ['compare', <><GitCompare size={13} /> Engine vs actual</>, 'moving to Analytics', () => { setPanel('compare'); if (!comparison) loadComparison(); }],
              ].map(([k, label, sub, go]) => (
                <button key={k} data-testid={'menu-' + k} onClick={() => { setMenu(null); go(); }}
                  className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-bg-hover flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2">{label}</span><span className="text-text-faint text-xs">{sub}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Status strip — only what is live. */}
      <div className="flex gap-2 mb-4 flex-wrap items-stretch" data-testid="status-strip">
        <div className="card flex items-center gap-3 flex-wrap" style={{ flex: '1 1 420px', padding: '8px 12px' }}>
          <span className="text-[11px] uppercase tracking-wider font-bold text-text-faint">Open</span>
          {openTickets.length === 0 ? <span className="text-text-faint text-sm">no positions</span>
            : openTickets.slice(0, 4).map(d => {
              const p = posByRef.get(String(d._rowIndex));
              const u = modeUi(/45/.test(String(d.Engine || '')) ? '45dte' : '0dte');
              return (
                <button key={d._rowIndex} data-testid="strip-open" onClick={() => { setPanel('log'); setLogTab('open'); setExpandedIdx(decisions.indexOf(d)); }}
                  className="flex items-center gap-2 text-[13px] px-2 py-1 rounded-md hover:bg-bg-hover" style={{ border: '1px solid var(--c-30363d)' }}
                  title={`Ticket #${d._rowIndex}${p ? ` · ${p.qtyOpen ?? p.qty} open` : ''}`}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: u.solid }} />
                  <b>{d.Underlying}</b> <span className="text-text-muted">{stratOf(d)} {d['Wing Strikes'] || ''}</span>
                  <span className="mono" style={{ fontSize: 10.5, fontWeight: 700, padding: '1px 5px', borderRadius: 4, color: u.fg, background: u.bg }}>{u.short}</span>
                  {p && <span className="mono text-text-faint" style={{ fontSize: 11.5 }}>×{p.qtyOpen ?? p.qty}</span>}
                </button>
              );
            })}
          {openTickets.length > 4 && <span className="text-text-faint text-xs">+{openTickets.length - 4} more</span>}
          <div className="flex-1" />
          <button onClick={() => setPanel(panel === 'checkup' ? null : 'checkup')} data-testid="checkup-toggle"
            title="Hold, take profit, roll or close — a check-up of every open 45DTE position"
            className={`flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg transition-colors ${panel === 'checkup' ? 'text-white' : 'border-bg-border text-text-muted hover:bg-bg-hover'}`}
            style={panel === 'checkup' ? { borderColor: MODE_UI['45dte'].border, background: MODE_UI['45dte'].bg } : undefined}>
            <Stethoscope size={14} /> Check-up
            <span data-testid="checkup-count" style={{ fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5, color: MODE_UI['45dte'].fg,
              background: MODE_UI['45dte'].bg, border: `1px solid ${MODE_UI['45dte'].border}` }}>{open45.length}</span>
          </button>
        </div>
        <div className="card flex items-center gap-2" style={{ padding: '8px 12px' }} data-testid="strip-working">
          <span className="text-[11px] uppercase tracking-wider font-bold text-text-faint">Working</span>
          {workingTickets.length === 0 ? <span className="text-text-faint text-sm">none</span>
            : <button onClick={() => { setPanel('log'); setLogTab('working'); }} className="text-[13px] hover:underline">
                {workingTickets.slice(0, 2).map(d => `${d.Underlying} ${stratOf(d)}`).join(' · ')}{workingTickets.length > 2 ? ` +${workingTickets.length - 2}` : ''}
              </button>}
        </div>
        <div className="card flex items-center gap-2" style={{ padding: '8px 12px' }} data-testid="strip-today"
          title={`Realised P&L of ${today.count} close${today.count === 1 ? '' : 's'} dated ${sessionDay}, after commission`}>
          <span className="text-[11px] uppercase tracking-wider font-bold text-text-faint">{sessionDay === tradingSession().dateISO ? 'Today' : 'Last session'}</span>
          <b className="mono" style={{ fontSize: 16, color: today.count ? pnlColor(today.pnl) : 'var(--c-6e7681)' }}>{today.count ? fmt$(today.pnl) : '$0'}</b>
        </div>
      </div>

      {orderTicket && (
        <OrderTicket
          position={{ ...orderTicket.dec, qtyClosed: orderTicket.qtyClosed, realisedPnl: orderTicket.realised }}
          initialTab={orderTicket.tab}
          onClose={() => setOrderTicket(null)}
          onDone={async () => {
            setOrderTicket(null);
            showToast('Recorded', 'success');
            await new Promise(r => setTimeout(r, 500));
            await loadDecisions();
          }} />
      )}
      {toast && (
        <div className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-lg text-sm font-medium fade-in ${
          toast.type === 'success' ? 'bg-green-bg border border-green text-green' : 'bg-red-bg border border-red text-red'}`}>
          {toast.msg}
        </div>
      )}

      {/* TRADE TICKETS PANEL */}
      {panel === 'log' && (
        <div className="card mb-4 fade-in" style={{ maxHeight: '500px', overflowY: 'auto' }}>
          {/* Ticket log tabs (Nov 2026): sorted by what is true now. Cancelled orders
              have their own tab and never count as open. */}
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <div className="flex gap-1 rounded-lg p-1" style={{ background: 'var(--c-0d1117)', border: '1px solid var(--c-30363d)' }} data-testid="log-tabs">
              {[['open', 'Open', openTickets.length], ['working', 'Working', workingTickets.length], ['closed', 'Closed', closedTickets.length], ['cancelled', 'Cancelled', cancelledTickets.length]].map(([k, label, n]) => (
                <button key={k} data-testid={'log-tab-' + k} data-on={logTab === k ? '1' : '0'} onClick={() => setLogTab(k)}
                  className="flex items-center gap-2 px-3 py-1 rounded-md text-[13px]"
                  style={logTab === k ? { background: 'var(--c-21262d)', color: 'var(--c-e6edf3)', fontWeight: 700 } : { color: 'var(--c-8b949e)' }}>
                  {label} <span className="mono" style={{ fontSize: 11 }}>{n}</span>
                </button>
              ))}
            </div>
            <button onClick={handleReconcile} disabled={reconciling}
              className="text-[12.5px] px-3 py-1 border border-[var(--c-2f81f7)] rounded-lg text-[var(--c-58a6ff)] hover:bg-[var(--c-0d1a2e)] disabled:opacity-50">
              {reconciling ? 'Reconciling...' : '⚡ Reconcile with TWS'}
            </button>
          </div>
          {(logTab === 'open' || logTab === 'working') && (
            <div className="mb-4">
              {logList.length === 0 && <div className="py-4 text-center text-text-faint text-sm">{logTab === 'open' ? 'No open positions.' : 'No orders working.'}</div>}

              {/* Reconcile results */}
              {reconcileResults && (
                <div className="mb-3 p-3 rounded-lg border border-[var(--c-30363d)] bg-[var(--c-0d1117)]">
                  <div className="text-xs text-[var(--c-a8b2be)] mb-2">
                    {reconcileResults.matches.length} matched, {reconcileResults.unmatchedCount} unmatched fills
                  </div>
                  {reconcileResults.matches.map((m, i) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-[var(--c-21262d)] last:border-0">
                      <div>
                        <span className="text-sm text-white font-medium">{m.ticket.underlying}</span>
                        <span className="text-xs text-[var(--c-a8b2be)] ml-2">{m.ticket.strategy}</span>
                        <span className="text-xs text-[var(--c-8b949e)] ml-2">{m.fillCount} fills</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="mono text-sm font-bold" style={{color:m.totalPnl >= 0 ? 'var(--c-3fb950)' : 'var(--c-f85149)'}}
                          title={m.grossPnl != null ? `${fmt$(m.grossPnl)} before commission · ${fmt$(m.totalComm)} commission` : ''}>{fmt$(m.totalPnl)}</span>
                        {m.totalComm > 0 && <span className="mono text-[11.5px] text-text-faint">after {fmt$(m.totalComm)} comm</span>}
                        <button onClick={async () => {
                          try {
                            if (m.ticket.type === 'decision') {
                              // One-click close has no capture window, so start the
                              // bridge vol snapshot now, close immediately, and
                              // backfill the row when the data lands (~14s covers
                              // the chained market-data + greeks fetches). Expiry
                              // for IVx only when this is a same-day (0DTE) ticket;
                              // otherwise price/VIX still arrive, IVx stays blank.
                              const today = lastSessionDate();
                              const snap = startCloseVolSnapshot(m.ticket.underlying,
                                m.ticket.entryDate === today ? { expiry: today } : {});
                              const rowIdx = m.ticket.rowIndex;
                              setTimeout(() => {
                                if (Object.values(snap).some(v => v != null)) {
                                  api.backfillTicketVol(rowIdx, snap).catch(() => {});
                                }
                              }, 14000);
                              await api.closeTicket(m.ticket.rowIndex, {
                                closeDate: lastSessionDate(),
                                grossPnl: m.grossPnl != null ? m.grossPnl : m.totalPnl,
                                fees: m.totalComm,
                                notes: m.pnlBasis === 'ib-realised' ? 'P&L from IBKR realised (after commission); entry commission not itemised' : '',
                                closePrice: '',
                                account: account || ''
                              });
                            } else {
                              await api.closeTrade(m.ticket.rowIndex, {
                                closeDate: lastSessionDate(),
                                closePnl: m.totalPnl.toString(),
                                closePrice: ''
                              });
                            }
                            loadDecisions();
                            setReconcileResults(r => ({
                              ...r,
                              matches: r.matches.filter((_, j) => j !== i)
                            }));
                          } catch (e) { alert('Error: ' + e.message); }
                        }}
                          className="text-[12px] px-2 py-1 bg-[var(--c-238636)] rounded text-white hover:bg-[var(--c-2ea043)] font-semibold">
                          Accept & close
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {logList.map((dec, i) => {
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
                        {dec.Timestamp ? sessionLabelOf(dec.Timestamp) : ''}
                      </span>
                      <span className="text-sm font-medium">{dec.Underlying}</span>
                      <span className="text-xs text-text-muted flex-1">{stratName}</span>
                      {(() => { const b = directionBadge(dec.Direction); return (
                        <span className="text-xs font-medium" style={{ color: TONE_HEX[b.tone] }} title={dec.Direction || ''}>{b.icon} {b.text}</span>); })()}
                      <span className="mono text-xs text-text-faint">{dec['Setup Score']}</span>
                      {expanded ? <ChevronUp size={14} className="text-text-faint" /> : <ChevronDown size={14} className="text-text-faint" />}
                    </div>

                    {expanded && (
                      <div className="px-3 py-3 bg-bg border-t border-bg-border fade-in">
                        <div className="grid grid-cols-3 gap-4 text-sm mb-3">
                          <div className="space-y-1">
                            <div className="text-[12px] text-text-faint uppercase tracking-wider mb-1">Entry details</div>
                            <Row label="Strategy" value={stratName} />
                            <Row label="Direction" value={dec.Direction} />
                            <Row label="Contracts" value={dec.Contracts} />
                            <Row label="Kelly $" value={dec['Kelly $']} />
                            <Row label="POP Margin" value={dec['POP Margin']} />
                            <Row label="Price" value={dec.Price ? '$' + dec.Price : '--'} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[12px] text-text-faint uppercase tracking-wider mb-1">Setup quality</div>
                            <Row label="Score" value={dec['Setup Score']} />
                            <Row label="Grade" value={dec['Setup Grade']} />
                            <Row label="Regime" value={dec.Regime} />
                            <Row label="VIX" value={dec.VIX} />
                            <Row label="IV" value={dec.IV} />
                            <Row label="IVR" value={dec.IVR} />
                          </div>
                          <div className="space-y-1">
                            <div className="text-[12px] text-text-faint uppercase tracking-wider mb-1">Strikes & behaviour</div>
                            <Row label="Strikes" value={dec['Wing Strikes']} />
                            <div className="text-xs text-text-muted italic mt-1">{dec['Market Behaviour']}</div>
                            {dec['Trade Notes'] && (
                              <div className="mt-2 p-2 bg-bg-card rounded text-xs text-text-muted">{dec['Trade Notes']}</div>
                            )}
                          </div>
                        </div>

                        {/* Action buttons */}
                        <div className="flex items-center gap-2 pt-2 border-t border-bg-border">
                          {hasEntryPrice(dec) && (<>
                            <button onClick={(e) => { e.stopPropagation(); openOrderTicket(dec, 'close'); }}
                              title="Sell ticket: close in tranches, with IBKR limit prices"
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
                              style={{ background: 'var(--c-da3633)', color: '#fff' }}>
                              <DollarSign size={12} /> Sell / scale out
                            </button>
{/45/.test(dec.Engine || '') && (
                                                        <button onClick={(e) => { e.stopPropagation(); openOrderTicket(dec, 'roll'); }}
                              title="Roll: close the old legs and open new ones as one combo"
                              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
                              style={{ border: '1px solid var(--c-9e6a03)', color: 'var(--c-d29922)' }}>
                              Roll
                            </button>
                            )}
                          </>)}
                          <button title={hasEntryPrice(dec) ? 'Quick close: type the close price and P&L by hand' : 'This ticket has no Net Debit/Credit, so close it by typing the P&L'}
                            onClick={(e) => { e.stopPropagation(); setClosingIdx(isClosing ? null : globalIdx); setCloseForm({ closeDate: lastSessionDate(), closePrice: '', grossPnl: '', fees: String(estCloseFees(dec)) });
                            closeSnapRef.current = isClosing ? {} : startCloseVolSnapshot(dec.Underlying,
                              { expiry: dec.Engine === '0DTE' ? (dec.Timestamp || '').split('T')[0] : '' }); }}
                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-green-dim hover:bg-green text-white rounded-lg transition-colors">
                            {hasEntryPrice(dec) ? <>Quick close</> : <><DollarSign size={12} /> Close ticket</>}
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
                                <label className="text-[12px] text-text-muted block mb-1">Close date</label>
                                <input type="date" value={closeForm.closeDate} onChange={e => setCloseForm(f => ({ ...f, closeDate: e.target.value }))}
                                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div>
                                <label className="text-[12px] text-text-muted block mb-1">Close price ($)</label>
                                <input type="number" step="0.01" value={closeForm.closePrice} onChange={e => setCloseForm(f => ({ ...f, closePrice: e.target.value }))}
                                  placeholder="e.g. 0.05" className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div>
                                <label className="text-[12px] text-text-muted block mb-1" title="TWS Trades › Summary › Net Total">P&L before commission ($)</label>
                                <input type="number" step="0.01" value={closeForm.grossPnl} onChange={e => setCloseForm(f => ({ ...f, grossPnl: e.target.value }))}
                                  placeholder="TWS Net Total, e.g. -18" className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div>
                                <label className="text-[12px] text-text-muted block mb-1" title="TWS Trades › Summary › Comm — open and close together. Pre-filled from the account rate.">Commission, round trip ($)</label>
                                <input type="number" step="0.01" value={closeForm.fees} onChange={e => setCloseForm(f => ({ ...f, fees: e.target.value }))}
                                  placeholder="TWS Comm" className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                              </div>
                              <div className="col-span-2 flex items-end">
                                {closeForm.grossPnl !== '' && isFinite(parseFloat(closeForm.grossPnl)) && (() => {
                                  const net = parseFloat(closeForm.grossPnl) - (parseFloat(closeForm.fees) || 0);
                                  return <span className="text-xs text-text-muted pb-2">Recorded P&L after commission:{' '}
                                    <b className="mono text-sm" style={{ color: pnlColor(net) }}>{fmt$(net)}</b></span>;
                                })()}
                              </div>
                            </div>
                            <button onClick={() => handleCloseTicket(dec)} disabled={saving || closeForm.grossPnl === ''}
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

          {/* Cancelled — orders that never filled */}
          {logTab === 'cancelled' && (
            <div>
              {cancelledTickets.length === 0 && <div className="py-4 text-center text-text-faint text-sm">No cancelled orders.</div>}
              {cancelledTickets.map(dec => (
                <div key={dec._rowIndex} data-testid="log-cancelled" className="flex items-center gap-3 px-3 py-2 border border-bg-border rounded-lg mb-1 opacity-75">
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--c-6e7681)' }} />
                  <span className="mono text-xs text-text-muted w-10">{dec.Engine}</span>
                  <span className="text-xs text-text-muted mono w-16">{dec.Timestamp ? sessionLabelOf(dec.Timestamp) : ''}</span>
                  <span className="text-sm font-medium">{dec.Underlying}</span>
                  <span className="text-xs text-text-muted flex-1">{stratOf(dec)} {dec['Wing Strikes'] || ''}</span>
                  <span className="text-xs text-text-faint">cancelled · never filled</span>
                </div>
              ))}
            </div>
          )}

          {/* Closed tickets */}
          {logTab === 'closed' && (
            <div>
              {closedTickets.length === 0 && <div className="py-4 text-center text-text-faint text-sm">No closed tickets.</div>}
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
                        {dec.Timestamp ? sessionLabelOf(dec.Timestamp) : ''}
                      </span>
                      <span className="text-sm font-medium">{dec.Underlying}</span>
                      <span className="text-xs text-text-muted flex-1">{stratName}</span>
                      <span className="mono text-sm font-bold" style={{ color: pnlColor(pnl) }}>{fmt$(pnl)}</span>
                      <span className={`badge text-[12px] ${pnl >= 0 ? 'badge-green' : 'badge-red'}`}>{pnl >= 0 ? 'Win' : 'Loss'}</span>
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
                            <div className="text-[12px] text-text-faint uppercase">Actual P&L</div>
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
      {panel === 'checkup' && (
        <Checkup45 tickets={openTickets} />
      )}

      {panel === 'watchlist' && (
        <WatchlistPanel list={watch} onChange={changeWatch} ivr={wlIvr} chain={wlChain} earn={wlEarn} rank0={rank0} rank45={rank45}
          onRefreshIvr={() => refreshIvr(true)} ivrBusy={wlIvrBusy} ivrAsOf={wlIvrAt} bridgeUrl={bridgeOf()} saveState={wlSave}
          onCheck={async sym => { const c = await checkChain(bridgeOf(), sym); setWlChain(prev => ({ ...prev, [sym]: c })); return c; }} />
      )}

      {panel === 'multiscan' && (
        <MultiScanPanel mode={mode} cls={groupClass} classLabel={CLASS_LABEL[groupClass]}
          scan={scans[activeGroup] || null} busy={!!scanBusy[activeGroup]} master={master} now={scanNow}
          underlyings={scanLists[activeGroup] || []} onEditWatchlist={() => setPanel('watchlist')}
          why={(mode === '0dte' ? rank0 : rank45).why}
          onScan={typed => runGroupScan(activeGroup, null, typed)} onScanAll={runAllScans}
          onRecalc={md => recalcGroup(activeGroup, md)}
          otherScans={GROUPS.map(([m, c]) => ({ g: groupKey(m, c), m, c, s: scans[groupKey(m, c)] })).filter(x => x.g !== activeGroup && x.s)}
          onOpenGroup={openGroup} onSelect={handleSelectFromScan} />
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
                <tr className="text-text-faint text-[12px] uppercase tracking-wider">
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
                      <td className="py-2 px-2 text-text-muted mono text-xs">{m.decision.timestamp ? sessionLabelOf(m.decision.timestamp) : ''}</td>
                      <td className="py-2 px-2 font-medium">{m.decision.underlying}</td>
                      <td className="py-2 px-2 text-text-muted text-xs">{engineStrat}</td>
                      <td className="py-2 px-2 text-center">
                        {(() => { const b = directionBadge(m.decision.direction); return (
                          <span className="text-xs font-medium" style={{ color: TONE_HEX[b.tone] }} title={m.decision.direction || ''}>{b.icon}</span>); })()}
                      </td>
                      <td className="py-2 px-2 text-xs">{m.matchedTrade?.strategy || <span className="text-text-faint">--</span>}</td>
                      <td className="py-2 px-2 text-right mono font-medium" style={{ color: m.matchedTrade ? pnlColor(pnl) : 'var(--c-8b949e)' }}>
                        {m.matchedTrade ? fmt$(pnl) : '--'}
                      </td>
                      <td className="py-2 px-2 text-center">
                        {m.matchedTrade?.wl && <span className={`badge text-[12px] ${m.matchedTrade.wl === 'Win' ? 'badge-green' : 'badge-red'}`}>{m.matchedTrade.wl}</span>}
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

      {/* Trade tabs — the active group only */}
      <div className="flex items-center gap-1.5 mb-3 flex-wrap" data-testid="tab-strip">
        {orderedTabs.map((t, i) => {
          const on = t.id === (activeTab && activeTab.id);
          const sum = summaries[t.id];
          const conf = sum && sum.ready ? sum.confidence : null;
          const comp = sum && sum.composite != null ? sum.composite : null;
          // The whole tab takes the banner's colour band for its composite
          // (strong / decent / marginal / weak). Grey until the ticket is priced.
          const tint = sum && sum.ready && sum.bg ? sum : null;
          return (
            <div key={t.id} data-testid="tab" data-tab-id={t.id} onClick={() => setActiveId(t.id)}
              title={(t.seed ? 'Seeded from multi-scan' : 'Manual ticket')
                + (comp != null && tint ? ` \u00b7 Composite ${comp}/100` : '')
                + (conf != null ? ` \u00b7 Trade Confidence ${conf}/100 ${sum.tier}` : '')
                + (sum && sum.blocked ? ' \u00b7 blocked' : '')
                + (rankable ? ` \u00b7 ranked #${i + 1}` : '')}
              data-mode={t.mode}
              style={{ ...(tint ? {
                background: tint.bg, borderColor: tint.border, color: 'var(--c-e6edf3)',
                boxShadow: on ? `0 0 0 2px ${tint.color}` : 'none', opacity: on ? 1 : 0.85
              } : {}), borderLeft: `3px solid ${modeUi(t.mode).solid}` }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs cursor-pointer transition-colors ${tint ? '' : (on ? 'border-accent bg-accent/10 text-white' : 'border-bg-border text-text-muted hover:bg-bg-hover')}`}>
              {rankable && (
                <span className="mono text-[11px] text-text-faint" style={{ minWidth: 12 }}>{i + 1}</span>
              )}
              <span className="font-medium">{t.label}</span>
              {tint && (
                <span className="mono text-[11px]" style={{ color: tint.color, fontWeight: 700 }}>
                  {sum.blocked ? '\u2298 ' : ''}{comp}
                </span>
              )}
              <ModeBadge mode={t.mode} />
              <span onClick={e => { e.stopPropagation(); closeTab(t.id); }} title="Close this ticket"
                className="text-text-faint hover:text-red text-sm leading-none">×</span>
            </div>
          );
        })}
        {groupTabs.length === 0 && (
          <span data-testid="group-empty" className="text-[12.5px] text-text-faint">
            No {modeUi(groupMode).short} · {CLASS_LABEL[groupClass]} tickets —
            {' '}<button onClick={() => setPanel('multiscan')} className="underline" style={{ color: modeUi(groupMode).fg }}>scan this group</button>
            {' '}or add one with + Trade.
          </span>
        )}
        {groupTabs.length > 1 && !rankable && (
          <span className="text-[11px] text-text-faint" title="The composite needs the sizing inputs on every ticket before the tabs can be ordered">
            ranking once all priced
          </span>
        )}
        {(() => {
          const [gm, gc] = activeGroup.split('|');
          const full = groupTabs.length >= TAB_GROUP_MAX;
          return (
            <button data-testid="add-tab" disabled={full}
              onClick={() => addTab(gc === 'index' ? null : { underlying: CLASS_DEFAULT[gc] }, gm)}
              title={full ? `${TAB_GROUP_MAX} tickets is the most for a group — close one first` : `New ${modeUi(gm).short} · ${CLASS_LABEL[gc]} ticket`}
              className="px-2.5 py-1.5 border border-dashed border-bg-border rounded-lg text-xs text-text-faint hover:text-white hover:border-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
              + Trade
            </button>
          );
        })()}
        <button onClick={() => (confirmClear ? clearAllTabs() : setConfirmClear(true))}
          title="Close every ticket in this group"
          className={`ml-auto px-2.5 py-1.5 border rounded-lg text-xs transition-colors ${confirmClear
            ? 'border-red text-red bg-red/10'
            : 'border-bg-border text-text-faint hover:text-white hover:border-red'}`}>
          {confirmClear ? `Clear ${groupTabs.length} here?` : 'Clear group'}
        </button>
      </div>

      {/* Native Decision Engine — one panel per tab, hidden panels stay mounted
          so switching tabs never discards a half-entered ticket. */}
      {tabs.map(t => (
        <div key={t.id} style={{ display: t.id === (activeTab && activeTab.id) ? 'block' : 'none' }}>
          <div data-testid="ticket-mode-banner" data-mode={t.mode}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', marginBottom: 10, borderRadius: 8,
              background: modeUi(t.mode).bg, borderLeft: `4px solid ${modeUi(t.mode).solid}`, fontSize: 12.5, color: 'var(--c-c9d1d9)' }}>
            <ModeBadge mode={t.mode} size="lg" />
            <span style={{ color: modeUi(t.mode).fg, fontWeight: 600 }}>{modeUi(t.mode).long}</span>
            {t.seed && t.seed._scanMode && (
              <span style={{ color: 'var(--c-a8b2be)' }}>
                · from the {modeUi(t.seed._scanMode).short} multi-scan
                {t.seed._meta && t.seed._meta.pulledAt ? ' ' + new Date(t.seed._meta.pulledAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''}
              </span>
            )}
          </div>
          <EnginePanel mode={t.mode} onLogTrade={handleEngineLog} createdAt={t.createdAt} book45={book45} capital={capital}
            accountConfig={accounts?.find(a => a.id === account) || {}}
            strategyHistory={strategyHistory} captureStats={captureStats}
            seed={t.seed} initialState={t.state}
            toast={showToast}
            onOpenInTab={addStateTab}
            onStateChange={st => handlePanelState(t.id, st)}
            onSummary={sum => handlePanelSummary(t.id, sum)} />
        </div>
      ))}
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

// Blank trend cell: say why — an old bridge, or a bridge that returned no daily bars.
const trendMissing = r => r.data?._oldBridge
  ? <span style={{color:'var(--c-d29922)'}} title="Your Bridge predates the 6 Oct update: it sends no daily bars or VIX3M. In the bridge folder: git pull, then restart the bridge.">update Bridge</span>
  : r.data?._noDaily
    ? <span style={{color:'var(--c-d29922)'}} title="The Bridge returned no daily bars for this ticker (TWS historical data request failed or timed out). Scan again.">no daily bars</span>
    : <span style={{color:'var(--c-8b949e)'}}>--</span>;

// What each scan type shows per underlying. The 0DTE rows read today's session;
// none of them means anything six weeks out, so 45DTE gets its own set.
const SCAN_ROWS = {
  '0dte': [
    { label: 'Direction', render: r => <span style={{color: r.result?.dirScore > 0 ? 'var(--c-3fb950)' : r.result?.dirScore < 0 ? 'var(--c-f85149)' : 'var(--c-c9d1d9)'}}>{r.result?.dirLabel || '--'}</span> },
    { label: 'Move consumed', render: r => r.result?.moveConsumed !== undefined ? (r.result.moveConsumed * 100).toFixed(0) + '%' : '--' },
    { label: 'Regime', render: r => <span style={{fontSize:12.5,color:'var(--c-c9d1d9)'}}>{r.result?.regime || '--'}</span> },
    { label: 'Compression', render: r => r.result?.comp != null ? r.result.comp.toFixed(2) : '--' },
    { label: 'Trend', render: r => <span style={{color: r.result?.trendPattern === 'continuation' ? 'var(--c-3fb950)' : r.result?.trendPattern === 'reversal' ? 'var(--c-d29922)' : 'var(--c-c9d1d9)'}}>{r.result?.trendPattern || '--'}</span> },
    { label: 'Short-term trend', render: r => {
      const s = r.result?.slope5;
      const a = r.result?.vwapAccept;
      const e = r.result?.emaTrend;
      const lead = e ? `EMA ${e}` : `${s?.strength || '--'} ${s?.direction && s.direction !== 'unknown' ? '(' + s.direction + ')' : ''}`;
      return <span style={{color: s?.direction === 'rising' ? 'var(--c-3fb950)' : s?.direction === 'falling' ? 'var(--c-f85149)' : 'var(--c-c9d1d9)'}}>{lead}{a == null ? '' : ` · ${(a*100).toFixed(0)}% accept`}{r.result?.confirmed ? ' ✓' : r.result?.diverges ? ' ✗' : ''}</span>;
    }},
  ],
  '45dte': [
    { label: 'IV rank', tip: 'Where today’s IV sits in its 52-week range. Above 30–40 favours selling premium; under 20 favours debit and calendar structures.',
      render: r => {
        const v = parseFloat(r.data?.ivr);
        if (!(v > 0)) return <span style={{color:'var(--c-8b949e)'}}>--</span>;
        const col = v > 40 ? 'var(--c-3fb950)' : v > 20 ? 'var(--c-c9d1d9)' : 'var(--c-d29922)';
        return <span style={{color:col}}>{v.toFixed(0)}% <span style={{fontSize:12,color:'var(--c-a8b2be)'}}>{r.result?.ivrBand || ''}</span></span>;
      }},
    { label: 'IV / HV', tip: 'Implied over 30-day realised. Above 1 the options are paying more than the index has been moving — the edge a premium seller is collecting.',
      render: r => {
        const x = r.result?.ivhvRatio;
        if (!(x > 0)) return <span style={{color:'var(--c-8b949e)'}}>--</span>;
        return <span style={{color: x >= 1.1 ? 'var(--c-3fb950)' : x >= 1 ? 'var(--c-c9d1d9)' : 'var(--c-f85149)'}}>{x.toFixed(2)}× <span style={{fontSize:12,color:'var(--c-a8b2be)'}}>{r.data?.iv}/{r.data?.hv}</span></span>;
      }},
    { label: 'Term', tip: 'Front-month IV against ~90-day IV. Contango (front cheaper) is normal and calm; backwardation means stress now and blocks naked short premium.',
      render: r => {
        const t = r.result?.termBias;
        if (!t) return <span style={{color:'var(--c-8b949e)'}}>--</span>;
        return <span style={{color: t === 'contango' ? 'var(--c-3fb950)' : t === 'backwardation' ? 'var(--c-f85149)' : 'var(--c-c9d1d9)'}}>{t}{r.result?.termRatio ? ` ${(+r.result.termRatio).toFixed(2)}` : ''}</span>;
      }},
    { label: 'Skew 25Δ', tip: 'Put IV minus call IV at 25 delta, in vol points. A steep skew pays more for the put side.',
      render: r => {
        const k = parseFloat(r.data?.skew);
        return isFinite(k) && r.data?.skew !== '' && r.data?.skew != null ? <span>{k > 0 ? '+' : ''}{k.toFixed(1)} pts</span> : <span style={{color:'var(--c-8b949e)'}}>--</span>;
      }},
    { label: 'Move to expiry', tip: 'One standard deviation to a 45-day expiry, from IV: price × IV × √(45/365).',
      render: r => {
        const e = r.result?.em45, p = parseFloat(r.data?.price);
        return e > 0 ? <span>±{e.toFixed(e > 50 ? 0 : 1)} <span style={{fontSize:12,color:'var(--c-a8b2be)'}}>{p > 0 ? (e / p * 100).toFixed(1) + '%' : ''}</span></span> : <span style={{color:'var(--c-8b949e)'}}>--</span>;
      }},
    { label: 'Events', tip: 'Scheduled high-impact releases (FOMC, CPI, jobs) before the 45-day expiry.',
      render: r => {
        const n = r.result?.eventHighCount;
        return n == null ? '--' : <span style={{color: n > 2 ? 'var(--c-d29922)' : 'var(--c-c9d1d9)'}}>{n} high-impact</span>;
      }},
    { label: 'Trend', tip: 'Daily trend: close vs 20- and 50-day averages, the 20-day slope, and ADX(14). Sets the ticket\u2019s outlook. ADX under 20 is a range — neutral, whatever the averages say.',
      render: r => {
        const t = r.data?._trend;
        if (!t) return trendMissing(r);
        const col = t.outlook === 'bullish' ? 'var(--c-3fb950)' : t.outlook === 'bearish' ? 'var(--c-f85149)' : 'var(--c-c9d1d9)';
        return <span style={{color:col}} title={t.why}>{trendLabel(t)}</span>;
      }},
    { label: 'Stretch', tip: 'Distance from the 20-day mean in standard deviations of the last 20 closes. Beyond ±2 a move back toward the mean is common.',
      render: r => {
        const t = r.data?._trend;
        if (!t || t.z20 == null) return trendMissing(r);
        return <span style={{color: t.stretch !== 'normal' ? 'var(--c-d29922)' : 'var(--c-c9d1d9)'}}>{t.z20 > 0 ? '+' : ''}{t.z20.toFixed(1)}σ <span style={{fontSize:12,color:'var(--c-a8b2be)'}}>{t.pctVs20 > 0 ? '+' : ''}{t.pctVs20.toFixed(1)}% vs 20d</span></span>;
      }},
    { label: 'Realised vol', tip: 'HV10 ÷ HV60. Below 0.7 coiled (quiet before a move), above 1.3 expanding (let it settle before selling premium).',
      render: r => {
        const t = r.data?._trend;
        if (!t || t.hvRatio == null) return trendMissing(r);
        return <span style={{color: t.hvRegime !== 'steady' ? 'var(--c-d29922)' : 'var(--c-c9d1d9)'}}>{t.hvRatio.toFixed(2)} <span style={{fontSize:12,color:'var(--c-a8b2be)'}}>{t.hvRegime}</span></span>;
      }},
    { label: 'VIX / VIX3M', tip: 'Above 1 is index backwardation: about the same direction odds, much wider swings. Size down rather than call a direction.',
      render: r => {
        const x = parseFloat(r.data?.vixTermRatio);
        return x > 0 ? <span style={{color: x >= 1 ? 'var(--c-f85149)' : 'var(--c-c9d1d9)'}}>{x.toFixed(2)}</span> : r.data?._oldBridge ? trendMissing(r) : <span style={{color:'var(--c-8b949e)'}}>--</span>;
      }},
    { label: 'Regime', render: r => <span style={{fontSize:12.5,color:'var(--c-c9d1d9)'}}>{r.result?.regime || '--'}</span> },
  ],
};

export function MultiScanPanel({ mode, cls, classLabel, scan, busy, master, now, underlyings, onEditWatchlist, why,
  onScan, onScanAll, onRecalc, otherScans, onOpenGroup, onSelect }) {
  const scanMode = mode === '0dte' ? '0dte' : '45dte';
  const ui = modeUi(scanMode);
  const scanSt = useScanStatus();
  const anyRunning = !!(scanSt && scanSt.running);
  // Only what you TYPE is kept here; everything else comes fresh from each scan. (A
  // rescan used to keep the previous scan's numbers, because fetched values were
  // stored as if typed and typed values win.)
  const [typed, setTyped] = useState({});
  useEffect(() => { setTyped({}); }, [cls, scanMode]);
  const fetched = (scan && scan.manualData) || {};
  const [showInputs, setShowInputs] = useState(false);
  const results = scan ? scan.results : null;
  const scannedAt = scan ? scan.scannedAt : null;
  const scanMeta = (scan && scan.meta) || {};
  const stale = scannedAt && now - new Date(scannedAt).getTime() >= SCAN_FRESH_MS;
  const inputFields = SCAN_FIELDS[scanMode];
  const getVal = (u, k) => typed[u]?.[k] ?? fetched[u]?.[k] ?? '';
  const setVal = (u, k, v) => setTyped(prev => ({ ...prev, [u]: { ...(prev[u] || {}), [k]: v } }));
  const withTyped = () => {
    const out = {};
    new Set([...Object.keys(fetched), ...Object.keys(typed)]).forEach(u => { out[u] = { ...(fetched[u] || {}), ...(typed[u] || {}) }; });
    return out;
  };
  const openMeta = r => scanMeta[r.underlying] || (scannedAt ? { isLive: false, label: 'Multi-scan', asOf: null, pulledAt: scannedAt } : null);

  return (
    <>
    <ScanBubbles />
    <div className="card mb-4 fade-in" data-testid="multiscan" data-mode={scanMode} data-cls={cls}
      style={{ borderColor: ui.border, borderTop: `4px solid ${ui.solid}` }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <ModeBadge mode={scanMode} size="lg" testid="multiscan-mode" /> {classLabel} scan
          </h3>
          <p className="text-xs text-text-muted mt-1">
            {scanMode === '0dte'
              ? 'Today\u2019s session: direction, range used, compression, VWAP — for a same-day trade'
              : 'Volatility and trend: IV rank, IV vs realised, term, skew, daily trend — for a trade about six weeks out'}
          </p>
          {scannedAt && (
            <p className="text-[12.5px] mono mt-1" style={{ color: stale ? 'var(--c-d29922)' : 'var(--c-a8b2be)' }} data-testid="scan-age">
              {ui.short} · {classLabel} scan {clockOf(scannedAt)} · {agoOf(scannedAt, now)}{stale ? ' — rescan' : ''}
            </p>
          )}
          {master && <p className="text-[12.5px] mt-1" style={{ color: 'var(--c-58a6ff)' }}>Scan everything: {master.label} ({master.i}/{master.n})…</p>}
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setShowInputs(!showInputs)}
            className={`px-3 py-2 text-xs border rounded-lg transition-colors ${showInputs ? 'border-accent bg-accent/10 text-accent' : 'border-[var(--c-30363d)] text-[var(--c-a8b2be)] hover:bg-[var(--c-161b22)]'}`}>
            {showInputs ? 'Hide inputs' : 'Show inputs'}
          </button>
          <button onClick={() => onRecalc(withTyped())} disabled={!results}
            className="px-3 py-2 text-xs border border-[var(--c-30363d)] rounded-lg text-[var(--c-a8b2be)] hover:bg-[var(--c-161b22)] disabled:opacity-30">
            Recalculate
          </button>
          <button onClick={() => onScan(typed)} disabled={busy || !!master || anyRunning} data-testid="scan-all"
            title={`Scan ${underlyings.join(', ')} for a ${ui.short} trade`}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
            style={{ background: ui.solid, color: 'var(--c-on-accent)' }}>
            <ui.Icon size={14} className={busy ? 'animate-spin' : ''} />
            {busy ? `Scanning ${classLabel}…` : `Scan ${classLabel} · ${ui.short}`}
          </button>
          <button onClick={onScanAll} disabled={!!master || anyRunning} data-testid="scan-everything-panel"
            title="All six groups: 0DTE and 45DTE × indices, ETFs, stocks"
            className="px-3 py-2 text-xs border border-[var(--c-30363d)] rounded-lg text-[var(--c-c9d1d9)] hover:bg-[var(--c-161b22)] disabled:opacity-50">
            Scan everything
          </button>
        </div>
      </div>

      {otherScans && otherScans.length > 0 && (
        <div data-testid="multiscan-other" className="mb-3 text-[12.5px] flex items-center gap-2 flex-wrap" style={{ color: 'var(--c-a8b2be)' }}>
          Other groups:
          {otherScans.map(o => {
            const best = o.s.results && o.s.results[0] && o.s.results[0].result ? o.s.results[0] : null;
            return (
              <button key={o.g} onClick={() => onOpenGroup(o.m, o.c)} data-testid={'other-' + o.g.replace('|', '-')}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 6, border: `1px solid ${modeUi(o.m).border}`,
                  color: modeUi(o.m).fg, background: modeUi(o.m).bg }}>
                {modeUi(o.m).short} · {CLASS_LABEL[o.c]}{best ? <span className="mono"> · {best.underlying} {best.result.setupScore}</span> : null}
              </button>
            );
          })}
        </div>
      )}

      {/* This group's names — from the watchlist (Nov 2026): the mode's top N, this asset class */}
      <div className="flex gap-2 mb-4 flex-wrap items-center" data-testid="scan-names">
        {underlyings.length ? underlyings.map(u => {
          // The number on a name is its IV rank, said so (Nov 2026): it read as a setup
          // score (QQQ "81" beside a 48/100 setup). The scan's own IV rank wins over the
          // watchlist's cached one, so the chip and the table below agree.
          const row = results && results.find(x => x.underlying === u);
          const scanIvr = row ? parseFloat(row.data && row.data.ivr) : NaN;
          const wlIvr = why && /^IVR/.test(why[u] || '') ? parseFloat(why[u].replace(/^IVR /, '')) : NaN;
          const ivr = scanIvr > 0 ? scanIvr : wlIvr > 0 ? wlIvr : null;
          const src = scanIvr > 0 ? 'from this scan' : 'from the watchlist ranking';
          return (
            <span key={u} data-testid={'scan-name-' + u} title={(ivr != null ? `IV rank ${Math.round(ivr)}%, ${src}` : '') + (why && why[u] ? ` · ${why[u]}` : '')}
              className="mono" style={{ padding: '3px 9px', borderRadius: 7, fontSize: 13, fontWeight: 700,
              color: 'var(--c-ffffff)', border: `1px solid ${ui.border}`, background: ui.bg }}>{u}
              {ivr != null && <span style={{ fontSize: 11, fontWeight: 600, color: ui.fg }}> IVR {Math.round(ivr)}</span>}</span>
          );
        }) : <span className="text-xs" style={{ color: 'var(--c-8b949e)' }}>No {classLabel.toLowerCase()} in the {ui.short} top list.</span>}
        <button onClick={onEditWatchlist} data-testid="edit-watchlist" className="px-2 py-1 text-xs underline" style={{ color: 'var(--c-8b949e)' }}>edit watchlist</button>
      </div>

      {showInputs && (
        <div className="mb-4 overflow-x-auto fade-in">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[11px] text-[var(--c-a8b2be)] uppercase tracking-wider">
                <th className="text-left py-1 px-1 w-28">{ui.short} input</th>
                {underlyings.map((u, i) => <th key={i} className="text-center py-1 px-1 text-white text-sm font-bold">{u}</th>)}
              </tr>
            </thead>
            <tbody>
              {inputFields.map(f => (
                <tr key={f.key} className="border-t border-[var(--c-21262d)]">
                  <td className="py-1 px-1 text-[var(--c-a8b2be)] text-[12px]">{f.label}</td>
                  {underlyings.map((u, i) => (
                    <td key={i} className="py-1 px-1">
                      <input type="number" step="any" value={getVal(u, f.key)} onChange={e => setVal(u, f.key, e.target.value)} placeholder="—"
                        className="w-full px-2 py-1 bg-[var(--c-0d1117)] border border-[var(--c-21262d)] rounded text-[12.5px] text-white mono outline-none focus:border-[var(--c-2f81f7)] text-center" />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="scan-results" data-mode={scanMode} data-cls={cls}>
            <thead>
              <tr className="text-[12px] text-[var(--c-a8b2be)] uppercase tracking-wider">
                <th className="text-left py-2 px-2"><ModeBadge mode={scanMode} /></th>
                {results.map((r, i) => (
                  <th key={i} className="text-center py-2 px-3" style={{minWidth:140}}>
                    <span className="text-white text-sm font-bold">{r.underlying}</span>
                    {i === 0 && r.result && r.result.setupScore > 0 && <span className="ml-1.5 text-[11px] px-1.5 py-0.5 rounded bg-green/10 text-green font-semibold">BEST</span>}
                    {scanMeta[r.underlying] && (
                      <div className="text-[11px] mono font-normal mt-0.5 normal-case tracking-normal"
                        style={{ color: scanMeta[r.underlying].isLive ? 'var(--c-3fb950)' : 'var(--c-a8b2be)' }}
                        title={scanMeta[r.underlying].label + (scanMeta[r.underlying].asOf ? ' · quote ' + clockOf(scanMeta[r.underlying].asOf) : '')}>
                        {scanMeta[r.underlying].isLive ? '● live' : '○ close'} {clockOf(scanMeta[r.underlying].pulledAt)}
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { label: 'Strategy', render: r => r.error
                    ? <span data-testid="scan-error" style={{ color: 'var(--c-f85149)', fontSize: 12.5 }}>{r.error}</span>
                    : <>{r.result?.legStrat || r.result?.bestStrat || '--'}
                        {r.data?._volError && <div data-testid="scan-vol-error" style={{ color: 'var(--c-d29922)', fontSize: 11.5, fontWeight: 400 }}>vol surface: {r.data._volError}</div>}</> },
                { label: 'Setup score', render: r => {
                  const sc = r.result?.setupScore || 0;
                  const col = sc >= 85 ? 'var(--c-3fb950)' : sc >= 70 ? 'var(--c-2f81f7)' : sc >= 50 ? 'var(--c-d29922)' : 'var(--c-f85149)';
                  return <span style={{color:col}}>{sc}/100 <span style={{fontSize:12,fontWeight:400}}>{r.result?.setup||''}</span></span>;
                }},
                ...SCAN_ROWS[scanMode],
                { label: 'Price', render: r => r.data?.price || '--' },
                { label: 'VIX', render: r => r.data?.vix || '--' },
                { label: 'Decision', render: r => {
                  const d = r.result?.decision || '--';
                  const col = d === 'Trade' ? 'var(--c-3fb950)' : d === 'Trade with caution' ? 'var(--c-d29922)' : 'var(--c-f85149)';
                  return <span style={{color:col,fontWeight:700}}>{d}</span>;
                }},
                { label: '', render: r => {
                  if (!r.result || !r.data?.price) return null;
                  return <button data-testid="scan-open" data-mode={scanMode}
                    onClick={(e) => { e.stopPropagation(); onSelect && onSelect(r.underlying, r.data, openMeta(r), scanMode); }}
                    title={`Opens a ${ui.short} ticket for ${r.underlying}`}
                    style={{display:'inline-flex',alignItems:'center',gap:5,padding:'4px 10px',borderRadius:6,border:`1px solid ${ui.border}`,
                      background:ui.bg,color:ui.fg,fontSize:12.5,fontWeight:700,cursor:'pointer'}}>
                    <ui.Icon size={12} /> Open {ui.short} →
                  </button>;
                }},
              ].map((row, ri) => (
                <tr key={ri} className="border-t border-[var(--c-21262d)]">
                  <td className="py-2 px-2 text-[var(--c-a8b2be)]" title={row.tip || undefined}
                    style={row.tip ? { textDecoration: 'underline dotted var(--c-484f58)', textUnderlineOffset: 3, cursor: 'help' } : undefined}>{row.label}</td>
                  {results.map((r, i) => <td key={i} className="py-2 px-3 text-center mono text-xs">{row.render(r)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!results && !busy && (
        <div className="py-8 text-center text-[var(--c-8b949e)] text-sm">
          “Scan {classLabel} · {ui.short}” scans {underlyings.join(', ')} — or “Scan everything” for all six groups. “Show inputs” to enter values by hand.
        </div>
      )}
    </div>
    </>
  );
}

function Stat({ label, value, cls }) {
  return (
    <div className="text-center">
      <div className="text-[12px] text-text-faint uppercase">{label}</div>
      <div className={`text-sm font-bold mono ${cls || ''}`}>{value}</div>
    </div>
  );
}
