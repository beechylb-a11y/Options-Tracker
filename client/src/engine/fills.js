// Working orders, entry fills, and what the fill actually cost you.
//
// WHY THIS EXISTS. A logged trade used to be assumed filled. A 45DTE four-leg order
// rests — the QQQ 695/705/805/815 condor of 7 Oct sat at a mid limit all day and
// never filled — and with size it arrives in pieces at different prices. So three
// things were unrecordable: whether an order filled at all, how the price you got
// compared with the price you asked for, and how much risk you were committed to
// but not yet carrying.
//
// Pure on purpose: every number here is arithmetic over rows, so it can be checked
// without a database, a bridge, or TWS. (Oct 2026.)

// Prices are signed the way the ticket signs them: negative is a debit paid,
// positive a credit received. Slippage is therefore always "worse = less money to
// you", whichever side of the trade you are on, and one comparison works for both.
const num = v => {
  const n = parseFloat(String(v ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// ── Status ────────────────────────────────────────────────────────────────
// The old vocabulary had three words for five states, and `Partial` meant
// part-CLOSED, which left nothing to call a part-FILLED order. Both now have a
// name, and the entry side is read first because a position cannot be part-closed
// before it is filled.
export const STATUS = {
  WORKING: 'Working',          // order sent, nothing filled
  PART_FILLED: 'Part filled',  // some contracts in, more still resting
  OPEN: 'Open',                // fully filled, nothing closed
  PART_CLOSED: 'Part closed',  // was Partial
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',      // withdrawn without filling — a decision, not a trade
};

export function statusOf({ qty, qtyFilled, qtyClosed, cancelled }) {
  const q = num(qty) || 0, f = num(qtyFilled) || 0, c = num(qtyClosed) || 0;
  if (cancelled && f <= 0) return STATUS.CANCELLED;
  if (f <= 0) return STATUS.WORKING;
  if (c <= 0) return f < q ? STATUS.PART_FILLED : STATUS.OPEN;
  if (c >= f) return f < q ? STATUS.PART_FILLED : STATUS.CLOSED;
  return STATUS.PART_CLOSED;
}

// ── Fill quality ──────────────────────────────────────────────────────────
// Three questions, deliberately separated because they have different answers:
//   vs limit — did you get what you asked for? Usually yes; a limit order fills at
//              its limit or better, so this is mostly a check that the record is
//              sane, and a negative number here means price improvement.
//   vs mid   — did you pay away the spread? This is the one that compounds. The
//              limit is a choice; the mid is the market.
//   spreads  — the same gap in units of the spread, which is the only scale on
//              which 0.04 on a condor and 0.04 on a fly mean the same thing.
export function fillQuality(fill) {
  const got = num(fill.fillPrice);
  if (got == null) return null;
  const limit = num(fill.limitPrice);
  const mid = num(fill.midAtSend);
  const spread = num(fill.spreadAtSend);
  const qty = num(fill.qtyFilled) || 1;

  // Worse always means less money to you. With signed prices that is simply
  // (what you asked) − (what you got) for a credit, and the same expression for a
  // debit because both are signed: paying 1.11 is −1.11, so asking −1.00 and
  // getting −1.11 gives +0.11 of slippage. One formula, both sides.
  const vsLimit = limit == null ? null : +(limit - got).toFixed(4);
  const vsMid = mid == null ? null : +(mid - got).toFixed(4);
  return {
    fillPrice: got, limitPrice: limit, midAtSend: mid,
    vsLimit, vsMid,
    // Dollars across the contracts that actually filled — the number that lands in
    // the account, not a per-share abstraction.
    vsMidDollars: vsMid == null ? null : +(vsMid * 100 * qty).toFixed(2),
    inSpreads: (vsMid == null || !spread || spread <= 0) ? null
      : +(vsMid / spread).toFixed(2),
    improved: vsLimit != null && vsLimit < -0.0001,
  };
}

// Roll a ticket's fills into one entry. Quantity-weighted, because two contracts at
// 0.60 and three at 0.70 is 0.66, not 0.65 — the same mistake the exit blend was
// written to avoid.
export function blendFills(fills) {
  const rows = (fills || []).filter(f => num(f.qtyFilled) > 0 && num(f.fillPrice) != null);
  if (!rows.length) return null;
  const qty = rows.reduce((a, f) => a + num(f.qtyFilled), 0);
  const notional = rows.reduce((a, f) => a + num(f.qtyFilled) * num(f.fillPrice), 0);
  const fees = rows.reduce((a, f) => a + (num(f.feesUsd) || 0), 0);
  // Weighted over the same contracts, so a ticket where only some fills recorded a
  // mid is not silently compared against a different denominator.
  const withMid = rows.filter(f => num(f.midAtSend) != null);
  const midQty = withMid.reduce((a, f) => a + num(f.qtyFilled), 0);
  const midNotional = withMid.reduce((a, f) => a + num(f.qtyFilled) * num(f.midAtSend), 0);
  const avgPrice = +(notional / qty).toFixed(4);
  const avgMid = midQty > 0 ? +(midNotional / midQty).toFixed(4) : null;
  return {
    qtyFilled: qty,
    avgPrice,
    avgMid,
    fees: +fees.toFixed(2),
    tranches: rows.length,
    slippageVsMid: avgMid == null ? null : +(avgMid - avgPrice).toFixed(4),
    slippageDollars: avgMid == null ? null : +((avgMid - avgPrice) * 100 * qty).toFixed(2),
    firstFill: rows.map(f => String(f.fillDate || '')).filter(Boolean).sort()[0] || '',
    lastFill: rows.map(f => String(f.fillDate || '')).filter(Boolean).sort().pop() || '',
  };
}

// ── Exposure ──────────────────────────────────────────────────────────────
// Working risk is counted in FULL against the cap, and reported separately.
// A resting order can fill at any moment, so treating it as weightless is how you
// get filled into a breach you never chose; but folding it into one number would
// hide the difference between money at risk and money committed. Both, side by
// side, and the cap tested against the sum. (Oct 2026.)
export function exposure(positions, { maxOpenRisk } = {}) {
  const rows = positions || [];
  let live = 0, working = 0, workingCount = 0;
  for (const p of rows) {
    const qty = num(p.qty) || 0;
    const risk = num(p.maxRisk) || 0;
    if (qty <= 0 || risk <= 0) continue;
    const perContract = risk / qty;
    const filled = num(p.qtyFilled);
    // A ticket with no fill record at all is legacy: it was logged as done, so its
    // open quantity is filled quantity. Treating it as working would invent a
    // commitment that was never made.
    const f = filled == null ? (num(p.qtyOpen) || 0) : filled;
    const open = Math.max(0, (num(p.qtyOpen) != null ? num(p.qtyOpen) : f));
    const resting = Math.max(0, qty - f);
    live += perContract * Math.min(open, f);
    if (resting > 0) { working += perContract * resting; workingCount++; }
  }
  const cap = num(maxOpenRisk);
  const committed = live + working;
  return {
    live: +live.toFixed(2),
    working: +working.toFixed(2),
    committed: +committed.toFixed(2),
    workingCount,
    cap: cap || null,
    // Three separate verdicts, because "you are over" and "you would be over if
    // everything fills" are different sentences and only one of them is urgent.
    overNow: cap ? live > cap : false,
    overIfFilled: cap ? committed > cap : false,
    headroom: cap ? +(cap - committed).toFixed(2) : null,
  };
}

// Fill-rate history: of the orders that were worked, how many filled, and what the
// slippage looked like. The number that tells you whether resting at mid is a
// strategy or a habit.
export function fillStats(tickets) {
  const rows = (tickets || []).filter(t => t && (num(t.qty) || 0) > 0);
  if (!rows.length) return null;
  const worked = rows.filter(t => t.limitPrice != null && t.limitPrice !== '');
  const filled = rows.filter(t => (num(t.qtyFilled) || 0) > 0);
  const full = rows.filter(t => (num(t.qtyFilled) || 0) >= (num(t.qty) || 0));
  const slips = rows.map(t => num(t.slippageVsMid)).filter(Number.isFinite);
  const mean = slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null;
  return {
    tickets: rows.length,
    worked: worked.length,
    filled: filled.length,
    fullyFilled: full.length,
    fillRate: rows.length ? +(100 * filled.length / rows.length).toFixed(1) : null,
    fullFillRate: rows.length ? +(100 * full.length / rows.length).toFixed(1) : null,
    avgSlippage: mean == null ? null : +mean.toFixed(4),
    // Dollars given up to the spread across everything measured — the cost of the
    // entry habit, which is otherwise invisible because it never appears as a loss.
    totalSlippageDollars: +rows.reduce((a, t) => a + (num(t.slippageDollars) || 0), 0).toFixed(2),
  };
}
