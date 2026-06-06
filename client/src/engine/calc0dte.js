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
  const butterflyZone = moveConsumed > 0.60 && isCompressing;
  const spreadZone = moveConsumed < 0.60 && !isCompressing;

  let base;
  if (butterflyZone) {
    // High move consumed + compression: butterfly structures dominate
    base = ['MARGINAL','EXCELLENT','EXCELLENT','EXCELLENT','MARGINAL','EXCELLENT','GOOD'];
  } else if (rmRatio < 0.25) {
    base = ['GOOD','MARGINAL','GOOD','NO TRADE','EXCELLENT','NO TRADE','MARGINAL'];
  } else if (rmRatio < 0.50) {
    base = ['EXCELLENT','MARGINAL','MARGINAL','NO TRADE','EXCELLENT','GOOD','MARGINAL'];
  } else if (rmRatio < 0.75) {
    base = ['GOOD','EXCELLENT','MARGINAL','MARGINAL','GOOD','EXCELLENT','MARGINAL'];
  } else if (rmRatio < 1.00) {
    base = ['MARGINAL','EXCELLENT','EXCELLENT','EXCELLENT','MARGINAL','GOOD','GOOD'];
  } else if (isCompressing) {
    base = ['MARGINAL','EXCELLENT','MARGINAL','EXCELLENT','MARGINAL','GOOD','GOOD'];
  } else {
    base = ['GOOD','GOOD','MARGINAL','NO TRADE','NO TRADE','NO TRADE','NO TRADE'];
  }

  const ratings = base.slice();
  if (isStrong) {
    [3,4,5,6].forEach(i => { ratings[i] = degrade(ratings[i], 1); });
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
    // New overnight inputs
    esOvernightHigh, esOvernightLow, esClose, priorDayClose, cashOpen } = inputs;

  const hasPrice = price > 0;
  const hasComp = atr5 > 0 && atr2h > 0;
  const hasGam = gamStrike > 0 && atr > 0;
  const hasGreeks = theta > 0 && delta > 0;
  const popFrac = pop / 100;
  const hasOvernight = esOvernightHigh > 0 && esOvernightLow > 0 && priorDayClose > 0;
  const hasCashOpen = cashOpen > 0;

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

  // ── Overnight metrics ──
  const overnightMove = hasOvernight ? Math.abs(esClose - priorDayClose) : 0;
  const overnightRange = hasOvernight ? esOvernightHigh - esOvernightLow : 0;
  const overnightDir = hasOvernight ? (esClose > priorDayClose ? 'bullish' : esClose < priorDayClose ? 'bearish' : 'flat') : 'unknown';
  const overnightAboveVWAP = hasOvernight && esClose > (esOvernightHigh + esOvernightLow) / 2;
  const overnightAbovePrior = hasOvernight && esClose > priorDayClose;
  const overnightRangePct = em > 0 ? overnightRange / em : 0;
  const overnightMovePct = em > 0 ? overnightMove / em : 0;

  // ── Move consumed (overnight + cash session) ──
  const cashMove = rm;
  const totalMoveConsumed = em > 0 ? (overnightMove + cashMove) / em : (em > 0 ? rmRatio : 0);
  const moveConsumed = Math.min(totalMoveConsumed, 1.5); // cap at 150%
  const volRemaining = Math.max(0, 1 - moveConsumed);

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
    if (bestStrat === 'Iron butterfly') {
      legs = [leg('Long put (wing)', p-D), leg('Short put (body)', p), leg('Short call (body)', p), leg('Long call (wing)', p+D)];
    } else if (bestStrat === 'Standard butterfly') {
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-D), leg('Short call x2 (mid)', gs), leg('Long call (upper)', gs+D)]
        : [leg('Long put (upper)', gs+D), leg('Short put x2 (mid)', gs), leg('Long put (lower)', gs-D)];
    } else if (bestStrat === 'Broken wing butterfly') {
      const nearW = D, farW = Math.round(D * 1.75 / roundTo) * roundTo;
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-nearW), leg('Short call x2 (body)', gs), leg(`Long call (broken ${farW.toFixed(0)}pt)`, gs+farW)]
        : [leg('Long put (upper)', gs+nearW), leg('Short put x2 (body)', gs), leg(`Long put (broken ${farW.toFixed(0)}pt)`, gs-farW)];
    } else if (bestStrat === 'Asymmetric butterfly') {
      legs = dirScore >= 0
        ? [leg('Long call (lower)', gs-D), leg('Short call x2 (body)', gs), leg('Long call (1.5x upper)', gs+D*1.5)]
        : [leg('Long put (upper)', gs+D), leg('Short put x2 (body)', gs), leg('Long put (1.5x lower)', gs-D*1.5)];
    } else if (bestStrat === 'Iron Condor - Normal') {
      legs = [leg('Long put', p-2*D), leg('Short put', p-D), leg('Short call', p+D), leg('Long call', p+2*D)];
    } else if (bestStrat === 'Long Condor - Reversed') {
      legs = [leg('Long put', p-2*D), leg('Short put', p-D), leg('Short call', p+D), leg('Long call', p+2*D)];
    } else if (bestStrat === 'Chicken condor') {
      const tightW = D, wideW = D * 1.5;
      legs = dirScore >= 0
        ? [leg('Long put', p-wideW-D), leg('Short put', p-wideW), leg('Short call', p+tightW), leg('Long call', p+tightW+D)]
        : [leg('Long put', p-tightW-D), leg('Short put', p-tightW), leg('Short call', p+wideW), leg('Long call', p+wideW+D)];
    } else if (bestStrat === 'Bull put spread') {
      legs = [leg('Short put', p-D), leg('Long put', p-2*D)];
    } else if (bestStrat === 'Bear call spread') {
      legs = [leg('Short call', p+D), leg('Long call', p+2*D)];
    } else if (bestStrat === 'Bull call spread') {
      legs = [leg('Long call', p), leg('Short call', p+D*0.5)];
    } else if (bestStrat === 'Bear put spread') {
      legs = [leg('Long put', p), leg('Short put', p-D*0.5)];
    }
  }
  const wingTxt = D > 0 ? `D=${D.toFixed(1)} pts (base ${baseDistance.toFixed(1)} x ${distMult.toFixed(2)})` : '';

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

  // ── Kelly sizing ──
  const halfRisk = risk / 2;
  const wlRatio = halfRisk > 0 ? win / halfRisk : 0;
  const kelly = wlRatio > 0 ? Math.max(0, popFrac - (1 - popFrac) / wlRatio) : 0;
  const bePop = halfRisk > 0 ? halfRisk / (win + halfRisk) : 0;
  const kellyDollar = bankroll > 0 ? Math.min(kelly * bankroll, bankroll * 0.30) : 0;
  const popMargin = bePop > 0 && popFrac > 0 ? popFrac / bePop : 0;
  const kellyRisk = kelly * bankroll;
  const riskCap = maxOpen > 0 ? Math.min(kellyRisk, maxLoss, maxOpen) : Math.min(kellyRisk, maxLoss);
  const fullC = risk > 0 ? Math.max(1, Math.floor(riskCap / risk)) : 1;
  const halfC = Math.max(1, Math.floor(fullC / 2));
  const vixOvC = vixHigh ? Math.max(1, Math.floor(fullC * 0.5)) : fullC;
  const contracts = setup === 'B Setup' ? halfC : (vixHigh ? vixOvC : fullC);
  const maxRisk = contracts * risk;
  const kellyOverRisk = risk > 0 && kellyDollar > 0 && risk > kellyDollar;

  // ── Greeks ──
  let greeks = null;
  if (hasGreeks && atr > 0) {
    const tEdge = delta * atr > 0 ? theta / (delta * atr) : 0;
    const gRisk = theta > 0 ? (gamma * atr) / theta : 0;
    const dsMax = delta > 0 ? theta * (hours / 6.5) / delta : 0;
    const dsATR = atr > 0 ? dsMax / atr : 0;
    greeks = { tEdge, gRisk, dsMax, dsATR };
  }

  // ── Warnings ──
  const blockers = [];
  const warnings = [];
  const missingSize = win <= 0 || risk <= 0 || popFrac <= 0;
  let hardBlocker = '';
  if (!hasPrice) hardBlocker = 'Enter underlying price to generate a decision';
  else if (!missingSize && kelly <= 0) hardBlocker = 'Kelly negative — edge insufficient';

  if (greeks && greeks.tEdge < 0.05) blockers.push('Theta edge too weak');
  if (greeks && greeks.gRisk > 1.20) blockers.push('Gamma risk too high');
  if (vixGap < -0.10) warnings.push('VIX1D cheap — favour long gamma (BWB, Long Condor)');
  if (vixGap > 0.25) warnings.push('VIX1D extremely rich — verify no event risk');
  if (vixHigh) warnings.push('VIX >25 — half-size override');
  if (setup === 'B Setup') warnings.push('B setup — half Kelly');
  if (moveConsumed > 0.90 && isDirectional) warnings.push('Move >90% consumed — avoid chasing directional');
  if (moveConsumed > 0.80 && isCompressing) warnings.push('Vol exhausted + compression — butterfly/BWB territory');
  if (vwapOverextended) warnings.push(`Price ${(vwapDistPctEM*100).toFixed(0)}% EM from VWAP — pullback risk`);
  if (diverges) warnings.push('15m VWAP diverges from 5m — lower conviction');
  if (overextendedWarning) warnings.push('Strong direction + overextended — consider pullback');
  if (hasOvernight && overnightMovePct > 0.60 && isDirectional) warnings.push(`Overnight consumed ${(overnightMovePct*100).toFixed(0)}% EM — limited room`);

  // ── Decision ──
  let decision, decisionClass;
  if (hardBlocker) { decision = 'No trade'; decisionClass = 'nogo'; }
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
    overnightMove, overnightRange, overnightDir, overnightRangePct, overnightMovePct,
    moveConsumed, volRemaining,
    // Strategy
    ratings: sorted, bestStrat, bestRating,
    // Strikes
    legs, wingTxt, D, baseDistance, distMult,
    // Scoring
    setupScore, setup, criteria,
    // Kelly
    kelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    fullC, halfC, vixOvC, contracts, maxRisk, vixHigh,
    // Greeks
    greeks,
    // Decision
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    behaviour: MARKET_BEHAVIOUR_0DTE[bestStrat] || ''
  };
}
