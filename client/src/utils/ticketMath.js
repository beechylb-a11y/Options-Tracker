// Order-ticket arithmetic shared by the BUY side (profit-taker ladder on the engine)
// and the SELL side (tranche close / 45DTE roll). Pure functions, no React.
//
// Conventions — the one thing to get right:
//   ncd     per-share net as the app stores it: POSITIVE = credit received,
//           NEGATIVE = debit paid  (Decisions col AH "Net Debit/Credit").
//   price   what you type as a combo limit, always a positive magnitude, with
//           a side: a credit trade CLOSES for a debit, a debit trade for a credit.
//   IBKR    a combo you BUY carries a SIGNED price: debit positive, credit
//           negative (BUY SPX fly @ 1.50, BUY iron condor @ -3.40). The attached
//           profit taker is the opposite side at  entry + profit/share,  the stop at
//           entry − loss/share. One rule for both credit and debit, which is why it
//           makes a quick check against what TWS pre-fills.
//
// Targets are a % of MAX PROFIT (same basis as the engine's old ProfitScale), not a
// % of the entry price. For credit spreads the two coincide; for debit flies they
// diverge badly — 50% of a 1.50 debit is +0.75, 50% of a 3.50 max profit is +1.75.
// IBKR's percentage preset works off the parent price, so the ticket shows both.

export const MULT = 100;

const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return isFinite(n) ? n : null; };
export const round2 = x => Math.round(x * 100) / 100;

// Snap to a tradeable tick: 0.05 for index combos (SPX/XSP/RUT/NDX), 0.01 for ETF
// options. A guide, not a rule — check the tick TWS enforces on the specific series.
export function snap(price, tick = 0.05) {
  if (!isFinite(price)) return price;
  return round2(Math.round(price / tick) * tick);
}

export function defaultTick(underlying) {
  const u = String(underlying || '').toUpperCase();
  return (u === 'SPX' || u === 'SPXW' || u === 'XSP' || u === 'RUT' || u === 'NDX') ? 0.05 : 0.01;
}

// Normalise whatever the caller holds — a Journal decision row (sheet headers), an
// OpenPositions row (camelCase), or the engine's live inputs — into one shape.
export function normalisePosition(src = {}) {
  const g = (...keys) => { for (const k of keys) if (src[k] !== undefined && src[k] !== '') return src[k]; return ''; };
  const qty = num(g('qty', 'Contracts', 'Qty')) || 1;
  const qtyClosedKnown = num(g('qtyClosed'));
  const qtyOpen = num(g('qtyOpen'));
  const ncd = num(g('entryPrice', 'Net Debit/Credit', 'netCreditDebit'));
  const maxProfitPos = num(g('maxProfit', 'Max Profit'));
  const maxRiskPos = num(g('maxRisk', 'Max Risk'));
  const rawStrat = String(g('strategy', 'Strategy'));
  const parts = rawStrat.split(' - ');
  const stratName = parts.length > 2 ? parts.slice(1, -1).join(' - ') : rawStrat;
  const ts = String(g('Timestamp', 'timestamp'));
  return {
    ticketRef: num(g('ticketRef', '_rowIndex')),
    timestamp: ts,
    entryDate: String(g('entryDate')) || ts.split('T')[0] || '',
    engine: String(g('engine', 'Engine')) || '',
    underlying: String(g('underlying', 'Underlying')).toUpperCase(),
    strategy: stratName,
    strategyRaw: rawStrat,
    legs: String(g('legs', 'Wing Strikes')),
    account: String(g('account', 'Account')),
    qty,
    qtyOpen: qtyOpen != null ? qtyOpen : Math.max(0, qty - (qtyClosedKnown || 0)),
    realised: num(g('realisedPnl')) || 0,
    ncd,                                           // per share, + credit / − debit
    isCredit: ncd != null ? ncd > 0 : null,
    maxProfitPerContract: maxProfitPos != null && qty ? maxProfitPos / qty : null,
    maxRiskPerContract: maxRiskPos != null && qty ? maxRiskPos / qty : null,
  };
}

// Max profit per SHARE — the base every % target is taken of. Falls back to the
// entry magnitude when the ticket carries no Max Profit (manual / legacy tickets):
// right for credit spreads, conservative for debit flies.
export function maxProfitPerShare(pos) {
  if (pos.maxProfitPerContract != null && pos.maxProfitPerContract > 0) return pos.maxProfitPerContract / MULT;
  return Math.abs(pos.ncd || 0);
}

// % of max profit → closing limit (positive magnitude). Negative % = a loss exit.
export function targetToPrice(pos, pct) {
  const e = Math.abs(pos.ncd || 0), mp = maxProfitPerShare(pos);
  const profit = mp * (pct / 100);
  return pos.isCredit ? e - profit : e + profit;
}

// Stop: loss as a % of the ENTRY price, not of max profit. Credit: 100% = close for
// 2x the credit. Debit: 50% = close for half the debit. Measuring a debit fly's stop
// against max profit produced negative closing prices (Sep 2026).
export function stopToPrice(pos, lossPct) {
  const e = Math.abs(pos.ncd || 0), l = e * Math.abs(lossPct) / 100;
  return pos.isCredit ? e + l : Math.max(0, e - l);
}

// Closing limit → % of max profit (inverse of the above).
export function priceToTarget(pos, price) {
  const e = Math.abs(pos.ncd || 0), mp = maxProfitPerShare(pos);
  if (!mp) return null;
  const profit = pos.isCredit ? e - price : price - e;
  return (profit / mp) * 100;
}

// Gross P&L in $ for closing `qty` contracts at `price` (positive magnitude).
export function pnlAt(pos, price, qty) {
  const e = Math.abs(pos.ncd || 0);
  const perShare = pos.isCredit ? e - price : price - e;
  return round2(perShare * MULT * qty);
}

// Round-trip-free: fees for ONE side of the trade (this close), per contract per leg.
export function legCount(legs) {
  const n = String(legs || '').split(/[\/|,\s]+/).map(Number).filter(x => x > 0).length;
  return n || 1;
}
export function feesFor(qty, legs, perLegContract) {
  return round2((Number(qty) || 0) * legCount(legs) * (Number(perLegContract) || 0));
}

// IBKR combo lines for an entry + a closing target. Returned as display strings so
// the ticket and the log notes say the same thing.
export function ibkrLines(pos, closePrice) {
  const e = Math.abs(pos.ncd || 0);
  const signedEntry = pos.isCredit ? -e : e;            // BUY-combo convention
  const signedClose = pos.isCredit ? -closePrice : closePrice;
  const f = x => (x < 0 ? '−' : '') + Math.abs(x).toFixed(2);
  return {
    buyConv: `BUY combo @ ${f(signedEntry)}  →  SELL LMT @ ${f(signedClose)}`,
    sellConv: pos.isCredit
      ? `SELL combo @ ${e.toFixed(2)} cr  →  BUY LMT @ ${closePrice.toFixed(2)} db`
      : `BUY combo @ ${e.toFixed(2)} db  →  SELL LMT @ ${closePrice.toFixed(2)} cr`,
    offset: round2(signedClose - signedEntry),          // what TWS's offset field needs
    offsetPctOfEntry: e ? ((Math.abs(closePrice - e)) / e) * 100 : null,
  };
}

// Split `qty` contracts across target %s as evenly as possible, remainder to the
// FIRST tranches (bank early, let the runner be the small one).
export function ladder(qty, pcts) {
  const n = Math.max(1, Math.min(pcts.length, qty));
  const use = pcts.slice(0, n);
  const base = Math.floor(qty / n), extra = qty % n;
  return use.map((pct, i) => ({ qty: base + (i < extra ? 1 : 0), pct }));
}

export const LADDER_PRESETS = {
  '0DTE':  { label: 'Thirds — 25 / 50 / 75', pcts: [25, 50, 75] },
  '45DTE': { label: '45DTE — half @ 50, runner @ 75', pcts: [50, 75] },
  single50:{ label: 'Single — 50%', pcts: [50] },
  fly:     { label: 'Fly — 30 / 50 / 70', pcts: [30, 50, 70] },
};

// Roll arithmetic. closeAt = debit/credit to take the old legs off (magnitude, same
// side rules as a close); openAt = the new structure's per-share net in ncd sign
// (+ credit / − debit). Net roll is what the IBKR roll combo prices at.
export function rollSummary(pos, qty, closeAt, openNcd) {
  const realised = pnlAt(pos, closeAt, qty);
  const closeSigned = pos.isCredit ? -closeAt : closeAt;  // cash in (+) / out (−) per share
  const net = round2(closeSigned + openNcd);              // + = roll for a credit
  const cumulative = round2((pos.ncd || 0) + net);        // running basis across the roll
  return { realised, net, cumulative };
}

// Exit plans persisted per ticket (keyed by the Decisions Timestamp — present on the
// engine at log time AND on the row afterwards), so a ladder set at entry is the
// ladder the sell ticket opens with.
const PLAN_KEY = ts => `exitPlan:${ts}`;
export function savePlan(ts, plan) {
  if (!ts) return;
  try { localStorage.setItem(PLAN_KEY(ts), JSON.stringify(plan)); } catch (e) { /* storage off */ }
}
export function loadPlan(ts) {
  if (!ts) return null;
  try { const s = localStorage.getItem(PLAN_KEY(ts)); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

export function planText(pos, rows, stopPct) {
  const lines = rows.map((r, i) => {
    const p = targetToPrice(pos, r.pct);
    return `  T${i + 1}: ${r.qty}x @ ${p.toFixed(2)} ${pos.isCredit ? 'db' : 'cr'} (${r.pct}% max profit, +$${pnlAt(pos, p, r.qty).toFixed(0)})`;
  });
  if (stopPct) {
    const sp = stopToPrice(pos, stopPct);
    lines.push(`  Stop: all @ ${sp.toFixed(2)} ${pos.isCredit ? 'db' : 'cr'} (lose ${Math.abs(stopPct)}% of entry, ${pnlAt(pos, sp, 1).toFixed(0)}/ct)`);
  }
  return '--- Exit plan ---\n' + lines.join('\n');
}
