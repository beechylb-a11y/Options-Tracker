/* Two combo fills of one order in the same second (IWM 278/280/283, 28 Oct 11:58:40:
   1 lot and 5 lots) must stay two tranches — the second used to overwrite the first. */
import { describe, it, expect } from 'vitest';
import { comboTranches, fillIdFor } from '../utils/fillMatch';

const leg = (stem, n, time, strike, side, qty, price) => ({ execId: `00020057.${stem}.0${n}.01`, time: `20261028 ${time} US/Eastern`, symbol: 'IWM', secType: 'OPT',
  side, qty, price, orderId: 0, permId: 712120881, strike, right: 'C', expiry: '20261028', commission: 0.5 });
const fill = (stem, time, lots, p) => [
  { execId: `00020057.${stem}.01.01`, time: `20261028 ${time} US/Eastern`, symbol: 'IWM', secType: 'BAG', side: 'BOT', qty: lots, price: 0.37, orderId: 0, permId: 712120881, strike: 0 },
  leg(stem, 2, time, 283, 'BOT', lots, p[0]), leg(stem, 3, time, 280, 'SLD', 2 * lots, p[1]), leg(stem, 4, time, 278, 'BOT', lots, p[2]),
];
const ex = [
  ...fill('6ae1e145', '11:56:38', 1, [0.21, 1.16, 2.48]),
  ...fill('6ae1e1c9', '11:58:40', 1, [0.22, 1.19, 2.53]),
  ...fill('6ae1e1ca', '11:58:40', 5, [0.22, 1.19, 2.53]),
  ...fill('6ae1e1d4', '11:58:46', 1, [0.22, 1.19, 2.53]),
];

describe('fills in the same second', () => {
  it('keeps every tranche: 1 + 1 + 5 + 1 = 8 lots', () => {
    const t = comboTranches(ex);
    expect(t.map(x => x.lots)).toEqual([1, 1, 5, 1]);
    expect(t.reduce((a, x) => a + x.lots, 0)).toBe(8);
    expect(t.every(x => Math.abs(x.netPrice + 0.37) < 0.006)).toBe(true);
  });
  it('the last fill in that second keeps the old id, so what was recorded is still recognised', () => {
    const ids = comboTranches(ex).map(fillIdFor);
    expect(ids).toContain('TWS-P712120881@20261028115840');           // the 5-lot, recorded before the fix
    expect(ids).toContain('TWS-P712120881@20261028115840#00020057.6ae1e1c9');
    expect(new Set(ids).size).toBe(4);
    const five = comboTranches(ex).find(x => fillIdFor(x) === 'TWS-P712120881@20261028115840');
    expect(five.lots).toBe(5);
  });
});
