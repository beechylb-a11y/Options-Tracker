/* The bridge keeps every execution it sees (23 Nov 2026): TWS answers reqExecutions for
   today only, so a META target that filled on Friday was invisible to the close ticket
   on Monday. */
import { describe, it, expect } from 'vitest';
import { execRecord, execYmd, mergeJournal, withCommission, pruneJournal, journalFills } from '../../../bridge/execJournal.js';
import { heldInTws } from '../components/OrderTicket';

const c = (strike, right) => ({ symbol: 'META', secType: 'OPT', exchange: 'SMART', strike, right, lastTradeDateOrContractMonth: '20261231', multiplier: '100' });
const x = (id, time, side, price) => ({ execId: id, time, acctNumber: 'DUQ739754', side, shares: 1, price, avgPrice: price, orderId: 77, permId: 9001, orderRef: 'papertrade-mqr9v3pt' });
const fri = [execRecord(c(695, 'P'), x('0001.01', '20261120  11:02:07 US/Eastern', 'BOT', 4.1)),
             execRecord(c(670, 'P'), x('0001.02', '20261120  11:02:07 US/Eastern', 'SLD', 1.05))];

describe('execution journal', () => {
  it('keeps the fields /api/executions always returned', () => {
    expect(fri[0]).toMatchObject({ execId: '0001.01', symbol: 'META', side: 'BOT', qty: 1, price: 4.1, strike: 695, right: 'P', expiry: '20261231', permId: 9001, orderRef: 'papertrade-mqr9v3pt' });
    expect(execYmd(fri[0])).toBe('20261120');
    expect(execYmd({ time: '20261120-16:02:07' })).toBe('20261120');
  });

  it('merges without duplicates, keeps first-seen time, takes commission reports', () => {
    let { journal, added } = mergeJournal({}, fri, { '0001.01': { commission: 0.65 } }, '2026-11-20T16:02:09Z');
    expect(added).toBe(2);
    ({ journal, added } = mergeJournal(journal, [fri[0]], {}, '2026-11-20T16:30:00Z'));
    expect(added).toBe(0);
    expect(journal['0001.01']).toMatchObject({ commission: 0.65, seenAt: '2026-11-20T16:02:09Z' });
    journal = withCommission(journal, { execId: '0001.02', commission: 0.65, realizedPNL: 1.7976931348623157e+308 });
    expect(journal['0001.02'].commission).toBe(0.65);
    expect(journal['0001.02'].realizedPnl).toBe(0);   // IB's "not set" is not a P&L
  });

  it('answers Monday for Friday, without repeating what TWS still returned', () => {
    const { journal } = mergeJournal({}, fri);
    const out = journalFills(journal, { sinceYmd: '20261117', exclude: new Set(['0001.02']) });
    expect(out.map(e => e.execId)).toEqual(['0001.01']);
    expect(out[0].source).toBe('journal');
    expect(journalFills(journal, { sinceYmd: '20261121' })).toEqual([]);
  });

  it('drops executions older than 120 days by trade date', () => {
    const old = execRecord(c(600, 'P'), x('0000.01', '20260701  10:00:00 US/Eastern', 'BOT', 1));
    const { journal } = mergeJournal({}, [...fri, old]);
    const kept = pruneJournal(journal, Date.UTC(2026, 10, 23));
    expect(Object.keys(kept).sort()).toEqual(['0001.01', '0001.02']);
  });
});

describe('closed in TWS', () => {
  const pos = { underlying: 'META', legs: '670/695' };
  it('a ticket whose legs TWS no longer holds reads as closed', () => {
    expect(heldInTws([], pos)).toBe(false);
    expect(heldInTws([{ underlying: 'META', strike: 695, right: 'P', qty: 0 }], pos)).toBe(false);
    expect(heldInTws([{ underlying: 'META', strike: 700, right: 'P', qty: -1 }], pos)).toBe(false);
    expect(heldInTws([{ underlying: 'META', strike: 695, right: 'P', qty: -1 }], pos)).toBe(true);
  });
});
