/* The roll as one order (Oct 2026): legs that move, live prices, a limit, and the
   order written out for TWS. QQQ 699/709/805/815 condor rolling its calls to 755/765. */
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRollOrder, priceRollOrder, rollOrderText } from '../engine/rollOrder';

const legs = [[699, 'P', 1], [709, 'P', -1], [805, 'C', -1], [815, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120' }));
const OLD = [699, 709, 805, 815];

describe('roll order', () => {
  it('moves only the legs whose strike changes: buy back the short, sell back the long, open both new', () => {
    const o = buildRollOrder({ oldLegs: legs, oldStrikes: OLD, newStrikes: ['699', '709', '755', '765'], lots: 5 });
    expect(o.legs.map(l => `${l.action} ${l.qty} ${l.strike}${l.right} ${l.role}`)).toEqual([
      'BUY 5 805C close', 'SELL 5 815C close', 'SELL 5 755C open', 'BUY 5 765C open']);
    expect(o.carried.map(l => l.strike)).toEqual([699, 709]);
    expect(o.all).toBe(false);
  });
  it('rolling out in time moves every leg, even at the same strikes', () => {
    const o = buildRollOrder({ oldLegs: legs, oldStrikes: OLD, newStrikes: OLD.map(String), newExpiry: '2026-12-18', lots: 1 });
    expect(o.legs.length).toBe(8);
    expect(o.legs.filter(l => l.role === 'open').every(l => l.expiry === '20261218')).toBe(true);
    expect(o.all).toBe(true);
  });
  it('prices it at mid and natural, split into the close and the open', () => {
    const o = buildRollOrder({ oldLegs: legs, oldStrikes: OLD, newStrikes: ['699', '709', '755', '765'], lots: 5 });
    // close: buy 805C (0.30/0.34), sell 815C (0.10/0.14); open: sell 755C (2.60/2.70), buy 765C (0.45/0.51)
    const q = [{ bid: 0.30, ask: 0.34 }, { bid: 0.10, ask: 0.14 }, { bid: 2.60, ask: 2.70 }, { bid: 0.45, ask: 0.51 }];
    const p = priceRollOrder(o.legs, q);
    expect(p).toMatchObject({ complete: true, closeMid: -0.2, openMid: 2.17, mid: 1.97, natural: 1.85 });
    const t = rollOrderText({ underlying: 'QQQ', legs: o.legs, price: p, limit: 1.97, lots: 5 });
    expect(t).toMatch(/BUY\s+5\s+QQQ 20 NOV 26 805 CALL\s+\(to close\)/);
    expect(t).toMatch(/SELL\s+5\s+QQQ 20 NOV 26 755 CALL\s+\(to open\)/);
    expect(t).toMatch(/Limit: 1\.97 CREDIT per combo/);
    expect(t).toMatch(/SELL the combo @ 1\.97/);
    expect(priceRollOrder(o.legs, [q[0]]).complete).toBe(false);
  });
  it('a leg moving onto another leg\'s strike nets into one TWS leg (TWS rejects the same contract twice)', () => {
    const c = [[699, 'P', 1], [709, 'P', -1], [755, 'C', -1], [765, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261120' }));
    const o = buildRollOrder({ oldLegs: c, oldStrikes: [699, 709, 755, 765], newStrikes: ['699', '709', '745', '755'], lots: 5 });
    const q = [{ bid: 1.10, ask: 1.16 }, { bid: 0.30, ask: 0.34 }, { bid: 2.05, ask: 2.15 }, { bid: 1.10, ask: 1.16 }];
    const p = priceRollOrder(o.legs, q, 5);
    expect(p.mid).toBe(0.16);
    const t = rollOrderText({ underlying: 'QQQ', legs: o.legs, price: p, limit: 0.16, lots: 5 });
    expect(t).toMatch(/BUY\s+10\s+QQQ 20 NOV 26 755 CALL\s+\(close \+ open, same contract\)/);
    expect(t.match(/755 CALL/g).length).toBe(1);
    expect(t).toMatch(/Combo ratio 2:1:1 × 5/);
    expect(t).toMatch(/SELL the combo @ 0\.16/);
  });
  it('an iron fly body (two legs at one strike) moves both', () => {
    const fly = [[6700, 'P', 1], [6740, 'P', -1], [6740, 'C', -1], [6780, 'C', 1]].map(([strike, right, qty]) => ({ strike, right, qty, expiry: '20261218' }));
    const o = buildRollOrder({ oldLegs: fly, oldStrikes: [6700, 6740, 6780], newStrikes: ['6700', '6760', '6780'], lots: 1 });
    expect(o.legs.filter(l => l.role === 'open').map(l => `${l.action} ${l.strike}${l.right}`)).toEqual(['SELL 6760P', 'SELL 6760C']);
  });
});

const T57 = { _rowIndex: 57, Timestamp: '2026-10-15T16:10:39.966Z', Notes: 'Rolled from TICKET-54' };
vi.mock('../utils/api', () => ({ api: { getDecisions: () => Promise.resolve([T57]) } }));
import RollOrderPanel from '../components/RollOrderPanel';

describe('roll order panel', () => {
  beforeEach(() => {
    localStorage.setItem('bridgeUrl', 'http://bridge');
    const MID = { '805C': [0.30, 0.34], '815C': [0.10, 0.14], '755C': [2.60, 2.70], '765C': [0.45, 0.51] };
    global.fetch = vi.fn(url => {
      const u = String(url);
      let body = {};
      if (u.includes('/api/positions')) body = { raw: legs.map(l => ({ underlying: 'QQQ', expiry: l.expiry, strike: l.strike, right: l.right, qty: l.qty * 5 })) };
      else if (u.includes('/api/option-greeks')) {
        const ls = JSON.parse(new URL(u).searchParams.get('legs'));
        body = { legs: ls.map(l => { const m = MID[l.strike + l.right] || [1, 1.1]; return { ...l, greeks: { bid: m[0], ask: m[1] } }; }) };
      }
      return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(body)) });
    });
  });
  afterEach(() => { cleanup(); localStorage.clear(); });

  it('finds the legs in TWS, prices the roll and fills the record fields', async () => {
    const onUse = vi.fn();
    const pos = { ticketRef: 57, timestamp: T57.Timestamp, underlying: 'QQQ', legs: '699 / 709 / 805 / 815', strategy: 'Iron Condor - Normal', qtyOpen: 5, isCredit: true };
    render(<RollOrderPanel pos={pos} roll={{ strikes: ['699', '709', '755', '765'], expiry: '' }} oldStrikes={OLD} lots={5} onUse={onUse} />);
    await waitFor(() => expect(screen.getAllByTestId('roll-leg').length).toBe(4));
    await waitFor(() => expect(screen.getByTestId('roll-net').textContent).toMatch(/1\.97 CREDIT/), { timeout: 3000 });
    expect(screen.getByTestId('roll-limit').value).toBe('1.97');
    expect(screen.getByTestId('roll-text').textContent).toMatch(/SELL the combo @ 1\.97/);
    fireEvent.click(screen.getByTestId('roll-use'));
    expect(onUse).toHaveBeenCalledWith({ closeAt: '0.20', openAt: '2.17', openSide: 'cr' });
  });
});
