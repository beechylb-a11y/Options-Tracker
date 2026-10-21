// ── A position across its rolls (Oct 2026) ──
//
// A roll closes the old ticket (its P&L is banked on the Closes tab) and opens a
// new one whose notes say "Rolled from TICKET-54". Every screen showed the new
// ticket alone, so a condor rolled for a $447 gain and now −$460 read as a $460
// loser when the position — what you actually opened on 8 Oct — was down $13.
// This walks the "Rolled from" links back to the first ticket and adds up what
// each earlier ticket banked.

import { sessionDateOf } from './session.js';

const num = v => { const x = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return Number.isFinite(x) ? x : null; };
const ymd = iso => String(iso || '').slice(0, 10).replace(/-/g, '');

export const rolledFromRef = notes => {
  const m = /Rolled from TICKET-(\d+)/i.exec(String(notes || ''));
  return m ? Number(m[1]) : null;
};

/** "Net roll 2.27 cr" in a rolled ticket's notes → +2.27 (per share, + credit). */
export const rollNetOf = notes => {
  const m = /Net roll ([\d.]+) (cr|db)/i.exec(String(notes || ''));
  return m ? (m[2].toLowerCase() === 'cr' ? 1 : -1) * Number(m[1]) : null;
};

/** "cumulative basis 4.72 cr" → +4.72. */
export const cumulativeBasisOf = notes => {
  const m = /cumulative basis ([\d.]+) (cr|db)/i.exec(String(notes || ''));
  return m ? (m[2].toLowerCase() === 'cr' ? 1 : -1) * Number(m[1]) : null;
};

/**
 * @param dec        the open ticket's Decisions row (sheet headers, with _rowIndex)
 * @param decisions  every Decisions row
 * @param closes     /api/closes rows (sheet headers: Ticket Ref, P&L ($), Close Date)
 * @returns null when the ticket was never rolled, else
 *   { links: [{ ref, strikes, entryYmd, closeYmd, realised, net, qty }],   oldest first
 *     banked ($ realised by the earlier tickets, net of fees),
 *     startYmd (session the first ticket opened), rolls, basis (cumulative, per share) }
 */
export function rollChain(dec, { decisions = [], closes = [] } = {}) {
  if (!dec) return null;
  const byRef = new Map();
  for (const d of decisions) if (d && d._rowIndex != null) byRef.set(Number(d._rowIndex), d);
  const closesOf = ref => closes.filter(c => String(c['Ticket Ref'] ?? c.ticketRef) === String(ref));
  const links = [];
  const seen = new Set([Number(dec._rowIndex)]);
  let child = dec;
  for (let guard = 0; guard < 20; guard++) {
    const ref = rolledFromRef(child.Notes);
    if (ref == null || seen.has(ref)) break;
    seen.add(ref);
    const d = byRef.get(ref);
    const cs = closesOf(ref);
    // Tranches on the Closes tab; a ticket closed before that tab existed carries its
    // result on the Decisions row instead.
    const realised = cs.length ? cs.reduce((a, c) => a + (num(c['P&L ($)'] ?? c.pnl) || 0), 0)
      : (d ? num(d['Actual P&L']) || 0 : 0);
    const closeYmd = cs.map(c => ymd(c['Close Date'] ?? c.closeDate)).filter(Boolean).sort().pop() || ymd(sessionDateOf(child.Timestamp));
    links.unshift({
      ref,
      strikes: d ? String(d['Wing Strikes'] || '') : '',
      entryYmd: d ? ymd(sessionDateOf(d.Timestamp)) : null,
      closeYmd,
      realised: Math.round(realised * 100) / 100,
      net: rollNetOf(child.Notes),           // what the roll out of this ticket took in, per share
      qty: d ? num(d.Contracts) : null,
      found: !!d,
    });
    if (!d) break;
    child = d;
  }
  if (!links.length) return null;
  const banked = Math.round(links.reduce((a, l) => a + l.realised, 0) * 100) / 100;
  return {
    links, banked, rolls: links.length,
    startYmd: links[0].entryYmd || links[0].closeYmd,
    basis: cumulativeBasisOf(dec.Notes),
  };
}

/** Per-leg IVs logged with a ticket: "Leg IVs: 699P 24.1 / 709P 22.3" → { '699P': 24.1, … }. */
export function legIvsFromNotes(notes) {
  const m = /Leg IVs:\s*([^\n]+)/.exec(String(notes || ''));
  if (!m) return null;
  const out = {};
  const re = /([\d.]+)([PC])\s+([\d.]+)/g;
  let t;
  while ((t = re.exec(m[1]))) out[`${Number(t[1])}${t[2]}`] = Number(t[3]);
  return Object.keys(out).length ? out : null;
}
