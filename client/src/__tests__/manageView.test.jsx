/* Manage view for an open trade (Nov 2026, phase 4): stream quotes, the position's
   chart inputs, the verdict and its one action, working orders, the trade story. */
import { describe, it, expect } from 'vitest';
import { liveQuotesFor, legKeysOf, positionCurve, manageVerdict, positionOrders, tradeStory, IDPH } from '../engine/manageView';
import { positionRisk } from '../engine/portfolio';
import { payoffSeries, whereIsPrice } from '../engine/tradeView';
import { pnlAt, curveAt } from '../engine/payoffCurve';
import { INTRADAY_DAYS_PER_HOUR } from '../components/PayoffChart';

const NOW = new Date('2026-10-21T14:38:00Z');           // 10:38 New York
const legs0 = [[6700, 'P', 1], [6740, 'P', -1], [6740, 'C', -1], [6780, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261021' }));
const fly = { engine: '0DTE', strategy: 'Iron Butterfly', underlying: 'SPX', live: 1, qty: 1, expiry: '20261021', legs: legs0,
  pos: { ncd: 24.5, isCredit: true }, entry: { spot: 6738 } };
const mid = { '6700P': 0.6, '6740P': 9.2, '6740C': 19.0, '6780C': 1.4 };
const quotesFor = (p, extra = {}) => {
  const q = {};
  legKeysOf(p).forEach((k, i) => { const m = mid[p.legs[i].strike + p.legs[i].right]; q[k] = { bid: m - 0.05, ask: m + 0.05, mark: m, iv: 13, delta: 0.1, theta: -1, ts: 1000 + i }; });
  q.SPX = { last: 6751, mark: 6751, ts: 999 };
  return { ...q, ...extra };
};

describe('stream quotes in the option-greeks shape', () => {
  it('values the position off the stream exactly as from polling', () => {
    const sq = liveQuotesFor(fly, quotesFor(fly));
    expect(sq.undPrice).toBe(6751);
    expect(sq.ts).toBe(1000);
    const r = positionRisk(fly, sq, { now: NOW });
    expect(r.markSource).toBe('quotes');
    expect(Math.round(r.pnl)).toBe(-170);          // buy back at 26.20 against a 24.50 credit
    expect(r.greeksSource).toBe('quotes');
  });
  it('null while any leg has no price, so the model is used instead of half a mark', () => {
    const q = quotesFor(fly); delete q[legKeysOf(fly)[2]];
    expect(liveQuotesFor(fly, q)).toBeNull();
  });
});

describe('position curve', () => {
  it('0DTE: trading clock to the bell, the 15:00 exit, and the now curve through the market mark', () => {
    expect(IDPH).toBeCloseTo(INTRADAY_DAYS_PER_HOUR, 12);
    const r = positionRisk(fly, liveQuotesFor(fly, quotesFor(fly)), { now: NOW });
    const c = positionCurve(fly, r.legs, r.spot, { now: NOW });
    expect(c.intraday).toBe(true);
    expect(c.closeEt).toBe('15:00');
    expect(c.nearDte).toBeCloseTo((5 + 22 / 60) * IDPH, 6);
    expect(c.closeDay).toBeCloseTo((4 + 22 / 60) * IDPH, 6);
    // same value now as the calendar-time model on the same live IVs
    const s = payoffSeries(fly, r.legs, r.spot, { now: NOW });
    expect(pnlAt(c.cl, 6751, c.net, 0)).toBeCloseTo(s.nowAt(6751), 0);
    expect(c.lo).toBeLessThan(6700); expect(c.hi).toBeGreaterThan(6780);
    // before the open the clock starts at 09:30, not at 08:00
    const pre = positionCurve(fly, r.legs, r.spot, { now: new Date('2026-10-21T12:00:00Z') });
    expect(pre.nearDte).toBeCloseTo(6.5 * IDPH, 6);
    expect(pre.closeDay).toBeCloseTo(5.5 * IDPH, 6);
  });
  it('45DTE: all lots, the planned close, and the banked roll money', () => {
    const legs = [[699, 'P', 1], [709, 'P', -1], [755, 'C', -1], [765, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120', iv: 21 }));
    const c45 = { engine: '45DTE', strategy: 'Iron Condor - Normal', underlying: 'QQQ', live: 5, qty: 5, expiry: '20261120', legs,
      pos: { ncd: 3.77, isCredit: true }, entry: {} };
    const c = positionCurve(c45, legs, 722.51, { now: NOW });
    expect(c.intraday).toBe(false);
    expect(c.lots).toBe(5);
    expect(c.closeDte).toBe(21);
    expect(c.closeDay).toBeGreaterThan(8.9); expect(c.closeDay).toBeLessThan(9.3);   // 30 Oct close
    const exp = curveAt(c.cl, { net: c.net, lo: 700, hi: 760, days: c.nearDte });
    expect(Math.round(exp.maxProfit)).toBe(1885);
    const banked = positionCurve(c45, legs, 722.51, { now: NOW, banked: 300 });
    expect(Math.round(curveAt(banked.cl, { net: banked.net, lo: 700, hi: 760, days: banked.nearDte }).maxProfit)).toBe(2185);
  });
});

describe('verdict and its one action', () => {
  const base = { engine: '45DTE', working: false, pnl: 200, stopLoss: -1800, targetGain: 900, where: null, daysToClose: 12, canRoll: true, markSource: 'quotes' };
  it('holds when nothing has fired', () => {
    const v = manageVerdict(base);
    expect(v).toMatchObject({ tone: 'green', title: 'On plan — hold', action: null });
    expect(v.why).toMatch(/\$700 to the target · \$2,000 of room to the stop/);
  });
  it('stop beats target beats time; stops are information only', () => {
    expect(manageVerdict({ ...base, pnl: -1900 })).toMatchObject({ tone: 'red', action: 'close', title: 'Stop reached — close it' });
    expect(manageVerdict({ ...base, pnl: -1900 }).why).toMatch(/not sent to TWS/);
    expect(manageVerdict({ ...base, pnl: 950, daysToClose: 0 })).toMatchObject({ title: 'Close day reached — roll it', action: 'roll' });
    expect(manageVerdict({ ...base, pnl: 950 })).toMatchObject({ tone: 'green', action: 'close', title: 'Target reached — take the profit' });
  });
  it('45DTE close day: roll when it can, close when it cannot', () => {
    expect(manageVerdict({ ...base, daysToClose: 3 })).toMatchObject({ tone: 'amber', action: 'roll', title: 'Close day in 3 days' });
    expect(manageVerdict({ ...base, daysToClose: 3, closeDte: 21, closeYmd: '20261120' }).why).toBe('The 21-DTE close is on 20 Nov — roll it out or close it before then.');
    expect(manageVerdict({ ...base, daysToClose: 0, canRoll: false })).toMatchObject({ tone: 'red', action: 'close' });
  });
  it('0DTE: the managed exit time', () => {
    const z = { ...base, engine: '0DTE', daysToClose: null, canRoll: false };
    expect(manageVerdict({ ...z, minsToExit: 20 })).toMatchObject({ tone: 'amber', action: 'close', title: 'Time exit in 20 min' });
    expect(manageVerdict({ ...z, minsToExit: -5 })).toMatchObject({ tone: 'red', title: 'Time exit passed — close now' });
    expect(manageVerdict({ ...z, minsToExit: 200 }).title).toBe('On plan — hold');
  });
  it('short strikes: breached and tested', () => {
    const s = payoffSeries({ engine: '45DTE', strategy: 'Iron Condor - Normal', live: 1, qty: 1, expiry: '20261120', pos: { ncd: 3.77 }, entry: {} },
      [[699, 'P', 1], [709, 'P', -1], [755, 'C', -1], [765, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120', iv: 21 })), 706, { now: NOW });
    const v = manageVerdict({ ...base, where: whereIsPrice(s, 706) });
    expect(v).toMatchObject({ tone: 'red', title: 'Short 709P breached', action: 'roll' });
  });
  it('a working order and a missing mark', () => {
    expect(manageVerdict({ ...base, working: true })).toMatchObject({ tone: 'purple', action: null });
    expect(manageVerdict({ ...base, pnl: null }).tone).toBe('grey');
    expect(manageVerdict({ ...base, markSource: 'model' }).alerts.map(a => a.tone)).toEqual(['grey']);
  });
});

describe('working orders and the story', () => {
  it('keeps live orders on this underlying, this ticket first, finished ones out', () => {
    const orders = [
      { orderId: 7, symbol: 'SPX', status: 'Submitted', ref: 'SB-12' },
      { orderId: 8, symbol: 'SPX', status: 'PreSubmitted', ref: 'SB-60' },
      { orderId: 9, symbol: 'SPX', status: 'Filled', ref: 'SB-60' },
      { orderId: 10, symbol: 'QQQ', status: 'Submitted' },
    ];
    const out = positionOrders(orders, { ...fly, ticketRef: 60 });
    expect(out.map(o => o.orderId)).toEqual([8, 7]);
    expect(out[0].mine).toBe(true);
  });
  it('the roll chain as steps, ending at the open ticket', () => {
    const p = { ...fly, chain: { links: [{ strikes: '6680/6720/6760', realised: -120, entryYmd: '20261020', closeYmd: '20261021' }], banked: -120, rolls: 1 } };
    const st = tradeStory(p, 300);
    expect(st.steps.map(s => s.kind)).toEqual(['opened', 'now']);
    expect(st.steps[1].strikes).toBe('6700P/6740P/6740C/6780C');
    expect(tradeStory({ ...p, row: { legs: '6700 / 6740 / 6780' } }, 300).steps[1].strikes).toBe('6700/6740/6780');
    expect(st.total).toBe(180);
    expect(tradeStory(fly, 0)).toBeNull();
  });
});
