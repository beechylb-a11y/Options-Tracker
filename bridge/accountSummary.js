// TWS account summary → one record per account (Nov 2026).
// Net liq, buying power, margin and cushion, so the app can track capital against
// buying power and not just the Settings bankroll. Pure: index.js feeds it the
// (account, tag, value, currency) rows from reqAccountSummary.

export const SUMMARY_TAGS = [
  'NetLiquidation', 'BuyingPower', 'AvailableFunds', 'ExcessLiquidity',
  'InitMarginReq', 'MaintMarginReq', 'GrossPositionValue', 'Cushion',
  'EquityWithLoanValue', 'TotalCashValue', 'Leverage', 'AccountType',
];

const FIELD = {
  NetLiquidation: 'netLiq', BuyingPower: 'buyingPower', AvailableFunds: 'availableFunds',
  ExcessLiquidity: 'excessLiquidity', InitMarginReq: 'initMargin', MaintMarginReq: 'maintMargin',
  GrossPositionValue: 'grossPosition', Cushion: 'cushion', EquityWithLoanValue: 'equityWithLoan',
  TotalCashValue: 'cash', Leverage: 'leverage',
};

// rows: [{ account, tag, value, currency }] → { [account]: { account, netLiq, …, currency } }
export function foldSummary(rows) {
  const out = {};
  for (const r of rows || []) {
    const acct = String(r.account || '');
    if (!acct || acct === 'All') continue;
    const rec = out[acct] || (out[acct] = { account: acct, currency: '' });
    if (r.tag === 'AccountType') { rec.accountType = String(r.value || ''); continue; }
    const f = FIELD[r.tag];
    if (!f) continue;
    const v = Number(r.value);
    if (!Number.isFinite(v)) continue;
    rec[f] = v;
    if (r.currency && !rec.currency) rec.currency = r.currency;
  }
  for (const rec of Object.values(out)) {
    rec.paper = /^DU/i.test(rec.account);
    // Leverage isn't sent by every TWS build: gross position value ÷ net liq.
    if (rec.leverage == null && rec.netLiq > 0 && rec.grossPosition != null) rec.leverage = rec.grossPosition / rec.netLiq;
  }
  return out;
}
