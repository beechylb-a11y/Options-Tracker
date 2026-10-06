// ── Open 45DTE check-up (Oct 2026) ──
//
// For a 45DTE trade already on: is it going to plan, and what does the playbook
// say to do now — hold, take profit, roll, or close. Pure function; the panel
// gathers the inputs (TWS legs and marks, the vol surface, the logged ticket).
//
// "The plan" is the trade as entered with nothing moving but the calendar: the
// legs re-priced at the ENTRY spot and ENTRY IV, today. That is what theta alone
// should have paid by now. The gap to the actual P&L splits into what price did
// and what volatility did, so "behind plan" comes with a reason.
//
// The rules are tastylive's where they have one (claude/45dte-exit-rules-tastylive-
// oct2026.md): take short premium at 50% (iron fly 25%), close by 21 DTE, defend a
// tested condor by rolling the untested side, a tested credit spread by rolling out
// in time for a credit, leave long flies alone, close a calendar that price has left.
// Thresholds marked "ours" are the app's, to calibrate against closes.

import { bsPrice, RATE, divYieldOf } from './payoffCurve';
import { exitRuleFor, STOP_LOSS_PCT } from './data';
import { trendFit } from './trend';
import { eventRisk45DTE } from './events';
import CALENDAR from './econ-calendar.js';

const pad = n => String(n).padStart(2, '0');
const ymdToDate = s => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), 12);
export const daysBetweenYmd = (a, b) => Math.round((ymdToDate(b) - ymdToDate(a)) / 86400000);
const isoOf = ymd => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
export const ymdOfIso = iso => String(iso || '').slice(0, 10).replace(/-/g, '');

export const TESTED_DELTA = 0.30;      // tastylive's usual "tested" mark on a short strike
export const PRESSURED_DELTA = 0.25;   // ours: worth watching
export const UNTESTED_DELTA = 0.15;    // ours: far enough to roll toward price
export const CAL_DRIFT_SD = 1.0;       // ours: a calendar this many σ from its strike rarely recovers

export function familyOf(strategy) {
  const s = String(strategy || '');
  if (/Calendar|Diagonal/i.test(s)) return 'time';
  if (/Reversed/i.test(s)) return 'longGamma';
  if (/Iron Condor|Chicken|Iron butterfly|Strangle|Straddle/i.test(s)) return 'condor';
  if (/Bull put|Bear call|Credit spread/i.test(s)) return 'creditVertical';
  if (/Jade/i.test(s)) return 'jade';
  if (/Broken wing|BWB/i.test(s)) return 'bwb';
  if (/Ratio/i.test(s)) return 'ratio';
  if (/butterfly/i.test(s)) return 'longFly';
  if (/Bull call|Bear put/i.test(s)) return 'debitVertical';
  return 'other';
}
const SHORT_PREMIUM = ['condor', 'creditVertical', 'jade'];

// Value per share of the holding (signed: + you own value, − you owe it).
function valueOf(legs, S, ivShift, dayOffset, todayYmd, underlying, ivOf) {
  const q = divYieldOf(underlying);
  let v = 0;
  for (const l of legs) {
    const days = daysBetweenYmd(todayYmd, l.expiry) - dayOffset;
    const iv = Math.max(0.01, (ivOf(l) + ivShift) / 100);
    v += l.qty * bsPrice(S, l.strike, Math.max(0, days) / 365, iv, l.right, RATE, q);
  }
  return v;
}

/**
 * @param p.strategy   engine strategy name ("Iron Condor - Normal")
 * @param p.legs       [{ strike, right:'C'|'P', qty (signed, per ONE lot), expiry:'YYYYMMDD',
 *                       iv? (%), delta? (per contract), bid?, ask? }]
 * @param p.qtyOpen    lots still open
 * @param p.entry      { ncd (per share, + credit / − debit), dateYmd, spot?, iv? (% ATM),
 *                       maxProfit? ($ per lot), maxRisk? ($ per lot) }
 * @param p.now        { todayYmd, spot, iv? (% ATM), mark? (per share, signed value of
 *                       the holding — Σ qty×mid), delta?, theta?, vega? (net, $ per lot) }
 * @param p.trend      computeTrend() output, optional
 * @param p.underlying for the dividend yield
 */
export function reviewOpen45(p) {
  const { strategy, legs = [], qtyOpen = 1, entry = {}, now = {}, trend = null, underlying = 'SPX' } = p;
  const fam = familyOf(strategy);
  const rule = exitRuleFor('45DTE', strategy);
  const today = now.todayYmd;
  const out = { family: fam, rule, metrics: {}, chips: [], reasons: [], steps: [], warnings: [] };
  if (!legs.length || !today) {
    out.action = 'unknown'; out.headline = 'Legs not found — can’t check this one';
    return out;
  }

  // ── Time ──
  const expiries = [...new Set(legs.map(l => l.expiry))].sort();
  const nearExp = expiries[0];
  const dte = daysBetweenYmd(today, nearExp);
  const entryYmd = entry.dateYmd || today;
  const entryDte = daysBetweenYmd(entryYmd, nearExp);
  const closeDte = rule.closeDte || 21;
  const daysHeld = Math.max(0, daysBetweenYmd(entryYmd, today));
  const planDays = Math.max(1, entryDte - closeDte);
  const daysToClose = dte - closeDte;
  const timeFrac = Math.min(1, daysHeld / planDays);

  // ── Money (per share, then $) ──
  const ncd = Number(entry.ncd) || 0;
  const isCredit = ncd > 0;
  const mark = isFinite(now.mark) ? now.mark : null;
  const pnlShare = mark != null ? mark + ncd : null;
  const maxProfitShare = entry.maxProfit > 0 ? entry.maxProfit / 100 : (isCredit ? ncd : null);
  const base = rule.basis === 'entry' ? Math.abs(ncd) : maxProfitShare;
  const targetShare = base ? base * rule.target / 100 : null;
  const progress = pnlShare != null && targetShare ? pnlShare / targetShare : null;
  const pctOfMax = pnlShare != null && maxProfitShare ? pnlShare / maxProfitShare : null;
  const lot$ = x => x == null ? null : Math.round(x * 100);

  // ── Plan: theta alone, at entry spot and IV ──
  const ivNowOf = l => (l.iv > 0 ? l.iv : now.iv) || 0;
  const ivShift = entry.iv > 0 && now.iv > 0 ? now.iv - entry.iv : 0;     // ATM pts since entry
  let attribution = null, planShare = null;
  const canModel = entry.spot > 0 && now.spot > 0 && legs.every(l => ivNowOf(l) > 0);
  if (canModel) {
    const V = (S, shift, off) => valueOf(legs, S, shift, off, today, underlying, ivNowOf);
    const v0 = V(entry.spot, -ivShift, -daysHeld);         // at entry: entry spot, entry vol, entry date
    const vT = V(entry.spot, -ivShift, 0);                 // today, nothing else moved
    const vP = V(now.spot, -ivShift, 0);                   // today, price moved
    const vV = V(now.spot, 0, 0);                          // today, price and vol moved
    planShare = (vT - v0);
    attribution = {
      time: lot$(vT - v0), price: lot$(vP - vT), vol: lot$(vV - vP),
      model: lot$(vV - v0),
      other: pnlShare != null ? lot$(pnlShare - (vV - v0)) : null,   // fills, skew, model error
    };
  } else if (targetShare) {
    planShare = targetShare * timeFrac;                    // straight-line pace to the target
  }

  // ── Where price sits against each short ──
  const shorts = legs.filter(l => l.qty < 0).map(l => {
    const d = Math.max(1, daysBetweenYmd(today, l.expiry));
    const sd = now.spot * (ivNowOf(l) / 100) * Math.sqrt(d / 365);
    const toward = l.right === 'P' ? now.spot - l.strike : l.strike - now.spot;   // + = OTM cushion
    const absDelta = isFinite(l.delta) ? Math.abs(l.delta) : null;
    const itm = toward < 0;
    const tested = itm || (absDelta != null ? absDelta >= TESTED_DELTA : sd > 0 && toward / sd < 0.5);
    const pressured = !tested && (absDelta != null ? absDelta >= PRESSURED_DELTA : sd > 0 && toward / sd < 0.8);
    const untested = absDelta != null ? absDelta < UNTESTED_DELTA : sd > 0 && toward / sd > 1.2;
    return { strike: l.strike, right: l.right, expiry: l.expiry, cushion: toward, cushionSd: sd > 0 ? toward / sd : null,
      absDelta, itm, tested, pressured, untested };
  });
  // A time spread or a long fly WANTS its short at the money — "tested" means nothing
  // there. A BWB is tested only when price is past the body on the broken-wing side.
  if (fam === 'time' || fam === 'longFly') shorts.forEach(s => { s.tested = s.pressured = false; s.untested = true; });
  if (fam === 'bwb') {
    const longs = legs.filter(l => l.qty > 0);
    shorts.forEach(s => {
      const far = longs.slice().sort((a, b) => Math.abs(b.strike - s.strike) - Math.abs(a.strike - s.strike))[0];
      const riskUp = far && far.strike > s.strike;
      s.tested = !!far && (riskUp ? now.spot > s.strike : now.spot < s.strike);
      s.pressured = false;
    });
  }
  const testedShorts = shorts.filter(s => s.tested);
  const putShort = shorts.filter(s => s.right === 'P').sort((a, b) => a.cushion - b.cushion)[0];
  const callShort = shorts.filter(s => s.right === 'C').sort((a, b) => a.cushion - b.cushion)[0];

  // ── Backdrop ──
  const fit = trendFit(trend, now.delta);
  const ivChange = ivShift ? +ivShift.toFixed(1) : 0;
  const shortVega = isFinite(now.vega) ? now.vega < 0 : isCredit;
  let events = [];
  try { events = eventRisk45DTE(isoOf(today), Math.max(0, daysToClose)).events.filter(e => ((CALENDAR.severity || {})[e.kind]) === 'high'); }
  catch (e) { events = []; }

  // ── Pace verdict ──
  let pace;
  if (pnlShare == null) pace = 'unknown';
  else if (targetShare && pnlShare >= targetShare) pace = 'target';
  else if (planShare != null && planShare > 0 && pnlShare >= planShare * 0.8) pace = pnlShare >= planShare * 1.2 ? 'ahead' : 'on plan';
  else if (planShare != null && planShare <= 0 && pnlShare >= planShare) pace = 'on plan';   // debit structures pay theta early
  else if (pnlShare >= 0) pace = 'behind';
  else pace = 'off plan';

  out.metrics = {
    dte, entryDte, closeDte, daysHeld, daysToClose, timeFrac: +timeFrac.toFixed(2), nearExp,
    pnlShare: pnlShare != null ? +pnlShare.toFixed(2) : null,
    pnl$: pnlShare != null ? Math.round(pnlShare * 100 * qtyOpen) : null,
    pnlLot$: lot$(pnlShare), plan$: planShare != null ? Math.round(planShare * 100 * qtyOpen) : null,
    target$: targetShare ? Math.round(targetShare * 100 * qtyOpen) : null,
    progress: progress != null ? +progress.toFixed(2) : null,
    pctOfMax: pctOfMax != null ? +pctOfMax.toFixed(2) : null,
    attribution, pace, ivChange, shortVega, trendFit: fit, events, shorts,
    targetLabel: `${rule.target}% of ${rule.basis === 'entry' ? 'the debit' : 'max profit'}`,
  };
  // Stop guide: lose 100% of the entry premium (credit: buy back at 2×; debit: worth nothing).
  const stopPct = p.stopPct != null && isFinite(p.stopPct) && p.stopPct > 0 ? +p.stopPct : STOP_LOSS_PCT;
  const stopShare = Math.abs(ncd) > 0 ? Math.abs(ncd) * stopPct / 100 : null;
  out.metrics.stopPct = stopPct;
  out.metrics.stopPrice = stopShare != null ? +(isCredit ? Math.abs(ncd) + stopShare : Math.max(0, Math.abs(ncd) - stopShare)).toFixed(2) : null;
  out.metrics.stop$ = stopShare != null ? -Math.round(stopShare * 100 * qtyOpen) : null;
  out.metrics.toStop$ = stopShare != null && pnlShare != null ? Math.round((pnlShare + stopShare) * 100 * qtyOpen) : null;
  const stopHit = stopShare != null && pnlShare != null && pnlShare <= -stopShare;

  // ── What to do ──
  const act = (action, tone, headline) => { out.action = action; out.tone = tone; out.headline = headline; };
  const sideName = s => (s.right === 'P' ? 'put' : 'call');
  const S = out.steps, W = out.reasons;
  const rollCredit = 'only for a net credit — a roll that costs a debit is a new bet, close instead';

  if (pace === 'target') {
    act('take-profit', 'green', `Take profit — at ${Math.round((progress || 1) * rule.target)}% vs the ${rule.target}% target`);
    W.push(`tastylive manages ${strategy} at ${out.metrics.targetLabel}; the rest of the curve pays less per day of risk.`);
    S.push(`Close all ${qtyOpen} at about ${mark != null ? Math.abs(mark).toFixed(2) : 'the mid'} ${isCredit ? 'debit' : 'credit'}.`);
  } else if (stopHit) {
    act('close', 'red', `Stop hit — down ${Math.round(-pnlShare / Math.abs(ncd) * 100)}% of the ${isCredit ? 'credit' : 'debit'}`);
    W.push(`Your stop guide is ${stopPct}% of the ${isCredit ? 'credit' : 'debit'} (${isCredit ? 'buy back at ' : 'close at '}${out.metrics.stopPrice.toFixed(2)}).`);
    S.push(`Close all ${qtyOpen} at about ${mark != null ? Math.abs(mark).toFixed(2) : 'the mid'} ${isCredit ? 'debit' : 'credit'}.`);
    if (SHORT_PREMIUM.includes(fam) && dte > closeDte) S.push(`Or roll out in time ${rollCredit} — tastylive found rolling beat stopping on 45-DTE short premium.`);
  } else if (dte <= closeDte) {
    const tested = testedShorts.length > 0;
    if (SHORT_PREMIUM.includes(fam) && !tested && (pnlShare || 0) >= 0) {
      act('close-or-roll', 'amber', `Time stop: ${dte} DTE — close, or roll to the next cycle`);
      S.push('Close it, or roll every leg out to the ~45-DTE expiry, same strikes, ' + rollCredit + '.');
    } else {
      act('close', 'red', `Time stop: ${dte} DTE — close`);
      if (SHORT_PREMIUM.includes(fam) && tested) S.push(`Rolling a tested position out is possible ${rollCredit}.`);
    }
    W.push(fam === 'time'
      ? `Calendars and diagonals close at ${closeDte} DTE on the front leg; after that the front leg’s gamma runs the trade.`
      : `Inside ${closeDte} DTE gamma accelerates — tastylive’s research found the biggest losers there, and a time stop beat any P&L stop.`);
  } else if (SHORT_PREMIUM.includes(fam) && testedShorts.length) {
    const t = testedShorts[0];
    const other = t.right === 'P' ? callShort : putShort;
    if (fam === 'condor' && other && other.untested && testedShorts.length === 1) {
      act('roll-untested', 'amber', `Roll the untested ${sideName(other)} side toward price`);
      W.push(`The ${t.strike}${t.right} is tested${t.absDelta != null ? ` (${Math.round(t.absDelta * 100)}Δ)` : ''}; the ${other.strike}${other.right} is doing nothing${other.absDelta != null ? ` (${Math.round(other.absDelta * 100)}Δ)` : ''}.`);
      S.push(`Move the ${sideName(other)} spread ${other.right === 'P' ? 'up' : 'down'} toward price — short to roughly 25–30Δ — for extra credit. Same expiry.`);
      S.push('That widens break-even on the tested side by the credit taken in. Keep the tested side as it is.');
    } else if (fam === 'condor' && testedShorts.length >= 2) {
      act('close', 'red', 'Both sides tested — close or cut size');
      W.push('Price has run through the body; there is no untested side left to roll for credit.');
    } else if (fam === 'condor' && other && !other.untested) {
      act('watch', 'amber', `${sideName(t).replace(/^./, c => c.toUpperCase())} side tested — the other side is too close to roll`);
      W.push(`Rolling the ${other.strike}${other.right} toward price would leave almost no room between the shorts.`);
      S.push(`Hold to the ${closeDte}-DTE stop, or close the tested ${sideName(t)} spread if it reaches 2× the credit taken for it.`);
    } else {
      act('roll-out', 'amber', `Tested at ${t.strike}${t.right} — roll out in time`);
      W.push(`The short ${t.strike}${t.right} is ${t.itm ? 'in the money' : 'tested'}${t.absDelta != null ? ` (${Math.round(t.absDelta * 100)}Δ)` : ''} with ${dte} days left.`);
      S.push(`Roll the spread to the next ~45-DTE expiry at the same strikes, ${rollCredit}.`);
      S.push('tastylive rolls while the short leg still has more extrinsic value than the long — earlier is easier.');
    }
  } else if (fam === 'debitVertical' && pnlShare != null && pnlShare <= -0.5 * Math.abs(ncd) && fit < 0) {
    act('close', 'red', 'Thesis broken — half the debit gone and the trend is against you');
    W.push('A debit spread needs the move; with the daily trend the other way, the remaining debit is the cheaper exit.');
  } else if (fam === 'time') {
    const k = legs[0].strike;
    const d = Math.max(1, dte);
    const sd = now.spot * ((now.iv || ivNowOf(legs[0])) / 100) * Math.sqrt(d / 365);
    const away = sd > 0 ? Math.abs(now.spot - k) / sd : 0;
    out.metrics.calendarDriftSd = +away.toFixed(2);
    if (away >= CAL_DRIFT_SD && (pnlShare || 0) < 0) {
      act('close', 'red', `Price has left the strike — ${away.toFixed(1)}σ from ${k}`);
      W.push('A time spread makes its money with price at the strike; movement is the enemy and this far out it rarely comes back before the front leg goes.');
    } else if (/Diagonal/i.test(strategy) && testedShorts.length) {
      act('roll-short', 'amber', `Short ${testedShorts[0].strike}${testedShorts[0].right} tested — roll it toward break-even`);
      S.push('Buy back the short, sell the same expiry closer to break-even (or the next weekly) for a credit. Keep the debit under 75% of the width.');
    }
  } else if (fam === 'bwb' && testedShorts.length) {
    act('roll-out', 'amber', 'Risk side tested — roll the short spread out');
    W.push('The broken wing carries the risk; with price through the body that side is now the trade.');
    S.push(`Roll the short spread (the body and the far wing) out in time ${rollCredit}, or close the whole fly.`);
  } else if (fam === 'ratio' && testedShorts.length) {
    act('roll-out', 'amber', 'Extra short tested — roll it out');
    S.push(`Sell the embedded long spread for what it’s worth and roll the naked short out in time ${rollCredit}.`);
  }

  if (!out.action) {
    const lbl = pace === 'ahead' ? 'Hold — ahead of plan' : pace === 'on plan' ? 'Hold — on plan'
      : pace === 'behind' ? 'Hold — behind plan, nothing to fix yet' : pace === 'off plan' ? 'Hold — under water, inside the rules'
      : 'Hold';
    act('hold', pace === 'off plan' || pace === 'behind' ? 'amber' : 'green', lbl);
    if (fam === 'longFly') W.push('Long flies are not managed — the most this can lose is what you paid. Most of the value arrives late.');
    if (daysToClose <= 5) S.push(`Time stop in ${daysToClose} day${daysToClose === 1 ? '' : 's'} (${closeDte} DTE).`);
    if (targetShare) S.push(`Take profit at ${out.metrics.targetLabel}: about +$${Math.round(targetShare * 100 * qtyOpen)}.`);
  }

  // ── Context lines (never change the action) ──
  shorts.filter(s => s.pressured).forEach(s => out.warnings.push(`${s.strike}${s.right} getting close${s.absDelta != null ? ` — ${Math.round(s.absDelta * 100)}Δ` : ''}; ${TESTED_DELTA * 100}Δ is the tested mark.`));
  if (fit < 0) out.warnings.push(`The daily trend is ${trend.outlook} and your delta leans the other way.`);
  if (shortVega && ivChange >= 2) out.warnings.push(`IV up ${ivChange} pts since entry — hurting a short-vega position.`);
  if (trend && trend.hvRegime === 'expanding' && SHORT_PREMIUM.includes(fam)) out.warnings.push(`Realised vol expanding (HV10/HV60 ${trend.hvRatio}).`);
  if (events.length) out.warnings.push(`${events.length} major event${events.length > 1 ? 's' : ''} before the time stop: ${events.map(e => `${e.label} ${e.date.slice(5)}`).join(', ')}.`);
  return out;
}
