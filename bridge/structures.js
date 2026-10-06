// ================================================================
//  Group TWS option legs into structures for the ticket (pure; Oct 2026)
//  Used by /api/positions and /api/open-orders.
//
//  Each leg carries perShare: the option's price per share. Positions get it from
//  avgCost ÷ multiplier (reqPositions' avgCost is per CONTRACT incl. multiplier);
//  working orders from their limit price (already per share). The old code guessed
//  which one it had from the size of the number (> 100 → per contract), so a short
//  leg bought at 0.40 (avgCost 40) was read as 40.00 a share.
//
//  netCreditDebit is per SHARE, per ONE unit of the structure (+ credit, − debit) —
//  what the ticket's net field holds. It used to be summed across every contract,
//  so a 10-lot fly reported ten times its price.
// ================================================================

export function legPerShare(avgCost, multiplier, basis) {
  const m = Number(multiplier) || 100;
  return basis === 'share' ? Number(avgCost) || 0 : (Number(avgCost) || 0) / m;
}

function shapeOf(sorted, timeSpread) {
  const calls = sorted.filter(l => l.right === 'C').length;
  const puts = sorted.filter(l => l.right === 'P').length;
  const shorts = sorted.filter(l => l.qty < 0).length;
  const longs = sorted.filter(l => l.qty > 0).length;
  const n = sorted.length;
  if (timeSpread) return sorted[0].strike === sorted[1].strike ? 'Calendar' : 'Diagonal';
  if (n === 4 && calls === 2 && puts === 2 && shorts === 2 && longs === 2) return 'Iron condor / Iron fly';
  if (n === 4 && shorts === 2 && longs === 2 && (calls === 4 || puts === 4)) return 'Butterfly';
  if (n === 3 && shorts === 1 && longs === 2) return 'Broken wing / Butterfly';
  if (n === 2 && shorts === 1 && longs === 1) return calls === 2 ? 'Call spread' : puts === 2 ? 'Put spread' : 'Spread';
  return 'Custom';
}

function build(legs, timeSpread) {
  const sorted = [...legs].sort((a, b) => a.strike - b.strike || String(a.expiry).localeCompare(String(b.expiry)));
  const contracts = Math.min(...sorted.map(l => Math.abs(l.qty))) || 1;
  let net = 0;
  sorted.forEach(l => { net += -Math.sign(l.qty) * (l.perShare || 0) * Math.abs(l.qty); });
  net /= contracts;
  const expiries = [...new Set(sorted.map(l => l.expiry))].sort();
  return {
    underlying: sorted[0].underlying,
    expiry: expiries[0],                       // near expiry for a time spread
    expiries,
    shape: shapeOf(sorted, timeSpread),
    legCount: sorted.length,
    legs: sorted,
    strikes: sorted.map(l => l.strike),
    contracts,
    netCreditDebit: Math.round(net * 100) / 100,   // per share, per 1 unit: + credit, − debit
    isCredit: net >= 0,
  };
}

// A calendar/diagonal is two legs in one underlying, two expiries, one long and
// one short in the same size — grouping by expiry alone split it in two.
function isTimeSpread(legs) {
  if (legs.length !== 2) return false;
  const [a, b] = legs;
  return a.expiry !== b.expiry && Math.sign(a.qty) === -Math.sign(b.qty) && Math.abs(a.qty) === Math.abs(b.qty)
    && a.right === b.right;
}

export function groupIntoStructures(legs) {
  const byUnd = {};
  (legs || []).forEach(l => { (byUnd[l.underlying] = byUnd[l.underlying] || []).push(l); });
  const structures = [];
  Object.values(byUnd).forEach(ul => {
    if (isTimeSpread(ul)) { structures.push(build(ul, true)); return; }
    const byExp = {};
    ul.forEach(l => { (byExp[l.expiry] = byExp[l.expiry] || []).push(l); });
    Object.values(byExp).forEach(g => structures.push(build(g, false)));
  });
  return { structures, raw: legs, count: (legs || []).length };
}
