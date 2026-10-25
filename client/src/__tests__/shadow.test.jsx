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
    // held to expiry, less the entry commission (4 legs × $0.65; nothing to pay at expiry)
    expect(settled).toEqual([{ id: 1, settleDate: '20261008', settlePrice: 760, pnlPerCt: 578.4, commission: 2.6, source: 'close-net' }]);
  });

  /* Every SPX and XSP verdict sat unsettled for weeks. The pass was running and working:
     it settled the equities in the same batch and reported "N settled · M still waiting
     for a close", which is what it also says about a trade that has not expired yet. The
     bridge returned no bars for the index underlyings and nothing named them. */
  it('names the underlyings whose bars never arrived, instead of calling them pending', async () => {
    SHADOW = [
      { id: 1, underlying: 'IWM', expiry: '20261022', entry_net: -1.52, legs: shadowLegs(condorLegs) },
      { id: 2, underlying: 'SPX', expiry: '20261022', entry_net: -16.05, legs: shadowLegs(condorLegs) },
      { id: 3, underlying: 'XSP', expiry: '20261021', entry_net: -2.5, legs: shadowLegs(condorLegs) },
    ];
    global.fetch = vi.fn(async (u) => ({
      text: async () => JSON.stringify(/IWM/.test(u) ? { bars: [{ date: '20261022', close: 276.67 }] } : { bars: [] }),
    }));
    const res = await settleShadows('acct', { bridgeUrl: 'http://bridge', now: new Date('2026-10-23T15:00:00Z') });
    expect(res.settled).toBe(1);
    expect(res.noBars.sort()).toEqual(['SPX', 'XSP']);
    expect(settled.map(s => s.id)).toEqual([1]);
  });

  // Step 4 (Oct 2026): an already settled and managed 0DTE verdict still gets its
  // strike-distance × exit lesson, once, from the day's 5-minute bars.
  it('learns strike distance × exit from a 0DTE session already settled', async () => {
    SHADOW = [{ id: 7, engine: '0DTE', underlying: 'SPX', strategy: 'Bull put spread', session_date: '2026-10-23', expiry: '20261023',
      first_seen: '2026-10-23T14:30:00Z', spot: 6600, entry_net: 3.5, settled_at: 'x', managed_at: 'x',
      legs: [{ strike: 6560, right: 'P', qty: -1 }, { strike: 6540, right: 'P', qty: 1 }],
      inputs: { sdLeft: 45, hours: 5.5, vix1d: 15, vix: 17, emSource: 'straddle' } }];
    const intraday = [];
    for (let m = 570; m <= 960; m += 5) intraday.push({ date: `20261023  ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`, close: 6600 + (m - 570) / 20 });
    global.fetch = vi.fn(async (u) => ({ text: async () => JSON.stringify({ bars: /5%20mins/.test(u) ? intraday : [{ date: '20261023', close: 6619.5 }] }) }));
    const res = await settleShadows('acct', { bridgeUrl: 'http://bridge', now: new Date('2026-10-24T15:00:00Z') });
    expect(res.settled).toBe(1);
    expect(settled).toHaveLength(1);
    expect(settled[0].id).toBe(7);
    expect(settled[0].pnlPerCt).toBeUndefined();
    expect(settled[0].learn.grid).toHaveLength(6);
    expect(settled[0].learn.exits.hold.pnl).toBe(349);
    expect(settled[0].learn.model.close).toBe(6619.5);
  });

  it('reports no empty underlyings when every request answers', async () => {
    SHADOW = [{ id: 1, underlying: 'QQQ', expiry: '20261008', entry_net: 5.81, legs: shadowLegs(condorLegs) }];
    global.fetch = vi.fn(async () => ({ text: async () => JSON.stringify({ bars: [{ date: '20261008', close: 760 }] }) }));
    const res = await settleShadows('acct', { bridgeUrl: 'http://bridge', now: new Date('2026-10-09T15:00:00Z') });
    expect(res.noBars).toEqual([]);
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
