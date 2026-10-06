// ================================================================
//  45DTE CALCULATION ENGINE
//  Pure functions — no DOM access.
// ================================================================
import { STRATS_45DTE, REGIME_RATINGS45, REGIME_COMMENTARY45, MARKET_BEHAVIOUR_45DTE, DELTA_GUIDE, exitRuleFor } from './data.js';
import { blendCapture, stopLossFrac } from './capture.js';
import { eventRisk45DTE, nowET } from './events.js';
import { unitsFromLegs, roundTripCommission, DEFAULT_COMMISSION } from '../utils/commission.js';
import { deltaCrossCheck, deltaStrikePlan } from './deltaStrikes.js';

// ── Term structure from ~30d vs ~90d ATM IV (Oct 2026) ──
// front/back is the same ratio as VIX/VIX3M: calm markets sit near 0.85-0.92, above 1
// near-dated vol is priced over far-dated, which is stress. The flat band stops a 0.98
// read earning full contango points or a 1.01 read tripping the backwardation blocker.
// Thresholds MUST match bridge/volSurface.js (a test pins them together).
export const TERM_FLAT_LO = 0.95, TERM_FLAT_HI = 1.02;
export function termBiasFromIV(front, back) {
  if (!(front > 0) || !(back > 0)) return '';
  const ratio = front / back;
  return ratio > TERM_FLAT_HI ? 'backwardation' : ratio >= TERM_FLAT_LO ? 'flat' : 'contango';
}
const TERM_BIASES = ['contango', 'flat', 'backwardation'];

function degrade(r) { const o=['EXCELLENT','GOOD','MARGINAL','POOR']; return o[Math.min(o.indexOf(r)+1,3)]; }

// Assumed capture fractions (share of max profit / max risk) before any measured
// history — exported so the capture tracker can show them. (Oct 2026.)
export function assumedCapture45(s) {
  if (s === 'Standard butterfly' || s === 'Asymmetric butterfly') return { winCap: 0.28, lossCap: 0.45 };
  if (s === 'Broken wing butterfly' || s.includes('BWB')) return { winCap: 0.30, lossCap: 0.50 };
  // Iron fly and diagonal match their exit targets (Oct 2026): tastylive manages iron
  // flies at 25% and diagonals at 25–50% (app default 25%), so winners bank ~0.25 of
  // max — not 0.35 / the 0.40 default. The capture tracker refines both from closes.
  if (s === 'Iron butterfly') return { winCap: 0.25, lossCap: 0.55 };
  if (s === 'Diagonal spread') return { winCap: 0.25, lossCap: 0.60 };
  if (s.includes('Iron Condor') || s === 'Chicken condor') return { winCap: 0.50, lossCap: 0.70 };
  if (s.includes('Credit') || s.includes('Bull put') || s.includes('Bear call')) return { winCap: 0.55, lossCap: 0.75 };
  if (s.includes('Bull call') || s.includes('Bear put') || s.includes('Debit')) return { winCap: 0.50, lossCap: 0.60 };
  if (s.includes('Reversed')) return { winCap: 0.45, lossCap: 0.55 };
  return { winCap: 0.40, lossCap: 0.60 };
}

export function calc45DTE(inputs) {
  const { underlying, price, ivr, iv, hv, vix, ivFront, ivBack, skew,
    termBias, dte=45, outlook, pop, win, risk, bankroll, startBR,
    maxLoss, maxOpen, bpr, theta, vega, delta,
    // Optional per-strategy realized history (resolved object or a map keyed
    // by strategy name via historyByStrategy).
    // wingDeltas: { lowerAbsDelta, upperAbsDelta } for skew-aware P(max loss).
    history: historyInput, historyByStrategy, wingDeltas, captureByStrategy,
    // Daily trend read (engine/trend.js computeTrend) and VIX / VIX3M — optional.
    trend, vixTermRatio } = inputs;

  // Signed theta: positive collects decay, negative pays it. Gate on magnitude so a
  // debit structure still gets scored, and let the signed tEff below score it honestly
  // (a negative theta efficiency earns zero points, which is the correct answer).
  const thetaAbs = Math.abs(theta);
  const thetaPaid = theta < 0;
  const hasPrice = price > 0, hasVol = iv > 0, hasGreeks = thetaAbs > 0 && bpr > 0;
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

  // Term structure. With both ATM IVs present the bias is DERIVED from them and the
  // dropdown is ignored — it used to be the only input, defaulted to contango, and
  // never looked at IV Front/Back, so every read banked 15 setup points and the
  // backwardation blocker only fired if someone remembered to flip it. Without the
  // IVs the dropdown stands in; blank means unknown, which scores zero.
  // termDiff is back − front: POSITIVE = contango. (It was front − back with the
  // contango/backwardation labels attached the wrong way round.)
  const termBiasEff = hasTerm ? termBiasFromIV(ivFront, ivBack)
    : (TERM_BIASES.includes(termBias) ? termBias : '');
  const termRatio = hasTerm ? ivFront / ivBack : null;
  const termDiff = hasTerm ? ivBack - ivFront : 0;
  const capTerm = termBiasEff ? termBiasEff.charAt(0).toUpperCase() + termBiasEff.slice(1) : 'Unknown';
  const termLabel = hasTerm
    ? `${capTerm} ${termDiff >= 0 ? '+' : ''}${termDiff.toFixed(1)} vol (30d/90d ${termRatio.toFixed(2)})`
    : termBiasEff ? `${capTerm} (manual)` : 'Unknown — no term data';

  // Regime
  let regime;
  if (termBiasEff === 'backwardation') regime = 'Backwardation';
  else if (ivr > 60 && ivhvRatio > 1.1) regime = 'Very rich';
  else if (ivr > 40 && ivhvRatio > 1.0) regime = 'Premium rich';
  else if (ivr < 20 || ivhvRatio < 1.0) regime = 'Premium cheap';
  else regime = 'Neutral';

  // Ratings
  const ratingLevels = ['POOR','MARGINAL','GOOD','EXCELLENT'];
  let ratings45 = (REGIME_RATINGS45[regime] || [1,1,1,1,1,1,1,1,1,1,1]).map(i => ratingLevels[i]);
  const isBull = outlook === 'bullish', isBear = outlook === 'bearish';

  if (isBull) {
    ratings45[8] = 'POOR'; if (ivr < 25) ratings45[7] = 'EXCELLENT';
    ratings45[0] = degrade(ratings45[0]); ratings45[9] = degrade(ratings45[9]);
  } else if (isBear) {
    ratings45[7] = 'POOR'; if (ivr < 25) ratings45[8] = 'EXCELLENT';
    ratings45[0] = degrade(ratings45[0]); ratings45[9] = degrade(ratings45[9]);
  }

  const order = {EXCELLENT:0,GOOD:1,MARGINAL:2,'POOR':3};
  const sorted = STRATS_45DTE.map((s,i) => ({name:s, rating:ratings45[i], idx:i})).sort((a,b) => order[a.rating]-order[b.rating] || a.idx-b.idx);
  // ── Tiebreak (Jul 2026): when ≥2 structures tie at the top rating, break by DIRECTION
  // FIT to the outlook instead of the arbitrary array order (which fires in ~90% of
  // 45DTE cells and always picked Credit spread / Calendar / IC by list position).
  // A directional outlook should express through a structure that leans that way; a
  // neutral outlook through a neutral/range structure. Ties fall back to array order.
  // (Regime ratings already gate premium-buy/sell by IV rank, so the residual choice
  // among tied survivors is mostly directional character.)
  const _neutral45 = s => /Iron Condor|Iron butterfly|Standard butterfly|Calendar/i.test(s);
  const _directional45 = s => /Credit spread|Broken wing|Bull call|Bear put|Diagonal|Ratio|Jade/i.test(s);
  const _dirOutlook = outlook === 'bullish' || outlook === 'bearish';
  const coh45 = (s) => _dirOutlook
    ? (_directional45(s) ? 1.0 : _neutral45(s) ? 0.8 : 0.9)
    : (_neutral45(s) ? 1.0 : _directional45(s) ? 0.8 : 0.9);
  const tradeable = sorted.filter(s => s.rating==='EXCELLENT'||s.rating==='GOOD');
  let best = null, runnerUp = null, tiebreakApplied = false;
  if (tradeable.length) {
    const topTied = tradeable.filter(s => s.rating === tradeable[0].rating);
    const ranked = topTied.slice().sort((a,b) => coh45(b.name)-coh45(a.name) || a.idx-b.idx);
    best = ranked[0];
    if (ranked.length > 1) {
      runnerUp = { name: ranked[1].name, rating: ranked[1].rating };
      tiebreakApplied = ranked[0].name !== topTied[0].name;
    }
  }
  const bestStrat = best ? best.name : 'No suitable structure';
  const bestRating = best ? best.rating : 'POOR';

  // Override: if caller specifies a strategy, use that for legs
  const overrideStrategy = inputs.overrideStrategy || null;
  const legStrat = overrideStrategy || bestStrat;
  // Planned exit: closeDte days before the (near) expiry — 21 by the playbook, 7 on
  // the front leg for calendars/diagonals (EXIT_RULES); inputs.closeDte overrides.
  const closeDte45 = inputs.closeDte > 0 ? inputs.closeDte : exitRuleFor('45DTE', legStrat).closeDte;

  // Strike engine
  const strikeStep45 = ['SPX', 'NDX', 'RUT'].includes(String(underlying || '').toUpperCase()) ? 5
    : ['SPY', 'QQQ', 'IWM', 'XSP', 'DIA'].includes(String(underlying || '').toUpperCase()) ? 1 : 0.5;
  let legs = [], strikeLine = '';
  if (hasPrice && em45 > 0) {
    const p = price;
    // Listed strike increments: 5 on SPX/NDX/RUT, 1 on the ETFs. Rounding SPX to
    // 0.5 produced strikes like 7776.5 that do not exist. (Oct 2026.)
    const R = n => Math.round(n / strikeStep45) * strikeStep45;
    const leg = (label, strike) => ({label, strike: R(strike)});
    const sdFull = em45, sd80 = em45*0.80, sd50 = em45*0.50, sd25 = em45*0.25;

    // Wings are one width on both sides, measured from the ROUNDED shorts. Rounding
    // each leg on its own gave 698/711/813/826-style condors whose sides could differ
    // by a strike; TWS only recognises an iron condor when the wings match, and lists
    // anything else as a custom combo. (Oct 2026.)
    const W = Math.max(strikeStep45, R(sdFull - sd80));
    if (legStrat === 'Iron Condor - Normal') {
      const sp = R(p - sd80), sc = R(p + sd80);
      legs = [{label:'Long put',strike:sp - W},{label:'Short put',strike:sp},{label:'Short call',strike:sc},{label:'Long call',strike:sc + W}];
    } else if (legStrat === 'Iron butterfly') {
      const b = R(p), wf = Math.max(strikeStep45, R(sd80));
      legs = [{label:'Long put (wing)',strike:b - wf},{label:'Short put (body)',strike:b},{label:'Short call (body)',strike:b},{label:'Long call (wing)',strike:b + wf}];
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
      // Calls above, puts below: the strike sits where price is expected to be at
      // the front expiry. Labels name the expiry role so the panel can date them.
      const cs = isBull?R(p+sd25):isBear?R(p-sd25):R(p);
      const rt = isBear ? 'put' : 'call';
      legs = [leg(`Long ${rt} (back month)`,cs),leg(`Short ${rt} (front month)`,cs)];
    } else if (legStrat === 'Diagonal spread') {
      // Bullish: calls, short strike above. Otherwise puts, short strike below — a
      // short CALL below the long one was an in-the-money short. (Oct 2026.)
      legs = isBull
        ? [leg('Long call (back month)',R(p)),leg('Short call (front month)',R(p+sd50))]
        : [leg('Long put (back month)',R(p)),leg('Short put (front month)',R(p-sd50))];
    } else if (legStrat === 'Ratio spread') {
      legs = [leg('Long call',p),leg('Short call x2',p+sd50)];
    } else if (legStrat === 'Standard butterfly') {
      legs = [leg('Long put',p-sd50),leg('Short put',p),leg('Short call',p),leg('Long call',p+sd50)];
    }
    strikeLine = `1 SD=${em45.toFixed(1)} pts | 0.5 SD=${sd50.toFixed(1)} pts | ${dte}d @ IV ${iv.toFixed(1)}%`;
  }

  // ── User strike overrides — pure substitution, no derivation math (Aug 2026) ──
  // Same contract as calc0DTE: inputs.overrideStrikes is { [legIndex]: strike }
  // keyed by index into the legs array as built above; overrideStrikesStrat gates
  // the map to the structure it was typed against. Applied BEFORE P(max loss)
  // reads the wings, so the tail runs on the substituted strikes. engineLegs
  // preserves the engine's suggestion for the UI and dual logging.
  const engineLegs = legs.map(l => ({ ...l }));
  const ovStrikes = inputs.overrideStrikes || null;
  let strikeOrderWarning = null;
  if (ovStrikes && legs.length > 0
      && (!inputs.overrideStrikesStrat || inputs.overrideStrikesStrat === legStrat)) {
    const Rov = n => Math.round(n / strikeStep45) * strikeStep45;   // same increment the builder uses
    legs = legs.map((l, i) => {
      const v = ovStrikes[i];
      // An absent/unparseable override falls back to the engine strike — never NaN.
      const k = (typeof v === 'number' && isFinite(v) && v > 0) ? Rov(v) : null;
      return k != null ? { ...l, strike: k } : l;
    });
    // Flag (never throw) when edits break the engine's relative strike ordering.
    for (let i = 1; i < legs.length; i++) {
      const d0 = Math.sign(engineLegs[i].strike - engineLegs[i - 1].strike);
      const d1 = Math.sign(legs[i].strike - legs[i - 1].strike);
      if (d0 !== 0 && d1 !== d0) {
        strikeOrderWarning = `Edited strikes break the ${legStrat} ordering: `
          + `${legs[i - 1].label} ${legs[i - 1].strike} vs ${legs[i].label} ${legs[i].strike}`;
        break;
      }
    }
  }

  // ── P(max loss): probability price settles in a max-loss tail by expiry ──
  // 45DTE version uses the full-DTE lognormal sigma (NOT the intraday 5.5h window
  // used in 0DTE): sigma = price × (IV/100) × √(DTE/365). Much wider distribution
  // than 0DTE, so tail probabilities run higher and brackets are recalibrated.
  function normCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp(-z * z / 2);
    let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? 1 - p : p;
  }
  let pMaxLoss = null, pMaxLossLow = null, pMaxLossHigh = null;
  let pMaxLossModel = null, pMaxLossDelta = null, pMaxLossSource = null;
  const DEBIT_MID_RISK = ['Long Condor - Reversed','Calendar spread','Diagonal spread'];
  if (legs.length > 0 && price > 0 && iv > 0 && dte > 0 && !DEBIT_MID_RISK.includes(legStrat)) {
    const strikes = legs.map(l => l.strike);
    const lowerWing = Math.min(...strikes);
    const upperWing = Math.max(...strikes);
    // ── Broken-wing geometry: which side carries the TRUE max-loss tail ──
    // A BWB / asymmetric fly loses its full max loss only under the WIDER (broken)
    // wing; the narrow side loses just the debit. Compute the risk side so both the
    // model and delta tail methods can zero the non-risk side. (Fix Jul 2026.)
    const uniqStrikes = [...new Set(strikes)].sort((a, b) => a - b);
    const bodyK = uniqStrikes.length >= 3 ? uniqStrikes[Math.floor(uniqStrikes.length / 2)] : null;
    const lowerWidth = bodyK != null ? bodyK - uniqStrikes[0] : null;
    const upperWidth = bodyK != null ? uniqStrikes[uniqStrikes.length - 1] - bodyK : null;
    const isBWB = legStrat === 'Broken wing butterfly' || legStrat === 'Asymmetric butterfly';
    const bwbRiskSide = (isBWB && lowerWidth != null && upperWidth != null && lowerWidth !== upperWidth)
      ? (upperWidth > lowerWidth ? 'high' : 'low') : null;
    // Right (call/put) of each OUTER wing, read from the leg labels.
    const wingRightAt = (k) => {
      const lg = legs.find(l => l.strike === k);
      return (lg && lg.label && lg.label.toLowerCase().includes('put')) ? 'put' : 'call';
    };
    // Horizon = time actually HELD, not full expiry. 45DTE trades are managed to
    // a 21 DTE exit, so P(max loss) uses the days-to-exit horizon (dte − 21),
    // not the full dte. Using full expiry overstated tail risk ~2x because it
    // priced 24 days of movement the trade is never exposed to.
    const holdDays = Math.max(dte - closeDte45, 1);
    const sigma = price * (iv / 100) * Math.sqrt(holdDays / 365);
    if (sigma > 0) {
      pMaxLossLow = normCdf((lowerWing - price) / sigma);
      pMaxLossHigh = 1 - normCdf((upperWing - price) / sigma);
      // One-sided risk strategies
      if (legStrat === 'Credit spread') {
        if (isBull || !isBear) pMaxLossHigh = 0; else pMaxLossLow = 0;
      } else if (legStrat === 'Bull call spread') { pMaxLossHigh = 0; }
      else if (legStrat === 'Bear put spread') { pMaxLossLow = 0; }
      else if (legStrat === 'Jade lizard') { pMaxLossHigh = 0; } // no upside risk by design
      // Broken-wing / asymmetric fly: max loss is one-sided (the wider wing).
      else if (isBWB && bwbRiskSide === 'high') { pMaxLossLow = 0; }  // safe side is the downside
      else if (isBWB && bwbRiskSide === 'low')  { pMaxLossHigh = 0; } // safe side is the upside
      pMaxLossModel = Math.min(1, (pMaxLossLow || 0) + (pMaxLossHigh || 0));

      // Delta-proxy cross-check (embeds real IV + skew)
      if (wingDeltas && (wingDeltas.lowerAbsDelta != null || wingDeltas.upperAbsDelta != null)) {
        // Right-aware (Fix Jul 2026): P(below a CALL strike) = 1 − |delta|; a PUT's
        // |delta| gives P(below) directly. Convert by each wing's ACTUAL right instead
        // of assuming lower=put / upper=call — an all-call fly's deep-ITM lower call
        // delta (~0.77) fed into the "P below" slot otherwise inflates P(max loss).
        const lowerRight = wingRightAt(lowerWing);
        const upperRight = wingRightAt(upperWing);
        let dLow = wingDeltas.lowerAbsDelta != null
          ? (lowerRight === 'call' ? Math.max(0, 1 - Math.abs(wingDeltas.lowerAbsDelta)) : Math.abs(wingDeltas.lowerAbsDelta))
          : (pMaxLossLow || 0);
        let dHigh = wingDeltas.upperAbsDelta != null
          ? (upperRight === 'put' ? Math.max(0, 1 - Math.abs(wingDeltas.upperAbsDelta)) : Math.abs(wingDeltas.upperAbsDelta))
          : (pMaxLossHigh || 0);
        if (legStrat === 'Bull call spread' || legStrat === 'Jade lizard') dHigh = 0;
        if (legStrat === 'Bear put spread') dLow = 0;
        if (legStrat === 'Credit spread') { if (isBull || !isBear) dHigh = 0; else dLow = 0; }
        if (isBWB && bwbRiskSide === 'high') dLow = 0;
        if (isBWB && bwbRiskSide === 'low')  dHigh = 0;
        pMaxLossDelta = Math.min(1, dLow + dHigh);
      }

      if (pMaxLossModel != null && pMaxLossDelta != null) {
        // Divergence guardrail (Fix Jul 2026): a large gap means one input is malformed;
        // prefer the smooth model over blending a bad delta into the score.
        if (Math.abs(pMaxLossModel - pMaxLossDelta) > 0.35) { pMaxLoss = pMaxLossModel; pMaxLossSource = 'model (delta rejected)'; }
        else { pMaxLoss = (pMaxLossModel + pMaxLossDelta) / 2; pMaxLossSource = 'blend'; }
      }
      else if (pMaxLossDelta != null) { pMaxLoss = pMaxLossDelta; pMaxLossSource = 'delta'; }
      else { pMaxLoss = pMaxLossModel; pMaxLossSource = 'model'; }
    }
  }

  // Scoring (100 pts)
  let setupScore = 0;
  const criteria = [];
  const ivrPts = ivr>60?25:ivr>40?21:ivr>20?13:ivr>10?7:0;
  setupScore += ivrPts; criteria.push({label:`IV Rank ${ivr>0?ivr.toFixed(0)+'%':'--'}`, pts:ivrPts, max:25});
  const ivhvPts = ivhvRatio>1.2?20:ivhvRatio>=1.0?12:ivhvRatio>0?4:0;
  setupScore += ivhvPts; criteria.push({label:`IV/HV ${ivhvRatio>0?ivhvRatio.toFixed(2):'--'}`, pts:ivhvPts, max:20});
  // Use the scored structure's OWN rating so a manual override scores its pick, not
  // the auto-pick (identical when no override). (Fix Jul 2026.)
  const scoreRating = (sorted.find(s => s.name === legStrat)?.rating) || bestRating;
  const stratFit = scoreRating==='EXCELLENT'?15:scoreRating==='GOOD'?10:scoreRating==='MARGINAL'?5:0;
  setupScore += stratFit; criteria.push({label:`Strategy fit (${scoreRating})`, pts:stratFit, max:15});
  const tEff = hasGreeks ? theta/bpr : 0;
  const tEffPts = !hasGreeks?8:tEff>0.02?15:tEff>0.01?10:tEff>0.005?5:0;
  setupScore += tEffPts; criteria.push({label:`Theta efficiency ${hasGreeks?tEff.toFixed(4):'--'}`, pts:tEffPts, max:15});
  const termPts = termBiasEff==='contango'?15:termBiasEff==='flat'?8:0;
  setupScore += termPts; criteria.push({label:`Term structure (${termBiasEff || 'unknown'})`, pts:termPts, max:15});

  // Tail risk — P(max loss) (10). Recalibrated for the 45DTE horizon: the wider
  // distribution means tail probabilities run higher than 0DTE, so brackets are
  // shifted up (10/20/30/40% rather than 5/10/15/25%).
  let tailPts45, tailLabel45;
  if (pMaxLoss == null) {
    tailPts45 = 5; tailLabel45 = 'Tail risk --';
  } else {
    tailPts45 = pMaxLoss < 0.10 ? 10 : pMaxLoss < 0.20 ? 8 : pMaxLoss < 0.30 ? 6 : pMaxLoss < 0.40 ? 3 : 0;
    const srcTag = pMaxLossSource === 'blend' ? ' (blend)' : pMaxLossSource === 'delta' ? ' (delta)' : '';
    tailLabel45 = `P(max loss) ${(pMaxLoss*100).toFixed(0)}%${srcTag}`;
  }
  setupScore += tailPts45; criteria.push({label:tailLabel45, pts:tailPts45, max:10});

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

  // ── EV calculation (tiered: estimated capture-fractions → measured history) ──
  // Same model as 0DTE. avgWin/avgLoss come from per-strategy capture fractions
  // until >= 50 closed trades exist for the strategy, then from realized stats.
  const EV_HISTORY_THRESHOLD = 50;
  const history = historyInput || (historyByStrategy ? historyByStrategy[legStrat] : null);
  const captureFractions45 = assumedCapture45;
  const { winCap: baseWinCap45, lossCap: baseLossCap45 } = captureFractions45(legStrat);
  // A structure managed on its DEBIT (the calendar: tastylive takes 25% of what was
  // paid) wins that, not a fraction of a model max profit. The default 0.40 × max
  // profit at the near expiry roughly doubled a calendar's average win. (Oct 2026.)
  const exitRule = exitRuleFor('45DTE', legStrat);
  // Measured capture from closed tickets (capture tracker) pulls the assumed
  // fractions toward reality as evidence builds — winners as a share of max
  // profit, losers as a share of max risk. (Oct 2026.)
  const capStat45 = captureByStrategy ? captureByStrategy[legStrat] : null;
  const debitBasis = exitRule.basis === 'entry' && risk > 0;
  // A debit-managed structure's prior is its target ÷ (max profit / debit), so it is
  // on the same "share of max profit" scale the tracker measures.
  const priorWin45 = debitBasis && win > 0 ? (risk * exitRule.target / 100) / win : baseWinCap45;
  const winCapB45 = blendCapture(priorWin45, capStat45 && capStat45.winCap, capStat45 && capStat45.winSamples);
  // Loss prior = the stop guide (100% of the entry premium), blended toward closed
  // losers — as 0DTE. (Oct 2026.)
  const stopFrac45 = stopLossFrac(inputs.netCreditDebit, risk);
  const lossCapB45 = blendCapture(stopFrac45 != null ? stopFrac45 : baseLossCap45, capStat45 && capStat45.lossCap, capStat45 && capStat45.lossSamples);
  const evWinCap = winCapB45.value, evLossCap = lossCapB45.value;
  const estAvgWin = debitBasis && !(win > 0)
    ? risk * exitRule.target / 100
    : win * evWinCap;
  const estAvgLoss = risk * evLossCap;
  const histTrades = history?.trades || 0;
  const hasMeasured = histTrades >= EV_HISTORY_THRESHOLD && history?.avgWin > 0 && history?.avgLoss > 0;
  const wMeasured = Math.min(1, histTrades / EV_HISTORY_THRESHOLD);
  const realWinP = (history?.winRate > 0) ? history.winRate : popFrac;
  const winP = (history?.winRate > 0) ? (1 - wMeasured) * popFrac + wMeasured * realWinP : popFrac;
  // Time spreads (calendar, diagonal): TWS shows no POP and the capture fractions
  // have nothing to anchor on, so the panel simulates the managed trade from the
  // payoff curve — target or time stop — and hands over avg win and avg loss.
  // (Oct 2026.) POP itself arrives through the pop input (model-filled when blank).
  const cm = inputs.curveModel && /Calendar|Diagonal/.test(legStrat) && !hasMeasured
    && inputs.curveModel.avgWin > 0 && inputs.curveModel.avgLoss > 0 ? inputs.curveModel : null;
  const avgWinUsed = hasMeasured ? history.avgWin : cm ? cm.avgWin : estAvgWin;
  const avgLossUsed = hasMeasured ? history.avgLoss : cm ? cm.avgLoss : estAvgLoss;
  // Distribution-weighted loss when P(max loss) is known (estimated mode):
  // price the max-loss tail explicitly rather than smearing into one average.
  let lossTerm45 = (1 - winP) * avgLossUsed, lossModel45 = cm ? 'curve' : 'flat';
  let lossTermHeld45 = null;
  if (pMaxLoss != null && (1 - winP) > 0 && risk > 0) {
    const pT = Math.min(pMaxLoss, 1 - winP);
    lossTermHeld45 = pT * risk + Math.max(0, (1 - winP) - pT) * risk * (baseLossCap45 * 0.6);
  }
  if (!hasMeasured && !cm && stopFrac45 != null && (1 - winP) > 0 && risk > 0) {
    lossModel45 = 'stop';                                   // lossTerm45 already = (1−winP) × risk × blended stop
  } else if (!hasMeasured && !cm && pMaxLoss != null && (1 - winP) > 0 && risk > 0) {
    const pTail = Math.min(pMaxLoss, 1 - winP);
    const pPartial = Math.max(0, (1 - winP) - pTail);
    const partialLoss = risk * (evLossCap * 0.6);
    lossTerm45 = pTail * risk + pPartial * partialLoss;
    lossModel45 = 'distribution';
  }
  // Round-trip commission, estimated model only (measured history is already net).
  const commUnits = unitsFromLegs(legs);
  const commRate = inputs.commissionPerContract != null ? Number(inputs.commissionPerContract) : DEFAULT_COMMISSION;
  const commRT = roundTripCommission(commUnits, 1, commRate);
  const commInEV = hasMeasured ? 0 : commRT;
  const evGross = (avgWinUsed > 0 && winP > 0)
    ? (winP * avgWinUsed) - lossTerm45 : 0;
  const ev = (avgWinUsed > 0 && winP > 0) ? evGross - commInEV : 0;
  const winBreakeven = (winP > 0 && evWinCap > 0)
    ? (lossTerm45 + commInEV) / (winP * evWinCap) : null;
  const evBasis = {
    mode: hasMeasured ? 'measured' : 'estimated',
    lossModel: lossModel45,
    pMaxLoss: pMaxLoss != null ? +(pMaxLoss).toFixed(4) : null,
    pMaxLossSource: pMaxLossSource,
    winBreakeven: winBreakeven != null ? Math.round(winBreakeven) : null,
    historyTrades: histTrades, threshold: EV_HISTORY_THRESHOLD,
    winCap: evWinCap, lossCap: evLossCap,
    stopLoss: stopFrac45 != null ? { pct: 100, frac: stopFrac45, perContract: Math.round(stopFrac45 * risk) } : null,
    evHeld: lossModel45 === 'stop' && lossTermHeld45 != null && avgWinUsed > 0 && winP > 0
      ? (winP * avgWinUsed) - lossTermHeld45 - commInEV : null,
    winBasis: debitBasis && winCapB45.source === 'assumed' ? `${exitRule.target}% of debit` : `${Math.round(evWinCap * 100)}% of max`,
    capture: { win: winCapB45, loss: lossCapB45, closed: capStat45 ? capStat45.closed : 0 },
    curve: cm ? { pTarget: cm.pTarget, paths: cm.paths, closeDte: cm.closeDte, modelPop: cm.pop, netSource: cm.netSource } : null,
    winP, avgWin: avgWinUsed, avgLoss: avgLossUsed, maxWin: win, maxLoss: risk,
    evGross, commission: commInEV, commissionRoundTrip: commRT, commissionUnits: commUnits, commissionRate: commRate
  };

  // ── Kelly (EXPECTED-LOSS, Jul 2026) — same rework as 0DTE ──
  // W/L ratio uses expected win vs expected loss (driven by P(max loss)) instead
  // of max win over half-max-loss. Varies naturally per strategy. Contracts are
  // still capped at TRUE max loss (risk) vs maxLoss/maxOpen for solvency.
  const lossProbK = 1 - winP;
  const expectedLossPerLoss = (lossProbK > 0 && lossTerm45 > 0)
    ? lossTerm45 / lossProbK
    : (risk / 2);
  const expectedWin = avgWinUsed > 0 ? avgWinUsed : win;
  const wlRatio = expectedLossPerLoss > 0 ? expectedWin / expectedLossPerLoss : 0;
  const kelly = wlRatio > 0 ? Math.max(0, winP - (1 - winP) / wlRatio) : 0;
  const bePop = (win + risk) > 0 ? risk / (win + risk) : 0;
  const kellyDollar = bankroll > 0 ? Math.min(kelly * bankroll, bankroll * 0.30) : 0;
  const popMargin = bePop > 0 && popFrac > 0 ? popFrac / bePop : 0;
  // SAFETY RAIL: total position risk at true max loss never exceeds limits.
  const riskCap = maxOpen > 0 ? Math.min(kelly * bankroll, maxLoss, maxOpen) : Math.min(kelly * bankroll, maxLoss);
  const fullC = risk > 0 ? Math.max(1, Math.floor(riskCap / risk)) : 1;
  const halfC = Math.max(1, Math.floor(fullC / 2));
  const contracts = setup === 'B Setup' ? halfC : fullC;
  const maxRisk = contracts * risk;
  const kellyOverRisk = risk > 0 && kellyDollar > 0 && risk > kellyDollar;

  // Greeks + Directional Edge
  let greeks = null;
  if (thetaAbs>0||vega>0||Math.abs(delta)>0) {
    const tvRatio = (thetaAbs>0&&vega>0)?vega/thetaAbs:0;

    // 45DTE Directional Edge
    // Remaining EM = IV × √(remaining DTE / 365) × price
    const remainingDTE = Math.max(dte - closeDte45, 1); // target exit at closeDte45 (21 by default)
    const daysToExit = dte - closeDte45; // days until planned exit
    const remainingEM = iv > 0 && price > 0 ? price * (iv / 100) * Math.sqrt(remainingDTE / 365) : 0;
    const directionalGain = Math.abs(delta) * remainingEM;
    const thetaPressure = thetaAbs * Math.max(daysToExit, 1); // magnitude — thetaPaid says which way it flows
    const edgeRatio = thetaPressure > 0 ? directionalGain / thetaPressure : directionalGain > 0 ? 99 : 0;

    // Strategy interpretation for 45DTE
    const isCreditStrat = legStrat.includes('Iron Condor') || legStrat.includes('Iron butterfly')
      || legStrat.includes('Put spread') || legStrat.includes('Call spread')
      || legStrat.includes('Strangle');
    const isDebitDir = legStrat.includes('Bull call') || legStrat.includes('Bear put')
      || legStrat.includes('Calendar') || legStrat.includes('Diagonal');

    let edgeSignal, edgeAction, edgePhase;
    if (thetaPaid) {
      // Paying decay over the holding period: only the move can cover it, so high is
      // the requirement regardless of what the strategy name suggests.
      if (edgeRatio > 2.0) { edgeSignal = 'excellent'; edgeAction = 'Move covers the decay paid over ' + daysToExit + ' days'; }
      else if (edgeRatio > 1.3) { edgeSignal = 'good'; edgeAction = 'Move should outpace the decay bill'; }
      else if (edgeRatio > 1.0) { edgeSignal = 'marginal'; edgeAction = 'Move barely covers decay — needs to arrive early in the hold'; }
      else { edgeSignal = 'poor'; edgeAction = 'Decay outruns the available move — this bleeds over the hold'; }
      edgePhase = 'paying decay';
    } else if (isCreditStrat) {
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
      directionalGain, thetaPressure, edgeRatio, edgeSignal, edgeAction, edgePhase, thetaPaid, thetaAbs,
      remainingEM, remainingDTE, daysToExit, isCreditStrat, isDebitDir
    };
  }

  // Decision
  const blockers = [], warnings = [];
  const missingSize = win<=0||risk<=0||popFrac<=0;
  let hardBlocker = '';
  if (!hasVol) hardBlocker = 'Enter IV, IVR and HV';
  else if (termBiasEff === 'backwardation') hardBlocker = 'Backwardation — avoid naked short premium';

  if (hasGreeks && tEff > 0 && tEff < 0.005) blockers.push('Theta efficiency too low');
  if (vix > 25) warnings.push('VIX >25 — reduce size');
  if (setup === 'B Setup') warnings.push(`B setup (${setupScore}/100) — half Kelly`);
  if (!missingSize && kelly <= 0) warnings.push('Kelly negative — edge insufficient, minimum 1 contract');
  if (ivr < 20) warnings.push('Low IVR — debit or calendars');
  if (!termBiasEff) warnings.push('Term structure unknown — fetch the vol surface or set term bias (scores 0/15 until then)');
  if (greeks && greeks.tvRatio > 4) warnings.push('Vega/theta elevated — vol expansion risk');
  // ── Daily backdrop (Oct 2026): the 45DTE replacements for the 0DTE session reads.
  const _sellsPremium = /Iron Condor|Chicken|Credit|Bull put|Bear call|Jade|Iron butterfly|Strangle|Ratio/i.test(legStrat);
  if (trend) {
    const z = trend.z20;
    if (trend.stretch === 'stretched up' && (isBull || /Bull|Call|Diagonal/.test(legStrat) && !/Bear call/.test(legStrat)))
      warnings.push(`Price stretched ${z.toFixed(1)}σ above its 20-day mean — bullish entries often give back to the mean first`);
    else if (trend.stretch === 'stretched down' && (isBear || /Bear|Put spread/.test(legStrat) && !/Bull put/.test(legStrat)))
      warnings.push(`Price stretched ${Math.abs(z).toFixed(1)}σ below its 20-day mean — bearish entries often give back to the mean first`);
    if (_sellsPremium && trend.hvRegime === 'coiled')
      warnings.push(`Realised vol coiled (HV10/HV60 ${trend.hvRatio.toFixed(2)}) — quiet stretches end in a move; size down short premium`);
    if (_sellsPremium && trend.hvRegime === 'expanding')
      warnings.push(`Realised vol expanding (HV10/HV60 ${trend.hvRatio.toFixed(2)}) — let it settle before selling premium`);
  }
  if (vixTermRatio >= 1) warnings.push(`VIX above VIX3M (${(+vixTermRatio).toFixed(2)}) — index stress: same direction odds, wider swings; size down`);
  // ── Scheduled macro events between entry and expiry (Aug 2026) ──
  // For a premium seller the COUNT matters more than any single date: each event is
  // another chance for vol to expand through the wings over a 45-day hold. Events in
  // the final week get called out separately — least time to recover, sharpest gamma.
  // Warn-only; the scorecard is untouched.
  // Warnings gate the decision; notices (coverage gaps, date provenance) never do.
  const _ev45 = eventRisk45DTE(nowET().dateISO, dte);
  _ev45.warnings.forEach(w => warnings.push(w));
  const notices = [..._ev45.notices];

  // ── Delta cross-check and delta strikes (R-49, Oct 2026) — see calc0dte.js ──
  const deltaCheck = deltaCrossCheck({ legs, strat: legStrat, horizon: '45dte',
    legGreeks: inputs.legGreeks || null, pop, price });
  deltaCheck.warnings.forEach(w => warnings.push(w));
  deltaCheck.notices.forEach(n => notices.push(n));
  const deltaPlan = deltaCheck.applicable && Array.isArray(inputs.legGreeks) && inputs.legGreeks.length
    ? deltaStrikePlan({ legs, strat: legStrat, horizon: '45dte', price, legGreeks: inputs.legGreeks,
        T: (dte > 0 ? dte : 45) / 365, underlying })
    : null;

  let decision, decisionClass;
  if (hardBlocker) { decision='No trade'; decisionClass='nogo'; }
  else if (setup === 'No setup') { decision='No trade'; decisionClass='nogo'; }
  else if (missingSize||bestRating==='POOR'||blockers.length) { decision=missingSize?'Enter sizing':'Review signals'; decisionClass='nogo'; }
  else if (warnings.length) { decision='Trade with caution'; decisionClass='warn'; }
  else { decision='Trade'; decisionClass='go'; }

  // ═══════════════════════════════════════
  //  TRADE CONFIDENCE (gated, multiplicative) — 45DTE parity with 0DTE.
  //  Setup Quality answers "clean pattern?"; Confidence answers "risk money NOW?".
  //  One fatal flaw (negative EV, edge/structure conflict, bad reward:risk) SINKS
  //  the number instead of being averaged away by the additive setup. The 45DTE
  //  direction coherence keys off the purpose-built Directional Edge (already
  //  structure-aware: credit wants theta-dominant, debit wants move-dominant),
  //  not the coarse `outlook`. (Jul 2026)
  // ═══════════════════════════════════════
  const confConflicts = [];
  // Premium axis (name-based; calc45 has no net credit/debit input): sellers want
  // RICH vol, buyers want CHEAP vol. 'Iron butterfly' is a credit seller; the plain
  // /butterfly/ flies are debit buyers — order the tests so iron is caught first.
  const isCreditSell = /Iron Condor|Iron butterfly|Credit spread|Jade lizard/i.test(legStrat);
  const isDebitBuy = /Broken wing|Asymmetric|Standard butterfly|Calendar|Diagonal|Bull call|Bear put|Ratio/i.test(legStrat);

  // ── edgeGate: positive expectancy, EV normalised by CAPITAL AT RISK ──
  // Mirrors the 0DTE rework (Jul 2026): ev/risk not ev/win, and one continuous
  // line through 0.75 at EV = 0 instead of a 0.55 → 0.70 cliff.
  let edgeGate45;
  if (missingSize || risk <= 0) {
    edgeGate45 = 0.5;
  } else {
    const evRatio = ev / risk;
    edgeGate45 = Math.max(0.06, Math.min(1, 0.75 + evRatio * 1.6));
  }

  // ── payoffGate: broken-geometry floor only — EV already prices reward:risk ──
  let payoffGate45 = 1;
  if (win > 0 && risk > 0) {
    const rr = win / risk;
    payoffGate45 = rr >= 0.20 ? 1.00 : rr >= 0.12 ? 0.90 : rr >= 0.06 ? 0.72 : 0.55;
    if (rr < 0.12) confConflicts.push({ tag: 'Reward:Risk',
      label: `Reward:risk ${rr.toFixed(2)} — one loss erases ${Math.round(1 / rr)} wins`, severity: 'high' });
  }

  // ── coherenceGate: Directional Edge + IV regime vs structure ──
  let coherenceGate45 = 1;
  // (a) Direction↔Structure via the 45DTE Directional Edge (structure-aware). Skipped
  //     when greeks are missing (edgeSignal null → can't judge → neutral).
  const eSig = greeks?.edgeSignal || null;
  if (eSig === 'marginal') {
    coherenceGate45 *= 0.75;
    confConflicts.push({ tag: 'Direction↔Structure',
      label: `Directional Edge marginal for ${legStrat} — ${greeks.edgeAction}`, severity: 'low' });
  } else if (eSig === 'poor') {
    coherenceGate45 *= 0.55;
    confConflicts.push({ tag: 'Direction↔Structure',
      label: `Directional Edge poor for ${legStrat} — ${greeks.edgeAction}`, severity: 'high' });
  }
  // (b) Vol↔Structure — sellers into cheap vol / buyers into rich vol.
  if (isCreditSell && ivr > 0 && ivr < 25) {
    coherenceGate45 *= 0.65;
    confConflicts.push({ tag: 'Vol↔Structure',
      label: `Selling premium into low IV rank (${ivr.toFixed(0)}%)`, severity: 'high' });
  } else if (isDebitBuy && ivr > 60) {
    coherenceGate45 *= 0.75;
    confConflicts.push({ tag: 'Vol↔Structure',
      label: `Buying premium into rich IV rank (${ivr.toFixed(0)}%)`, severity: 'low' });
  }
  // (c) Regime↔Structure (mild) — IV below realised undermines a premium sale.
  if (isCreditSell && ivhvRatio > 0 && ivhvRatio < 1.0) {
    coherenceGate45 *= 0.9;
    confConflicts.push({ tag: 'Regime↔Structure',
      label: `IV below realised (IV/HV ${ivhvRatio.toFixed(2)}) — thin premium edge`, severity: 'low' });
  }

  // ── Composite (gated, multiplicative) ──
  const confRaw45 = setupScore * edgeGate45 * coherenceGate45 * payoffGate45;
  const tradeConfidence = missingSize ? null : Math.max(0, Math.min(100, Math.round(confRaw45)));
  const confidenceTier = tradeConfidence == null ? '--'
    : tradeConfidence >= 70 ? 'High'
    : tradeConfidence >= 50 ? 'Moderate'
    : tradeConfidence >= 30 ? 'Low'
    : tradeConfidence >= 15 ? 'Weak' : 'Avoid';
  const confGates45 = [
    { v: edgeGate45, msg: (win > 0 && ev < 0) ? `Negative EV ($${Math.round(ev)})` : 'Thin edge' },
    { v: coherenceGate45, msg: confConflicts.find(c => c.tag.includes('↔'))?.label || 'Signal conflict' },
    { v: payoffGate45, msg: (win > 0 && risk > 0) ? `Reward:risk ${(win / risk).toFixed(2)}` : 'Payoff' }
  ];
  const bindingGate45 = confGates45.reduce((a, b) => (b.v < a.v ? b : a));
  const confidenceDriver = missingSize
    ? 'Enter sizing to score confidence'
    : tradeConfidence >= 50
      ? `Carried by ${ev > 0 ? `EV +$${Math.round(ev)}` : 'a clean setup'} · coherent signals`
      : `Limited by ${bindingGate45.msg}`;

  // Management targets
  const sdRange = (hasPrice && hasVol) ? { oneSD: em45, halfSD: em45*0.5 } : null;

  return {
    em45, ivhvRatio, ivhvLabel, ivrBand, ivrStructures,
    termDiff, termLabel, skew, termBias: termBiasEff, termRatio, termDerived: hasTerm, closeDte: closeDte45,
    regime, regimeCommentary: REGIME_COMMENTARY45[regime],
    ratings: sorted, bestStrat, bestRating, legStrat, overrideStrategy, runnerUp, tiebreakApplied,
    legs, engineLegs, strikeOrderWarning, strikeLine, deltaCheck, deltaPlan,
    eventsToExpiry: _ev45.events, eventHighCount: _ev45.highCount, eventExpiryISO: _ev45.expiryISO, notices,
    setupScore, setup, criteria,
    pMaxLoss, pMaxLossLow, pMaxLossHigh, pMaxLossModel, pMaxLossDelta, pMaxLossSource,
    kelly, kellyDollar, kellyOverRisk, popMargin, bePop, wlRatio,
    ev, evBasis,
    targetCredit, targetLabel,
    fullC, halfC, contracts, maxRisk, tEff,
    greeks, sdRange, deltaGuide: DELTA_GUIDE,
    decision, decisionClass, hardBlocker, blockers, warnings, missingSize,
    tradeConfidence, confidenceTier, confidenceDriver, confConflicts,
    behaviour: MARKET_BEHAVIOUR_45DTE[legStrat] || '',
    outlook, trend: trend || null, vixTermRatio: vixTermRatio || null
  };
}
