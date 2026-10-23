import { describe, it, expect } from 'vitest';
import { rollSummary, normalisePosition } from '../utils/ticketMath';

describe('second roll basis', () => {
  it('builds on the earlier cumulative basis, not the current legs\' entry', () => {
    const pos = normalisePosition({ _rowIndex: 57, Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', 'Wing Strikes': '699 / 709 / 755 / 765',
      'Net Debit/Credit': '3.77', Contracts: '5', Notes: 'Rolled from TICKET-54. Net roll 2.27 cr; cumulative basis 4.72 cr.' });
    expect(pos.priorBasis).toBe(4.72);
    const rs = rollSummary(pos, 5, 1.18, 2.72, 1.27);
    expect(rs).toMatchObject({ net: 1.54, cumulative: 6.26, closeFull: 2.45, openFull: 3.99 });
    expect(rs.realised).toBeCloseTo(660, 6);
  });
  it('a first roll still starts from the entry', () => {
    const pos = normalisePosition({ 'Net Debit/Credit': '2.44', Contracts: '5', 'Wing Strikes': '699 / 709 / 805 / 815' });
    expect(rollSummary(pos, 5, 0.22, 2.49, 0).cumulative).toBe(4.71);
  });
});
