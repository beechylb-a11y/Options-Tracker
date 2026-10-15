import { describe, it, expect } from 'vitest';
import { rollSummary, carriedFromTws, normalisePosition } from '../utils/ticketMath';

// QQQ 699/709/805/815 condor, 2.44 cr x5, rolled 805/815 → 755/765 on 15 Oct 2026.
// TWS fills: 805C 0.43 / 815C 0.21 (0.22 db), 755C 6.56 / 765C 4.07 (2.49 cr).
// Puts entered at 709P 6.62 / 699P 5.34 → 1.28 cr carried.
const pos = normalisePosition({ entryPrice: 2.44, qty: 5, legs: '699 / 709 / 805 / 815', engine: '45DTE' });

describe('partial roll — carried legs', () => {
  it('without carried legs: the old (whole-position) behaviour is unchanged', () => {
    const r = rollSummary(pos, 5, 1.50, 3.77);
    expect(r.closeFull).toBe(1.5);
    expect(r.openFull).toBe(3.77);
    expect(r.realised).toBe(470);
  });

  it('books the carried puts through at entry: old banks the calls only, new opens at 3.77', () => {
    const r = rollSummary(pos, 5, 0.22, 2.49, 1.28);
    expect(r.closeFull).toBe(1.5);
    expect(r.openFull).toBe(3.77);
    expect(r.realised).toBe(470);     // TWS realised $471.70 (net of comm)
    expect(r.net).toBe(2.27);         // the TWS combo filled at 11.35 for 5 = 2.27
  });

  it('works for a debit structure carrying a debit leg', () => {
    const d = normalisePosition({ entryPrice: -3.00, qty: 1, legs: '100 / 105 / 110', engine: '45DTE' });
    // close moved legs for 1.00 cr, open new for 1.50 db, carried long leg cost 2.00 db
    const r = rollSummary(d, 1, 1.00, -1.50, -2.00);
    expect(r.closeFull).toBe(3);      // as if the whole thing sold for its cost
    expect(r.openFull).toBe(-3.5);
    expect(r.realised).toBe(0);
  });

  it('reads the carried legs from TWS positions', () => {
    const raw = [
      { underlying: 'QQQ', expiry: '20261120', strike: 699, right: 'P', qty: 5, perShare: 5.347 },
      { underlying: 'QQQ', expiry: '20261120', strike: 709, right: 'P', qty: -5, perShare: 6.614 },
      { underlying: 'QQQ', expiry: '20261120', strike: 755, right: 'C', qty: -5, perShare: 6.553 },
      { underlying: 'SPY', expiry: '20261120', strike: 699, right: 'P', qty: 1, perShare: 9 },
    ];
    expect(carriedFromTws(raw, 'QQQ', [699, 709])).toBe(1.27);
    expect(carriedFromTws(raw, 'QQQ', [699, 712])).toBeNull();
  });
});
