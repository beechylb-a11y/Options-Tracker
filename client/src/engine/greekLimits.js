// Book greek limits as a share of the bankroll (Nov 2026).
//
// Fixed numbers ("delta within ±50", "vega ±200") stop meaning anything when the
// account grows or the book mixes SPX and XSP, so every limit here scales with the
// bankroll from Settings (the account's, or all real accounts together). TWS net liq
// isn't used: on the paper login it is the paper balance, far above the real money.
//
// Only the 45DTE book is held to these. A 0DTE book's theta is huge for the risk it
// carries on the day and its delta swings with every tick; it lives under the risk
// cap and the stress grid instead, and is shown beside the gauges, not in them.
//
//   Theta   daily theta 0.1 %–0.3 % of bankroll is the working band; amber above
//           0.3 %, red above 0.5 %. Below 0.1 % is under target, not a fault.
//   Delta   beta-weighted, in SPY deltas: within ±0.1 % of bankroll (±50 on $50k).
//           Amber outside the band, red past twice it.
//   Vega    the book's P&L if implied vol rises 10 points: amber past a 3 % loss,
//           red past 5 %.
//   Δ/Θ     |SPY deltas| ÷ daily theta, shown as a readout; amber above 1, red above 5.
//
// Warnings, never blocks: a ticket that would push the book past a band says so.

export const LIMITS = {
  theta: { floor: 0.001, amber: 0.003, red: 0.005 },
  delta: { band: 0.001, redX: 2 },
  vega10: { amber: 0.03, red: 0.05 },
  ratio: { amber: 1, red: 5 },
};
export const VEGA_SHOCK = 10;   // vol points

/** $ a book makes for a 1% SPX move → SPY-weighted deltas (shares of SPY). */
export function spyDeltas(spxDelta1, spyPrice) {
  if (!(spyPrice > 0) || !Number.isFinite(spxDelta1)) return null;
  return spxDelta1 / (spyPrice * 0.01);
}

/** SPY's price for the conversion: SPY live, else SPX / 10, else XSP. */
export function spyPriceFrom({ spy, spx, xsp } = {}) {
  if (spy > 0) return spy;
  if (spx > 0) return spx / 10;
  if (xsp > 0) return xsp;
  return null;
}

export function thetaTone(pct) {
  if (pct == null) return 'none';
  if (pct < 0) return 'amber';                 // a premium book paying decay
  if (pct > LIMITS.theta.red) return 'red';
  if (pct > LIMITS.theta.amber) return 'amber';
  if (pct < LIMITS.theta.floor) return 'low';
  return 'green';
}
export function deltaTone(frac) {
  if (frac == null) return 'none';
  if (frac > LIMITS.delta.redX) return 'red';
  if (frac > 1) return 'amber';
  return 'green';
}
export function vegaTone(lossPct) {
  if (lossPct == null) return 'none';
  if (lossPct > LIMITS.vega10.red) return 'red';
  if (lossPct > LIMITS.vega10.amber) return 'amber';
  return 'green';
}
export function ratioTone(r) {
  if (r == null) return 'none';
  if (r > LIMITS.ratio.red) return 'red';
  if (r > LIMITS.ratio.amber) return 'amber';
  return 'green';
}

/**
 * Where a book sits against the limits.
 * @param g        { theta ($/day), spxDelta1 ($ per 1% SPX), vega10 ($ P&L at +10 vol, − = loss), n }
 * @param netLiq   bankroll the limits scale with
 * @param spyPrice for the SPY-delta conversion
 */
export function bookLimits(g, { netLiq, spyPrice } = {}) {
  const ok = netLiq > 0;
  const theta = g && Number.isFinite(g.theta) ? g.theta : 0;
  const dSpy = spyDeltas(g ? g.spxDelta1 || 0 : 0, spyPrice);
  const band = ok ? LIMITS.delta.band * netLiq : null;     // SPY deltas
  const thetaPct = ok ? theta / netLiq : null;
  const deltaFrac = ok && dSpy != null ? Math.abs(dSpy) / band : null;
  const v10 = g && Number.isFinite(g.vega10) ? g.vega10 : null;
  const vegaLossPct = ok && v10 != null ? Math.max(0, -v10) / netLiq : null;
  const ratio = dSpy != null && theta > 0 ? Math.abs(dSpy) / theta : null;
  return {
    n: g ? g.n || 0 : 0, netLiq: ok ? netLiq : null,
    theta, thetaPct, thetaTone: thetaTone(thetaPct),
    thetaBand: ok ? { floor: LIMITS.theta.floor * netLiq, amber: LIMITS.theta.amber * netLiq, red: LIMITS.theta.red * netLiq } : null,
    deltaSpy: dSpy, deltaBand: band, deltaFrac, deltaTone: deltaTone(deltaFrac),
    vega10: v10, vegaLossPct, vegaTone: vegaTone(vegaLossPct),
    vegaBand: ok ? { amber: LIMITS.vega10.amber * netLiq, red: LIMITS.vega10.red * netLiq } : null,
    ratio, ratioTone: ratioTone(ratio),
  };
}

/** Sum the greeks of the positions in one book (risks from engine/portfolio positionRisk). */
export function bookGreeks(risks, keep = () => true) {
  const out = { n: 0, theta: 0, spxDelta1: 0, vega: 0 };
  for (const r of risks || []) {
    if (!r || !r.greeks || !keep(r)) continue;
    out.n++;
    out.theta += r.greeks.theta || 0;
    out.spxDelta1 += r.spxDelta1 || 0;
    out.vega += r.greeks.vega || 0;
  }
  return out;
}

const pct = x => `${(x * 100).toFixed(2)}%`;
const dlr = x => `$${Math.round(Math.abs(x)).toLocaleString('en-US')}`;

/**
 * Warnings for a 45DTE ticket: what the book would look like with this trade on.
 * @param book   { theta, spxDelta1, vega, netLiq, spyPrice } — the 45DTE book now
 * @param trade  { theta, delta, vega } net per combo (bridge units: position $, ×100),
 *               contracts, price (underlying), beta
 * Only warns when the trade moves the book across a band, or deeper past one.
 */
export function tradeLimitWarnings(book, trade) {
  if (!book || !(book.netLiq > 0) || !trade || !(trade.contracts > 0)) return [];
  const c = trade.contracts;
  const add = {
    theta: (trade.theta || 0) * c,
    spxDelta1: (trade.delta || 0) * c * (trade.price || 0) * 0.01 * (trade.beta || 1),
    vega: (trade.vega || 0) * c,
  };
  if (!add.theta && !add.spxDelta1) return [];
  const before = bookLimits({ theta: book.theta, spxDelta1: book.spxDelta1 }, book);
  const after = bookLimits({ theta: book.theta + add.theta, spxDelta1: book.spxDelta1 + add.spxDelta1 }, book);
  const out = [];
  const worse = (a, b) => ({ none: 0, low: 0, green: 0, amber: 1, red: 2 }[a] > { none: 0, low: 0, green: 0, amber: 1, red: 2 }[b]);
  if (after.thetaPct != null && after.thetaPct > LIMITS.theta.amber && (worse(after.thetaTone, before.thetaTone) || after.thetaPct > before.thetaPct)) {
    out.push(`Book theta would be ${dlr(after.theta)}/day, ${pct(after.thetaPct)} of bankroll — over the ${after.thetaPct > LIMITS.theta.red ? '0.5%' : '0.3%'} line for the 45DTE book`);
  }
  if (after.deltaFrac != null && after.deltaFrac > 1 && (worse(after.deltaTone, before.deltaTone) || after.deltaFrac > before.deltaFrac)) {
    const side = after.deltaSpy > 0 ? 'long' : 'short';
    out.push(`Book delta would be ${Math.round(Math.abs(after.deltaSpy))} SPY deltas ${side}, past the ±${Math.round(after.deltaBand)} band (0.1% of bankroll)`);
  }
  return out;
}
