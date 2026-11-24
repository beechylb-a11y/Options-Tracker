/* Payoff chart zones and hero (25 Nov 2026): each chart clips its own profit/loss tints
   (two charts on a page shared #pc-above and tinted the wrong side), the hero number is
   green in profit and red in loss, and the break-even names its moment with the expiry
   one under it (the price map below is at expiry). */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import PayoffChart from '../components/PayoffChart';
import { liveStore } from '../live/liveStore';

// SPY 640/670 bear call spread, 7.50 credit, 42 DTE, closes at 21 DTE.
const cl = [
  { strike: 640, right: 'C', sign: -1, qty: 1, dte: 42, iv: 0.46, r: 0.04, q: 0.013 },
  { strike: 670, right: 'C', sign: 1, qty: 1, dte: 42, iv: 0.46, r: 0.04, q: 0.013 },
];
const base = { cl, net: 7.5, netSource: 'ticket', spot: 591.49, lo: 400, hi: 900, sigmaNear: 0.46,
  nearDte: 42, closeDay: 21, closeDte: 21, todayYmd: '20261125', underlying: 'SPY', divYield: 0.013, hero: true };

describe('payoff zones and hero', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T16:00:00Z'));
    liveStore.setConnection('off');
    liveStore.applySnapshot({ seq: 0, status: {}, quotes: {}, positions: [], orders: [] });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('two charts each clip to their own zero line; profit green, loss red', () => {
    const { container } = render(<><PayoffChart {...base} /><PayoffChart {...base} spot={700} /></>);
    const ids = [...container.querySelectorAll('clipPath')].map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const profit = screen.getAllByTestId('pnl-zone-profit'), loss = screen.getAllByTestId('pnl-zone-loss');
    expect(profit[0].getAttribute('clip-path')).not.toBe(profit[1].getAttribute('clip-path'));
    expect(profit[0].getAttribute('fill')).toMatch(/52,199,89/);
    expect(loss[0].getAttribute('fill')).toMatch(/255,69,58/);
  });

  it('hero P&L green in profit, red in loss', () => {
    render(<><PayoffChart {...base} /><PayoffChart {...base} spot={700} /></>);
    const [up, down] = screen.getAllByTestId('payoff-hero-pnl');
    expect(up.textContent).toMatch(/^\+/);
    expect(up.style.color).toBe('rgb(126, 226, 160)');
    expect(down.textContent).toMatch(/^−/);
    expect(down.style.color).toBe('rgb(255, 163, 154)');
  });

  it('break-even names the 21-DTE date and gives the expiry one (640 + 7.50)', () => {
    render(<PayoffChart {...base} />);
    const facts = screen.getByTestId('payoff-facts');
    expect(facts.textContent).toMatch(/Break-even on/);
    expect(screen.getByTestId('be-expiry-note').textContent).toMatch(/^647\.\d\d at expiry$/);
  });
});
