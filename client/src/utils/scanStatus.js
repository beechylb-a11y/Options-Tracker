// Scan progress (Nov 2026). A scan pulls every name through two or three bridge
// calls, two names at a time, and took up to a minute behind one spinning icon —
// nothing said it was still going, how far it had got, or which name it was on.
//
// fetchScanData reports each name's stages here; the Decision Engine, the rail, the
// header and the line across the top of the app all read the same store, so the
// progress shows from any page. Pure helpers below the store are tested.

import { useSyncExternalStore } from 'react';

export const SCAN_STAGES = {
  '0dte': ['Quotes', 'Option chain', 'Straddle'],
  '45dte': ['Quotes', 'Vol surface'],
};
export const STALL_MS = 20000;

/** A fresh progress record for one group. */
export function initProgress({ mode, list, label, master = null, now = Date.now() }) {
  const stages = SCAN_STAGES[mode] || SCAN_STAGES['45dte'];
  const tickers = {};
  for (const u of list || []) tickers[u] = { status: 'queue', stage: -1, since: null, error: null };
  return { running: true, mode, label, master, stages, order: [...(list || [])], tickers, startedAt: now, finishedAt: null, stopped: false, summary: null };
}

/**
 * One event from fetchScanData → the next state (a new object).
 * ev: { u, stage (index), state: 'start' | 'done' | 'error', error?, now? }
 * A name is 'work' while any stage runs, 'done' after its last stage, 'error' if a
 * stage failed (the scan carries on; the engine says why on the row).
 */
export function applyEvent(p, ev) {
  if (!p || !p.tickers[ev.u]) return p;
  const t = { ...p.tickers[ev.u] };
  const last = p.stages.length - 1;
  const now = ev.now ?? Date.now();
  if (ev.state === 'start') { t.status = 'work'; t.stage = ev.stage; t.since = now; }
  else if (ev.state === 'error') { t.status = 'error'; t.stage = ev.stage; t.error = ev.error || 'no answer'; t.since = null; }
  else if (ev.state === 'done') {
    if (t.status === 'error') return p;          // a later stage can't undo a failure
    t.stage = ev.stage; t.since = null;
    t.status = ev.stage >= last ? 'done' : 'work';
  }
  return { ...p, tickers: { ...p.tickers, [ev.u]: t } };
}

/** Stage-units finished / total, the name being worked on, counts and a rough time left. */
export function summarise(p, now = Date.now()) {
  if (!p) return null;
  const n = p.order.length, S = p.stages.length;
  let units = 0, done = 0, err = 0, work = 0;
  let current = null;
  for (const u of p.order) {
    const t = p.tickers[u];
    if (t.status === 'done') { units += S; done++; }
    else if (t.status === 'error') { units += S; err++; }
    else if (t.status === 'work') {
      work++;
      // A running stage counts half.
      units += Math.max(0, t.stage) + 0.5;
      if (!current || (t.since || 0) < (p.tickers[current].since || 0)) current = u;
    }
  }
  const frac = n && S ? Math.min(1, units / (n * S)) : 0;
  const elapsed = Math.max(0, now - p.startedAt);
  const eta = frac > 0.08 && frac < 1 ? Math.round(elapsed * (1 - frac) / frac / 1000) : null;
  const cur = current ? p.tickers[current] : null;
  // With "Scan everything" the bar covers all groups: (group − 1 + this group) / groups.
  const overall = p.master ? Math.min(1, ((p.master.i - 1) + frac) / p.master.n) : frac;
  return {
    n, done, err, work, queue: n - done - err - work, frac, overall, eta,
    position: Math.min(n, done + err + (work ? 1 : 0)),
    current, currentStage: cur && cur.stage >= 0 ? p.stages[cur.stage] : null,
    stalled: !!(cur && cur.since && now - cur.since > STALL_MS),
  };
}

/** "about 40 s left" / "about 2 min left" / '' */
export function etaText(s) {
  if (s == null) return '';
  if (s < 60) return `about ${Math.max(5, Math.round(s / 5) * 5)} s left`;
  return `about ${Math.round(s / 60)} min left`;
}

// ── The store ──
let state = null;           // current or last progress record
const subs = new Set();
const emit = () => subs.forEach(f => f());
export const scanStore = {
  get: () => state,
  set: next => { state = next; emit(); },
  update: fn => { state = fn(state); emit(); },
  clear: () => { state = null; emit(); },
  subscribe: f => { subs.add(f); return () => subs.delete(f); },
};
export function useScanStatus() {
  return useSyncExternalStore(scanStore.subscribe, scanStore.get, scanStore.get);
}

// The running scan's stop control, set by whoever started it.
let stopFn = null;
export const setScanStopper = fn => { stopFn = fn; };
export const stopScan = () => { if (stopFn) stopFn(); };
