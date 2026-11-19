/* Scan progress (Nov 2026): every name reports its stages, a failed name is marked and
   the scan carries on, Stop ends it between names, and the summary counts and times
   what is left. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchScanData } from '../utils/multiScan';
import { initProgress, applyEvent, summarise, etaText, scanStore, SCAN_STAGES } from '../utils/scanStatus';

afterEach(() => { vi.restoreAllMocks(); scanStore.clear(); });

const okBody = { price: 250, vix: 17, isLive: true };
function mockBridge({ fail = [], delay = 2 } = {}) {
  global.fetch = vi.fn(async (url) => {
    await new Promise(r => setTimeout(r, delay));
    const u = String(url);
    if (fail.some(f => u.includes('market-data?underlying=' + f))) return { status: 200, text: async () => JSON.stringify({ error: 'Not connected to TWS' }) };
    if (u.includes('/api/vol-surface')) return { status: 200, text: async () => JSON.stringify({ iv: 20, ivr: 30 }) };
    return { status: 200, text: async () => JSON.stringify(okBody) };
  });
}

describe('fetchScanData progress', () => {
  it('reports start and done for each stage of each name (45DTE: quotes, vol surface)', async () => {
    mockBridge();
    const ev = [];
    await fetchScanData({ mode: '45dte', underlyings: ['AAPL', 'AMD'], bridgeUrl: 'http://b', onProgress: e => ev.push(e) });
    for (const u of ['AAPL', 'AMD']) {
      expect(ev.filter(e => e.u === u).map(e => `${e.stage}${e.state[0]}`)).toEqual(['0s', '0d', '1s', '1d']);
    }
  });

  it('marks a name with no market data as an error and skips its later stages', async () => {
    mockBridge({ fail: ['NVDA'] });
    const ev = [];
    await fetchScanData({ mode: '45dte', underlyings: ['AAPL', 'NVDA'], bridgeUrl: 'http://b', onProgress: e => ev.push(e) });
    const nv = ev.filter(e => e.u === 'NVDA');
    expect(nv.map(e => e.state)).toEqual(['start', 'error']);
    expect(nv[1].error).toBe('Not connected to TWS');
    expect(ev.filter(e => e.u === 'AAPL').length).toBe(4);
  });

  it('stops between names when the signal aborts', async () => {
    mockBridge({ delay: 5 });
    const ctl = new AbortController();
    const ev = [];
    const p = fetchScanData({ mode: '45dte', underlyings: ['A', 'B', 'C', 'D', 'E', 'F'], bridgeUrl: 'http://b', signal: ctl.signal,
      onProgress: e => { ev.push(e); if (e.u === 'A' && e.state === 'done') ctl.abort(); } });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // Two in flight when Stop landed; nothing after them started.
    const started = new Set(ev.filter(e => e.state === 'start' && e.stage === 0).map(e => e.u));
    expect(started.size).toBeLessThanOrEqual(3);
    expect(started.has('F')).toBe(false);
  });
});

describe('progress record', () => {
  const t0 = 1_000_000;
  it('walks a name from waiting through its stages to done', () => {
    let p = initProgress({ mode: '0dte', list: ['SPY', 'QQQ'], label: 'ETFs · 0DTE', now: t0 });
    expect(p.stages).toEqual(SCAN_STAGES['0dte']);
    expect(summarise(p, t0).queue).toBe(2);
    p = applyEvent(p, { u: 'SPY', stage: 0, state: 'start', now: t0 });
    expect(p.tickers.SPY.status).toBe('work');
    p = applyEvent(p, { u: 'SPY', stage: 0, state: 'done', now: t0 + 1000 });
    p = applyEvent(p, { u: 'SPY', stage: 1, state: 'start', now: t0 + 1000 });
    let s = summarise(p, t0 + 2000);
    expect(s.current).toBe('SPY');
    expect(s.currentStage).toBe('Option chain');
    p = applyEvent(p, { u: 'SPY', stage: 1, state: 'done' });
    p = applyEvent(p, { u: 'SPY', stage: 2, state: 'done' });
    s = summarise(p, t0 + 3000);
    expect(p.tickers.SPY.status).toBe('done');
    expect(s.done).toBe(1);
    expect(s.frac).toBeCloseTo(0.5, 5);
    expect(s.eta).toBe(3);                         // 3 s for half → 3 s left
  });

  it('keeps a failed name failed and counts it as finished', () => {
    let p = initProgress({ mode: '45dte', list: ['A', 'B'], label: 'x', now: t0 });
    p = applyEvent(p, { u: 'A', stage: 0, state: 'error', error: 'no chain' });
    p = applyEvent(p, { u: 'A', stage: 1, state: 'done' });
    expect(p.tickers.A.status).toBe('error');
    const s = summarise(p, t0 + 1000);
    expect(s.err).toBe(1);
    expect(s.frac).toBeCloseTo(0.5, 5);
  });

  it('flags a stage that has run past 20 s as stalled', () => {
    let p = initProgress({ mode: '45dte', list: ['A'], label: 'x', now: t0 });
    p = applyEvent(p, { u: 'A', stage: 1, state: 'start', now: t0 });
    expect(summarise(p, t0 + 5000).stalled).toBe(false);
    expect(summarise(p, t0 + 21000).stalled).toBe(true);
  });

  it('spreads the bar over every group in Scan everything', () => {
    const p = initProgress({ mode: '45dte', list: ['A'], label: 'x', master: { i: 3, n: 6 }, now: t0 });
    expect(summarise(p, t0).overall).toBeCloseTo(2 / 6, 5);
  });

  it('ignores events for names it is not scanning', () => {
    const p = initProgress({ mode: '45dte', list: ['A'], label: 'x', now: t0 });
    expect(applyEvent(p, { u: 'Z', stage: 0, state: 'start' })).toBe(p);
  });

  it('says the time left in words', () => {
    expect(etaText(null)).toBe('');
    expect(etaText(38)).toBe('about 40 s left');
    expect(etaText(2)).toBe('about 5 s left');
    expect(etaText(130)).toBe('about 2 min left');
  });
});
