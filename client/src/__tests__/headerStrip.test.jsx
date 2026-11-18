/* Header strip (Nov 2026): three wells — Market, Today, System — each stat a label
   over its value, so the strip reads in columns. */
import React from 'react';
import { render, screen, cleanup, waitFor, within } from '@testing-library/react';
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  api: { getTracker: async () => [], getDecisions: async () => [], getStats: async () => ({ config: { maxDailyLoss: 1000 } }),
    getOpenPositions: async () => [{ qtyOpen: 1, qty: 1 }, { qtyOpen: 2, qty: 2 }, { qtyOpen: 0, qtyFilled: 0, qty: 1 }] },
  clearApiCache: () => {},
}));
import HeaderStrip from '../components/HeaderStrip';
import { liveStore } from '../live/liveStore';

afterEach(() => cleanup());

describe('header strip', () => {
  it('groups the numbers into Market / Today / System wells with labels over values', async () => {
    liveStore.setConnection('open');
    liveStore.applySnapshot({ seq: 1, status: { connected: true, mode: 'paper' }, quotes: { SPX: { last: 7342.18, close: 7318.4, ts: Date.now() } }, positions: [], orders: [] });
    render(<HeaderStrip authenticated account="p" accounts={[{ id: 'p', name: 'PaperTrade' }]} onAccountChange={() => {}} />);
    const market = screen.getByTestId('hdr-market');
    expect(within(market).getByTestId('ny-clock').querySelector('.hdr-label').textContent).toMatch(/New York/);
    expect(within(market).getByTestId('ny-status')).toBeTruthy();
    expect(within(market).getByTestId('live-price').textContent).toMatch(/SPX.*7,342\.18.*\+0\.32%/);
    await waitFor(() => expect(screen.getByTestId('hdr-open').textContent).toMatch(/Open\s*2\s*1 working/));
    expect(screen.getByTestId('hdr-today').querySelectorAll('.hdr-stat')).toHaveLength(3);
    expect(screen.getByTestId('hdr-losscap').querySelector('.hdr-label').textContent).toBe('Loss cap');
    const sys = screen.getByTestId('hdr-system');
    expect(within(sys).getByLabelText('Account').value).toBe('p');
    expect(sys.textContent).toMatch(/Feeds.*DB.*Bridge.*PAPER/);
  });
});
