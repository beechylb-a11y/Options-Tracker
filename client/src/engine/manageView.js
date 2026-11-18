// ── Manage view for one open trade (Nov 2026, phase 4) ──
//
// The cockpit layout, pointed at a position instead of a ticket: one verdict and one
// primary action, the payoff chart on the live price, the legs streaming, the orders
// working in TWS, and how the position got here (its roll chain). Pure helpers; the
// panel (TradeDetail) fetches and draws.
//
//   liveQuotesFor   the push stream's quotes in the /api/option-greeks shape, so
//                   positionRisk() values the position exactly as it did from polling
//   positionCurve   the PayoffChart inputs for the whole position (all lots, rolls in)
//   manageVerdict   what to do now: close / roll / hold, and every alert that fired
//   positionOrders  the working orders on this underlying, this ticket's first
//   tradeStory      the roll chain as steps, oldest first, ending at the open ticket

import { yearsToExpiry, ivFor, plannedExit, etWall } from './portfolio.js';
import { RATE, divYieldOf, priceRange } from './payoffCurve.js';
import { exitRuleFor } from './data.js';
import { liveKey, markOf } from '../live/liveStore.js';

// Trading time for an intraday chart: 6.5 h is one trading day, 252 of them a year,
// in the chart's calendar-day units. Same constant as PayoffChart.
export const IDPH = 365 / (6.5 * 252);
const BELL_MIN = 16 * 60, OPEN_MIN = 9 * 60 + 30;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DONE = /^(Filled|Cancelled|ApiCancelled|Inactive|PendingCancel)$/;

const money = v => (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();
const hm = s => { const [h, m] = String(s || '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };

/** The stream's keys for a position's legs, in leg order. */
export function legKeysOf(p) {
  if (!p || !Array.isArray(p.legs)) return [];
  return p.legs.map(l => liveKey(p.underlying, l.expiry, l.strike, l.right));
}

/**
 * Live quotes for every leg in the shape positionRisk() reads from /api/option-greeks,
 * or null while any leg has no price yet (half a mark is worse than the model).
 * @param quotes the live store's quotes by key
 */
export function liveQuotesFor(p, quotes) {
  const keys = legKeysOf(p);
  if (!keys.length || !quotes) return null;
  const qs = keys.map(k => quotes[k]);
  if (qs.some(q => !q || markOf(q) == null)) return null;
  const legs = qs.map(q => ({ greeks: { bid: q.bid ?? null, ask: q.ask ?? null, optPrice: q.mark ?? markOf(q),
    iv: q.iv > 0 ? q.iv : null, delta: q.delta ?? null } }));
  const und = quotes[String(p.underlying || '').toUpperCase()];
  const undPrice = (und && (und.mark ?? markOf(und))) || qs.map(q => q.und).find(v => v > 0) || null;
  let net = null;
  if (qs.every(q => Number.isFinite(q.delta))) {
    net = { delta: 0, gamma: 0, theta: 0, vega: 0 };
    p.legs.forEach((l, i) => {
      const q = qs[i], m = (Number(l.qty) || 0) * 100;
      net.delta += q.delta * m; net.gamma += (q.gamma || 0) * m; net.theta += (q.theta || 0) * m; net.vega += (q.vega || 0) * m;
    });
  }
  const ts = Math.min(...qs.map(q => q.ts || 0));
  return { legs, undPrice, net, ts: ts || null, delayed: qs.some(q => q.delayed), source: 'stream' };
}

/**
 * PayoffChart inputs for the open contracts, rolls included.
 * @param legs positionRisk().legs (live IV where quoted)
 * @returns null without legs or a price, else
 *   { cl, net, lo, hi, nearDte, closeDay, closeDte, closeEt, intraday, isTimeSpread, sigmaNear, divYield, lots }
 */
export function positionCurve(p, legs, spot, { now = new Date(), banked = 0 } = {}) {
  if (!p || !Array.isArray(legs) || !legs.length || !(spot > 0)) return null;
  const lots = p.live > 0 ? p.live : (p.qty || 1);
  const ncd = Number(p.pos && p.pos.ncd) || 0;
  const net = ncd * lots + (Number(banked) || 0) / 100;
  const w = etWall(now);
  const exps = legs.map(l => String(l.expiry));
  const intraday = exps.every(e => e === w.ymd);
  const isTimeSpread = new Set(exps).size > 1;
  const divYield = divYieldOf(p.underlying);

  let dteOf, closeDay, closeEt = '', closeDte = null;
  if (intraday) {
    // Trading hours only: before 09:30 the clock starts at the open.
    const from = Math.max(w.min, OPEN_MIN);
    const bellH = Math.max(0.05, (BELL_MIN - from) / 60);
    const T = bellH * IDPH;
    dteOf = () => T;
    closeEt = exitRuleFor('0DTE', p.strategy).closeEt || '15:00';
    const exitH = Math.max(0, (hm(closeEt) - from) / 60);
    closeDay = Math.min(T, exitH * IDPH);
  } else {
    dteOf = l => yearsToExpiry(l.expiry, now) * 365;
    closeDte = exitRuleFor('45DTE', p.strategy).closeDte || 21;
  }
  // A live leg IV is TWS's, quoted on calendar time. On the intraday trading clock the
  // same total variance to the bell is kept (iv × √(calendar / trading)), so the "now"
  // curve passes through the market's own mark. A ticket or VIX1D IV is used as is,
  // like the engine's chart. (Nov 2026.)
  // Rate and dividend scale by the same ratio, so the forward matches too.
  const clockOf = l => {
    const v = ivFor(p, l);
    if (!intraday || !v.live) return { iv: v.iv / 100, k: 1 };
    const cal = yearsToExpiry(l.expiry, now) * 365, tr = dteOf(l);
    const k = cal > 0 && tr > 0 ? cal / tr : 1;
    return { iv: (v.iv / 100) * Math.sqrt(k), k };
  };
  const cl = legs.filter(l => Number.isFinite(Number(l.strike)) && Number(l.qty)).map(l => ({ l, c: clockOf(l) })).map(({ l, c }) => ({
    strike: Number(l.strike), right: l.right === 'P' ? 'P' : 'C', sign: Number(l.qty) < 0 ? -1 : 1,
    qty: Math.abs(Number(l.qty)) * lots, dte: dteOf(l), iv: c.iv, r: RATE * c.k, q: divYield * c.k,
    label: `${Number(l.qty) < 0 ? 'Short' : 'Long'} ${l.strike}${l.right}` }));
  if (!cl.length) return null;
  const nearDte = Math.min(...cl.map(l => l.dte));
  const near = cl.filter(l => l.dte === nearDte);
  const sigmaNear = near.reduce((a, l) => a + l.iv, 0) / near.length;

  if (!intraday) {
    const closeYmd = plannedExit(p);
    closeDay = closeYmd ? Math.min(nearDte, Math.max(0, yearsToExpiry(closeYmd, now) * 365)) : nearDte;
  }
  let lo, hi;
  if (intraday) {
    const sd = spot * sigmaNear * Math.sqrt(Math.max(nearDte, 0.02) / 365);
    const ks = cl.map(l => l.strike).concat(spot);
    const pad = Math.max(2.5 * sd, (Math.max(...ks) - Math.min(...ks)) * 0.6, spot * 0.004);
    lo = Math.max(0.01, Math.min(...ks) - pad); hi = Math.max(...ks) + pad;
  } else {
    [lo, hi] = priceRange(cl, spot, sigmaNear * 100);
  }
  return { cl, net, lo, hi, nearDte, closeDay, closeDte, closeEt, intraday, isTimeSpread, sigmaNear, divYield, lots };
}

/**
 * What to do with the position now. One headline and one primary action; every
 * condition that fired is in `alerts`, worst first.
 * @param x { engine, working, pnl, stopLoss, targetGain, where (whereIsPrice), minsToExit (0DTE),
 *            daysToClose, closeDte, closeYmd (45DTE), canRoll, markSource }
 * @returns { tone: green|amber|red|purple|grey, title, why, action: close|roll|null, alerts:[{tone,text}] }
 */
export function manageVerdict(x) {
  const alerts = [];
  const add = (tone, text, action = null, title = null) => alerts.push({ tone, text, action, title });
  const is0 = x.engine === '0DTE';
  const later = x.canRoll ? 'roll' : 'close';
  if (x.working) {
    return { tone: 'purple', title: 'Order working — not filled yet', why: 'Drawn as if filled. Manage the order in TWS or below.', action: null, alerts: [] };
  }
  if (x.pnl == null) {
    return { tone: 'grey', title: 'No mark yet', why: 'Waiting for prices on the legs.', action: null, alerts: [] };
  }
  const pnl = x.pnl;
  if (x.stopLoss != null && pnl <= x.stopLoss) {
    add('red', `P&L ${money(pnl)} is past the ${money(x.stopLoss)} stop. Stops are not sent to TWS — close it yourself.`, 'close', 'Stop reached — close it');
  }
  if (x.targetGain != null && pnl >= x.targetGain) {
    add('green', `P&L ${money(pnl)} has reached the ${money(x.targetGain)} target.`, 'close', 'Target reached — take the profit');
  }
  if (is0 && x.minsToExit != null) {
    if (x.minsToExit <= 0) add('red', 'The managed exit time has passed. Close whatever the P&L.', 'close', 'Time exit passed — close now');
    else if (x.minsToExit <= 30) add('amber', `${Math.round(x.minsToExit)} min to the managed exit.`, 'close', `Time exit in ${Math.round(x.minsToExit)} min`);
  }
  if (!is0 && x.daysToClose != null) {
    const rule = x.closeDte ? `the ${x.closeDte}-DTE close` : 'the planned close';
    const on = x.closeYmd ? ` on ${Number(x.closeYmd.slice(6, 8))} ${MON[Number(x.closeYmd.slice(4, 6)) - 1]}` : ` in ${x.daysToClose} days`;
    const how = x.canRoll ? 'Roll it out or close it' : 'Close it';
    if (x.daysToClose <= 0) add('red', `${x.daysToClose < 0 ? 'Past' : 'Today is'} ${rule}. ${how} — gamma grows from here.`, later, `Close day reached — ${later} it`);
    else if (x.daysToClose <= 5) add('amber', `${rule[0].toUpperCase() + rule.slice(1)} is${on} — ${how.toLowerCase()} before then.`, later, `Close day in ${x.daysToClose} day${x.daysToClose === 1 ? '' : 's'}`);
  }
  const nr = x.where && x.where.near;
  if (nr && !nr.body) {
    if (nr.away < 0) add('red', `Price is through the short ${nr.strike}${nr.right}.`, later, `Short ${nr.strike}${nr.right} breached`);
    else if (x.where.nearSd != null && x.where.nearSd < 0.5) add('amber', `Price is ${x.where.nearSd.toFixed(1)}σ from the short ${nr.strike}${nr.right}.`, null, 'Short strike being tested');
  } else if (nr && nr.body && x.where && !x.where.inside) {
    add('amber', `Price is outside the profit zone, ${Math.abs(nr.away).toFixed(nr.away >= 100 ? 0 : 1)} pts from the ${nr.strike} body.`, null, 'Outside the profit zone');
  }
  if (x.markSource === 'model') add('grey', 'No live quotes on every leg — valued with a model.', null, null);

  const rank = { red: 0, green: 1, amber: 2, grey: 3 };
  alerts.sort((a, b) => rank[a.tone] - rank[b.tone]);
  const head = alerts.find(a => a.title);
  if (head) return { tone: head.tone, title: head.title, why: head.text, action: head.action, alerts };
  const why = [
    x.targetGain != null ? `${money(x.targetGain - pnl).replace('+', '')} to the target` : null,
    x.stopLoss != null ? `${money(pnl - x.stopLoss).replace('+', '')} of room to the stop` : null,
  ].filter(Boolean).join(' · ');
  return { tone: 'green', title: 'On plan — hold', why: why || 'Nothing has fired.', action: null, alerts };
}

/** Working orders on this underlying from the live book, this ticket's first. */
export function positionOrders(orders, p) {
  if (!Array.isArray(orders) || !p) return [];
  const sym = String(p.underlying || '').toUpperCase();
  const ref = p.ticketRef != null ? String(p.ticketRef) : '';
  return orders
    .filter(o => o && String(o.symbol || '').toUpperCase() === sym && !DONE.test(o.status || '') && !o.whatIf)
    .map(o => ({ ...o, mine: !!(ref && o.ref && String(o.ref).includes(ref)) }))
    .sort((a, b) => (b.mine - a.mine) || (a.orderId - b.orderId));
}

/**
 * The position's history as steps: each ticket it was rolled from (strikes, what it
 * banked), then the open ticket now. Null when it was never rolled.
 */
export function tradeStory(p, pnlNow) {
  if (!p || !p.chain || !Array.isArray(p.chain.links) || !p.chain.links.length) return null;
  const steps = p.chain.links.map((l, i) => ({
    kind: i === 0 ? 'opened' : 'rolled', strikes: l.strikes, from: l.entryYmd || null, to: l.closeYmd || null,
    realised: Number.isFinite(l.realised) ? l.realised : null,
  }));
  // Same form as the earlier tickets' strikes (the ticket's Wing Strikes line).
  const strikes = (p.row && p.row.legs) || (Array.isArray(p.legs) ? p.legs.map(l => `${l.strike}${l.right}`).join('/') : '');
  steps.push({ kind: 'now', strikes, from: p.entry && p.entry.ymd || null, to: null, open: pnlNow });
  for (const st of steps) st.strikes = String(st.strikes || '').replace(/\s*\/\s*/g, '/');
  const banked = Number(p.chain.banked) || 0;
  return { steps, banked, total: pnlNow != null ? pnlNow + banked : null, rolls: p.chain.rolls ?? p.chain.links.length };
}
