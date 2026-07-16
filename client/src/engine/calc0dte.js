// ================================================================
//  0DTE CALCULATION ENGINE v2
//  Merged scoring: compression + move consumed + overnight + VWAP + VIX + gamma
// ================================================================
import { STRATS_0DTE, SQRT252, REGIME_CONDS, REGIME_COMMENTARY, VIX_GAP_RATINGS, MARKET_BEHAVIOUR_0DTE } from './data.js';

function degrade(rating, levels) {
  const order = ['EXCELLENT','GOOD','MARGINAL','NO TRADE'];
  const idx = order.indexOf(rating);
  return order[Math.min(idx + levels, 3)];
}

export function getStrategyRatings(dirScore, gapBandIdx, rmRatio, isCompressing, moveConsumed) {
  const isBull = dirScore > 0, isBear = dirScore < 0, isNeutral = dirScore === 0;
  const isStrong = Math.abs(dirScore) >= 2;
  const isMild = Math.abs(dirScore) === 1;
  const butterflyZone = moveConsumed > 0.60 && isCompressing;
  const spreadZone = moveConsumed < 0.60 && !isCompressing;

  // Base ratings: [Chicken, BWB, Asymmetric, Standard, IronCondor, LongCondor, IronButterfly]
  let base;
  if (butterflyZone) {
    // High move consumed + compression: butterfly structures dominate
    // Direction determines which butterfly type leads
    if (isStrong) {
      // Strong direction: BWB leads (max asymmetry), Asymmetric good, Standard poor
      base = ['MARGINAL','EXCELLENT','GOOD','MARGINAL','MARGINAL','GOOD','MARGINAL'];
    } else if (isMild) {
      // Mild direction: Asymmetric leads (moderate asymmetry), BWB good, Standard marginal
      base = ['MARGINAL','GOOD','EXCELLENT','MARGINAL','MARGINAL','EXCELLENT','GOOD'];
    } else {
      // Neutral: Standard/Iron butterfly lead (symmetric), BWB/Asymmetric marginal
      base = ['MARGINAL','MARGINAL','MARGINAL','EXCELLENT','MARGINAL','GOOD','EXCELLENT'];
    }
  } else if (rmRatio < 0.25) {
    base = ['GOOD','MARGINAL','GOOD','NO TRADE','EXCELLENT','NO TRADE','MARGINAL'];
  } else if (rmRatio < 0.50) {
    if (isStrong) {
      base = ['EXCELLENT','MARGINAL','MARGINAL','NO TRADE','GOOD','NO TRADE','MARGINAL'];
    } else {
      base = ['EXCELLENT','MARGINAL','MARGINAL','NO TRADE','EXCELLENT','GOOD','MARGINAL'];
    }
  } else if (rmRatio < 0.75) {
    if (isStrong) {
      // Strong direction + transition zone: BWB preferred over Asymmetric
      base = ['GOOD','EXCELLENT','GOOD','MARGINAL','GOOD','GOOD','MARGINAL'];
    } else if (isMild) {
      // Mild direction: Asymmetric slightly preferred
      base = ['GOOD','GOOD','EXCELLENT','MARGINAL','GOOD','EXCELLENT','MARGINAL'];
    } else {
      // Neutral: Long Condor preferred
      base = ['MARGINAL','MARGINAL','MARGINAL','GOOD','GOOD','EXCELLENT','GOOD'];
    }
  } else if (rmRatio < 1.00) {
    if (isStrong) {
      base = ['MARGINAL','EXCELLENT','GOOD','MARGINAL','MARGINAL','MARGINAL','MARGINAL'];
    } else if (isMild) {
      base = ['MARGINAL','GOOD','EXCELLENT','GOOD','MARGINAL','GOOD','GOOD'];
    } else {
      // Neutral: Standard butterfly and Iron butterfly lead
      base = ['MARGINAL','MARGINAL','MARGINAL','EXCELLENT','MARGINAL','GOOD','EXCELLENT'];
    }
  } else if (isCompressing) {
    if (isStrong) {
      base = ['MARGINAL','EXCELLENT','GOOD','MARGINAL','MARGINAL','MARGINAL','MARGINAL'];
    } else if (isMild) {
      base = ['MARGINAL','GOOD','EXCELLENT','GOOD','MARGINAL','GOOD','GOOD'];
    } else {
      base = ['MARGINAL','MARGINAL','MARGINAL','EXCELLENT','MARGINAL','GOOD','EXCELLENT'];
    }
  } else {
    // RM >100% expanding — dangerous, only directional structures
    if (isStrong) {
      base = ['GOOD','GOOD','MARGINAL','NO TRADE','NO TRADE','NO TRADE','NO TRADE'];
    } else {
      base = ['GOOD','MARGINAL','MARGINAL','NO TRADE','NO TRADE','NO TRADE','NO TRADE'];
    }
  }

  const ratings = base.slice();
  // Strong direction still downgrades centred structures
  if (isStrong) {
    [3,4,5,6].forEach(i => { if (ratings[i] !== 'NO TRADE') ratings[i] = degrade(ratings[i], 1); });
  }

  // Spreads: enhanced logic using move consumed and direction
  // Bull Put Spread — prefer when bullish breakout + move < 60%
  let bps;
  if (isBull && spreadZone) bps = 'EXCELLENT';
  else if (isBull && moveConsumed < 0.60) bps = (gapBandIdx>=2)?'EXCELLENT':'GOOD';
  else if (isBull) bps = moveConsumed > 0.80 ? 'NO TRADE' : 'MARGINAL';
  else if (isNeutral) bps = 'MARGINAL';
  else bps = 'NO TRADE';
  ratings.push(bps);

  // Bear Call Spread
  let bcs;
  if (isBear && spreadZone) bcs = 'EXCELLENT';
  else if (isBear && moveConsumed < 0.60) bcs = (gapBandIdx>=2)?'EXCELLENT':'GOOD';
  else if (isBear) bcs = moveConsumed > 0.80 ? 'NO TRADE' : 'MARGINAL';
  else if (isNeutral) bcs = 'MARGINAL';
  else bcs = 'NO TRADE';
  ratings.push(bcs);

  // Bull Call Spread (debit)
  let bullCall;
  if (isBull && moveConsumed < 0.40 && !isCompressing) bullCall = 'EXCELLENT';
  else if (isBull && moveConsumed < 0.50) bullCall = 'GOOD';
  else if (isBull && moveConsumed < 0.60) bullCall = 'MARGINAL';
  else bullCall = 'NO TRADE';
  ratings.push(bullCall);

  // Bear Put Spread (debit)
  let bearPut;
  if (isBear && moveConsumed < 0.40 && !isCompressing) bearPut = 'EXCELLENT';
  else if (isBear && moveConsumed < 0.50) bearPut = 'GOOD';
  else if (isBear && moveConsumed < 0.60) bearPut = 'MARGINAL';
  else bearPut = 'NO TRADE';
  ratings.push(bearPut);

  return ratings;
}

export function calc0DTE(inputs) {
  const { price, high, low, vwap5, vwap5_30, vwap15, vwap15_30, atr, em, atr5, atr2h, gamStrike,
    vix, vix1d, bankroll, startBR, risk, maxLoss, win, maxOpen, pop, netCreditDebit,
    theta, delta, gamma, hours, underlying,
    // Overnight inputs
    esOvernightHigh, esOvernightLow, esClose, priorDayClose, cashOpen, esEM,
    // Optional per-strategy realized history: { trades, winRate, avgWin, avgLoss }
    // (avgWin/avgLoss as positive dollar magnitudes per contract). When trades
    // >= EV_HISTORY_THRESHOLD, measured expectancy replaces estimates.
    // Pass either a resolved `history` object or a `historyByStrategy` map keyed
    // by strategy name (the engine indexes it by its own legStrat below).
    // wingDeltas: { lowerAbsDelta, upperAbsDelta } — |delta| of the outer wing
    // options from the live chain, for the skew-aware P(max loss) cross-check.
    history: historyInput, historyByStrategy, wingDeltas } = inputs;

  const hasPrice = price > 0;
  const hasComp = atr5 > 0 && atr2h > 0;
  const hasGam = gamStrike > 0 && atr > 0;
  const hasGreeks = theta > 0 && Math.abs(delta) > 0;
  const popFrac = pop / 100;
  const hasOvernight = esOvernightHigh > 0 && esOvernightLow > 0 && priorDayClose > 0;
  const hasCashOpen = cashOpen > 0;
  const hasESEM = esEM > 0;

  // Use VWAP 5 as primary
  const vwap = vwap5;

  // ── Core derived metrics ──
  const rm = high - low;
  const rmRatio = em > 0 ? rm / em : 0;
  const comp = hasComp ? atr5 / atr2h : null;
  const gamDist = hasGam ? Math.abs(price - gamStrike) / atr : null;
  const aboveVWAP = hasPrice && vwap > 0 && price >= vwap;
  const vwapDiff = vwap > 0 ? price - vwap : 0;
  const vwapDistPctEM = (em > 0 && vwap > 0) ? Math.abs(price - vwap) / em : 0;
  const vwapOverextended = vwapDistPctEM > 0.75;
  const vixGap = vix > 0 ? (vix1d - vix) / vix : 0;
  const gapBandIdx = vixGap < -0.10 ? 0 : vixGap <= 0.10 ? 1 : vixGap <= 0.25 ? 2 : 3;
  const vixHigh = vix > 25;
  const emVIX = price > 0 ? Math.round(price * (vix / 100) / SQRT252) : 0;
  const emV1D = price > 0 ? Math.round(price * (vix1d / 100) / SQRT252) : 0;
  const vixGrade = vixGap<-0.10?'Cheap short-term vol':vixGap<=0.10?'Neutral':vixGap<=0.25?'Rich short-term vol':'Extremely rich short-term vol';
  const vixImplic = vixGap<-0.10?'BWB, Asymmetric, Long Condor':vixGap<=0.10?'BWB, Asymmetric, Chicken Condor':vixGap<=0.25?'Iron Condor, Iron Butterfly, Chicken Condor':'Iron Condor, Iron Butterfly (check event risk)';
  const isCompressing = hasComp && comp < 0.50;
  const isExpanding = hasComp && comp > 0.80;

  // ═══════════════════════════════════════
  //  OVERNIGHT + MOVE CONSUMED (full model)
  // ═══════════════════════════════════════

  // Overnight directional move (signed)
  const overnightDirMove = hasOvernight ? esClose - priorDayClose : 0;
  const overnightMove = Math.abs(overnightDirMove);
  const overnightRange = hasOvernight ? esOvernightHigh - esOvernightLow : 0;
  const overnightDir = hasOvernight ? (overnightDirMove > 0 ? 'bullish' : overnightDirMove < 0 ? 'bearish' : 'flat') : 'unknown';

  // Overnight range consumed (vs ES EM if available, else vs cash EM)
  const overnightRangeEM = hasESEM ? esEM : em;
  const overnightRangePct = overnightRangeEM > 0 ? overnightRange / overnightRangeEM : 0;
  const overnightMovePct = overnightRangeEM > 0 ? overnightMove / overnightRangeEM : 0;

  // Cash session directional move (signed: price - open)
  const cashDirMove = (hasPrice && hasCashOpen) ? price - cashOpen : 0;
  const cashMove = Math.abs(cashDirMove);
  const cashRange = rm; // high - low

  // Gap: difference between cash open and ES pre-open (any slippage at open)
  const gapAtOpen = (hasCashOpen && esClose > 0) ? cashOpen - esClose : 0;

  // Total directional consumed: combine overnight and cash as % of their respective EMs
  // NOT cross-instrument (ES prior close vs SPX current price would be nonsensical)
  const overnightDirPct = overnightRangeEM > 0 ? overnightMove / overnightRangeEM : 0;
  const cashDirPct = em > 0 ? cashMove / em : 0;
  // Weighted blend: overnight dir + cash dir
  const totalDirConsumed = hasOvernight
    ? (overnightDirPct * 0.4 + cashDirPct * 0.6)  // cash session weighted more
    : cashDirPct;

  // Total range consumed: overnight range + cash range vs combined EM
  const combinedEM = (hasESEM ? esEM : em) + (em > 0 ? em : 0);
  const totalRangeConsumed = combinedEM > 0 ? (overnightRange + cashRange) / combinedEM : (em > 0 ? rmRatio : 0);

  // Primary move consumed metric
  const moveConsumedDir = Math.min(totalDirConsumed, 1.5);
  const moveConsumedRange = Math.min(totalRangeConsumed, 1.5);
  // Blended: 60% range + 40% directional — range matters more for premium sellers
  const moveConsumed = Math.min((moveConsumedRange * 0.6 + moveConsumedDir * 0.4), 1.5);
  const volRemaining = Math.max(0, 1 - moveConsumed);

  // ── Continuation vs Reversal detection ──
  // Continuation: overnight and cash session move in same direction
  // Reversal: overnight and cash session move in opposite directions
  const cashDir = cashDirMove > 0 ? 'bullish' : cashDirMove < 0 ? 'bearish' : 'flat';
  let trendPattern = 'unknown';
  if (overnightDir !== 'unknown' && overnightDir !== 'flat' && cashDir !== 'flat') {
    if (overnightDir === cashDir) {
      trendPattern = 'continuation'; // same direction — trend day likely
    } else {
      trendPattern = 'reversal'; // opposite — mean reversion / failed gap
    }
  } else if (overnightDir === 'flat' && cashDir === 'flat') {
    trendPattern = 'range'; // neither moved — range day
  } else if (overnightDir !== 'unknown' && cashDir === 'flat') {
    trendPattern = 'gap-and-hold'; // overnight moved, cash hasn't yet
  }

  // Trend strength score (0-10) for strategy selection
  let trendStrength = 0;
  if (trendPattern === 'continuation') {
    trendStrength = Math.min(10, Math.round(totalDirConsumed * 10));
  } else if (trendPattern === 'reversal') {
    trendStrength = -Math.min(5, Math.round(moveConsumedDir * 5)); // negative = reversal
  }

  // ── VWAP slopes ──
  function calcSlope(now, ago) {
    if (now > 0 && ago > 0) {
      const pctChange = ((now - ago) / ago) * 100;
      const absChange = Math.abs(pctChange);
      const strength = absChange < 0.02 ? 'flat' : absChange < 0.08 ? 'mild' : 'strong';
      const direction = pctChange > 0.02 ? 'rising' : pctChange < -0.02 ? 'falling' : 'flat';
      return { strength, direction, pctChange };
    }
    return { strength: 'flat', direction: 'unknown', pctChange: 0 };
  }
  const slope5 = calcSlope(vwap5, vwap5_30);
  const slope15 = calcSlope(vwap15, vwap15_30);
  const slope = slope5.strength;
  const slopeDirection = slope5.direction;
  const confirmed = slope5.direction !== 'flat' && slope5.direction !== 'unknown'
    && slope15.direction === slope5.direction;
  const diverges = slope5.direction !== 'flat' && slope5.direction !== 'unknown'
    && slope15.direction !== 'unknown' && slope15.direction !== 'flat'
    && slope15.direction !== slope5.direction;

  // ── Direction score ──
  let dirScore;
  if (!hasPrice || vwap <= 0) dirScore = 0;
  else if (aboveVWAP && slope === 'strong') dirScore = 2;
  else if (aboveVWAP && slope === 'mild') dirScore = 1;
  else if (!aboveVWAP && slope === 'strong') dirScore = -2;
  else if (!aboveVWAP && slope === 'mild') dirScore = -1;
  else dirScore = aboveVWAP ? 1 : (hasPrice ? -1 : 0);

  // 15m confirmation adjusts conviction
  if (diverges && Math.abs(dirScore) >= 2) dirScore = dirScore > 0 ? 1 : -1;
  else if (confirmed && Math.abs(dirScore) === 1) dirScore = dirScore > 0 ? 2 : -2;

  // Overnight alignment boost
  if (hasOvernight) {
    if (overnightDir === 'bullish' && dirScore >= 1) dirScore = Math.min(2, dirScore);
    if (overnightDir === 'bearish' && dirScore <= -1) dirScore = Math.max(-2, dirScore);
    // Overnight diverges from cash session
    if (overnightDir === 'bullish' && dirScore <= -1) dirScore = Math.max(-1, dirScore + 1);
    if (overnightDir === 'bearish' && dirScore >= 1) dirScore = Math.min(1, dirScore - 1);
  }

  const overextendedWarning = vwapOverextended && Math.abs(dirScore) >= 2;
  const dirLabel = dirScore>=2?'Strong bullish':dirScore===1?'Mild bullish':dirScore===0?'Neutral':dirScore===-1?'Mild bearish':'Strong bearish';

  // ── Regime ──
  let regime;
  if (moveConsumed > 0.80 && isCompressing) regime = 'Volatility exhausted + compression';
  else if (moveConsumed > 0.60 && isCompressing) regime = 'High move consumed + compression';
  else if (rmRatio < 0.25) regime = 'RM < 25%';
  else if (rmRatio < 0.50) regime = 'RM 25-50%';
  else if (rmRatio < 0.75) regime = 'RM 50-75%';
  else if (rmRatio < 1.00) regime = 'RM 75-100%';
  else regime = isCompressing ? 'RM >100% compress' : 'RM >100% expand';

  if (gamDist !== null && gamDist < 0.25 && comp < 0.35 && rmRatio >= 0.75) regime = 'RM 75-100%';

  const regimeConds = REGIME_CONDS[regime] || `Move consumed ${(moveConsumed*100).toFixed(0)}% — ${isCompressing ? 'compressing' : 'expanding'}`;
  const regimeCommentary = REGIME_COMMENTARY[regime] || (moveConsumed > 0.60 && isCompressing
    ? 'Butterfly zone: most expected move consumed with compression developing. Pin and decay favoured.'
    : moveConsumed < 0.40 && !isCompressing
    ? 'Spread zone: volatility budget remaining with expansion. Directional credit spreads if direction clear.'
    : 'Transition zone: assess compression and direction before committing.');

  // ── Strategy ratings ──
  const ratings = getStrategyRatings(dirScore, gapBandIdx, rmRatio, isCompressing, moveConsumed);
  const sorted = STRATS_0DTE.map((s, i) => ({ name: s, rating: ratings[i] }));
  const order = { EXCELLENT: 0, GOOD: 1, MARGINAL: 2, 'NO TRADE': 3 };
  sorted.sort((a, b) => order[a.rating] - order[b.rating]);
  const best = sorted.find(s => s.rating === 'EXCELLENT' || s.rating === 'GOOD');
  const bestStrat = best ? best.name : 'No suitable structure';
  const bestRating = best ? best.rating : 'NO TRADE';

  // Override: if caller specifies a strategy, use that for legs
  const overrideStrategy = inputs.overrideStrategy || null;
  const legStrat = overrideStrategy || bestStrat;

  // ── Strike engine (with directional gamma) ──
  const baseDistance = price > 0 ? Math.max(emVIX, emV1D, em * 0.5) : 0;
  let distMult = 1.0;
  if (hasComp) { if (comp < 0.50) distMult = 0.8; else if (comp > 0.80) distMult = 1.25; }
  let D = baseDistance * distMult;
  const roundTo = (underlying === 'SPX' || underlying === 'RUT') ? 5 : (underlying === 'SPY' || underlying === 'QQQ' || underlying === 'IWM') ? 1 : 0.5;
  if (D > 0 && D < roundTo * 2) D = roundTo * 2;
  const R = n => roundTo > 0 ? Math.round(n / roundTo) * roundTo : Math.round(n * 2) / 2;
  const leg = (label, strike) => ({ label, strike: R(strike) });

  // Gamma strike: use directionally. Bullish → look at gamma above price. Bearish → below.
  let gs = price;
  if (price > 0 && D > 0) {
    if (hasGam && gamStrike > 0) {
      const gamDelta = gamStrike - price;
      const maxMove = D * 0.8;
      // Directional gamma: if bullish and gamma is above, use it. If bearish and gamma below, use it.
      const dirAligned = (dirScore >= 1 && gamDelta > 0) || (dirScore <= -1 && gamDelta < 0) || dirScore === 0;
      if (dirAligned) {
        if (Math.abs(gamDelta) <= maxMove) gs = gamStrike;
        else gs = price + Math.sign(gamDelta) * maxMove;
      }
      gs = R(gs);
    }
  }

  let legs = [];
  if (price > 0 && D > 0) {
    const p = price;
    if (legStrat === 'Iron butterfly') {
      legs = [leg('Long put (wing)', p-D), leg('Short put (body)', p), leg('Short call (body)', p), leg('Long call (wing)', p+D)];
    } else if (legStrat === 'Standard butterfly') {
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-D), leg('Short call x2 (mid)', gs), leg('Long call (upper)', gs+D)]
        : [leg('Long put (upper)', gs+D), leg('Short put x2 (mid)', gs), leg('Long put (lower)', gs-D)];
    } else if (legStrat === 'Broken wing butterfly') {
      const nearW = D, farW = Math.round(D * 1.75 / roundTo) * roundTo;
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-nearW), leg('Short call x2 (body)', gs), leg(`Long call (broken ${farW.toFixed(0)}pt)`, gs+farW)]
        : [leg('Long put (upper)', gs+nearW), leg('Short put x2 (body)', gs), leg(`Long put (broken ${farW.toFixed(0)}pt)`, gs-farW)];
    } else if (legStrat === 'Asymmetric butterfly') {
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-D), leg('Short call x2 (body)', gs), leg('Long call (1.5x upper)', gs+D*1.5)]
        : [leg('Long put (upper)', gs+D), leg('Short put x2 (body)', gs), leg('Long put (1.5x lower)', gs-D*1.5)];
    } else if (legStrat === 'Iron Condor - Normal') {
      legs = [leg('Long put', p-2*D), leg('Short put', p-D), leg('Short call', p+D), leg('Long call', p+2*D)];
    } else if (legStrat === 'Long Condor - Reversed') {
      // Reversed iron condor: sell outer wings, buy inner strikes
      // Profits from large move — debit structure
      legs = [leg('Short put', p-2*D), leg('Long put', p-D), leg('Long call', p+D), leg('Short call', p+2*D)];
    } else if (legStrat === 'Chicken condor') {
      const tightW = D, wideW = D * 1.5;
      legs = dirScore >= 0
        ? [leg('Long put', p-wideW-D), leg('Short put', p-wideW), leg('Short call', p+tightW), leg('Long call', p+tightW+D)]
        : [leg('Long put', p-tightW-D), leg('Short put', p-tightW), leg('Short call', p+wideW), leg('Long call', p+wideW+D)];
    } else if (legStrat === 'Bull put spread') {
      // Two strike sets: EM(VIX)/2 based and EM(VIX1D) based
      const dVix = emVIX > 0 ? Math.max(emVIX, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Short put (VIX)', p - dVix), leg('Long put (VIX)', p - dVix * 2),
        leg('Short put (VIX1D)', p - dV1d), leg('Long put (VIX1D)', p - dV1d * 2)
      ];
    } else if (legStrat === 'Bear call spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Short call (VIX)', p + dVix), leg('Long call (VIX)', p + dVix * 2),
        leg('Short call (VIX1D)', p + dV1d), leg('Long call (VIX1D)', p + dV1d * 2)
      ];
    } else if (legStrat === 'Bull call spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Long call (VIX)', p), leg('Short call (VIX)', p + dVix * 0.5),
        leg('Long call (VIX1D)', p), leg('Short call (VIX1D)', p + dV1d * 0.5)
      ];
    } else if (legStrat === 'Bear put spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Long put (VIX)', p), leg('Short put (VIX)', p - dVix * 0.5),
        leg('Long put (VIX1D)', p), leg('Short put (VIX1D)', p - dV1d * 0.5)
      ];
    }
  }
  const isSpread = ['Bull put spread','Bear call spread','Bull call spread','Bear put spread'].includes(legStrat);

  // ── P(max loss): probability price settles in a max-loss tail by close ──
  // Max loss on a defined-risk structure occurs OUTSIDE the outer wings. Using
  // the lognormal 0DTE approximation: remaining session sigma = EM × √(hours/5.5)
  // (EM shrinks as the day burns down). P(below lower wing) + P(above upper wing).
  // No Greeks needed. For spreads (one-sided risk) only the at-risk tail counts.
  function normCdf(z) { // standard normal CDF via erf approximation
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  let pMaxLoss = null, pMaxLossLow = null, pMaxLossHigh = null;
  let pMaxLossModel = null, pMaxLossDelta = null, pMaxLossSource = null;
  if (legs.length > 0 && price > 0 && em > 0) {
    const strikes = legs.map(l => l.strike);
    const lowerWing = Math.min(...strikes);
    const upperWing = Math.max(...strikes);
    const hoursLeft = hours > 0 ? hours : 5.5;
    // Sigma from the best available 0DTE vol proxy. VIX1D (1-day vol index) is
    // closest to actual ATM 0DTE IV, so prefer its EM when present; else fall
    // back to the general EM input. Both are skew-free (see delta method below).
    const emBase = emV1D > 0 ? emV1D : em;
    const sigma = emBase * Math.sqrt(Math.min(1, hoursLeft / 5.5)); // remaining-session move
    if (sigma > 0) {
      // Reversed condor is a DEBIT structure — max loss is in the MIDDLE, not
      // the tails — so this tail method doesn't apply; leave null for it.
      if (legStrat !== 'Long Condor - Reversed') {
        pMaxLossLow = normCdf((lowerWing - price) / sigma);          // P(settle below lower wing)
        pMaxLossHigh = 1 - normCdf((upperWing - price) / sigma);     // P(settle above upper wing)
        if (legStrat === 'Bull put spread') { pMaxLossHigh = 0; }    // risk only on downside
        else if (legStrat === 'Bear call spread') { pMaxLossLow = 0; } // risk only on upside
        else if (legStrat === 'Bull call spread') { pMaxLossHigh = 0; pMaxLossLow = normCdf((Math.min(...strikes) - price) / sigma); }
        else if (legStrat === 'Bear put spread') { pMaxLossLow = 0; pMaxLossHigh = 1 - normCdf((Math.max(...strikes) - price) / sigma); }
        pMaxLossModel = Math.min(1, (pMaxLossLow || 0) + (pMaxLossHigh || 0));

        // ── Delta-proxy cross-check (embeds real IV level + skew) ──
        // Wing deltas come from the option chain via TWS or per-leg manual entry.
        // P(below lower wing) ≈ 1 − |delta of lower long call|  (or |delta| of a
        // long put wing directly); P(above upper wing) ≈ |delta of upper call|.
        // Only computed when wingDeltas provided: { lowerAbsDelta, upperAbsDelta }.
        if (wingDeltas && (wingDeltas.lowerAbsDelta != null || wingDeltas.upperAbsDelta != null)) {
          // The lower wing is a PUT (its delta is negative; |delta| ≈ P below it
          // directly). The upper wing is a CALL (|delta| ≈ P above it directly).
          // So BOTH tails use |wing delta| as-is — do NOT do 1−delta.
          const lowTail = wingDeltas.lowerAbsDelta != null
            ? Math.abs(wingDeltas.lowerAbsDelta) : (pMaxLossLow || 0);
          const highTail = wingDeltas.upperAbsDelta != null
            ? Math.abs(wingDeltas.upperAbsDelta) : (pMaxLossHigh || 0);
          // Respect one-sided-risk strategies
          let dLow = lowTail, dHigh = highTail;
          if (legStrat === 'Bull put spread' || legStrat === 'Bull call spread') dHigh = 0;
          if (legStrat === 'Bear call spread' || legStrat === 'Bear put spread') dLow = 0;
          pMaxLossDelta = Math.min(1, dLow + dHigh);
        }

        // Blend: when both exist, average them (delta embeds skew, model is
        // smooth/stable). When only one exists, use it.
        if (pMaxLossModel != null && pMaxLossDelta != null) {
          pMaxLoss = (pMaxLossModel + pMaxLossDelta) / 2;
          pMaxLossSource = 'blend';
        } else if (pMaxLossDelta != null) {
          pMaxLoss = pMaxLossDelta; pMaxLossSource = 'delta';
        } else {
          pMaxLoss = pMaxLossModel; pMaxLossSource = 'model';
        }
      }
    }
  }

  const wingTxt = D > 0
    ? isSpread
      ? `EM(VIX)=${emVIX>0?emVIX.toFixed(1):'--'} | EM(VIX1D)=${emV1D>0?emV1D.toFixed(1):'--'}`
      : `D=${D.toFixed(1)} pts (base ${baseDistance.toFixed(1)} x ${distMult.toFixed(2)})`
    : '';

  // ═══════════════════════════════════════
  //  MERGED SCORING (100 pts)
  //  Compression(20) + MoveConsumed(20) + StratFit(15) +
  //  VWAP(10) + VIXgap(10) + Overnight(10) +
  //  OvernightRange(5) + VWAPdist(5) + GammaDist(5)
  // ═══════════════════════════════════════
  let setupScore = 0;
  const criteria = [];

  // 1. Compression signal (15)
  const isCentred = ['Iron Condor - Normal','Iron butterfly','Standard butterfly','Long Condor - Reversed'].includes(bestStrat);
  const isDirectional = ['Chicken condor','Broken wing butterfly','Asymmetric butterfly','Bull put spread','Bear call spread','Bull call spread','Bear put spread'].includes(bestStrat);
  let compPts;
  if (!hasComp) compPts = 5;
  else if (isCentred) compPts = comp<0.35?15:comp<0.50?12:comp<0.80?6:2;
  else if (isDirectional) compPts = comp>0.80?14:comp>0.50?11:comp>0.35?8:5;
  else compPts = comp<0.50?11:comp<0.80?8:4;
  setupScore += compPts;
  criteria.push({ label: `Compression ${hasComp?comp.toFixed(2):'--'}`, pts: compPts, max: 15 });

  // 2. Expected move consumed (15)
  let movePts;
  if (em <= 0) movePts = 5;
  else if (isCentred) {
    // Butterflies want high move consumed
    movePts = moveConsumed>0.80?15:moveConsumed>0.60?12:moveConsumed>0.40?8:moveConsumed>0.25?4:2;
  } else {
    // Spreads want low move consumed (room to run)
    movePts = moveConsumed<0.30?15:moveConsumed<0.50?12:moveConsumed<0.60?8:moveConsumed<0.80?4:0;
  }
  setupScore += movePts;
  criteria.push({ label: `Move consumed ${em>0?(moveConsumed*100).toFixed(0)+'%':'--'}`, pts: movePts, max: 15 });

  // 2b. Tail risk — P(max loss) (10). Lower probability of settling in a
  // max-loss tail = higher score. Rewards structures whose wings are far from
  // spot relative to the remaining expected move.
  let tailPts, tailLabel;
  if (pMaxLoss == null) {
    tailPts = 5; // unknown (missing EM/price, or reversed condor) → neutral
    tailLabel = 'Tail risk --';
  } else {
    tailPts = pMaxLoss < 0.05 ? 10 : pMaxLoss < 0.10 ? 8 : pMaxLoss < 0.15 ? 6 : pMaxLoss < 0.25 ? 3 : 0;
    const srcTag = pMaxLossSource === 'blend' ? ' (blend)' : pMaxLossSource === 'delta' ? ' (delta)' : '';
    tailLabel = `P(max loss) ${(pMaxLoss*100).toFixed(0)}%${srcTag}`;
  }
  setupScore += tailPts;
  criteria.push({ label: tailLabel, pts: tailPts, max: 10 });

  // 3. Strategy fit (15)
  const stratFit = bestRating==='EXCELLENT'?15:bestRating==='GOOD'?10:bestRating==='MARGINAL'?5:0;
  setupScore += stratFit;
  criteria.push({ label: `Strategy fit (${bestRating})`, pts: stratFit, max: 15 });

  // 4. VWAP slope + 15m confirmation (10)
  let slopePts;
  if (slope === 'flat') slopePts = isCentred?10:isDirectional?5:7;
  else if (slope === 'mild') slopePts = isDirectional?10:isCentred?5:7;
  else slopePts = isDirectional?8:isCentred?2:5;
  if (confirmed && isDirectional) slopePts = Math.min(10, slopePts + 2);
  if (diverges && isDirectional) slopePts = Math.max(0, slopePts - 3);
  if (diverges && isCentred) slopePts = Math.min(10, slopePts + 1);
  if (vwapOverextended && isDirectional) slopePts = Math.max(0, slopePts - 2);
  setupScore += slopePts;
  const slopeLabel = `VWAP ${slope} (${slopeDirection})${confirmed?' ✓15m':diverges?' ✗15m':''}`;
  criteria.push({ label: slopeLabel, pts: slopePts, max: 10 });

  // 5. VIX1D/VIX gap (10)
  const vixGapRatings = VIX_GAP_RATINGS[bestStrat] || [3,5,7,10];
  let vixPts = vixGap===0&&vix===0 ? 5 : vixGapRatings[gapBandIdx];
  if (vixHigh) vixPts = Math.floor(vixPts * 0.5);
  setupScore += vixPts;
  criteria.push({ label: `VIX gap for ${bestStrat}`, pts: vixPts, max: 10 });

  // 6. ES overnight trend alignment (10)
  let overnightPts;
  if (!hasOvernight) overnightPts = 5;
  else {
    const dirAligned = (overnightDir === 'bullish' && dirScore >= 1) || (overnightDir === 'bearish' && dirScore <= -1);
    const dirConflict = (overnightDir === 'bullish' && dirScore <= -1) || (overnightDir === 'bearish' && dirScore >= 1);
    if (dirAligned && isDirectional) overnightPts = 10;
    else if (dirAligned) overnightPts = 7;
    else if (overnightDir === 'flat' && isCentred) overnightPts = 8;
    else if (dirConflict) overnightPts = 2;
    else overnightPts = 5;
  }
  setupScore += overnightPts;
  criteria.push({ label: `ES overnight ${hasOvernight?overnightDir:'--'}`, pts: overnightPts, max: 10 });

  // 7. Overnight range utilization (5)
  let rangePts;
  if (!hasOvernight || em <= 0) rangePts = 3;
  else if (isCentred) rangePts = overnightRangePct>0.60?5:overnightRangePct>0.30?3:1;
  else rangePts = overnightRangePct<0.30?5:overnightRangePct<0.60?3:1;
  setupScore += rangePts;
  criteria.push({ label: `Overnight range ${hasOvernight?(overnightRangePct*100).toFixed(0)+'% EM':'--'}`, pts: rangePts, max: 5 });

  // 8. VWAP distance (5)
  let vwapDistPts;
  if (em <= 0 || vwap <= 0) vwapDistPts = 3;
  else if (isDirectional) vwapDistPts = vwapDistPctEM<0.25?5:vwapDistPctEM<0.50?4:vwapDistPctEM<0.75?2:0;
  else vwapDistPts = vwapDistPctEM<0.15?5:vwapDistPctEM<0.30?3:1;
  setupScore += vwapDistPts;
  criteria.push({ label: `VWAP distance ${vwap>0?(vwapDistPctEM*100).toFixed(0)+'% EM':'--'}`, pts: vwapDistPts, max: 5 });

  // 9. Gamma distance (5)
  let gamPts;
  if (!hasGam) gamPts = 3;
  else if (rmRatio < 0.50) gamPts = gamDist>1.0?5:gamDist>0.50?4:gamDist>0.25?2:1;
  else gamPts = gamDist<0.25?5:gamDist<0.50?4:gamDist<1.0?2:1;
  setupScore += gamPts;
  criteria.push({ label: `Gamma distance ${hasGam?gamDist.toFixed(2)+'x ATR':'--'}`, pts: gamPts, max: 5 });

  const setup = setupScore>=85?'A+ Setup':setupScore>=70?'A Setup':setupScore>=50?'B Setup':'No setup';

  // ── Target credit/debit based on strategy type and wing width ──
  let targetCredit = null;
  let targetLabel = '';
  let targetLow = 0, targetHigh = 0, targetMax = 0;
  let targetIsCredit = true;
  if (D > 0) {
    const width = D;
    targetMax = width; // max possible credit/debit = wing width
    if (legStrat.includes('Iron Condor') || legStrat === 'Chicken condor') {
      targetLow = width * 0.25; targetHigh = width * 0.40;
      targetCredit = (targetLow + targetHigh) / 2;
      targetLabel = `Target credit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = true;
    } else if (legStrat === 'Iron butterfly') {
      targetLow = width * 0.25; targetHigh = width * 0.35;
      targetCredit = (targetLow + targetHigh) / 2;
      targetLabel = `Target credit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = true;
    } else if (legStrat === 'Standard butterfly') {
      targetLow = width * 0.10; targetHigh = width * 0.25;
      targetCredit = -(targetLow + targetHigh) / 2;
      targetLabel = `Target debit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = false;
    } else if (legStrat === 'Broken wing butterfly') {
      // BWB: typically a debit trade. Near wing is tight, broken wing is wide.
      // Debit depends on how wide the broken wing is vs near wing.
      // Typical debit = 30-60% of near wing width
      const nearW = D; // near wing width
      targetLow = nearW * 0.20; targetHigh = nearW * 0.60;
      targetCredit = -(targetLow + targetHigh) / 2;
      targetLabel = `Target debit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)} (or small credit)`;
      targetIsCredit = false;
    } else if (legStrat === 'Asymmetric butterfly') {
      targetLow = width * 0.05; targetHigh = width * 0.20;
      targetCredit = -(targetLow + targetHigh) / 2;
      targetLabel = `Target debit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = false;
    } else if (legStrat.includes('Bull put') || legStrat.includes('Bear call') || legStrat.includes('Credit')) {
      targetLow = width * 0.25; targetHigh = width * 0.40;
      targetCredit = (targetLow + targetHigh) / 2;
      targetLabel = `Target credit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = true;
    } else if (legStrat.includes('Bull call') || legStrat.includes('Bear put') || legStrat.includes('Debit')) {
      targetLow = width * 0.50; targetHigh = width * 0.75;
      targetCredit = -(targetLow + targetHigh) / 2;
      targetLabel = `Target debit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = false;
    } else if (legStrat === 'Long Condor' || legStrat === 'Long Condor - Reversed') {
      targetLow = width * 0.30; targetHigh = width * 0.60;
      targetCredit = -(targetLow + targetHigh) / 2;
      targetLabel = `Target debit: $${targetLow.toFixed(2)}–$${targetHigh.toFixed(2)}`;
      targetIsCredit = false;
    }
  }

  // ═══════════════════════════════════════
  //  FAIR VALUE SCORE (0-100)
  //  Strategy-specific: different strategies value different conditions
  // ═══════════════════════════════════════

  const ivHvRatio = (vix > 0 && atr > 0 && price > 0)
    ? (vix1d > 0 ? vix1d : vix) / ((atr / price) * 100 * SQRT252)
    : 1.0;
  const vixGapPct = vix > 0 ? (vix1d - vix) / vix : 0;

  // Classify strategy type for fair value
  const isCredit = legStrat.includes('Iron Condor') || legStrat === 'Chicken condor' || legStrat === 'Iron butterfly'
    || legStrat.includes('Bull put') || legStrat.includes('Bear call');
  const isDebitBfly = legStrat.includes('butterfly') || legStrat.includes('Butterfly') || legStrat.includes('BWB') || legStrat.includes('Broken');
  const isReversed = legStrat.includes('Reversed');
  const isDebitSpread = legStrat.includes('Bull call') || legStrat.includes('Bear put');

  // ── Volatility Score (0-100) ──
  // Credit sellers want rich vol. Debit buyers want cheap vol. Reversed wants cheap vol (buying gamma).
  let volScore = 50;
  if (isCredit) {
    // Credit strategies: rich vol = excellent (selling expensive options)
    if (ivHvRatio > 1.3) volScore = 95;
    else if (ivHvRatio > 1.1) volScore = 80;
    else if (ivHvRatio > 0.9) volScore = 60;
    else if (ivHvRatio > 0.8) volScore = 40;
    else volScore = 20;
    // Rich short-term vol bonus for credit sellers
    if (vixGapPct > 0.25) volScore = Math.min(100, volScore + 10);
    else if (vixGapPct > 0.10) volScore = Math.min(100, volScore + 5);
    else if (vixGapPct < -0.10) volScore = Math.max(0, volScore - 10);
  } else if (isReversed) {
    // Reversed condor: buying vol — want CHEAP vol (inverted scale)
    if (ivHvRatio < 0.8) volScore = 95;
    else if (ivHvRatio < 0.9) volScore = 80;
    else if (ivHvRatio < 1.1) volScore = 60;
    else if (ivHvRatio < 1.3) volScore = 40;
    else volScore = 20;
    // Cheap short-term vol bonus for vol buyers
    if (vixGapPct < -0.10) volScore = Math.min(100, volScore + 10);
    else if (vixGapPct > 0.10) volScore = Math.max(0, volScore - 10);
  } else if (isDebitBfly) {
    // Debit butterflies: want vol near fair (not too rich or cheap)
    // Sweet spot is IV/HV near 1.0 — paying fair for the structure
    if (ivHvRatio > 0.85 && ivHvRatio < 1.15) volScore = 90;
    else if (ivHvRatio > 0.75 && ivHvRatio < 1.25) volScore = 70;
    else if (ivHvRatio < 0.75) volScore = 55; // cheap vol — butterfly shape less defined
    else volScore = 40; // rich vol — paying too much
    // Cheap short-term helps (buying near-term options)
    if (vixGapPct < -0.10) volScore = Math.min(100, volScore + 10);
    else if (vixGapPct > 0.25) volScore = Math.max(0, volScore - 10);
  } else {
    // Debit spreads: want cheap vol (buying)
    if (ivHvRatio < 0.8) volScore = 90;
    else if (ivHvRatio < 0.9) volScore = 75;
    else if (ivHvRatio < 1.1) volScore = 60;
    else if (ivHvRatio < 1.3) volScore = 40;
    else volScore = 25;
  }
  const volGrade = volScore >= 80 ? 'Rich' : volScore >= 60 ? 'Fair' : 'Cheap';

  // ── Structure Score (0-100) ──
  let structScore = 50;
  if (D > 0 && netCreditDebit !== 0) {
    const absNCD = Math.abs(netCreditDebit);
    const ratio = absNCD / D;

    if (isCredit) {
      // Credit: higher credit = better
      if (ratio > 0.40) structScore = 95;
      else if (ratio > 0.30) structScore = 85;
      else if (ratio > 0.20) structScore = 70;
      else if (ratio > 0.10) structScore = 55;
      else structScore = 35;
    } else if (isDebitBfly) {
      // Debit butterfly: evaluate based on debit relative to wing width
      // <25% Excellent, 25-40% Good, 40-55% Marginal, >55% No Trade
      if (win > 0 && risk > 0) {
        const rr = win / risk;
        if (rr > 0.50) structScore = 95;
        else if (rr > 0.30) structScore = 80;
        else if (rr > 0.20) structScore = 65;
        else if (rr > 0.10) structScore = 50;
        else structScore = 30;
      } else if (ratio < 0.25) structScore = 95;      // Excellent
      else if (ratio < 0.40) structScore = 80;         // Good
      else if (ratio < 0.55) structScore = 55;         // Marginal
      else structScore = 25;                           // No Trade
    } else if (isReversed) {
      // Reversed condor: want low debit relative to potential payout
      if (ratio < 0.30) structScore = 95;
      else if (ratio < 0.45) structScore = 80;
      else if (ratio < 0.60) structScore = 65;
      else structScore = 35;
    } else {
      // Debit spreads: lower debit = better
      if (ratio < 0.50) structScore = 90;
      else if (ratio < 0.65) structScore = 75;
      else if (ratio < 0.80) structScore = 55;
      else structScore = 30;
    }
  }

  // Greeks adjustments (apply to all strategies)
  if (hasGreeks && theta > 0 && Math.abs(delta) > 0 && atr5 > 0) {
    const tEdge = theta / (Math.abs(delta) * atr5);
    if (isCredit) {
      // Credit sellers want high theta edge
      if (tEdge > 0.30) structScore = Math.min(100, structScore + 10);
      else if (tEdge > 0.15) structScore = Math.min(100, structScore + 5);
      else if (tEdge < 0.05) structScore = Math.max(0, structScore - 15);
    } else {
      // Debit buyers: theta edge less relevant, but very low is still bad
      if (tEdge < 0.03) structScore = Math.max(0, structScore - 5);
    }
  }
  if (hasGreeks && gamma > 0 && theta > 0 && atr5 > 0) {
    const gRisk = gamma * atr5 / theta;
    if (isCredit) {
      // Credit sellers fear gamma
      if (gRisk > 1.20) structScore = Math.max(0, structScore - 15);
      else if (gRisk > 0.70) structScore = Math.max(0, structScore - 5);
      else if (gRisk < 0.30) structScore = Math.min(100, structScore + 5);
    } else if (isReversed) {
      // Reversed condor WANTS gamma — high gamma is good
      if (gRisk > 1.20) structScore = Math.min(100, structScore + 10);
      else if (gRisk > 0.70) structScore = Math.min(100, structScore + 5);
    }
  }
  const structGrade = structScore >= 80 ? 'Excellent' : structScore >= 60 ? 'Good' : structScore >= 40 ? 'Fair' : 'Poor';

  // ── Regime Score (0-100) ──
  let regimeScore = 50;
  if (moveConsumed > 0) {
    if (isDebitBfly) {
      // Butterflies want high move consumed (exhaustion = pinning)
      if (moveConsumed > 0.80) regimeScore = 95;
      else if (moveConsumed > 0.60) regimeScore = 80;
      else if (moveConsumed > 0.40) regimeScore = 55;
      else regimeScore = 30;
    } else if (isReversed) {
      // Reversed condor wants LOW move consumed (room for big move)
      if (moveConsumed < 0.20) regimeScore = 95;
      else if (moveConsumed < 0.35) regimeScore = 80;
      else if (moveConsumed < 0.50) regimeScore = 60;
      else regimeScore = 25; // too much already consumed — breakout less likely
    } else if (isCredit) {
      // Credit structures want moderate — not too much (gap risk) not too little (still moving)
      if (moveConsumed > 0.30 && moveConsumed < 0.60) regimeScore = 90;
      else if (moveConsumed < 0.30) regimeScore = 70;
      else if (moveConsumed < 0.80) regimeScore = 55;
      else regimeScore = 35;
    } else {
      // Debit spreads want low consumed (room for directional move)
      if (moveConsumed < 0.25) regimeScore = 90;
      else if (moveConsumed < 0.40) regimeScore = 75;
      else if (moveConsumed < 0.60) regimeScore = 55;
      else regimeScore = 30;
    }
  }

  // Compression adjustments (strategy-specific)
  if (comp !== null) {
    if (isDebitBfly && isCompressing) regimeScore = Math.min(100, regimeScore + 10);
    else if (isDebitBfly && isExpanding) regimeScore = Math.max(0, regimeScore - 15);
    else if (isReversed && isExpanding) regimeScore = Math.min(100, regimeScore + 10); // reversed wants expansion
    else if (isReversed && isCompressing) regimeScore = Math.max(0, regimeScore - 10);
    else if (isCredit && isCompressing) regimeScore = Math.min(100, regimeScore + 5);
    else if (isCredit && isExpanding) regimeScore = Math.max(0, regimeScore - 5);
  }

  // VWAP alignment
  if (confirmed) regimeScore = Math.min(100, regimeScore + 5);
  else if (diverges) regimeScore = Math.max(0, regimeScore - 5);

  // Gamma strike proximity (matters most for butterflies)
  if (gamDist !== null) {
    if (isDebitBfly) {
      if (gamDist < 0.5) regimeScore = Math.min(100, regimeScore + 15);
      else if (gamDist < 1.0) regimeScore = Math.min(100, regimeScore + 8);
      else if (gamDist > 2.0) regimeScore = Math.max(0, regimeScore - 10);
    } else {
      if (gamDist < 0.5) regimeScore = Math.min(100, regimeScore + 5);
      else if (gamDist < 1.0) regimeScore = Math.min(100, regimeScore + 3);
    }
  }

  // Trend pattern adjustments
  if (trendPattern === 'continuation' && (isCredit || isDebitBfly)) regimeScore = Math.max(0, regimeScore - 10); // trending = bad for range structures
  if (trendPattern === 'continuation' && (isReversed || isDebitSpread)) regimeScore = Math.min(100, regimeScore + 10); // trending = good for breakout/directional
  if (trendPattern === 'range' && (isCredit || isDebitBfly)) regimeScore = Math.min(100, regimeScore + 5);

  const regimeGrade = regimeScore >= 80 ? 'Excellent' : regimeScore >= 60 ? 'Good' : regimeScore >= 40 ? 'Fair' : 'Poor';

  // ── Composite Fair Value Score — strategy-specific weights ──
  let fvWeightVol, fvWeightStruct, fvWeightRegime;
  if (isCredit) {
    // Credit strategies: vol matters most (selling premium), regime second
    fvWeightVol = 0.35; fvWeightStruct = 0.25; fvWeightRegime = 0.40;
  } else if (isReversed) {
    // Reversed: vol critical (buying cheap), regime critical (need breakout)
    fvWeightVol = 0.35; fvWeightStruct = 0.20; fvWeightRegime = 0.45;
  } else if (isDebitBfly) {
    // Butterflies: regime most important (pinning conditions), structure second (good price)
    fvWeightVol = 0.20; fvWeightStruct = 0.30; fvWeightRegime = 0.50;
  } else {
    // Debit spreads: balanced
    fvWeightVol = 0.30; fvWeightStruct = 0.30; fvWeightRegime = 0.40;
  }

  const fairValueScore = Math.round(volScore * fvWeightVol + structScore * fvWeightStruct + regimeScore * fvWeightRegime);
  const fairValueGrade = fairValueScore >= 90 ? 'Excellent' : fairValueScore >= 80 ? 'Good' : fairValueScore >= 70 ? 'Marginal' : 'No Trade';

  // ═══════════════════════════════════════
  //  PAYOFF DIAGRAM — Generic engine
  //  Uses net credit/debit + leg intrinsic values
  // ═══════════════════════════════════════
  let payoff = null;
  const ncd = netCreditDebit; // per-share net credit (positive) or debit (negative)
  if (price > 0 && legs.length >= 2) {
    const strikes = legs.map(l => l.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const range = maxStrike - minStrike || 10;
    const plotMin = Math.round(minStrike - range * 1.0);
    const plotMax = Math.round(maxStrike + range * 1.0);
    const step = roundTo || 1;

    // For spreads with dual EM suggestions (4 legs with VIX labels), use first pair
    const payoffLegs = (legs.length === 4 && legs[0]?.label?.includes('VIX')) ? legs.slice(0, 2) : legs;

    // Parse legs into structured format
    const parsedLegs = payoffLegs.map(l => {
      const label = l.label.toLowerCase();
      return {
        strike: l.strike,
        type: label.includes('call') ? 'call' : 'put',
        side: (label.includes('short') || label.includes('sell')) ? 'sell' : 'buy',
        qty: label.includes('x2') ? 2 : 1
      };
    });

    // Calculate payoff at each price point
    // P&L = sum of (intrinsic × side × qty) + net credit/debit
    // For SELL: you receive premium, lose on intrinsic
    // For BUY: you pay premium, gain on intrinsic
    const multiplier = 100; // options multiplier

    const points = [];
    for (let px = plotMin; px <= plotMax; px += step) {
      let pnl = 0;
      parsedLegs.forEach(leg => {
        let intrinsic = 0;
        if (leg.type === 'call') intrinsic = Math.max(0, px - leg.strike);
        else intrinsic = Math.max(0, leg.strike - px);
        // Sell = short = negative intrinsic (you pay out), Buy = long = positive intrinsic (you receive)
        const sign = leg.side === 'sell' ? -1 : 1;
        pnl += sign * leg.qty * intrinsic;
      });
      // Add net credit/debit (per share)
      // ncd > 0 means credit received (shifts curve up)
      // ncd < 0 means debit paid (shifts curve down)
      const totalPnl = (pnl + ncd) * multiplier;
      points.push({ price: px, pnl: totalPnl });
    }

    const pnls = points.map(p => p.pnl);
    const maxProfit = Math.max(...pnls);
    const maxLossCalc = Math.min(...pnls);

    // Find breakevens (where P&L crosses zero)
    const breakevens = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if ((prev.pnl <= 0 && curr.pnl > 0) || (prev.pnl > 0 && curr.pnl <= 0)) {
        const be = prev.price + (0 - prev.pnl) / (curr.pnl - prev.pnl) * (curr.price - prev.price);
        breakevens.push(Math.round(be * 10) / 10);
      }
    }

    // Profit band (price range where P&L > 0)
    const profitPrices = points.filter(p => p.pnl > 0).map(p => p.price);
    const profitBandLow = profitPrices.length > 0 ? Math.min(...profitPrices) : 0;
    const profitBandHigh = profitPrices.length > 0 ? Math.max(...profitPrices) : 0;
    const profitBandWidth = profitBandHigh - profitBandLow;

    payoff = {
      points, maxProfit, maxLoss: maxLossCalc, breakevens,
      profitBandLow, profitBandHigh, profitBandWidth,
      plotMin, plotMax, ncd,
      legs: parsedLegs
    };
  }

  // ── EV calculation (tiered) ──
  // Old model used max profit × POP − max loss × (1−POP), which is too punitive:
  // you rarely capture max profit and rarely eat max loss. Instead:
  //   Tier 1 (estimate): scale max profit/loss by per-strategy capture fractions
  //                      to approximate the average winner / average loser.
  //   Tier 3 (measured): once >= 50 closed trades for this strategy exist, use
  //                      the realized winRate / avgWin / avgLoss directly.
  //   POP term: blend model POP early → realized win% as data accumulates.
  const EV_HISTORY_THRESHOLD = 50;

  // Resolve the realized-history slice for this strategy (if a map was passed).
  const history = historyInput || (historyByStrategy ? historyByStrategy[legStrat] : null);

  // Per-strategy capture fractions { winCap, lossCap } as a share of max.
  // winCap  = typical fraction of MAX PROFIT actually realized on winners.
  // lossCap = typical fraction of MAX LOSS actually given back on losers.
  // Butterflies: pin is rare, so winCap is low; managed exits keep lossCap < 1.
  // Condors/credit spreads: take-profit at ~50% credit, stops cap the loss.
  function captureFractions(s) {
    if (s === 'Standard butterfly' || s === 'Asymmetric butterfly') return { winCap: 0.28, lossCap: 0.45 };
    if (s === 'Broken wing butterfly' || s.includes('BWB')) return { winCap: 0.30, lossCap: 0.50 };
    if (s === 'Iron butterfly') return { winCap: 0.35, lossCap: 0.55 };
    if (s.includes('Iron Condor') || s === 'Chicken condor') return { winCap: 0.50, lossCap: 0.70 };
    if (s.includes('Bull put') || s.includes('Bear call')) return { winCap: 0.55, lossCap: 0.75 }; // credit spreads
    if (s.includes('Bull call') || s.includes('Bear put')) return { winCap: 0.50, lossCap: 0.60 }; // debit spreads
    if (s.includes('Reversed') || s === 'Long Condor - Reversed') return { winCap: 0.45, lossCap: 0.55 };
    return { winCap: 0.40, lossCap: 0.60 }; // sensible default
  }

  const { winCap, lossCap } = captureFractions(legStrat);

  // Estimated average winner / loser (dollars per contract) from the structure.
  const estAvgWin = win * winCap;
  const estAvgLoss = risk * lossCap;

  // Decide estimate vs measured, and blend the probability term.
  const histTrades = history?.trades || 0;
  const hasMeasured = histTrades >= EV_HISTORY_THRESHOLD
    && history?.avgWin > 0 && history?.avgLoss > 0;
  // Blend weight ramps 0→1 over the first threshold of trades.
  const wMeasured = Math.min(1, histTrades / EV_HISTORY_THRESHOLD);

  // Win probability: model POP blended toward realized win% as data grows.
  const modelWinP = popFrac;
  const realWinP = (history?.winRate > 0) ? history.winRate : modelWinP;
  const winP = (history?.winRate > 0)
    ? (1 - wMeasured) * modelWinP + wMeasured * realWinP
    : modelWinP;

  // Average win/loss magnitudes: measured if available, else estimate.
  const avgWinUsed = hasMeasured ? history.avgWin : estAvgWin;
  const avgLossUsed = hasMeasured ? history.avgLoss : estAvgLoss;

  // Loss side: when P(max loss) is known and we're estimating, split the loss
  // distribution into a MAX-LOSS component (probability pMaxLoss × full risk)
  // and a PARTIAL-LOSS component (the rest of the loss probability × estimated
  // partial loss). This is more accurate than a single average loss because a
  // butterfly's rare-but-large tail is priced explicitly rather than smeared in.
  let lossTerm, evMode2 = 'flat';
  const lossProb = 1 - winP;
  if (!hasMeasured && pMaxLoss != null && lossProb > 0 && risk > 0) {
    const pTail = Math.min(pMaxLoss, lossProb);            // capped at total loss prob
    const pPartial = Math.max(0, lossProb - pTail);
    const partialLoss = risk * (lossCap * 0.6);            // partial losers give back less
    lossTerm = pTail * risk + pPartial * partialLoss;      // absolute expected loss $
    evMode2 = 'distribution';
  } else {
    lossTerm = lossProb * avgLossUsed;                     // original flat model
  }

  const ev = (avgWinUsed > 0 && winP > 0)
    ? (winP * avgWinUsed) - lossTerm
    : 0;

  // Surface how EV was derived (for the UI to show "estimated" vs "measured").
  const evBasis = {
    mode: hasMeasured ? 'measured' : 'estimated',
    lossModel: evMode2,
    pMaxLoss: pMaxLoss != null ? +(pMaxLoss).toFixed(4) : null,
    historyTrades: histTrades,
    threshold: EV_HISTORY_THRESHOLD,
    winCap, lossCap,
    winP, avgWin: avgWinUsed, avgLoss: avgLossUsed,
    maxWin: win, maxLoss: risk
  };

  // ═══════════════════════════════════════
  //  SHARPE-ADJUSTED KELLY SIZING
  // ═══════════════════════════════════════
  // EXPECTED-LOSS Kelly (Jul 2026): the old formula used win / (risk/2) — max
  // profit over a crude half-max-loss fudge, which over-penalised structures
  // whose max loss is large but improbable (butterflies, far-winged condors).
  // Now W/L ratio uses EXPECTED win vs EXPECTED loss, where expected loss is
  // driven by P(max loss). This varies naturally per strategy (no hand-tuning)
  // because P(max loss) and capture fractions already differ per structure.
  // Expected loss per LOSING trade = lossTerm / lossProb (falls back to the old
  // half-risk when P(max loss) / EV inputs aren't available).
  const lossProbK = 1 - winP;
  const expectedLossPerLoss = (lossProbK > 0 && lossTerm > 0)
    ? lossTerm / lossProbK           // avg $ lost on a losing trade (tail-weighted)
    : (risk / 2);                    // fallback: old half-risk behaviour
  const expectedWin = avgWinUsed > 0 ? avgWinUsed : win;
  const wlRatio = expectedLossPerLoss > 0 ? expectedWin / expectedLossPerLoss : 0;
  // Kelly on realised win probability (winP already blends POP → realised win%).
  const rawKelly = wlRatio > 0 ? Math.max(0, winP - (1 - winP) / wlRatio) : 0;
  // Breakeven POP / margin still reference the true structure economics.
  const halfRisk = risk / 2;
  const bePop = (win + risk) > 0 ? risk / (win + risk) : 0;
  const popMargin = bePop > 0 && popFrac > 0 ? popFrac / bePop : 0;

  // Volatility factor (from VIX1D)
  let volFactor = 1.0;
  if (vix1d > 0) {
    if (vix1d < 12) volFactor = 1.0;
    else if (vix1d < 18) volFactor = 0.75;
    else if (vix1d < 25) volFactor = 0.50;
    else volFactor = 0.25;
  } else if (vix > 0) {
    if (vix < 15) volFactor = 1.0;
    else if (vix < 20) volFactor = 0.75;
    else if (vix < 25) volFactor = 0.50;
    else volFactor = 0.25;
  }

  // Sharpe factor — EV per dollar risked
  // Sharpe proxy = EV / risk (positive = edge, negative = no edge)
  const sharpeProxy = risk > 0 ? ev / risk : 0;
  let sharpeFactor = 1.0;
  if (sharpeProxy > 0.30) sharpeFactor = 1.0;       // strong edge
  else if (sharpeProxy > 0.15) sharpeFactor = 0.75;  // decent edge
  else if (sharpeProxy > 0.05) sharpeFactor = 0.50;  // marginal edge
  else if (sharpeProxy > 0) sharpeFactor = 0.35;     // weak edge
  else sharpeFactor = 0.25;                           // negative EV

  // Strategy-specific sizing modifier — SHRUNK (Jul 2026).
  // Tail risk is now captured in the Kelly W/L ratio via expected loss (P(max
  // loss)), so this modifier no longer needs to penalise tails — doing so would
  // double-count. It now only handles RESIDUAL concerns Kelly doesn't see:
  // gamma/pin risk, fill quality, and behavioural discipline. Values moved
  // toward 1.0; the steepest (reversed condor) kept lowest for its low POP.
  let stratModifier = 1.0;
  let stratModReason = 'Standard';
  if (legStrat.includes('Iron Condor') || legStrat.includes('Chicken')) {
    stratModifier = 0.95; stratModReason = 'Credit condor — gamma near shorts';
  } else if (legStrat === 'Iron butterfly') {
    stratModifier = 0.95; stratModReason = 'Iron fly — pin/gamma risk';
  } else if (legStrat === 'Standard butterfly' || legStrat === 'Asymmetric butterfly') {
    stratModifier = 1.00; stratModReason = 'Butterfly — capped debit';
  } else if (legStrat === 'Broken wing butterfly') {
    stratModifier = 0.92; stratModReason = 'BWB — fill/gamma';
  } else if (legStrat === 'Long Condor - Reversed') {
    stratModifier = 0.80; stratModReason = 'Reversed condor — low POP, preserve capital';
  } else if (legStrat.includes('Bull put') || legStrat.includes('Bear call') || legStrat.includes('Credit')) {
    stratModifier = 0.95; stratModReason = 'Credit spread — gamma near short';
  } else if (legStrat.includes('Bull call') || legStrat.includes('Bear put') || legStrat.includes('Debit')) {
    stratModifier = 1.00; stratModReason = 'Debit spread — capped risk';
  }

  // Adjusted Kelly = raw Kelly × vol factor × Sharpe factor × strategy modifier
  const adjustedKelly = rawKelly * volFactor * sharpeFactor * stratModifier;
  const kelly = adjustedKelly;
  const kellyDollar = bankroll > 0 ? Math.min(kelly * bankroll, bankroll * 0.30) : 0;
  const kellyRisk = kelly * bankroll;
  // SAFETY RAIL: contracts are sized so total position risk at TRUE max loss
  // (contracts × risk, where risk = full max loss per contract) never exceeds
  // Kelly $, maxLoss, or maxOpen. Expected-loss Kelly can size larger, but this
  // cap guarantees solvency on the rare day price blows through a wing.
  const riskCap = maxOpen > 0 ? Math.min(kellyRisk, maxLoss, maxOpen) : Math.min(kellyRisk, maxLoss);
  const fullC = risk > 0 ? Math.max(1, Math.floor(riskCap / risk)) : 1;
  const halfC = Math.max(1, Math.floor(fullC / 2));
  const vixOvC = vixHigh ? Math.max(1, Math.floor(fullC * 0.5)) : fullC;
  const contracts = setup === 'B Setup' ? halfC : (vixHigh ? vixOvC : fullC);
  const maxRisk = contracts * risk;
  const kellyOverRisk = risk > 0 && kellyDollar > 0 && risk > kellyDollar;

  // ── Greeks analysis ──
  let greeks = null;
  if (hasGreeks && atr > 0) {
    const absDelta = Math.abs(delta);
    const tEdge = absDelta * atr > 0 ? theta / (absDelta * atr) : 0;
    const gRisk = theta > 0 ? (gamma * atr) / theta : 0;
    // Max tolerable move: how far price can move before theta earned is consumed
    // theta is daily ($), hours is actual hours remaining to 4pm ET
    // Theta earned in remaining time = theta × (hours / 5.5)
    // 0DTE target close at 3pm ET = 5.5 trading hours from 9:30am
    const hoursUsed = hours > 0 ? hours : 5.5; // fallback to full 0DTE session
    const thetaRemaining = theta * (hoursUsed / 5.5);
    const dsMax = absDelta > 0 ? thetaRemaining / absDelta : 0;
    const dsATR = atr > 0 ? dsMax / atr : 0;

    // Theta edge interpretation
    const tEdgeSignal = tEdge < 0.05 ? 'weak' : tEdge < 0.15 ? 'marginal' : tEdge < 0.30 ? 'solid' : tEdge < 0.50 ? 'strong' : 'pinning';
    const tEdgeAction = tEdge < 0.05 ? 'Do not trade — one candle erases hours of theta'
      : tEdge < 0.15 ? 'Use only on A+ setup with low realised vol'
      : tEdge < 0.30 ? 'Preferred zone — good reward-to-gamma-risk'
      : tEdge < 0.50 ? 'Excellent if Gamma Risk < 0.7'
      : 'Check Gamma Risk — looks great until it explodes';

    // Gamma risk interpretation
    const gRiskSignal = gRisk < 0.30 ? 'low' : gRisk < 0.70 ? 'moderate' : gRisk < 1.20 ? 'elevated' : 'high';
    const gRiskAction = gRisk < 0.30 ? 'Safe to hold — minimal whipsaw risk'
      : gRisk < 0.70 ? 'Acceptable — watch if IV spikes'
      : gRisk < 1.20 ? 'Reduce size or tighten profit target'
      : 'Avoid or exit — gamma cliff risk';

    // Max tolerable move interpretation
    const dsSignal = dsATR > 1.0 ? 'strong' : dsATR > 0.50 ? 'good' : dsATR > 0.25 ? 'marginal' : 'thin';
    const dsAction = dsATR > 1.0 ? 'Theta dominates under normal movement'
      : dsATR > 0.50 ? 'Theta holds unless vol expands significantly'
      : dsATR > 0.25 ? 'A+ setup only, low realised vol, tighten target'
      : 'Avoid or cut size sharply — theta cannot compensate';

    // Sweet spot check
    const sweetSpot = tEdge >= 0.15 && tEdge <= 0.40 && gRisk < 0.70 && Math.abs(delta) >= 5 && Math.abs(delta) <= 15;

    // ── Directional Edge Framework ──
    // Measures whether price movement or time decay will dominate
    const remainingMove = Math.max(0, em - (moveConsumed * em)); // Expected remaining move in points
    const directionalGain = Math.abs(delta) * remainingMove; // $ directional P&L potential
    const thetaPressure = thetaRemaining; // $ theta earned until planned exit

    // Edge Ratio = Directional Gain / Theta Pressure
    const edgeRatio = thetaPressure > 0 ? directionalGain / thetaPressure : directionalGain > 0 ? 99 : 0;

    // Time-adjusted thresholds — tighten through the day
    let edgeThreshold = 2.0; // default
    if (hoursUsed <= 1) edgeThreshold = 1.0;
    else if (hoursUsed <= 2) edgeThreshold = 1.2;
    else if (hoursUsed <= 3) edgeThreshold = 1.5;
    else if (hoursUsed <= 4) edgeThreshold = 2.0;
    else edgeThreshold = 2.5;

    // Strategy-specific interpretation
    const isCreditStrat = legStrat.includes('Iron Condor') || legStrat === 'Iron butterfly'
      || legStrat.includes('Bull put') || legStrat.includes('Bear call') || legStrat === 'Chicken condor';
    const isDebitDir = legStrat.includes('Bull call') || legStrat.includes('Bear put');
    const isBflyCondor = legStrat.includes('butterfly') || legStrat.includes('Butterfly')
      || legStrat.includes('BWB') || legStrat.includes('Broken') || legStrat.includes('Reversed');

    let edgeSignal, edgeAction, edgePhase;
    if (isCreditStrat) {
      // Credit sellers WANT low ratio — theta should dominate
      if (edgeRatio < 0.7) { edgeSignal = 'excellent'; edgeAction = 'Theta dominates — ideal for premium selling'; }
      else if (edgeRatio < 1.0) { edgeSignal = 'good'; edgeAction = 'Theta still stronger — favourable'; }
      else if (edgeRatio < 1.5) { edgeSignal = 'marginal'; edgeAction = 'Directional risk rising — watch closely'; }
      else { edgeSignal = 'poor'; edgeAction = 'Move likely to overcome theta — avoid or hedge'; }
      edgePhase = 'theta-dominant';
    } else if (isDebitDir) {
      // Debit directional WANT high ratio — move should dominate
      if (edgeRatio > 2.5) { edgeSignal = 'excellent'; edgeAction = 'Strong remaining move vs decay — directional edge'; }
      else if (edgeRatio > 1.5) { edgeSignal = 'good'; edgeAction = 'Move still outpacing theta — proceed'; }
      else if (edgeRatio > 1.0) { edgeSignal = 'marginal'; edgeAction = 'Edge thinning — tighten profit target'; }
      else { edgeSignal = 'poor'; edgeAction = 'Theta consuming edge — close or roll'; }
      edgePhase = 'move-dominant';
    } else if (isBflyCondor) {
      // Butterflies/condors want TRANSITION: high ratio early (move to body) → low ratio late (theta collects)
      if (moveConsumed < 0.4) {
        // Early phase — need move toward body
        if (edgeRatio > 1.5) { edgeSignal = 'excellent'; edgeAction = 'Move toward body still likely — good entry'; }
        else if (edgeRatio > 1.0) { edgeSignal = 'good'; edgeAction = 'Moderate directional edge — acceptable'; }
        else { edgeSignal = 'marginal'; edgeAction = 'May not reach body — check if already near target'; }
        edgePhase = 'approach';
      } else if (moveConsumed < 0.7) {
        // Transition phase — near body
        if (edgeRatio >= 0.7 && edgeRatio <= 1.5) { edgeSignal = 'excellent'; edgeAction = 'Transition zone — price near body, theta building'; }
        else if (edgeRatio > 1.5) { edgeSignal = 'good'; edgeAction = 'Still moving — watch for overshoot'; }
        else { edgeSignal = 'good'; edgeAction = 'Theta taking over — body reached, hold for decay'; }
        edgePhase = 'transition';
      } else {
        // Late phase — want theta to dominate
        if (edgeRatio < 0.7) { edgeSignal = 'excellent'; edgeAction = 'Theta dominating — collect remaining value'; }
        else if (edgeRatio < 1.0) { edgeSignal = 'good'; edgeAction = 'Mostly theta now — hold to target'; }
        else { edgeSignal = 'marginal'; edgeAction = 'Unexpected movement — consider closing early'; }
        edgePhase = 'collection';
      }
    } else {
      // Default
      if (edgeRatio > 2.0) { edgeSignal = 'excellent'; edgeAction = 'Direction dominates'; }
      else if (edgeRatio > 1.0) { edgeSignal = 'good'; edgeAction = 'Balanced'; }
      else { edgeSignal = 'marginal'; edgeAction = 'Theta dominant'; }
      edgePhase = 'neutral';
    }

    greeks = { tEdge, gRisk, dsMax, dsATR, tEdgeSignal, tEdgeAction, gRiskSignal, gRiskAction, dsSignal, dsAction, sweetSpot,
      // Directional Edge
      directionalGain, thetaPressure, edgeRatio, edgeThreshold, edgeSignal, edgeAction, edgePhase,
      remainingMove, isCreditStrat, isDebitDir, isBflyCondor
    };
  }

  // ── Warnings ──
  const blockers = [];
  const warnings = [];
  const missingSize = win <= 0 || risk <= 0 || popFrac <= 0;
  let hardBlocker = '';
  if (!hasPrice) hardBlocker = 'Enter underlying price to generate a decision';

  if (greeks && greeks.tEdge < 0.05) blockers.push('Theta edge too weak');
  if (greeks && greeks.gRisk > 1.20) blockers.push('Gamma risk too high');
  if (vixGap < -0.10) warnings.push('VIX1D cheap — favour long gamma (BWB, Long Condor)');
  if (vixGap > 0.25) warnings.push('VIX1D extremely rich — verify no event risk');
  if (vixHigh) warnings.push('VIX >25 — half-size override');
  if (setup === 'B Setup') warnings.push('B setup — half Kelly');
  if (!missingSize && kelly <= 0) warnings.push('Kelly negative — edge insufficient, minimum 1 contract');
  if (moveConsumed > 0.90 && isDirectional) warnings.push('Move >90% consumed — avoid chasing directional');
  if (moveConsumed > 0.80 && isCompressing) warnings.push('Vol exhausted + compression — butterfly/BWB territory');
  if (vwapOverextended) warnings.push(`Price ${(vwapDistPctEM*100).toFixed(0)}% EM from VWAP — pullback risk`);
  if (diverges) warnings.push('15m VWAP diverges from 5m — lower conviction');

  // Debit/wing ratio check for butterflies
  if (isDebitBfly && D > 0 && netCreditDebit < 0) {
    const debitWingRatio = Math.abs(netCreditDebit) / D;
    if (debitWingRatio > 0.55) {
      blockers.push(`Debit ${(debitWingRatio*100).toFixed(0)}% of wing width — too expensive (>55%)`);
    } else if (debitWingRatio > 0.40) {
      warnings.push(`Debit ${(debitWingRatio*100).toFixed(0)}% of wing width — marginal value (40-55%)`);
    }
  }
  if (overextendedWarning) warnings.push('Strong direction + overextended — consider pullback');
  if (hasOvernight && overnightMovePct > 0.60 && isDirectional) warnings.push(`Overnight consumed ${(overnightMovePct*100).toFixed(0)}% EM — limited room`);
  if (trendPattern === 'continuation' && totalDirConsumed > 0.80) warnings.push('Continuation trend — ' + (totalDirConsumed*100).toFixed(0) + '% consumed directionally — avoid chasing');
  if (trendPattern === 'reversal' && moveConsumedDir > 0.30) warnings.push('Reversal detected — overnight ' + overnightDir + ' but cash ' + cashDir + ' — confirm before directional');

  // ── Decision ──
  let decision, decisionClass;
  if (hardBlocker) { decision = 'No trade'; decisionClass = 'nogo'; }
  else if (setup === 'No setup') { decision = 'No trade'; decisionClass = 'nogo'; }
  else if (missingSize || bestRating === 'NO TRADE' || blockers.length) { decision = missingSize ? 'Enter sizing' : 'Review signals'; decisionClass = 'nogo'; }
  else if (warnings.length) { decision = 'Trade with caution'; decisionClass = 'warn'; }
  else { decision = 'Trade'; decisionClass = 'go'; }

  return {
    // Signals
    vixGap, vixGrade, vixImplic, emVIX, emV1D, gapBandIdx,
    dirScore, dirLabel, aboveVWAP, vwapDiff,
    slope, slopeDirection, slope5, slope15, vwapDistPctEM, vwapOverextended, confirmed, diverges,
    rm, rmRatio, comp, isCompressing,
    gamDist, regime, regimeConds, regimeCommentary,
    // Overnight
    overnightMove, overnightDirMove, overnightRange, overnightDir, overnightRangePct, overnightMovePct,
    cashMove, cashDirMove, cashDir, gapAtOpen,
    moveConsumed, moveConsumedDir, moveConsumedRange, volRemaining,
    totalDirConsumed, totalRangeConsumed,
    trendPattern, trendStrength,
    // Strategy
    ratings: sorted, bestStrat, bestRating, legStrat, overrideStrategy,
    // Strikes
    legs, wingTxt, D, baseDistance, distMult,
    // Scoring
    setupScore, setup, criteria,
    pMaxLoss, pMaxLossLow, pMaxLossHigh, pMaxLossModel, pMaxLossDelta, pMaxLossSource,
    // Kelly (Sharpe-adjusted)
    kelly, rawKelly, adjustedKelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    volFactor, sharpeFactor, sharpeProxy, stratModifier, stratModReason,
    fullC, halfC, vixOvC, contracts, maxRisk, vixHigh,
    // EV & Payoff
    ev, evBasis, payoff, targetCredit, targetLabel, targetLow, targetHigh, targetMax, targetIsCredit,
    // Fair Value
    fairValueScore, fairValueGrade, volScore, volGrade, structScore, structGrade,
    regimeScore, regimeGrade, ivHvRatio, fvWeightVol, fvWeightStruct, fvWeightRegime,
    // Greeks
    greeks,
    // Decision
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    behaviour: MARKET_BEHAVIOUR_0DTE[legStrat] || ''
  };
}
