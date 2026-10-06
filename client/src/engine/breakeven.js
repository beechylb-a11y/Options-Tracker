// ================================================================
//  BREAK-EVEN FILL — the entry price at which EV = 0 (Oct 2026)
//  Pure. The panel supplies evAt(net): EV ($/contract) for a per-share net
//  (+ credit / − debit), which rises as the fill improves (more credit, less
//  debit). Bisection finds where it crosses zero.
// ================================================================

// lo/hi: the feasible net range (per share). Returns
//   { status: 'ok',   net }   EV = 0 at net (pay ≤ |net| debit / receive ≥ net credit)
//   { status: 'none' }        EV < 0 even at the best feasible price
//   { status: 'any', net: lo } EV ≥ 0 even at the worst price in range
export function solveBreakevenNet(evAt, lo, hi, iters = 28) {
  if (!(hi > lo)) return { status: 'none' };
  const eLo = evAt(lo), eHi = evAt(hi);
  if (!isFinite(eLo) || !isFinite(eHi)) return { status: 'none' };
  if (eHi < 0) return { status: 'none', evBest: eHi };
  if (eLo >= 0) return { status: 'any', net: lo };
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (evAt(m) >= 0) b = m; else a = m;
  }
  return { status: 'ok', net: b };
}

// Win and risk ($/contract) of a single-expiry structure at a given net: its
// expiry payoff is intrinsic + net, so both shift one-for-one with the fill.
// mp0/ml0 = max / min of the intrinsic payoff ($/contract, net 0).
export function winRiskAtNet(mp0, ml0, net) {
  return { win: mp0 + net * 100, risk: -(ml0 + net * 100) };
}
