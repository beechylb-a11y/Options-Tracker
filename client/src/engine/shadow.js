// ── Shadow verdicts (Oct 2026) ──
//
// Every verdict the engine reaches is kept — taken, skipped, passed or blocked — and
// settled against what the underlying actually did. That is the only way to tell
// whether a gate earns its place: a blocker is right when what it blocks loses money,
// and nothing logged-only can show the trades it stopped.
//
// Pure functions here; the panel records, the settle pass prices outcomes.

import { bsPrice, RATE, divYieldOf } from './payoffCurve.js';

const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z));
}

/** Engine legs ({ label, strike }) → [{ strike, right, qty }] with qty signed (+ long). */
export function shadowLegs(legs) {
  return (legs || []).map(l => {
    const lb = String(l.label || '').toLowerCase();
    const right = lb.includes('put') ? 'P' : lb.includes('call') ? 'C' : null;
    const mult = /x2\b/.test(lb) ? 2 : 1;
    const qty = (/short|sell/.test(lb) ? -1 : 1) * mult;
    return { strike: Number(l.strike), right, qty };
  }).filter(l => l.right && Number.isFinite(l.strike));
}

export const legsKey = legs => legs.map(l => `${l.qty > 0 ? '+' : ''}${l.qty}${l.strike}${l.right}`).join(' ');

/** Value of the legs at expiry for underlying S, per share (signed: what you hold). */
export function valueAtExpiry(legs, S) {
  return legs.reduce((a, l) => a + l.qty * Math.max(0, l.right === 'C' ? S - l.strike : l.strike - S), 0);
}

/** Held to expiry: per contract $, entry per share (+ credit / − debit), before commission. */
export function pnlAtExpiry(legs, entryNet, S) {
  return Math.round((valueAtExpiry(legs, S) + entryNet) * 100 * 100) / 100;
}

/** 0DTE fair entry, normal model on the move left (sd in points). + credit / − debit. */
export function fairNet0(legs, S, sd) {
  if (!(S > 0) || !(sd > 0) || !legs.length) return null;
  const v = legs.reduce((a, l) => {
    const d = (l.right === 'C' ? S - l.strike : l.strike - S) / sd;
    const intr = l.right === 'C' ? S - l.strike : l.strike - S;
    return a + l.qty * (intr * N(d) + sd * Math.exp(-d * d / 2) / Math.sqrt(2 * Math.PI));
  }, 0);
  return Math.round(-v * 100) / 100;
}

/** 45DTE fair entry, Black-Scholes at the ticket IV. + credit / − debit. */
export function fairNet45(legs, S, ivPct, dte, underlying) {
  if (!(S > 0) || !(ivPct > 0) || !(dte > 0) || !legs.length) return null;
  const v = legs.reduce((a, l) => a + l.qty * bsPrice(S, l.strike, dte / 365, ivPct / 100, l.right, RATE, divYieldOf(underlying)), 0);
  return Math.round(-v * 100) / 100;
}

/** Which bucket a verdict falls in. taken wins over anything once logged. */
export function categoryOf({ blockers, verdictWord, missingInputs, logged }) {
  if (logged) return 'taken';
  if (blockers && blockers.length) return 'blocked';
  if (missingInputs) return 'unsized';
  if (/^Pass/i.test(verdictWord || '')) return 'pass';
  return 'trade';
}

export function shadowSig({ sessionDate, engine, underlying, strategy, legs, expiry, account }) {
  return [sessionDate, engine, underlying, strategy, legsKey(legs), expiry, account || ''].join('|');
}

/** Bars [{ date, close }] (daily) → close on YYYYMMDD, or null when that day has none. */
export function closeOn(bars, ymd) {
  const hit = (bars || []).find(b => String(b.date || '').replace(/-/g, '').slice(0, 8) === ymd);
  const c = hit ? Number(hit.close) : NaN;
  return Number.isFinite(c) && c > 0 ? c : null;
}

/** Is this expiry over? After 16:15 New York on the day, or any later day. */
export function expiryPassed(expiry, now = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map(x => [x.type, x.value]));
  const today = `${p.year}${p.month}${p.day}`;
  if (expiry < today) return true;
  if (expiry > today) return false;
  const hm = Number(p.hour === '24' ? 0 : p.hour) * 60 + Number(p.minute);
  return hm >= 16 * 60 + 15;
}

/** Summary per category: n, settled, win rate and mean P&L per contract. */
export function shadowSummary(rows) {
  const out = {};
  for (const r of rows || []) {
    const c = r.category || 'unknown';
    const s = out[c] || (out[c] = { n: 0, settled: 0, wins: 0, pnl: 0 });
    s.n++;
    const p = Number(r.pnl_per_ct ?? r.pnlPerCt);
    if (r.settled_at || r.settledAt) {
      if (Number.isFinite(p)) { s.settled++; s.pnl += p; if (p > 0) s.wins++; }
    }
  }
  for (const s of Object.values(out)) {
    s.winRate = s.settled ? s.wins / s.settled : null;
    s.avg = s.settled ? s.pnl / s.settled : null;
  }
  return out;
}
