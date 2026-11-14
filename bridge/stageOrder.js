// ── Stage an entry + profit target in TWS, untransmitted (Nov 2026) ──
//
// The exit plan's "Stage in TWS" button. The bridge builds the trade as ONE combo
// (BAG) order with the profit target(s) attached as child orders, and places them with
// transmit = false: they land in TWS's order window, filled in, and nothing reaches the
// exchange until the trader checks them and clicks Transmit in TWS.
//
// Deliberately NOT staged: a stop. The trader manages the loss by hand (decision,
// 14 Nov 2026); the stop on the exit plan is a reference level for the check-up only.
//
// Pure: no IB connection here, so the order shapes can be tested. index.js resolves the
// legs' conIds and places what this returns.
//
// Sign convention: the orders read the way the exit-plan card and TWS's own ticket read
// them, prices always positive. A credit trade is a SELL of the combo at the credit
// (SELL 4 @ 0.66) and its profit target a BUY back (BUY 4 @ 0.50); a debit trade BUYs at
// the debit and SELLs at the target. IB reverses every leg when a combo is SOLD, so for a
// credit trade the combo is defined with each leg's side flipped: selling it opens
// exactly the ticket's legs.

export const STAGE_MAX_LOTS = 50;

const round2 = x => Math.round(x * 100) / 100;

/**
 * @param p.underlying  'SPX' | 'QQQ' | …
 * @param p.legs        [{ strike, right: 'C'|'P', qty (signed, per lot), expiry 'yyyymmdd' }]
 * @param p.lots        contracts of the combo
 * @param p.side        'credit' | 'debit'
 * @param p.entry       price per share, positive (0.66)
 * @param p.targets     [{ qty, price }] — price per share, positive (0.50 to buy back a credit)
 * @param p.tif         'DAY' | 'GTC' for the targets (0DTE → DAY)
 * @param p.account     IB account code (optional: TWS uses its default)
 * @param p.orderRef    tag carried on every order so the fills map back to the ticket
 * @returns { error } | { comboLegs, parent, children, summary }
 *          comboLegs carry `legKey` for index.js to swap in the conId.
 */
export function buildStage(p) {
  const legs = Array.isArray(p && p.legs) ? p.legs : [];
  if (legs.length < 2 || legs.length > 4) return { error: 'Staging takes a 2–4 leg combo' };
  const lots = Math.round(Number(p.lots));
  if (!(lots >= 1) || lots > STAGE_MAX_LOTS) return { error: `Contracts must be 1–${STAGE_MAX_LOTS}` };
  const side = p.side === 'debit' ? 'debit' : p.side === 'credit' ? 'credit' : null;
  if (!side) return { error: 'Say whether the entry is a credit or a debit' };
  const entry = Number(p.entry);
  if (!(entry > 0)) return { error: 'No entry price' };
  for (const l of legs) {
    if (!(Number(l.strike) > 0) || !/^[CP]$/.test(String(l.right || '').toUpperCase()) || !(Number(l.qty)) || !/^\d{8}$/.test(String(l.expiry || ''))) {
      return { error: 'A leg is missing its strike, right, quantity or expiry' };
    }
  }
  // Per-lot ratios must be whole numbers; IB wants each leg's ratio, not the total.
  const ratios = legs.map(l => Math.abs(Number(l.qty)));
  if (ratios.some(r => !Number.isInteger(r))) return { error: 'Leg ratios must be whole numbers per contract' };

  const targets = (Array.isArray(p.targets) ? p.targets : [])
    .map(t => ({ qty: Math.round(Number(t.qty)), price: Number(t.price) }))
    .filter(t => t.qty > 0 && t.price >= 0);
  const tq = targets.reduce((a, t) => a + t.qty, 0);
  if (tq > lots) return { error: `Targets add up to ${tq} contracts, more than the ${lots} entered` };
  if (side === 'credit' && targets.some(t => t.price >= entry)) return { error: 'A credit trade’s profit target must cost less than the credit taken in' };
  if (side === 'debit' && targets.some(t => t.price <= entry)) return { error: 'A debit trade’s profit target must sell for more than it cost' };

  const credit = side === 'credit';
  const common = {
    orderType: 'LMT',
    transmit: false,                          // ALWAYS — the trader transmits in TWS
    outsideRth: false,
    ...(p.account ? { account: String(p.account) } : {}),
    ...(p.orderRef ? { orderRef: String(p.orderRef).slice(0, 40) } : {}),
  };
  const parent = { ...common, action: credit ? 'SELL' : 'BUY', totalQuantity: lots, lmtPrice: round2(entry), tif: 'DAY' };
  const children = targets.map(t => ({ ...common, action: credit ? 'BUY' : 'SELL', totalQuantity: t.qty, lmtPrice: round2(t.price), tif: p.tif === 'GTC' ? 'GTC' : 'DAY' }));
  const comboLegs = legs.map(l => ({
    legKey: `${String(l.expiry)}|${Number(l.strike)}|${String(l.right).toUpperCase()[0]}`,
    ratio: Math.abs(Number(l.qty)),
    action: (credit ? -1 : 1) * Number(l.qty) > 0 ? 'BUY' : 'SELL',   // flipped for a credit (sold combo)
    exchange: 'SMART',
  }));
  const ks = legs.map(l => Number(l.strike)).join('/');
  const summary = [
    `${credit ? 'SELL' : 'BUY'} ${lots} ${String(p.underlying || '').toUpperCase()} ${ks} @ ${entry.toFixed(2)} ${side === 'credit' ? 'cr' : 'db'}`,
    ...targets.map(t => `${credit ? 'BUY' : 'SELL'} ${t.qty} @ ${t.price.toFixed(2)} (profit target)`),
  ];
  return { comboLegs, parent, children, summary };
}
