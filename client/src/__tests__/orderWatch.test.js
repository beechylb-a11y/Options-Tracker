// Staged-order watch (18 Nov 2026): the 12:30 ET cut-off and the market at send / at fill.
import { describe, it, expect } from 'vitest';
import { execStem, comboMidOf, ticketSign, execSign, cutoffAction, dueCutoffs, prune } from '../../../bridge/orderWatch.js';

describe('combo quote', () => {
  it('a bull put spread, ticket-signed: short leg in, long leg out', () => {
    // short 674P 1.20/1.30, long 672P 0.60/0.70 → mid credit 0.60, natural 0.50, spread 0.20
    const q = comboMidOf([{ sign: ticketSign(-1), qty: 1, bid: 1.2, ask: 1.3 }, { sign: ticketSign(1), qty: 1, bid: 0.6, ask: 0.7 }], 1);
    expect(q).toMatchObject({ mid: 0.6, natural: 0.5, best: 0.7, spread: 0.2 });
  });
  it('a 2-lot fly from executions: quantities divide back to one lot', () => {
    const q = comboMidOf([{ sign: execSign('BOT'), qty: 2, bid: 5, ask: 5.2 }, { sign: execSign('SLD'), qty: 4, bid: 3, ask: 3.1 }, { sign: execSign('BOT'), qty: 2, bid: 1.6, ask: 1.7 }]);
    expect(q.lots).toBe(2);
    expect(q.mid).toBeCloseTo(-(5.1 + 1.65) + 2 * 3.05, 6);   // a debit is negative
    expect(q.spread).toBeCloseTo(0.2 + 0.1 * 2 + 0.1, 6);
  });
  it('a zero bid on a wing is a quote; no ask is not', () => {
    expect(comboMidOf([{ sign: 1, qty: 1, bid: 0.1, ask: 0.15 }, { sign: -1, qty: 1, bid: 0, ask: 0.05 }], 1).mid).toBeCloseTo(0.1, 6);
    expect(comboMidOf([{ sign: 1, qty: 1, bid: 0.1, ask: 0.15 }, { sign: -1, qty: 1, bid: 0 }], 1)).toBeNull();
  });
  it('execution id stem groups the legs of one fill', () => {
    expect(execStem('00020057.6ae1e1c9.02.01')).toBe('00020057.6ae1e1c9');
  });
});

describe('cut-off', () => {
  it('cancels only an order that is open and has filled nothing', () => {
    expect(cutoffAction({ found: true, status: 'Submitted', filled: 0 })).toBe('cancel');
    expect(cutoffAction({ found: true, status: 'PreSubmitted' })).toBe('cancel');
    expect(cutoffAction({ found: true, status: 'Submitted', filled: 2 })).toBe('partial');
    expect(cutoffAction({ found: true, status: 'Filled', filled: 4 })).toBe('filled');
    expect(cutoffAction({ found: true, status: 'Cancelled' })).toBe('gone');
    expect(cutoffAction(undefined)).toBe('gone');
  });
  it('due = past cancelAt and not yet handled', () => {
    const reg = { 1: { parentId: 1, cancelAt: 100 }, 2: { parentId: 2, cancelAt: 300 }, 3: { parentId: 3, cancelAt: 50, done: 'cancel' }, 4: { parentId: 4, cancelAt: null } };
    expect(dueCutoffs(reg, 200).map(e => e.parentId)).toEqual([1]);
  });
  it('prunes old entries', () => {
    const now = Date.parse('2026-11-18T00:00:00Z');
    const o = prune({ a: { at: '2026-11-17T00:00:00Z' }, b: { at: '2026-10-01T00:00:00Z' } }, now, 10);
    expect(Object.keys(o)).toEqual(['a']);
  });
});
