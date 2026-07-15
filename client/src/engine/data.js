// ================================================================
//  DECISION ENGINE — SHARED DATA
//  Strategy arrays, ratings matrices, market behaviour lookups
// ================================================================

export const SQRT252 = Math.sqrt(252);

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
  'SPX', 'SPY', 'QQQ', 'RUT', 'NVDA', 'TSLA', 'AAPL', 'IWM', 'VIX',
  'AMZN', 'MSFT', 'AMD', 'META', 'INTC', 'GOOGL', 'SLV', 'GLD',
  'HYG', 'TLT', 'MSTR', 'PLTR'
];
