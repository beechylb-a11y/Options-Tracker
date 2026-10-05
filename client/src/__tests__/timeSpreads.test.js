/* Calendar / diagonal expiries (Oct 2026): the engine said "short front-month /
   long back-month" with no dates and rounded SPX strikes to 0.5 (7776.5). */
import { describe, it, expect } from 'vitest';
import { fridaysFrom, timeSpreadDefaults, nearChoices, farChoices, dteBetween, legRole } from '../utils/expiries';
import { calc45DTE } from '../engine/calc45dte';

const today = '20261006';   // Tue 6 Oct 2026
const fridays = fridaysFrom(today);

describe('expiry choices', () => {
  it('falls back to weekly Fridays', () => {
    expect(fridays[0]).toBe('20261009');
    expect(fridays.every(e => new Date(+e.slice(0, 4), +e.slice(4, 6) - 1, +e.slice(6, 8)).getDay() === 5)).toBe(true);
  });
  it('defaults the near leg to the ticket DTE and the far leg about a month later', () => {
    const { near, far } = timeSpreadDefaults('Calendar spread', '45', fridays, today);
    expect(near).toBe('20261120');
    expect(dteBetween(near, far)).toBe(28);
    const d = timeSpreadDefaults('Diagonal spread', '45', fridays, today);
    expect(dteBetween(d.near, d.far)).toBe(42);
  });
  it('uses the listed chain when it has one', () => {
    const chain = ['20261016', '20261120', '20261218', '20270115'];
    const { near, far } = timeSpreadDefaults('Calendar spread', '45', chain, today);
    expect([near, far]).toEqual(['20261120', '20261218']);
  });
  it('offers five choices around each pick, far always after near', () => {
    expect(nearChoices(fridays, today, '20261120')).toEqual(['20261106', '20261113', '20261120', '20261127', '20261204']);
    expect(farChoices(fridays, '20261120', '20261218').every(e => e > '20261120')).toBe(true);
  });
});

describe('engine time-spread legs', () => {
  const base = { underlying: 'SPX', price: 7410, ivr: 30, iv: 16, hv: 13, vix: 15.8, ivFront: 15, ivBack: 16.5, skew: 3,
    termBias: 'contango', dte: 45, outlook: 'neutral', pop: 0, win: 0, risk: 0, bankroll: 25000, startBR: 25000,
    maxLoss: 600, maxOpen: 900, bpr: 0, theta: 0, vega: 0, delta: 0 };
  it('names the near and far legs, with call or put, on listed SPX strikes', () => {
    const r = calc45DTE({ ...base, overrideStrategy: 'Calendar spread' });
    expect(r.legs.map(l => legRole(l.label)).sort()).toEqual(['far', 'near']);
    expect(r.legs.every(l => /call|put/i.test(l.label))).toBe(true);
    expect(r.legs.every(l => l.strike % 5 === 0)).toBe(true);
  });
  it('builds a bearish diagonal from puts, short strike below', () => {
    const r = calc45DTE({ ...base, outlook: 'bearish', overrideStrategy: 'Diagonal spread' });
    const short = r.legs.find(l => /short/i.test(l.label)), long = r.legs.find(l => /long/i.test(l.label));
    expect(/put/i.test(short.label) && /put/i.test(long.label)).toBe(true);
    expect(short.strike).toBeLessThan(long.strike);
  });
});
