// ================================================================
//  TASTYTRADE CSV PARSER + STRATEGY CLASSIFIER + TRADE TRACKER
//  Full port of tastytrade_strategy_cleaner.gs + tastytrade_tracker.gs
//  into a single Node.js module for the Railway app.
//
//  Key features ported from Apps Script:
//  - Tab/comma delimiter auto-detection
//  - Order # grouping for multi-leg strategy detection
//  - SPXW/SPXQ/NDXP normalised to canonical underlying
//  - Receive Deliver rows (expiration, exercise, assignment, cash settlement) included
//  - Virtual EXP| IDs synthesised for settlement rows
//  - Combinatorial backtracking for expiry leg grouping
//  - FIFO fingerprint matching with partial close re-queuing
//  - Description-based strategy fallback
//  - Calendar, collar, covered call, ratio spread, straddle/strangle classification
//  - Orphan close handling
// ================================================================

// Column positions in tastytrade Activity export
const COL = {
  DATETIME: 0, TX_CODE: 1, SUBCODE: 2, SUBCODE2: 3,
  SYMBOL: 4, INSTR_TYPE: 5, DESCRIPTION: 6,
  VALUE: 7, QUANTITY: 8, AVG_PRICE: 9, COL10: 10,
  FEES: 11, MULTIPLIER: 12, ROOT_SYMBOL: 13, UNDERLYING: 14,
  EXPIRY: 15, STRIKE: 16, CALL_PUT: 17, ORDER_ID: 18,
  NET_VALUE: 19, CURRENCY: 20
};

function col(row, idx) {
  return (row && row[idx] !== undefined) ? String(row[idx]).trim() : '';
}

function normaliseUnderlying(sym) {
  if (!sym) return sym;
  const s = sym.trim().toUpperCase();
  if (s === 'SPXW' || s === 'SPXQ' || (s.length === 4 && s.slice(0, 3) === 'SPX')) return 'SPX';
  if (s === 'NDXP' || (s.length === 4 && s.slice(0, 3) === 'NDX')) return 'NDX';
  if (s === 'RUTW') return 'RUT';
  if (s === 'VIXW') return 'VIX';
  return s;
}

function roundTo2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function parseDate(str) {
  if (!str || str === '') return null;
  const d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let yr = parseInt(m[3]);
    if (yr < 100) yr += 2000;
    return new Date(yr, parseInt(m[1]) - 1, parseInt(m[2]));
  }
  return null;
}

function fmtDate(d) {
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ================================================================
//  CSV PARSING
// ================================================================
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return [];

  const tabCount = (lines[0].match(/\t/g) || []).length;
  const commaCount = (lines[0].match(/,/g) || []).length;
  const delim = tabCount >= commaCount ? '\t' : ',';

  function splitLine(line) {
    if (delim === '\t') return line.split('\t').map(v => v.trim());
    const result = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    result.push(cur.trim());
    return result;
  }

  const firstRow = splitLine(lines[0]);
  const hasHeader = isNaN(Date.parse(firstRow[0])) &&
    (firstRow[0].toLowerCase().includes('date') || firstRow[0].toLowerCase().includes('time'));
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map(line => {
    return splitLine(line).map(v => v.replace(/^"|"$/g, '').trim());
  }).filter(r => r.some(v => v));
}

// ================================================================
//  LEG EXTRACTION
// ================================================================
function legFromRow(r) {
  const cp = col(r, COL.CALL_PUT).toLowerCase();
  const normCp = (cp === 'c' || cp === 'call') ? 'call'
    : (cp === 'p' || cp === 'put') ? 'put' : '';
  const sub = col(r, COL.SUBCODE).toLowerCase();
  const sub2 = (r[COL.SUBCODE2] !== undefined ? String(r[COL.SUBCODE2]) : '').toLowerCase();
  const isBuy = sub.includes('buy') || sub2.includes('buy');
  return {
    cp: normCp,
    dir: isBuy ? 'buy' : 'sell',
    strike: parseFloat(r[COL.STRIKE]) || 0,
    qty: Math.abs(parseFloat(r[COL.QUANTITY]) || 1),
    subcode: col(r, COL.SUBCODE),
    sub2: sub2,
    desc: col(r, COL.DESCRIPTION).toLowerCase(),
    instr: col(r, COL.INSTR_TYPE).toLowerCase()
  };
}

// ================================================================
//  STRATEGY CLASSIFICATION
// ================================================================
function classifyOrder(legs) {
  if (!legs || !legs.length) return '';
  if (legs.length === 1) return classifySingleLegFromLeg(legs[0]);

  const calls = legs.filter(l => l.cp === 'call');
  const puts = legs.filter(l => l.cp === 'put');
  const stocks = legs.filter(l => !l.cp);
  const buys = legs.filter(l => l.dir === 'buy');
  const sells = legs.filter(l => l.dir === 'sell');
  const n = legs.length;
  const allCalls = puts.length === 0 && stocks.length === 0;
  const allPuts = calls.length === 0 && stocks.length === 0;
  const hasBoth = calls.length > 0 && puts.length > 0;
  const hasStock = stocks.length > 0;
  const strikes = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
  const nStr = strikes.length;

  // Iron Condor / Iron Butterfly (4 legs, calls+puts, 2 buy + 2 sell)
  if (n === 4 && hasBoth && buys.length === 2 && sells.length === 2) {
    const sc = calls.find(l => l.dir === 'sell');
    const bc = calls.find(l => l.dir === 'buy');
    const sp = puts.find(l => l.dir === 'sell');
    const bp = puts.find(l => l.dir === 'buy');
    if (sc && bc && sp && bp) {
      if (Math.abs(sc.strike - sp.strike) < 0.01) return 'Short Iron Butterfly';
      if (Math.abs(bc.strike - bp.strike) < 0.01) return 'Long Iron Butterfly';
      return bc.strike > sc.strike ? 'Long Iron Condor' : 'Short Iron Condor';
    }
  }

  // Butterfly (3 legs, same type, 3 strikes)
  if (n === 3 && nStr === 3) {
    const sorted = legs.slice().sort((a, b) => a.strike - b.strike);
    const dirs = sorted.map(l => l.dir);
    if (allCalls) {
      if (dirs[0] === 'buy' && dirs[1] === 'sell' && dirs[2] === 'buy') return 'Long Call Butterfly';
      if (dirs[0] === 'sell' && dirs[1] === 'buy' && dirs[2] === 'sell') return 'Short Call Butterfly';
    }
    if (allPuts) {
      if (dirs[0] === 'buy' && dirs[1] === 'sell' && dirs[2] === 'buy') return 'Long Put Butterfly';
      if (dirs[0] === 'sell' && dirs[1] === 'buy' && dirs[2] === 'sell') return 'Short Put Butterfly';
    }
  }

  // Condor (4 legs, same type, 4 strikes)
  if (n === 4 && nStr === 4) {
    if (allCalls) return buys.length > sells.length ? 'Long Call Condor' : 'Short Condor';
    if (allPuts) return buys.length > sells.length ? 'Long Put Condor' : 'Short Condor';
  }

  // Straddle (2 legs, 1 call + 1 put, same strike)
  if (n === 2 && hasBoth && nStr === 1) {
    if (sells.length === 2) return 'Short Straddle';
    if (buys.length === 2) return 'Long Straddle';
  }

  // Strangle / Collar (2 legs, call + put, different strikes)
  if (n === 2 && hasBoth && nStr === 2) {
    const sc = calls.find(l => l.dir === 'sell');
    const sp = puts.find(l => l.dir === 'sell');
    const bc = calls.find(l => l.dir === 'buy');
    const bp = puts.find(l => l.dir === 'buy');
    if (sc && sp) return 'Short Strangle';
    if (bc && bp) return 'Long Strangle';
    if (bc && sp) return 'Collar';
    if (sc && bp) return 'Collar';
  }

  // Vertical Spreads (2 legs, same type, 2 strikes)
  if (n === 2 && nStr === 2) {
    const srt = legs.slice().sort((a, b) => a.strike - b.strike);
    if (allCalls) {
      if (srt[0].dir === 'buy' && srt[1].dir === 'sell') return 'Bull Call Spread';
      if (srt[0].dir === 'sell' && srt[1].dir === 'buy') return 'Bear Call Spread';
    }
    if (allPuts) {
      if (srt[0].dir === 'sell' && srt[1].dir === 'buy') return 'Bull Put Spread';
      if (srt[0].dir === 'buy' && srt[1].dir === 'sell') return 'Bear Put Spread';
    }
  }

  // Calendar Spreads (2 legs, same type, same strike)
  if (n === 2 && nStr === 1) {
    if (allCalls) return sells.length > buys.length ? 'Short Call Calendar Spread' : 'Long Call Calendar Spread';
    if (allPuts) return sells.length > buys.length ? 'Short Put Calendar Spread' : 'Long Put Calendar Spread';
  }

  // Stock + option combos
  if (hasStock && n === 2) {
    const opt = legs.find(l => !!l.cp);
    const stk = legs.find(l => !l.cp);
    if (opt && stk) {
      if (stk.dir === 'buy' && opt.dir === 'sell' && opt.cp === 'call') return 'Covered Call';
      if (stk.dir === 'buy' && opt.dir === 'buy' && opt.cp === 'put') return 'Protective Put';
      if (stk.dir === 'sell' && opt.dir === 'sell' && opt.cp === 'put') return 'Covered Put';
      if (stk.dir === 'buy' && opt.dir === 'sell' && opt.cp === 'put') return 'Cash-Secured Put';
    }
  }

  // Ratio spreads (3 legs, same type, 2 strikes, uneven qty)
  if (n === 3 && nStr === 2) {
    if (allCalls) return buys.length > sells.length ? 'Long Ratio Call Spread' : 'Short Ratio Call Spread';
    if (allPuts) return buys.length > sells.length ? 'Long Ratio Put Spread' : 'Short Ratio Put Spread';
  }

  return '';
}

function classifySingleLegFromLeg(leg) {
  const desc = leg.desc || '';
  const sub = (leg.subcode || '').toLowerCase();
  const sub2 = (leg.sub2 || '').toLowerCase();
  const cp = leg.cp;
  const isCall = cp === 'call';
  const isPut = cp === 'put';

  // Description keyword shortcuts
  if (desc.includes('iron condor')) return sub.includes('sell') ? 'Short Iron Condor' : 'Long Iron Condor';
  if (desc.includes('iron butterfly')) return sub.includes('sell') ? 'Short Iron Butterfly' : 'Long Iron Butterfly';
  if (desc.includes('butterfly') && isCall) return sub.includes('buy') ? 'Long Call Butterfly' : 'Short Call Butterfly';
  if (desc.includes('butterfly') && isPut) return sub.includes('buy') ? 'Long Put Butterfly' : 'Short Put Butterfly';
  if (desc.includes('condor') && isCall) return sub.includes('buy') ? 'Long Call Condor' : 'Short Condor';
  if (desc.includes('condor') && isPut) return sub.includes('buy') ? 'Long Put Condor' : 'Short Condor';
  if (desc.includes('straddle')) return sub.includes('sell') ? 'Short Straddle' : 'Long Straddle';
  if (desc.includes('strangle')) return sub.includes('sell') ? 'Short Strangle' : 'Long Strangle';
  if (desc.includes('covered call')) return 'Covered Call';
  if (desc.includes('covered put')) return 'Covered Put';
  if (desc.includes('cash-secured') || desc.includes('cash secured')) return 'Cash-Secured Put';
  if (desc.includes('collar')) return 'Collar';
  if (desc.includes('protective put')) return 'Protective Put';

  // Stock
  if (!cp) return leg.dir === 'buy' ? 'Long Stock' : 'Short Stock';

  // Option direction
  const isSellToOpen = sub.includes('sell to open') || sub2.includes('sell_to_open');
  const isBuyToOpen = sub.includes('buy to open') || sub2.includes('buy_to_open');

  if (isBuyToOpen && isCall) return 'Long Call';
  if (isSellToOpen && isCall) return 'Naked Call';
  if (isBuyToOpen && isPut) return 'Long Put';
  if (isSellToOpen && isPut) return 'Naked Put';

  // Fallback
  if (isCall) return leg.dir === 'buy' ? 'Long Call' : 'Naked Call';
  if (isPut) return leg.dir === 'buy' ? 'Long Put' : 'Naked Put';
  return '';
}

// ================================================================
//  FINGERPRINTING
// ================================================================
function fingerprint(legs) {
  if (!legs.length) return '';
  const rawUnd = col(legs[0], COL.UNDERLYING) || col(legs[0], COL.SYMBOL).replace(/\s.*/, '');
  const und = normaliseUnderlying(rawUnd);
  const expiries = legs.map(l => col(l, COL.EXPIRY)).filter(Boolean).sort();
  const exp = expiries[0] || '';
  const strikes = legs.map(l => (parseFloat(l[COL.STRIKE]) || 0).toFixed(2)).sort();
  const cps = legs.map(l => col(l, COL.CALL_PUT).toUpperCase()).sort();
  return `${und}|${exp}|${strikes.join(',')}|${cps.join(',')}`;
}

// Combinations helper for backtracking
function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const first = arr[0], rest = arr.slice(1);
  const withFirst = combos(rest, k - 1).map(c => [first, ...c]);
  const without = combos(rest, k);
  return [...withFirst, ...without];
}

// ================================================================
//  MAIN: processCSV
//  Input: array of raw CSV rows (each row is an array of strings)
//  Output: { outputRows, trackerRows }
// ================================================================
export function processCSV(rawRows) {
  // ---- Step 1: Build order groups for strategy classification ----
  const orderGroups = {};
  rawRows.forEach(r => {
    const txCode = col(r, COL.TX_CODE).toLowerCase();
    if (txCode !== 'trade') return;
    const oid = col(r, COL.ORDER_ID);
    if (!oid) return;
    if (!orderGroups[oid]) orderGroups[oid] = [];
    orderGroups[oid].push(legFromRow(r));
  });

  const orderStrategy = {};
  for (const oid in orderGroups) {
    orderStrategy[oid] = classifyOrder(orderGroups[oid]);
  }

  // ---- Step 2: Build cleaned output rows ----
  const outputRows = [];
  rawRows.forEach(r => {
    const txCode = col(r, COL.TX_CODE).toLowerCase();
    const subcode = col(r, COL.SUBCODE).toLowerCase();
    const desc = col(r, COL.DESCRIPTION).toLowerCase();
    const isTrade = txCode === 'trade';
    const isExpiry = subcode.includes('expir');
    const isExercise = subcode.includes('exercise') || subcode.includes('exercis');
    const isAssign = subcode.includes('assign');
    const isCashSet = desc.includes('cash settlement') || desc.includes('removal of option');
    const isReceive = txCode === 'receive deliver';
    const isSettlement = isReceive && (isExpiry || isExercise || isAssign || isCashSet);

    if (!isTrade && !isSettlement) return;

    let orderId = col(r, COL.ORDER_ID);
    const underlying = normaliseUnderlying(col(r, COL.UNDERLYING) || col(r, COL.SYMBOL));

    if (!orderId && isSettlement) {
      orderId = `EXP|${underlying}|${col(r, COL.EXPIRY)}|${col(r, COL.STRIKE)}`;
    }
    if (!orderId) return;

    let strategy = '';
    if (isTrade && orderId && orderStrategy[orderId]) {
      strategy = orderStrategy[orderId];
    }
    if (!strategy && isTrade) {
      strategy = classifySingleLegFromLeg(legFromRow(r));
    }

    outputRows.push([
      col(r, COL.DATETIME), orderId, strategy, underlying,
      col(r, COL.INSTR_TYPE), col(r, COL.DESCRIPTION), col(r, COL.SUBCODE),
      col(r, COL.SYMBOL), col(r, COL.EXPIRY), col(r, COL.STRIKE), col(r, COL.CALL_PUT),
      col(r, COL.QUANTITY), col(r, COL.AVG_PRICE), col(r, COL.FEES),
      col(r, COL.NET_VALUE), col(r, COL.CURRENCY)
    ]);
  });

  // ---- Step 3: Build trade tracker ----
  // A. Group legs by Order #, split into open vs close
  const orderMap = {};
  const orderSeq = [];

  // Pre-pass: collect EXP legs for combinatorial grouping
  const expLegs = [];
  outputRows.forEach(row => {
    const oid = row[1];
    if (oid && oid.startsWith('EXP|')) {
      expLegs.push(row);
    }
  });
  expLegs.sort((a, b) => (parseFloat(a[9]) || 0) - (parseFloat(b[9]) || 0));

  // Build known open fingerprints for backtracking matching
  const knownOpenFPs = {};
  outputRows.forEach(row => {
    const oid = row[1];
    if (!oid || oid.startsWith('EXP|')) return;
    const sub = (row[6] || '').toLowerCase();
    if (!sub.includes('to open')) return;
    const und = normaliseUnderlying(row[3]);
    const exp = row[8] || '';
    const strike = (parseFloat(row[9]) || 0).toFixed(2);
    const cp = (row[10] || '').toUpperCase();
    if (!knownOpenFPs[oid]) knownOpenFPs[oid] = { und, exp, strikes: [], cps: [] };
    knownOpenFPs[oid].strikes.push(strike);
    knownOpenFPs[oid].cps.push(cp);
  });

  const openFPSet = {};
  Object.keys(knownOpenFPs).forEach(oid => {
    const o = knownOpenFPs[oid];
    const fp = `${o.und}|${o.exp}|${o.strikes.slice().sort().join(',')}|${o.cps.slice().sort().join(',')}`;
    openFPSet[fp] = true;
  });

  // Group EXP legs by und|exp, then match subsets via combinatorial backtracking
  const expByUndExp = {};
  expLegs.forEach(row => {
    const und = normaliseUnderlying(row[3]);
    const exp = row[8] || '';
    const key = `${und}|${exp}`;
    if (!expByUndExp[key]) expByUndExp[key] = [];
    expByUndExp[key].push(row);
  });

  const expiryGroups = {};
  const expGroupSeq = [];

  Object.keys(expByUndExp).forEach(undExpKey => {
    let remaining = expByUndExp[undExpKey].slice();
    let progress = true;

    while (progress && remaining.length > 0) {
      progress = false;
      for (let size = Math.min(remaining.length, 8); size >= 1; size--) {
        const allCombos = combos(remaining, size);
        let matchFound = false;
        for (const combo of allCombos) {
          const und = normaliseUnderlying(combo[0][3]);
          const exp = combo[0][8] || '';
          const strikes = combo.map(r => (parseFloat(r[9]) || 0).toFixed(2)).sort();
          const cps = combo.map(r => (r[10] || '').toUpperCase()).sort();
          const fp = `${und}|${exp}|${strikes.join(',')}|${cps.join(',')}`;

          if (openFPSet[fp]) {
            const groupId = `EXPGRP|${fp}`;
            if (!expiryGroups[groupId]) {
              expiryGroups[groupId] = [];
              expGroupSeq.push(groupId);
            }
            combo.forEach(r => expiryGroups[groupId].push(r));
            combo.forEach(r => {
              const idx = remaining.indexOf(r);
              if (idx >= 0) remaining.splice(idx, 1);
            });
            progress = true;
            matchFound = true;
            break;
          }
        }
        if (matchFound) break;
      }
    }

    // Fallback: unmatched legs grouped by und|exp
    if (remaining.length > 0) {
      const groupId = `EXPGRP|fallback|${undExpKey}`;
      if (!expiryGroups[groupId]) {
        expiryGroups[groupId] = [];
        expGroupSeq.push(groupId);
      }
      remaining.forEach(r => expiryGroups[groupId].push(r));
    }
  });

  // Register expiry groups as synthetic close orders
  expGroupSeq.forEach(groupId => {
    if (!orderMap[groupId]) {
      orderMap[groupId] = { oid: groupId, openLegs: [], closeLegs: [] };
      orderSeq.push(groupId);
    }
    expiryGroups[groupId].forEach(r => orderMap[groupId].closeLegs.push(r));
  });

  // Register all non-EXP orders
  outputRows.forEach(row => {
    const oid = row[1];
    if (!oid || oid.startsWith('EXP|')) return;
    if (!orderMap[oid]) {
      orderMap[oid] = { oid, openLegs: [], closeLegs: [] };
      orderSeq.push(oid);
    }
    const sub = (row[6] || '').toLowerCase();
    if (sub.includes('to open')) {
      orderMap[oid].openLegs.push(row);
    } else {
      orderMap[oid].closeLegs.push(row);
    }
  });

  // B. Sort chronologically
  function earliestDate(legs) {
    const dates = legs.map(l => parseDate(l[0])).filter(Boolean).sort((a, b) => a - b);
    return dates[0] || null;
  }

  orderSeq.sort((a, b) => {
    const allA = orderMap[a].openLegs.concat(orderMap[a].closeLegs);
    const allB = orderMap[b].openLegs.concat(orderMap[b].closeLegs);
    const da = earliestDate(allA), db = earliestDate(allB);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  // C. Fingerprint for output rows (uses output column indices: 3=underlying, 8=expiry, 9=strike, 10=cp)
  function fpFromOutputRows(legs) {
    if (!legs.length) return '';
    const und = normaliseUnderlying(legs[0][3]);
    const exp = legs[0][8] || '';
    const strikes = legs.map(l => (parseFloat(l[9]) || 0).toFixed(2)).sort();
    const cps = legs.map(l => (l[10] || '').toUpperCase()).sort();
    return `${und}|${exp}|${strikes.join(',')}|${cps.join(',')}`;
  }

  // D. FIFO queue per fingerprint
  const fpQueue = {};
  function enqueueOpen(fp, parentOid) {
    if (!fpQueue[fp]) fpQueue[fp] = [];
    fpQueue[fp].push(parentOid);
  }
  function dequeueOpen(fp) {
    if (!fpQueue[fp] || !fpQueue[fp].length) return null;
    return fpQueue[fp].shift();
  }

  // E. Positions store
  const positions = {};
  function strategyFromLegs(legs) {
    for (const l of legs) {
      const s = (l[2] || '').trim();
      if (s) return s;
    }
    return '';
  }

  // Pass 1: register open legs
  orderSeq.forEach(oid => {
    const o = orderMap[oid];
    if (!o.openLegs.length) return;
    const fp = fpFromOutputRows(o.openLegs);
    positions[oid] = {
      oid, openLegs: o.openLegs, closeLegs: [], closeOids: [],
      fingerprint: fp,
      strategy: strategyFromLegs(o.openLegs),
      underlying: normaliseUnderlying(o.openLegs[0][3]),
      entryDate: earliestDate(o.openLegs)
    };
    enqueueOpen(fp, oid);
  });

  // Pass 2: match close legs (FIFO with partial close re-queuing)
  orderSeq.forEach(oid => {
    const o = orderMap[oid];
    if (!o.closeLegs.length) return;
    const fp = fpFromOutputRows(o.closeLegs);
    const parentOid = dequeueOpen(fp);
    if (parentOid) {
      positions[parentOid].closeLegs.push(...o.closeLegs);
      positions[parentOid].closeOids.push(oid);
      o.absorbedInto = parentOid;
      // Re-queue if partially closed
      const openQty = positions[parentOid].openLegs.reduce((s, l) =>
        s + Math.abs(parseFloat(l[11]) || 0), 0);
      const closedQty = positions[parentOid].closeLegs.reduce((s, l) =>
        s + Math.abs(parseFloat(l[11]) || 0), 0);
      if (closedQty < openQty) {
        enqueueOpen(fp, parentOid);
      }
    } else if (!positions[oid]) {
      // Orphan close
      positions[oid] = {
        oid, openLegs: [], closeLegs: o.closeLegs, closeOids: [],
        fingerprint: fp,
        strategy: strategyFromLegs(o.closeLegs),
        underlying: normaliseUnderlying(o.closeLegs[0][3]),
        entryDate: null
      };
    }
  });

  // F. Build tracker rows
  const trackerRows = [];

  orderSeq.forEach(oid => {
    if (orderMap[oid].absorbedInto) return;
    if (!positions[oid]) return;

    const pos = positions[oid];
    const { openLegs, closeLegs } = pos;
    const allLegs = openLegs.concat(closeLegs);

    const entryDate = pos.entryDate ? fmtDate(pos.entryDate) : '';
    const expiries = openLegs.map(l => parseDate(l[8])).filter(Boolean).sort((a, b) => a - b);
    const expiryDate = expiries.length ? fmtDate(expiries[0]) : '';
    const closeDates = closeLegs.map(l => parseDate(l[0])).filter(Boolean).sort((a, b) => b - a);
    const closeDate = closeDates.length ? fmtDate(closeDates[0]) : '';

    const refLegs = openLegs.length ? openLegs : closeLegs;
    const qty = refLegs.reduce((mx, l) => Math.max(mx, Math.abs(parseFloat(l[11]) || 0)), 0);
    const netCredit = openLegs.reduce((s, l) => s + (parseFloat((l[14] || '').replace(/,/g, '')) || 0), 0);
    const totalPnl = allLegs.reduce((s, l) => s + (parseFloat((l[14] || '').replace(/,/g, '')) || 0), 0);

    const isExpired = allLegs.some(l =>
      (l[6] || '').toLowerCase().includes('expir') || (l[5] || '').toLowerCase().includes('expir'));
    const isAssigned = allLegs.some(l =>
      (l[6] || '').toLowerCase().includes('assign') || (l[5] || '').toLowerCase().includes('assignment'));
    const isExercised = allLegs.some(l =>
      (l[6] || '').toLowerCase().includes('exercise') || (l[5] || '').toLowerCase().includes('exercise'));
    const isCashSettled = allLegs.some(l =>
      (l[5] || '').toLowerCase().includes('cash settlement') || (l[5] || '').toLowerCase().includes('removal of option'));

    let status;
    if (isAssigned || isExercised) status = 'Assigned';
    else if (isCashSettled) status = 'Cash Settled';
    else if (isExpired) status = 'Expired';
    else if (closeDate) status = 'Closed';
    else status = 'Open';

    const wl = totalPnl > 0 ? 'Win' : totalPnl < 0 ? 'Loss' : '';
    const allOids = [oid, ...pos.closeOids].join(', ');

    trackerRows.push([
      allOids, entryDate, expiryDate, closeDate,
      pos.strategy, pos.underlying, qty,
      roundTo2(netCredit), roundTo2(totalPnl),
      wl, '', status
    ]);
  });

  // Sort by entry date
  trackerRows.sort((a, b) => {
    const da = parseDate(a[1]), db = parseDate(b[1]);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  // Running cumulative BA
  let winCount = 0, closedCount = 0;
  trackerRows.forEach(row => {
    if (row[9] === 'Win' || row[9] === 'Loss') {
      closedCount++;
      if (row[9] === 'Win') winCount++;
      row[10] = closedCount > 0 ? roundTo2(winCount / closedCount * 100) : '';
    }
  });

  return { outputRows, trackerRows };
}
