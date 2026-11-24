/* The ticket's own underlying streams with its legs (25 Nov 2026): META isn't in the
   bridge's fixed watch list, so "Underlying · waiting for a tick" sat on the META ticket. */
import React from 'react';
import { render, cleanup, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LegTable } from '../components/VisionTicket';

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe('ticket underlying on the stream', () => {
  it('asks the bridge for the underlying alongside the legs, and lets it go on unmount', async () => {
    localStorage.setItem('bridgeUrl', 'http://localhost:3333');
    const bodies = [];
    global.fetch = vi.fn(async (url, opts) => { bodies.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null }); return { ok: true, json: async () => ({ held: [], refused: [] }) }; });
    const { unmount } = render(<LegTable underlying="meta" legs={[{ expiry: '20270115', strike: 640, right: 'C', qty: -1 }, { expiry: '20270115', strike: 670, right: 'C', qty: 1 }]} />);
    await act(async () => { await Promise.resolve(); });
    const watch = bodies.find(b => b.url.endsWith('/api/live/watch'));
    expect(watch.body.underlyings).toEqual(['META']);
    unmount();
    const un = bodies.find(b => b.url.endsWith('/api/live/unwatch'));
    expect(un.body.keys).toContain('META');
  });
});

describe('leg TWS has no contract for', () => {
  it('says "not listed in TWS" instead of waiting', async () => {
    const { liveStore } = await import('../live/liveStore');
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ held: [], refused: [] }) }));
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true }, quotes: { 'META 20270219 585 P': { noContract: true } }, positions: [], orders: [] });
    const { getByTestId } = render(<LegTable underlying="META" legs={[{ expiry: '20270219', strike: 585, right: 'P', qty: -1 }]} />);
    expect(getByTestId('leg-not-listed').textContent).toBe('not listed in TWS');
    liveStore.setConnection('off');
  });
});
