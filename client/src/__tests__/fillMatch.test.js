import { describe, it, expect } from 'vitest';
import { comboTranches, matchTranches, execWhen, fillIdFor, fillPayload, positionForTicket } from '../utils/fillMatch';

// A SPY 759/763/768 fly, one lot, bought as a debit: buy 1 × 759, sell 2 × 763,
// buy 1 × 768. Leg prices chosen so the net is a clean 1.11 debit.
//   paid   759 @ 5.00  → −5.00
//   got    763 @ 2.40 ×2 → +4.80
//   paid   768 @ 0.91  → −0.91
//   net    −1.11
const fly = (time, orderId, lots = 1) => ([
  { execId: `e1-${orderId}`, orderId, time, symbol: 'SPY', secType: 'OPT', side: 'BOT', qty: 1 * lots, price: 5.00, strike: 759, right: 'C', expiry: '20261017', commission: 0.65 * lots },
  { execId: `e2-${orderId}`, orderId, time, symbol: 'SPY', secType: 'OPT', side: 'SLD', qty: 2 * lots, price: 2.40, strike: 763, right: 'C', expiry: '20261017', commission: 1.30 * lots },
  { execId: `e3-${orderId}`, orderId, time, symbol: 'SPY', secType: 'OPT', side: 'BOT', qty: 1 * lots, price: 0.91, strike: 768, right: 'C', expiry: '20261017', commission: 0.65 * lots },
]);

describe('execWhen', () => {
  it('splits the TWS timestamp without inventing a timezone', () => {
    expect(execWhen('20261008 09:31:02')).toEqual({ date: '2026-10-08', time: '09:31:02', key: '20261008093102' });
    expect(execWhen('20261008-09:31:02').date).toBe('2026-10-08');
  });
  it('survives a shape it has never seen', () => {
    expect(execWhen('').date).toBe('');
    expect(execWhen(null).date).toBe('');
  });
});

describe('comboTranches', () => {
  it('rebuilds the combo net from the legs, signed like the ticket', () => {
    const [t] = comboTranches(fly('20261008 09:31:02', 77));
    expect(t.lots).toBe(1);
    expect(t.netPrice).toBeCloseTo(-1.11, 4);     // a debit is negative
    expect(t.strikes).toEqual([759, 763, 768]);
    expect(t.fees).toBeCloseTo(2.60, 2);
    expect(t.underlying).toBe('SPY');
  });

  it('divides by lots, not by leg count — two lots is the same price per contract', () => {
    const [t] = comboTranches(fly('20261008 09:31:02', 77, 2));
    expect(t.lots).toBe(2);
    expect(t.netPrice).toBeCloseTo(-1.11, 4);
  });

  it('keeps two partial fills of one order as two tranches', () => {
    const ts = comboTranches([...fly('20261008 09:31:02', 77), ...fly('20261008 14:02:11', 77)]);
    expect(ts).toHaveLength(2);
    expect(ts.map(t => t.time)).toEqual(['09:31:02', '14:02:11']);
  });

  it('signs a credit structure the other way', () => {
    const condor = [
      { orderId: 9, time: '20261008 15:40:00', symbol: 'QQQ', secType: 'OPT', side: 'SLD', qty: 1, price: 3.00, strike: 705, right: 'P' },
      { orderId: 9, time: '20261008 15:40:00', symbol: 'QQQ', secType: 'OPT', side: 'BOT', qty: 1, price: 1.40, strike: 695, right: 'P' },
    ];
    const [t] = comboTranches(condor);
    expect(t.netPrice).toBeCloseTo(1.60, 4);      // a credit is positive
  });

  it('ignores non-option executions and prices it cannot read', () => {
    expect(comboTranches([{ orderId: 1, time: '20261008 09:30:00', symbol: 'SPY', secType: 'STK', side: 'BOT', qty: 100, price: 660 }])).toEqual([]);
    expect(comboTranches([{ orderId: 1, time: '20261008 09:30:00', symbol: 'SPY', secType: 'OPT', side: 'BOT', qty: 1, price: null, strike: 759 }])).toEqual([]);
  });

  it('reads the lots of a broken-wing ratio without flattening it', () => {
    const legs = fly('20261008 09:31:02', 77);
    legs[1].qty = 3;                               // +1 / −3 / +1 — a BWB, not an error
    const [t] = comboTranches(legs);
    expect(t.lots).toBe(1);
  });
});

const ticket = (over = {}) => ({
  ticketRef: 12, underlying: 'SPY', strategy: 'Butterfly',
  legs: '759 / 763 / 768', qty: 2, qtyFilled: 0, limitPrice: -1.05, account: 'DU1', ...over,
});

describe('matchTranches', () => {
  it('matches a full strike set and measures ask against got', () => {
    const trs = comboTranches(fly('20261008 09:31:02', 77));
    const { rows, unmatched } = matchTranches([ticket()], trs);
    expect(unmatched).toHaveLength(0);
    expect(rows[0].outstanding).toBe(2);
    const c = rows[0].candidates[0];
    expect(c.match).toBe('full');
    // Asked −1.05, got −1.11: 0.06 worse, and worse is positive on both sides.
    expect(c.vsLimit).toBeCloseTo(0.06, 4);
  });

  it('offers a partial strike overlap but does not call it the combo', () => {
    const trs = comboTranches(fly('20261008 09:31:02', 77).slice(0, 2));   // 759/763 only
    const { rows } = matchTranches([ticket()], trs);
    expect(rows[0].candidates[0].match).toBe('partial');
  });

  it('marks a fill already in the table as recorded', () => {
    const trs = comboTranches(fly('20261008 09:31:02', 77));
    const { rows } = matchTranches([ticket()], trs, [fillIdFor(trs[0])]);
    expect(rows[0].candidates[0].recorded).toBe(true);
  });

  it('reports what TWS filled that no ticket wanted', () => {
    const trs = comboTranches(fly('20261008 09:31:02', 77));
    const { rows, unmatched } = matchTranches([ticket({ underlying: 'QQQ', legs: '695 / 705' })], trs);
    expect(rows[0].candidates).toHaveLength(0);
    expect(unmatched).toHaveLength(1);
  });

  it('flags a fill bigger than the ticket is still waiting on', () => {
    const trs = comboTranches(fly('20261008 09:31:02', 77, 3));     // 3 lots back
    const { rows } = matchTranches([ticket({ qty: 2 })], trs);      // only 2 ordered
    expect(rows[0].candidates[0].overOutstanding).toBe(true);
    const ok = matchTranches([ticket({ qty: 3 })], trs);
    expect(ok.rows[0].candidates[0].overOutstanding).toBe(false);
  });

  it('treats SPXW and SPX as the same underlying', () => {
    const trs = comboTranches([
      { orderId: 3, time: '20261008 10:00:00', symbol: 'SPXW', secType: 'OPT', side: 'BOT', qty: 1, price: 10, strike: 6700, right: 'P' },
      { orderId: 3, time: '20261008 10:00:00', symbol: 'SPXW', secType: 'OPT', side: 'SLD', qty: 1, price: 8, strike: 6650, right: 'P' },
    ]);
    const { rows } = matchTranches([ticket({ underlying: 'SPX', legs: '6650 / 6700' })], trs);
    expect(rows[0].candidates[0].match).toBe('full');
  });
});

describe('fillPayload', () => {
  it('carries the tranche through with the ticket it was confirmed against', () => {
    const [tr] = comboTranches(fly('20261008 09:31:02', 77));
    const p = fillPayload(ticket(), tr);
    expect(p.ticketRef).toBe(12);
    expect(p.qtyFilled).toBe(1);
    expect(p.fillPrice).toBeCloseTo(-1.11, 4);
    expect(p.limitPrice).toBe(-1.05);
    expect(p.qtyOrdered).toBe(2);
    expect(p.fillDate).toBe('2026-10-08');
    // The id comes from the execution, so a second reconcile of the same TWS day
    // cannot write the same entry twice.
    expect(p.fillId).toBe('TWS-77@20261008093102');
  });

  it('lets a hand correction win over the derived numbers', () => {
    const [tr] = comboTranches(fly('20261008 09:31:02', 77));
    const p = fillPayload(ticket(), tr, { qty: 2, price: -1.09 });
    expect(p.qtyFilled).toBe(2);
    expect(p.fillPrice).toBeCloseTo(-1.09, 4);
  });
});

// An order typed into TWS itself reaches the bridge's API client with orderId 0, and
// every leg has its own execId — the old key split the condor into four one-leg
// tranches, none a full match. (Oct 2026.)
describe('orders placed in TWS (orderId 0)', () => {
  const leg = (strike, right, side, price, extra = {}) => ({ execId: 'x' + strike, orderId: 0, permId: 913, time: '20261008 10:05:31 US/Eastern',
    symbol: 'QQQ', secType: 'OPT', side, qty: 5, price, strike, right, expiry: '20261120', ...extra });
  const condor = [leg(699, 'P', 'BOT', 5.30), leg(709, 'P', 'SLD', 6.60), leg(805, 'C', 'SLD', 3.30), leg(815, 'C', 'BOT', 2.10)];
  const tk = { ticketRef: 54, underlying: 'QQQ', legs: '699 / 709 / 805 / 815', qty: 5, qtyFilled: 0, limitPrice: 2.5 };

  it('groups the legs on the permanent order id', () => {
    const ts = comboTranches(condor);
    expect(ts).toHaveLength(1);
    expect(ts[0].lots).toBe(5);
    expect(ts[0].netPrice).toBeCloseTo(2.5, 4);
    expect(matchTranches([tk], ts).rows[0].candidates[0].match).toBe('full');
  });
  it('without a permId, the contract at that moment stands in for the order', () => {
    const ts = comboTranches(condor.map(e => ({ ...e, permId: undefined })));
    expect(ts).toHaveLength(1);
    expect(ts[0].strikes).toEqual([699, 709, 805, 815]);
  });
  it('legs a second apart are still one fill; a repeated leg starts the next tranche', () => {
    const split = condor.map((e, i) => (i >= 2 ? { ...e, time: '20261008 10:05:32 US/Eastern' } : e));
    expect(comboTranches(split)).toHaveLength(1);
    const twice = [...condor, ...condor.map(e => ({ ...e, execId: e.execId + 'b', time: '20261008 10:05:32 US/Eastern' }))];
    expect(comboTranches(twice)).toHaveLength(2);
  });
});

describe('positionForTicket', () => {
  const structs = [
    { underlying: 'QQQ', expiries: ['20261120'], strikes: [699, 709, 805, 815], contracts: 5, netCreditDebit: 2.44 },
    { underlying: 'SPY', expiries: ['20261017'], strikes: [759, 763, 768], contracts: 1, netCreditDebit: -1.11 },
  ];
  it('finds the position with the same underlying and strikes', () => {
    expect(positionForTicket({ underlying: 'QQQ', legs: '699 / 709 / 805 / 815' }, structs)).toMatchObject({ qty: 5, price: 2.44, side: 'cr' });
    expect(positionForTicket({ underlying: 'SPY', legs: '759 / 763 / 768' }, structs)).toMatchObject({ qty: 1, price: 1.11, side: 'db' });
  });
  it('a different strike set is not this ticket', () => {
    expect(positionForTicket({ underlying: 'QQQ', legs: '700 / 709 / 805 / 815' }, structs)).toBeNull();
    expect(positionForTicket({ underlying: 'QQQ', legs: '' }, structs)).toBeNull();
  });
});
