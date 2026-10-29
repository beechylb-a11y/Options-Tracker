// ── 0DTE check-up (Oct 2026) ──
//
// The 45DTE check-up never covered 0DTE, so an open 0DTE trade had no live price, no
// P&L and no verdict anywhere — the IWM 278/280/283 fly of 28 Oct sat on the board as
// a grey "OPEN" with "no live mark" all afternoon. This is the 0DTE verdict: the target
// and stop from the exit plan, and what the clock means for THIS position — which, in
// the last hour, depends on how it settles:
//
//   CASH-SETTLED (SPX, XSP, NDX, RUT): nothing is delivered. A position worth what it
//   will settle at can simply be left to expire — there is no assignment and the close
//   costs a commission and the spread. The risk is gamma: near a short strike or the
//   body of a fly, the last hour swings fastest.
//
//   SETTLES INTO SHARES (SPY, QQQ, IWM, single stocks): an in-the-money short is
//   assigned and an in-the-money long exercised after the bell, and the underlying can
//   still move until 17:30 ET — after you can act. A short call assigned leaves you
//   short 100 shares per contract overnight on margin. Close by 15:45 at the latest.
//
// Pure: legs, entry, mark, spot and the clock in; verdict, numbers and advice out.

import { normalisePosition, targetToPrice, stopToPrice, pnlAt } from '../utils/ticketMath';
import { exitRuleFor, STOP_LOSS_PCT } from './data';
import { payoffShape } from './positionPlan';

const CASH = /^(SPX|SPXW|XSP|NDX|NDXP|RUT|RUTW|VIX|DJX|OEX|XEO)$/i;
export const cashSettled = u => CASH.test(String(u || '').trim());

/** Minutes since midnight, New York. */
export function nyMinutes(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(now).map(x => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

const T = { exitWindow: 14 * 60 + 30, exit: 15 * 60, lastCall: 15 * 60 + 45, bell: 16 * 60 };
const money = v => (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();

/**
 * @param p.legs       [{ strike, right, qty (signed, per lot) }]
 * @param p.qtyOpen    lots open
 * @param p.entry      { ncd (per share, + credit), maxProfit ($ per lot) }
 * @param p.now        { mark (per share, Σ qty×mid, signed value held), spot, sd (1σ points left, optional), at: Date }
 * @param p.underlying
 * @param p.strategy   engine strategy name
 * @param p.stopPct / p.targetPct  from the saved exit plan (optional)
 */
export function review0(p) {
  const { legs = [], qtyOpen = 1, entry = {}, now = {}, underlying = '', strategy = '' } = p;
  const out = { action: 'unknown', tone: 'grey', headline: '', steps: [], warnings: [], metrics: {} };
  const ncd = Number(entry.ncd) || 0;
  if (!legs.length || !ncd) { out.headline = !legs.length ? 'Legs not found — can’t check this one' : 'No entry price on the ticket'; return out; }
  if (!(now.spot > 0) || now.mark == null) { out.headline = 'No live quote — can’t check this one'; return out; }

  const rule0 = exitRuleFor('0DTE', strategy);
  const rule = p.targetPct > 0 ? { ...rule0, target: Math.round(+p.targetPct) } : rule0;
  const q = Math.max(1, Number(qtyOpen) || 1);
  const pos = normalisePosition({ qty: q, qtyOpen: q, entryPrice: ncd, maxProfit: entry.maxProfit > 0 ? entry.maxProfit * q : '', basis: rule.basis });
  const pnlShare = ncd + Number(now.mark);
  const pnl$ = Math.round(pnlShare * 100 * q);
  const targetPrice = targetToPrice(pos, rule.target);
  const target$ = Math.round(pnlAt(pos, targetPrice, q));
  const stopPct = p.stopPct > 0 ? +p.stopPct : STOP_LOSS_PCT;
  const stopPrice = stopToPrice(pos, stopPct);
  const stop$ = Math.round(pnlAt(pos, stopPrice, q));
  const closePrice = Math.max(0, pos.isCredit ? Math.abs(ncd) - pnlShare : Math.abs(ncd) + pnlShare);

  // What it settles at if price stays here, and the best it can do.
  const shape = payoffShape(legs, ncd);
  const atExpiry$ = shape ? Math.round(shape.pnlAt(now.spot) * 100 * q) : null;
  // Exactly, at the strikes — the payoff is piecewise linear, so its peak is on one.
  const max$ = shape ? Math.round(Math.max(shape.maxProfit, ...legs.map(l => shape.pnlAt(Number(l.strike)))) * 100 * q) : null;
  const inside = shape ? shape.pnlAt(now.spot) > 0 : null;
  const shorts = legs.filter(l => l.qty < 0).map(l => {
    const away = l.right === 'C' ? l.strike - now.spot : now.spot - l.strike;   // + = out of the money
    return { strike: l.strike, right: l.right, away: +away.toFixed(2), itm: away < 0,
      tested: away < 0, pressured: now.sd > 0 ? away < 0.5 * now.sd : away < now.spot * 0.002, cushion: away };
  });
  const near = [...shorts].sort((a, b) => Math.abs(a.away) - Math.abs(b.away))[0] || null;
  const cash = cashSettled(underlying);
  const mins = nyMinutes(now.at || new Date());
  const toExit = T.exit - mins, toBell = T.bell - mins, toLastCall = T.lastCall - mins;
  const phase = mins >= T.bell ? 'settled' : mins >= T.lastCall ? 'last' : mins >= T.exit ? 'after-exit' : mins >= T.exitWindow ? 'exit-window' : 'open';

  out.metrics = {
    pnl$, pnlShare: +pnlShare.toFixed(4), target$, targetPrice, stop$, stopPrice, stopPct, targetLabel: `${rule.target}% of ${rule.basis === 'entry' ? 'the entry' : 'max profit'}`,
    ncd, isCredit: pos.isCredit, closePrice: +closePrice.toFixed(2), atExpiry$, max$, inside, shorts, near,
    settle: cash ? 'cash' : 'shares', phase, minutesToExit: toExit, minutesToBell: toBell, minutesToLastCall: toLastCall,
    pnl$Lot: Math.round(pnlShare * 100),
  };
  const act = (action, tone, headline) => { out.action = action; out.tone = tone; out.headline = headline; };
  const S = out.steps;
  const gammaLine = near
    ? `Gamma is highest now: price is ${Math.abs(near.away).toFixed(2)} from the ${near.strike}${near.right} short${near.itm ? ' — through it' : ''}, and in the last hour a small move takes a big share of the value.`
    : 'Gamma is highest in the last hour: small moves swing a 0DTE position fastest.';
  const keepLine = max$ != null && pnl$ > 0
    ? `Closing now keeps ${money(pnl$)}; the most it can make is ${money(max$)}, only if price pins ${shape && shape.strikes.length >= 3 ? 'at the body' : 'in the best spot'} at 16:00.` : null;

  if (phase === 'settled') {
    act('record-expiry', 'grey', cash ? 'Expired — record the cash settlement' : 'Expired — check what was exercised or assigned');
    S.push(cash ? `Settled at ${money(atExpiry$ ?? pnl$)} if price closed here. Record it on the Sell ticket with Expired.`
      : `Settles into shares: any in-the-money leg was exercised or assigned — check TWS for a stock position before the next open.`);
    return out;
  }
  if (pnl$ >= target$ && target$ > 0) {
    act('take-profit', 'green', `Take profit — ${money(pnl$)} vs the ${money(target$)} target`);
    S.push(`Sell at ${closePrice.toFixed(2)} ${pos.isCredit ? 'debit' : 'credit'} or better (${out.metrics.targetLabel}).`);
    if (phase !== 'open') S.push(gammaLine);
    return out;
  }
  if (pnl$ <= stop$) {
    act('close', 'red', `At the stop — ${money(pnl$)} vs ${money(stop$)}`);
    S.push(`Close: the plan's stop is ${stopPct}% of the entry.`);
    return out;
  }

  if (!cash) {
    if (phase === 'last') {
      act('close', 'red', 'Close now — settles into shares, 15 minutes to the bell');
      S.push('Close before 16:00. An in-the-money short is assigned and an in-the-money long exercised after the bell, and the price can still move until 17:30 ET — after you can do anything about it.');
      if (shorts.some(s => s.itm || s.pressured)) S.push(`A short call assigned leaves you short ${100 * q} shares per short strike overnight (a short put, long ${100 * q}) — on margin, at tomorrow's open.`);
      return out;
    }
    if (phase === 'after-exit' || phase === 'exit-window') {
      act('watch', 'amber', phase === 'after-exit' ? 'Past the 15:00 exit — close by 15:45 at the latest' : 'Exit window — plan to be out by 15:00, 15:45 at the latest');
      S.push(gammaLine);
      if (keepLine) S.push(keepLine);
      S.push(`${underlying} settles into shares: don't hold an in-the-money short into the bell — assignment means a stock position on margin overnight.`);
      return out;
    }
  } else {
    // Cash settled: letting it expire is a real choice once the bell is close.
    const safe = near ? (now.sd > 0 ? Math.abs(near.away) > 1.0 * now.sd : Math.abs(near.away) > now.spot * 0.004) && !near.itm : true;
    const settleBetter = atExpiry$ != null && atExpiry$ >= pnl$;
    if (phase === 'last' || phase === 'after-exit') {
      if (safe && settleBetter) {
        act('hold', 'green', `Let it settle — cash settled, worth ${money(atExpiry$)} if price stays here`);
        S.push(`No assignment on ${underlying}: it settles in cash at the close. Price is ${near ? Math.abs(near.away).toFixed(1) + ' from the nearest short' : 'away from the strikes'}, so closing would only pay the spread and commission.`);
        return out;
      }
      act('watch', 'amber', near && near.itm ? 'Through a short — close or let it settle' : 'Near a strike into the close — close or let it settle');
      S.push(gammaLine);
      if (keepLine) S.push(keepLine);
      S.push(`${underlying} is cash settled — no assignment, so letting it expire is fine if you accept where it settles (${money(atExpiry$ ?? pnl$)} at this price).`);
      return out;
    }
    if (phase === 'exit-window') {
      act('watch', 'amber', 'Exit window — 15:00 managed exit');
      S.push(gammaLine);
      if (keepLine) S.push(keepLine);
      S.push(`Cash settled: if price is well clear of the strikes at 15:00, letting it expire is an option.`);
      return out;
    }
  }

  if (inside === false && near && (near.itm || near.pressured)) {
    act('watch', 'amber', near.itm ? `Through the ${near.strike}${near.right} — outside the profit zone` : `Close to the ${near.strike}${near.right} short`);
    S.push(`Stop at ${money(stop$)}; target ${money(target$)}. ${toExit > 0 ? `${Math.floor(toExit / 60)}h ${toExit % 60}m to the 15:00 exit.` : ''}`);
    return out;
  }
  act('hold', 'green', pnl$ >= 0 ? 'Hold — on plan' : 'Hold — inside the stop');
  S.push(`Target ${money(target$)} (sell at ${targetPrice.toFixed(2)}), stop ${money(stop$)}. ${toExit > 0 ? `${Math.floor(toExit / 60)}h ${toExit % 60}m to the 15:00 exit.` : ''}`);
  return out;
}
