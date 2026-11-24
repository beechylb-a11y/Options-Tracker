/* A dead stream line (25 Nov 2026): XSP's quote stopped at 723.72 and the ticket priced
   off it for 18 hours as "live". In market hours a quote over 10 min old is not live. */
import { describe, it, expect } from 'vitest';
import { quoteStale, rthOpen, streamPrice, STALE_RTH_MS } from '../live/streamQuotes';

const tue1037 = new Date('2026-11-24T15:37:00Z');   // 10:37 New York
const tue0300 = new Date('2026-11-24T08:00:00Z');   // 03:00 New York
const sat = new Date('2026-11-28T15:37:00Z');

describe('stale underlying', () => {
  it('market hours in New York', () => {
    expect([rthOpen(tue1037), rthOpen(tue0300), rthOpen(sat)]).toEqual([true, false, false]);
  });
  it('over 10 min old in market hours is stale; closed market keeps the last value', () => {
    const old = { ts: tue1037.getTime() - 1114 * 60000, last: 723.72, mark: 723.72 };
    expect(quoteStale(old, tue1037)).toBe(true);
    expect(quoteStale({ ts: tue1037.getTime() - 60000 }, tue1037)).toBe(false);
    expect(quoteStale(old, sat)).toBe(false);
    expect(STALE_RTH_MS).toBe(600000);
  });
  it('streamPrice drops the dead line', () => {
    const state = { connection: 'open', status: { connected: true }, quotes: { XSP: { ts: tue1037.getTime() - 1114 * 60000, mark: 723.72 }, SPX: { ts: tue1037.getTime() - 2000, mark: 7184.41 } } };
    expect(streamPrice('XSP', state, tue1037)).toBeNull();
    expect(streamPrice('SPX', state, tue1037)).toBe(7184.41);
  });
});
