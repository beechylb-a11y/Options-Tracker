// ── Completed orders, the backstop for old fills (Nov 2026) ──
//
// TWS hands this API version today's executions only, so a fill from a day the bridge
// was off is gone from /api/executions. TWS does still hand out up to seven days of
// COMPLETED ORDERS (reqCompletedOrders): which order filled, how many, its limit and
// when — not the fill price itself. /api/completed-orders returns them with each combo
// leg resolved to strike / right / expiry, and the close ticket uses one as a last
// resort, at the limit price, asking you to confirm it.

/** One completed order, in plain fields. */
export function completedRecord(contract = {}, order = {}, state = {}) {
  return {
    permId: order.permId || 0,
    orderId: order.orderId || 0,
    account: order.account || '',
    symbol: contract.symbol || '',
    secType: contract.secType || '',
    action: order.action || '',               // BUY / SELL
    totalQuantity: Number(order.totalQuantity) || 0,
    filledQuantity: Number(order.filledQuantity) || 0,
    orderType: order.orderType || '',
    lmtPrice: order.lmtPrice != null && order.lmtPrice < 1e300 ? Number(order.lmtPrice) : null,
    orderRef: order.orderRef || '',
    status: state.status || '',
    completedTime: state.completedTime || '',
    completedStatus: state.completedStatus || '',
    // A single option: its own strike; a combo: its legs by conId, resolved later.
    strike: contract.secType === 'OPT' ? Number(contract.strike) || 0 : 0,
    right: contract.secType === 'OPT' ? contract.right || '' : '',
    expiry: contract.lastTradeDateOrContractMonth || '',
    comboLegs: (contract.comboLegs || []).map(l => ({ conId: l.conId, ratio: Number(l.ratio) || 1, action: l.action || '' })),
  };
}

/** yyyymmdd of completedTime ("20261120 11:03:33 America/New_York"). */
export function completedYmd(r) {
  const m = /^(\d{8})/.exec(String((r && r.completedTime) || '').trim());
  return m ? m[1] : '';
}

/** Did it fill? completedStatus is free text ("Filled Size: 1 ..."), status "Filled". */
export function isFilled(r) {
  return !!r && (/^filled$/i.test(r.status) || /^filled/i.test(r.completedStatus)) && (r.filledQuantity > 0 || r.totalQuantity > 0);
}

/** Combo legs with strike / right / expiry from a { conId: contract } map. */
export function withLegs(r, byConId = {}) {
  const legs = r.comboLegs.map(l => {
    const c = byConId[l.conId] || {};
    return { conId: l.conId, ratio: l.ratio, action: l.action, strike: Number(c.strike) || 0, right: c.right || '', expiry: c.lastTradeDateOrContractMonth || '' };
  });
  return { ...r, legs, resolved: legs.every(l => l.strike > 0) };
}
