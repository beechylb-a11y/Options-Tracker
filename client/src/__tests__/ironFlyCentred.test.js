// A centred fly is built as an iron fly; the iron fly closes by 13:30 ET (18 Nov 2026).
import { describe, it, expect } from 'vitest';
import { calc0DTE } from '../engine/calc0dte';
import { exitRuleFor } from '../engine/data';
import { review0 } from '../engine/review0';
import { planText } from '../utils/ticketMath';

// Neutral, compressing, most of the move used: the butterfly zone, where the standard
// fly and the iron fly both rate EXCELLENT.
const base = { price: 7410, high: 7430, low: 7392, vwap5: 7410, vwap5_30: 7410, vwapRoll30: 7410, vwapRoll30Prior: 7410,
  vwapAccept: 0.5, atr: 61, em: 38, atr5: 2, atr2h: 12, gamStrike: 0, vix: 15.8, vix1d: 12.9, esOvernightHigh: 7425,
  esOvernightLow: 7395, esClose: 7380, priorDayClose: 7410, cashOpen: 7380, esEM: 40, overnightStale: false,
  bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, theta: 0, delta: 0, gamma: 0, hours: 3.5,
  underlying: 'SPX', overrideStrikes: null, vertVariant: 'engine', historyByStrategy: null,
  emSource: 'straddle', straddleCall: 21.5, straddlePut: 20.8, straddleHaircut: 1.2533,
  win: 0, risk: 0, pop: 0, comboBid: null, comboAsk: null, netCreditDebit: 0 };

describe('centred fly → iron fly', () => {
  it('on a tie with the standard fly and the body at the money, the pick is the iron fly', () => {
    const r = calc0DTE(base);
    const std = r.ratings.find(s => s.name === 'Standard butterfly');
    const iron = r.ratings.find(s => s.name === 'Iron butterfly');
    expect(std.rating).toBe(iron.rating);                       // the tie that used to go to list order
    expect(r.bestRating).toBe('EXCELLENT');
    expect(r.bestStrat).toBe('Iron butterfly');
    expect(r.flyForm).toBe('iron');
    expect(r.runnerUp).toMatchObject({ name: 'Standard butterfly' });
    expect(r.legs).toHaveLength(4);
    const shorts = r.legs.filter(l => /short/i.test(l.label)).map(l => l.strike);
    expect(Math.abs(shorts[0] - base.price)).toBeLessThanOrEqual(10);
  });
  it('a body moved off spot (gamma strike) keeps the standard fly', () => {
    const r = calc0DTE({ ...base, gamStrike: 7430 });
    expect(r.flyForm).toBeNull();
    expect(r.bestStrat).not.toBe('Iron butterfly');
  });
  it('an override to the standard fly still builds the standard fly', () => {
    const r = calc0DTE({ ...base, overrideStrategy: 'Standard butterfly' });
    expect(r.legStrat).toBe('Standard butterfly');
    expect(r.legs).toHaveLength(3);
  });
});

describe('iron fly time exit', () => {
  it('the rule carries 13:30 ET and the plan text says so', () => {
    expect(exitRuleFor('0DTE', 'Iron butterfly')).toMatchObject({ target: 25, closeEt: '13:30' });
    expect(exitRuleFor('0DTE', 'Standard butterfly').closeEt).toBeUndefined();
    const pos = { isCredit: true, entryPrice: 22.5, qty: 1, qtyOpen: 1, basis: 'entry' };
    expect(planText(pos, [{ qty: 1, pct: 25 }], '', { closeEt: '13:30' })).toMatch(/Close by: 13:30 ET, whatever the P&L/);
  });
  const legs = [{ strike: 7380, right: 'P', qty: 1 }, { strike: 7410, right: 'P', qty: -1 }, { strike: 7410, right: 'C', qty: -1 }, { strike: 7440, right: 'C', qty: 1 }];
  const at = hm => new Date(`2026-11-18T${hm}:00-05:00`);
  const p = (hm, mark) => ({ legs, qtyOpen: 1, entry: { ncd: 22.5, maxProfit: 2250 }, now: { mark, spot: 7412, at: at(hm) }, underlying: 'SPX', strategy: 'Iron butterfly' });
  it('before 13:30 it counts down to the time exit', () => {
    const r = review0(p('12:00', -20));
    expect(r.metrics.exitEt).toBe('13:30');
    expect(r.metrics.minutesToExit).toBe(90);
    expect(r.steps.join(' ')).toMatch(/to the 13:30 exit/);
  });
  it('after 13:30 the check-up says close, whatever the P&L', () => {
    const r = review0(p('13:45', -21));
    expect(r.action).toBe('close');
    expect(r.headline).toMatch(/13:30 time exit/);
  });
  it('a standard fly keeps the 15:00 working close', () => {
    const r = review0({ ...p('13:45', 2), legs: [{ strike: 7380, right: 'C', qty: 1 }, { strike: 7410, right: 'C', qty: -2 }, { strike: 7440, right: 'C', qty: 1 }], entry: { ncd: -8, maxProfit: 2200 }, strategy: 'Standard butterfly' });
    expect(r.metrics.exitEt).toBe('15:00');
    expect(r.action).not.toBe('close');
  });
});
