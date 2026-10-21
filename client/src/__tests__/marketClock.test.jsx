/* Header market clock (Oct 2026): New York time and where the session stands. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { marketClock } from '../engine/marketClock';
import { NyClock } from '../components/HeaderStrip';

// 2026-10-21 is a Wednesday; New York is UTC−4 in October.
const at = (iso) => new Date(iso);

describe('market clock', () => {
  it('pre-market, open, past the 15:00 exit, closed', () => {
    expect(marketClock(at('2026-10-21T12:00:00Z'))).toMatchObject({ time: '08:00', date: 'Wed 21 Oct', status: 'PRE-MARKET', detail: 'opens in 1h 30m' });
    const open = marketClock(at('2026-10-21T14:38:00Z'));
    expect(open).toMatchObject({ time: '10:38', status: 'OPEN', tone: 'green' });
    expect(open.detail).toBe('4h 22m to the 15:00 exit · 5h 22m to the bell');
    expect(marketClock(at('2026-10-21T19:20:00Z'))).toMatchObject({ status: 'CLOSING', detail: 'past the 15:00 0DTE exit · bell in 40m' });
    expect(marketClock(at('2026-10-21T21:00:00Z'))).toMatchObject({ status: 'CLOSED', detail: 'next session Thu 22 Oct' });
  });
  it('weekend, holiday and early close', () => {
    expect(marketClock(at('2026-10-24T15:00:00Z'))).toMatchObject({ status: 'WEEKEND', detail: 'next session Mon 26 Oct' });
    expect(marketClock(at('2026-11-26T15:00:00Z'))).toMatchObject({ status: 'HOLIDAY', detail: 'Thanksgiving — closed · next session Fri 27 Nov' });
    // Wednesday before Thanksgiving, after the close: Thursday is skipped
    expect(marketClock(at('2026-11-25T22:00:00Z')).detail).toBe('next session Fri 27 Nov');
    // Black Friday closes at 13:00, so the working exit is 12:00 (EST: 17:30Z is 12:30)
    expect(marketClock(at('2026-11-27T17:30:00Z'))).toMatchObject({ status: 'CLOSING', detail: 'past the 12:00 0DTE exit · bell in 30m' });
  });
  it('renders in the header', () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at('2026-10-21T14:38:00Z'));
    render(<NyClock />);
    expect(screen.getByTestId('ny-clock').textContent).toMatch(/NY10:38Wed 21 OctOPEN/);
    cleanup(); vi.useRealTimers();
  });
});
