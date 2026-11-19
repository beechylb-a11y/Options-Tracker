import { useEffect, useMemo, useState } from 'react';
import { api } from '../utils/api';
import { buildBook, positionRisk } from '../engine/portfolio';
import { tradingSession } from '../engine/session';
import { bookGreeks, spyPriceFrom } from '../engine/greekLimits';
import { streamQuotesFor, streamPrice, useLiveQuotesEvery } from './streamQuotes';

// The open 45DTE book's greeks and the bankroll the limits scale with, for screens
// that aren't the Risk page (the Engine's 45DTE ticket warns when a trade would push
// the book past a band). Legs the push stream prices are valued live; the rest use
// the model at the ticket's entry IV — `modelled` says how many. No TWS calls here:
// the Risk page does the full live pass. (Nov 2026.)
export function useBook45(account, { enabled = true } = {}) {
  const [base, setBase] = useState(null);
  const stream = useLiveQuotesEvery(5000);
  useEffect(() => {
    if (!enabled) return undefined;
    let dead = false;
    // Each call guarded on its own: a missing endpoint (or an older API) gives an
    // empty book, never a broken Engine.
    const safe = (fn, dflt) => Promise.resolve().then(fn).catch(() => dflt);
    Promise.all([
      safe(() => api.getOpenPositions(account), []),
      safe(() => api.getDecisions(), []),
      safe(() => api.getCloses(), []),
      safe(() => api.getStats(account), null),
    ]).then(([open, decisions, closes, stats]) => {
      if (dead) return;
      setBase({ open: Array.isArray(open) ? open : [], decisions: Array.isArray(decisions) ? decisions : [],
        closes: Array.isArray(closes) ? closes : [], netLiq: Number(stats?.config?.currentBankroll) || null });
    });
    return () => { dead = true; };
  }, [account, enabled]);

  return useMemo(() => {
    if (!base) return null;
    const now = new Date();
    const todayYmd = tradingSession(now).yyyymmdd;
    const book = buildBook({ open: base.open, decisions: base.decisions, closes: base.closes, raw: null, todayYmd });
    const risks = [];
    let modelled = 0;
    for (const p of book) {
      if (p.engine !== '45DTE' || (p.expiry && p.expiry < todayYmd)) continue;
      const q = p.legs ? streamQuotesFor(p.underlying, p.legs, stream) : null;
      const r = positionRisk(p, q, { now, spotHint: streamPrice(p.underlying, stream) });
      if (!r || !r.greeks) continue;
      if (r.greeksSource === 'model') modelled++;
      risks.push(r);
    }
    const spx = streamPrice('SPX', stream) || (risks.find(r => r.p.underlying === 'SPX') || {}).spot;
    const g = bookGreeks(risks);
    return { ...g, modelled, netLiq: base.netLiq,
      spyPrice: spyPriceFrom({ spy: streamPrice('SPY', stream), spx, xsp: streamPrice('XSP', stream) }) };
  }, [base, stream]);
}
