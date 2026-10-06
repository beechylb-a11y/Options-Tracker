// ================================================================
//  CAPTURE TRACKER — what share of max profit / max risk trades actually realise
//  (Oct 2026). Pure functions; the server runs them over the TradeLog and the
//  engines read the result.
//
//  The engines' EV uses capture fractions: an iron condor's average win was
//  assumed to be 50% of its max profit. Closing 0DTE premium at 15-25% makes that
//  ~25%, which halves EV and Kelly size. Rather than guess, measure it from closed
//  tickets: realised P&L per contract ÷ max profit per contract (winners) and
//  ÷ max risk per contract (losers), by engine and strategy.
// ================================================================

import { STOP_LOSS_PCT } from './data.js';

// Loss prior from the stop guide (Oct 2026): a loser gives back STOP_LOSS_PCT of the
// entry premium, as a share of max risk (capped at 1). Credit 2.50 on $750 risk →
// 0.33; a plain debit fly → 1 (the debit IS the max loss); an asymmetric fly paid
// 0.55 with $165 risk → 0.33. Null when the ticket has no entry price yet.
export function stopLossFrac(netCreditDebit, riskPerContract, pct = STOP_LOSS_PCT) {
  const prem = Math.abs(parseFloat(netCreditDebit)) * 100 * (pct / 100);
  if (!(prem > 0) || !(riskPerContract > 0)) return null;
  return Math.min(1, prem / riskPerContract);
}

const num = v => { const n = parseFloat(String(v ?? '').replace(/[$,]/g, '')); return isFinite(n) ? n : null; };

// Logged strategy strings look like "SPX - Iron Condor - Normal - neutral"; the
// engine name is the middle. A bare name passes through.
export function strategyOf(raw) {
  const s = String(raw || '').trim();
  const parts = s.split(' - ');
  return parts.length > 2 ? parts.slice(1, -1).join(' - ') : s;
}
export const engineOf = raw => /45/.test(String(raw || '')) ? '45DTE' : /0/.test(String(raw || '')) ? '0DTE' : '';

const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// rows: TradeLog objects (header-keyed, as /api/tradelog returns them).
// → { '0DTE': { [strategy]: stat }, '45DTE': { ... } }
//   stat = { closed, wins, losses, winRate, winCap, winCapMedian, lossCap, lossCapMedian }
//   winCap/lossCap are averages of per-ticket fractions (null when no sample).
export function captureStats(rows, { account } = {}) {
  const out = { '0DTE': {}, '45DTE': {} };
  const acc = {};
  for (const r of rows || []) {
    if (account && account !== 'all' && String(r.Account || '') !== account) continue;
    const eng = engineOf(r.Engine);
    if (!eng) continue;
    const strat = strategyOf(r.Strategy);
    if (!strat) continue;
    const qty = num(r.Qty), qClosed = num(r['Qty Closed']), pnl = num(r['Realised P&L']);
    const maxP = num(r['Max Profit']), maxR = num(r['Max Risk']);
    if (!(qty > 0) || !(qClosed > 0) || pnl == null) continue;
    const perCt = pnl / qClosed;
    const key = eng + '|' + strat;
    const a = acc[key] || (acc[key] = { eng, strat, closed: 0, wins: 0, losses: 0, winFr: [], lossFr: [], lossPrem: [], stopFr: [] });
    a.closed += 1;
    if (perCt >= 0) {
      a.wins += 1;
      const mpc = maxP > 0 ? maxP / qty : null;
      if (mpc) a.winFr.push(Math.min(1.5, perCt / mpc));   // clamp a bad max-profit entry
    } else {
      a.losses += 1;
      const mrc = maxR > 0 ? maxR / qty : null;
      if (mrc) a.lossFr.push(Math.min(1.5, Math.abs(perCt) / mrc));
      // Against the stop guide: loss ÷ entry premium (1.0 = exactly the 100% stop),
      // and the stop's own share of max risk — the prior the engine started from.
      const ep = num(r['Entry Price']);
      if (ep && Math.abs(ep) > 0) {
        a.lossPrem.push(Math.abs(perCt) / (Math.abs(ep) * 100));
        if (mrc) a.stopFr.push(Math.min(1, Math.abs(ep) * 100 / mrc));
      }
    }
  }
  for (const a of Object.values(acc)) {
    const avg = x => x.length ? x.reduce((s, v) => s + v, 0) / x.length : null;
    out[a.eng][a.strat] = {
      closed: a.closed, wins: a.wins, losses: a.losses,
      winRate: a.closed ? a.wins / a.closed : 0,
      winCap: avg(a.winFr), winCapMedian: median(a.winFr), winSamples: a.winFr.length,
      lossCap: avg(a.lossFr), lossCapMedian: median(a.lossFr), lossSamples: a.lossFr.length,
      lossXPremium: avg(a.lossPrem), lossXPremiumMax: a.lossPrem.length ? Math.max(...a.lossPrem) : null,
      stopFrac: avg(a.stopFr),
    };
  }
  return out;
}

// Shrink a measured fraction toward the prior: (n·measured + K·prior) / (n + K).
// With K = 10, ten closed winners move the number halfway; it never jumps on two
// lucky trades, and the prior fades as evidence builds.
export const CAPTURE_K = 10;
export function blendCapture(prior, measured, n, K = CAPTURE_K) {
  if (!(measured != null && isFinite(measured)) || !(n > 0)) return { value: prior, prior, measured: null, n: 0, source: 'assumed' };
  const value = (n * measured + K * prior) / (n + K);
  return { value, prior, measured, n, source: n >= K ? 'measured' : 'blended' };
}
