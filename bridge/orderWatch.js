// Watching staged orders after they leave the app (Nov 2026). Pure helpers — the
// bridge (index.js) does the IB calls and keeps the state on disk.
//
// 1. The 12:30 ET cut-off. TWS rejects a GTD time-in-force on an inter-exchange combo
//    (SPX: "Inter exchange combo order should be DAY/GTC order"), so a 0DTE entry is
//    staged as DAY and the BRIDGE cancels it at the cut-off if nothing has filled.
//    The registry of staged orders is written to disk, so a bridge restart before
//    12:30 still cancels on time.
//
// 2. The market at send and at fill. A paper fill can print far from any real market
//    (SPX 17 Nov filled a put spread well through the mid). Recording the combo mid
//    when the order is staged and again when TWS reports the fill makes that visible
//    on its own — and on a live account it is the slippage the review needs.
//
// Sign convention everywhere here: money in is positive, per lot — the ticket's
// convention (a credit is +, a debit is −), and the same as the reconcile screen's
// netPrice, so "mid − fill" is slippage with worse always positive.

/** "00020057.6ae1e1c9.02.01" → "00020057.6ae1e1c9" — the id every leg of one combo fill shares. */
export function execStem(execId) {
  const p = String(execId || '').split('.');
  return p.length >= 2 ? `${p[0]}.${p[1]}` : String(execId || '');
}

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
const r4 = x => Math.round(x * 10000) / 10000;

/**
 * Combo quote from leg quotes.
 * @param legs [{ sign: +1 money in (sold / short) | −1 money out (bought / long), qty, bid, ask }]
 * @param lots divide by this (default: gcd of the quantities)
 * @returns { mid, natural, best, spread } per lot, money-in positive; null if any leg has no two-sided quote
 */
export function comboMidOf(legs, lots) {
  if (!Array.isArray(legs) || !legs.length) return null;
  const L = lots || legs.map(l => Math.round(Math.abs(Number(l.qty) || 0))).reduce((a, b) => gcd(a, b), 0) || 1;
  let mid = 0, natural = 0, best = 0;
  for (const l of legs) {
    const b = Number(l.bid), a = Number(l.ask), q = Math.abs(Number(l.qty) || 0), s = l.sign >= 0 ? 1 : -1;
    // A far-OTM leg can be bid 0 / ask 0.05, so a zero bid is a real quote; no ask is not.
    if (!(a > 0) || !(b >= 0) || a < b || !(q > 0)) return null;
    mid += s * q * (a + b) / 2;
    natural += s * q * (s > 0 ? b : a);    // crossing the market: sell at the bid, buy at the ask
    best += s * q * (s > 0 ? a : b);
  }
  return { mid: r4(mid / L), natural: r4(natural / L), best: r4(best / L), spread: r4((best - natural) / L), lots: L };
}

/** Ticket legs ({ qty: −1 short / +1 long per lot }) → comboMidOf input signs. */
export const ticketSign = qty => (Number(qty) < 0 ? 1 : -1);
/** Execution side → sign. */
export const execSign = side => (String(side || '').toUpperCase() === 'SLD' ? 1 : -1);

/**
 * What to do with a staged entry at its cut-off.
 * @param st { found, status, filled } from this client's open orders (found=false: not open any more)
 * @returns 'cancel' | 'filled' | 'partial' | 'gone'
 */
export function cutoffAction(st) {
  if (!st || !st.found) return 'gone';                    // filled or cancelled before the cut-off
  const filled = Number(st.filled) || 0;
  if (/^filled$/i.test(st.status || '')) return 'filled';
  if (filled > 0) return 'partial';                       // part filled — yours to manage, never pulled
  if (/cancel/i.test(st.status || '')) return 'gone';
  return 'cancel';
}

/** Registry entries whose cut-off has passed and that have not been dealt with. */
export function dueCutoffs(reg, now) {
  return Object.values(reg || {}).filter(e => e && e.cancelAt && !e.done && Number(e.cancelAt) <= now);
}

/** Drop registry / quote entries older than `days` (by their stagedAt / at). */
export function prune(obj, now, days = 10, key = 'at') {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const t = Date.parse(v && (v[key] || v.stagedAt || v.at));
    if (!isFinite(t) || now - t <= days * 864e5) out[k] = v;
  }
  return out;
}
