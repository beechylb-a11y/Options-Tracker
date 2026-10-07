// ── Strikes that are actually listed, per expiry and per right (Oct 2026) ──
//
// The builders round to a fixed grid ($5 SPX, $1 ETFs). Real chains are not that
// regular: QQQ 20 Nov lists puts every $1 but calls every $5 that far out, so an
// engine condor of 701/712/811/822 asks for two calls that do not exist, and
// once fixed by hand the wings differ (11 vs 10) — TWS then shows a custom combo,
// not an iron condor.
//
// fitToListed moves each leg onto a strike listed for its own right. Iron condors
// and iron flies are fitted as a whole: one wing width that exists on BOTH sides,
// shorts moved as little as possible. Everything else snaps leg by leg, keeping
// legs that were apart from collapsing onto one strike.

const rightOf = l => {
  const s = String(l && l.label || '').toLowerCase();
  return s.includes('put') ? 'P' : s.includes('call') ? 'C' : null;
};
const isShort = l => /short|sell/i.test(String(l && l.label || ''));
const EPS = 1e-6;

function sortedList(a) {
  return Array.isArray(a) ? [...new Set(a.map(Number).filter(x => isFinite(x) && x > 0))].sort((x, y) => x - y) : [];
}

/** Normalise { C:[...], P:[...] } (or { calls, puts }); null when nothing usable. */
export function normListed(listed) {
  if (!listed) return null;
  const C = sortedList(listed.C || listed.calls), P = sortedList(listed.P || listed.puts);
  return C.length || P.length ? { C, P } : null;
}

const has = (list, k) => list.some(x => Math.abs(x - k) < EPS);
export function nearestListed(list, k) {
  if (!list || !list.length) return k;
  return list.reduce((a, b) => (Math.abs(b - k) < Math.abs(a - k) ? b : a));
}
/** The n listed strikes either side of k (k itself included if listed), ascending. */
export function neighbours(list, k, n = 2) {
  const below = list.filter(x => x <= k + EPS).slice(-n - 1);
  const above = list.filter(x => x > k + EPS).slice(0, n);
  return [...below, ...above];
}
/** Strikes on the listed chain around k, high → low (the ladder's order). */
export function listedLadder(list, k, n = 3) {
  const L = list && list.length ? list : null;
  if (!L) return null;
  const c = nearestListed(L, k);
  const i = L.findIndex(x => Math.abs(x - c) < EPS);
  return L.slice(Math.max(0, i - n), i + n + 1).reverse();
}

// Iron condor / iron fly shape: one short + one long put (long below), one short +
// one long call (long above). Returns the four indices or null.
function ironShape(legs) {
  const P = [], C = [];
  legs.forEach((l, i) => { const r = rightOf(l); if (r === 'P') P.push(i); else if (r === 'C') C.push(i); });
  if (P.length !== 2 || C.length !== 2) return null;
  const sp = P.find(i => isShort(legs[i])), lp = P.find(i => !isShort(legs[i]));
  const sc = C.find(i => isShort(legs[i])), lc = C.find(i => !isShort(legs[i]));
  if ([sp, lp, sc, lc].some(i => i == null)) return null;
  if (!(legs[lp].strike < legs[sp].strike) || !(legs[lc].strike > legs[sc].strike)) return null;
  return { sp, lp, sc, lc };
}

function fitIron(legs, L, ix) {
  const sp0 = legs[ix.sp].strike, sc0 = legs[ix.sc].strike;
  const W0 = ((sp0 - legs[ix.lp].strike) + (legs[ix.lc].strike - sc0)) / 2;
  const fly = Math.abs(sp0 - sc0) < EPS;
  const spC = neighbours(L.P, sp0, 3);
  const scC = fly ? null : neighbours(L.C, sc0, 3);
  let best = null;
  const tryOne = (sp, sc) => {
    if (fly ? Math.abs(sp - sc) > EPS : sp >= sc) return;
    // every width that is listed on both sides
    L.P.forEach(lp => {
      const w = sp - lp;
      if (!(w > EPS) || w > Math.max(3 * W0, W0 + 25)) return;
      if (!has(L.C, sc + w)) return;
      // shorts are the trade (delta/EM-placed); the width is risk — weigh both
      const cost = Math.abs(sp - sp0) + Math.abs(sc - sc0) + Math.abs(w - W0) + (w > W0 ? 0.01 : 0);
      if (!best || cost < best.cost - EPS) best = { cost, sp, sc, w };
    });
  };
  if (fly) spC.filter(k => has(L.C, k)).forEach(k => tryOne(k, k));
  else spC.forEach(sp => scC.forEach(sc => tryOne(sp, sc)));
  if (!best) return null;
  const out = legs.map(l => ({ ...l }));
  out[ix.sp].strike = best.sp; out[ix.lp].strike = best.sp - best.w;
  out[ix.sc].strike = best.sc; out[ix.lc].strike = best.sc + best.w;
  return out;
}

function fitEach(legs, L) {
  const out = legs.map(l => {
    const list = L[rightOf(l)];
    return list && list.length ? { ...l, strike: nearestListed(list, l.strike) } : { ...l };
  });
  // Two legs of one right that were apart must stay apart: the long steps outward.
  for (let i = 0; i < out.length; i++) {
    for (let j = 0; j < out.length; j++) {
      if (i === j || rightOf(out[i]) !== rightOf(out[j]) || isShort(out[j]) || !isShort(out[i])) continue;
      if (Math.abs(legs[i].strike - legs[j].strike) < EPS || Math.abs(out[i].strike - out[j].strike) > EPS) continue;
      const list = L[rightOf(out[j])];
      const up = legs[j].strike > legs[i].strike;
      const next = up ? list.find(x => x > out[i].strike + EPS) : [...list].reverse().find(x => x < out[i].strike - EPS);
      if (next != null) out[j].strike = next;
    }
  }
  return out;
}

/**
 * Is this chain believable for these legs? A short or truncated reply from the
 * bridge (a timeout, a TWS hiccup) once left a condor with both calls on 825.
 * Each right the legs use needs a real list that spans the legs' strikes.
 */
export function chainCovers(legs, listed) {
  const L = normListed(listed);
  if (!L) return { ok: false, why: 'no listed strikes' };
  for (const r of ['P', 'C']) {
    const ks = (legs || []).filter(l => rightOf(l) === r).map(l => +l.strike).filter(k => k > 0);
    if (!ks.length) continue;
    const list = L[r], name = r === 'P' ? 'puts' : 'calls';
    if (list.length < 5) return { ok: false, why: `only ${list.length} ${name} came back` };
    const lo = Math.min(...ks), hi = Math.max(...ks);
    const span = Math.max(hi - lo, 1);
    if (list[0] > lo + span || list[list.length - 1] < hi - span) {
      return { ok: false, why: `${name} listed ${list[0]}–${list[list.length - 1]} do not reach ${lo}–${hi}` };
    }
  }
  return { ok: true, why: null };
}

/** Two legs of one right that were apart now share a strike. */
function collapsed(before, after) {
  for (let i = 0; i < after.length; i++) for (let j = i + 1; j < after.length; j++) {
    if (rightOf(after[i]) !== rightOf(after[j])) continue;
    if (Math.abs(before[i].strike - before[j].strike) > EPS && Math.abs(after[i].strike - after[j].strike) < EPS) return true;
  }
  return false;
}

/**
 * @param legs    [{ label, strike }]
 * @param listed  { C:[...], P:[...] } for the ticket's expiry
 * @returns { legs, changed, moves:[{ idx, label, from, to }], equalWings } — legs
 *          unchanged (changed false) when there is nothing to fit against.
 */
export function fitToListed(legs, listed) {
  const L = normListed(listed);
  const none = (skipped = null) => ({ legs: legs || [], changed: false, moves: [], equalWings: null, skipped });
  if (!L || !Array.isArray(legs) || !legs.length) return none();
  const cover = chainCovers(legs, L);
  if (!cover.ok) return none(cover.why);
  const ix = ironShape(legs);
  let out = null, equalWings = null;
  if (ix) {
    // A condor / iron fly is fitted whole or not at all: snapping leg by leg is
    // what gives uneven wings.
    out = fitIron(legs, L, ix);
    if (!out) return none('no wing width is listed on both sides near these strikes');
    equalWings = out[ix.sp].strike - out[ix.lp].strike;
  } else {
    out = fitEach(legs, L);
  }
  if (collapsed(legs, out)) return none('fitting would put two legs on one strike');
  const moves = [];
  out.forEach((l, i) => { if (Math.abs(l.strike - legs[i].strike) > EPS) moves.push({ idx: i, label: l.label, from: legs[i].strike, to: l.strike }); });
  return { legs: out, changed: moves.length > 0, moves, equalWings, skipped: null };
}

/** Legs whose strike is not listed for their right — for a warning on hand edits. */
export function unlistedLegs(legs, listed) {
  const L = normListed(listed);
  if (!L || !Array.isArray(legs) || !chainCovers(legs, L).ok) return [];
  return legs.filter(l => { const list = L[rightOf(l)]; return list && list.length && !has(list, l.strike); });
}

/** Iron condor / fly with wings of different widths — TWS books it as a custom combo. */
export function unequalWings(legs) {
  const ix = Array.isArray(legs) ? ironShape(legs) : null;
  if (!ix) return null;
  const pw = legs[ix.sp].strike - legs[ix.lp].strike, cw = legs[ix.lc].strike - legs[ix.sc].strike;
  return Math.abs(pw - cw) > EPS ? { put: pw, call: cw } : null;
}
