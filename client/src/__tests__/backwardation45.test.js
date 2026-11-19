/* Backwardation on a 45DTE ticket (20 Nov 2026). It used to block EVERY structure —
   an SPY iron condor included — under "avoid naked short premium". The playbook says
   "Defined risk credit spreads only — avoid calendars, reduce size". Now: naked premium
   and calendars/diagonals are blocked; defined-risk trades go through, warned, at half Kelly. */
import { describe, it, expect } from 'vitest';
import { calc45DTE } from '../engine/calc45dte';

const base = { underlying: 'SPY', price: 728, ivr: 60, iv: 19.2, hv: 17, vix: 25.6, dte: 42, outlook: 'neutral',
  pop: 62, win: 300, risk: 700, bankroll: 50000, startBR: 50000, maxLoss: 1000, maxOpen: 5000 };
const run = (strat, termBias) => calc45DTE({ ...base, termBias, overrideStrategy: strat });

describe('backwardation', () => {
  it('an iron condor (defined risk) is no longer blocked: warned, half Kelly', () => {
    const b = run('Iron Condor - Normal', 'backwardation');
    const c = run('Iron Condor - Normal', 'contango');
    expect(b.hardBlocker).toBe('');
    expect(b.warnings.some(w => /^Backwardation — near-term IV above far: defined risk only, sized at half Kelly/.test(w))).toBe(true);
    expect(b.kellyContracts).toBe(c.halfC);
    expect(c.warnings.some(w => /Backwardation/.test(w))).toBe(false);
  });
  it('defined-risk verticals and butterflies trade too', () => {
    for (const s of ['Credit spread', 'Iron butterfly', 'Broken wing butterfly', 'Bull call spread']) {
      expect(run(s, 'backwardation').hardBlocker, s).toBe('');
    }
  });
  it('naked short premium is still blocked, jade lizard included', () => {
    for (const s of ['Short strangle', 'Short put', 'Jade lizard']) {
      const r = run(s, 'backwardation');
      expect(r.hardBlocker, s).toBe('Backwardation — no naked short premium; use a defined-risk structure');
      expect(r.decision).toBe('No trade');
    }
  });
  it('calendars and diagonals are blocked: the front month is the rich one', () => {
    for (const s of ['Calendar spread', 'Diagonal spread']) {
      expect(run(s, 'backwardation').hardBlocker, s).toBe('Backwardation — no calendars or diagonals while the front month is the rich one');
    }
  });
});
