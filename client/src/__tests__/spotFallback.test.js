/* Where the vol-surface route gets a price, and what it says when it cannot get one.

   QQQ returned no price on 14 Oct. The bridge log settled why, and it was not the first
   guess (a missing entitlement). The SAME QQQ/STK contract answers under one market data
   type and not the other:

     type 3 (/api/market-data)   snap QQQ/STK: bid=753.87 ask=753.91 ... delayed=true
     type 2 (/api/vol-surface)   snap QQQ/STK (timeout): bid=0 ask=0 last=0 close=0
     type 2, options             snap QQQ/OPT: bid=1 ask=1.01 ... delayed=false

   The account holds QQQ equity DELAYED and the options real-time on OPRA. Frozen (2)
   serves the last real-time snapshot, so for a delayed-only line it has nothing to
   serve and no error to raise. reqMarketDataType is connection-level, so vol-surface's
   choice of frozen — right for the greeks — governed its cash snapshot too.

   A spot of zero is not a small gap: `toward` for a put is (spot − strike), so it put
   every short put in the money and turned the check-up upside down. */
import { describe, it, expect } from 'vitest';
import { resolveSpot } from '../../../bridge/volSurface.js';

const QQQ_BARS = [
  ['20261009', 736.1, 741.0, 735.2, 740.4],
  ['20261013', 740.5, 744.8, 739.1, 742.33],
];
const forQQQ = (snap, extra = {}) => resolveSpot({
  snap, daily: QQQ_BARS, dailySource: 'QQQ', underlying: 'QQQ', secType: 'STK', ...extra });

describe('resolveSpot — live price', () => {
  it('prefers the mid, then the last, then the session close', () => {
    expect(forQQQ({ mid: 742.5, last: 742.4, prevClose: 740.4 })).toMatchObject({ spot: 742.5, source: 'mid' });
    expect(forQQQ({ last: 742.4, prevClose: 740.4 })).toMatchObject({ spot: 742.4, source: 'last' });
    expect(forQQQ({ prevClose: 740.4 })).toMatchObject({ spot: 740.4, source: 'close' });
  });

  it('takes a caller-supplied spot without asking anything else', () => {
    const r = resolveSpot({ caller: 742.1, snap: { mid: 1 }, underlying: 'QQQ' });
    expect(r).toMatchObject({ spot: 742.1, source: 'caller', note: null });
  });

  it('never adds a note when it has a live price', () => {
    expect(forQQQ({ mid: 742.5 }).note).toBeNull();
  });
});

describe('resolveSpot — the QQQ outage', () => {
  // The symptom: frozen data for an unentitled STK line delivers no tick of any kind.
  const EMPTY = { noTicks: true, notSubscribed: true };

  it('falls back to the last daily close instead of returning zero', () => {
    const r = forQQQ(EMPTY);
    expect(r.spot).toBeCloseTo(742.33, 2);
    expect(r.source).toBe('daily-close');
    expect(r.asOf).toBe('20261013');
  });

  it('says the price is stale rather than passing it off as live', () => {
    expect(forQQQ(EMPTY).note).toMatch(/stale spot/i);
    expect(forQQQ(EMPTY).note).toMatch(/20261013/);
  });

  it('refuses a proxy underlying — a price is not a ratio', () => {
    // SPX reads SPY bars for the trend because every trend number is a ratio or a
    // percentage. SPY is a tenth of SPX, so borrowing its close would be wrong, not stale.
    const r = resolveSpot({ snap: EMPTY, daily: QQQ_BARS, dailySource: 'SPY',
      underlying: 'SPX', secType: 'IND' });
    expect(r.spot).toBe(0);
    expect(r.source).toBeNull();
  });
});

describe('resolveSpot — naming the cause', () => {
  const noBars = extra => resolveSpot({ daily: [], dailySource: 'QQQ', underlying: 'QQQ', secType: 'STK', ...extra });

  it('blames frozen-on-a-delayed-line when that is what was asked for', () => {
    // The 14 Oct case. No error code was raised, because nothing was unsubscribed —
    // which is exactly why the first explanation (a missing entitlement) was wrong.
    const r = noBars({ snap: { noTicks: true }, requestedType: 2 });
    expect(r.note).toMatch(/frozen/i);
    expect(r.note).toMatch(/delayed-only/i);
    expect(r.note).not.toMatch(/data farms/i);
  });

  it('blames the feed only once frozen has been ruled out', () => {
    const r = noBars({ snap: { noTicks: true }, requestedType: 3 });
    expect(r.note).toMatch(/data farms|too slow/i);
    expect(r.note).toMatch(/restarting the bridge will not fix/i);
  });

  it('still reports a real missing entitlement ahead of either', () => {
    expect(noBars({ snap: { notSubscribed: true, noTicks: true }, requestedType: 2 }).note).toMatch(/entitlement/i);
  });

  it('still returns a note when there is nothing to go on at all', () => {
    const r = noBars({ snap: {} });
    expect(r.spot).toBe(0);
    expect(r.note).toMatch(/no price for QQQ/i);
  });

  it('ignores zero and negative placeholder ticks', () => {
    // TWS sends -1 for "no value"; treating it as a price put spot below every strike.
    expect(forQQQ({ mid: 0, last: -1, prevClose: -1 }).source).toBe('daily-close');
  });
});
