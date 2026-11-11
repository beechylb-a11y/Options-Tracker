// ── Find a logged ticket's live legs (Oct 2026) ──
//
// The Decisions row keeps strikes only ("7000 / 7050 / 7750 / 7800"). Side, right
// and expiry come from TWS (/api/positions), matched on underlying + strikes; a
// ticket logged since Oct 2026 also carries a "Legs:" line in its notes, used when
// TWS has no match (paper account, already-closed legs, bridge down).

export const parseStrikes = s => String(s || '').split(/[\/,]/).map(x => parseFloat(x)).filter(x => isFinite(x) && x > 0);

// "Legs: +1 7000P 20261120 / -1 7050P 20261120 / ..."
export function legsFromNotes(notes) {
  const m = /Legs:\s*([^\n]+)/.exec(String(notes || ''));
  if (!m) return null;
  const legs = [];
  const re = /([+\-−])(\d+)\s+([\d.]+)([PC])\s+(\d{8})/g;
  let t;
  while ((t = re.exec(m[1]))) legs.push({ qty: (t[1] === '+' ? 1 : -1) * +t[2], strike: +t[3], right: t[4], expiry: t[5] });
  return legs.length ? legs : null;
}

// Strategy name out of "SPX - Iron Condor - Normal - 2 contracts".
export function strategyName(raw) {
  const parts = String(raw || '').split(' - ');
  return parts.length > 2 ? parts.slice(1, -1).join(' - ') : String(raw || '');
}

const symOf = u => {
  const s = String(u || '').toUpperCase();
  return s === 'SPXW' ? 'SPX' : s;
};

/**
 * @param t   { underlying, strikes (string), strategy, qtyOpen, todayYmd }
 * @param raw TWS option legs [{ underlying, expiry, strike, right, qty (signed, total) }]
 * @returns   { legs: [{ strike, right, qty per lot, expiry }], source, note } | { legs: null, note }
 */
const strikeKey = ks => [...new Set(ks.map(Number))].sort((a, b) => a - b).join('/');

/**
 * The ticket's strikes match nothing in TWS — but the order may simply have filled at
 * other strikes than were logged (SPY 11 Nov: logged 753/757/762, TWS held 753/756/761,
 * and the check-up gave up). Find the ONE TWS position in this symbol with the same
 * shape as the ticket's legs — same rights, same per-lot quantities, strike for strike
 * from the bottom — that no other open ticket owns. None, or more than one: no guess.
 */
export function matchByShape(t, raw) {
  const shape = legsFromNotes(t.notes);
  if (!shape) return null;
  const today = t.todayYmd || '00000000';
  const claimed = new Set((t.claimed || []).map(s => strikeKey(parseStrikes(s))));
  const want = [...shape].sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  const byExp = {};
  (raw || []).filter(l => symOf(l.underlying) === symOf(t.underlying) && String(l.expiry).slice(0, 8) >= today && l.qty)
    .forEach(l => { const e = String(l.expiry).slice(0, 8); (byExp[e] = byExp[e] || []).push(l); });
  const hits = [];
  for (const e of Object.keys(byExp)) {
    const merged = {};
    byExp[e].forEach(l => {
      const k = `${+l.strike}${l.right}`;
      merged[k] = merged[k] || { strike: +l.strike, right: l.right, expiry: e, qty: 0 };
      merged[k].qty += +l.qty;
    });
    const legs = Object.values(merged).filter(l => l.qty !== 0).sort((a, b) => a.strike - b.strike);
    if (legs.length !== want.length) continue;
    const minAbs = Math.min(...legs.map(l => Math.abs(l.qty)));
    const same = legs.every((l, i) => l.right === want[i].right && l.qty / minAbs === want[i].qty);
    if (!same || claimed.has(strikeKey(legs.map(l => l.strike)))) continue;
    hits.push({ legs: legs.map(l => ({ ...l, qty: l.qty / minAbs })), lots: minAbs, exact: e === want[0].expiry });
  }
  const pool = hits.some(h => h.exact) ? hits.filter(h => h.exact) : hits;
  if (pool.length !== 1) return null;
  const tws = pool[0].legs.map(l => l.strike).join('/');
  return { legs: pool[0].legs, source: 'tws',
    mismatch: { tws, ticket: parseStrikes(t.strikes).join('/') },
    note: `TWS holds ${tws}; the ticket says ${parseStrikes(t.strikes).join('/')} — reading TWS` };
}

export function matchTicketLegs(t, raw) {
  const exact = matchExact(t, raw);
  if (exact.legs) return exact;
  return matchByShape(t, raw) || exact;
}

function matchExact(t, raw) {
  const ks = parseStrikes(t.strikes);
  const uniq = new Set(ks);
  const today = t.todayYmd || '00000000';
  const isTime = /Calendar|Diagonal/i.test(t.strategy || '');
  const cand = (raw || []).filter(l => symOf(l.underlying) === symOf(t.underlying) && uniq.has(+l.strike)
    && String(l.expiry).slice(0, 8) >= today && l.qty);
  if (!cand.length) return { legs: null, note: 'No TWS position at these strikes' };

  let pick;
  if (isTime) {
    pick = cand;
    if (new Set(pick.map(l => String(l.expiry).slice(0, 8))).size < 2) return { legs: null, note: 'TWS shows one expiry — a time spread needs two' };
  } else {
    const byExp = {};
    cand.forEach(l => { const e = String(l.expiry).slice(0, 8); (byExp[e] = byExp[e] || []).push(l); });
    const full = Object.keys(byExp).sort().filter(e => new Set(byExp[e].map(l => +l.strike)).size === uniq.size);
    if (!full.length) return { legs: null, note: 'TWS holds only some of these strikes' };
    pick = byExp[full[0]];
  }
  // merge duplicates, then per-lot quantities
  const merged = {};
  pick.forEach(l => {
    const e = String(l.expiry).slice(0, 8), k = `${+l.strike}${l.right}${e}`;
    merged[k] = merged[k] || { strike: +l.strike, right: l.right, expiry: e, qty: 0 };
    merged[k].qty += +l.qty;
  });
  const legs = Object.values(merged).filter(l => l.qty !== 0).sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  const lots = Math.max(1, +t.qtyOpen || 1);
  const minAbs = Math.min(...legs.map(l => Math.abs(l.qty)));
  let note = '';
  if (minAbs !== lots) note = `TWS holds ${minAbs} lot${minAbs === 1 ? '' : 's'} at these strikes; the ticket has ${lots} open — another ticket may share them`;
  legs.forEach(l => { l.qty = l.qty / minAbs; });
  return { legs, source: 'tws', note };
}
