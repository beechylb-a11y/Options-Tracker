// React side of the live store (Nov 2026). Each hook re-renders only when the piece it
// reads changes: a component showing SPX ignores QQQ ticks.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { liveStore, liveKey, freshnessOf } from './liveStore';
import { watchLegs, unwatchKeys } from './liveFeed';
import { marketClock } from '../engine/marketClock';

const sub = l => liveStore.subscribe(l);

export function useLiveQuote(key) {
  return useSyncExternalStore(sub, () => (key ? liveStore.getQuote(key) : undefined));
}

export function useLiveConnection() {
  const connection = useSyncExternalStore(sub, () => liveStore.getState().connection);
  const error = useSyncExternalStore(sub, () => liveStore.getState().error);
  const status = useSyncExternalStore(sub, () => liveStore.getState().status);
  const session = useSyncExternalStore(sub, () => liveStore.getState().session);
  return { connection, error, status, session };
}

export const useLiveQuotes = () => useSyncExternalStore(sub, () => liveStore.getState().quotes);
export const useLivePositions = () => useSyncExternalStore(sub, () => liveStore.getState().positions);
export const useLiveOrders = () => useSyncExternalStore(sub, () => liveStore.getState().orders);

/** The freshness of one quote, re-checked every few seconds so "stale" appears on its own. */
export function useFreshness(q, everyMs = 5000) {
  const { connection, status } = useLiveConnection();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), everyMs); return () => clearInterval(id); }, [everyMs]);
  const phase = marketClock(new Date(now)).phase;
  return freshnessOf(q, { now, connection, bridgeConnected: status.connected !== false,
    farmOk: status.farmOk !== false, marketOpen: phase === 'open' || phase === 'late' });
}

/**
 * Stream a ticket's legs while the component is on screen: asks the bridge now and
 * every minute (they expire after two), and lets them go when it unmounts.
 *   legs: [{ underlying, expiry 'YYYYMMDD', strike, right, qty }]
 */
export function useLiveWatch(legs, { underlyings = [] } = {}) {
  const sig = JSON.stringify([(legs || []).map(l => [l.underlying, l.expiry, l.strike, l.right, l.qty]), underlyings]);
  const [answer, setAnswer] = useState(null);
  useEffect(() => {
    const clean = (legs || []).filter(l => l && l.underlying && l.expiry && l.strike && l.right);
    if (!clean.length && !underlyings.length) return undefined;
    let dead = false;
    const ask = () => watchLegs(clean, { underlyings }).then(a => { if (!dead && a) setAnswer(a); });
    ask();
    const id = setInterval(ask, 60000);
    return () => { dead = true; clearInterval(id); unwatchKeys(clean.map(l => liveKey(l.underlying, l.expiry, l.strike, l.right))); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);
  return answer;
}

/** Live keys for a ticket's legs, memoised. */
export function useLegKeys(legs) {
  const sig = JSON.stringify((legs || []).map(l => [l.underlying, l.expiry, l.strike, l.right]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (legs || []).map(l => liveKey(l.underlying, l.expiry, l.strike, l.right)), [sig]);
}
