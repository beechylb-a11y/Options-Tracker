/* The check-up panel end to end against a mocked bridge: finds the TWS legs,
   prices them, and shows the playbook action per open 45DTE ticket. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/api', () => ({ api: { getOpenPositions: () => Promise.resolve([]) } }));
import Checkup45 from '../components/Checkup45';

const tickets = [
  { Timestamp: '2026-09-29T15:00:00Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Bull put spread - 1 contract',
    Contracts: '1', 'Wing Strikes': '745 / 735', Price: '760', IV: '19', 'Net Debit/Credit': '3.35', 'Max Profit': '335', Notes: '' },
  { Timestamp: '2026-10-01T15:00:00Z', Engine: '45DTE', Underlying: 'IWM', Strategy: 'IWM - Bull put spread - 1 contract',
    Contracts: '1', 'Wing Strikes': '240 / 235', Price: '250', IV: '20', 'Net Debit/Credit': '1.10', Notes: 'Legs: -1 240P 20261113 / +1 235P 20261113' },
  { Timestamp: '2026-10-05T14:00:00Z', Engine: '0DTE', Underlying: 'SPX', Strategy: 'SPX - Iron butterfly - 1 contract', 'Wing Strikes': '7400' },
];

describe('45DTE check-up panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-16T15:00:00Z'));
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(url => {
      const u = String(url);
      let body = {};
      if (u.includes('/api/positions')) body = { raw: [
        { underlying: 'QQQ', expiry: '20261113', strike: 745, right: 'P', qty: -1 },
        { underlying: 'QQQ', expiry: '20261113', strike: 735, right: 'P', qty: 1 }] };
      else if (u.includes('/api/vol-surface')) body = { spot: u.includes('QQQ') ? 744 : 251, iv: 22, daily: [] };
      else if (u.includes('/api/option-greeks')) {
        const legs = JSON.parse(decodeURIComponent(u.split('legs=')[1]));
        body = { undPrice: u.includes('QQQ') ? 744 : 251, net: { delta: 30, theta: 5, vega: -20 },
          legs: legs.map(l => ({ ...l, greeks: { iv: 22, delta: l.right === 'P' ? (l.strike >= 745 ? -0.5 : l.strike === 240 ? -0.2 : -0.33) : 0.1,
            bid: l.strike >= 745 ? 9.8 : l.strike === 735 ? 5.4 : l.strike === 240 ? 1.4 : 0.6,
            ask: l.strike >= 745 ? 10.0 : l.strike === 735 ? 5.6 : l.strike === 240 ? 1.5 : 0.7 } })) };
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it('reviews only the 45DTE tickets and says what to do', async () => {
    render(<Checkup45 tickets={tickets} />);
    expect(screen.getByTestId('checkup-run').textContent).toMatch(/Check 2 open trades/);
    fireEvent.click(screen.getByTestId('checkup-run'));
    await waitFor(() => expect(screen.getAllByTestId('checkup-card').length).toBe(2));
    const cards = screen.getAllByTestId('checkup-card');
    expect(cards[0].dataset.action).toBe('roll-out');                 // QQQ short 745P tested
    expect(cards[0].textContent).toMatch(/legsTWS/);
    expect(cards[1].textContent).toMatch(/ticket notes/);             // IWM found from the logged Legs line
    expect(screen.getAllByTestId('plan-track').length).toBe(2);
  });

  it('asks for the bridge when there is none', () => {
    localStorage.removeItem('bridgeUrl');
    render(<Checkup45 tickets={tickets} />);
    fireEvent.click(screen.getByTestId('checkup-run'));
    expect(screen.getByTestId('checkup').textContent).toMatch(/Bridge URL/);
  });
});
