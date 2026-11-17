// Exit plan card + "Stage in TWS" (Nov 2026). The bridge stages the entry and the profit
// target(s) with transmit off; a stop is never sent.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
afterEach(cleanup);
import { buildStage } from '../../../bridge/stageOrder.js';
import ExitPlanCard, { exitNumbers, spreadLabels } from '../components/ExitPlanCard';

const PUT_SPREAD = [
  { strike: 674, right: 'P', qty: -1, expiry: '20261116' },
  { strike: 672, right: 'P', qty: 1, expiry: '20261116' },
];

describe('buildStage', () => {
  it('a credit spread: SELL the combo at the credit, BUY it back at the target, legs flipped, prices positive', () => {
    const p = buildStage({ underlying: 'qqq', legs: PUT_SPREAD, lots: 4, side: 'credit', entry: 0.66, targets: [{ qty: 4, price: 0.5 }], tif: 'DAY' });
    expect(p.error).toBeUndefined();
    expect(p.parent).toMatchObject({ action: 'SELL', totalQuantity: 4, lmtPrice: 0.66, orderType: 'LMT', transmit: false, tif: 'DAY' });
    expect(p.children).toHaveLength(1);
    expect(p.children[0]).toMatchObject({ action: 'BUY', totalQuantity: 4, lmtPrice: 0.5, transmit: false });
    // Selling a combo reverses each leg, so the combo is defined flipped: selling it
    // opens SHORT 674P / LONG 672P, the ticket.
    expect(p.comboLegs.map(l => [l.legKey, l.action, l.ratio])).toEqual([['20261116|674|P', 'BUY', 1], ['20261116|672|P', 'SELL', 1]]);
    expect(p.summary[0]).toBe('SELL 4 QQQ 674/672 @ 0.66 cr DAY');
  });

  it('a debit butterfly: BUY at the debit, SELL the targets, legs as on the ticket, GTC targets', () => {
    const fly = [{ strike: 7300, right: 'C', qty: 1, expiry: '20261218' }, { strike: 7350, right: 'C', qty: -2, expiry: '20261218' }, { strike: 7400, right: 'C', qty: 1, expiry: '20261218' }];
    const p = buildStage({ underlying: 'SPX', legs: fly, lots: 3, side: 'debit', entry: 12.4, targets: [{ qty: 2, price: 15.5 }, { qty: 1, price: 18.6 }], tif: 'GTC' });
    expect(p.parent).toMatchObject({ action: 'BUY', lmtPrice: 12.4 });
    expect(p.children.map(c => [c.action, c.totalQuantity, c.lmtPrice, c.tif])).toEqual([['SELL', 2, 15.5, 'GTC'], ['SELL', 1, 18.6, 'GTC']]);
    expect(p.comboLegs.map(l => [l.action, l.ratio])).toEqual([['BUY', 1], ['SELL', 2], ['BUY', 1]]);
  });

  it('never builds a stop, and every order is untransmitted', () => {
    const p = buildStage({ underlying: 'QQQ', legs: PUT_SPREAD, lots: 2, side: 'credit', entry: 0.66, targets: [{ qty: 2, price: 0.5 }], stop: 1.32, stopPrice: 1.32 });
    const all = [p.parent, ...p.children];
    expect(all.every(o => o.transmit === false && o.orderType === 'LMT')).toBe(true);
    expect(all.some(o => /STP/.test(o.orderType))).toBe(false);
    expect(p.children).toHaveLength(1);
  });

  it('refuses a target on the wrong side of the entry, too many target contracts, and bad legs', () => {
    expect(buildStage({ underlying: 'QQQ', legs: PUT_SPREAD, lots: 2, side: 'credit', entry: 0.66, targets: [{ qty: 2, price: 0.8 }] }).error).toMatch(/cost less/);
    expect(buildStage({ underlying: 'QQQ', legs: PUT_SPREAD, lots: 2, side: 'debit', entry: 0.66, targets: [{ qty: 2, price: 0.5 }] }).error).toMatch(/more than it cost/);
    expect(buildStage({ underlying: 'QQQ', legs: PUT_SPREAD, lots: 2, side: 'credit', entry: 0.66, targets: [{ qty: 3, price: 0.5 }] }).error).toMatch(/more than the 2/);
    expect(buildStage({ underlying: 'QQQ', legs: [PUT_SPREAD[0]], lots: 2, side: 'credit', entry: 0.66 }).error).toMatch(/2–4 leg/);
    expect(buildStage({ underlying: 'QQQ', legs: [{ ...PUT_SPREAD[0], expiry: '' }, PUT_SPREAD[1]], lots: 2, side: 'credit', entry: 0.66 }).error).toMatch(/expiry/);
    expect(buildStage({ underlying: 'QQQ', legs: PUT_SPREAD, lots: 0, side: 'credit', entry: 0.66 }).error).toMatch(/Contracts/);
  });
});

const PLAN = { priced: [{ qty: 4, pct: 25, price: 0.5 }], stopPrice: 1.32, commRoundTrip: 10.4, basis: 'entry' };

describe('exit plan numbers', () => {
  it('prices the ladder and the outcomes for the contracts on the ticket', () => {
    const N = exitNumbers({ net: 0.66, win: 66, qty: 4, plan: PLAN, maxRisk: 536 });
    expect(N.isCredit).toBe(true);
    expect(N.targets[0].gain).toBe(64);
    expect(N.stop).toBe(-264);
    expect(N.max).toBe(264);
    expect(N.reward).toBeCloseTo(53.6, 5);
    expect(N.risk).toBeCloseTo(274.4, 5);
    expect(N.rr).toBeCloseTo(53.6 / 274.4, 5);
  });
  it('labels never sit on top of each other', () => {
    const lx = spreadLabels([0, 66.7, 71.7, 100]);
    for (let i = 1; i < lx.length; i++) expect(lx[i] - lx[i - 1]).toBeGreaterThanOrEqual(11.99);
    expect(Math.max(...lx)).toBeLessThanOrEqual(95);
  });
});

describe('ExitPlanCard', () => {
  beforeEach(() => {
    localStorage.setItem('bridgeUrl', 'https://bridge.test');
    localStorage.removeItem('stage-account-v1');
    global.fetch = vi.fn(async (url, opts) => {
      if (String(url).includes('/api/health')) return { ok: true, json: async () => ({ connected: true, mode: 'paper', accounts: ['DU111', 'DU222'] }) };
      if (String(url).includes('/api/stage-order')) return { ok: true, status: 200, json: async () => ({ ok: true, staged: true, transmitted: false, summary: ['SELL 4 QQQ 674/672 @ 0.66 cr', 'BUY 4 @ 0.50 (profit target)'], account: JSON.parse(opts.body).account }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
  });

  const props = { head: { underlying: 'QQQ', strikes: [672, 674], strategy: 'Bull put spread', expiryLabel: '16 Nov' },
    net: 0.66, win: 66, qty: 4, plan: PLAN, maxRisk: 536, stageLegs: PUT_SPREAD, tif: 'DAY', orderRef: 'SB QQQ 672/674' };

  it('shows the TWS rows in keying order, with your stop marked not sent', () => {
    render(<ExitPlanCard {...props} />);
    expect(screen.getByTestId('tws-row-entry').textContent).toMatch(/SELL 4.*QQQ 16 Nov 672 \/ 674.*0\.66.*CR/);
    expect(screen.getByTestId('tws-row-target-0').textContent).toMatch(/BUY 4.*Profit taker.*0\.50/);
    expect(screen.getByTestId('tws-row-stop').textContent).toMatch(/Stop at 1\.32.*not sent/);
    expect(screen.getByTestId('exit-out-target').textContent).toMatch(/\+\$54/);
    expect(screen.getByTestId('exit-out-stop').textContent).toMatch(/−\$274/);
  });

  it('stages the entry and the profit target only — no stop in the request', async () => {
    const onStaged = vi.fn();
    render(<ExitPlanCard {...props} onStaged={onStaged} />);
    await waitFor(() => expect(screen.getByTestId('stage-mode').textContent).toBe('PAPER'));
    fireEvent.change(screen.getByTestId('stage-account'), { target: { value: 'DU222' } });
    fireEvent.click(screen.getByTestId('stage-btn'));
    await waitFor(() => expect(screen.getByTestId('stage-ok').textContent).toMatch(/not transmitted/));
    const call = global.fetch.mock.calls.find(c => String(c[0]).includes('/api/stage-order'));
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({ underlying: 'QQQ', lots: 4, side: 'credit', entry: 0.66, targets: [{ qty: 4, price: 0.5 }], tif: 'DAY', account: 'DU222', orderRef: 'SB QQQ 672/674' });
    expect(body.entryTif).toBe('DAY');
    expect(JSON.stringify(body)).not.toMatch(/stop/i);
    expect(onStaged).toHaveBeenCalled();
  });

  it('says why when the ticket cannot be staged', () => {
    render(<ExitPlanCard {...props} stageLegs={null} stageWhyNot="TWS combos here take up to 4 legs — key this one by hand." />);
    expect(screen.queryByTestId('stage-btn')).toBeNull();
    expect(screen.getByTestId('stage-off').textContent).toMatch(/up to 4 legs/);
  });
});
