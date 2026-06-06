// ================================================================
//  45DTE CALCULATION ENGINE
//  Pure functions — no DOM access.
// ================================================================
import { STRATS_45DTE, REGIME_RATINGS45, REGIME_COMMENTARY45, MARKET_BEHAVIOUR_45DTE, DELTA_GUIDE } from './data.js';

function degrade(r) { const o=['EXCELLENT','GOOD','MARGINAL','NO TRADE']; return o[Math.min(o.indexOf(r)+1,3)]; }

export function calc45DTE(inputs) {
  const { underlying, price, ivr, iv, hv, vix, ivFront, ivBack, skew,
    termBias, dte=45, outlook, pop, win, risk, bankroll, startBR,
    maxLoss, maxOpen, bpr, theta, vega, delta } = inputs;

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

  // Strike engine
  let legs = [], strikeLine = '';
  if (hasPrice && em45 > 0) {
    const p = price;
    const R = n => Math.round(n * 2) / 2;
    const leg = (label, strike) => ({label, strike: R(strike)});
    const sdFull = em45, sd80 = em45*0.80, sd50 = em45*0.50, sd25 = em45*0.25;

    if (bestStrat === 'Iron Condor - Normal') {
      legs = [leg('Long put',p-sdFull),leg('Short put',p-sd80),leg('Short call',p+sd80),leg('Long call',p+sdFull)];
    } else if (bestStrat === 'Iron butterfly') {
      legs = [leg('Long put (wing)',p-sd80),leg('Short put (body)',p),leg('Short call (body)',p),leg('Long call (wing)',p+sd80)];
    } else if (bestStrat === 'Credit spread') {
      legs = isBull||!isBear ? [leg('Short put',p-sd50),leg('Long put',p-sd80)] : [leg('Short call',p+sd50),leg('Long call',p+sd80)];
    } else if (bestStrat === 'Bull call spread') {
      legs = [leg('Long call',p),leg('Short call',p+sd50)];
    } else if (bestStrat === 'Bear put spread') {
      legs = [leg('Long put',p),leg('Short put',p-sd50)];
    } else if (bestStrat === 'Broken wing butterfly') {
      const nearW = Math.max(10, R(sd25)), farW = Math.max(17.5, R(sd50*0.6));
      if (isBull) { const body = R(p+sd50*0.3); legs = [leg('Long call (lower)',body-nearW),leg('Short call x2',body),leg(`Long call (broken ${farW.toFixed(1)}pt)`,body+farW)]; }
      else { const body = R(p-sd50*0.3); legs = [leg('Long put (upper)',body+nearW),leg('Short put x2',body),leg(`Long put (broken ${farW.toFixed(1)}pt)`,body-farW)]; }
    } else if (bestStrat === 'Jade lizard') {
      legs = [leg('Short put',p-sd50),leg('Long put',p-sd80),leg('Short call',p+sd80),leg('Long call',p+sdFull)];
    } else if (bestStrat === 'Calendar spread') {
      const cs = isBull?R(p+sd25):isBear?R(p-sd25):R(p);
      legs = [leg('Long back-month',cs),leg('Short front-month',cs)];
    } else if (bestStrat === 'Diagonal spread') {
      legs = [leg('Long 60-90d call',R(p)),leg('Short 20-30d call',R(p+sd50*(isBull?1:-1)))];
    } else if (bestStrat === 'Ratio spread') {
      legs = [leg('Long call',p),leg('Short call x2',p+sd50)];
    } else if (bestStrat === 'Standard butterfly') {
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

  // Greeks
  let greeks = null;
  if (theta>0||vega>0||delta>0) {
    const tvRatio = (theta>0&&vega>0)?vega/theta:0;
    greeks = { tEff, tvRatio, vega: vega||0, delta: delta||0 };
  }

  // Decision
  const blockers = [], warnings = [];
  const missingSize = win<=0||risk<=0||popFrac<=0;
  let hardBlocker = '';
  if (!hasVol) hardBlocker = 'Enter IV, IVR and HV';
  else if (!missingSize && kelly <= 0) hardBlocker = 'Kelly negative — edge insufficient';
  else if (termBias === 'backwardation') hardBlocker = 'Backwardation — avoid naked short premium';

  if (hasGreeks && tEff > 0 && tEff < 0.005) blockers.push('Theta efficiency too low');
  if (vix > 25) warnings.push('VIX >25 — reduce size');
  if (setup === 'B Setup') warnings.push(`B setup (${setupScore}/100) — half Kelly`);
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
    ratings: sorted, bestStrat, bestRating,
    legs, strikeLine,
    setupScore, setup, criteria,
    kelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    fullC, halfC, contracts, maxRisk, tEff,
    greeks, sdRange, deltaGuide: DELTA_GUIDE,
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    behaviour: MARKET_BEHAVIOUR_45DTE[bestStrat] || '',
    outlook
  };
}
