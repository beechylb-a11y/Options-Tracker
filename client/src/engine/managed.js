// ── Managed outcome of a shadow verdict (Oct 2026, learning loop step 3) ──
//
// Held to expiry is the easy number and the wrong one for how the trades are run:
// 0DTE short premium is closed at 15–25% or by 15:00, 45DTE at 50% of max or 21 DTE.
// This walks the underlying's actual path, marks the position with the same models
// the engines use, and exits at the first of: profit target, the 100%-of-premium
// stop, or the planned time. Spread is paid on the way in and, for a managed exit,
// on the way out; commission on every leg crossed.
//
// It is a model of an exit, not a fill: the position's value comes from the
// underlying and a volatility held at entry, not from option quotes, which IBKR
// does not keep for expired contracts.

import { bsPrice, RATE, divYieldOf } from './payoffCurve.js';
import { valueAtExpiry } from './shadow.js';
import { exitRuleFor, STOP_LOSS_PCT } from './data.js';
import { DEFAULT_COMMISSION } from '../utils/commission.js';

const N = x => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x), t = 1 / (1 + 0.3275911 * z);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z));
}
const units = legs => legs.reduce((a, l) => a + Math.abs(l.qty), 0);
const INDEX_ETF = ['SPX', 'XSP', 'NDX', 'RUT', 'SPY', 'QQQ', 'IWM', 'DIA'];

/** Half the combo spread when no quote was seen: per leg, scaled to price. */
export function defaultHalfSpread(legs, underlying, price) {
  const perLeg = (INDEX_ETF.includes(String(underlying || '').toUpperCase()) ? 1.35e-5 : 6e-5) * (Number(price) || 0);
  return Math.round(Math.max(0.01, perLeg) * units(legs) * 100) / 100;
}

/** Round-trip-or-not commission per combo contract. */
export function commissionPerCt(legs, sides, rate = DEFAULT_COMMISSION) {
  return Math.round(units(legs) * rate * sides * 100) / 100;
}

/** Signed value per share of what you hold, normal model on the move left (0DTE). */
export function value0(legs, S, sd) {
  if (!(sd > 1e-9)) return valueAtExpiry(legs, S);
  return legs.reduce((a, l) => {
    const intr = l.right === 'C' ? S - l.strike : l.strike - S;
    const d = intr / sd;
    return a + l.qty * (intr * N(d) + sd * Math.exp(-d * d / 2) / Math.sqrt(2 * Math.PI));
  }, 0);
}

/** Signed value per share, Black-Scholes (45DTE). */
export function value45(legs, S, T, ivPct, underlying) {
  if (!(T > 1e-6)) return valueAtExpiry(legs, S);
  return legs.reduce((a, l) => a + l.qty * bsPrice(S, l.strike, T, ivPct / 100, l.right, RATE, divYieldOf(underlying)), 0);
}

/** Best case held to expiry, per share (for 'max'-basis targets). */
export function maxProfitPS(legs, entryNet) {
  const ks = legs.map(l => l.strike);
  const pts = [Math.min(...ks) * 0.5, ...ks, Math.max(...ks) * 1.5];
  return Math.max(...pts.map(S => valueAtExpiry(legs, S) + entryNet));
}

/**
 * Walk marked steps and exit at the first trigger.
 * @param steps  [{ at, value }] — value = signed per-share value of the holding then
 * @returns { pnlPS, reason, at } (per share, before exit costs) or null with no steps
 */
export function walkExit({ steps, entryNet, target, basis, stopPct = STOP_LOSS_PCT, maxPS }) {
  if (!steps || !steps.length) return null;
  const prem = Math.abs(entryNet);
  const goal = basis === 'max' ? (target / 100) * Math.max(0, maxPS) : (target / 100) * prem;
  const stop = (stopPct / 100) * prem;
  for (const s of steps) {
    const p = s.value + entryNet;
    if (goal > 0 && p >= goal) return { pnlPS: p, reason: 'target', at: s.at };
    if (stop > 0 && p <= -stop) return { pnlPS: p, reason: 'stop', at: s.at };
  }
  const last = steps[steps.length - 1];
  return { pnlPS: last.value + entryNet, reason: last.final ? 'expiry' : 'time', at: last.at };
}

// IBKR history bars: "yyyymmdd  hh:mm:ss" in New York exchange time (see the bridge's
// /api/history note), or epoch seconds. → { ymd, min } minutes after midnight ET.
const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function barTimeET(date) {
  const s = String(date ?? '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})[\s-]+(\d{2}):(\d{2})/.exec(s);
  if (m) return { ymd: m[1] + m[2] + m[3], min: +m[4] * 60 + +m[5] };
  if (/^\d{9,11}$/.test(s)) {
    const p = Object.fromEntries(ET.formatToParts(new Date(+s * 1000)).map(x => [x.type, x.value]));
    return { ymd: p.year + p.month + p.day, min: (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute };
  }
  return null;
}
const etMinOfISO = iso => {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = Object.fromEntries(ET.formatToParts(d).map(x => [x.type, x.value]));
  return { ymd: p.year + p.month + p.day, min: (p.hour === '24' ? 0 : +p.hour) * 60 + +p.minute };
};
const OPEN = 9 * 60 + 30, BELL = 16 * 60, EXIT0 = 15 * 60;

/**
 * 0DTE managed outcome from the expiry day's 5-min bars.
 * The move left is the one seen at capture (sdLeft over hoursLeft), shrinking with √time.
 * @returns { pnl, reason, at, commission, halfSpread } per contract $, or null when the
 *          day's bars are not there (left for the next pass).
 */
export function managed0(row, bars) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  const entry = Number(row.entry_net);
  if (!legs.length || !Number.isFinite(entry)) return null;
  const inp = row.inputs || {};
  const start = etMinOfISO(row.first_seen || row.last_seen);
  const day = String(row.expiry);
  const pts = (bars || []).map(b => ({ t: barTimeET(b.date), S: Number(b.close) }))
    .filter(x => x.t && x.t.ymd === day && x.t.min >= OPEN && x.t.min <= BELL && x.S > 0)
    .sort((a, b) => a.t.min - b.t.min);
  if (pts.length < 20) return null;                       // not a plausible session of bars
  const from = start && start.ymd === day ? start.min : OPEN;
  const hours0 = Number(inp.hours) > 0 ? Number(inp.hours) : Math.max(0.25, (BELL - from) / 60);
  const sd0 = Number(inp.sdLeft) > 0 ? Number(inp.sdLeft)
    : Number(inp.em) > 0 ? Number(inp.em) * Math.sqrt(hours0 / 6.5) : null;
  if (!(sd0 > 0)) return null;
  const sdAt = min => sd0 * Math.sqrt(Math.max(0, (BELL - min) / 60) / hours0);
  const path = pts.filter(x => x.t.min > from && x.t.min <= EXIT0);
  if (!path.length) return null;
  const steps = path.map(x => ({ at: `${day} ${String(Math.floor(x.t.min / 60)).padStart(2, '0')}:${String(x.t.min % 60).padStart(2, '0')}`, value: value0(legs, x.S, sdAt(x.t.min)) }));
  const rule = exitRuleFor('0DTE', row.strategy);
  const ex = walkExit({ steps, entryNet: entry, target: rule.target, basis: rule.basis, maxPS: maxProfitPS(legs, entry) });
  if (!ex) return null;
  const hs = Number.isFinite(Number(row.entry_half_spread)) && row.entry_half_spread !== null ? Number(row.entry_half_spread) : 0;
  const comm = commissionPerCt(legs, 2);
  return { pnl: Math.round((ex.pnlPS - hs) * 100 - comm), reason: ex.reason, at: ex.at, commission: comm };
}

/**
 * 45DTE managed outcome from daily closes: marked with Black-Scholes at the entry IV,
 * exiting at the target, the stop, or the planned close (closeDte before expiry).
 * Ready once the exit has triggered or the planned close date has a bar.
 */
export function managed45(row, dailyBars, now = new Date()) {
  const legs = Array.isArray(row.legs) ? row.legs : [];
  const entry = Number(row.entry_net);
  const iv = Number((row.inputs || {}).iv);
  if (!legs.length || !Number.isFinite(entry) || !(iv > 0)) return null;
  const exp = String(row.expiry);
  const expD = new Date(+exp.slice(0, 4), +exp.slice(4, 6) - 1, +exp.slice(6, 8));
  const rule = exitRuleFor('45DTE', row.strategy);
  const closeD = new Date(expD.getTime() - (rule.closeDte || 21) * 86400000);
  const ymd = d => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const startY = String(row.session_date || '').replace(/-/g, '');
  const closeY = ymd(closeD);
  const days = (dailyBars || []).map(b => ({ y: String(b.date || '').replace(/-/g, '').slice(0, 8), S: Number(b.close) }))
    .filter(x => x.y > startY && x.y <= closeY && x.S > 0).sort((a, b) => (a.y < b.y ? -1 : 1));
  if (!days.length) return null;
  const steps = days.map(x => {
    const d = new Date(+x.y.slice(0, 4), +x.y.slice(4, 6) - 1, +x.y.slice(6, 8));
    return { at: x.y, value: value45(legs, x.S, Math.max(0, (expD - d) / 86400000) / 365, iv, row.underlying) };
  });
  const ex = walkExit({ steps, entryNet: entry, target: rule.target, basis: rule.basis, maxPS: maxProfitPS(legs, entry) });
  if (!ex) return null;
  // Not finished: no trigger yet and the planned close has not passed (a close on a
  // weekend or holiday has no bar of its own; the last session before it stands).
  if (ex.reason === 'time' && days[days.length - 1].y < closeY && ymd(now) <= closeY) return null;
  const hs = Number.isFinite(Number(row.entry_half_spread)) && row.entry_half_spread !== null ? Number(row.entry_half_spread) : 0;
  const comm = commissionPerCt(legs, 2);
  return { pnl: Math.round((ex.pnlPS - hs) * 100 - comm), reason: ex.reason, at: ex.at, commission: comm };
}
