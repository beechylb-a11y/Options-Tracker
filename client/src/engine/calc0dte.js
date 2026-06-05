// ================================================================
//  0DTE CALCULATION ENGINE
//  Pure functions — no DOM access. Takes inputs, returns results.
// ================================================================
import { STRATS_0DTE, SQRT252, REGIME_CONDS, REGIME_COMMENTARY, VIX_GAP_RATINGS, MARKET_BEHAVIOUR_0DTE } from './data.js';

function degrade(rating, levels) {
  const order = ['EXCELLENT','GOOD','MARGINAL','NO TRADE'];
  const idx = order.indexOf(rating);
  return order[Math.min(idx + levels, 3)];
}

export function getStrategyRatings(dirScore, gapBandIdx, rmRatio, isCompressing, slope) {
  const isBull = dirScore > 0, isBear = dirScore < 0, isNeutral = dirScore === 0;
  const isStrong = Math.abs(dirScore) >= 2;

  let base;
  if      (rmRatio < 0.25) base = ['GOOD','MARGINAL','GOOD','NO TRADE','EXCELLENT','NO TRADE','MARGINAL'];
  else if (rmRatio < 0.50) base = ['EXCELLENT','MARGINAL','MARGINAL','NO TRADE','EXCELLENT','GOOD','MARGINAL'];
  else if (rmRatio < 0.75) base = ['GOOD','EXCELLENT','MARGINAL','MARGINAL','GOOD','EXCELLENT','MARGINAL'];
  else if (rmRatio < 1.00) base = ['MARGINAL','EXCELLENT','EXCELLENT','EXCELLENT','MARGINAL','GOOD','GOOD'];
  else if (isCompressing)  base = ['MARGINAL','EXCELLENT','MARGINAL','EXCELLENT','MARGINAL','GOOD','GOOD'];
  else                     base = ['GOOD','GOOD','MARGINAL','NO TRADE','NO TRADE','NO TRADE','NO TRADE'];

  const ratings = base.slice();
  if (isStrong) {
    [3,4,5,6].forEach(i => { ratings[i] = degrade(ratings[i], 1); });
  }

  // Bull Put Spread
  let bps;
  if (isBull) bps = (gapBandIdx>=2&&rmRatio<0.50)?'EXCELLENT':(gapBandIdx>=1&&rmRatio<0.50)?'GOOD':(rmRatio<0.50)?'MARGINAL':'MARGINAL';
  else if (isNeutral) bps = 'MARGINAL';
  else bps = 'NO TRADE';
  ratings.push(bps);

  // Bear Call Spread
  let bcs;
  if (isBear) bcs = (gapBandIdx>=2&&rmRatio<0.50)?'EXCELLENT':(gapBandIdx>=1&&rmRatio<0.50)?'GOOD':(rmRatio<0.50)?'MARGINAL':'MARGINAL';
  else if (isNeutral) bcs = 'MARGINAL';
  else bcs = 'NO TRADE';
  ratings.push(bcs);

  // Bull Call Spread
  let bullCall;
  if (isBull) bullCall = (gapBandIdx===0&&rmRatio<0.40)?'EXCELLENT':(gapBandIdx<=1&&rmRatio<0.40)?'GOOD':(rmRatio<0.40)?'MARGINAL':'NO TRADE';
  else bullCall = 'NO TRADE';
  ratings.push(bullCall);

  // Bear Put Spread
  let bearPut;
  if (isBear) bearPut = (gapBandIdx===0&&rmRatio<0.40)?'EXCELLENT':(gapBandIdx<=1&&rmRatio<0.40)?'GOOD':(rmRatio<0.40)?'MARGINAL':'NO TRADE';
  else bearPut = 'NO TRADE';
  ratings.push(bearPut);

  return ratings;
}

export function calc0DTE(inputs) {
  const { price, high, low, vwap, atr, em, atr5, atr2h, gamStrike, slope,
    vix, vix1d, bankroll, startBR, risk, maxLoss, win, maxOpen, pop,
    theta, delta, gamma, hours, underlying } = inputs;

  const hasPrice = price > 0;
  const hasComp = atr5 > 0 && atr2h > 0;
  const hasGam = gamStrike > 0 && atr > 0;
  const hasGreeks = theta > 0 && delta > 0;
  const popFrac = pop / 100;

  // Derived
  const rm = high - low;
  const rmRatio = em > 0 ? rm / em : 0;
  const comp = hasComp ? atr5 / atr2h : null;
  const gamDist = hasGam ? Math.abs(price - gamStrike) / atr : null;
  const aboveVWAP = hasPrice && price >= vwap;
  const vwapDiff = price - vwap;
  const vixGap = vix > 0 ? (vix1d - vix) / vix : 0;
  const gapBandIdx = vixGap < -0.10 ? 0 : vixGap <= 0.10 ? 1 : vixGap <= 0.25 ? 2 : 3;
  const vixHigh = vix > 25;
  const emVIX = price > 0 ? Math.round(price * (vix / 100) / SQRT252) : 0;
  const emV1D = price > 0 ? Math.round(price * (vix1d / 100) / SQRT252) : 0;

  // VIX signal
  const vixGrade = vixGap<-0.10?'Cheap short-term vol':vixGap<=0.10?'Neutral':vixGap<=0.25?'Rich short-term vol':'Extremely rich short-term vol';
  const vixImplic = vixGap<-0.10?'BWB, Asymmetric, Long Condor':vixGap<=0.10?'BWB, Asymmetric, Chicken Condor':vixGap<=0.25?'Iron Condor, Iron Butterfly, Chicken Condor':'Iron Condor, Iron Butterfly (check event risk)';

  // Direction
  let dirScore;
  if (!hasPrice) dirScore = 0;
  else if (aboveVWAP && slope === 'strong') dirScore = 2;
  else if (aboveVWAP && slope === 'mild') dirScore = 1;
  else if (!aboveVWAP && slope === 'strong') dirScore = -2;
  else if (!aboveVWAP && slope === 'mild') dirScore = -1;
  else dirScore = aboveVWAP ? 1 : (hasPrice ? -1 : 0);

  const dirLabel = dirScore>=2?'Strong bullish':dirScore===1?'Mild bullish':dirScore===0?'Neutral':dirScore===-1?'Mild bearish':'Strong bearish';

  // Regime
  const isCompressing = hasComp && comp < 0.50;
  const isExpanding = hasComp && comp > 0.80;
  let regime;
  if (rmRatio < 0.25) regime = 'RM < 25%';
  else if (rmRatio < 0.50) regime = 'RM 25-50%';
  else if (rmRatio < 0.75) regime = 'RM 50-75%';
  else if (rmRatio < 1.00) regime = 'RM 75-100%';
  else regime = isCompressing ? 'RM >100% compress' : 'RM >100% expand';

  if (gamDist !== null && gamDist < 0.25 && comp < 0.35 && rmRatio >= 0.75) regime = 'RM 75-100%';

  // Ratings
  const ratings = getStrategyRatings(dirScore, gapBandIdx, rmRatio, isCompressing, slope);
  const sorted = STRATS_0DTE.map((s, i) => ({ name: s, rating: ratings[i] }));
  const order = { EXCELLENT: 0, GOOD: 1, MARGINAL: 2, 'NO TRADE': 3 };
  sorted.sort((a, b) => order[a.rating] - order[b.rating]);

  const best = sorted.find(s => s.rating === 'EXCELLENT' || s.rating === 'GOOD');
  const bestStrat = best ? best.name : 'No suitable structure';
  const bestRating = best ? best.rating : 'NO TRADE';

  // Strike engine
  const baseDistance = price > 0 ? Math.max(emVIX / 2, emV1D, em * 0.5) : 0;
  let distMult = 1.0;
  if (hasComp) { if (comp < 0.50) distMult = 0.8; else if (comp > 0.80) distMult = 1.25; }
  let D = baseDistance * distMult;
  const roundTo = underlying === 'SPX' ? 5 : (underlying === 'QQQ' || underlying === 'IWM') ? 1 : (underlying === 'SPY') ? 1 : 0.5;
  // Minimum D: at least 2x roundTo so strikes don't collapse
  if (D > 0 && D < roundTo * 2) D = roundTo * 2;
  const R = n => roundTo > 0 ? Math.round(n / roundTo) * roundTo : Math.round(n * 2) / 2;
  const leg = (label, strike) => ({ label, strike: R(strike) });

  let legs = [];
  if (price > 0 && D > 0) {
    const p = price;
    const gs = (hasGam && gamStrike > 0) ? gamStrike : p;
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

  // Scoring (100 pts)
  let setupScore = 0;
  const criteria = [];

  // 1. RM band (30)
  let rmPts;
  if (!hasPrice || em === 0) rmPts = 10;
  else if (rmRatio < 0.25) rmPts = bestRating==='EXCELLENT'?30:bestRating==='GOOD'?22:12;
  else if (rmRatio < 0.50) rmPts = bestRating==='EXCELLENT'?30:bestRating==='GOOD'?22:12;
  else if (rmRatio < 0.75) rmPts = bestRating==='EXCELLENT'?28:bestRating==='GOOD'?20:10;
  else if (rmRatio < 1.00) rmPts = bestRating==='EXCELLENT'?30:bestRating==='GOOD'?20:8;
  else rmPts = isCompressing ? (bestRating==='EXCELLENT'?25:15) : 5;
  setupScore += rmPts;
  criteria.push({ label: `Realised move ${hasPrice&&em>0?(rmRatio*100).toFixed(0)+'% EM':'--'}`, pts: rmPts, max: 30 });

  // 2. ATR compression (25)
  let compPts;
  if (!hasComp) compPts = 8;
  else if (rmRatio < 0.50) compPts = comp>=0.50&&comp<=0.80?25:comp>0.80?18:12;
  else if (rmRatio < 0.75) compPts = comp<0.50?25:comp<0.80?18:10;
  else compPts = comp<0.35?25:comp<0.50?20:comp<0.80?10:3;
  setupScore += compPts;
  criteria.push({ label: `ATR compression ${hasComp?comp.toFixed(2):'--'}`, pts: compPts, max: 25 });

  // 3. Gamma distance (20)
  let gamPts;
  if (!hasGam) gamPts = 7;
  else if (rmRatio < 0.50) gamPts = gamDist>1.0?20:gamDist>0.50?16:gamDist>0.25?8:3;
  else gamPts = gamDist<0.25?20:gamDist<0.50?16:gamDist<1.0?8:3;
  setupScore += gamPts;
  criteria.push({ label: `Gamma distance ${hasGam?gamDist.toFixed(2)+'x ATR':'--'}`, pts: gamPts, max: 20 });

  // 4. Strategy fit (15)
  const stratFit = bestRating==='EXCELLENT'?15:bestRating==='GOOD'?10:bestRating==='MARGINAL'?5:0;
  setupScore += stratFit;
  criteria.push({ label: `Strategy fit (${bestRating})`, pts: stratFit, max: 15 });

  // 5. VIX gap (15)
  const vixGapRatings = VIX_GAP_RATINGS[bestStrat] || [5,5,5,5];
  let vixPts = vixGap===0&&vix===0 ? 7 : vixGapRatings[gapBandIdx];
  if (vixHigh) vixPts = Math.floor(vixPts * 0.5);
  setupScore += vixPts;
  criteria.push({ label: `VIX1D/VIX gap for ${bestStrat}`, pts: vixPts, max: 15 });

  // 6. VWAP slope (10)
  const isCentred = ['Iron Condor - Normal','Iron butterfly','Standard butterfly','Long Condor - Reversed'].includes(bestStrat);
  const isDirectional = ['Chicken condor','Broken wing butterfly','Asymmetric butterfly','Bull put spread','Bear call spread','Bull call spread','Bear put spread'].includes(bestStrat);
  let slopePts;
  if (slope === 'flat') slopePts = isCentred?10:isDirectional?5:7;
  else if (slope === 'mild') slopePts = isDirectional?10:isCentred?5:7;
  else slopePts = isDirectional?8:isCentred?2:5;
  setupScore += slopePts;
  criteria.push({ label: `VWAP slope (${slope})`, pts: slopePts, max: 10 });

  const setup = setupScore>=85?'A+ Setup':setupScore>=70?'A Setup':setupScore>=50?'B Setup':'No setup';

  // Kelly
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

  // Greeks
  let greeks = null;
  if (hasGreeks && atr > 0) {
    const tEdge = delta * atr > 0 ? theta / (delta * atr) : 0;
    const gRisk = theta > 0 ? (gamma * atr) / theta : 0;
    const dsMax = delta > 0 ? theta * (hours / 6.5) / delta : 0;
    const dsATR = atr > 0 ? dsMax / atr : 0;
    greeks = { tEdge, gRisk, dsMax, dsATR };
  }

  // Blockers / Warnings
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
  if (rmRatio >= 0.75 && rmRatio < 1.00) warnings.push('Butterfly zone (>75% EM)');
  if (rmRatio >= 1.00 && !isCompressing) warnings.push('EM exceeded without compression');
  if (rmRatio >= 1.00 && isCompressing) warnings.push('EM exceeded + compression — butterfly/BWB');

  // Decision
  let decision, decisionClass;
  if (hardBlocker) { decision = 'No trade'; decisionClass = 'nogo'; }
  else if (missingSize || bestRating === 'NO TRADE' || blockers.length) { decision = missingSize ? 'Enter sizing' : 'Review signals'; decisionClass = 'nogo'; }
  else if (warnings.length) { decision = 'Trade with caution'; decisionClass = 'warn'; }
  else { decision = 'Trade'; decisionClass = 'go'; }

  return {
    // Signals
    vixGap, vixGrade, vixImplic, emVIX, emV1D, gapBandIdx,
    dirScore, dirLabel, aboveVWAP, vwapDiff,
    rm, rmRatio, comp, isCompressing,
    gamDist, regime,
    regimeConds: REGIME_CONDS[regime], regimeCommentary: REGIME_COMMENTARY[regime],
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
