// Capital and buying power (Nov 2026).
// The Settings bankroll says what sizing is based on; TWS says what the account is
// worth and how much of its buying power is tied up. These helpers join the two:
// buying power in use against a band that moves with VIX, cushion before a margin
// call, and return on the buying power each position holds.
import { isAggExcluded } from './stats';

// Share of net liq to have in use, by VIX: less on when premium is thin and a spike
// is likelier, more as VIX rises, never past half. Band = target ± 5 points.
const LADDER = [[15, 25], [20, 30], [30, 35], [40, 40], [Infinity, 50]];
export const BP_LADDER = LADDER.map(([upTo, pct], i) => ({ from: i ? LADDER[i - 1][0] : 0, upTo, pct }));

export function bpBand(vix) {
  const v = Number(vix);
  const known = Number.isFinite(v) && v > 0;
  const target = known ? LADDER.find(([upTo]) => v < upTo)[1] : 30;
  return { target, lo: target - 5, hi: Math.min(50, target + 5), vix: known ? v : null };
}

// Buying power in use as % of net liq: the initial margin TWS holds against the
// positions (for defined-risk spreads that is the max loss). Falls back to what
// isn't available any more.
export function bpUsedPct(s) {
  if (!s || !(s.netLiq > 0)) return null;
  if (Number.isFinite(s.initMargin)) return (s.initMargin / s.netLiq) * 100;
  if (Number.isFinite(s.availableFunds)) return Math.max(0, (s.netLiq - s.availableFunds) / s.netLiq) * 100;
  return null;
}

// low: room to add · ok: in the band · over: above the band · high: past 1.5× target
export function bpStatus(used, band) {
  if (used == null || !band) return null;
  if (used > band.target * 1.5) return 'high';
  if (used > band.hi) return 'over';
  if (used < band.lo) return 'low';
  return 'ok';
}

// Cushion = excess liquidity ÷ net liq. Under 10% IBKR is close to liquidating.
export function cushionPct(s) {
  if (!s) return null;
  if (Number.isFinite(s.cushion)) return s.cushion * 100;
  if (s.netLiq > 0 && Number.isFinite(s.excessLiquidity)) return (s.excessLiquidity / s.netLiq) * 100;
  return null;
}
export const cushionTone = c => (c == null ? null : c < 10 ? 'red' : c < 25 ? 'amber' : 'green');

// Which app account a TWS account belongs to: the one whose "TWS account" is set to
// it, else (paper logins, DU…) the one paper account.
export function matchAccount(twsId, accounts = []) {
  const id = String(twsId || '').toUpperCase();
  if (!id) return null;
  const set = accounts.find(a => String(a.twsAccount || '').trim().toUpperCase() === id);
  if (set) return set;
  if (/^DU/.test(id)) {
    const paper = accounts.filter(a => isAggExcluded(a.id, accounts));
    if (paper.length === 1 && !paper[0].twsAccount) return paper[0];
  }
  return null;
}

export const bankrollOf = a => {
  if (!a) return null;
  const start = Number(a.startingBankroll);
  if (Number.isFinite(start) && start > 0) return start + (Number(a.realisedPnl) || 0);
  return Number(a.bankroll) > 0 ? Number(a.bankroll) : null;
};

// Net liq vs the Settings bankroll, signed %. Flag at 5% either way: sizing is off.
export function bankrollGap(bankroll, netLiq) {
  if (!(bankroll > 0) || !(netLiq > 0)) return null;
  const pct = ((netLiq - bankroll) / bankroll) * 100;
  return { pct, flag: Math.abs(pct) >= 5 };
}

// Simple annualised return: r × 365 ÷ days, so a 0DTE and a 45-day trade compare on
// one scale. Simple, not compounded: compounding a 32% 44-day return prints 918%,
// which says nothing useful about a trade you can't repeat back to back.
export function annualise(ret, days) {
  if (!Number.isFinite(ret) || !(days > 0)) return null;
  return (ret * 365) / days;
}

const ymdDays = (a, b) => {
  const d = s => { const t = String(s || '').replace(/-/g, ''); return t.length >= 8 ? Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) : NaN; };
  const n = Math.round((d(b) - d(a)) / 86400000);
  return Number.isFinite(n) ? n : null;
};

// One open position's capital: the buying power it holds (its max loss for the
// contracts still open), as % of the account's net liq, and what it returns on it.
export function positionCapital(p, risk, netLiq) {
  if (!p || !(p.live > 0)) return null;
  const perRisk = Number(p.pos && p.pos.maxRiskPerContract);
  const bpr = perRisk > 0 ? perRisk * p.live : p.maxRisk > 0 && p.qty ? (p.maxRisk * p.live) / p.qty : null;
  if (!(bpr > 0)) return null;
  const perProfit = Number(p.pos && p.pos.maxProfitPerContract);
  const maxRet = perProfit > 0 ? (perProfit * p.live) / bpr : null;
  const pnl = risk && Number.isFinite(risk.pnl) ? risk.pnl : null;
  const held = Math.max(1, ymdDays(p.entry && p.entry.ymd, p.expiry) || 1);
  return {
    bpr,
    pctNetLiq: netLiq > 0 ? (bpr / netLiq) * 100 : null,
    maxRet,
    nowRet: pnl != null ? pnl / bpr : null,
    days: held,
    annualMax: maxRet != null ? annualise(maxRet, held) : null,
    credit: !!(p.pos && p.pos.isCredit),
  };
}
