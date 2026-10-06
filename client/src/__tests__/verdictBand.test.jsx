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
    // the price map draws the structure against price
    expect(screen.getByTestId('price-map').getAttribute('aria-label')).toMatch(/7410.*strikes 7305, 7345, 7450, 7495/);
  });

  it('Log trade still opens the note and writes through onLogTrade', async () => {
    const onLog = vi.fn(() => Promise.resolve(true));
    render(<EnginePanel mode="0dte" onLogTrade={onLog} accountConfig={{ id: 'acct', bankroll: 25000 }}
      strategyHistory={{}} toast={() => {}}
      initialState={{ i0: { ...base, netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' } }} />);
    fireEvent.click(screen.getByTestId('log-trade'));
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(onLog).toHaveBeenCalledTimes(1);
  });

  it('switching to an alternative card clears the old legs’ sizing', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' });
    const cards = screen.getAllByTestId('choice-card');
    expect(cards.length).toBe(3);
    expect(cards[0].dataset.current).toBe('1');
    fireEvent.click(screen.getAllByTestId('choice-switch')[0]);
    expect(screen.getByTestId('verdict').textContent).not.toBe('Take it smaller, or pass');
    expect(screen.getByTestId('needs-you').textContent).toMatch(/Enter sizing/);
  });

  it('says pass when EV after commission is negative, and Kelly is shown as no edge', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '80' });
    expect(screen.getByTestId('verdict').textContent).toBe('Pass at this price');
    expect(screen.getByTestId('execution').textContent).toMatch(/no edge at this price/);
    expect(screen.getByTestId('commission-cell').textContent).toMatch(/4 contracts × \$0\.65 × 2 sides/);
  });

  it('puts the trade on one line, low strike to high, in order-ticket form', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' });
    const line = screen.getByTestId('strike-line');
    expect(line.style.flexWrap).toBe('nowrap');
    expect(line.textContent.replace(/[≡ⓘ\s]/g, '')).toBe('+7305Put\u22127345Put\u22127450Call+7495Call');
  });

  it('ladder rows show what moving the leg does to the trade, without the bridge', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '92' });
    const opener = screen.getByTestId('strike-line').querySelectorAll('span[title^="Strike ladder"]')[1];
    fireEvent.click(opener);
    const rows = screen.getAllByTestId('ladder-row');
    expect(rows.length).toBe(7);
    expect(rows.filter(r => /\d+\.\d%/.test(r.textContent)).length).toBe(7);
    expect(screen.getByTestId('ladder').textContent).toMatch(/Bridge URL not set/);
  });

  it('lists what the Bridge does not supply on the evidence line, red when required', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '', risk: '', pop: '' });
    const chips = screen.getByTestId('input-chips');
    ['win', 'risk', 'pop'].forEach(k => expect(screen.getByTestId('input-chip-' + k).dataset.state).toBe('missing'));
    expect(chips.textContent).toMatch(/3 to enter/);
    fireEvent.click(screen.getByTestId('input-chip-win'));
    expect(screen.getByTestId('evidence-body').style.display).toBe('block');
  });

  it('keeps the sizing row while you type the last field, so the input never disappears mid-number', () => {
    mount({ netCreditDebit: '6.36', gamma: '-0.2', win: '636', risk: '3364', pop: '' });
    const pop = screen.getByTestId('needs-you').querySelectorAll('input')[2];
    fireEvent.focus(pop);
    fireEvent.change(pop, { target: { value: '9' } });
    expect(document.body.contains(pop)).toBe(true);
    fireEvent.change(pop, { target: { value: '92' } });
    expect(pop.value).toBe('92');
    expect(screen.getByTestId('need-size').dataset.resolved).toBe('1');
    fireEvent.blur(pop, { relatedTarget: null });
    expect(screen.queryByTestId('need-size')).toBeNull();
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
