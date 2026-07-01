// ================================================================
//  45DTE CALCULATION ENGINE
//  Pure functions — no DOM access.
// ================================================================
import { STRATS_45DTE, REGIME_RATINGS45, REGIME_COMMENTARY45, MARKET_BEHAVIOUR_45DTE, DELTA_GUIDE } from './data.js';

function degrade(r) { const o=['EXCELLENT','GOOD','MARGINAL','NO TRADE']; return o[Math.min(o.indexOf(r)+1,3)]; }

export function calc45DTE(inputs) {
  const { underlying, price, ivr, iv, hv, vix, ivFront, ivBack, skew,
    termBias, dte=45, outlook, pop, win, risk, bankroll, startBR,
    maxLoss, maxOpen, bpr, theta, vega, delta,
    // Optional per-strategy realized history (resolved object or a map keyed
    // by strategy name via historyByStrategy).
    history: historyInput, historyByStrategy } = inputs;

  const hasPrice = price > 0, hasVol = iv > 0, hasGreeks = theta > 0 && bpr > 0;
  const hasTerm = ivFront > 0 && ivBack > 0;
  const popFrac = pop / 100;

  // EM45
  const em45 = (hasPrice && hasVol) ? price * (iv/100) * Math.sqrt(dte/365) : 0;

  // IV/HV
  const ivhvRatio = hv > 0 ? iv/hv : 0;
  const ivhvLabel = ivhvRatio>1.2?'Premium rich — sell vol':ivhvRatio>=1.0?'Neutral':'Premium cheap — buy vol';

  // IVR band
  const ivrBand = ivr>60?'Very rich':ivr>40?'Premium rich':ivr>20?'Neutral':'Premium cheap';
  const ivrStructures = ivr>60?'Iron Condor, Jade lizard, BWB, Credit spreads'
    :ivr>40?'Iron Condor, Bull put, Bear call, Chicken condor'
    :ivr>20?'Calendar, Diagonal, Iron Condor, Credit spreads'
    :'Bull call, Bear put, Calendar, Diagonal';

  // Term structure
  const termDiff = hasTerm ? ivFront - ivBack : 0;
  const termLabel = hasTerm
    ? (termDiff>2?`Steep contango +${termDiff.toFixed(1)}%`:termDiff>0?`Mild contango +${termDiff.toFixed(1)}%`:termDiff<-1?`Backwardation ${termDiff.toFixed(1)}%`:'Flat')
    : termBias.charAt(0).toUpperCase()+termBias.slice(1);

  // Regime
  let regime;
  if (termBias === 'backwardation') regime = 'Backwardation';
  else if (ivr > 60 && ivhvRatio > 1.1) regime = 'Very rich';
  else if (ivr > 40 && ivhvRatio > 1.0) regime = 'Premium rich';
  else if (ivr < 20 || ivhvRatio < 1.0) regime = 'Premium cheap';
  else regime = 'Neutral';

  // Ratings
  const ratingLevels = ['NO TRADE','MARGINAL','GOOD','EXCELLENT'];
  let ratings45 = (REGIME_RATINGS45[regime] || [1,1,1,1,1,1,1,1,1,1,1]).map(i => ratingLevels[i]);
  const isBull = outlook === 'bullish', isBear = outlook === 'bearish';

  if (isBull) {
    ratings45[8] = 'NO TRADE'; if (ivr < 25) ratings45[7] = 'EXCELLENT';
    ratings45[0] = degrade(ratings45[0]); ratings45[9] = degrade(ratings45[9]);
  } else if (isBear) {
    ratings45[7] = 'NO TRADE'; if (ivr < 25) ratings45[8] = 'EXCELLENT';
    ratings45[0] = degrade(ratings45[0]); ratings45[9] = degrade(ratings45[9]);
  }

  const order = {EXCELLENT:0,GOOD:1,MARGINAL:2,'NO TRADE':3};
  const sorted = STRATS_45DTE.map((s,i) => ({name:s, rating:ratings45[i]})).sort((a,b) => order[a.rating]-order[b.rating]);
  const best = sorted.find(s => s.rating==='EXCELLENT'||s.rating==='GOOD');
  const bestStrat = best ? best.name : 'No suitable structure';
  const bestRating = best ? best.rating : 'NO TRADE';

  // Override: if caller specifies a strategy, use that for legs
  const overrideStrategy = inputs.overrideStrategy || null;
  const legStrat = overrideStrategy || bestStrat;

  // Strike engine
  let legs = [], strikeLine = '';
  if (hasPrice && em45 > 0) {
    const p = price;
    const R = n => Math.round(n * 2) / 2;
    const leg = (label, strike) => ({label, strike: R(strike)});
    const sdFull = em45, sd80 = em45*0.80, sd50 = em45*0.50, sd25 = em45*0.25;

    if (legStrat === 'Iron Condor - Normal') {
      legs = [leg('Long put',p-sdFull),leg('Short put',p-sd80),leg('Short call',p+sd80),leg('Long call',p+sdFull)];
    } else if (legStrat === 'Iron butterfly') {
      legs = [leg('Long put (wing)',p-sd80),leg('Short put (body)',p),leg('Short call (body)',p),leg('Long call (wing)',p+sd80)];
    } else if (legStrat === 'Credit spread') {
      legs = isBull||!isBear ? [leg('Short put',p-sd50),leg('Long put',p-sd80)] : [leg('Short call',p+sd50),leg('Long call',p+sd80)];
    } else if (legStrat === 'Bull call spread') {
      legs = [leg('Long call',p),leg('Short call',p+sd50)];
    } else if (legStrat === 'Bear put spread') {
      legs = [leg('Long put',p),leg('Short put',p-sd50)];
    } else if (legStrat === 'Broken wing butterfly') {
      const nearW = Math.max(10, R(sd25)), farW = Math.max(17.5, R(sd50*0.6));
      if (isBull) { const body = R(p+sd50*0.3); legs = [leg('Long call (lower)',body-nearW),leg('Short call x2',body),leg(`Long call (broken ${farW.toFixed(1)}pt)`,body+farW)]; }
      else { const body = R(p-sd50*0.3); legs = [leg('Long put (upper)',body+nearW),leg('Short put x2',body),leg(`Long put (broken ${farW.toFixed(1)}pt)`,body-farW)]; }
    } else if (legStrat === 'Jade lizard') {
      legs = [leg('Short put',p-sd50),leg('Long put',p-sd80),leg('Short call',p+sd80),leg('Long call',p+sdFull)];
    } else if (legStrat === 'Calendar spread') {
      const cs = isBull?R(p+sd25):isBear?R(p-sd25):R(p);
      legs = [leg('Long back-month',cs),leg('Short front-month',cs)];
    } else if (legStrat === 'Diagonal spread') {
      legs = [leg('Long 60-90d call',R(p)),leg('Short 20-30d call',R(p+sd50*(isBull?1:-1)))];
    } else if (legStrat === 'Ratio spread') {
      legs = [leg('Long call',p),leg('Short call x2',p+sd50)];
    } else if (legStrat === 'Standard butterfly') {
      legs = [leg('Long put',p-sd50),leg('Short put',p),leg('Short call',p),leg('Long call',p+sd50)];
    }
    strikeLine = `1 SD=${em45.toFixed(1)} pts | 0.5 SD=${sd50.toFixed(1)} pts | ${dte}d @ IV ${iv.toFixed(1)}%`;
  }

  // Scoring (100 pts)
  let setupScore = 0;
  const criteria = [];
  const ivrPts = ivr>60?30:ivr>40?25:ivr>20?15:ivr>10?8:0;
  setupScore += ivrPts; criteria.push({label:`IV Rank ${ivr>0?ivr.toFixed(0)+'%':'--'}`, pts:ivrPts, max:30});
  const ivhvPts = ivhvRatio>1.2?20:ivhvRatio>=1.0?12:ivhvRatio>0?4:0;
  setupScore += ivhvPts; criteria.push({label:`IV/HV ${ivhvRatio>0?ivhvRatio.toFixed(2):'--'}`, pts:ivhvPts, max:20});
  const stratFit = bestRating==='EXCELLENT'?20:bestRating==='GOOD'?13:bestRating==='MARGINAL'?6:0;
  setupScore += stratFit; criteria.push({label:`Strategy fit (${bestRating})`, pts:stratFit, max:20});
  const tEff = hasGreeks ? theta/bpr : 0;
  const tEffPts = !hasGreeks?8:tEff>0.02?15:tEff>0.01?10:tEff>0.005?5:0;
  setupScore += tEffPts; criteria.push({label:`Theta efficiency ${hasGreeks?tEff.toFixed(4):'--'}`, pts:tEffPts, max:15});
  const termPts = termBias==='contango'?15:termBias==='flat'?8:0;
  setupScore += termPts; criteria.push({label:`Term structure (${termBias})`, pts:termPts, max:15});

  const setup = setupScore>=85?'A+ Setup':setupScore>=70?'A Setup':setupScore>=50?'B Setup':'No setup';

  // ── Target credit/debit for 45DTE strategies ──
  let targetCredit = null;
  let targetLabel = '';
  // 45DTE typically uses 1-SD strike selection, wider spreads
  const typicalWidth45 = price > 0 && vix > 0 ? Math.round(price * (vix/100) * Math.sqrt(45/365)) : 0;
  if (typicalWidth45 > 0 && legStrat) {
    if (legStrat.includes('Iron Condor') || legStrat.includes('Strangle')) {
      const cr = Math.round(typicalWidth45 * 0.33 * 100) / 100;
      targetLabel = `Target credit: ~$${cr.toFixed(2)} (1/3 of ${typicalWidth45}pt width at 1-SD)`;
    } else if (legStrat.includes('Iron butterfly')) {
      const lo = typicalWidth45 * 0.25, hi = typicalWidth45 * 0.30;
      targetLabel = `Target credit: $${lo.toFixed(2)}\u2013$${hi.toFixed(2)} (25-30% of ${typicalWidth45}pt)`;
    } else if (legStrat.includes('Put spread') || legStrat.includes('Call spread')) {
      targetLabel = `Target credit: 1/3 of spread width`;
    } else if (legStrat.includes('Calendar') || legStrat.includes('Diagonal')) {
      targetLabel = `Target debit: minimize — aim for low net cost`;
    }
  }

  // Kelly
  const halfRisk = risk/2;
  const wlRatio = halfRisk>0?win/halfRisk:0;
  const kelly = wlRatio>0?Math.max(0,popFrac-(1-popFrac)/wlRatio):0;
  const bePop = halfRisk>0?halfRisk/(win+halfRisk):0;
  const kellyDollar = bankroll>0?Math.min(kelly*bankroll,bankroll*0.30):0;
  const popMargin = bePop>0&&popFrac>0?popFrac/bePop:0;
  const riskCap = maxOpen>0?Math.min(kelly*bankroll,maxLoss,maxOpen):Math.min(kelly*bankroll,maxLoss);
  const fullC = risk>0?Math.max(1,Math.floor(riskCap/risk)):1;
  const halfC = Math.max(1,Math.floor(fullC/2));
  const contracts = setup==='B Setup'?halfC:fullC;
  const maxRisk = contracts*risk;
  const kellyOverRisk = risk>0&&kellyDollar>0&&risk>kellyDollar;

  // ── EV calculation (tiered: estimated capture-fractions → measured history) ──
  // Same model as 0DTE. avgWin/avgLoss come from per-strategy capture fractions
  // until >= 50 closed trades exist for the strategy, then from realized stats.
  const EV_HISTORY_THRESHOLD = 50;
  const history = historyInput || (historyByStrategy ? historyByStrategy[legStrat] : null);
  function captureFractions45(s) {
    if (s === 'Standard butterfly' || s === 'Asymmetric butterfly') return { winCap: 0.28, lossCap: 0.45 };
    if (s === 'Broken wing butterfly' || s.includes('BWB')) return { winCap: 0.30, lossCap: 0.50 };
    if (s === 'Iron butterfly') return { winCap: 0.35, lossCap: 0.55 };
    if (s.includes('Iron Condor') || s === 'Chicken condor') return { winCap: 0.50, lossCap: 0.70 };
    if (s.includes('Credit') || s.includes('Bull put') || s.includes('Bear call')) return { winCap: 0.55, lossCap: 0.75 };
    if (s.includes('Bull call') || s.includes('Bear put') || s.includes('Debit')) return { winCap: 0.50, lossCap: 0.60 };
    if (s.includes('Reversed')) return { winCap: 0.45, lossCap: 0.55 };
    return { winCap: 0.40, lossCap: 0.60 };
  }
  const { winCap: evWinCap, lossCap: evLossCap } = captureFractions45(legStrat);
  const estAvgWin = win * evWinCap;
  const estAvgLoss = risk * evLossCap;
  const histTrades = history?.trades || 0;
  const hasMeasured = histTrades >= EV_HISTORY_THRESHOLD && history?.avgWin > 0 && history?.avgLoss > 0;
  const wMeasured = Math.min(1, histTrades / EV_HISTORY_THRESHOLD);
  const realWinP = (history?.winRate > 0) ? history.winRate : popFrac;
  const winP = (history?.winRate > 0) ? (1 - wMeasured) * popFrac + wMeasured * realWinP : popFrac;
  const avgWinUsed = hasMeasured ? history.avgWin : estAvgWin;
  const avgLossUsed = hasMeasured ? history.avgLoss : estAvgLoss;
  const ev = (avgWinUsed > 0 && avgLossUsed > 0 && winP > 0)
    ? (winP * avgWinUsed) - ((1 - winP) * avgLossUsed) : 0;
  const evBasis = {
    mode: hasMeasured ? 'measured' : 'estimated',
    historyTrades: histTrades, threshold: EV_HISTORY_THRESHOLD,
    winCap: evWinCap, lossCap: evLossCap,
    winP, avgWin: avgWinUsed, avgLoss: avgLossUsed, maxWin: win, maxLoss: risk
  };

  // Greeks + Directional Edge
  let greeks = null;
  if (theta>0||vega>0||Math.abs(delta)>0) {
    const tvRatio = (theta>0&&vega>0)?vega/theta:0;

    // 45DTE Directional Edge
    // Remaining EM = IV × √(remaining DTE / 365) × price
    const remainingDTE = Math.max(dte - 21, 1); // target exit at 21 DTE
    const daysToExit = dte - 21; // days until planned exit
    const remainingEM = iv > 0 && price > 0 ? price * (iv / 100) * Math.sqrt(remainingDTE / 365) : 0;
    const directionalGain = Math.abs(delta) * remainingEM;
    const thetaPressure = theta * Math.max(daysToExit, 1);
    const edgeRatio = thetaPressure > 0 ? directionalGain / thetaPressure : directionalGain > 0 ? 99 : 0;

    // Strategy interpretation for 45DTE
    const isCreditStrat = legStrat.includes('Iron Condor') || legStrat.includes('Iron butterfly')
      || legStrat.includes('Put spread') || legStrat.includes('Call spread')
      || legStrat.includes('Strangle');
    const isDebitDir = legStrat.includes('Bull call') || legStrat.includes('Bear put')
      || legStrat.includes('Calendar') || legStrat.includes('Diagonal');

    let edgeSignal, edgeAction, edgePhase;
    if (isCreditStrat) {
      if (edgeRatio < 0.5) { edgeSignal = 'excellent'; edgeAction = 'Theta strongly dominates over ' + daysToExit + ' days'; }
      else if (edgeRatio < 0.8) { edgeSignal = 'good'; edgeAction = 'Theta advantage holds — favourable premium sale'; }
      else if (edgeRatio < 1.2) { edgeSignal = 'marginal'; edgeAction = 'Directional risk meaningful — tighten strikes or reduce size'; }
      else { edgeSignal = 'poor'; edgeAction = 'Move likely exceeds theta — unfavourable for credit'; }
      edgePhase = 'theta-dominant';
    } else if (isDebitDir) {
      if (edgeRatio > 2.0) { edgeSignal = 'excellent'; edgeAction = 'Strong directional edge over ' + daysToExit + ' day holding'; }
      else if (edgeRatio > 1.2) { edgeSignal = 'good'; edgeAction = 'Directional P&L should outpace decay'; }
      else if (edgeRatio > 0.8) { edgeSignal = 'marginal'; edgeAction = 'Thin edge — need strong directional conviction'; }
      else { edgeSignal = 'poor'; edgeAction = 'Theta eroding edge — reconsider entry or timing'; }
      edgePhase = 'move-dominant';
    } else {
      if (edgeRatio > 1.5) { edgeSignal = 'good'; edgeAction = 'Directional component stronger'; }
      else if (edgeRatio > 0.7) { edgeSignal = 'good'; edgeAction = 'Balanced — monitor through holding period'; }
      else { edgeSignal = 'good'; edgeAction = 'Theta component stronger'; }
      edgePhase = 'balanced';
    }

    greeks = { tEff, tvRatio, vega: vega||0, delta: delta||0,
      directionalGain, thetaPressure, edgeRatio, edgeSignal, edgeAction, edgePhase,
      remainingEM, remainingDTE, daysToExit, isCreditStrat, isDebitDir
    };
  }

  // Decision
  const blockers = [], warnings = [];
  const missingSize = win<=0||risk<=0||popFrac<=0;
  let hardBlocker = '';
  if (!hasVol) hardBlocker = 'Enter IV, IVR and HV';
  else if (termBias === 'backwardation') hardBlocker = 'Backwardation — avoid naked short premium';

  if (hasGreeks && tEff > 0 && tEff < 0.005) blockers.push('Theta efficiency too low');
  if (vix > 25) warnings.push('VIX >25 — reduce size');
  if (setup === 'B Setup') warnings.push(`B setup (${setupScore}/100) — half Kelly`);
  if (!missingSize && kelly <= 0) warnings.push('Kelly negative — edge insufficient, minimum 1 contract');
  if (ivr < 20) warnings.push('Low IVR — debit or calendars');
  if (greeks && greeks.tvRatio > 4) warnings.push('Vega/theta elevated — vol expansion risk');

  let decision, decisionClass;
  if (hardBlocker) { decision='No trade'; decisionClass='nogo'; }
  else if (setup === 'No setup') { decision='No trade'; decisionClass='nogo'; }
  else if (missingSize||bestRating==='NO TRADE'||blockers.length) { decision=missingSize?'Enter sizing':'Review signals'; decisionClass='nogo'; }
  else if (warnings.length) { decision='Trade with caution'; decisionClass='warn'; }
  else { decision='Trade'; decisionClass='go'; }

  // Management targets
  const sdRange = (hasPrice && hasVol) ? { oneSD: em45, halfSD: em45*0.5 } : null;

  return {
    em45, ivhvRatio, ivhvLabel, ivrBand, ivrStructures,
    termDiff, termLabel, skew,
    regime, regimeCommentary: REGIME_COMMENTARY45[regime],
    ratings: sorted, bestStrat, bestRating, legStrat, overrideStrategy,
    legs, strikeLine,
    setupScore, setup, criteria,
    kelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    ev, evBasis,
    targetCredit, targetLabel,
    fullC, halfC, contracts, maxRisk, tEff,
    greeks, sdRange, deltaGuide: DELTA_GUIDE,
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    behaviour: MARKET_BEHAVIOUR_45DTE[legStrat] || '',
    outlook
  };
}
