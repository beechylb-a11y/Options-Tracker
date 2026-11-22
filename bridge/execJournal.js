// ── Execution journal (Nov 2026) ──
//
// TWS hands out executions for the current day only (up to 7 days if its Trade Log
// is set to show them; IB Gateway never more than today). A META credit spread whose
// target filled on Friday had vanished from /api/executions by Monday, so the close
// ticket could not find its fill. The bridge now keeps every execution it sees — live
// reports, and a sweep of whatever TWS holds on connect and every 15 minutes — in a
// small JSON file next to it, for 120 days, and /api/executions?all=1 answers from TWS
// and this journal together. Pure functions here; index.js does the I/O.

/** One execution in the shape /api/executions has always returned. */
export function execRecord(contract = {}, execution = {}) {
  return {
    execId: execution.execId,
    time: execution.time,
    account: execution.acctNumber,
    symbol: contract.symbol,
    secType: contract.secType,
    exchange: contract.exchange,
    side: execution.side, // BOT or SLD
    qty: execution.shares || execution.filledQuantity,
    price: execution.price,
    avgPrice: execution.avgPrice,
    orderId: execution.orderId,
    // Same on every leg of one order whoever placed it. orderId is 0 for an order
    // entered in TWS by hand, so the app groups combo legs on this.
    permId: execution.permId || 0,
    orderRef: execution.orderRef || '',
    strike: contract.strike || 0,
    right: contract.right || '', // C or P
    expiry: contract.lastTradeDateOrContractMonth || '',
    multiplier: contract.multiplier || '100',
    realizedPnl: execution.realizedPNL || 0,
  };
}

/** yyyymmdd of an execution ("20261120  10:31:05 US/Eastern", "20261120-15:31:05"). */
export function execYmd(e) {
  const m = /^(\d{8})/.exec(String((e && e.time) || '').trim());
  return m ? m[1] : '';
}

const BIG = 1.7976931348623157e+308;   // IB's "not set"

/**
 * Add executions (and any commission reports, keyed by execId) to the journal.
 * Returns { journal, added } — a new object; the input is not changed.
 */
export function mergeJournal(journal, execs = [], comms = {}, nowIso = new Date().toISOString()) {
  const out = { ...(journal || {}) };
  let added = 0;
  for (const e of execs) {
    if (!e || !e.execId) continue;
    const prev = out[e.execId];
    const c = comms[e.execId] || {};
    const commission = c.commission != null && c.commission < BIG ? c.commission : (prev && prev.commission) || e.commission || 0;
    const rp = c.realizedPnl != null && c.realizedPnl < BIG ? c.realizedPnl : (prev && prev.realizedPnl) || (e.realizedPnl < BIG ? e.realizedPnl : 0) || 0;
    const { quoteAtFill, source, ...base } = e;   // derived fields are rebuilt on the way out
    out[e.execId] = { ...(prev || {}), ...base, commission, realizedPnl: rp, seenAt: (prev && prev.seenAt) || nowIso };
    if (!prev) added++;
  }
  return { journal: out, added };
}

/** Attach a commission report to an execution already in the journal. */
export function withCommission(journal, report) {
  if (!report || !report.execId || !journal || !journal[report.execId]) return journal;
  const e = journal[report.execId];
  return { ...journal, [report.execId]: { ...e,
    commission: report.commission != null && report.commission < BIG ? report.commission : e.commission,
    realizedPnl: report.realizedPNL != null && report.realizedPNL < BIG ? report.realizedPNL : e.realizedPnl } };
}

/** Drop executions older than `days` (by their trade date, else when first seen). */
export function pruneJournal(journal, nowMs = Date.now(), days = 120) {
  const out = {};
  const cut = nowMs - days * 864e5;
  for (const [k, e] of Object.entries(journal || {})) {
    const y = execYmd(e);
    const t = y ? Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)) : Date.parse(e && e.seenAt);
    if (!isFinite(t) || t >= cut) out[k] = e;
  }
  return out;
}

/** Journal executions on or after sinceYmd, minus those TWS already returned. */
export function journalFills(journal, { sinceYmd = '', exclude = new Set() } = {}) {
  return Object.values(journal || {})
    .filter(e => !exclude.has(e.execId) && (!sinceYmd || execYmd(e) >= sinceYmd))
    .map(e => ({ ...e, source: 'journal' }))
    .sort((a, b) => String(a.time).localeCompare(String(b.time)));
}
