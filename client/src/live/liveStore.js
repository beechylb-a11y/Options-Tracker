// ── Live store (Nov 2026) ──
//
// The one place the app keeps live TWS data: underlying and leg quotes, positions,
// working orders and the bridge's state, fed by the bridge's push stream
// (/api/stream, bridge/liveBook.js). Screens read from here instead of each asking the
// bridge for its own price, so two screens can never show different numbers.
//
// Pure: the store, the stream parser and the freshness rule have no network or React
// in them (liveFeed.js connects; useLive.js is the React side).

/** Same key the bridge uses: 'SPX' or 'SPX 20261118 7600 P' (bridge/liveBook.js liveKey). */
export function liveKey(underlying, expiry, strike, right) {
  const u = String(underlying || '').toUpperCase().trim();
  if (!expiry) return u;
  const k = Number(strike);
  const rt = String(right || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  return `${u} ${String(expiry).replace(/-/g, '')} ${Number.isInteger(k) ? k : Math.round(k * 100) / 100} ${rt}`;
}

// ── Freshness ──
// live     a tick arrived recently and the feed is real-time
// frozen   the market is closed: the last value, shown with its time
// delayed  no real-time entitlement — never good enough to place an order on
// stale    market open, but nothing new for STALE_MS, or TWS lost its data farm
// off      no stream from the bridge, or the bridge has no TWS connection
// A quiet far-out-of-the-money leg can go a while without a tick even on a live feed,
// so stale is a minute, not a few seconds.
export const STALE_MS = 60000;
export const FRESHNESS = ['live', 'frozen', 'delayed', 'stale', 'off'];

export function freshnessOf(q, { now = Date.now(), connection = 'open', bridgeConnected = true, farmOk = true, marketOpen = true } = {}) {
  if (connection !== 'open' || !bridgeConnected) return 'off';
  if (!q || !q.ts) return 'off';
  if (q.notEntitled) return 'off';
  if (q.delayed || q.mdType === 3 || q.mdType === 4) return 'delayed';
  if (!marketOpen) return 'frozen';
  if (!farmOk || now - q.ts > STALE_MS) return 'stale';
  return 'live';
}

export const FRESH_LABEL = {
  live: 'Live', frozen: 'Market closed — last value', delayed: 'Delayed — no real-time entitlement',
  stale: 'Stale — no update lately', off: 'Not live',
};

export function ageText(ts, now = Date.now()) {
  if (!ts) return '';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 10) return `${s.toFixed(1)} s ago`;
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Server-Sent Events parser ──
// EventSource can't send headers (the bridge key, ngrok's skip-warning), so the feed
// reads the stream with fetch and parses frames here.
export function createSSEParser(onEvent) {
  let buf = '';
  return function feed(chunk) {
    buf += chunk.replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message', data = '', id = null;
      for (const line of frame.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data += (data ? '\n' : '') + value;
        else if (field === 'id') id = value;
      }
      if (!data) continue;
      let parsed;
      try { parsed = JSON.parse(data); } catch { continue; }
      onEvent(event, parsed, id);
    }
  };
}

// ── Store ──
export function createLiveStore() {
  let state = {
    connection: 'idle',     // idle | connecting | open | down | off (no bridge URL)
    error: '',
    seq: 0,
    lastMessageAt: 0,
    status: {},             // bridge: connected, farmOk, lines, maxLines, refused, positionsReady
    session: {},            // bridge: app, mode, accounts
    quotes: {},
    positions: [],
    orders: [],
  };
  const listeners = new Set();
  const emit = () => { for (const l of listeners) l(); };
  const set = patch => { state = { ...state, ...patch }; emit(); };

  return {
    getState: () => state,
    getQuote: key => state.quotes[key],
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    setConnection(connection, error = '') {
      if (state.connection === connection && state.error === error) return;
      set({ connection, error });
    },
    applySnapshot(d) {
      if (!d) return;
      set({ seq: d.seq || 0, lastMessageAt: Date.now(), status: d.status || {}, session: d.session || state.session,
        quotes: d.quotes || {}, positions: d.positions || [], orders: d.orders || [] });
    },
    applyDelta(d) {
      if (!d) return;
      // Changed quotes become new objects; untouched ones keep their identity, so a
      // screen showing SPX does not re-render for a QQQ tick.
      let quotes = state.quotes;
      const changed = d.quotes && Object.keys(d.quotes).length;
      if (changed || (d.removed && d.removed.length)) {
        quotes = { ...state.quotes, ...(d.quotes || {}) };
        for (const k of d.removed || []) delete quotes[k];
      }
      set({ seq: d.seq || state.seq, lastMessageAt: Date.now(), status: d.status || state.status, quotes,
        positions: d.positions || state.positions, orders: d.orders || state.orders });
    },
    applyPing(d) {
      set({ lastMessageAt: Date.now(), status: (d && d.status) || state.status,
        session: d && d.session ? { ...state.session, ...d.session } : state.session });
    },
  };
}

export const liveStore = createLiveStore();

/** Mid when both sides are real, else last (bridge/liveBook.js markOf). */
export function markOf(q) {
  if (!q) return null;
  if (q.bid != null && q.ask != null && q.ask >= q.bid && q.ask > 0) return Math.round((q.bid + q.ask) * 50) / 100;
  return q.last != null ? q.last : null;
}

/**
 * A combo's market from its legs' live quotes, per share, money in positive (credit +,
 * debit −). legs: [{ key, qty }] qty signed per lot. natural = crossing the spread,
 * far = the other side. Same rule as bridge/liveBook.js comboQuote.
 */
export function comboQuote(legs, quotes) {
  let mid = 0, natural = 0, far = 0, complete = !!(legs && legs.length);
  for (const l of legs || []) {
    const q = quotes && quotes[l.key];
    const m = markOf(q);
    if (!q || m == null || q.bid == null || q.ask == null) { complete = false; continue; }
    mid -= l.qty * m;
    natural -= l.qty * (l.qty > 0 ? q.ask : q.bid);
    far -= l.qty * (l.qty > 0 ? q.bid : q.ask);
  }
  const r2 = v => Math.round(v * 100) / 100;
  return complete ? { mid: r2(mid), natural: r2(natural), far: r2(far), complete } : { mid: null, natural: null, far: null, complete: false };
}
