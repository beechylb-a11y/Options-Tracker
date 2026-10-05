// ================================================================
//  DELTA CROSS-CHECK AND DELTA STRIKES  (R-49, Oct 2026)
// ================================================================
// The engines place strikes in units of the expected move. That ruler has no skew in
// it: one EM below spot and one EM above are treated as equally likely to be reached,
// which the market does not believe — puts are bid, so a put one EM down carries more
// delta than a call one EM up. Delta is the market's own statement of that distance.
//
// This module does three things with the per-leg greeks Fetch Greeks already returns:
//   1. BAND CHECK — is each short strike inside the delta band its structure expects?
//   2. POP CHECK  — does the POP you typed agree with the POP the short deltas imply?
//   3. DELTA STRIKES — the same structure rebuilt with its short strikes AT the target
//      delta, wings moved with them so every width is unchanged.
//
// No option chain is needed. The strike for a target delta is solved from the
// short leg's OWN observed delta (which fixes the effective vol × √time at that
// strike, in IBKR's model and IBKR's time convention), and the UI then confirms it
// against a three-strike bracket of live greeks before anything is applied.
//
// Pure functions, no DOM. Deltas are handled as ABSOLUTE values in delta points
// (0–100) unless a name says otherwise.

// ── Normal distribution ─────────────────────────────────────────────────────
export function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 on erf; |error| < 1.5e-7.
  const s = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}

export function normInv(p) {
  // Acklam's rational approximation; relative error < 1.2e-9.
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const lo = 0.02425, hi = 1 - lo;
  let q, r;
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > hi) {
    q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Black-Scholes in terms of v = σ√T (zero rates, zero dividends) ──────────
// Working in v rather than σ and T separately is deliberate: the one number that
// matters for where a delta lands is total vol to expiry, and calibrating v from an
// observed delta sidesteps every argument about calendar vs trading time.

/** |delta| (0..1) of a call or put at strike K. */
export function bsAbsDelta(S, K, v, right) {
  if (!(S > 0 && K > 0 && v > 0)) return null;
  const d1 = (Math.log(S / K) + 0.5 * v * v) / v;
  const callDelta = normCdf(d1);
  return right === 'P' ? 1 - callDelta : callDelta;
}

/** The strike whose |delta| is absDelta (0..1), for total vol v. */
export function strikeForDelta(S, absDelta, v, right) {
  if (!(S > 0 && v > 0 && absDelta > 0 && absDelta < 1)) return null;
  const callDelta = right === 'P' ? 1 - absDelta : absDelta;
  const d1 = normInv(callDelta);
  return S * Math.exp(-d1 * v + 0.5 * v * v);
}

/**
 * Total vol v = σ√T that makes BS reproduce an OBSERVED |delta| at strike K.
 * Solves ½v² − d1·v + ln(S/K) = 0. Two roots; the one nearest the IV-based
 * estimate v0 is taken (or the smaller positive root without one). Falls back to v0
 * when the observation cannot pin v down — a delta near 0.5 (strike near spot),
 * near 0 or 1, or no real root.
 */
export function calibrateV(S, K, absDelta, right, v0 = null) {
  const fallback = v0 > 0 ? v0 : null;
  if (!(S > 0 && K > 0) || !(absDelta > 0.005 && absDelta < 0.995)) return fallback;
  const x = Math.log(S / K);
  if (Math.abs(x) < 1e-4) return fallback;               // ATM: delta says nothing about v
  const callDelta = right === 'P' ? 1 - absDelta : absDelta;
  const d1 = normInv(callDelta);
  const disc = d1 * d1 - 2 * x;
  if (disc < 0) return fallback;
  const roots = [d1 + Math.sqrt(disc), d1 - Math.sqrt(disc)].filter(r => r > 1e-6);
  if (!roots.length) return fallback;
  if (fallback) return roots.reduce((a, b) => (Math.abs(b - fallback) < Math.abs(a - fallback) ? b : a));
  return Math.min(...roots);
}

// ── Strike grids ─────────────────────────────────────────────────────────────
// Same increments the 0DTE builder rounds to. The 45DTE builder rounds everything to
// 0.5, which is not a real SPX strike — delta strikes go to the real grid because the
// bracket check has to ask TWS about strikes that exist.
export function strikeGrid(underlying) {
  const u = String(underlying || '').toUpperCase();
  if (u === 'SPX' || u === 'RUT' || u === 'NDX') return 5;
  if (['SPY', 'QQQ', 'IWM', 'XSP', 'DIA'].includes(u)) return 1;
  return 0.5;
}
const roundToGrid = (k, step) => Math.round(k / step) * step;

// ── Targets ──────────────────────────────────────────────────────────────────
// Delta points (absolute). `t` is where the delta method puts the short; `lo`–`hi` is
// the band the cross-check accepts before it says anything.
//
// 0DTE. The EM builder puts condor and credit-vertical shorts one remaining-session SD
// out, which is ~16Δ on a flat surface; the credit-vertical pullback buffer pushes up to
// 1.4 SD (~8Δ), hence the lower floor there. Chicken condor: tight side 1 SD, wide side
// 1.5 SD (~7Δ). Debit verticals sell 0.5 SD (~30Δ). Bands are wide because 0DTE skew is
// steep: a 1-SD put is routinely 20Δ while the matching call is 12Δ.
//
// 45DTE. From the playbook's delta guide (data.js DELTA_GUIDE): condor shorts 16–20Δ,
// credit-spread shorts 25–30Δ, jade lizard 20Δ put / 16Δ call, debit verticals 30Δ short,
// ratio shorts 25Δ.
//
// Structures with no entry here (flies, iron fly, reversed condor, calendars, diagonals)
// are placed by pin or by time, not by probability, and the check stays silent on them.
//
// mode 'side'  — the short moves to target and its wing(s) move with it: widths kept.
// mode 'short' — only the short moves (debit verticals and ratios, whose long leg is
//                anchored at the money on purpose).
// pop  'credit' — POP ≈ 1 − Σ|Δ short| (one short per side); null = no POP check.
export const DELTA_TARGETS = {
  '0dte': {
    'Iron Condor - Normal': { mode: 'side', pop: 'credit', shorts: { P: { t: 16, lo: 8, hi: 25 }, C: { t: 16, lo: 8, hi: 25 } } },
    'Bull put spread':      { mode: 'side', pop: 'credit', shorts: { P: { t: 15, lo: 6, hi: 25 } } },
    'Bear call spread':     { mode: 'side', pop: 'credit', shorts: { C: { t: 15, lo: 6, hi: 25 } } },
    'Chicken condor':       { mode: 'side', pop: 'credit', shorts: { near: { t: 16, lo: 8, hi: 25 }, far: { t: 7, lo: 3, hi: 14 } } },
    'Bull call spread':     { mode: 'short', pop: null, shorts: { C: { t: 30, lo: 20, hi: 42 } } },
    'Bear put spread':      { mode: 'short', pop: null, shorts: { P: { t: 30, lo: 20, hi: 42 } } },
  },
  '45dte': {
    'Iron Condor - Normal': { mode: 'side', pop: 'credit', shorts: { P: { t: 18, lo: 12, hi: 25 }, C: { t: 18, lo: 12, hi: 25 } } },
    'Credit spread':        { mode: 'side', pop: 'credit', shorts: { P: { t: 28, lo: 20, hi: 35 }, C: { t: 28, lo: 20, hi: 35 } } },
    'Jade lizard':          { mode: 'side', pop: 'credit', shorts: { P: { t: 20, lo: 15, hi: 30 }, C: { t: 16, lo: 10, hi: 22 } } },
    'Bull call spread':     { mode: 'short', pop: null, shorts: { C: { t: 30, lo: 20, hi: 40 } } },
    'Bear put spread':      { mode: 'short', pop: null, shorts: { P: { t: 30, lo: 20, hi: 40 } } },
    'Ratio spread':         { mode: 'short', pop: null, shorts: { C: { t: 25, lo: 18, hi: 32 } } },
  },
};

export const DEFAULT_STRIKE_METHOD = { '0dte': 'em', '45dte': 'delta' };

// ── Legs ─────────────────────────────────────────────────────────────────────
/** Right, side and pairing tag read off an engine leg label. */
export function parseLeg(l) {
  const lbl = String(l && l.label || '').toLowerCase();
  const right = lbl.includes('put') ? 'P' : lbl.includes('call') ? 'C' : null;
  const tagM = /\((vix1d|vix)\)/i.exec(l && l.label || '');
  return { label: l.label, strike: l.strike, right, short: lbl.includes('short'), tag: tagM ? tagM[1].toUpperCase() : null };
}

/** The greeks row for a leg, matched on strike AND right. */
function greeksFor(leg, legGreeks) {
  if (!Array.isArray(legGreeks)) return null;
  return legGreeks.find(g => g && Math.abs(Number(g.strike) - leg.strike) < 1e-6
    && String(g.right || '').toUpperCase() === leg.right && g.delta != null && isFinite(g.delta)) || null;
}

/** Nearest observation of the same right within maxDist — enough to calibrate v. */
function nearestGreeks(leg, legGreeks, maxDist) {
  if (!Array.isArray(legGreeks)) return null;
  const same = legGreeks.filter(g => g && String(g.right || '').toUpperCase() === leg.right
    && g.delta != null && isFinite(g.delta) && Math.abs(Number(g.strike) - leg.strike) <= maxDist);
  if (!same.length) return null;
  return same.reduce((a, b) => (Math.abs(Number(b.strike) - leg.strike) < Math.abs(Number(a.strike) - leg.strike) ? b : a));
}

/** The band for one short leg, or null when the structure has none for it. */
function bandFor(spec, leg, shortsParsed, price) {
  if (!spec || !leg.right) return null;
  if (spec.shorts.near || spec.shorts.far) {
    // Chicken condor: tight side vs wide side, by distance from spot.
    const others = shortsParsed.filter(s => s !== leg && s.right && s.right !== leg.right);
    if (!others.length || !(price > 0)) return spec.shorts.near;
    const mine = Math.abs(leg.strike - price), theirs = Math.min(...others.map(o => Math.abs(o.strike - price)));
    return mine <= theirs ? spec.shorts.near : spec.shorts.far;
  }
  return spec.shorts[leg.right] || null;
}

const fmtD = d => (d == null ? '—' : d.toFixed(0) + 'Δ');

// ── 1 + 2. The cross-check ───────────────────────────────────────────────────
/**
 * @param legs       the ticket's legs as built (post-override)
 * @param strat      structure name
 * @param horizon    '0dte' | '45dte'
 * @param legGreeks  [{ strike, right, delta, iv }] from Fetch Greeks (signed delta, iv in %)
 * @param pop        POP typed on the ticket, percent (0 = not entered)
 * @param hoursLeft  0DTE only: hours to the working close; ≤ 1 suspends the check
 * @returns { applicable, rows, impliedPop, popGap, suspended, stale, haveGreeks, warnings, notices }
 */
export function deltaCrossCheck({ legs, strat, horizon, legGreeks, pop, hoursLeft, price }) {
  const out = { applicable: false, rows: [], impliedPop: null, popGap: null, suspended: false,
    stale: false, haveGreeks: false, warnings: [], notices: [] };
  const spec = (DELTA_TARGETS[horizon] || {})[strat];
  if (!spec || !Array.isArray(legs) || !legs.length) return out;
  out.applicable = true;
  out.spec = spec;

  const parsed = legs.map(parseLeg);
  const shorts = parsed.filter(p => p.short && p.right);
  out.rows = shorts.map(s => {
    const band = bandFor(spec, s, shorts, price);
    const g = greeksFor(s, legGreeks);
    const delta = g ? Math.abs(g.delta) * 100 : null;
    return { label: s.label, strike: s.strike, right: s.right, delta, iv: g && g.iv > 0 ? g.iv : null,
      target: band ? band.t : null, lo: band ? band.lo : null, hi: band ? band.hi : null,
      inBand: band && delta != null ? delta >= band.lo && delta <= band.hi : null };
  });
  const banded = out.rows.filter(r => r.target != null);
  out.haveGreeks = banded.length > 0 && banded.every(r => r.delta != null);
  // Some deltas came back for other strikes: the strikes were changed after the fetch.
  out.stale = Array.isArray(legGreeks) && legGreeks.length > 0 && !out.haveGreeks;
  if (!out.haveGreeks) return out;

  // POP implied by the short deltas. One short per side counts; where a side carries
  // two (the dual-EM vertical pair) the larger delta is taken, the cautious reading.
  if (spec.pop === 'credit') {
    const bySide = {};
    banded.forEach(r => { bySide[r.right] = Math.max(bySide[r.right] || 0, r.delta); });
    const sum = Object.values(bySide).reduce((a, b) => a + b, 0);
    out.impliedPop = Math.max(0, Math.min(1, 1 - sum / 100));
    if (pop > 0) out.popGap = pop - out.impliedPop * 100;
  }

  // Final hour of a 0DTE: out-of-the-money deltas collapse toward zero as time runs out,
  // so every short reads "too far out" and the POP rule reads near 100%. Neither means
  // anything; say so once and stay quiet.
  if (horizon === '0dte' && hoursLeft > 0 && hoursLeft <= 1) {
    out.suspended = true;
    out.notices.push('Delta check off in the final hour — out-of-the-money 0DTE deltas collapse toward zero, so bands and delta-implied POP stop meaning anything');
    return out;
  }

  banded.forEach(r => {
    if (r.inBand) return;
    const side = r.right === 'P' ? 'put' : 'call';
    out.warnings.push(r.delta > r.hi
      ? `Short ${side} ${r.strike} is ${fmtD(r.delta)} — above the ${r.lo}–${r.hi}Δ band for ${strat}: the market prices it closer than the expected move does (target ${r.target}Δ)`
      : `Short ${side} ${r.strike} is ${fmtD(r.delta)} — below the ${r.lo}–${r.hi}Δ band for ${strat}: further out than intended, so the premium is thin (target ${r.target}Δ)`);
  });
  if (out.popGap != null && Math.abs(out.popGap) > 10) {
    out.warnings.push(`POP ${pop.toFixed(0)}% entered vs ~${(out.impliedPop * 100).toFixed(0)}% implied by the short deltas `
      + `(${out.popGap > 0 ? '+' : ''}${out.popGap.toFixed(0)} pts) — EV and Kelly run off the POP you typed; check it`);
  }
  return out;
}

// ── 3. Delta strikes ─────────────────────────────────────────────────────────
/**
 * The same structure with each short at its target delta.
 *
 * @param legs, strat, horizon, price, legGreeks — as deltaCrossCheck
 * @param T              years to expiry, only for the IV fallback when a delta can't pin v
 * @param underlying     sets the strike grid
 * @param shortStrikes   optional { legIndex: strike } — short strikes already confirmed
 *                       against live greeks (the bracket check); used as-is
 * @returns null, or { legs, moves: [{ idx, label, right, from, to, target, curDelta, estDelta }],
 *          changed, basis }
 */
export function deltaStrikePlan({ legs, strat, horizon, price, legGreeks, T, underlying, shortStrikes }) {
  const spec = (DELTA_TARGETS[horizon] || {})[strat];
  if (!spec || !(price > 0) || !Array.isArray(legs) || !legs.length) return null;
  const step = strikeGrid(underlying);
  const parsed = legs.map(parseLeg);
  const shortsP = parsed.filter(p => p.short && p.right);

  const moves = [];
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    if (!p.short || !p.right) continue;
    const band = bandFor(spec, p, shortsP, price);
    if (!band) continue;
    // One observation per short calibrates v. Its own strike is best; a neighbour on the
    // real grid will do (the 45DTE builder rounds to 0.5, which SPX does not list).
    const g = greeksFor(p, legGreeks) || nearestGreeks(p, legGreeks, 4 * step);
    if (!g) return null;
    const cur = Math.abs(g.delta);
    const v0 = g.iv > 0 && T > 0 ? (g.iv / 100) * Math.sqrt(T) : null;
    const v = calibrateV(price, Number(g.strike), cur, p.right, v0);
    if (!(v > 0)) return null;
    let to;
    if (shortStrikes && shortStrikes[i] != null) to = shortStrikes[i];
    else {
      const k = strikeForDelta(price, band.t / 100, v, p.right);
      if (!(k > 0)) return null;
      to = roundToGrid(k, step);
    }
    moves.push({ idx: i, label: p.label, right: p.right, tag: p.tag, from: p.strike, to,
      target: band.t, curDelta: (bsAbsDelta(price, p.strike, v, p.right) || cur) * 100, estDelta: (bsAbsDelta(price, to, v, p.right) || 0) * 100, v });
  }
  if (!moves.length) return null;

  const next = legs.map(l => ({ ...l }));
  moves.forEach(m => { next[m.idx].strike = m.to; });

  if (spec.mode === 'side') {
    // Each long rides with the short it protects: same right, on the far (OTM) side.
    // Pairing tag first (the dual-EM vertical's "(VIX)" / "(VIX1D)" sets), otherwise the
    // nearest such short — so two shorts on one side never fight over the same wing.
    parsed.forEach((p, i) => {
      if (p.short || !p.right) return;
      const cands = moves.filter(m => m.right === p.right
        && (p.right === 'P' ? p.strike < m.from : p.strike > m.from));
      if (!cands.length) return;
      const tagged = p.tag ? cands.find(m => m.tag === p.tag) : null;
      const m = tagged || cands.reduce((a, b) => (Math.abs(b.from - p.strike) < Math.abs(a.from - p.strike) ? b : a));
      next[i].strike = roundToGrid(p.strike + (m.to - m.from), step);
    });
  } else {
    // Short only. A debit spread whose short crosses its long is no longer a spread:
    // hold the short at least one strike beyond the long.
    moves.forEach(m => {
      const longs = parsed.filter(p => !p.short && p.right === m.right);
      longs.forEach(l => {
        if (m.right === 'C' && next[m.idx].strike <= l.strike) next[m.idx].strike = l.strike + step;
        if (m.right === 'P' && next[m.idx].strike >= l.strike) next[m.idx].strike = l.strike - step;
      });
      m.to = next[m.idx].strike;
      m.estDelta = (bsAbsDelta(price, m.to, m.v, m.right) || 0) * 100;
    });
  }

  return {
    legs: next,
    moves: moves.map(({ v, tag, ...m }) => m),
    changed: next.some((l, i) => l.strike !== legs[i].strike),
    basis: shortStrikes ? 'confirmed against live greeks' : 'estimated from each short’s own delta',
  };
}

/** Bracket of strikes around an estimate, for the live-greeks confirmation. */
export function bracketStrikes(k, underlying, n = 1) {
  const step = strikeGrid(underlying);
  const out = [];
  for (let j = -n; j <= n; j++) out.push(roundToGrid(k + j * step, step));
  return out;
}

/** From live quotes [{ strike, delta }], the strike whose |delta| is nearest target (Δ points). */
export function pickByDelta(rows, target) {
  const ok = (rows || []).filter(r => r && r.delta != null && isFinite(r.delta));
  if (!ok.length) return null;
  return ok.reduce((a, b) => (Math.abs(Math.abs(b.delta) * 100 - target) < Math.abs(Math.abs(a.delta) * 100 - target) ? b : a));
}

/** "6650P 18Δ / 6800C 14Δ" — the log column and the print line. */
export function shortDeltaSummary(check) {
  if (!check || !check.rows || !check.rows.length) return '';
  return check.rows.map(r => `${r.strike}${r.right} ${fmtD(r.delta)}`).join(' / ');
}
