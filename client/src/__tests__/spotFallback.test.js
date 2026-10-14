/* Where the vol-surface route gets a price, and what it says when it cannot get one.

   QQQ returned no price on 14 Oct. The route asks TWS for market data type 2 (frozen)
   so model greeks keep resolving after the close, but frozen returns nothing at all for
   an instrument the account cannot stream — and QQQ/SPY/IWM are STK/SMART, a separate
   entitlement from the OPRA options bundle. /api/market-data had already met this and
   falls back to the last bar; /api/vol-surface pulled a year of daily bars in parallel
   and used the last close for nothing but the trend.

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

  it('distinguishes a missing entitlement from a dead feed', () => {
    expect(noBars({ snap: { notSubscribed: true, noTicks: true } }).note).toMatch(/entitlement/i);
    expect(noBars({ snap: { noTicks: true } }).note).toMatch(/data farms|too slow/i);
  });

  it('tells the reader a bridge restart will not fix the TWS end', () => {
    expect(noBars({ snap: { noTicks: true } }).note).toMatch(/restarting the bridge will not fix/i);
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
