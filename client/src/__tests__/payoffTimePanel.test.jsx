/* Payoff over time on the 45DTE ticket: opens on the 21-DTE close, draws a
   calendar (which used to say "No single-expiry payoff"), and the date buttons move it. */
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const i45 = { underlying: 'SPX', price: '7774', iv: '13.1', hv: '11', ivr: '30', vix: '15', dte: '45',
  ivFront: '12.9', ivBack: '13.9', pop: '', win: '', risk: '' };
const mount = (extra = {}) => render(
  <EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 50000 }}
    strategyHistory={{}} toast={() => {}} initialState={{ i45: { ...i45, ...(extra.i45 || {}) }, ...extra.state }} />);

describe('payoff over time', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear();
    global.fetch = vi.fn(async () => ({ json: async () => ({}) }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('draws a calendar and opens on the 21-DTE close', () => {
    mount({ i45: { netCreditDebit: '61' }, state: { overrideStrat: 'Calendar spread' } });
    const c = within(screen.getByTestId('payoff-time-chart'));
    expect(c.getByRole('button', { name: /21-DTE close ·/, hidden: true })).toBeTruthy();
    expect(c.getByRole('button', { name: /Near expiry ·/, hidden: true })).toBeTruthy();
    expect(c.getByText(/makes most of its money in the last weeks/)).toBeTruthy();
    expect(c.getByText(/ticket's net debit 61.00/)).toBeTruthy();
    // the calendar's own choice card now has a payoff to read from
    const pick = screen.getByText('YOUR PICK').closest('[data-testid="choice-card"]') || screen.getByText('YOUR PICK').parentElement.parentElement.parentElement;
    expect(pick.textContent).toMatch(/Profits if SPX stays \d+–\d+/);
    expect(pick.textContent).toMatch(/dr 61\.00/);
  });

  it('moves between today, close and expiry', () => {
    mount({ state: { overrideStrat: 'Iron Condor - Normal' } });
    const c = within(screen.getByTestId('payoff-time-chart'));
    expect(c.getByText(/at model fair/)).toBeTruthy();
    const slider = c.getByLabelText('Days from today');
    fireEvent.click(c.getByRole('button', { name: 'Today', hidden: true }));
    expect(slider.value).toBe('0');
    fireEvent.click(c.getByRole('button', { name: /^Expiry ·/, hidden: true }));
    expect(Number(slider.value)).toBeGreaterThan(21);
    fireEvent.click(c.getByRole('button', { name: /21-DTE close ·/, hidden: true }));
    expect(Number(slider.max) - Number(slider.value)).toBe(21);
  });
});
