// ── A ticket's expiry and age (Oct 2026) ──
//
// The Decisions row has no expiry column. It is found, in order, from:
//   1. the "Legs:" line logged with the ticket (side, strike, expiry per leg)
//   2. TWS, when the bridge's positions are passed in (matched on strikes)
//   3. for a rolled ticket, "exp …" in its roll note, else the ticket it was rolled
//      from (a roll that kept the expiry does not repeat it)
//   4. a 0DTE: the session it was opened in
// Nothing is guessed beyond that: no expiry means "unknown", not a made-up date.

import { legsFromNotes, matchTicketLegs } from './positionMatch';
import { rolledFromRef } from '../engine/rollChain';
import { sessionDateOf } from '../engine/session';

const ymd = s => String(s || '').replace(/-/g, '').slice(0, 8);

/**
 * @param dec        Decisions row
 * @param decisions  all Decisions rows (for roll parents)
 * @param opts.raw   TWS option legs from /api/positions (optional)
 * @param opts.todayYmd
 * @returns { expiry: 'YYYYMMDD', source: 'legs'|'tws'|'roll'|'session' } or null
 */
export function ticketExpiry(dec, decisions = [], { raw = null, todayYmd = '00000000', qtyOpen = 1 } = {}) {
  if (!dec) return null;
  const legs = legsFromNotes(dec.Notes);
  if (legs && legs.length) return { expiry: legs.map(l => l.expiry).sort()[0], source: 'legs' };
  if (raw && raw.length) {
    const parts = String(dec.Strategy || '').split(' - ');
    const m = matchTicketLegs({ underlying: dec.Underlying, strikes: dec['Wing Strikes'],
      strategy: parts.length > 2 ? parts.slice(1, -1).join(' - ') : dec.Strategy, qtyOpen, todayYmd }, raw);
    if (m.legs && m.legs.length) return { expiry: m.legs.map(l => l.expiry).sort()[0], source: 'tws' };
  }
  const parent = rolledFromRef(dec.Notes);
  if (parent != null) {
    const e = /\bexp (\d{4}-?\d{2}-?\d{2})/i.exec(String(dec.Notes || ''));
    if (e) return { expiry: ymd(e[1]), source: 'roll' };
    const p = decisions.find(d => Number(d._rowIndex) === parent);
    const pe = p && p !== dec ? ticketExpiry(p, decisions.filter(d => d !== dec), { todayYmd }) : null;
    if (pe) return { expiry: pe.expiry, source: 'roll' };
  }
  if (/0DTE/i.test(String(dec.Engine || ''))) {
    const s = ymd(sessionDateOf(dec.Timestamp));
    if (s) return { expiry: s, source: 'session' };
  }
  return null;
}

const utc = y => Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8));
export const daysBetweenYmd = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);
