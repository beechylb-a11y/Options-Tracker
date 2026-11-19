// Combo price increments (20 Nov 2026).
//
// TWS rejects a combo limit that isn't on the contract's price grid ("110: The price
// does not conform to the minimum price variation"). The ticket used to send cents.
// Measured with what-if orders on the paper login, 20 Nov 2026, 3-leg call combos:
//   SPX  22.12 / 2.12 rejected · 22.15, 22.10, 2.15, 2.10 accepted   → $0.05
//   XSP  2.12, 0.42 accepted                                         → $0.01
//   SPY  2.12, 0.42 accepted                                         → $0.01
// NDX and RUT aren't penny classes either; they get $0.05 until measured. Rounding to
// a nickel is always accepted where cents are, so erring wide never rejects.
// The bridge keeps the same table (bridge/stageOrder.js); a test holds them equal.
export const COMBO_TICK = { SPX: 0.05, SPXW: 0.05, NDX: 0.05, NDXP: 0.05, RUT: 0.05, RUTW: 0.05 };
export const DEFAULT_TICK = 0.01;

export function comboTick(underlying) {
  return COMBO_TICK[String(underlying || '').toUpperCase()] || DEFAULT_TICK;
}

/** Round a price onto the tick grid. dir: 'down' | 'up' | 'near'. */
export function roundToTick(price, tick = DEFAULT_TICK, dir = 'near') {
  const x = Number(price);
  if (!isFinite(x) || !(tick > 0)) return x;
  const steps = Math.round((x / tick) * 1e6) / 1e6;       // kill float noise (22.15/0.05 = 442.99999…)
  const n = dir === 'down' ? Math.floor(steps) : dir === 'up' ? Math.ceil(steps) : Math.round(steps);
  return Number((n * tick).toFixed(2));
}

/**
 * The prices to send for a combo, each rounded in the trader's favour:
 *   debit entry (BUY)  → down (pay less)      credit entry (SELL) → up (take in more)
 *   debit target (SELL)→ up                   credit target (BUY) → down
 */
export function tickEntry(entry, isCredit, tick) { return roundToTick(entry, tick, isCredit ? 'up' : 'down'); }
export function tickTarget(price, isCredit, tick) { return roundToTick(price, tick, isCredit ? 'down' : 'up'); }
