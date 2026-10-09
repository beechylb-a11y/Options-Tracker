// ── Risk now: the whole book in one place (Oct 2026) ──
//
// The Portfolio Risk page used to read the old TastyTrade tracker and greeks typed
// in by hand, so it showed nothing for trades logged from the engines. This builds
// the book from the tickets the app itself keeps (open + working), finds each
// ticket's real legs (TWS first, then the "Legs:" line logged with the ticket),
// and answers four questions:
//   1. what is on, and does TWS agree?
//   2. what does the book do if the market moves — greeks, SPX-weighted
//   3. what happens in a bad day — a stress grid of SPX move × IV change
//   4. what needs doing now — stops, targets, time exits, expired tickets
//
// Pure functions: the page fetches, this computes. Every figure is $ for the
// contracts actually open; a working order is risk committed, not a position.

import { bsPrice, RATE, divYieldOf } from './payoffCurve.js';
import { exposure, STATUS } from './fills.js';
import { eventsInWindow } from './events.js';
import { exitRuleFor, STOP_LOSS_PCT } from './data.js';
import { matchTicketLegs, legsFromNotes, strategyName } from '../utils/positionMatch.js';
import { normalisePosition, stopToPrice, targetToPrice, pnlAt, withEntryFill } from '../utils/ticketMath.js';

const num = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const symOf = u => { const s = String(u || '').toUpperCase(); return s === 'SPXW' ? 'SPX' : s; };

// ── Beta to SPX ───────────────────────────────────────────────────────────
// Fixed, rounded long-run betas: enough to put a QQQ condor and an SPX fly on one
// scale. Not re-estimated live; an unknown single stock is treated as 1.2.
export const BETA = {
  SPX: 1, SPY: 1, XSP: 1, ES: 1, MES: 1,
  QQQ: 1.2, NDX: 1.2, XND: 1.2, IWM: 1.2, RUT: 1.2, DIA: 0.9,
  TSLA: 2.0, NVDA: 1.8, AMD: 1.8, AAPL: 1.1, MSFT: 1.1, GOOGL: 1.1, GOOG: 1.1,
  AMZN: 1.3, META: 1.3, NFLX: 1.3, AVGO: 1.5, PLTR: 2.0, MSTR: 2.5, COIN: 2.5,
};
export const DEFAULT_BETA = 1.2;
export const betaOf = u => BETA[symOf(u)] ?? DEFAULT_BETA;

// ── Time ──────────────────────────────────────────────────────────────────
const ETF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
/** Wall clock in New York: { ymd, min } (minutes after midnight). */
export function etWall(now = new Date()) {
  const p = Object.fromEntries(ETF.formatToParts(now).map(x => [x.type, x.value]));
  return { ymd: p.year + p.month + p.day, min: (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute };
}
const ymdUTC = ymd => Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
export const daysBetween = (a, b) => Math.round((ymdUTC(b) - ymdUTC(a)) / 86400000);
export const isoOfYmd = y => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
export function addDaysYmd(ymd, n) {
  const d = new Date(ymdUTC(ymd) + n * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** Calendar years from now to 16:00 New York on the expiry date (0 once past). */
export function yearsToExpiry(expiryYmd, now = new Date()) {
  const w = etWall(now);
  const mins = daysBetween(w.ymd, String(expiryYmd)) * 1440 + (16 * 60 - w.min);
  return Math.max(0, mins) / (365 * 1440);
}

// ── 1. The book ───────────────────────────────────────────────────────────
/**
 * One entry per open or working ticket, with its legs.
 * @param open       /api/positions/open rows
 * @param decisions  /api/decisions rows (for Notes, Price, IV, VIX1D)
 * @param raw        TWS option legs from the bridge, or null when it is not reachable
 * @param todayYmd   the session date, YYYYMMDD
 */
export function buildBook({ open, decisions, raw, todayYmd }) {
  const byTs = new Map(), byRow = new Map();
  (decisions || []).forEach(d => { if (d.Timestamp) byTs.set(String(d.Timestamp), d); if (d._rowIndex) byRow.set(Number(d._rowIndex), d); });
  return (open || []).map(r0 => {
    const row = withEntryFill(r0);
    const d = byTs.get(String(row.timestamp || '')) || byRow.get(Number(row.ticketRef)) || {};
    const pos = normalisePosition(row);
    const engine = /45/.test(String(row.engine || d.Engine || '')) ? '45DTE' : '0DTE';
    const qty = num(row.qty) || 0;
    const qtyOpen = num(row.qtyOpen) != null ? num(row.qtyOpen) : qty;
    const filled = num(row.qtyFilled);
    const f = filled == null ? qtyOpen : filled;           // legacy tickets: open = filled
    const live = Math.max(0, Math.min(qtyOpen, f));
    const resting = Math.max(0, qty - f);
    const strategy = strategyName(row.strategy || d.Strategy || '') || String(row.strategy || '');
    const underlying = symOf(row.underlying || d.Underlying);

    let legs = null, legSource = null, note = '';
    if (raw && live > 0) {
      const m = matchTicketLegs({ underlying, strikes: row.legs || d['Wing Strikes'], strategy, qtyOpen: live, todayYmd }, raw);
      if (m.legs) { legs = m.legs; legSource = 'TWS'; note = m.note || ''; }
      else note = m.note || '';
    }
    if (!legs) {
      const fromNotes = legsFromNotes(d.Notes);
      if (fromNotes) { legs = fromNotes; legSource = 'ticket'; }
    }
    const entryYmd = String(row.entryDate || '').replace(/-/g, '').slice(0, 8);
    const expiry = legs ? legs.map(l => String(l.expiry)).sort()[0] : (engine === '0DTE' && entryYmd.length === 8 ? entryYmd : null);
    return {
      key: String(row.ticketRef || row.timestamp),
      row, ticketRef: row.ticketRef, timestamp: row.timestamp || '',
      engine, underlying, strategy, status: row.status,
      qty, qtyOpen, live, resting,
      working: live === 0 && resting > 0,
      legs, legSource, note,
      expiry, dte: expiry ? daysBetween(todayYmd, expiry) : null,
      pos,                                                  // normalised: ncd, isCredit, basis, maxRisk/ct
      entry: { ncd: pos.ncd || 0, spot: num(d.Price), iv: num(d.IV), vix1d: num(d.VIX1D), em: num(d.EM), ymd: entryYmd },
      maxRisk: num(row.maxRisk),
    };
  });
}

// ── 1b. Does TWS agree? ───────────────────────────────────────────────────
/**
 * extra:   legs TWS holds that no open ticket accounts for (or holds in a different
 *          size from what the tickets say)
 * missing: open tickets whose legs TWS does not show — expired but not closed in
 *          the log, closed in TWS only, or logged on another account
 */
export function reconcile(book, raw, todayYmd) {
  if (!raw) return null;
  const k = (u, e, s, r) => `${symOf(u)}|${String(e).slice(0, 8)}|${+s}|${r}`;
  const tws = new Map(), logged = new Map();
  for (const l of raw) {
    if (!l.qty || String(l.expiry).slice(0, 8) < todayYmd) continue;
    const key = k(l.underlying, l.expiry, l.strike, l.right);
    tws.set(key, (tws.get(key) || 0) + Number(l.qty));
  }
  for (const p of book) {
    if (p.legSource !== 'TWS' || !(p.live > 0)) continue;
    for (const l of p.legs) {
      const key = k(p.underlying, l.expiry, l.strike, l.right);
      logged.set(key, (logged.get(key) || 0) + l.qty * p.live);
    }
  }
  const extra = [];
  for (const key of new Set([...tws.keys(), ...logged.keys()])) {
    const t = tws.get(key) || 0, g = logged.get(key) || 0;
    if (Math.abs(t - g) < 0.5) continue;
    const [underlying, expiry, strike, right] = key.split('|');
    extra.push({ underlying, expiry, strike: +strike, right, tws: t, logged: g });
  }
  extra.sort((a, b) => a.underlying.localeCompare(b.underlying) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  const missing = book.filter(p => p.live > 0 && p.legSource !== 'TWS').map(p => ({
    key: p.key, p,
    why: p.expiry && p.expiry < todayYmd ? `Expired ${isoOfYmd(p.expiry)} — the log still has it open`
      : p.note || 'TWS shows no position at these strikes',
  }));
  return { extra, missing };
}

// ── 2. Values and greeks ──────────────────────────────────────────────────
/** IV (percent) a leg is valued at: its live quote, else the ticket's, else VIX1D, else 20. */
export function ivFor(p, leg) {
  if (leg && leg.iv > 0) return { iv: leg.iv, live: true };
  if (p.entry.iv > 0) return { iv: p.entry.iv, live: false };
  if (p.entry.vix1d > 0) return { iv: p.entry.vix1d, live: false };
  return { iv: 20, live: false };
}

/** Signed per-share value of what you hold (+ long), Black-Scholes per leg. */
export function holdingValue(p, legs, S, { now = new Date(), ivShift = 0, days = 0 } = {}) {
  const q = divYieldOf(p.underlying);
  return legs.reduce((a, l) => {
    const T = Math.max(0, yearsToExpiry(l.expiry, now) - days / 365);
    const iv = Math.max(1, ivFor(p, l).iv + ivShift);
    return a + l.qty * bsPrice(S, l.strike, T, iv / 100, l.right, RATE, q);
  }, 0);
}

/** Model greeks for the open contracts, in the bridge's units ×100 per lot × lots. */
export function modelGreeks(p, legs, S, now = new Date()) {
  const lots = p.live * 100;
  const V = (s, o = {}) => holdingValue(p, legs, s, { now, ...o });
  const h = Math.max(0.01, S * 0.001), v0 = V(S);
  const up = V(S + h), dn = V(S - h);
  return {
    delta: (up - dn) / (2 * h) * lots,
    gamma: (up - 2 * v0 + dn) / (h * h) * lots,
    theta: (V(S, { days: 1 }) - v0) * lots,
    vega: (V(S, { ivShift: 1 }) - v0) * lots,
  };
}

/**
 * Live risk for one position.
 * @param quotes  /api/option-greeks reply for its legs, or null
 * @param spotHint a current price for the underlying when no quote came back
 */
export function positionRisk(p, quotes, { now = new Date(), spotHint = null } = {}) {
  if (!p.legs || !(p.live > 0)) return null;
  let legs = p.legs.map(l => ({ ...l }));
  let markPS = null, markSource = null, greeks = null, greeksSource = null;
  const ok = quotes && !quotes.error && Array.isArray(quotes.legs);
  if (ok) {
    let mark = 0, all = true;
    legs = legs.map((l, i) => {
      const g = quotes.legs[i] && quotes.legs[i].greeks;
      const mid = g && g.bid > 0 && g.ask > 0 ? (g.bid + g.ask) / 2 : g && g.optPrice != null ? g.optPrice : null;
      if (mid == null) all = false; else mark += l.qty * mid;
      return { ...l, iv: g && g.iv > 0 ? g.iv : null, delta: g ? g.delta : null };
    });
    if (all) { markPS = mark; markSource = 'quotes'; }
    if (quotes.net && Number.isFinite(quotes.net.delta)) {
      const n = quotes.net;
      greeks = { delta: n.delta * p.live, gamma: (n.gamma || 0) * p.live, theta: (n.theta || 0) * p.live, vega: (n.vega || 0) * p.live };
      greeksSource = 'quotes';
    }
  }
  const spot = (ok && num(quotes.undPrice) > 0 ? num(quotes.undPrice) : null) || (spotHint > 0 ? spotHint : null) || p.entry.spot;
  if (!(spot > 0)) return { p, legs, spot: null, markPS, markSource, greeks, greeksSource, pnl: null };
  if (markPS == null) { markPS = holdingValue(p, legs, spot, { now }); markSource = 'model'; }
  if (!greeks) { greeks = modelGreeks(p, legs, spot, now); greeksSource = 'model'; }
  const closePx = p.pos.isCredit ? -markPS : markPS;
  const pnl = Number.isFinite(p.pos.ncd) && p.pos.ncd !== 0 ? pnlAt(p.pos, Math.max(0, closePx), p.live) : null;
  const beta = betaOf(p.underlying);
  return {
    p, legs, spot, spotSource: ok && num(quotes.undPrice) > 0 ? 'live' : spotHint > 0 ? 'live' : 'entry',
    markPS, closePx, markSource, greeks, greeksSource, pnl, beta,
    // $ the position makes for a 1% SPX move (the underlying moving beta × 1%)
    spxDelta1: greeks.delta * spot * 0.01 * beta,
    // $ from convexity alone in a 1% move of its own underlying (− when short gamma)
    gamma1: 0.5 * greeks.gamma * (spot * 0.01) * (spot * 0.01),
  };
}

export function totals(risks) {
  const t = { spxDelta1: 0, theta: 0, vega: 0, gamma1: 0, pnl: 0, n: 0, modelled: 0 };
  for (const r of risks) {
    if (!r || !r.greeks) continue;
    t.n++;
    if (r.greeksSource === 'model') t.modelled++;
    t.spxDelta1 += r.spxDelta1 || 0;
    t.theta += r.greeks.theta || 0;
    t.vega += r.greeks.vega || 0;
    t.gamma1 += r.gamma1 || 0;
    if (Number.isFinite(r.pnl)) t.pnl += r.pnl;
  }
  return t;
}

// ── 3. Stress grid ────────────────────────────────────────────────────────
export const STRESS_MOVES = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3];
export const STRESS_IV = [-5, 0, 5];

/**
 * P&L of the open book for each SPX move (%) × IV change (vol points), every
 * underlying moving beta × the SPX move. Valued against the model's own value now,
 * so model error cancels and only the shock shows.
 * @param horizonDays 0 = an instant shock; 1 = by tomorrow (theta included; a 0DTE
 *                    is at expiry)
 */
export function stressGrid(risks, { moves = STRESS_MOVES, ivShifts = STRESS_IV, horizonDays = 0, now = new Date() } = {}) {
  const use = (risks || []).filter(r => r && r.spot > 0 && r.legs && r.legs.length);
  const base = use.map(r => holdingValue(r.p, r.legs, r.spot, { now }));
  const cells = moves.map(m => ivShifts.map(iv => {
    const by = use.map((r, i) => {
      const S = r.spot * (1 + r.beta * m / 100);
      const v = holdingValue(r.p, r.legs, S, { now, ivShift: iv, days: horizonDays });
      return { key: r.p.key, pnl: (v - base[i]) * 100 * r.p.live };
    });
    return { move: m, iv, pnl: by.reduce((a, x) => a + x.pnl, 0), by };
  }));
  let worst = null;
  cells.forEach(row => row.forEach(c => { if (!worst || c.pnl < worst.pnl) worst = c; }));
  const top = worst ? [...worst.by].sort((a, b) => a.pnl - b.pnl)[0] : null;
  return { moves, ivShifts, horizonDays, cells, worst, top: top && top.pnl < 0 ? top : null, n: use.length };
}

/** One SPX daily standard deviation, in %, from VIX. */
export const spxDailySd = vix => (vix > 0 ? vix / Math.sqrt(252) : null);

// ── 4. Risk budget ────────────────────────────────────────────────────────
export function bucketOf(p, todayYmd) {
  if (p.dte == null) return 'Unknown expiry';
  if (p.expiry <= todayYmd) return 'Today';
  if (p.dte <= 7) return 'Next 7 days';
  return 'Later';
}
const BUCKETS = ['Today', 'Next 7 days', 'Later', 'Unknown expiry'];

export function riskBudget(book, { cap = null, todayYmd } = {}) {
  const exp = exposure(book.map(p => p.row), { maxOpenRisk: cap });
  const add = (map, k, p) => {
    const perCt = p.qty > 0 && p.maxRisk > 0 ? p.maxRisk / p.qty : 0;
    const g = map.get(k) || { key: k, live: 0, working: 0, n: 0 };
    g.live += perCt * p.live; g.working += perCt * p.resting; g.n++;
    map.set(k, g);
  };
  const byB = new Map(), byU = new Map();
  for (const p of book) { add(byB, bucketOf(p, todayYmd), p); add(byU, p.underlying, p); }
  const buckets = BUCKETS.filter(b => byB.has(b)).map(b => byB.get(b));
  const underlyings = [...byU.values()].sort((a, b) => (b.live + b.working) - (a.live + a.working));
  const total = underlyings.reduce((a, g) => a + g.live + g.working, 0);
  const top = underlyings[0];
  return { exp, buckets, underlyings, concentration: top && total > 0 ? { key: top.key, share: (top.live + top.working) / total } : null };
}

/** The day a position is planned to be gone: 45DTE at its close-by DTE, else expiry. */
export function plannedExit(p) {
  if (!p.expiry) return null;
  if (p.engine !== '45DTE') return p.expiry;
  const rule = exitRuleFor('45DTE', p.strategy);
  return addDaysYmd(p.expiry, -(rule.closeDte || 21));
}

/** Scheduled macro events before each position is planned to be closed. */
export function eventsAhead(book, todayYmd, cal) {
  const map = new Map();
  for (const p of book) {
    let end = plannedExit(p);
    if (!end) continue;
    if (end < todayYmd) end = p.expiry;
    if (end < todayYmd) continue;
    for (const e of eventsInWindow(isoOfYmd(todayYmd), isoOfYmd(end), cal)) {
      const k = e.date + '|' + (e.kind || e.label);
      const g = map.get(k) || { ...e, positions: [] };
      g.positions.push(`${p.underlying} ${p.strategy}`);
      map.set(k, g);
    }
  }
  return [...map.values()].sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

// ── 5. What needs attention ───────────────────────────────────────────────
const RANK = { red: 0, amber: 1, green: 2, blue: 3, grey: 4 };
const $ = v => (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();

/** Stop for the open contracts: the plan saved at entry, else the 100% guide. */
export function stopFor(p, plan) {
  if (!(Math.abs(p.pos.ncd || 0) > 0) || !(p.live > 0)) return null;
  const pct = plan && plan.stopPct !== '' && plan.stopPct != null ? Math.abs(parseFloat(plan.stopPct)) : STOP_LOSS_PCT;
  if (!(pct > 0)) return null;
  const price = stopToPrice(p.pos, pct);
  return { pct, price, loss: pnlAt(p.pos, price, p.live), planned: !!(plan && plan.stopPct !== '' && plan.stopPct != null) };
}

/** Profit target for the open contracts, by the strategy's exit rule. */
export function targetFor(p) {
  if (!(Math.abs(p.pos.ncd || 0) > 0) || !(p.live > 0)) return null;
  const rule = exitRuleFor(p.engine, p.strategy);
  const price = targetToPrice(p.pos, rule.target);
  const gain = pnlAt(p.pos, price, p.live);
  return gain > 0 ? { pct: rule.target, basis: rule.basis, price, gain } : null;
}

/**
 * @param risks   positionRisk() by key
 * @param reviews reviewOpen45() by key (45DTE with legs and a mark)
 * @param planOf  ticket timestamp → saved exit plan
 */
export function attention(book, { risks = {}, reviews = {}, planOf = () => null, now = new Date(), todayYmd } = {}) {
  const out = [];
  const w = etWall(now);
  const push = (p, tone, title, detail, action) => out.push({ key: p.key + ':' + title, p, tone, title, detail, action });
  for (const p of book) {
    const r = risks[p.key];
    const name = `${p.underlying} ${p.strategy}`;
    if (p.working) {
      push(p, 'blue', 'Order not filled yet', `${name}: ${p.resting} contract${p.resting === 1 ? '' : 's'} resting. Record the fills or cancel it.`, 'fills');
      continue;
    }
    if (!(p.live > 0)) continue;
    if (p.expiry && p.expiry < todayYmd) {
      push(p, 'red', 'Expired, still open in the log', `${name} expired ${isoOfYmd(p.expiry)}. Record the close so P&L and risk are right.`, 'sell');
      continue;
    }
    if (p.engine === '0DTE' && p.expiry === w.ymd && w.min < 16 * 60) {
      if (w.min >= 15 * 60) push(p, 'red', 'Past 15:00 — close the 0DTE', `${name}: the plan closes 0DTE by 15:00 New York. Gamma is at its worst into the bell.`, 'sell');
      else if (w.min >= 14 * 60 + 30) push(p, 'amber', `Close by 15:00 (${15 * 60 - w.min} min)`, `${name}: time exit coming up.`, 'sell');
    }
    // A 45DTE with live quotes has the full check-up (stop, target, time stop,
    // tested strikes, rolls): use its call and nothing else, so one trade does not
    // raise three overlapping lines.
    const rv = p.engine === '45DTE' ? reviews[p.key] : null;
    if (rv && rv.action && rv.action !== 'unknown') {
      if (rv.action !== 'hold') push(p, rv.tone === 'red' ? 'red' : rv.tone === 'green' ? 'green' : 'amber', rv.headline,
        name + (rv.steps && rv.steps[0] ? ': ' + rv.steps[0] : ''), /^roll/.test(rv.action) ? 'roll' : 'sell');
      continue;
    }
    const stop = stopFor(p, planOf(p.timestamp));
    const tgt = targetFor(p);
    const pnl = r && Number.isFinite(r.pnl) ? r.pnl : null;
    const marked = r && r.markSource === 'quotes' ? '' : ' (model mark)';
    if (pnl != null && stop && stop.loss < 0) {
      const used = pnl / stop.loss;
      if (used >= 1) push(p, 'red', 'Stop reached', `${name}: ${$(pnl)} against a stop of ${$(stop.loss)} (${stop.pct}% of entry${stop.planned ? ', your plan' : ''})${marked}.`, 'sell');
      else if (used >= 0.6) push(p, 'amber', `${Math.round(used * 100)}% of the way to the stop`, `${name}: ${$(pnl)}; the stop is ${$(stop.loss)}${marked}.`, 'sell');
    }
    if (pnl != null && tgt && pnl >= tgt.gain) {
      push(p, 'green', 'Target reached — take profit', `${name}: ${$(pnl)} against a target of ${$(tgt.gain)} (${tgt.pct}% of ${tgt.basis === 'entry' ? 'entry' : 'max profit'})${marked}.`, 'sell');
    }
    if (p.engine === '45DTE' && p.dte != null) {
      const rule = exitRuleFor('45DTE', p.strategy);
      const left = p.dte - (rule.closeDte || 21);
      if (left <= 0) push(p, 'red', `At the ${rule.closeDte || 21}-DTE close`, `${name}: ${p.dte} DTE. The plan closes here whatever the P&L — gamma grows from now.`, 'sell');
      else if (left <= 5) push(p, 'amber', `${rule.closeDte || 21}-DTE close in ${left} day${left === 1 ? '' : 's'}`, `${name}: close by ${isoOfYmd(plannedExit(p))}.`, 'sell');
    }
  }
  // One line per position and title; most urgent first.
  return out.sort((a, b) => RANK[a.tone] - RANK[b.tone]);
}

export { STATUS };
