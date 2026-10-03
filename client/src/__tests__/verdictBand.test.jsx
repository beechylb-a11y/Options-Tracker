/* The verdict band (Oct 2026) replaced four competing 0-100 readouts with one
   verdict, and it gates Log trade on the engine's blockers. Before it, a ticket
   could show two red Blockers above a green, clickable Log trade button. These
   tests pin the gate and the evidence drawer's closed-by-default rule. */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const base = {
  underlying: 'SPX', price: '7410', high: '7421', low: '7398', vwap5: '7409', vwap5_30: '7409',
  vwapRoll30: '7410', vwapRoll30Prior: '7409', vwapAccept: '0.5', em: '38', atr5: '6.5', atr2h: '22', atr: '61',
  vix: '15.8', vix1d: '12.9', esOvernightHigh: '7430', esOvernightLow: '7388', esClose: '7415',
  priorDayClose: '7398', cashOpen: '7400', esEM: '40', hours: '3.5',
  theta: '38', delta: '-4', lowerWingDelta: '0.08', upperWingDelta: '0.07',
  emSource: 'straddle', straddleCall: '21.5', straddlePut: '20.8', straddleHaircut: '1.2533',
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900,
};
const mount = (i0) => render(
  <EnginePanel mode="0dte" onLogTrade={() => true} accountConfig={{ id: 'acct', bankroll: 25000 }}
    strategyHistory={{}} initialState={{ i0: { ...base, ...i0 } }} toast={() => {}} />);

describe('verdict band', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-02T15:30:00Z')); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('turns Log trade into the blocker reason, with a deliberate Log anyway', () => {
    // 1.45 credit on strikes worth ~6.36 at spot, and high gamma: two blockers.
    mount({ netCreditDebit: '1.45', gamma: '-1.2', win: '210', risk: '290', pop: '62' });
    expect(screen.getByTestId('verdict').textContent).toMatch(/^Blocked/);
    const btn = screen.getByTestId('log-trade');
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toMatch(/Blocked/);
    expect(screen.getByTestId('log-anyway')).toBeTruthy();
    expect(screen.getByTestId('needs-you').textContent).toMatch(/Gamma risk too high/);
  });

  it('asks for sizing instead of showing a score-driven verdict', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '', risk: '', pop: '' });
    expect(screen.getByTestId('verdict').textContent).toBe('Waiting on sizing');
    expect(screen.getByTestId('log-trade').disabled).toBe(true);
    expect(screen.getByTestId('needs-you').textContent).toMatch(/Enter sizing/);
  });

  it('offers a live Log trade when nothing blocks the ticket', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' });
    const btn = screen.getByTestId('log-trade');
    expect(btn.disabled).toBe(false);
    expect(screen.queryByTestId('log-anyway')).toBeNull();
  });

  it('keeps the evidence drawer closed until a tab is chosen', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' });
    const body = screen.getByTestId('evidence-body');
    expect(body.style.display).toBe('none');
    fireEvent.click(screen.getByTestId('drawer-tab-structures'));
    expect(body.style.display).toBe('block');
    fireEvent.click(screen.getByTestId('drawer-tab-structures'));
    expect(body.style.display).toBe('none');
  });
});
