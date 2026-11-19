/* Bridge vol-history cache (20 Nov 2026): a pull that came back without the IV series
   is retried after 2 minutes, not held for 30 — one slow TWS answer mid-scan used to
   leave a name without IV rank for half an hour. */
import { describe, it, expect } from 'vitest';
import { histTtl, HIST_TTL_MS, HIST_RETRY_MS } from '../../../bridge/volSurface.js';

describe('vol history cache life', () => {
  it('a full pull keeps 30 min; one missing the IV series keeps 2 min', () => {
    expect(HIST_TTL_MS).toBe(30 * 60 * 1000);
    expect(HIST_RETRY_MS).toBe(2 * 60 * 1000);
    expect(histTtl({ iv: [31.2, 30.8], hv: [25], daily: [{}] })).toBe(HIST_TTL_MS);
    expect(histTtl({ iv: [], hv: [25], closes: [1, 2], daily: [{}] })).toBe(HIST_RETRY_MS);
    expect(histTtl({ hv: [25] })).toBe(HIST_RETRY_MS);
    expect(histTtl(null)).toBe(HIST_RETRY_MS);
  });
});
