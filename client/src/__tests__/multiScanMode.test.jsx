/* Multi-scan mode identity (Oct 2026). A 0DTE scan kept its results on screen
   after the header was switched to 45DTE, and its Open button then opened the
   0DTE pick as a 45DTE ticket. Results are now filed per mode, every Open button
   opens the mode it was scanned in, and a scan-seeded ticket keeps its mode. */
import React from 'react';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../components/EnginePanel', () => ({
  default: ({ seed, mode }) => (
    <div data-testid="panel" data-mode={mode} data-u={(seed && seed.underlying) || ''}
      data-scan={(seed && seed._scanMode) || ''} data-ivr={(seed && seed.ivr) || ''} />
  ),
}));
vi.mock('../utils/api', () => ({
  api: { getStrategyHistory: () => Promise.resolve([]), getDecisions: () => Promise.resolve([]),
         getTradeTracker: () => Promise.resolve([]), getConfig: () => Promise.resolve({}) },
  clearApiCache: () => {},
}));
vi.mock('../utils/volSnapshot', () => ({ startCloseVolSnapshot: () => {} }));

import DecisionEngine from '../pages/DecisionEngine';

const visiblePanel = () => screen.getAllByTestId('panel').find(p => p.parentElement.style.display !== 'none');
const typeFirst = (label, value) => {
  const row = Array.from(screen.getByTestId('multiscan').querySelectorAll('tr'))
    .find(tr => tr.firstChild && tr.firstChild.textContent === label);
  fireEvent.change(row.querySelectorAll('input')[0], { target: { value } });
};

describe('multi-scan mode', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => cleanup());

  it('files results under the mode scanned, and opens picks in that mode', async () => {
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    fireEvent.click(screen.getByTestId('multiscan-toggle'));
    expect(screen.getByTestId('multiscan').dataset.mode).toBe('0dte');
    fireEvent.click(screen.getByText('Show inputs'));
    typeFirst('Price', '7410');
    fireEvent.click(screen.getByTestId('scan-all'));
    expect(await screen.findByTestId('scan-results')).toBeTruthy();
    expect(screen.getByTestId('scan-results').dataset.mode).toBe('0dte');
    expect(screen.getByText('Direction')).toBeTruthy();

    // switch the (blank) ticket to 45DTE: the 0DTE results are not shown here
    fireEvent.click(screen.getByTestId('mode-45dte'));
    expect(screen.getByTestId('multiscan').dataset.mode).toBe('45dte');
    expect(screen.queryByTestId('scan-results')).toBeNull();
    expect(screen.getByTestId('multiscan-other').textContent).toMatch(/0DTE/);

    // a 45DTE scan shows the vol rows, not the session rows
    typeFirst('IV Rank %', '42');
    typeFirst('Price', '7410');
    fireEvent.click(screen.getByTestId('scan-all'));
    await screen.findByTestId('scan-results');
    expect(screen.getByTestId('scan-results').dataset.mode).toBe('45dte');
    expect(screen.queryByText('Direction')).toBeNull();
    expect(screen.getByText('IV rank')).toBeTruthy();
    expect(screen.getByText('Term')).toBeTruthy();

    // back to 0DTE and open the pick: it is a 0DTE ticket, tagged as such
    fireEvent.click(screen.getByTestId('mode-0dte'));
    expect(screen.getByTestId('scan-results').dataset.mode).toBe('0dte');
    const open = screen.getAllByTestId('scan-open')[0];
    expect(open.textContent).toMatch(/Open 0DTE/);
    fireEvent.click(open);
    const p = visiblePanel();
    expect(p.dataset.mode).toBe('0dte');
    expect(p.dataset.scan).toBe('0dte');
    expect(p.dataset.u).toBe('SPX');
    const banner = screen.getAllByTestId('ticket-mode-banner').find(b => b.parentElement.style.display !== 'none');
    expect(banner.dataset.mode).toBe('0dte');
    expect(banner.textContent).toMatch(/from the 0DTE multi-scan/);
  });

  it('a scan ticket keeps its mode: the switch opens a new ticket instead', async () => {
    render(<DecisionEngine authenticated account="all" accounts={[]} />);
    fireEvent.click(screen.getByTestId('mode-45dte'));
    fireEvent.click(screen.getByTestId('multiscan-toggle'));
    fireEvent.click(screen.getByText('Show inputs'));
    typeFirst('Price', '7410');
    typeFirst('IV Rank %', '55');
    fireEvent.click(screen.getByTestId('scan-all'));
    await screen.findByTestId('scan-results');
    fireEvent.click(screen.getAllByTestId('scan-open')[0]);
    expect(visiblePanel().dataset.mode).toBe('45dte');
    expect(visiblePanel().dataset.ivr).toBe('55');           // the vol it scanned travels with it
    const before = screen.getAllByTestId('tab').length;

    fireEvent.click(screen.getByTestId('mode-0dte'));
    expect(screen.getAllByTestId('tab').length).toBe(before + 1);
    expect(visiblePanel().dataset.mode).toBe('0dte');
    expect(visiblePanel().dataset.u).toBe('');
    // the scan ticket is still 45DTE
    const scanPanel = screen.getAllByTestId('panel').find(p => p.dataset.scan === '45dte');
    expect(scanPanel.dataset.mode).toBe('45dte');
    const tabs = screen.getAllByTestId('tab').map(t => t.dataset.mode);
    expect(tabs).toContain('45dte');
    expect(tabs).toContain('0dte');
  });
});
