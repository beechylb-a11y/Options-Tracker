// Stop, entry and target for an open position, in $ for the contracts open.
// Shared by the Open positions table and the Dashboard board so both quote the same
// numbers — and the 45DTE check-up reads the same exit plan (Checkup45.exitPlanOf).
import { normalisePosition, stopToPrice, targetToPrice, pnlAt, loadPlan, withEntryFill } from './ticketMath';
import { exitRuleFor, STOP_LOSS_PCT } from '../engine/data';

// Stop line for an open position: the plan saved at entry, else the 100% guide.
// What was actually got: the fills' average entry when fills are recorded, else the
// ticket's entry (Oct 2026 — the row showed the asked 5.81 after a 2.50 fill). Rows
// are converted once on load, so the Sell/Roll ticket, the stop, live risk and the
// exposure all read the fill too (withEntryFill also restates max profit / risk).
const gotEntry = withEntryFill;
export function stopOf(r0) {
  const r = gotEntry(r0);
  const pos = normalisePosition(r);
  if (!(Math.abs(pos.ncd || 0) > 0)) return null;
  const plan = r.timestamp ? loadPlan(r.timestamp) : null;
  const pct = plan && plan.stopPct !== '' && plan.stopPct != null ? Math.abs(parseFloat(plan.stopPct)) : STOP_LOSS_PCT;
  if (!isFinite(pct) || pct <= 0) return null;
  const price = stopToPrice(pos, pct);
  // Contracts the stop applies to: what is open, or — for an order still resting —
  // everything that will be open once it fills. (Was qtyOpen || 1: a working 5-lot
  // showed the loss on one contract.)
  const qtyOpen = Number(pos.qtyOpen) || 0, qtyAll = Number(pos.qty) || Number(r.qty) || 1;
  const qty = qtyOpen > 0 ? qtyOpen : qtyAll;
  return { pct, price, isCredit: pos.isCredit, side: pos.isCredit ? 'db' : 'cr', qty, ifFilled: !(qtyOpen > 0),
    loss: pnlAt(pos, price, qty), guide: !plan || plan.stopPct === '' || plan.stopPct == null };
}

// What you got (or asked for): "cr 5.81" / "db 1.07"; a resting order shows its limit.
export function entryOf(r) {
  const filled = !!gotEntry(r)._entryFromFills;
  const pos = normalisePosition(gotEntry(r));
  const e = Math.abs(pos.ncd || 0);
  if (!(e > 0)) return null;
  const asked = parseFloat(r.limitPrice);
  return { side: pos.isCredit ? 'cr' : 'db', price: e, filled, asked: filled && Number.isFinite(asked) ? Math.abs(asked) : null };
}

// Profit target for the contracts open (or, for a resting order, all of them once
// filled): the exit plan saved at entry, else the strategy's rule. Credit: buy back
// at the price; debit: sell at it. (Oct 2026.)
export function targetOf(r0) {
  const r = gotEntry(r0);
  const pos = normalisePosition(r);
  if (!(Math.abs(pos.ncd || 0) > 0)) return null;
  const qtyOpen = Number(pos.qtyOpen) || 0;
  const qty = qtyOpen > 0 ? qtyOpen : (Number(pos.qty) || 1);
  const plan = r.timestamp ? loadPlan(r.timestamp) : null;
  const rows = plan && Array.isArray(plan.rows) ? plan.rows.filter(x => Number(x.qty) > 0 && Number(x.pct) > 0) : [];
  if (rows.length) {
    const legs = rows.map(x => { const price = targetToPrice(pos, Number(x.pct)); return { pct: Number(x.pct), qty: Number(x.qty), price, gain: pnlAt(pos, price, Number(x.qty)) }; });
    return { side: pos.isCredit ? 'buy back' : 'sell', price: legs[0].price, last: legs[legs.length - 1].price,
      gain: legs.reduce((a, x) => a + x.gain, 0), legs, plan: true, basis: pos.basis };
  }
  const rule = exitRuleFor(pos.engine || r.engine, pos.strategy);
  if (!rule || !(rule.target > 0)) return null;
  const price = targetToPrice(pos, rule.target);
  if (!(price >= 0)) return null;
  return { side: pos.isCredit ? 'buy back' : 'sell', price, last: price, gain: pnlAt(pos, price, qty),
    legs: [{ pct: rule.target, qty, price }], plan: false, basis: pos.basis };
}


// Risk still live: the open contracts' max loss, with entry and max loss restated from
// the fills where they are recorded. One function, so the table header, the Dashboard
// tile and the board cannot read three different numbers. (Oct 2026.)
export function liveRiskOf(r0) {
  const r = withEntryFill(r0);
  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  return n(r.qty) > 0 ? n(r.maxRisk) * (n(r.qtyOpen) / n(r.qty)) : 0;
}
export const liveRiskTotal = rows => (rows || []).reduce((a, r) => a + liveRiskOf(r), 0);
