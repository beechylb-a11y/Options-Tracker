// Two things the 45DTE check-up could say and did not: where the position actually
// sits, and what the roll it suggests would cost.
//
// WHY THIS EXISTS. The card named four strikes and told you to move the untested
// side "to roughly 25–30Δ". Both halves left work for the reader. The strikes do not
// say where price is among them, and a roll described only as "for extra credit"
// reads as free money — it is not. Rolling the quiet side in buys cushion on the
// side under pressure and pays for it with room on the side that was winning.
//
// Everything here is pure arithmetic over legs, so the geometry and the trade-off
// can be checked without a bridge, a chain or a quote. (Oct 2026.)

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

/** Expiry value of a leg set, per share. qty is signed. */
export function valueAt(legs, S) {
  return (legs || []).reduce((a, l) => a + l.qty *
    Math.max(0, l.right === 'P' ? l.strike - S : S - l.strike), 0);
}

/**
 * Where the structure makes and loses money at expiry.
 *
 * `ncd` is the net per share, signed the way the ticket signs it: + credit received,
 * − debit paid. Break-evens are found by walking the payoff between and beyond the
 * strikes rather than by a per-strategy formula, so a condor, a fly, a broken wing
 * and a vertical all come out of the same code.
 */
export function payoffShape(legs, ncd) {
  const ks = [...new Set((legs || []).map(l => num(l.strike)).filter(k => k != null))].sort((a, b) => a - b);
  if (!ks.length || num(ncd) == null) return null;
  const pnl = S => valueAt(legs, S) + num(ncd);
  const span = Math.max(ks[ks.length - 1] - ks[0], 1);
  // Beyond the outer strikes the payoff is flat for any defined-risk structure, so a
  // single span either side is enough to catch every crossing.
  const lo = ks[0] - span, hi = ks[ks.length - 1] + span;
  const pts = [];
  const N = 400;
  for (let i = 0; i <= N; i++) pts.push(lo + (hi - lo) * i / N);
  const be = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pnl(pts[i - 1]), b = pnl(pts[i]);
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) {
      // Linear between samples — the payoff is piecewise linear, so this is exact
      // wherever the segment holds no strike, and within a sample step where it does.
      be.push(+(pts[i - 1] + (pts[i] - pts[i - 1]) * (0 - a) / (b - a)).toFixed(2));
    }
  }
  const vals = pts.map(pnl);
  return {
    strikes: ks,
    breakevens: be,
    maxProfit: +Math.max(...vals).toFixed(4),
    maxLoss: +Math.min(...vals).toFixed(4),
    pnlAt: pnl,
  };
}

/**
 * The strip the card draws: one axis, the strikes on it, price where it is, and the
 * band between the break-evens. Returns positions as 0..1 fractions so the component
 * does nothing but multiply by its width.
 */
export function positionStrip({ legs, spot, ncd, testedStrike = null }) {
  const shape = payoffShape(legs, ncd);
  const s = num(spot);
  if (!shape || s == null) return null;
  const ks = shape.strikes;
  const be = shape.breakevens;
  // Pad so neither the price marker nor a break-even can sit on the edge.
  const all = [...ks, ...be, s];
  const lo0 = Math.min(...all), hi0 = Math.max(...all);
  const pad = Math.max((hi0 - lo0) * 0.08, 0.5);
  const lo = lo0 - pad, hi = hi0 + pad;
  const at = v => (v - lo) / (hi - lo);
  const inProfit = shape.pnlAt(s) > 0;
  return {
    lo, hi, at,
    spot: { value: s, x: at(s), inProfit },
    strikes: (legs || []).map(l => ({
      strike: l.strike, right: l.right, short: l.qty < 0, qty: l.qty,
      x: at(l.strike),
      tested: testedStrike != null && Math.abs(l.strike - testedStrike) < 1e-9,
    })).sort((a, b) => a.strike - b.strike),
    // The band only means anything with two crossings; a one-sided structure gets
    // whichever it has and the component draws to the edge.
    zone: be.length >= 2 ? { from: be[0], to: be[be.length - 1], x0: at(be[0]), x1: at(be[be.length - 1]) } : null,
    breakevens: be.map(b => ({ value: b, x: at(b) })),
    maxProfit: shape.maxProfit,
    maxLoss: shape.maxLoss,
  };
}

// ── Rolling the untested side ────────────────────────────────────────────────

/** Strikes worth quoting for a roll: listed, on the right side of spot, near the money. */
export function rollCandidates({ listed, spot, right, keepWidth, oldShort }) {
  const s = num(spot);
  const ks = (listed || []).map(num).filter(k => k != null).sort((a, b) => a - b);
  if (s == null || !ks.length) return [];
  // A roll moves the short TOWARD price, never away, and never through it.
  const side = right === 'C'
    ? ks.filter(k => k > s && (oldShort == null || k < oldShort))
    : ks.filter(k => k < s && (oldShort == null || k > oldShort));
  // The wing has to exist too, or the pair cannot be built.
  const has = new Set(ks);
  const ok = side.filter(k => has.has(right === 'C' ? k + keepWidth : k - keepWidth));
  // Nearest the money first — the 25–30Δ strike is usually within a handful.
  return ok.sort((a, b) => Math.abs(a - s) - Math.abs(b - s)).slice(0, 10).sort((a, b) => a - b);
}

/**
 * Pick the roll from quoted candidates and say what it costs.
 *
 * `quoted` is [{ strike, right, delta, bid, ask }] for the candidate shorts AND their
 * wings. The short is the listed strike whose delta is nearest `targetDelta`; the
 * long is one `keepWidth` further out, so the width you are used to is preserved.
 */
export function planRoll({ quoted, targetDelta = 0.275, keepWidth, right, spot, ncd,
                           oldShort, oldLong, testedShort, closeOld = null }) {
  const q = (quoted || []).filter(x => x && num(x.delta) != null && x.right === right);
  if (!q.length || !(keepWidth > 0)) return null;
  const mid = x => (num(x.bid) != null && num(x.ask) != null) ? (num(x.bid) + num(x.ask)) / 2 : num(x.optPrice);
  const byStrike = new Map(q.map(x => [+x.strike, x]));
  let best = null;
  for (const x of q) {
    const wing = byStrike.get(right === 'C' ? +x.strike + keepWidth : +x.strike - keepWidth);
    if (!wing) continue;
    const d = Math.abs(Math.abs(num(x.delta)) - targetDelta);
    if (!best || d < best.d) best = { d, short: x, long: wing };
  }
  if (!best) return null;
  const sMid = mid(best.short), lMid = mid(best.long);
  if (sMid == null || lMid == null) return null;
  const newCredit = +(sMid - lMid).toFixed(2);          // sell the short, buy the wing
  const cost = num(closeOld);                            // what it costs to buy back the old pair
  const net = cost != null ? +(newCredit - cost).toFixed(2) : newCredit;

  // The trade-off, in points of the underlying. Credit widens BOTH break-evens
  // outward from their shorts; moving the short itself is what gives the room up.
  const c0 = num(ncd) || 0;
  const c1 = c0 + net;
  const beOf = (k, r, c) => r === 'P' ? k - c : k + c;
  const testedK = num(testedShort);
  const cushionGained = testedK != null
    ? +Math.abs(beOf(testedK, right === 'C' ? 'P' : 'C', c1) - beOf(testedK, right === 'C' ? 'P' : 'C', c0)).toFixed(2)
    : null;
  const beforeRoom = oldShort != null ? beOf(num(oldShort), right, c0) : null;
  const afterRoom = beOf(+best.short.strike, right, c1);
  const roomGiven = beforeRoom != null ? +Math.abs(beforeRoom - afterRoom).toFixed(2) : null;

  return {
    right,
    shortStrike: +best.short.strike,
    longStrike: +best.long.strike,
    delta: +Math.abs(num(best.short.delta)).toFixed(3),
    newCredit, closeCost: cost, net,
    creditTotalBefore: +c0.toFixed(2), creditTotalAfter: +c1.toFixed(2),
    breakevenBefore: beforeRoom, breakevenAfter: +afterRoom.toFixed(2),
    cushionGained, roomGiven,
    // The honest headline. A roll that gives up more room than it buys cushion is
    // still often right — it is a trade, not a free credit — but nobody should have
    // to work that out from four strikes and a delta.
    worthIt: (cushionGained != null && roomGiven != null) ? cushionGained >= roomGiven : null,
    distanceToNewShort: spot != null ? +Math.abs(+best.short.strike - num(spot)).toFixed(2) : null,
  };
}
