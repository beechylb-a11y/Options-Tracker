// ── Commission: one counting rule for the whole app (Oct 2026) ──
//
// Before this file there were three: ProfitTaker counted CONTRACTS (a 1x2x1 fly is
// 4), the order ticket counted strike NUMBERS (3), and the frictions gauge counted
// payoff LEGS (3). The entry-side commission was never recorded anywhere, and EV
// ignored commission entirely. IBKR bills per contract, so contracts it is.
//
// Plain ESM with no imports: the server imports this file too
// (server/db.js → ../client/src/utils/commission.js), so the engine, the tickets,
// the close forms and the tax report all charge the same way.
//
// The rate is per contract, per side, and lives on the ACCOUNT
// (accounts[].commissionPerContract). IBKR's published fixed rate is $0.65, but
// tiered pricing with exchange rebates bills less: the 5 Oct 2026 QQQ 751/754/756
// fly (paper) cost $2.96 for 8 contracts round trip, $0.37 each. Settings can
// calibrate the rate from a day's TWS fills.

export const DEFAULT_COMMISSION = 0.65;
const MULT = 100;
const r2 = x => Math.round(x * 100) / 100;
const num = x => (x === null || x === undefined || x === '' || !isFinite(Number(x))) ? null : Number(x);

// Contracts in ONE unit of a structure, from engine legs ({label, strike}).
// "x2" bodies count twice. A 4-leg dual-EM vertical suggestion is two alternative
// 2-leg spreads, so it is billed as the one you trade (mirrors calc0dte's payoff).
export function unitsFromLegs(legs) {
  if (!Array.isArray(legs) || !legs.length) return 0;
  const use = (legs.length === 4 && String(legs[0]?.label || '').includes('VIX')) ? legs.slice(0, 2) : legs;
  return use.reduce((a, l) => a + (/x2\b/i.test(l.label || '') ? 2 : 1), 0);
}

// Contracts in one unit of a LOGGED ticket, where only "Wing Strikes"
// ("751 / 754 / 756") and the strategy name survive. A non-iron butterfly logs
// its body once, so three strikes on a fly mean four contracts.
export function unitsFromTicket(wingStrikes, strategy) {
  const toks = String(wingStrikes || '').split(/[\/|,\s]+/).filter(Boolean);
  let n = 0, extra = 0;
  for (const t of toks) {
    const m = /^(\d+(?:\.\d+)?)(?:x(\d+))?$/i.exec(t);
    if (!m || !(Number(m[1]) > 0)) continue;
    n++;
    if (m[2]) extra += Number(m[2]) - 1;
  }
  if (!n) return 0;
  const s = String(strategy || '');
  if (!extra && n === 3 && /butterfly|\bfly\b|\bbwb\b/i.test(s) && !/iron/i.test(s)) extra = 1;
  return n + extra;
}

// Per contract, per side, for an account object from Settings.
export function commissionRate(account) {
  const v = num(account && account.commissionPerContract);
  return v != null && v >= 0 ? v : DEFAULT_COMMISSION;
}

export function oneSideCommission(units, qty, rate) {
  return r2((Number(units) || 0) * (Number(qty) || 0) * (num(rate) ?? DEFAULT_COMMISSION));
}
export function roundTripCommission(units, qty, rate) {
  return r2(oneSideCommission(units, qty, rate) * 2);
}

// Effective rate from TWS executions: commission per option contract over the
// fills given. Combo (BAG) rows carry no strike and are skipped for the count.
export function rateFromFills(fills) {
  let comm = 0, qty = 0;
  for (const f of fills || []) {
    const c = num(f.commission);
    if (c != null) comm += c;
    if ((Number(f.strike) || 0) > 0) qty += Math.abs(Number(f.qty) || 0);
  }
  return qty > 0 && comm > 0 ? { rate: Math.round((comm / qty) * 1000) / 1000, commission: r2(comm), contracts: qty } : null;
}

// P&L of a set of TWS fills, split the way the TWS Trades summary shows it:
// gross ("Net Total"), commission ("Comm") and net ("Nt Incl. Comm").
//
// When the fills open AND close every contract (a same-day round trip, i.e. most
// 0DTE trades) gross comes straight from the prices, which needs no assumption.
// Otherwise the opening fills are on an earlier day and only IBKR's realisedPNL
// knows the cost basis; IBKR reports that figure after commission, so it is taken
// as the net and gross is net plus the commission seen here.
export function pnlFromFills(fills) {
  const all = fills || [];
  const legs = all.filter(f => (Number(f.strike) || 0) > 0);
  const commission = r2(all.reduce((a, f) => a + (num(f.commission) || 0), 0));
  if (!legs.length) return null;
  const pos = {};
  let gross = 0;
  for (const f of legs) {
    const q = Math.abs(Number(f.qty) || 0);
    const sgn = /^(SLD|SELL|S)$/i.test(f.side || '') ? -1 : 1;
    const k = `${f.strike}|${f.right || ''}|${f.expiry || ''}`;
    pos[k] = (pos[k] || 0) + sgn * q;
    const mult = Number(f.multiplier) || MULT;
    gross += -sgn * q * (Number(f.price) || 0) * mult;
  }
  const roundTrip = Object.values(pos).every(v => Math.abs(v) < 1e-9);
  if (roundTrip) return { gross: r2(gross), commission, net: r2(gross - commission), basis: 'prices' };
  const realised = all.reduce((a, f) => {
    const v = num(f.realizedPnl);
    return v != null && Math.abs(v) < 1e300 ? a + v : a;
  }, 0);
  return { gross: r2(realised + commission), commission, net: r2(realised), basis: 'ib-realised' };
}

// The one place a close becomes a number. Callers send what they know:
//   grossPnl (+ fees)   → net = gross − fees
//   netPnl   (+ fees)   → net as given
//   actualPnl (legacy)  → treated as net
// Fees not given are estimated round trip from the ticket, and say so.
export function resolveClosePnl({ grossPnl, netPnl, actualPnl, fees, units, qty, rate }) {
  const g = num(grossPnl), n = num(netPnl), a = num(actualPnl);
  let f = num(fees), feesSource = 'given';
  if (f == null) {
    f = units > 0 ? roundTripCommission(units, qty, rate) : 0;
    feesSource = units > 0 ? 'estimate' : 'none';
  }
  f = Math.abs(f);
  if (g != null) return { gross: r2(g), fees: r2(f), net: r2(g - f), feesSource };
  const net = n != null ? n : (a != null ? a : 0);
  return { gross: r2(net + f), fees: r2(f), net: r2(net), feesSource };
}
