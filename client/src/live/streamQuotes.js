// Screens that used to poll the bridge for quotes read the push stream first (Nov 2026).
//
// streamQuotesFor  every leg's quote from the live store in the /api/option-greeks
//                  shape, or null (stream not open, or a leg without a price) — the
//                  caller then asks the bridge as before
// streamPrice      the underlying's price from the store, or null
// useLiveQuotesEvery  the store's quotes, re-read at most every `ms`, for screens that
//                  redo heavy maths on every price (portfolio risk, the board)
import { useEffect, useState } from 'react';
import { liveStore, liveKey, markOf } from './liveStore';
import { liveQuotesFor } from '../engine/manageView';

const open = st => st && st.connection === 'open';

export function streamQuotesFor(underlying, legs, state = liveStore.getState()) {
  if (!open(state) || !Array.isArray(legs) || !legs.length) return null;
  return liveQuotesFor({ underlying, legs }, state.quotes);
}

// A quote older than this while the US market is open is not live (25 Nov 2026: XSP's
// stream line died at 723.72 and the ticket priced off it for 18 hours as "live").
export const STALE_RTH_MS = 10 * 60000;
export function rthOpen(at = new Date()) {
  const et = new Date(at.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = et.getDay(), m = et.getHours() * 60 + et.getMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 + 30 && m < 16 * 60;
}
export function quoteStale(q, at = new Date()) {
  return !!(q && q.ts && rthOpen(at) && at.getTime() - q.ts > STALE_RTH_MS);
}
export function streamPrice(underlying, state = liveStore.getState(), at = new Date()) {
  if (!open(state)) return null;
  const q = state.quotes[liveKey(underlying)];
  if (quoteStale(q, at)) return null;
  const v = q ? (q.mark ?? markOf(q)) : null;
  return v > 0 ? v : null;
}

/** Signed per-share value of the legs held (Σ qty × mid), from a streamQuotesFor reply. */
export function markFromStream(legs, sq) {
  if (!sq || !Array.isArray(sq.legs) || sq.legs.length !== legs.length) return null;
  let m = 0;
  for (let i = 0; i < legs.length; i++) {
    const g = sq.legs[i].greeks;
    const mid = g.bid != null && g.ask != null && g.ask >= g.bid ? (g.bid + g.ask) / 2 : g.optPrice;
    if (mid == null) return null;
    m += (Number(legs[i].qty) || 0) * mid;
  }
  return m;
}

export function useLiveQuotesEvery(ms = 1000) {
  const [snap, setSnap] = useState(() => liveStore.getState());
  useEffect(() => {
    let last = 0, timer = null, seen = liveStore.getState();
    const take = () => { last = Date.now(); timer = null; seen = liveStore.getState(); setSnap(seen); };
    const un = liveStore.subscribe(() => {
      const st = liveStore.getState();
      if (st.quotes === seen.quotes && st.connection === seen.connection) return;
      const wait = ms - (Date.now() - last);
      if (wait <= 0) take();
      else if (!timer) timer = setTimeout(take, wait);
    });
    return () => { un(); clearTimeout(timer); };
  }, [ms]);
  return snap;
}
