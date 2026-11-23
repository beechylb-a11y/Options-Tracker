import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { buildBook, positionRisk } from '../engine/portfolio';
import { tradingSession } from '../engine/session';
import { marketVol, positionVol, bookVol } from '../engine/volWatch';
import { streamQuotesFor, streamPrice, useLiveQuotesEvery } from './streamQuotes';
import { useLiveQuote } from './useLive';

// The volatility watch for the open book (Nov 2026): VIX / VIX1D / VIX3M from the push
// stream, each open position's IV against entry, and the book's vega. The open book
// is fetched once a minute and shared by every screen that asks (banner, Open board,
// Risk page), so three users cost one set of calls.
const cache = new Map();   // account → { at, promise, data }
function loadBase(account) {
  const hit = cache.get(account || 'all');
  if (hit && Date.now() - hit.at < 60000) return hit.promise;
  const safe = (fn, d) => Promise.resolve().then(fn).catch(() => d);
  const promise = Promise.all([
    safe(() => api.getOpenPositions(account), []), safe(() => api.getDecisions(), []),
    safe(() => api.getCloses(), []), safe(() => api.getStats(account), null),
  ]).then(([open, decisions, closes, stats]) => ({ open: Array.isArray(open) ? open : [], decisions: Array.isArray(decisions) ? decisions : [],
    closes: Array.isArray(closes) ? closes : [], netLiq: Number(stats?.config?.currentBankroll) || null }));
  cache.set(account || 'all', { at: Date.now(), promise });
  return promise;
}
export function clearVolWatchCache() { cache.clear(); }

export function useVolWatch(account, { enabled = true } = {}) {
  const [base, setBase] = useState(null);
  const [tick, setTick] = useState(0);
  const stream = useLiveQuotesEvery(5000);
  const vix = useLiveQuote('VIX'), vix1d = useLiveQuote('VIX1D'), vix3m = useLiveQuote('VIX3M');
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    loadBase(account).then(b => { if (!dead) setBase(b); });
    const id = setTimeout(() => setTick(t => t + 1), 60000);
    return () => { dead = true; clearTimeout(id); };
  }, [account, enabled, tick]);
  return useMemo(() => {
    const market = marketVol({ vix, vix1d, vix3m });
    if (!base) return { market, positions: [], book: bookVol([], market, null), byKey: {} };
    const now = new Date();
    const todayYmd = tradingSession(now).yyyymmdd;
    const book = buildBook({ open: base.open, decisions: base.decisions, closes: base.closes, raw: null, todayYmd });
    const positions = [];
    for (const p of book) {
      if (!(p.live > 0) || (p.expiry && p.expiry < todayYmd)) continue;
      const q = p.legs ? streamQuotesFor(p.underlying, p.legs, stream) : null;
      const r = positionRisk(p, q, { now, spotHint: streamPrice(p.underlying, stream) });
      const v = positionVol(r, { market, todayMs: now.getTime() });
      if (v) positions.push(v);
    }
    const byKey = Object.fromEntries(positions.map(v => [v.key, v]));
    return { market, positions, book: bookVol(positions, market, base.netLiq), byKey, netLiq: base.netLiq };
  }, [base, stream, vix, vix1d, vix3m]);
}
