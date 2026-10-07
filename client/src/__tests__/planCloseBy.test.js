/* The logged exit plan carries the 45DTE close-by DTE (Oct 2026); before, the 7/21
   DTE pick on the profit taker never reached the notes. */
import { describe, it, expect } from 'vitest';
import { planText, normalisePosition } from '../utils/ticketMath';

describe('planText close-by', () => {
  const pos = normalisePosition({ qty: 3, qtyOpen: 3, entryPrice: -4.8, maxProfit: 763 * 3, underlying: 'QQQ', basis: 'entry' });
  it('adds the close-by line with its date', () => {
    const t = planText(pos, [{ qty: 3, pct: 25 }], 100, { closeDte: 21, closeLeg: 'front leg', date: '30 Oct 2026' });
    expect(t).toMatch(/T1: 3x @ 6\.00 cr/);
    expect(t).toMatch(/Stop: all @ 0\.00 cr/);
    expect(t).toMatch(/Close by: 21 DTE on the front leg \(30 Oct 2026\), whatever the P&L/);
  });
  it('leaves 0DTE plans as they were', () => {
    expect(planText(pos, [{ qty: 3, pct: 25 }], 100)).not.toMatch(/Close by/);
  });
});
