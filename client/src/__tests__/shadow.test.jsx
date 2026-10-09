/* Shadow verdicts (Oct 2026): every engine verdict is kept and settled against the
   close, so blocked and skipped trades can be judged by what they would have made. */
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { shadowLegs, pnlAtExpiry, fairNet0, categoryOf, closeOn, expiryPassed, shadowSummary, legsKey } from '../engine/shadow';

const recorded = [], settled = [];
let SHADOW = [];
vi.mock('../utils/api', () => ({ api: {
  recordShadow: v => { recorded.push(v); return Promise.resolve({ id: 1 }); },
  getShadow: () => Promise.resolve(SHADOW),
  settleShadow: items => { settled.push(...items); return Promise.resolve({ settled: items.length }); },
} }));
import { settleShadows } from '../utils/shadowSettle';
import EnginePanel from '../components/EnginePanel';

const condorLegs = [{ label: 'Long put', strike: 699 }, { label: 'Short put', strike: 709 }, { label: 'Short call', strike: 805 }, { label: 'Long call', strike: 815 }];

describe('shadow maths', () => {
  it('signs legs, prices expiry and the fair entry', () => {
    const L = shadowLegs(condorLegs);
    expect(legsKey(L)).toBe('+1699P -1709P -1805C +1815C');
    expect(pnlAtExpiry(L, 5.81, 760)).toBe(581);            // inside: keep the credit
    expect(pnlAtExpiry(L, 5.81, 690)).toBe(-419);           // through the put wing
    const fly = shadowLegs([{ label: 'Long call', strike: 749 }, { label: 'Short call x2', strike: 754 }, { label: 'Long call', strike: 762 }]);
    expect(fly.map(l => l.qty)).toEqual([1, -2, 1]);
    const f = fairNet0(fly, 754, 3.4);
    expect(f).toBeLessThan(0);                              // a debit
    expect(Math.abs(f)).toBeLessThan(5);
  });
  it('buckets verdicts, taken first', () => {
    expect(categoryOf({ blockers: ['Gamma risk too high'], verdictWord: 'Blocked' })).toBe('blocked');
    expect(categoryOf({ blockers: [], verdictWord: 'Pass at this price' })).toBe('pass');
    expect(categoryOf({ blockers: [], verdictWord: 'Take the trade' })).toBe('trade');
    expect(categoryOf({ blockers: [], missingInputs: true })).toBe('unsized');
    expect(categoryOf({ blockers: ['x'], logged: true })).toBe('taken');
  });
  it('knows when an expiry is over and finds the close', () => {
    expect(expiryPassed('20261008', new Date('2026-10-08T20:30:00Z'))).toBe(true);    // 16:30 ET
    expect(expiryPassed('20261008', new Date('2026-10-08T19:00:00Z'))).toBe(false);   // 15:00 ET
    expect(closeOn([{ date: '20261008', close: 758.3 }], '20261008')).toBe(758.3);
    expect(closeOn([{ date: '20261007', close: 758.3 }], '20261008')).toBeNull();
  });
  it('summarises by verdict', () => {
    const s = shadowSummary([
      { category: 'blocked', settled_at: 'x', pnl_per_ct: -100 }, { category: 'blocked', settled_at: 'x', pnl_per_ct: 50 },
      { category: 'blocked' }, { category: 'taken', settled_at: 'x', pnl_per_ct: 80 }]);
    expect(s.blocked).toMatchObject({ n: 3, settled: 2, wins: 1, winRate: 0.5, avg: -25 });
    expect(s.taken.avg).toBe(80);
  });
});

describe('settle pass', () => {
  afterEach(() => { settled.length = 0; vi.restoreAllMocks(); });
  it('prices expired verdicts from the daily close and leaves the rest', async () => {
    SHADOW = [
      { id: 1, underlying: 'QQQ', expiry: '20261008', entry_net: 5.81, legs: shadowLegs(condorLegs) },
      { id: 2, underlying: 'QQQ', expiry: '20991231', entry_net: 1, legs: shadowLegs(condorLegs) },
    ];
    global.fetch = vi.fn(async () => ({ text: async () => JSON.stringify({ bars: [{ date: '20261008', close: 760 }] }) }));
    const res = await settleShadows('acct', { bridgeUrl: 'http://bridge', now: new Date('2026-10-09T15:00:00Z') });
    expect(res.settled).toBe(1);
    expect(settled).toEqual([{ id: 1, settleDate: '20261008', settlePrice: 760, pnlPerCt: 581, source: 'close' }]);
  });
});

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '250', delta: '-4', gamma: '-1.2', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, netCreditDebit: '6.36', win: '636', risk: '3364', pop: '92',
};
describe('the ticket records its verdict', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); recorded.length = 0; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });
  it('after 20 s unchanged, once, with the blocker and the typed entry', async () => {
    render(<EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }} strategyHistory={{}}
      toast={() => {}} initialState={{ i0: base }} />);
    await act(async () => { vi.advanceTimersByTime(19000); });
    expect(recorded.length).toBe(0);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(recorded.length).toBe(1);
    const v = recorded[0];
    expect(v).toMatchObject({ engine: '0DTE', underlying: 'SPX', account: 'acct', category: 'blocked', entrySource: 'ticket', entryNet: 6.36, expiry: '20261002' });
    expect(v.blockers).toMatch(/Gamma risk too high/);
    expect(v.legs.length).toBeGreaterThanOrEqual(3);
    expect(v.sig).toMatch(/^2026-10-02\|0DTE\|SPX\|/);
    await act(async () => { vi.advanceTimersByTime(60000); });
    expect(recorded.length).toBe(1);
  });
});
