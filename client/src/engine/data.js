// ================================================================
//  DECISION ENGINE — SHARED DATA
//  Strategy arrays, ratings matrices, market behaviour lookups
// ================================================================

export const SQRT252 = Math.sqrt(252);

// ── Execution frictions ──────────────────────────────────────────────────────
// Spread plus commission as a share of MAX PROFIT.
//
// Every other gauge on the ticket asks whether the trade is likely to WIN. This
// one asks whether winning is worth anything after you have paid to get in and
// out, and it is the only measure that separates a thin structure from a good
// one BEFORE the market has an opinion. Four 0DTE candidates on 2-3 Sep 2026 all
// finished green and looked interchangeable on outcome; on this number they were
// not close - two call flies at 5-7%, a deep-ITM bull call at 22% and an iron
// condor at 29%, with the condor holding the HIGHEST probability of the four
// (82%) and the widest cushion (1.35x EM). A payoff that thin is not a
// probability problem and no POP repairs it.
//
// Round trip, because you pay the spread twice: crossing a ROUND_TRIP_SPREADS
// multiple of the quoted width, plus commission on every leg both ways.
// Denominator is max profit per contract - the checkable number a trader already
// has in front of them, not a capture-adjusted estimate.
//
// Defaults are IBKR tiered US equity options (~$0.65/contract/side). Override
// commissionPerContract per account if that is wrong for you. (Sep 2026.)
export const FRICTION_DEFAULTS = { commissionPerContract: 0.65, roundTripSpreads: 1.0 };

// bid/ask of a COMBO from its per-leg quotes: buying pays the ask on longs and
// receives the bid on shorts, and the reverse for the side you sell out on.
// Reproduces the TWS combo quote to the cent on flies, verticals and condors.
export function comboQuote(legs) {
  if (!Array.isArray(legs) || !legs.length) return null;
  let bid = 0, ask = 0;
  const num = x => (x === null || x === undefined || x === '' || Number.isNaN(Number(x)))
    ? null : Number(x);   // Number(null) is 0, so a missing quote must be rejected first
  for (const l of legs) {
    const q = num(l.qty), b = num(l.bid), a = num(l.ask);
    if (q === null || b === null || a === null || !isFinite(q) || !isFinite(b)
        || !isFinite(a) || q === 0) return null;
    ask += q > 0 ? q * a : q * b;
    bid += q > 0 ? q * b : q * a;
  }
  return { bid: +bid.toFixed(2), ask: +ask.toFixed(2) };
}

// win = max profit per contract in DOLLARS. legCount = number of option legs.
// Returns null when the combo quote is unknown - the gauge reads "not available"
// rather than inventing a spread.
export function computeFrictions({ comboBid, comboAsk, win, legCount, contracts = 1, opts = {} }) {
  const cfg = { ...FRICTION_DEFAULTS, ...opts };
  const ok = x => !(x === null || x === undefined || x === '' || Number.isNaN(Number(x)));
  if (!ok(comboBid) || !ok(comboAsk)) return null;
  const b = Number(comboBid), a = Number(comboAsk);
  if (!isFinite(b) || !isFinite(a) || !(win > 0) || !(legCount > 0)) return null;
  const width = Math.abs(a - b);
  if (!isFinite(width)) return null;
  const spread$ = width * 100 * cfg.roundTripSpreads;          // per contract, round trip
  const commission$ = cfg.commissionPerContract * legCount * 2; // both ways
  const total$ = spread$ + commission$;
  const pct = total$ / win;
  const signal = pct < 0.05 ? 'clean' : pct < 0.10 ? 'acceptable'
    : pct < 0.20 ? 'heavy' : 'prohibitive';
  const action = pct < 0.05 ? 'Execution is not a factor in this trade'
    : pct < 0.10 ? 'Normal cost of doing business - worth a limit order, not a worry'
    : pct < 0.20 ? 'Getting in and out costs a meaningful slice of the best case - work the fill or widen the structure'
    : 'The payoff is too thin to survive its own execution. Probability does not fix this - pick a structure with more to win.';
  return {
    comboBid: +b.toFixed(2), comboAsk: +a.toFixed(2), spreadWidth: +width.toFixed(2),
    // Exact dollars; the UI rounds. Rounding here and again at contract scale
    // made "$10 each, $99 for ten" — arithmetic the reader has to forgive.
    spreadCost: spread$, commission: commission$, total: total$,
    totalAll: total$ * (contracts || 1),
    pct, signal, action, legCount
  };
}

export const STRATS_0DTE = [
  'Chicken condor', 'Broken wing butterfly', 'Asymmetric butterfly',
  'Standard butterfly', 'Iron Condor - Normal', 'Long Condor - Reversed',
  'Iron butterfly', 'Bull put spread', 'Bear call spread',
  'Bull call spread', 'Bear put spread'
];

export const STRATS_45DTE = [
  'Iron Condor - Normal', 'Credit spread', 'Calendar spread',
  'Diagonal spread', 'Broken wing butterfly', 'Jade lizard',
  'Ratio spread', 'Bull call spread', 'Bear put spread',
  'Iron butterfly', 'Standard butterfly'
];

// ── Profit locus (Jul 2026) ──
// WHERE a structure makes its money, which is not the same question as what shape
// its risk is:
//   'pin'    price stops at the body            (flies, iron fly, calendars)
//   'range'  price stays inside a band          (condors, credit spreads)
//   'move'   price travels                      (debit verticals, reversed condor)
// A broken wing butterfly is asymmetric in where its RISK sits and is still a pin:
// it needs price to stop. Treating asymmetry as directionality is what let a
// strong directional read promote a pin structure. Risk shape decides which SIDE
// of a chosen structure carries the risk; it never decides the class.
export const PROFIT_LOCUS = {
  'Chicken condor':          'range',
  'Broken wing butterfly':   'pin',
  'Asymmetric butterfly':    'pin',
  'Standard butterfly':      'pin',
  'Iron Condor - Normal':    'range',
  'Long Condor - Reversed':  'move',
  'Iron butterfly':          'pin',
  'Bull put spread':         'range',
  'Bear call spread':        'range',
  'Bull call spread':        'move',
  'Bear put spread':         'move',
  // 45DTE-only names
  'Credit spread':           'range',
  'Calendar spread':         'pin',
  'Diagonal spread':         'pin',
  'Jade lizard':             'range',
  'Ratio spread':            'range',
};

// Single source of truth for whether a strategy is a net CREDIT (you collect
// premium) or net DEBIT (you pay). 'varies' = depends on how it's structured;
// resolve from the ticket's net credit/debit at runtime.
export const STRATEGY_CASH_TYPE = {
  'Iron Condor - Normal':   'credit',
  'Iron butterfly':         'credit',
  'Bull put spread':        'credit',
  'Bear call spread':       'credit',
  'Credit spread':          'credit',
  'Chicken condor':         'credit',
  'Jade lizard':            'credit',
  'Standard butterfly':     'debit',
  'Asymmetric butterfly':   'debit',
  'Long Condor - Reversed': 'debit',
  'Bull call spread':       'debit',
  'Bear put spread':        'debit',
  'Calendar spread':        'debit',
  'Diagonal spread':        'debit',
  'Broken wing butterfly':  'varies', // credit or small debit by wing width
  'Ratio spread':           'varies'  // front-ratio credit / back-ratio debit
};

// Resolve the effective type for a strategy given the ticket's net credit/debit.
// netCreditDebit: positive = credit received, negative = debit paid, 0/blank = unknown.
// Returns 'credit' | 'debit' | 'varies' (varies only when no net is available yet).
export function resolveCashType(strategy, netCreditDebit) {
  const base = STRATEGY_CASH_TYPE[strategy] || 'varies';
  if (base !== 'varies') return base;
  const n = parseFloat(netCreditDebit);
  if (!isNaN(n) && n !== 0) return n > 0 ? 'credit' : 'debit';
  return 'varies';
}

export const REGIME_CONDS = {
  'RM < 25%':          'Move from open < 25% EM — pinning not developed — trend can still build',
  'RM 25-50%':         'Move 25-50% EM — neutral zone — market has room, need additional signals',
  'RM 50-75%':         'Move 50-75% EM — beginning to exhaust — mean reversion probability rising',
  'RM 75-100%':        'Move 75-100% EM — most movement consumed — entering stabilization zone',
  'RM >100% compress': 'EM exceeded + compression — VWAP flattening, ATR compressing, volume fading',
  'RM >100% expand':   'EM exceeded + expansion — VWAP steep, ATR expanding, volume increasing'
};

export const REGIME_COMMENTARY = {
  'RM < 25%':          'Strong directional bias: credit spreads lead. Neutral bias: Iron Condor - Normal. Trend can still develop.',
  'RM 25-50%':         'Credit spreads and condors lead. Confirm direction before selecting spread type.',
  'RM 50-75%':         'Transition zone. Long Condor - Reversed and BWB preferred. Directional spreads marginal.',
  'RM 75-100%':        'Stabilization zone. Butterfly structures excel. Directional spreads low probability.',
  'RM >100% compress': 'EM exceeded with compression — butterfly/BWB. Directional spreads: no trade.',
  'RM >100% expand':   'EM exceeded without compression — avoid centred. Chicken condor or BWB only.'
};

export const MARKET_BEHAVIOUR_0DTE = {
  'Chicken condor':         'Price stays very contained inside short strikes. No late breakout.',
  'Broken wing butterfly':  'Price moves toward body strike and stalls. Avoid fast move through the risk wing.',
  'Asymmetric butterfly':   'Price moves toward the profit zone body. No aggressive overshoot through risk side.',
  'Standard butterfly':     'Price pins near the middle short strike by expiry.',
  'Iron Condor - Normal':   'Price stays calmly between short put and short call. Low realised movement.',
  'Long Condor - Reversed': 'Price makes a large move beyond either long strike. Profits from breakout or trend day. Avoid range-bound markets.',
  'Iron butterfly':         'Price pins as close as possible to the central short strike within breakevens.',
  'Bull put spread':        'Price stays above the short put. Sideways-to-higher after entry.',
  'Bear call spread':       'Price stays below the short call. Sideways-to-lower after entry.',
  'Bull call spread':       'Price moves upward quickly through the long call toward the short call.',
  'Bear put spread':        'Price moves downward quickly through the long put toward the short put.'
};

export const MARKET_BEHAVIOUR_45DTE = {
  'Iron Condor - Normal':   'Price remains broadly range-bound. IV contracts. Time decay allows buyback cheaper.',
  'Credit spread':          'Price stays above short put (bull) or below short call (bear). Theta + IV contraction.',
  'Calendar spread':        'Price stays near the strike. Front month decays faster than back month.',
  'Diagonal spread':        'Price drifts toward the short strike. Time spread earns theta differential.',
  'Broken wing butterfly':  'Price drifts toward body strike over time. Theta + IV contraction help. No large move beyond risk wing.',
  'Jade lizard':            'Price stays above short put. Total credit exceeds call spread width (no upside risk).',
  'Ratio spread':           'Price moves toward the short strikes moderately. Not beyond. Theta helps if near shorts.',
  'Bull call spread':       'Price trends upward toward or beyond the short call before theta erodes the debit.',
  'Bear put spread':        'Price trends downward toward or beyond the short put before theta erodes the debit.',
  'Iron butterfly':         'Price remains near the body strike. IV falls. Time decay works inside breakevens.',
  'Standard butterfly':     'Price gradually moves toward the body strike and stays near it. Low realised vol.'
};

// ── Settlement class (0DTE) ──
// Cash-settled index options resolve at the close into a cash debit or credit that a
// defined-risk structure already caps. Everything else is physically settled: an ITM leg
// at the bell becomes 100 actual shares per contract — assigned on a short leg,
// auto-exercised on a long one — and that is an unhedged overnight position, not a
// bounded loss. It is the whole reason "can I just let this expire?" is a different
// question per underlying. (Aug 2026)
export const CASH_SETTLED_0DTE = ['SPX', 'RUT', 'NDX', 'XSP', 'VIX'];

export const VIX_GAP_RATINGS = {
  'Chicken condor':         [  3,  7, 10, 10 ],
  'Broken wing butterfly':  [ 10, 10,  7,  3 ],
  'Asymmetric butterfly':   [ 10, 10,  7,  3 ],
  'Standard butterfly':     [ 10,  7,  3,  0 ],
  'Iron Condor - Normal':   [  0,  3,  7, 10 ],
  'Long Condor - Reversed': [ 10,  7,  3,  0 ],
  'Iron butterfly':         [  0,  3, 10, 10 ],
  'Bull put spread':        [  3,  7, 10, 10 ],
  'Bear call spread':       [  3,  7, 10, 10 ],
  'Bull call spread':       [ 10,  7,  3,  0 ],
  'Bear put spread':        [ 10,  7,  3,  0 ]
};

export const REGIME_RATINGS45 = {
  'Premium cheap':   [ 1, 0, 2, 2, 1, 0, 1, 2, 2, 0, 0 ],
  'Neutral':         [ 2, 1, 2, 2, 2, 1, 2, 1, 1, 1, 1 ],
  'Premium rich':    [ 3, 3, 1, 1, 3, 3, 2, 0, 0, 3, 2 ],
  'Very rich':       [ 3, 3, 0, 0, 3, 3, 3, 0, 0, 3, 3 ],
  'Backwardation':   [ 2, 2, 0, 1, 2, 2, 2, 0, 0, 2, 1 ]
};

export const REGIME_COMMENTARY45 = {
  'Premium cheap':   'IVR low — premium selling less attractive. Calendar, diagonal, debit spreads viable.',
  'Neutral':         'IVR moderate — balanced environment, iron condors, credit spreads all viable.',
  'Premium rich':    'IVR elevated — ideal short premium environment. Iron Condor - Normal, BWB, jade lizard lead.',
  'Very rich':       'IVR very high — excellent for premium selling but check event risk.',
  'Backwardation':   'Term structure inverted — near-term IV exceeds far. Calendars avoid. Credit spreads cautious.'
};

export const DELTA_GUIDE = [
  { strat: 'Iron Condor - Normal',     range: '16-20Δ short strikes',    note: 'Both sides OTM' },
  { strat: 'Credit spread',            range: '25-30Δ short, 10-16Δ long', note: 'Directional' },
  { strat: 'Calendar spread',          range: 'ATM or ±5Δ',             note: 'Near strike' },
  { strat: 'Diagonal spread',          range: 'Short 30Δ / Long 50Δ',    note: 'Front/back month' },
  { strat: 'Broken wing butterfly',    range: 'ATM body, 1 SD wings',    note: 'Risk wing wider' },
  { strat: 'Jade lizard',              range: '20Δ put, 16Δ call spread', note: 'No upside risk' },
  { strat: 'Ratio spread',             range: '50Δ long, 2x 25Δ short', note: 'ATM/OTM' },
  { strat: 'Bull call / Bear put',     range: '50Δ long, 30Δ short',    note: 'ITM to OTM' },
  { strat: 'Iron butterfly',           range: 'ATM short, 1 SD wings',   note: 'Max credit at center' },
  { strat: 'Standard butterfly',       range: 'ATM body, ±1 SD wings',  note: 'Pin trade' }
];

export const UNDERLYING_LIST = [
  'SPX', 'XSP', 'SPY', 'QQQ', 'RUT', 'NVDA', 'TSLA', 'AAPL', 'IWM', 'VIX',
  'AMZN', 'MSFT', 'AMD', 'META', 'INTC', 'GOOGL', 'SLV', 'GLD',
  'HYG', 'TLT', 'MSTR', 'PLTR'
];
