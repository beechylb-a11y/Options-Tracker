/* Trade details (Oct 2026): the payoff of an open trade on demand, from the dashboard. */
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { payoffSeries, whereIsPrice } from '../engine/tradeView';

const NOW = new Date('2026-10-21T14:38:00Z');           // 10:38 New York, Wednesday
const legs0 = [[6700, 'P', 1], [6740, 'P', -1], [6740, 'C', -1], [6780, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261021', iv: 13 }));
const fly = { engine: '0DTE', strategy: 'Iron Butterfly', underlying: 'SPX', live: 1, qty: 1, expiry: '20261021', pos: { ncd: 24.5, isCredit: true }, entry: {} };

describe('payoff series', () => {
  it('0DTE iron fly: expiry, now and 15:00 curves, break-evens, the move left', () => {
    const s = payoffSeries(fly, legs0, 6751, { now: NOW });
    expect(s.exitLabel).toBe('At 15:00');
    expect(Math.round(s.maxProfit)).toBe(2450);                       // credit kept at the body
    expect(Math.round(s.maxLoss)).toBe(-1550);                        // 40 wide − 24.50
    expect(s.breakevens.map(b => Math.round(b * 2) / 2)).toEqual([6715.5, 6764.5]);
    expect(s.sd).toBeGreaterThan(10);
    expect(s.sd).toBeLessThan(40);
    // time decay: worth more at 15:00 than now with price at the body, all at expiry
    expect(s.exitAt(6740)).toBeGreaterThan(s.nowAt(6740));
    expect(s.expiryAt(6740)).toBeGreaterThan(s.exitAt(6740));
    const w = whereIsPrice(s, 6751);
    expect(w.near).toMatchObject({ body: true, strike: 6740 });
    expect(w.near.away).toBeCloseTo(11, 6);
    expect(w.inside).toBe(true);
  });
  it('45DTE condor: the planned close, and the nearest short in points', () => {
    const legs = [[699, 'P', 1], [709, 'P', -1], [755, 'C', -1], [765, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120', iv: 21 }));
    const c = { engine: '45DTE', strategy: 'Iron Condor - Normal', underlying: 'QQQ', live: 5, qty: 5, expiry: '20261120', pos: { ncd: 3.77, isCredit: true }, entry: {} };
    const s = payoffSeries(c, legs, 722.51, { now: NOW });
    expect(s.exitLabel).toMatch(/planned close \(30\/10\)/);
    expect(Math.round(s.maxProfit)).toBe(1885);
    const w = whereIsPrice(s, 722.51);
    expect(w.near).toMatchObject({ strike: 709, right: 'P' });
    expect(w.near.away).toBeCloseTo(13.51, 6);
    // a working order is drawn as if filled
    expect(payoffSeries({ ...c, live: 0 }, legs, 722.51, { now: NOW }).ifFilled).toBe(true);
  });
});

const T60 = { _rowIndex: 60, Timestamp: '2026-10-21T14:00:00.000Z', Engine: '0DTE', Underlying: 'SPX', Strategy: 'SPX - Iron Butterfly - 1 contract',
  Contracts: '1', 'Wing Strikes': '6700 / 6740 / 6780', Price: '6738', VIX1D: '13',
  Notes: 'Legs: +1 6700P 20261021 / -1 6740P 20261021 / -1 6740C 20261021 / +1 6780C 20261021' };
const ROW = { ticketRef: 60, timestamp: T60.Timestamp, entryDate: '2026-10-21', engine: '0DTE', underlying: 'SPX', strategy: 'SPX - Iron Butterfly - 1 contract',
  legs: '6700 / 6740 / 6780', qty: 1, qtyOpen: 1, qtyFilled: 1, entryPrice: 24.5, maxRisk: 1550, maxProfit: 2450, status: 'Open', realisedPnl: '', closes: [] };
vi.mock('../utils/api', () => ({ api: {
  getDecisions: () => Promise.resolve([T60]), getCloses: () => Promise.resolve([]),
  getOpenPositions: () => Promise.resolve([ROW]), getStats: () => Promise.resolve({ config: {} }),
} }));
import TradeDetail from '../components/TradeDetail';
import OpenPositions from '../components/OpenPositions';

describe('trade detail panel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(url => {
      const u = String(url);
      let body = {};
      if (u.includes('/api/positions')) body = { raw: [] };
      else if (u.includes('/api/option-greeks')) {
        const legs = JSON.parse(new URL(u).searchParams.get('legs'));
        const mid = { '6700P': 0.6, '6740P': 9.2, '6740C': 19.0, '6780C': 1.4 };
        body = { undPrice: 6751, net: { delta: -25, gamma: -0.4, theta: 180, vega: -40 },
          legs: legs.map(l => ({ ...l, greeks: { iv: 13, delta: 0, bid: mid[l.strike + l.right] - 0.05, ask: mid[l.strike + l.right] + 0.05 } })) };
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it('draws the trade with live quotes and says where price is', async () => {
    const onSell = vi.fn();
    render(<TradeDetail row={ROW} onClose={() => {}} onSell={onSell} />);
    await waitFor(() => expect(screen.getByTestId('trade-detail').textContent).toMatch(/at the mid/));
    // mark: 0.6 − 9.2 − 19.0 + 1.4 = −26.2 → buy back at 26.20 against 24.50 credit
    expect(screen.getByTestId('detail-pnl').textContent).toBe('−$170');
    expect(screen.getByTestId('detail-near').textContent).toMatch(/Body 6740.*11\.00 pts away/);
    expect(screen.getByTestId('detail-target').textContent).toMatch(/\+\$1,225/);
    expect(screen.getByTestId('detail-stop').textContent).toMatch(/−\$2,450.*close @49\.00/);
    fireEvent.click(screen.getByTestId('detail-sell'));
    expect(onSell).toHaveBeenCalledWith(ROW);
  });

  it('quotes without an underlying price: reads it from market data instead of drawing at entry', async () => {
    const base = global.fetch;
    global.fetch = vi.fn(url => {
      const u = String(url);
      if (u.includes('/api/market-data')) { const b = { price: 6745.2 }; return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(b)), json: () => Promise.resolve(b) }); }
      return base(url).then(r => r.json()).then(b => {
        const body = u.includes('/api/option-greeks') ? { ...b, undPrice: null } : b;
        return { ok: true, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) };
      });
    });
    render(<TradeDetail row={ROW} onClose={() => {}} onSell={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('trade-detail').textContent).toMatch(/SPX 6745/));
    expect(screen.getByTestId('trade-detail').textContent).not.toMatch(/No live price/);
  });

  it('opens from the dashboard row', async () => {
    render(<OpenPositions authenticated account="all" compact maxOpenRisk={5000} />);
    await waitFor(() => expect(screen.getByTestId('op-details')).toBeTruthy());
    fireEvent.click(screen.getByTestId('op-details'));
    await waitFor(() => expect(screen.getByTestId('trade-detail')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('payoff-diagram')).toBeTruthy());
  });
});
