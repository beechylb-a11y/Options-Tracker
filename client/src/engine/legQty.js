// ── Contracts per unit on one engine leg (Oct 2026) ──
// Engine legs are { label, strike } and the quantity has always been read off the
// label: "Short call x2" is two contracts. Every reader tested /x2\b/, so a leg
// could only ever be 1 or 2 — enough for flies, not for the 2:3 and 3:4 ratio
// spreads (R-54), whose legs are x2, x3 and x4.
//
// One reader for every place that needs it:
//   1. an explicit numeric `qty` on the leg wins (builders that know it set it);
//   2. otherwise "x<n>" as its own word in the label ("x3", "x2 (body)");
//   3. otherwise 1.
// "(1.5x upper)" and "(VIX1D)" do not match: the x must start a word and be
// followed by digits. "(body)" alone is ONE contract — an iron fly's two shorts
// are labelled "(body)" and are one contract each.
export function legQty(leg) {
  if (!leg) return 1;
  const q = Number(leg.qty);
  if (Number.isFinite(q) && q >= 1) return Math.round(q);
  const m = /(?:^|[^a-z0-9.])x(\d+)\b/i.exec(String(leg.label || ''));
  const n = m ? parseInt(m[1], 10) : 1;
  return n >= 1 ? n : 1;
}

/** Signed quantity: + long, − short (a label with "short" or "sell"). */
export function signedLegQty(leg) {
  const lb = String((leg && leg.label) || '').toLowerCase();
  return (/short|sell/.test(lb) ? -1 : 1) * legQty(leg);
}
