/* Log trade on a 45DTE ticket with greeks (Oct 2026). The summary line read the 0DTE
   survivability fields (tEdge, gRisk), which 45DTE does not have, so confirmLog threw
   and the Log button did nothing — with or without "Order sent, not filled yet". */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const i45 = { underlying: 'QQQ', price: '758', ivr: '35', iv: '20', hv: '16', vix: '17', ivFront: '19', ivBack: '21', skew: '3',
  dte: '44', pop: '99', win: '603', risk: '1000', netCreditDebit: '5.81', theta: '12', vega: '-30', delta: '-2',
  bankroll: 25000, startBR: 25000, maxLoss: 6000, maxOpen: 9000 };
const mount = (onLog) => render(<EnginePanel mode="45dte" onLogTrade={onLog} accountConfig={{ id: 'acct', bankroll: 25000 }}
  strategyHistory={{}} toast={() => {}} initialState={{ i45, overrideStrat: 'Iron Condor - Normal' }} />);
const pressLog = () => fireEvent.click(screen.getAllByRole('button').find(b => b.textContent === 'Log'));

describe('45DTE Log trade', () => {
  afterEach(() => cleanup());
  it('writes the row, with the 45DTE edge in the summary', () => {
    const onLog = vi.fn(() => Promise.resolve(true));
    mount(onLog);
    fireEvent.click(screen.getByTestId('log-trade'));
    pressLog();
    expect(onLog).toHaveBeenCalledTimes(1);
    const row = onLog.mock.calls[0][0];
    expect(row.notes).toMatch(/Move vs decay: /);
    expect(row.notes).not.toMatch(/Survivability/);
    expect(row.limitPrice).toBe('');
  });
  it('writes a working order: the limit sent and when', () => {
    const onLog = vi.fn(() => Promise.resolve(true));
    mount(onLog);
    fireEvent.click(screen.getByTestId('log-trade'));
    fireEvent.click(screen.getByTestId('log-working').querySelector('input'));
    pressLog();
    expect(onLog).toHaveBeenCalledTimes(1);
    expect(onLog.mock.calls[0][0].limitPrice).toBe(5.81);
    expect(onLog.mock.calls[0][0].workingSince).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
});
