// Sizing caps beyond Kelly (Nov 2026).
// Kelly says how much edge there is; it says nothing about how much buying power is
// already tied up or how bad the bad days are. Contracts = the smallest of:
//   Kelly (half for a B setup or backwardation) · the buying power cap · the CVaR cap
// and the ticket shows which one set it. Risk-constrained Kelly (Busseti, Ryu & Boyd
// 2016) — cap the risk, then take Kelly inside it — beats a fixed Kelly fraction at
// the same drawdown risk.
import { bpBand } from '../utils/capital';

// One trade's bad day may cost at most this share of the sizing bankroll, measured
// as CVaR95: the average loss across the worst 5% of outcomes.
export const CVAR_TRADE_PCT = 2;

// CVaR95 per contract, $ (a positive number = a loss). The engine's own tail model:
// P(max loss) of outcomes lose the whole max loss; the other losers lose `partialFrac`
// of it. The worst 5% are filled from the max-loss tail first. Stops are not sent to
// TWS and a gap goes through them, so the tail is the max loss, not the stop.
// Without P(max loss) every loser is assumed to be a max loss.
export function cvar95({ risk, winP, pMaxLoss, partialFrac = 0.3, commission = 0 }) {
  if (!(risk > 0) || !(winP >= 0) || winP > 1) return null;
  const pLoss = 1 - winP;
  const pTail = Math.min(pLoss, pMaxLoss != null && pMaxLoss >= 0 ? pMaxLoss : pLoss);
  const pPart = Math.max(0, pLoss - pTail);
  const a = Math.min(pTail, 0.05);
  const b = Math.min(pPart, 0.05 - a);
  return ((a * risk + b * risk * partialFrac) / 0.05) + (commission || 0);
}

// How many max-size losses in a row take `drawPct` of capital, and the chance of a
// run that long somewhere in `trades` trades at loss rate pLoss.
export function losingRun({ lossEach, capital, pLoss, trades = 100, drawPct = 0.10 }) {
  if (!(lossEach > 0) || !(capital > 0) || !(pLoss > 0) || pLoss >= 1) return null;
  const n = Math.max(1, Math.ceil((capital * drawPct) / lossEach));
  // P(no run of n) by dynamic programming over the current run length.
  let state = new Array(n).fill(0); state[0] = 1;
  for (let i = 0; i < trades; i++) {
    const next = new Array(n).fill(0);
    for (let r = 0; r < n; r++) {
      if (!state[r]) continue;
      next[0] += state[r] * (1 - pLoss);
      if (r + 1 < n) next[r + 1] += state[r] * pLoss;
    }
    state = next;
  }
  const pNone = state.reduce((s, x) => s + x, 0);
  return { n, prob: Math.max(0, Math.min(1, 1 - pNone)), trades, drawPct };
}

// The caps and the size they give.
//   kellyFull / kellyHalf: contracts; useHalf: B setup or backwardation
//   riskEach: buying power one contract holds (its max loss)
//   capital: { netLiq, initMargin, vix } from TWS for the ticket's account (optional)
//   cvarEach: CVaR95 per contract; bankroll: the sizing bankroll
export function sizeSteps({ kellyFull, kellyHalf, useHalf, riskEach, capital, cvarEach, bankroll, cvarPct }) {
  // Per account in Settings (Nov 2026); 2% when not set.
  cvarPct = Number(cvarPct) > 0 ? Number(cvarPct) : CVAR_TRADE_PCT;
  const steps = [];
  if (kellyFull > 0) steps.push({ key: 'kelly', label: 'Kelly', ct: kellyFull, why: 'edge, capped by max loss and max open risk' });
  if (useHalf && kellyHalf > 0) steps.push({ key: 'half', label: 'Half Kelly', ct: kellyHalf, why: 'B setup or backwardation' });
  let bp = null;
  if (capital && capital.netLiq > 0 && riskEach > 0) {
    const band = bpBand(capital.vix);
    const used = Number.isFinite(capital.initMargin) ? capital.initMargin : 0;
    const room = (band.hi / 100) * capital.netLiq - used;
    bp = { band, room, used, ct: Math.max(0, Math.floor(room / riskEach)) };
    steps.push({ key: 'bp', label: 'Buying power cap', ct: bp.ct,
      why: `${band.hi}% of net liq at ${band.vix ? 'VIX ' + band.vix.toFixed(1) : 'VIX unknown'}: $${Math.max(0, Math.round(room)).toLocaleString()} room, $${Math.round(riskEach).toLocaleString()} a contract` });
  }
  let cv = null;
  if (cvarEach > 0 && bankroll > 0) {
    const limit = (cvarPct / 100) * bankroll;
    cv = { limit, pct: cvarPct, each: cvarEach, ct: Math.max(0, Math.floor(limit / cvarEach)) };
    steps.push({ key: 'cvar', label: 'CVaR cap', ct: cv.ct,
      why: `a bad day ≤ ${cvarPct}% of bankroll ($${Math.round(limit).toLocaleString()}); $${Math.round(cvarEach).toLocaleString()} a contract` });
  }
  if (!steps.length) return null;
  const sizers = steps.filter(s => s.key !== 'kelly' || !useHalf);
  const low = sizers.reduce((m, s) => (s.ct < m.ct ? s : m), sizers[0]);
  return {
    steps, bp, cvar: cv,
    binding: low.key,
    // Never below one contract: a cap at 0 says the trade is too big for the account,
    // and the ticket warns; the engine still prices one.
    final: Math.max(1, low.ct),
    capsAtZero: steps.filter(s => s.ct < 1 && s.key !== 'kelly' && s.key !== 'half').map(s => s.key),
  };
}
