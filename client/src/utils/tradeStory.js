// Closed engine trades as a story (Nov 2026): the data behind the Trades "Story"
// view, the Journal "Year" view and the Analytics "Edge" view. One source — the
// trade log (one row per ticket, every tranche summed) — so all three pages show
// the same trades, the same P&L and the same R. Pure functions; the pages draw.

import { isAggExcluded } from './stats.js';
import { wilson, meanCI, MIN_N, SOLID_N } from '../engine/calibration.js';

const num = v => { const x = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : null; };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "SPX - Bull put spread - 5 contracts" (a ticket's Strategy) → "Bull put spread". */
export function bareStrategy(s) {
  const p = String(s || '').split(' - ').map(x => x.trim());
  if (p.length >= 3 && /^\d+ contracts?$/i.test(p[p.length - 1])) return p.slice(1, -1).join(' - ');
  return String(s || '').trim();
}

/** "Bull Put Spread" and "Bull put spread" are one strategy: sentence case, one space. */
export function normStrategy(s) {
  const t = bareStrategy(s).replace(/\s+/g, ' ');
  if (!t) return 'Unknown';
  const lower = t.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/** Short family name for charts: "Iron Condor - Normal" → "Iron condor", "Asymmetric butterfly" → "Asym fly". */
export function strategyFamily(s) {
  const t = normStrategy(s).toLowerCase();
  if (/broken.?wing|bwb/.test(t)) return 'BWB';
  if (/asym/.test(t)) return 'Asym fly';
  if (/chicken/.test(t)) return 'Chicken condor';
  if (/reverse|rev\.? condor/.test(t)) return 'Rev condor';
  if (/iron fly|iron butterfly/.test(t)) return 'Iron fly';
  if (/iron condor/.test(t)) return 'Iron condor';
  if (/butterfly|\bfly\b/.test(t)) return 'Std fly';
  if (/bull put|put credit/.test(t)) return 'Bull put';
  if (/bear call|call credit/.test(t)) return 'Bear call';
  if (/bull call|call debit/.test(t)) return 'Bull call';
  if (/bear put|put debit/.test(t)) return 'Bear put';
  if (/strangle/.test(t)) return 'Strangle';
  if (/straddle/.test(t)) return 'Straddle';
  return normStrategy(s).split(' - ')[0];
}

/** "18/100 Weak" → 18; 54 → 54; '' → null. */
export const confOf = v => { const m = /(\d+(?:\.\d+)?)/.exec(String(v ?? '')); return m ? Number(m[1]) : null; };

/**
 * Trade-log rows → closed trades, oldest close first.
 * @returns [{ ref, engine, und, strategy, family, qty, entryDate, entryTime, closeDate,
 *             pnl, risk, r, conf, legs, account, entryPrice }]
 */
export function storyTrades(rows, account = 'all', accounts = []) {
  const all = !account || account === 'all';
  const out = [];
  for (const t of rows || []) {
    if (String(t.Status || '').toLowerCase() !== 'closed') continue;
    const acct = t.Account || '';
    if (all ? isAggExcluded(acct, accounts) : (acct && acct !== account)) continue;
    const pnl = num(t['Realised P&L']);
    if (pnl == null) continue;
    const risk = num(t['Max Risk']);
    let r = num(t['R Multiple']);
    if (r == null && risk > 0) r = Math.round(pnl / risk * 100) / 100;
    const entryDate = String(t['Entry Date'] || '').slice(0, 10);
    out.push({
      ref: String(t['Ticket Ref'] ?? ''),
      engine: t.Engine || '',
      und: t.Underlying || '',
      strategy: normStrategy(t.Strategy),
      family: strategyFamily(t.Strategy),
      qty: num(t.Qty) || 1,
      entryDate,
      entryTime: String(t['Entry Time'] || '').slice(0, 5),
      closeDate: String(t['Last Close'] || entryDate).slice(0, 10),
      pnl,
      risk: risk > 0 ? risk : null,
      r,
      conf: confOf(t.Confidence),
      legs: t.Legs || '',
      account: acct,
      entryPrice: num(t['Avg Entry']) ?? num(t['Entry Price']),
    });
  }
  return out.sort((a, b) => (a.closeDate < b.closeDate ? -1 : a.closeDate > b.closeDate ? 1 : Number(a.ref) - Number(b.ref)));
}

/** Running total after each trade: [{ i, cum, trade }]. */
export function equitySeries(trades) {
  let cum = 0;
  return (trades || []).map((t, i) => { cum += t.pnl; return { i, cum: Math.round(cum * 100) / 100, trade: t }; });
}

/** Deepest fall from a running high: { dd ($, ≤ 0), from, to } over the equity series. */
export function maxDrawdown(series) {
  let peak = 0, peakI = -1, best = { dd: 0, from: null, to: null };
  for (const p of series || []) {
    if (p.cum > peak) { peak = p.cum; peakI = p.i; }
    const dd = p.cum - peak;
    if (dd < best.dd) best = { dd: Math.round(dd * 100) / 100, from: peakI, to: p.i };
  }
  return best;
}

/**
 * Confidence bands → { label, n, win (0–1), avgR, winCI, rCI, read }. Only trades with
 * both a score and an R. winCI is the Wilson 95% range of the win rate, rCI the 95%
 * range of average R (null bounds under 2 trades). read: 'few' under MIN_N trades,
 * 'early' under SOLID_N, else 'solid' — the same bars as Analytics › Calibration.
 */
export const CONF_BANDS = [[0, 25, '0–24'], [25, 40, '25–39'], [40, 50, '40–49'], [50, 101, '50+']];
export function calibration(trades, bands = CONF_BANDS) {
  return bands.map(([lo, hi, label]) => {
    const s = (trades || []).filter(t => t.conf != null && t.r != null && t.conf >= lo && t.conf < hi);
    const w = s.filter(t => t.r > 0).length;
    const n = s.length;
    return {
      label, lo, hi, n, win: n ? w / n : 0, avgR: n ? s.reduce((a, t) => a + t.r, 0) / n : 0,
      winCI: wilson(w, n), rCI: meanCI(s.map(t => t.r)),
      read: n < MIN_N ? 'few' : n < SOLID_N ? 'early' : 'solid',
    };
  });
}

/**
 * What the bands say, in words. A band is read only from MIN_N trades. "Re-weight the
 * score" is said only when the best and worst readable bands' R ranges don't overlap
 * and every readable band has SOLID_N trades; short of that the score is context.
 * → { kind: 'few'|'overlap'|'climbs'|'early'|'reweight', text }
 */
export function calibrationRead(b) {
  const had = (b || []).filter(x => x.n);
  const scored = had.reduce((a, x) => a + x.n, 0);
  const ok = had.filter(x => x.n >= MIN_N && x.rCI && x.rCI.lo != null);
  const left = had.length - ok.length;
  const leftTxt = left ? ` (${left} band${left > 1 ? 's' : ''} under ${MIN_N} trades not counted)` : '';
  if (ok.length < 2) {
    return { kind: 'few', text: `Too few trades to judge the score: ${ok.length} of ${had.length} bands ${ok.length === 1 ? 'has' : 'have'} ${MIN_N} or more (${scored} scored trades). Read it as context, not a grade, and keep logging.` };
  }
  const climbs = ok.every((x, i, a) => i === 0 || x.avgR >= a[i - 1].avgR - 0.02);
  const byR = [...ok].sort((p, q) => q.avgR - p.avgR);
  const best = byR[0], worst = byR[byR.length - 1];
  const apart = best.rCI.lo > worst.rCI.hi;
  const early = ok.some(x => x.n < SOLID_N);
  if (!apart) {
    return climbs
      ? { kind: 'overlap', text: `Average R climbs with the score, but the 95% ranges overlap${leftTxt}, so it isn't shown yet. Keep logging.` }
      : { kind: 'overlap', text: `No band is clearly better: the 95% ranges of average R overlap${leftTxt}. Read the score as context, not a grade, and keep logging before re-weighting it.` };
  }
  if (climbs) {
    return { kind: 'climbs', text: `Average R climbs with the score and the ${best.label} band is clear of the ${worst.label} band: the engine is ranking trades the right way.${early ? ` Early: some bands have under ${SOLID_N} trades.` : ''}` };
  }
  if (early) {
    return { kind: 'early', text: `The ${best.label} band is clear of the ${worst.label} band, but it's early (bands under ${SOLID_N} trades). Keep logging before re-weighting the score.` };
  }
  return { kind: 'reweight', text: `They don't climb: the ${best.label} band is clear of the ${worst.label} band on ${SOLID_N}+ trades each. Re-weight the score on its own results.` };
}

/**
 * Per structure: what a typical trade wins and loses, spread over every trade, and the
 * expectancy (avg P&L per trade). Sorted by total P&L. minN drops one-off structures.
 */
export function structureEdge(trades, minN = 2, key = 'family') {
  const g = new Map();
  for (const t of trades || []) {
    const k = t[key] || 'Unknown';
    const x = g.get(k) || { name: k, n: 0, wins: 0, losses: 0, winSum: 0, lossSum: 0, total: 0 };
    x.n++; x.total += t.pnl;
    if (t.pnl > 0) { x.wins++; x.winSum += t.pnl; } else if (t.pnl < 0) { x.losses++; x.lossSum += t.pnl; }
    g.set(k, x);
  }
  return [...g.values()].filter(x => x.n >= minN).map(x => ({
    ...x,
    total: Math.round(x.total * 100) / 100,
    expectancy: x.total / x.n,
    winPart: x.winSum / x.n,          // ≥ 0 — the right-hand bar
    lossPart: x.lossSum / x.n,        // ≤ 0 — the left-hand bar
    avgWin: x.wins ? x.winSum / x.wins : 0,
    avgLoss: x.losses ? x.lossSum / x.losses : 0,
  })).sort((a, b) => b.total - a.total);
}

/** R histogram: edges [-1, -0.75, …] → [{ lo, hi, n }]. Values below the first edge land in it, above the last in the last bin. */
export const R_EDGES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, Infinity];
export function rHistogram(trades, edges = R_EDGES) {
  const bins = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0 }));
  for (const t of trades || []) {
    if (t.r == null) continue;
    let i = bins.findIndex(b => t.r >= b.lo && t.r < b.hi);
    if (i < 0) i = t.r < edges[0] ? 0 : bins.length - 1;
    bins[i].n++;
  }
  return bins;
}

/** Structure × underlying: { rows, cols, cell(row, col) → { total, n } | null }. Rows/cols by trade count. */
export function structureGrid(trades, { maxRows = 6, maxCols = 6 } = {}) {
  const count = (k) => { const m = new Map(); for (const t of trades || []) m.set(t[k], (m.get(t[k]) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]); };
  const rows = count('family').slice(0, maxRows), cols = count('und').slice(0, maxCols);
  const cells = new Map();
  for (const t of trades || []) {
    const k = t.family + '|' + t.und;
    const c = cells.get(k) || { total: 0, n: 0 };
    c.total += t.pnl; c.n++;
    cells.set(k, c);
  }
  return { rows, cols, cell: (r, c) => { const x = cells.get(r + '|' + c); return x ? { total: Math.round(x.total * 100) / 100, n: x.n } : null; } };
}

/** P&L by close date: { 'yyyy-mm-dd': $ }. */
export function dailyPnl(trades) {
  const m = {};
  for (const t of trades || []) m[t.closeDate] = Math.round(((m[t.closeDate] || 0) + t.pnl) * 100) / 100;
  return m;
}

const fmtDay = iso => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

/** Best day, worst day, green days, longest run of green trading days (days with no close are skipped). */
export function dayStats(byDay) {
  const keys = Object.keys(byDay || {}).sort();
  if (!keys.length) return { best: null, worst: null, green: 0, days: 0, streak: { n: 0, from: null } };
  let best = keys[0], worst = keys[0], green = 0, cur = 0, curFrom = null, streak = { n: 0, from: null };
  for (const k of keys) {
    const v = byDay[k];
    if (v > byDay[best]) best = k;
    if (v < byDay[worst]) worst = k;
    if (v > 0) { green++; if (!cur) curFrom = k; cur++; if (cur > streak.n) streak = { n: cur, from: curFrom }; } else cur = 0;
  }
  return {
    best: { date: best, label: fmtDay(best), pnl: byDay[best] },
    worst: { date: worst, label: fmtDay(worst), pnl: byDay[worst] },
    green, days: keys.length,
    streak: { ...streak, label: streak.from ? fmtDay(streak.from) : '' },
  };
}

/**
 * Weekday cells from `fromISO` to `toISO` for the heatmap: [{ date, col, row, pnl }] —
 * col is the week (Mon starts a new one), row 0–4 Mon–Fri. Month labels at the first
 * column of each month.
 */
export function heatCells(byDay, fromISO, toISO) {
  const cells = [], months = [];
  const d = new Date(fromISO + 'T12:00:00Z'), end = new Date(toISO + 'T12:00:00Z');
  let col = 0, lastMonth = -1;
  while (d <= end) {
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) {
      if (dow === 1 && cells.length) col++;
      const date = d.toISOString().slice(0, 10);
      const m = d.getUTCMonth();
      if (m !== lastMonth) { months.push({ col, label: MON[m] }); lastMonth = m; }
      cells.push({ date, col, row: dow - 1, pnl: byDay[date] ?? null });
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return { cells, months, cols: col + 1 };
}

/**
 * The month so far against its target: cumulative P&L by calendar day, the straight
 * target line, and where today's pace lands at month end.
 */
export function monthPace(byDay, monthISO, target, todayISO) {
  const [y, m] = monthISO.split('-').map(Number);
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayISO && todayISO.slice(0, 7) === monthISO ? Number(todayISO.slice(8, 10)) : daysIn;
  let cum = 0;
  const points = [];
  for (let day = 1; day <= today; day++) {
    const k = `${monthISO}-${String(day).padStart(2, '0')}`;
    cum += byDay[k] || 0;
    points.push({ day, cum: Math.round(cum * 100) / 100 });
  }
  const projected = today > 0 ? cum * daysIn / today : 0;
  return { daysIn, today, total: Math.round(cum * 100) / 100, target: target || 0, gap: Math.round(((target || 0) - cum) * 100) / 100, projected: Math.round(projected), points };
}

/** Monday of the week holding iso (yyyy-mm-dd). */
export function mondayOf(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  const dow = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - (dow - 1));
  return d.toISOString().slice(0, 10);
}

/**
 * Week cards, newest first: { monday, label, total, trades, early: { kept, of } } where
 * `early` counts 0DTE entries made before cutoff (New York, "HH:MM") — the stated
 * "enter by 12:00" rule. Weeks are by close date.
 */
export function weekCards(trades, { cutoff = '12:00', limit = 4 } = {}) {
  const g = new Map();
  for (const t of trades || []) {
    const k = mondayOf(t.closeDate);
    const w = g.get(k) || { monday: k, total: 0, trades: [], early: { kept: 0, of: 0 }, late: [] };
    w.total += t.pnl; w.trades.push(t);
    if (/0dte/i.test(t.engine) && t.entryTime) {
      w.early.of++;
      if (t.entryTime < cutoff) w.early.kept++; else w.late.push(t);
    }
    g.set(k, w);
  }
  return [...g.values()].sort((a, b) => (a.monday < b.monday ? 1 : -1)).slice(0, limit).map(w => {
    const fri = new Date(w.monday + 'T12:00:00Z'); fri.setUTCDate(fri.getUTCDate() + 4);
    const friISO = fri.toISOString().slice(0, 10);
    const sameMonth = friISO.slice(5, 7) === w.monday.slice(5, 7);
    return {
      ...w,
      total: Math.round(w.total * 100) / 100,
      trades: [...w.trades].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)),
      label: sameMonth ? `${Number(w.monday.slice(8))}–${fmtDay(friISO)}` : `${fmtDay(w.monday)} – ${fmtDay(friISO)}`,
    };
  });
}

export { fmtDay };

/**
 * Engine closes are written to the tracker as "TICKET-<n>" rows with no credit and no
 * expiry, so the Trades table read $0 credit and blank ROC/DTE for every engine trade.
 * Fill both from the ticket's trade-log row: credit = entry price (money in +) × 100 ×
 * the row's own contracts; a 0DTE ticket expires the day it was entered. Rows that
 * already carry a value are left alone. Returns new objects; the input is not touched.
 */
export function fillTicketRows(tracker, tradeLog) {
  const byRef = new Map((tradeLog || []).map(t => [String(t['Ticket Ref'] ?? ''), t]));
  return (tracker || []).map(row => {
    const m = /^TICKET-(\d+)$/.exec(String(row['Order #'] || '').trim());
    const log = m && byRef.get(m[1]);
    if (!log) return row;
    const out = { ...row };
    const credit = num(row['Net Credit ($)']);
    const px = num(log['Avg Entry']) ?? num(log['Entry Price']);
    const qty = num(row.Qty) || num(log.Qty) || 1;
    if ((credit == null || credit === 0) && px != null) out['Net Credit ($)'] = String(Math.round(px * 100 * qty * 100) / 100);
    if (!row['Expiry Date'] && /0dte/i.test(log.Engine || '') && log['Entry Date']) out['Expiry Date'] = String(log['Entry Date']).slice(0, 10);
    return out;
  });
}
