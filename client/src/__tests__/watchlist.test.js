import { describe, it, expect } from 'vitest';
import { normalise, fromLegacy, rankWatchlist, groupList, DEFAULT_WATCHLIST, WATCH_MAX } from '../utils/watchlist';

const w = (items, scanN = 10) => ({ v: 1, scanN, items });
const it0 = (sym, o = {}) => ({ sym, on0: true, on45: true, pin: false, ...o });

describe('normalise', () => {
  it('dedupes, uppercases, drops junk and caps at 20', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ sym: 'S' + String.fromCharCode(65 + i) }));
    const n = normalise({ items: [{ sym: 'spx' }, { sym: 'SPX' }, { sym: '12bad' }, ...many] });
    expect(n.items[0].sym).toBe('SPX');
    expect(n.items.filter(x => x.sym === 'SPX').length).toBe(1);
    expect(n.items.length).toBe(WATCH_MAX);
    expect(n.scanN).toBe(10);
  });
  it('reads the stored JSON string; rejects garbage', () => {
    expect(normalise(JSON.stringify(DEFAULT_WATCHLIST)).items.length).toBe(10);
    expect(normalise('nope')).toBeNull();
  });
  it('folds the old per-group browser lists into one', () => {
    const l = fromLegacy({ '0dte|stock': ['MSFT'], '45dte|stock': ['NFLX'] });
    expect(l.items.find(x => x.sym === 'MSFT')).toMatchObject({ on0: true, on45: false });
    expect(l.items.find(x => x.sym === 'NFLX')).toMatchObject({ on0: false, on45: true });
  });
});

describe('rankWatchlist — 0DTE', () => {
  it('pins first, then your order; a weekly-only name is skipped, dailies survive a weekend', () => {
    const list = w([it0('QQQ'), it0('TSLA'), it0('SPX', { pin: true })]);
    const chain = { TSLA: { ok: true, today: false, dailies: false }, QQQ: { ok: true, today: false, dailies: true } };
    const r = rankWatchlist('0dte', list, { chain });
    expect(r.scan).toEqual(['SPX', 'QQQ']);
    expect(r.why.TSLA).toBe('no expiry today');
  });
});

describe('rankWatchlist — 45DTE', () => {
  const ivr = { AAPL: { ivr: 40 }, NVDA: { ivr: 70 }, TSLA: { ivr: 80 }, AMD: { ivr: 55 } };
  it('pins first, then IVR high to low; earnings cost 20 points', () => {
    const list = w([it0('AAPL'), it0('NVDA'), it0('TSLA'), it0('AMD'), it0('SPY', { pin: true })]);
    const r = rankWatchlist('45dte', list, { ivr, earn: { TSLA: '2026-11-20' } });
    // TSLA 80 − 20 = 60 → below NVDA 70, above AMD 55
    expect(r.scan).toEqual(['SPY', 'NVDA', 'TSLA', 'AMD', 'AAPL']);
    expect(r.why.TSLA).toMatch(/earnings −20/);
  });
  it('only the top N are scanned; groups split by asset class', () => {
    const list = w([it0('AAPL'), it0('NVDA'), it0('TSLA'), it0('SPY')], 2);
    const r = rankWatchlist('45dte', list, { ivr: { ...ivr, SPY: { ivr: 10 } } });
    expect(r.scan).toEqual(['TSLA', 'NVDA']);
    expect(r.rest).toEqual(['AAPL', 'SPY']);
    expect(groupList(r, 'stock')).toEqual(['TSLA', 'NVDA']);
    expect(groupList(r, 'etf')).toEqual([]);
  });
});
