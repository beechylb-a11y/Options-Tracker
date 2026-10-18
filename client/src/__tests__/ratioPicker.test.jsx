/* Ratio selector on the 45DTE ticket (R-54): 1:2 / 2:3 / 3:4 and the protective long. */
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EnginePanel from '../components/EnginePanel';

const mount = (extra = {}) => render(<EnginePanel mode="45dte" onLogTrade={() => true} accountConfig={{ id: 'a', bankroll: 50000 }} strategyHistory={{}} toast={() => {}}
  initialState={{ i45: { underlying: 'QQQ', price: '600', iv: '22', hv: '18', ivr: '45', vix: '15', dte: '45', ivFront: '22', ivBack: '23' },
    overrideStrat: 'Ratio spread', ...extra }} />);
const line = () => screen.getAllByTestId('strike-line')[0].textContent;

describe('ratio picker', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-06T15:00:00Z'));
    localStorage.clear();
    global.fetch = vi.fn(async () => ({ json: async () => ({}), text: async () => '{}', status: 200 }));
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('shows 1:2 protected by default with the suggested protective strike', () => {
    mount();
    expect(screen.getByTestId('ratio-1:2').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('ratio-protect').checked).toBe(true);
    expect(screen.getByTestId('ratio-protect-note').textContent).toMatch(/1× 646C suggested/);
    expect(line()).toMatch(/−2×623 Call/);
  });

  it('switches to 3:4 and moves the protective long to the zero-risk strike', () => {
    mount();
    fireEvent.click(screen.getByTestId('ratio-3:4'));
    expect(screen.getByTestId('ratio-3:4').getAttribute('aria-pressed')).toBe('true');
    expect(line()).toMatch(/\+3×600 Call/);
    expect(line()).toMatch(/−4×623 Call/);
    expect(screen.getByTestId('ratio-protect-note').textContent).toMatch(/1× 692C/);
  });

  it('turning protection off drops the leg and flags undefined risk', () => {
    mount({ ratioSpec: { ratio: '2:3', protect: true } });
    fireEvent.click(screen.getByTestId('ratio-protect'));
    expect(screen.getByTestId('ratio-unprotected-note').textContent).toMatch(/no maximum loss/);
    expect(line()).not.toMatch(/669/);
  });

  it('does not show for other structures', () => {
    mount({ overrideStrat: 'Iron Condor - Normal' });
    expect(screen.queryByTestId('ratio-picker')).toBeNull();
  });
});
