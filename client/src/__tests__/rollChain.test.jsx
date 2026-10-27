/* A rolled position (Oct 2026): the open ticket plus what the tickets it was rolled
   from banked. QQQ condor 699/709/805/815 rolled its calls to 755/765 on 15 Oct,
   banking $446.50; the new ticket is −$460, so the position is −$13. */
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rollChain, rolledFromRef, rollNetOf, cumulativeBasisOf, legIvsFromNotes } from '../engine/rollChain';
import { reviewOpen45 } from '../engine/review45';

const T57 = { _rowIndex: 57, Timestamp: '2026-10-15T16:10:39.966Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts',
  Contracts: '5', 'Wing Strikes': '699 / 709 / 755 / 765', 'Net Debit/Credit': '3.77', 'Max Profit': '1885', 'Max Risk': '3115', Price: '724.49', IV: '21.4',
  Notes: 'Rolled from TICKET-54 (699 / 709 / 805 / 815, entry 2.44 cr). Closed old @ 0.22 db, realised $1,087 on 5. Opened new @ 2.49 cr. Net roll 2.27 cr; cumulative basis 4.72 cr.' };
const T54 = { _rowIndex: 54, Timestamp: '2026-10-08T03:14:12.659Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts',
  Contracts: '5', 'Wing Strikes': '699 / 709 / 805 / 815', 'Net Debit/Credit': '2.445', Notes: '' };
const CLOSES = [{ 'Ticket Ref': '54', 'Close Date': '2026-10-15', 'P&L ($)': '446.5' }, { 'Ticket Ref': '12', 'Close Date': '2026-10-01', 'P&L ($)': '99' }];

describe('roll chain', () => {
  it('reads the notes a roll writes', () => {
    expect(rolledFromRef(T57.Notes)).toBe(54);
    expect(rollNetOf(T57.Notes)).toBe(2.27);
    expect(cumulativeBasisOf(T57.Notes)).toBe(4.72);
    expect(legIvsFromNotes('Legs: …\nLeg IVs: 699P 26.10 / 709P 24.5 / 755C 17\n')).toEqual({ '699P': 26.1, '709P': 24.5, '755C': 17 });
  });
  it('walks back to the first ticket and adds up what it banked', () => {
    const c = rollChain(T57, { decisions: [T54, T57], closes: CLOSES });
    expect(c.rolls).toBe(1);
    expect(c.banked).toBe(446.5);
    expect(c.startYmd).toBe('20261008');
    expect(c.links[0]).toMatchObject({ ref: 54, strikes: '699 / 709 / 805 / 815', closeYmd: '20261015', net: 2.27 });
    expect(rollChain(T54, { decisions: [T54, T57], closes: CLOSES })).toBe(null);
  });
  it('follows two rolls, and stops on a loop', () => {
    const T60 = { _rowIndex: 60, Timestamp: '2026-10-20T15:00:00Z', Notes: 'Rolled from TICKET-57 (…). Net roll 0.40 cr' };
    const c = rollChain(T60, { decisions: [T54, T57, T60], closes: [...CLOSES, { 'Ticket Ref': '57', 'Close Date': '2026-10-20', 'P&L ($)': '-120' }] });
    expect(c.rolls).toBe(2);
    expect(c.banked).toBeCloseTo(326.5, 6);
    const loop = { _rowIndex: 1, Notes: 'Rolled from TICKET-1' };
    expect(rollChain(loop, { decisions: [loop] })).toBe(null);
  });
});

describe('review with leg IVs logged at entry', () => {
  const legs = [[699, 'P', 1], [709, 'P', -1], [755, 'C', -1], [765, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120' }));
  const nowIv = { '699P': 26, '709P': 24.5, '755C': 17, '765C': 16.5 };
  const base = { strategy: 'Iron Condor - Normal', qtyOpen: 5, underlying: 'QQQ',
    now: { todayYmd: '20261021', spot: 722.51, iv: 21.5, mark: -4.69 } };
  const L = legs.map(l => ({ ...l, iv: nowIv[l.strike + l.right] }));
  it('puts a skew move in the IV line instead of "not explained"', () => {
    const atm = reviewOpen45({ ...base, legs: L, entry: { ncd: 3.77, dateYmd: '20261015', spot: 724.49, iv: 21.4, maxProfit: 377 } });
    // entry at the same skew shape, put IVs 3 points lower than now
    const legIvs = { '699P': 23, '709P': 21.5, '755C': 17, '765C': 16.5 };
    const sk = reviewOpen45({ ...base, legs: L, entry: { ncd: 3.77, dateYmd: '20261015', spot: 724.49, iv: 21.4, maxProfit: 377, legIvs } });
    expect(sk.metrics.attribution.skewIncluded).toBe(true);
    expect(atm.metrics.attribution.skewIncluded).toBe(false);
    expect(sk.metrics.attribution.vol).toBeLessThan(atm.metrics.attribution.vol);           // short puts lose on their IV rise
    expect(Math.abs(sk.metrics.attribution.other)).toBeLessThan(Math.abs(atm.metrics.attribution.other));
    // and the plan path runs from 0 at entry to the planned close
    expect(sk.metrics.planCurve[0].pnl$).toBe(0);
    expect(sk.metrics.planCurve.length).toBe(sk.metrics.planDays + 1);
    expect(sk.metrics.planClose$).toBeGreaterThan(sk.metrics.plan$);
  });
});

vi.mock('../utils/api', () => ({ api: {
  getOpenPositions: () => Promise.resolve([{ ticketRef: 57, timestamp: T57.Timestamp, qty: 5, qtyOpen: 5, qtyFilled: 5 }]),
  getDecisions: () => Promise.resolve([T54, T57]),
  getCloses: () => Promise.resolve(CLOSES),
} }));
import Checkup45 from '../components/Checkup45';

describe('check-up card for a rolled position', () => {
  const Q = { '699P': [6.30, 26, -0.2], '709P': [9.40, 24.5, -0.3], '755C': [2.10, 17, 0.18], '765C': [0.51, 16.5, 0.08] };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-21T15:00:00Z'));
    localStorage.setItem('bridgeUrl', 'http://bridge');
    global.fetch = vi.fn(url => {
      const u = String(url);
      let body = {};
      if (u.includes('/api/positions')) body = { raw: [[699, 'P', 5], [709, 'P', -5], [755, 'C', -5], [765, 'C', 5]]
        .map(([strike, right, qty]) => ({ underlying: 'QQQ', expiry: '20261120', strike, right, qty })) };
      else if (u.includes('/api/vol-surface')) body = { spot: 722.51, iv: 21.5, daily: [] };
      else if (u.includes('/api/option-greeks')) {
        const legs = JSON.parse(decodeURIComponent(u.split('legs=')[1]));
        body = { undPrice: 722.51, net: { delta: -60, theta: 30, vega: -80 },
          legs: legs.map(l => { const z = Q[l.strike + l.right] || [1, 20, 0.1]; return { ...l, greeks: { bid: z[0] - 0.03, ask: z[0] + 0.03, iv: z[1], delta: z[2] } }; }) };
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });

  it('shows the position with the roll, the plan chart and the breakdown in $ for all contracts', async () => {
    render(<Checkup45 tickets={[T57]} />);
    fireEvent.click(screen.getByTestId('checkup-run'));
    await waitFor(() => expect(screen.getAllByTestId('checkup-card').length).toBe(1));
    expect(screen.getByTestId('position-pnl').textContent).toMatch(/−\$13[\s\S]*this ticket −\$460[\s\S]*banked \+\$447/);
    expect(screen.getByTestId('roll-history').textContent).toMatch(/8 Oct─ rolled 15 Oct \+\$447 ─15 Oct → now/);
    expect(screen.getByTestId('roll-history').innerHTML).toMatch(/699 \/ 709 \/ 805 \/ 815 · rolled 15 Oct/);
    expect(screen.getByTestId('checkup-summary').textContent).toMatch(/whole position is down \$13/);
    expect(screen.getByTestId('next-step').textContent).toMatch(/Next:/);
    const wf = screen.getByTestId('attribution').textContent;
    expect(wf).toMatch(/Banked when you rolled\+\$447/);
    expect(wf).toMatch(/Position now−\$13/);
    expect(screen.getByTestId('plan-track').textContent).toMatch(/rolled 15 Oct/);
    expect(screen.getByTestId('strip-legend').textContent).toMatch(/13\.5 above the 709P short/);
  });
});

describe('narrow condor vs broken condor (Oct 2026)', () => {
  const legs = (k1, k2, k3, k4, d) => [[k1, 'P', 1], [k2, 'P', -1], [k3, 'C', -1], [k4, 'C', 1]]
    .map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120', iv: 21, delta: d[strike + right] }));
  const base = { strategy: 'Iron Condor - Normal', qtyOpen: 5, underlying: 'QQQ', entry: { ncd: 3.99, dateYmd: '20261023', spot: 707.8, iv: 21, maxProfit: 399 } };
  it('price between the shorts, both ≥30Δ: watch, not "through the body"', () => {
    const r = reviewOpen45({ ...base, legs: legs(699, 709, 735, 745, { '699P': -0.33, '709P': -0.45, '735C': 0.32, '745C': 0.22 }),
      now: { todayYmd: '20261026', spot: 712.2, iv: 21, mark: -5.65 } });
    expect(r.action).toBe('watch');
    expect(r.headline).toMatch(/Narrow condor/);
    expect(r.reasons.join(' ')).not.toMatch(/run through the body/);
  });
  it('price through a short with the other tested too: close', () => {
    const r = reviewOpen45({ ...base, legs: legs(699, 709, 735, 745, { '699P': -0.45, '709P': -0.62, '735C': 0.31, '745C': 0.2 }),
      now: { todayYmd: '20261026', spot: 705, iv: 21, mark: -7.4 } });
    expect(r.action).toBe('close');
    expect(r.headline).toMatch(/Through the 709P/);
  });
});
