// Turn TWS executions into combo fills, and match them to the tickets that asked.
//
// WHY THIS EXISTS. The Fills table records what came back, but nothing was filling
// it in: typing five leg prices off a TWS screen into a per-contract net is exactly
// the arithmetic that goes wrong at 11pm. TWS already has the executions — one row
// per LEG per partial fill — so the work is grouping them back into the combo that
// was sent and signing the net the way the ticket signs it.
//
// Pure on purpose. Everything here is arithmetic over the bridge's /api/executions
// payload, so the matching can be tested without TWS, a bridge or a database.
// (Oct 2026.)

import { parseStrikes } from './positionMatch';

const num = v => { const n = parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };

// SPXW and SPX are the same underlying as far as a ticket is concerned.
const symOf = u => { const s = String(u || '').toUpperCase(); return s === 'SPXW' ? 'SPX' : s; };

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

// IB hands back "20261008 09:31:02", sometimes "20261008-09:31:02", sometimes with a
// timezone suffix. Split it rather than parse it: the date is the TWS session date
// already, and inventing a timezone conversion here would be a guess dressed up as
// a fact. Labelled as TWS-reported wherever it is shown.
export function execWhen(time) {
  const s = String(time || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})[\s\-T]*(\d{2}:\d{2}(?::\d{2})?)?/.exec(s);
  if (!m) return { date: '', time: '', key: s.replace(/\s+/g, '') };
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const clock = m[4] || '';
  return { date, time: clock, key: `${m[1]}${m[2]}${m[3]}${clock.replace(/:/g, '')}` };
}

// One tranche = the leg executions of a single combo fill. IB reports the legs of
// one partial fill under the same order id at the same second, so that pair is the
// grouping key. Two tranches of the same order stay separate rows, which is the
// whole point of the Fills table.
export function trancheOf(e) {
  const w = execWhen(e.time);
  return `${e.orderId || e.execId || '?'}@${w.key}`;
}

/**
 * Group leg executions into combo tranches.
 *
 * Sign convention matches the ticket: a leg BOUGHT is money out (negative), a leg
 * SOLD is money in (positive), so the net is negative for a debit and positive for
 * a credit — the same signing the Decisions row and the Fills table use.
 */
export function comboTranches(executions) {
  const byTranche = new Map();
  for (const e of executions || []) {
    if (e.secType && e.secType !== 'OPT') continue;
    const qty = Math.abs(num(e.qty) || 0);
    const price = num(e.price);
    if (!(qty > 0) || price == null) continue;
    const k = trancheOf(e);
    if (!byTranche.has(k)) byTranche.set(k, []);
    byTranche.get(k).push({ ...e, qty, price });
  }
  const out = [];
  for (const [key, legs] of byTranche) {
    const w = execWhen(legs[0].time);
    // Lots: the greatest common factor of the leg quantities. A 1/−2/+1 fly for two
    // lots arrives as 2/4/2 — a count of legs or a sum of quantities would read it
    // as four contracts and halve the net.
    const lots = legs.map(l => Math.round(l.qty)).reduce((a, b) => gcd(a, b), 0) || 1;
    const perLot = legs.reduce((a, l) =>
      a + (String(l.side).toUpperCase() === 'SLD' ? 1 : -1) * l.price * l.qty, 0) / lots;
    const strikes = [...new Set(legs.map(l => num(l.strike)).filter(s => s > 0))].sort((a, b) => a - b);
    out.push({
      key,
      orderId: legs[0].orderId ?? null,
      orderRef: legs[0].orderRef || '',
      account: legs[0].account || '',
      underlying: symOf(legs[0].symbol),
      date: w.date, time: w.time,
      lots,
      netPrice: +perLot.toFixed(4),
      fees: +legs.reduce((a, l) => a + (num(l.commission) || 0), 0).toFixed(2),
      strikes,
      // Kept so a mismatch can be shown rather than silently rounded away.
      legs: legs.map(l => ({
        strike: num(l.strike), right: l.right || '', expiry: String(l.expiry || '').slice(0, 8),
        side: String(l.side || '').toUpperCase(), qty: Math.round(l.qty), price: l.price,
      })).sort((a, b) => a.strike - b.strike),
      execIds: legs.map(l => l.execId).filter(Boolean),
    });
  }
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// The id the fill is written under. Built from the execution, not from the clock, so
// running reconcile twice over the same TWS day cannot double-count the entry — the
// second write is rejected by the Fills unique index.
export const fillIdFor = t => `TWS-${t.key}`;

/**
 * Match tranches to tickets.
 *
 * A ticket is matched on underlying plus strikes. `full` means every strike on the
 * ticket was in this tranche — the combo as sent. `partial` means some were, which
 * is either a legged-in entry or another ticket's order at overlapping strikes, and
 * is offered but never pre-ticked.
 *
 * @param tickets  [{ ticketRef, underlying, legs (strike string), qty, qtyFilled, limitPrice, ... }]
 * @param tranches comboTranches(...) output
 * @param seen     ids already in the Fills table, so a second run shows them as done
 */
export function matchTranches(tickets, tranches, seen = []) {
  const done = new Set(seen.map(String));
  const claimed = new Set();
  const rows = (tickets || []).map(t => {
    const ks = parseStrikes(t.legs ?? t.strikes);
    const want = new Set(ks);
    const cands = [];
    for (const tr of tranches) {
      if (symOf(tr.underlying) !== symOf(t.underlying)) continue;
      const hit = tr.strikes.filter(s => want.has(s));
      if (!hit.length) continue;
      const full = want.size > 0 && hit.length === want.size && tr.strikes.length === want.size;
      cands.push({
        ...tr,
        match: full ? 'full' : 'partial',
        recorded: done.has(fillIdFor(tr)),
        // Ask vs got, signed so worse is always less money to you.
        vsLimit: num(t.limitPrice) == null ? null : +(num(t.limitPrice) - tr.netPrice).toFixed(4),
        // More contracts than the ticket is still waiting on. Reported rather than
        // clamped: it means the lots were read wrong, or this fill belongs to a
        // different ticket, and both want a human rather than a round-down.
        overOutstanding: tr.lots > Math.max(0, (num(t.qty) || 0) - (num(t.qtyFilled) || 0)),
      });
    }
    // A full match wins over a partial one, and the earliest tranche first.
    cands.sort((a, b) => (a.match === b.match ? 0 : a.match === 'full' ? -1 : 1)
      || (a.date + a.time).localeCompare(b.date + b.time));
    cands.forEach(c => { if (c.match === 'full') claimed.add(c.key); });
    const filled = num(t.qtyFilled) || 0;
    return {
      ticket: t,
      outstanding: Math.max(0, (num(t.qty) || 0) - filled),
      candidates: cands,
    };
  });
  // Anything TWS reported that no ticket wanted. Shown, not hidden: an entry with no
  // ticket is either a trade logged nowhere or a close, and both are worth knowing.
  const unmatched = tranches.filter(tr =>
    !claimed.has(tr.key) && !rows.some(r => r.candidates.some(c => c.key === tr.key)));
  return { rows, unmatched };
}

/** The Fills row a confirmed tranche becomes. */
export function fillPayload(ticket, tr, { qty, price, notes } = {}) {
  const q = num(qty) != null ? num(qty) : tr.lots;
  const p = num(price) != null ? num(price) : tr.netPrice;
  return {
    fillId: fillIdFor(tr),
    ticketRef: ticket.ticketRef,
    ticketTimestamp: ticket.timestamp || '',
    engine: ticket.engine || '',
    underlying: ticket.underlying || '',
    strategy: ticket.strategy || '',
    fillDate: tr.date,
    fillTime: tr.time,
    qtyFilled: q,
    qtyOrdered: num(ticket.qty) || 0,
    fillPrice: p,
    limitPrice: ticket.limitPrice ?? '',
    midAtSend: ticket.midAtSend ?? '',
    feesUsd: tr.fees || '',
    orderRef: tr.orderRef || (tr.orderId != null ? String(tr.orderId) : ''),
    account: ticket.account || tr.account || '',
    notes: notes || (tr.match === 'partial' ? 'Partial strike match — confirmed by hand' : ''),
  };
}

// A fill typed by hand (Oct 2026): for an order that filled on a day the app never
// pulled TWS (the executions call only sees today's), or one filled away from TWS.
// Same row as a reconciled fill. The id is unique per entry, so it can never collide
// with a TWS fill id; the note says it was typed, so a review can tell the two apart.
// price is per contract and unsigned; side ('cr' | 'db') signs it like the ticket.
export function ticketSide(ticket) {
  const lim = num(ticket && ticket.limitPrice);
  const ent = num(ticket && (ticket.entryPrice ?? ticket.netCreditDebit));
  const v = lim != null && lim !== 0 ? lim : ent;
  return v != null && v < 0 ? 'db' : 'cr';
}
export function manualFillPayload(ticket, { qty, price, side, date, time, notes } = {}, now = Date.now()) {
  const q = num(qty), p = num(price);
  if (!(q > 0) || p == null || !(Math.abs(p) > 0)) return null;
  const sd = side === 'db' || side === 'cr' ? side : ticketSide(ticket);
  return {
    fillId: `MANUAL-${ticket.ticketRef}-${now}`,
    ticketRef: ticket.ticketRef,
    ticketTimestamp: ticket.timestamp || '',
    engine: ticket.engine || '',
    underlying: ticket.underlying || '',
    strategy: ticket.strategy || '',
    fillDate: date || '',
    fillTime: time || '',
    qtyFilled: q,
    qtyOrdered: num(ticket.qty) || 0,
    fillPrice: +(sd === 'db' ? -Math.abs(p) : Math.abs(p)).toFixed(4),
    limitPrice: ticket.limitPrice ?? '',
    midAtSend: ticket.midAtSend ?? '',
    feesUsd: '',
    orderRef: '',
    account: ticket.account || '',
    notes: notes || 'Entered by hand',
  };
}
