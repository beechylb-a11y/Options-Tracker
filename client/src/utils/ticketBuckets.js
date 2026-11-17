// Which list a logged ticket belongs in (Nov 2026). The Tickets panel and the Check-up
// badge counted every ticket whose Status was not "Closed" as open — so six cancelled
// orders (SPX chicken condor, RUT fly, SPY condor, QQQ fly, XSP condor, TSLA fly) read
// as open positions and the badge said "2 open" with one trade on. The trade log is
// the source of truth: it knows Working (sent, nothing filled), Part filled, Open,
// Part closed, Closed and Cancelled from the fills and closes.

/** @returns 'open' | 'working' | 'closed' | 'cancelled' */
export function ticketBucket(dec, pos) {
  const s = String((pos && pos.status) || '').toLowerCase();
  if (s === 'working') return 'working';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'closed') return 'closed';
  if (s) return 'open';                                    // Open / Partial / Part filled / Part closed
  const d = String((dec && (dec.Status || (dec._raw && dec._raw[21]))) || '').toLowerCase();
  if (/^cancel/.test(d)) return 'cancelled';
  if (d === 'closed') return 'closed';
  // No trade-log row: an open ticket with a limit that never filled is still working.
  const lim = dec && dec['Limit Price'];
  return lim !== '' && lim != null && isFinite(Number(lim)) && Number(lim) !== 0 ? 'working' : 'open';
}

/** decisions (objects with _rowIndex) + /api/positions/open rows → { open, working, closed, cancelled } */
export function bucketTickets(decisions, positions) {
  const byRef = new Map((positions || []).map(p => [String(p.ticketRef), p]));
  const out = { open: [], working: [], closed: [], cancelled: [] };
  for (const d of decisions || []) out[ticketBucket(d, byRef.get(String(d._rowIndex)))].push(d);
  return out;
}

/** Realised P&L of the closes dated `day` (yyyy-mm-dd), after commission. */
export function dayPnl(closes, day, account) {
  const rows = (closes || []).filter(c => String(c['Close Date'] || '').slice(0, 10) === day
    && (!account || account === 'all' || !c.Account || c.Account === account));
  return { pnl: +rows.reduce((a, c) => a + (parseFloat(c['P&L ($)']) || 0), 0).toFixed(2), count: rows.length };
}
