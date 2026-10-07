/* Scan fetches (Oct 2026): a slow or failing bridge says why on the row instead of
   leaving it blank, and the tickers are fetched two at a time. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchScanData, computeScan } from '../utils/multiScan';

afterEach(() => vi.restoreAllMocks());

describe('scan fetch', () => {
  it('explains a failed ticker and keeps the others', async () => {
    let inflight = 0, peak = 0;
    global.fetch = vi.fn(async (url) => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise(r => setTimeout(r, 5));
      inflight--;
      const u = String(url);
      if (u.includes('underlying=NVDA')) return { status: 200, text: async () => JSON.stringify({ error: 'Not connected to TWS' }) };
      if (u.includes('underlying=TSLA')) return { status: 404, text: async () => 'Cannot GET /api/market-data' };
      return { status: 200, text: async () => JSON.stringify({ price: 250, vix: 17, isLive: true }) };
    });
    const list = ['AAPL', 'NVDA', 'TSLA', 'AMD'];
    const { mergedData } = await fetchScanData({ mode: '0dte', underlyings: list, bridgeUrl: 'http://b' });
    expect(peak).toBeLessThanOrEqual(2);
    const rows = computeScan('0dte', list, mergedData);
    const byU = Object.fromEntries(rows.map(r => [r.underlying, r]));
    expect(byU.NVDA.error).toBe('Bridge: Not connected to TWS');
    expect(byU.TSLA.error).toMatch(/older version/);
    expect(byU.AAPL.result).toBeTruthy();
  });
});
