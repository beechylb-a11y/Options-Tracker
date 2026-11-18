/* Polling screens read the push stream first (Nov 2026): the check-up pass, the
   dashboard board's P&L, portfolio risk and trade details. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamQuotesFor, streamPrice, markFromStream } from '../live/streamQuotes';
import { createLiveStore, liveKey } from '../live/liveStore';
import { boardRow } from '../components/PositionBoard';

const legs = [[700, 'P', 1], [710, 'P', -1], [760, 'C', -1], [770, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261211' }));
const mids = { '700P': 1.6, '710P': 2.9, '760C': 2.4, '770C': 1.2 };
function seeded(connection = 'open', drop = null) {
  const st = createLiveStore();
  const quotes = { QQQ: { last: 735.4, mark: 735.4, ts: Date.now() } };
  for (const l of legs) {
    const k = liveKey('QQQ', l.expiry, l.strike, l.right);
    if (k === drop) continue;
    const m = mids[l.strike + l.right];
    quotes[k] = { bid: m - 0.05, ask: m + 0.05, mark: m, delta: 0.1, iv: 20, ts: Date.now() };
  }
  st.setConnection(connection);
  st.applySnapshot({ seq: 1, status: { connected: true }, quotes });
  return st.getState();
}

describe('stream quotes', () => {
  it('every leg priced and the stream open → the option-greeks shape; otherwise null', () => {
    const sq = streamQuotesFor('QQQ', legs, seeded());
    expect(sq.legs).toHaveLength(4);
    expect(sq.undPrice).toBe(735.4);
    expect(markFromStream(legs, sq)).toBeCloseTo(1.6 - 2.9 - 2.4 + 1.2, 10);
    expect(streamQuotesFor('QQQ', legs, seeded('down'))).toBeNull();
    expect(streamQuotesFor('QQQ', legs, seeded('open', 'QQQ 20261211 760 C'))).toBeNull();
    expect(streamPrice('qqq', seeded())).toBe(735.4);
    expect(streamPrice('QQQ', seeded('off'))).toBeNull();
  });
});

describe('board P&L between check-ups', () => {
  const row = { ticketRef: 61, underlying: 'QQQ', engine: '45DTE', strategy: 'QQQ - Iron Condor - Normal', legs: '700 / 710 / 760 / 770',
    qty: 3, qtyOpen: 3, qtyFilled: 3, entryPrice: 3.6, status: 'Open', realisedPnl: '' };
  const check = { legs, review: { action: 'hold', tone: 'green', metrics: { ncd: 3.6, pnl$: 100 } } };
  it('re-marks with the stream when it prices the legs, else keeps the check-up figure', () => {
    const live = boardRow(row, { check, liveMark: -2.5 });
    expect(live.ticketPnl).toBe(330);                 // (3.60 − 2.50) × 100 × 3
    expect(live.pnlSource).toBe('stream');
    const still = boardRow(row, { check });
    expect(still.ticketPnl).toBe(100);
    expect(still.pnlSource).toBe('check-up');
    expect(boardRow({ ...row, status: 'Working', qtyFilled: 0 }, { check, liveMark: -2.5 }).pnlSource).not.toBe('stream');
  });
});

// The shared check-up pass: legs priced by the stream skip the 40 s option-greeks call.
const T61 = { _rowIndex: 61, Timestamp: '2026-11-03T15:10:00.000Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 3 contracts',
  Contracts: '3', 'Wing Strikes': '700 / 710 / 760 / 770', Price: '731', IV: '21', 'Net Debit/Credit': '3.6',
  Notes: 'Legs: +1 700P 20261211 / -1 710P 20261211 / -1 760C 20261211 / +1 770C 20261211' };
vi.mock('../utils/api', () => ({ api: { getDecisions: async () => [T61], getCloses: async () => [], getOpenPositions: async () => [] } }));

describe('check-up pass', () => {
  let calls;
  beforeEach(async () => {
    calls = [];
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(async url => {
      calls.push(String(url));
      const body = /vol-surface/.test(url) ? { spot: 730, iv: 21, daily: [] } : /\/api\/positions/.test(url) ? { raw: [] } : { error: 'should not be asked' };
      return { ok: true, text: async () => JSON.stringify(body), json: async () => body };
    });
  });
  afterEach(() => { localStorage.clear(); });

  it('values the legs from the stream and asks the bridge only for positions and the surface', async () => {
    const { liveStore } = await import('../live/liveStore');
    const st = seeded();
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 2, status: st.status, quotes: st.quotes });
    const { checkupFor, clearCheckupCache } = await import('../components/Checkup45');
    clearCheckupCache();
    const x = await checkupFor(T61, null);
    expect(calls.some(u => /option-greeks/.test(u))).toBe(false);
    expect(x.quoteSource).toBe('stream');
    expect(x.spot).toBe(735.4);                       // the stream's price, not the surface's 730
    expect(x.quoteErr).toBeNull();
    expect(x.review.metrics.pnl$).toBe(330);
  });
});
