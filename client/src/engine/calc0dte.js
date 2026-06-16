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
    vix, vix1d, bankroll, startBR, risk, maxLoss, win, maxOpen, pop,
    theta, delta, gamma, hours, underlying,
    // Overnight inputs
    esOvernightHigh, esOvernightLow, esClose, priorDayClose, cashOpen, esEM } = inputs;

  const hasPrice = price > 0;
  const hasComp = atr5 > 0 && atr2h > 0;
  const hasGam = gamStrike > 0 && atr > 0;
  const hasGreeks = theta > 0 && delta > 0;
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
  const baseDistance = price > 0 ? Math.max(emVIX / 2, emV1D, em * 0.5) : 0;
  let distMult = 1.0;
  if (hasComp) { if (comp < 0.50) distMult = 0.8; else if (comp > 0.80) distMult = 1.25; }
  let D = baseDistance * distMult;
  const roundTo = underlying === 'SPX' ? 5 : (underlying === 'SPY' || underlying === 'QQQ' || underlying === 'IWM') ? 1 : 0.5;
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
      legs = [leg('Long put', p-2*D), leg('Short put', p-D), leg('Short call', p+D), leg('Long call', p+2*D)];
    } else if (legStrat === 'Chicken condor') {
      const tightW = D, wideW = D * 1.5;
      legs = dirScore >= 0
        ? [leg('Long put', p-wideW-D), leg('Short put', p-wideW), leg('Short call', p+tightW), leg('Long call', p+tightW+D)]
        : [leg('Long put', p-tightW-D), leg('Short put', p-tightW), leg('Short call', p+wideW), leg('Long call', p+wideW+D)];
    } else if (legStrat === 'Bull put spread') {
      // Two strike sets: EM(VIX)/2 based and EM(VIX1D) based
      const dVix = emVIX > 0 ? Math.max(emVIX / 2, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Short put (VIX)', p - dVix), leg('Long put (VIX)', p - dVix * 2),
        leg('Short put (VIX1D)', p - dV1d), leg('Long put (VIX1D)', p - dV1d * 2)
      ];
    } else if (legStrat === 'Bear call spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX / 2, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Short call (VIX)', p + dVix), leg('Long call (VIX)', p + dVix * 2),
        leg('Short call (VIX1D)', p + dV1d), leg('Long call (VIX1D)', p + dV1d * 2)
      ];
    } else if (legStrat === 'Bull call spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX / 2, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Long call (VIX)', p), leg('Short call (VIX)', p + dVix * 0.5),
        leg('Long call (VIX1D)', p), leg('Short call (VIX1D)', p + dV1d * 0.5)
      ];
    } else if (legStrat === 'Bear put spread') {
      const dVix = emVIX > 0 ? Math.max(emVIX / 2, roundTo * 2) : D;
      const dV1d = emV1D > 0 ? Math.max(emV1D, roundTo * 2) : D;
      legs = [
        leg('Long put (VIX)', p), leg('Short put (VIX)', p - dVix * 0.5),
        leg('Long put (VIX1D)', p), leg('Short put (VIX1D)', p - dV1d * 0.5)
      ];
    }
  }
  const isSpread = ['Bull put spread','Bear call spread','Bull call spread','Bear put spread'].includes(legStrat);
  const wingTxt = D > 0
    ? isSpread
      ? `EM(VIX)/2=${emVIX>0?(emVIX/2).toFixed(1):'--'} | EM(VIX1D)=${emV1D>0?emV1D.toFixed(1):'--'}`
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

  // 1. Compression signal (20)
  const isCentred = ['Iron Condor - Normal','Iron butterfly','Standard butterfly','Long Condor - Reversed'].includes(bestStrat);
  const isDirectional = ['Chicken condor','Broken wing butterfly','Asymmetric butterfly','Bull put spread','Bear call spread','Bull call spread','Bear put spread'].includes(bestStrat);
  let compPts;
  if (!hasComp) compPts = 7;
  else if (isCentred) compPts = comp<0.35?20:comp<0.50?16:comp<0.80?8:2;
  else if (isDirectional) compPts = comp>0.80?18:comp>0.50?14:comp>0.35?10:6;
  else compPts = comp<0.50?14:comp<0.80?10:5;
  setupScore += compPts;
  criteria.push({ label: `Compression ${hasComp?comp.toFixed(2):'--'}`, pts: compPts, max: 20 });

  // 2. Expected move consumed (20)
  let movePts;
  if (em <= 0) movePts = 7;
  else if (isCentred) {
    // Butterflies want high move consumed
    movePts = moveConsumed>0.80?20:moveConsumed>0.60?16:moveConsumed>0.40?10:moveConsumed>0.25?5:2;
  } else {
    // Spreads want low move consumed (room to run)
    movePts = moveConsumed<0.30?20:moveConsumed<0.50?16:moveConsumed<0.60?10:moveConsumed<0.80?5:0;
  }
  setupScore += movePts;
  criteria.push({ label: `Move consumed ${em>0?(moveConsumed*100).toFixed(0)+'%':'--'}`, pts: movePts, max: 20 });

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

  // ═══════════════════════════════════════
  //  PAYOFF & EV CALCULATIONS
  // ═══════════════════════════════════════
  let payoff = null;
  if (price > 0 && legs.length >= 2) {
    const strikes = legs.map(l => l.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const range = maxStrike - minStrike || 10;
    const plotMin = Math.round(minStrike - range * 0.8);
    const plotMax = Math.round(maxStrike + range * 0.8);
    const step = roundTo || 1;

    // For spreads with dual EM suggestions (4 legs = 2 sets), use first 2 legs
    const payoffLegs = (legs.length === 4 && legs[0]?.label?.includes('VIX')) ? legs.slice(0, 2) : legs;

    // Build payoff curve: intrinsic value at expiry
    // We calculate raw intrinsic, then calibrate so the curve matches
    // the user's win (max profit) and risk (max loss) amounts
    const rawPoints = [];
    for (let px = plotMin; px <= plotMax; px += step) {
      let pnl = 0;
      payoffLegs.forEach(l => {
        const isShort = l.label.toLowerCase().includes('short') || l.label.toLowerCase().includes('sell');
        const isCall = l.label.toLowerCase().includes('call');
        const isPut = l.label.toLowerCase().includes('put');
        const qty = l.label.includes('x2') ? 2 : 1;
        const sign = isShort ? -1 : 1;
        let intrinsic = 0;
        if (isCall) intrinsic = Math.max(0, px - l.strike);
        else if (isPut) intrinsic = Math.max(0, l.strike - px);
        pnl += sign * qty * intrinsic;
      });
      rawPoints.push({ price: px, pnl });
    }

    // Find raw max and min to calibrate against win/risk
    const rawPnls = rawPoints.map(p => p.pnl);
    const rawMax = Math.max(...rawPnls);
    const rawMin = Math.min(...rawPnls);

    // Calibrate: shift the curve so that
    //   max profit = win × 100 (in dollars)
    //   max loss = -risk × 100 (in dollars)
    // The shift = difference between raw max and user's win
    let shift = 0;
    if (win > 0 && rawMax !== rawMin) {
      // For credit trades: raw curve has max at some positive value, we shift to match win
      // For debit trades: raw curve has max at some positive value, we shift to match win
      // In both cases: shift so rawMax + shift = win (per share)
      shift = win - rawMax;
    }

    const points = rawPoints.map(p => ({
      price: p.price,
      pnl: (p.pnl + shift) * 100 // convert to dollars
    }));

    const pnls = points.map(p => p.pnl);
    const maxProfit = Math.max(...pnls);
    const maxLossCalc = Math.min(...pnls);

    // Find breakevens
    const breakevens = [];
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1];
      const curr = points[i];
      if ((prev.pnl <= 0 && curr.pnl > 0) || (prev.pnl > 0 && curr.pnl <= 0)) {
        const be = prev.price + (0 - prev.pnl) / (curr.pnl - prev.pnl) * (curr.price - prev.price);
        breakevens.push(Math.round(be * 10) / 10);
      }
    }

    // Profit band
    const profitPrices = points.filter(p => p.pnl > 0).map(p => p.price);
    const profitBandLow = profitPrices.length > 0 ? Math.min(...profitPrices) : 0;
    const profitBandHigh = profitPrices.length > 0 ? Math.max(...profitPrices) : 0;
    const profitBandWidth = profitBandHigh - profitBandLow;

    payoff = {
      points, maxProfit, maxLoss: maxLossCalc, breakevens,
      profitBandLow, profitBandHigh, profitBandWidth,
      plotMin, plotMax, shift
    };
  }

  // ── EV calculation ──
  // EV = (POP × win) - ((1-POP) × risk) — already in dollars per contract
  const ev = (win > 0 && risk > 0 && popFrac > 0)
    ? (popFrac * win) - ((1 - popFrac) * risk)
    : 0;

  // ═══════════════════════════════════════
  //  SHARPE-ADJUSTED KELLY SIZING
  // ═══════════════════════════════════════
  const halfRisk = risk / 2;
  const wlRatio = halfRisk > 0 ? win / halfRisk : 0;
  const rawKelly = wlRatio > 0 ? Math.max(0, popFrac - (1 - popFrac) / wlRatio) : 0;
  const bePop = halfRisk > 0 ? halfRisk / (win + halfRisk) : 0;
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

  // Adjusted Kelly = raw Kelly × vol factor × Sharpe factor
  const adjustedKelly = rawKelly * volFactor * sharpeFactor;
  const kelly = adjustedKelly; // use adjusted for all downstream
  const kellyDollar = bankroll > 0 ? Math.min(kelly * bankroll, bankroll * 0.30) : 0;
  const kellyRisk = kelly * bankroll;
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
    const tEdge = delta * atr > 0 ? theta / (delta * atr) : 0;
    const gRisk = theta > 0 ? (gamma * atr) / theta : 0;
    const dsMax = delta > 0 ? theta * (hours / 6.5) / delta : 0;
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

    greeks = { tEdge, gRisk, dsMax, dsATR, tEdgeSignal, tEdgeAction, gRiskSignal, gRiskAction, dsSignal, dsAction, sweetSpot };
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
    // Kelly (Sharpe-adjusted)
    kelly, rawKelly, adjustedKelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    volFactor, sharpeFactor, sharpeProxy,
    fullC, halfC, vixOvC, contracts, maxRisk, vixHigh,
    // EV & Payoff
    ev, payoff,
    // Greeks
    greeks,
    // Decision
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    behaviour: MARKET_BEHAVIOUR_0DTE[legStrat] || ''
  };
}
