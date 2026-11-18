// ── Live feed (Nov 2026) ──
//
// Keeps one push stream open to the bridge (/api/stream) and pours it into the live
// store. Reconnects on its own with a back-off; if nothing arrives for 40 s (the
// bridge pings every 15 s) the stream is treated as dead and reopened. Uses fetch, not
// EventSource, because the stream has to carry the bridge key (added by the fetch
// wrapper in bridgeAuth.js) and ngrok's skip-warning header.
import { liveStore, createSSEParser } from './liveStore';

const HDR = { 'ngrok-skip-browser-warning': '1', Accept: 'text/event-stream' };
const BACKOFF = [1000, 2000, 5000, 10000, 15000];
const SILENCE_MS = 40000;
const NO_URL_RECHECK_MS = 30000;

let started = false;
let ctrl = null;
let attempt = 0;
let timer = null;
let watchdog = null;

export const bridgeBase = () => {
  try { return (localStorage.getItem('bridgeUrl') || '').replace(/\/+$/, ''); } catch { return ''; }
};

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(connect, ms);
}

async function connect() {
  clearTimeout(timer);
  const base = bridgeBase();
  if (!base) { liveStore.setConnection('off', 'Bridge URL not set'); schedule(NO_URL_RECHECK_MS); return; }
  if (ctrl) { try { ctrl.abort(); } catch { /* already closed */ } }
  ctrl = new AbortController();
  const mine = ctrl;
  liveStore.setConnection('connecting');
  clearInterval(watchdog);
  watchdog = setInterval(() => {
    const last = liveStore.getState().lastMessageAt;
    if (liveStore.getState().connection === 'open' && Date.now() - last > SILENCE_MS) {
      try { mine.abort(); } catch { /* closed */ }
    }
  }, 5000);
  try {
    const res = await fetch(base + '/api/stream', { headers: HDR, signal: mine.signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(res.status === 401 ? 'Bridge key missing or wrong (Settings)' : `HTTP ${res.status}`);
    if (!/event-stream/.test(res.headers.get('content-type') || '')) throw new Error('Bridge has no live stream yet — restart it after the update');
    const parse = createSSEParser((event, data) => {
      if (event === 'snapshot') { liveStore.applySnapshot(data); liveStore.setConnection('open'); attempt = 0; }
      else if (event === 'delta') liveStore.applyDelta(data);
      else if (event === 'ping') liveStore.applyPing(data);
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parse(dec.decode(value, { stream: true }));
    }
    throw new Error('stream ended');
  } catch (e) {
    if (mine !== ctrl) return;                 // superseded by a newer connect()
    const msg = e && e.name === 'AbortError' ? 'no data for 40 s' : (e && e.message) || 'stream failed';
    liveStore.setConnection('down', msg);
    schedule(BACKOFF[Math.min(attempt++, BACKOFF.length - 1)]);
  }
}

/** Start once (main.jsx). Safe to call again. */
export function startLiveFeed() {
  if (started || typeof window === 'undefined' || typeof fetch === 'undefined') return;
  started = true;
  connect();
  // A changed Bridge URL or key in Settings, or the tab waking up: reconnect now.
  window.addEventListener('storage', e => { if (e.key === 'bridgeUrl' || e.key === 'bridgeKey') reconnectLiveFeed(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && liveStore.getState().connection !== 'open') reconnectLiveFeed();
  });
}

export function reconnectLiveFeed() { attempt = 0; connect(); }

/**
 * Ask the bridge to stream these ticket legs (they expire after ttlMs unless asked
 * again). Returns the bridge's answer: { held, refused, combo, note }.
 */
export async function watchLegs(legs, { underlyings = [], ttlMs = 120000 } = {}) {
  const base = bridgeBase();
  if (!base) return null;
  try {
    const r = await fetch(base + '/api/live/watch', {
      method: 'POST', headers: { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ legs, underlyings, ttlMs }),
    });
    return r.ok ? r.json() : null;
  } catch { return null; }
}

export async function unwatchKeys(keys) {
  const base = bridgeBase();
  if (!base || !keys || !keys.length) return;
  try {
    await fetch(base + '/api/live/unwatch', {
      method: 'POST', headers: { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }), keepalive: true,
    });
  } catch { /* best effort: the bridge expires them anyway */ }
}
