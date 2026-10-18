// ── Ratio spread construction (R-54, Oct 2026) ──
//
// A front ratio buys L options at the money and sells S > L of them 0.5 SD out.
// Every short beyond the longs (S − L of them) is uncovered past the short strike:
// the unlimited-risk tail OIC lists for a "short ratio call spread". The builder
// used to offer only 1:2 and nothing to close that tail.
//
// Now the ticket chooses the ratio (1:2, 2:3, 3:4) and, by default, adds S − L
// protective longs further out. The suggested protective strike is the furthest one
// at which the protected spread still loses nothing above it before premium — the
// longs' gain up to the short strike exactly pays for the uncovered shorts beyond:
//
//     K_prot = K_short + L / (S − L) × (K_short − K_long)
//
// With the engine's long at the money and shorts at +0.5 SD that is +1.0 / +1.5 /
// +2.0 SD. A protective strike further out collects more credit and reopens a
// capped loss above it:
//
//     max loss above K_prot = 100 × [(S − L)(K_prot − K_short) − L (K_short − K_long)] − net
//
// so the snap onto the grid or the listed chain goes INWARD (toward the shorts),
// never outward: inward only makes the top side better. Puts mirror below spot.
// Protection off makes the trade undefined risk — see calc45dte (R-56).

import { legQty } from './legQty.js';

export const RATIO_CHOICES = [
  { id: '1:2', L: 1, S: 2 },
  { id: '2:3', L: 2, S: 3 },
  { id: '3:4', L: 3, S: 4 },
];
export const DEFAULT_RATIO_SPEC = { ratio: '1:2', protect: true };

/** The ratio choice for a spec (unknown or missing → 1:2). */
export function ratioChoice(spec) {
  const id = spec && spec.ratio;
  return RATIO_CHOICES.find(c => c.id === id) || RATIO_CHOICES[0];
}
/** Protection is on unless the spec says false. */
export const isProtected = spec => !(spec && spec.protect === false);

/** The zero-risk protective strike (unrounded). */
export function zeroRiskStrike(kLong, kShort, L, S) {
  if (!(S > L) || !(L > 0)) return null;
  return kShort + (L / (S - L)) * (kShort - kLong);
}

const EPS = 1e-6;

/**
 * Snap a protective strike onto the grid (or the listed chain for its right) on the
 * SHORT's side of k: never further out than k, never on or inside the short.
 */
export function snapInward(k, kShort, step, listed) {
  const dir = Math.sign(k - kShort);
  if (!dir || !(step > 0)) return k;
  const d = Math.abs(k - kShort);
  if (Array.isArray(listed) && listed.length) {
    const beyond = listed.filter(x => (x - kShort) * dir > EPS);
    if (beyond.length) {
      const inside = beyond.filter(x => Math.abs(x - kShort) <= d + EPS);
      if (inside.length) return inside.reduce((a, b) => (Math.abs(b - kShort) > Math.abs(a - kShort) ? b : a));
      return beyond.reduce((a, b) => (Math.abs(b - kShort) < Math.abs(a - kShort) ? b : a));
    }
  }
  const n = Math.max(1, Math.floor(d / step + EPS));
  return +(kShort + dir * n * step).toFixed(6);
}

const qtyTag = n => (n > 1 ? ` x${n}` : '');

/**
 * The ratio spread's legs.
 * @param p      underlying price
 * @param sd50   half the horizon's 1-SD move
 * @param R      grid rounding the builder uses
 * @param step   strike increment
 * @param isBear puts below spot instead of calls above
 * @param spec   { ratio: '1:2'|'2:3'|'3:4', protect: bool }
 */
export function buildRatioLegs({ p, sd50, R, step, isBear, spec }) {
  const { L, S } = ratioChoice(spec);
  const right = isBear ? 'put' : 'call';
  const dir = isBear ? -1 : 1;
  const kLong = R(p);
  let kShort = R(p + dir * sd50);
  if ((kShort - kLong) * dir < step - EPS) kShort = kLong + dir * step;   // keep the short beyond the long
  const legs = [
    { label: `Long ${right}${qtyTag(L)}`, strike: kLong, qty: L },
    { label: `Short ${right}${qtyTag(S)}`, strike: kShort, qty: S },
  ];
  if (isProtected(spec)) {
    const k = snapInward(zeroRiskStrike(kLong, kShort, L, S), kShort, step, null);
    legs.push({ label: `Long ${right}${qtyTag(S - L)} (protective)`, strike: k, qty: S - L });
  }
  return legs;
}

const isProt = l => /protective/i.test(String(l && l.label || ''));
const isShortLeg = l => /short|sell/i.test(String(l && l.label || ''));

/** Indices of the long, short and protective legs, or null when it is not a ratio. */
export function ratioShape(legs) {
  if (!Array.isArray(legs)) return null;
  const pi = legs.findIndex(isProt);
  const si = legs.findIndex(isShortLeg);
  const li = legs.findIndex((l, i) => i !== pi && !isShortLeg(l));
  if (si < 0 || li < 0) return null;
  return { li, si, pi: pi >= 0 ? pi : null };
}

/**
 * Re-place the protective long from the CURRENT long and short (after delta strikes,
 * a listed-chain fit or a hand edit moved them). Quantities come from the labels.
 * keep: true when the user typed the protective strike — it is left where they put it.
 */
export function reprotect(legs, { step, listed = null, keep = false } = {}) {
  const sh = ratioShape(legs);
  if (!sh || sh.pi == null || keep) return legs;
  const L = legQty(legs[sh.li]), S = legQty(legs[sh.si]);
  const kL = Number(legs[sh.li].strike), kS = Number(legs[sh.si].strike);
  const k0 = zeroRiskStrike(kL, kS, L, S);
  if (k0 == null || !isFinite(k0)) return legs;
  const right = /put/i.test(legs[sh.pi].label) ? 'P' : 'C';
  const list = listed && listed[right] && listed[right].length ? listed[right] : null;
  const k = snapInward(k0, kS, step, list);
  if (Math.abs(k - Number(legs[sh.pi].strike)) < EPS) return legs;
  const out = legs.map(l => ({ ...l }));
  out[sh.pi].strike = k;
  return out;
}

/**
 * Expiry loss above (calls) / below (puts) the protective strike, in $ per package,
 * before premium. 0 or less = no loss up there; null = unprotected or not a ratio.
 */
export function ratioTailLoss(legs) {
  const sh = ratioShape(legs);
  if (!sh || sh.pi == null) return null;
  const L = legQty(legs[sh.li]), S = legQty(legs[sh.si]), P = legQty(legs[sh.pi]);
  const kL = +legs[sh.li].strike, kS = +legs[sh.si].strike, kP = +legs[sh.pi].strike;
  // Beyond every strike the payoff slope is L − S + P; a protected ratio has P = S − L.
  const slope = L - S + P;
  if (slope < 0) return null;
  // Payoff at kP (per share, calls up / puts down mirror by distance).
  const pay = L * Math.abs(kP - kL) - S * Math.abs(kP - kS);
  return Math.max(0, -pay) * 100;
}
