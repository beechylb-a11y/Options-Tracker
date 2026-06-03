// ================================================================
//  TASTYTRADE CSV PARSER + STRATEGY CLASSIFIER
//  Parses tab-delimited or comma-delimited Activity CSV exports.
//  Groups legs by Order #, identifies strategies, matches open/close.
// ================================================================

// Column positions in tastytrade Activity export (tab-delimited)
const COL = {
  DATETIME: 0, TX_CODE: 1, SUBCODE: 2, SUBCODE2: 3,
  SYMBOL: 4, INSTR_TYPE: 5, DESCRIPTION: 6,
  VALUE: 7, QUANTITY: 8, AVG_PRICE: 9, COL10: 10,
  FEES: 11, MULTIPLIER: 12, ROOT_SYMBOL: 13, UNDERLYING: 14,
  EXPIRY: 15, STRIKE: 16, CALL_PUT: 17, ORDER_ID: 18,
  NET_VALUE: 19, CURRENCY: 20
};

// Normalise weekly symbols to canonical underlying
function normaliseUnderlying(sym) {
  if (!sym) return sym;
  const s = sym.trim().toUpperCase();
  if (['SPXW', 'SPXQ'].includes(s) || (s.length === 4 && s.slice(0, 3) === 'SPX')) return 'SPX';
  if (['NDXP'].includes(s) || (s.length === 4 && s.slice(0, 3) === 'NDX')) return 'NDX';
  if (s === 'RUTW') return 'RUT';
  if (s === 'VIXW') return 'VIX';
  return s;
}

// Parse CSV/TSV content
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
  const hasHeader = isNaN(Date.parse(firstRow[0])) && firstRow[0].toLowerCase().includes('date');
  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines.map(line => {
    const vals = splitLine(line);
    return vals.map(v => v.replace(/^"|"$/g, '').trim());
  }).filter(r => r.some(v => v));
}

// Classify a multi-leg order
function classifyOrder(legs) {
  if (!legs.length) return '';
  if (legs.length === 1) return classifySingleLeg(legs[0]);

  const calls = legs.filter(l => l.cp === 'call');
  const puts = legs.filter(l => l.cp === 'put');
  const buys = legs.filter(l => l.dir === 'buy');
  const sells = legs.filter(l => l.dir === 'sell');
  const n = legs.length;
  const allCalls = puts.length === 0;
  const allPuts = calls.length === 0;
  const hasBoth = calls.length > 0 && puts.length > 0;
  const strikes = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
  const nStr = strikes.length;

  // Iron condor (4 legs, calls+puts, 2 buy + 2 sell)
  if (n === 4 && hasBoth && buys.length === 2 && sells.length === 2) {
    const sc = calls.find(l => l.dir === 'sell');
    const bc = calls.find(l => l.dir === 'buy');
    const sp = puts.find(l => l.dir === 'sell');
    const bp = puts.find(l => l.dir === 'buy');
    if (sc && bc && sp && bp) {
      if (Math.abs(sc.strike - sp.strike) < 0.01) return 'Iron butterfly';
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

  // Straddle
  if (n === 2 && hasBoth && nStr === 1) {
    if (sells.length === 2) return 'Short Straddle';
    if (buys.length === 2) return 'Long Straddle';
  }

  // Strangle
  if (n === 2 && hasBoth && nStr === 2) {
    if (sells.length === 2) return 'Short Strangle';
    if (buys.length === 2) return 'Long Strangle';
  }

  // Vertical spreads
  if (n === 2 && nStr === 2) {
    const srt = legs.slice().sort((a, b) => a.strike - b.strike);
    if (allCalls) {
      return srt[0].dir === 'buy' ? 'Bull Call Spread' : 'Bear Call Spread';
    }
    if (allPuts) {
      return srt[0].dir === 'sell' ? 'Bull Put Spread' : 'Bear Put Spread';
    }
  }

  return '';
}

function classifySingleLeg(leg) {
  const { cp, dir, sub } = leg;
  if (!cp) return dir === 'buy' ? 'Long Stock' : 'Short Stock';
  const isOpen = sub.includes('open');
  if (cp === 'call' && dir === 'buy') return 'Long Call';
  if (cp === 'call' && dir === 'sell') return isOpen ? 'Naked Call' : 'Short Call';
  if (cp === 'put' && dir === 'buy') return 'Long Put';
  if (cp === 'put' && dir === 'sell') return isOpen ? 'Naked Put' : 'Short Put';
  return '';
}

// Build legs from raw row
function buildLeg(row) {
  const cp = (row[COL.CALL_PUT] || '').toLowerCase();
  const normCp = (cp === 'c' || cp === 'call') ? 'call'
    : (cp === 'p' || cp === 'put') ? 'put' : '';
  const sub = (row[COL.SUBCODE] || '').toLowerCase();
  const sub2 = (row[COL.SUBCODE2] || '').toLowerCase();
  const isBuy = sub.includes('buy') || sub2.includes('buy');
  return {
    cp: normCp,
    dir: isBuy ? 'buy' : 'sell',
    strike: parseFloat(row[COL.STRIKE]) || 0,
    qty: Math.abs(parseFloat(row[COL.QUANTITY]) || 1),
    sub: sub,
    desc: (row[COL.DESCRIPTION] || '').toLowerCase(),
    instr: (row[COL.INSTR_TYPE] || '').toLowerCase()
  };
}

// ================================================================
//  MAIN: Process raw CSV rows into cleaned trade rows + trade tracker
// ================================================================
export function processCSV(rawRows) {
  // Step 1: Build output rows (one per leg, cleaned)
  const outputRows = [];
  const orderMap = {};
  const orderSeq = [];

  rawRows.forEach(row => {
    const txCode = (row[COL.TX_CODE] || '').toLowerCase();
    const subcode = (row[COL.SUBCODE] || '').toLowerCase();
    const desc = (row[COL.DESCRIPTION] || '').toLowerCase();
    const isTrade = txCode === 'trade';
    const isExpiry = subcode.includes('expir');
    const isExercise = subcode.includes('exercise');
    const isAssign = subcode.includes('assign');
    const isCashSet = desc.includes('cash settlement') || desc.includes('removal of option');
    const isReceive = txCode === 'receive deliver';
    const isSettlement = isReceive && (isExpiry || isExercise || isAssign || isCashSet);

    if (!isTrade && !isSettlement) return;

    let orderId = (row[COL.ORDER_ID] || '').trim();
    const underlying = normaliseUnderlying(row[COL.UNDERLYING] || row[COL.SYMBOL] || '');

    if (!orderId && isSettlement) {
      orderId = `EXP|${underlying}|${row[COL.EXPIRY]}|${row[COL.STRIKE]}`;
    }
    if (!orderId) return;

    if (!orderMap[orderId]) {
      orderMap[orderId] = { openLegs: [], closeLegs: [] };
      orderSeq.push(orderId);
    }

    const sub = (row[COL.SUBCODE] || '').toLowerCase();
    if (sub.includes('to open')) {
      orderMap[orderId].openLegs.push(row);
    } else {
      orderMap[orderId].closeLegs.push(row);
    }

    // Strategy from order legs
    const leg = buildLeg(row);
    let strategy = '';
    if (isTrade) {
      if (orderId && orderMap[orderId]) {
        const allLegs = orderMap[orderId].openLegs.concat(orderMap[orderId].closeLegs)
          .map(buildLeg);
        strategy = classifyOrder(allLegs);
      }
      if (!strategy) strategy = classifySingleLeg(leg);
    }

    outputRows.push([
      row[COL.DATETIME] || '',
      orderId,
      strategy,
      underlying,
      row[COL.INSTR_TYPE] || '',
      row[COL.DESCRIPTION] || '',
      row[COL.SUBCODE] || '',
      row[COL.SYMBOL] || '',
      row[COL.EXPIRY] || '',
      row[COL.STRIKE] || '',
      row[COL.CALL_PUT] || '',
      row[COL.QUANTITY] || '',
      row[COL.AVG_PRICE] || '',
      row[COL.FEES] || '',
      row[COL.NET_VALUE] || '',
      row[COL.CURRENCY] || ''
    ]);
  });

  // Step 2: Build trade tracker (one row per position lifecycle)
  // Group by fingerprint for open/close matching
  function fingerprint(legs) {
    if (!legs.length) return '';
    const und = normaliseUnderlying(legs[0][COL.UNDERLYING] || '');
    const exp = (legs[0][COL.EXPIRY] || '').trim();
    const strikes = legs.map(l => (parseFloat(l[COL.STRIKE]) || 0).toFixed(2)).sort();
    const cps = legs.map(l => (l[COL.CALL_PUT] || '').trim().toUpperCase()).sort();
    return `${und}|${exp}|${strikes.join(',')}|${cps.join(',')}`;
  }

  // FIFO open position queue
  const fpQueue = {};
  const positions = {};

  // Pass 1: register opens
  orderSeq.forEach(oid => {
    const o = orderMap[oid];
    if (!o.openLegs.length) return;
    const fp = fingerprint(o.openLegs);
    if (!fpQueue[fp]) fpQueue[fp] = [];
    fpQueue[fp].push(oid);
    const und = normaliseUnderlying(o.openLegs[0][COL.UNDERLYING] || '');
    let strategy = '';
    o.openLegs.forEach(l => { if (!strategy) strategy = classifyOrder(o.openLegs.map(buildLeg)); });

    positions[oid] = {
      oid, openLegs: o.openLegs, closeLegs: [], closeOids: [],
      strategy, underlying: und,
      entryDate: o.openLegs[0][COL.DATETIME] || ''
    };
  });

  // Pass 2: match closes
  orderSeq.forEach(oid => {
    const o = orderMap[oid];
    if (!o.closeLegs.length) return;
    const fp = fingerprint(o.closeLegs);
    const queue = fpQueue[fp];
    if (queue && queue.length) {
      const parentOid = queue.shift();
      positions[parentOid].closeLegs.push(...o.closeLegs);
      positions[parentOid].closeOids.push(oid);
      o.absorbedInto = parentOid;
    } else if (!positions[oid]) {
      positions[oid] = {
        oid, openLegs: [], closeLegs: o.closeLegs, closeOids: [],
        strategy: '', underlying: normaliseUnderlying(o.closeLegs[0][COL.UNDERLYING] || ''),
        entryDate: ''
      };
    }
  });

  // Build tracker rows
  const trackerRows = [];
  Object.values(positions).forEach(pos => {
    if (orderMap[pos.oid]?.absorbedInto) return;

    const openLegs = pos.openLegs;
    const closeLegs = pos.closeLegs;
    const allLegs = openLegs.concat(closeLegs);

    const entryDate = openLegs.length ? (openLegs[0][COL.DATETIME] || '').split('T')[0] : '';
    const expiryDate = openLegs.length ? (openLegs[0][COL.EXPIRY] || '') : '';
    const closeDate = closeLegs.length ? (closeLegs[0][COL.DATETIME] || '').split('T')[0] : '';

    const qty = Math.max(...(openLegs.length ? openLegs : closeLegs)
      .map(l => Math.abs(parseFloat(l[COL.QUANTITY]) || 0)));

    const netCredit = openLegs.reduce((s, l) =>
      s + (parseFloat((l[COL.NET_VALUE] || '').replace(/,/g, '')) || 0), 0);
    const totalPnl = allLegs.reduce((s, l) =>
      s + (parseFloat((l[COL.NET_VALUE] || '').replace(/,/g, '')) || 0), 0);

    const isExpired = allLegs.some(l =>
      (l[COL.SUBCODE] || '').toLowerCase().includes('expir') ||
      (l[COL.DESCRIPTION] || '').toLowerCase().includes('expir'));
    const isAssigned = allLegs.some(l =>
      (l[COL.SUBCODE] || '').toLowerCase().includes('assign') ||
      (l[COL.DESCRIPTION] || '').toLowerCase().includes('exercise'));
    const isCashSettled = allLegs.some(l =>
      (l[COL.DESCRIPTION] || '').toLowerCase().includes('cash settlement'));

    let status;
    if (isAssigned) status = 'Assigned';
    else if (isCashSettled) status = 'Cash Settled';
    else if (isExpired) status = 'Expired';
    else if (closeDate) status = 'Closed';
    else status = 'Open';

    const wl = totalPnl > 0 ? 'Win' : totalPnl < 0 ? 'Loss' : '';
    const allOids = [pos.oid, ...pos.closeOids].join(', ');

    trackerRows.push([
      allOids, entryDate, expiryDate, closeDate,
      pos.strategy, pos.underlying, qty,
      Math.round(netCredit * 100) / 100,
      Math.round(totalPnl * 100) / 100,
      wl, '', status
    ]);
  });

  // Sort by entry date
  trackerRows.sort((a, b) => {
    const da = a[1] ? new Date(a[1]) : new Date(9999, 0);
    const db = b[1] ? new Date(b[1]) : new Date(9999, 0);
    return da - db;
  });

  // Running cumulative BA
  let wins = 0, closed = 0;
  trackerRows.forEach(row => {
    if (row[9] === 'Win' || row[9] === 'Loss') {
      closed++;
      if (row[9] === 'Win') wins++;
      row[10] = closed > 0 ? Math.round(wins / closed * 1000) / 10 : '';
    }
  });

  return { outputRows, trackerRows };
}
