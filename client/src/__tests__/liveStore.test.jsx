import { describe, it, expect } from 'vitest';
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { createLiveStore, createSSEParser, freshnessOf, liveKey, comboQuote, liveStore, STALE_MS } from '../live/liveStore';
import * as bridgeBook from '../../../bridge/liveBook.js';
import { LivePrice, liveSummary } from '../components/HeaderStrip';

describe('the app and the bridge build the same keys and combo prices', () => {
  it('liveKey matches bridge/liveBook.js', () => {
    for (const args of [['spx'], ['SPX', '2026-11-18', '7600', 'Put'], ['XSP', '20261119', 765.5, 'c'], ['QQQ', '20261120', 720, 'C']]) {
      expect(liveKey(...args)).toBe(bridgeBook.liveKey(...args));
    }
  });
  it('comboQuote matches bridge/liveBook.js', () => {
    const quotes = { a: { bid: 1.05, ask: 1.1 }, b: { bid: 2.85, ask: 3 }, c: { bid: 0, ask: 0.05 } };
    for (const legs of [[{ key: 'a', qty: 1 }, { key: 'b', qty: -1 }], [{ key: 'a', qty: -2 }, { key: 'b', qty: 1 }, { key: 'c', qty: 1 }], [{ key: 'z', qty: 1 }]]) {
      expect(comboQuote(legs, quotes)).toEqual(bridgeBook.comboQuote(legs, quotes));
    }
  });
});

describe('createSSEParser', () => {
  it('handles frames split across chunks, comments and CRLF', () => {
    const got = [];
    const feed = createSSEParser((e, d, id) => got.push([e, d, id]));
    feed('retry: 3000\n\n: hello\n\nid: 4\nevent: snap');
    feed('shot\ndata: {"seq":4}\r\n\r\nevent: delta\ndata: {"seq":5}\n\nevent: delta\ndata: not json\n\n');
    expect(got).toEqual([['snapshot', { seq: 4 }, '4'], ['delta', { seq: 5 }, null]]);
  });
});

describe('createLiveStore', () => {
  it('keeps untouched quotes as the same object so unrelated screens do not re-render', () => {
    const s = createLiveStore();
    s.applySnapshot({ seq: 1, quotes: { SPX: { key: 'SPX', bid: 1 }, QQQ: { key: 'QQQ', bid: 2 } }, positions: [], orders: [] });
    const qqq = s.getQuote('QQQ');
    s.applyDelta({ seq: 2, quotes: { SPX: { key: 'SPX', bid: 1.5 } }, removed: [] });
    expect(s.getQuote('SPX').bid).toBe(1.5);
    expect(s.getQuote('QQQ')).toBe(qqq);
    s.applyDelta({ seq: 3, quotes: {}, removed: ['QQQ'], positions: [{ key: 'x' }] });
    expect(s.getQuote('QQQ')).toBeUndefined();
    expect(s.getState().positions).toEqual([{ key: 'x' }]);
    s.applyDelta({ seq: 4, quotes: {}, positions: null });
    expect(s.getState().positions).toEqual([{ key: 'x' }]);   // null = unchanged
  });
});

describe('freshnessOf', () => {
  const q = { ts: 1000 };
  it('says off without a stream, a TWS connection or any tick', () => {
    expect(freshnessOf(q, { now: 1000, connection: 'down' })).toBe('off');
    expect(freshnessOf(q, { now: 1000, bridgeConnected: false })).toBe('off');
    expect(freshnessOf({}, { now: 1000 })).toBe('off');
    expect(freshnessOf({ ts: 1, notEntitled: true }, { now: 1 })).toBe('off');
  });
  it('delayed beats everything else that is up; closed market is frozen', () => {
    expect(freshnessOf({ ts: 1000, delayed: true }, { now: 1000 })).toBe('delayed');
    expect(freshnessOf({ ts: 1000, mdType: 3 }, { now: 1000 })).toBe('delayed');
    expect(freshnessOf(q, { now: 1000 + 10 * STALE_MS, marketOpen: false })).toBe('frozen');
  });
  it('goes stale after a quiet minute in market hours or when TWS loses its data farm', () => {
    expect(freshnessOf(q, { now: 1000 + STALE_MS - 1 })).toBe('live');
    expect(freshnessOf(q, { now: 1000 + STALE_MS + 1 })).toBe('stale');
    expect(freshnessOf(q, { now: 1000, farmOk: false })).toBe('stale');
  });
});

describe('header live price', () => {
  it('shows SPX from the stream with its change on the day, and nothing before a price', () => {
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true, lines: 9, maxLines: 60 }, quotes: {}, positions: [], orders: [] });
    const { container } = render(<LivePrice symbol="SPX" />);
    expect(container.textContent).toBe('');
    act(() => { liveStore.applyDelta({ seq: 2, quotes: { SPX: { key: 'SPX', bid: 7648, ask: 7648.4, mark: 7648.2, close: 7616.2, ts: Date.now() } } }); });
    expect(screen.getByTestId('live-price').textContent).toContain('7,648.20');
    expect(screen.getByTestId('live-price').textContent).toContain('+0.42%');
    expect(screen.getByTestId('fresh-dot')).toBeTruthy();
  });
  it('summarises the stream for the bridge menu', () => {
    expect(liveSummary({ connection: 'open', status: { lines: 9, maxLines: 60 } })).toBe('Live stream on · 9 of 60 data lines');
    expect(liveSummary({ connection: 'down', error: 'HTTP 401', status: {} })).toBe('Live stream down: HTTP 401');
    expect(liveSummary({ connection: 'off', status: {} })).toBe('');
  });
});

describe('stage card live market', () => {
  it('prices the combo from streamed legs and compares it with the limit', async () => {
    const { LiveCombo } = await import('../components/ExitPlanCard');
    const calls = [];
    global.fetch = async (url, init) => { calls.push([String(url), init && init.body]); return { ok: true, json: async () => ({ held: [], refused: [] }) }; };
    localStorage.setItem('bridgeUrl', 'https://bridge.test');
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true }, quotes: {
      'SPX 20261118 7580 P': { key: 'SPX 20261118 7580 P', bid: 1.05, ask: 1.10, ts: Date.now() },
      'SPX 20261118 7600 P': { key: 'SPX 20261118 7600 P', bid: 2.85, ask: 3.00, ts: Date.now() },
    }, positions: [], orders: [] });
    const legs = [{ strike: 7580, right: 'P', qty: 1, expiry: '2026-11-18' }, { strike: 7600, right: 'P', qty: -1, expiry: '2026-11-18' }];
    render(<LiveCombo underlying="SPX" legs={legs} entry={1.85} isCredit />);
    const row = screen.getByTestId('live-combo').textContent;
    expect(row).toContain('mid 1.85 cr');
    expect(row).toContain('crossing 1.75 cr');
    expect(row).toContain('far side 1.95 cr');
    expect(screen.getByTestId('live-combo-edge').textContent).toBe('your limit 1.85 is at the mid');
    expect(calls[0][0]).toBe('https://bridge.test/api/live/watch');
    expect(JSON.parse(calls[0][1]).legs[0]).toMatchObject({ underlying: 'SPX', expiry: '2026-11-18', strike: 7580, right: 'P', qty: 1 });
    delete global.fetch;
    localStorage.removeItem('bridgeUrl');
  });
});
