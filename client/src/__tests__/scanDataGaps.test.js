/* Data gaps (25 Nov 2026): a scan name whose vol surface came back short is asked once
   more on its own, the retry fills only what was missing, what is still missing is named
   on the row, and a row without IV / IV rank / term never ranks as BEST. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchScanData, computeScan, volShort, mergeVol } from '../utils/multiScan';

afterEach(() => { vi.restoreAllMocks(); });

const full = { iv: 22, ivr: 55, hv: 18, ivFront: 23, ivBack: 21, skew: 6, termBias: 'backwardation', termRatio: 1.1, daily: [['20261124', 1, 2, 1, 2]] };

describe('scan data gaps', () => {
  it('volShort names what a pull lacks; mergeVol lays a retry over the first', () => {
    expect(volShort(full)).toEqual([]);
    expect(volShort({ ivr: 56, hv: 21, daily: [] })).toEqual(['IV', 'skew', 'term', 'daily bars']);
    expect(volShort({ error: 'x' })).toEqual(['vol surface']);
    const m = mergeVol({ ivr: 56, hv: 21, daily: [] }, full);
    expect(m.iv).toBe(22); expect(m.ivr).toBe(56); expect(m.termBias).toBe('backwardation'); expect(m.daily.length).toBe(1);
  });

  it('retries a short name once and keeps what is still missing on the row', async () => {
    const calls = {};
    global.fetch = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/api/vol-surface')) {
        const sym = u.match(/underlying=(\w+)/)[1];
        calls[sym] = (calls[sym] || 0) + 1;
        if (sym === 'GOOGL') return { status: 200, text: async () => JSON.stringify(calls[sym] === 1 ? { ivr: 95, daily: [] } : full) };
        if (sym === 'AMD') return { status: 200, text: async () => JSON.stringify({ ivr: 79, hv: 30, daily: [] }) };
        return { status: 200, text: async () => JSON.stringify(full) };
      }
      return { status: 200, text: async () => JSON.stringify({ price: 250, vix: 27, isLive: true }) };
    });
    const { mergedData } = await fetchScanData({ mode: '45dte', underlyings: ['NVDA', 'GOOGL', 'AMD'], bridgeUrl: 'http://b' });
    expect(calls).toEqual({ NVDA: 1, GOOGL: 2, AMD: 2 });
    expect(mergedData.GOOGL._volMissing).toBe(undefined);
    expect(mergedData.GOOGL.iv).toBe('22');
    expect(mergedData.AMD._volMissing).toEqual(['IV', 'skew', 'term', 'daily bars']);
    expect(mergedData.AMD._volRetried).toBe(true);
    const rows = computeScan('45dte', ['NVDA', 'GOOGL', 'AMD'], mergedData);
    expect(rows[rows.length - 1].underlying).toBe('AMD');   // incomplete goes last
    expect(rows[rows.length - 1].data._volMissing).toContain('IV');
  });
});
