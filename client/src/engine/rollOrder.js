// ── The roll as one order (Oct 2026) ──
//
// The Roll tab recorded a roll after the fact: two prices typed in. This builds the
// order itself from the legs that move — buy back / sell back each moved leg, open
// its replacement — prices it from live quotes (mid and natural, and the split
// between the close and the open half), and writes it out leg by leg so it can be
// entered in TWS as one combo. Pure: the panel fetches the legs and quotes.

/**
 * @param oldLegs    the position per lot: [{ strike, right, qty (signed, + long), expiry }]
 * @param oldStrikes the ticket's strikes, in the order the Roll tab lists them
 * @param newStrikes the edited strikes, same order
 * @param newExpiry  'YYYYMMDD' to roll out in time, '' to keep each leg's expiry
 * @param lots       contracts rolled
 * @returns { legs: [{ action, role, strike, right, expiry, qty, from? }], moved, carried, all }
 *   action BUY/SELL; role 'close' (an existing leg out) or 'open' (its replacement)
 */
export function buildRollOrder({ oldLegs, oldStrikes, newStrikes, newExpiry = '', lots = 1 }) {
  const legs = [], moved = [], carried = [];
  const exp = String(newExpiry || '').replace(/-/g, '');
  (oldStrikes || []).forEach((k, i) => {
    const nk = Number(newStrikes[i]);
    const at = (oldLegs || []).filter(l => Number(l.strike) === Number(k));
    if (!at.length || !Number.isFinite(nk)) return;
    // A strike can carry two legs (an iron fly's body); each moves with it.
    at.forEach(l => {
      const toExp = exp || String(l.expiry);
      const moves = nk !== Number(k) || toExp !== String(l.expiry);
      if (!moves) { carried.push({ ...l }); return; }
      moved.push(i);
      const n = Math.abs(l.qty) * lots;
      legs.push({ role: 'close', action: l.qty < 0 ? 'BUY' : 'SELL', strike: Number(k), right: l.right, expiry: String(l.expiry), qty: n });
      legs.push({ role: 'open', action: l.qty < 0 ? 'SELL' : 'BUY', strike: nk, right: l.right, expiry: toExp, qty: n, from: Number(k) });
    });
  });
  // Closes first, then the new legs: how the order reads in TWS.
  const ordered = [...legs.filter(l => l.role === 'close'), ...legs.filter(l => l.role === 'open')];
  return { legs: ordered, moved: [...new Set(moved)], carried, all: carried.length === 0 && legs.length > 0 };
}

const midOf = q => (q && q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : q && q.optPrice > 0 ? q.optPrice : null);

/**
 * Price the order per share, + = a credit to you. quotes[i] = { bid, ask, optPrice } for legs[i].
 *   mid      every leg at its mid
 *   natural  buys at the ask, sells at the bid — what crossing the spread costs
 *   closeMid / openMid  the two halves at mid, + = credit (closing a short is a debit)
 */
export function priceRollOrder(legs, quotes, lots) {
  let mid = 0, nat = 0, closeMid = 0, openMid = 0, complete = legs.length > 0;
  // Per lot of the position rolled (a BWB body moves 2 contracts per lot).
  const unit = lots > 0 ? lots : legs.length ? unitQty(legs) : 1;
  legs.forEach((l, i) => {
    const q = quotes && quotes[i];
    const m = midOf(q);
    if (m == null) { complete = false; return; }
    const w = (l.action === 'SELL' ? 1 : -1) * l.qty / unit;          // ratio per combo, signed
    mid += w * m;
    nat += w * (l.action === 'SELL' ? (q.bid > 0 ? q.bid : m) : (q.ask > 0 ? q.ask : m));
    if (l.role === 'close') closeMid += w * m; else openMid += w * m;
  });
  const r2 = x => Math.round(x * 100) / 100;
  return { mid: r2(mid), natural: r2(nat), closeMid: r2(closeMid), openMid: r2(openMid), complete, spread: r2(mid - nat) };
}

// Contracts per combo: the smallest leg size, so a 5-lot roll prices per one combo.
function unitQty(legs) { return Math.min(...legs.map(l => l.qty)); }

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const fmtExp = y => `${y.slice(6, 8)} ${MON[+y.slice(4, 6) - 1]} ${y.slice(2, 4)}`;

/**
 * The legs as TWS takes them: one line per contract. A roll can close and open the
 * same contract — moving a long 765 down onto a short 755 buys back the short and buys
 * the new long at 755 — and TWS rejects a combo with the same contract twice, so those
 * merge into one leg (BUY 10 755C), and a close and open that cancel drop out.
 */
export function netRollLegs(legs) {
  const by = new Map();
  for (const l of legs || []) {
    const k = `${l.expiry}|${l.strike}|${l.right}`;
    const s = (l.action === 'BUY' ? 1 : -1) * l.qty;
    const cur = by.get(k);
    if (cur) { cur.signed += s; cur.roles.add(l.role); } else by.set(k, { ...l, signed: s, roles: new Set([l.role]) });
  }
  return [...by.values()].filter(l => l.signed !== 0).map(({ signed, roles, ...l }) => ({
    ...l, action: signed > 0 ? 'BUY' : 'SELL', qty: Math.abs(signed),
    role: roles.size > 1 ? 'both' : l.role, merged: roles.size > 1 || undefined }));
}

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** The order written out, to enter as one TWS combo. */
export function rollOrderText({ underlying, legs, price, limit, lots }) {
  const net = netRollLegs(legs);
  const g = net.reduce((a, l) => gcd(a, l.qty), 0) || 1;
  const ratio = net.map(l => l.qty / g);
  // TWS prices one combo (the ratio); the limit here is per lot rolled — the same
  // unless a leg moves more than one contract per lot.
  const perCombo = limit == null ? null : limit * (lots || g) / g;
  const lines = [`${underlying} ROLL — ${g} combo${g === 1 ? '' : 's'} (one order in TWS)`];
  net.forEach(l => lines.push(`  ${l.action.padEnd(4)} ${String(l.qty).padStart(3)}  ${underlying} ${fmtExp(l.expiry)} ${l.strike} ${l.right === 'C' ? 'CALL' : 'PUT '}  (${l.role === 'close' ? 'to close' : l.role === 'open' ? 'to open' : 'close + open, same contract'})`));
  if (ratio.some(r => r !== 1)) lines.push(`  Combo ratio ${ratio.join(':')} × ${g}`);
  if (perCombo != null) {
    const credit = perCombo >= 0, x = Math.abs(perCombo).toFixed(2);
    const k = (lots || g) / g;
    const sc = v => (v * k).toFixed(2);
    lines.push(`  Limit: ${x} ${credit ? 'CREDIT' : 'DEBIT'} per combo${price ? `  (mid ${sc(price.mid)}, natural ${sc(price.natural)})` : ''}`);
    lines.push(`  In TWS: ${credit ? `SELL the combo @ ${x} (or BUY @ −${x})` : `BUY the combo @ ${x}`} · DAY`);
  }
  return lines.join('\n');
}
