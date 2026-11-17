// Nov 2026: 45DTE scans came back with IV / IV front / IV back / skew blank because the
// ATM strike was read off the all-expiry chain and did not exist at the chosen expiry.
import { describe, it, expect } from 'vitest';
import { isMonthly, nearestMonthly, nearestListed } from '../../../bridge/volSurface.js';

describe('vol surface expiries and strikes', () => {
  it('knows a standard monthly (third Friday, or the Thursday before a holiday Friday)', () => {
    expect(isMonthly('20261218')).toBe(true);     // Fri 18 Dec 2026
    expect(isMonthly('20261231')).toBe(false);    // Thu 31 Dec — a weekly
    expect(isMonthly('20270115')).toBe(true);     // Fri 15 Jan 2027
  });
  it('prefers the monthly near 45 days over a nearer weekly', () => {
    const exps = ['20261204', '20261211', '20261218', '20261224', '20261231', '20270108', '20270115', '20270219'];
    expect(nearestMonthly(exps, '20261228', '20261117', 1)).toBe('20261218');
    expect(nearestMonthly(exps, '20270101', '20261117', 1)).toBe('20270115');   // a tie goes to more time
    // no monthly within the window → plain nearest
    expect(nearestMonthly(['20261231', '20270108'], '20270101', '20261117', 1)).toBe('20261231');
  });
  it('picks the nearest strike LISTED as both a call and a put', () => {
    const L = { calls: [140, 145, 150, 155, 160], puts: [140, 145, 150, 155, 160] };
    expect(nearestListed(L, 153.64)).toBe(155);
    expect(nearestListed({ calls: [150, 155], puts: [150] }, 154)).toBe(150);
    expect(nearestListed(null, 154)).toBeNull();
  });
});
