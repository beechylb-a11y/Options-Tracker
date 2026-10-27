/* A roll ticket logged from TWS fills has no Price or IV. With the bridge down the
   Portfolio Risk page crashed on its missing greeks (27 Oct); entry market data now
   comes from the ticket it was rolled from. */
import { describe, it, expect } from 'vitest';
import { buildBook, positionRisk } from '../engine/portfolio';

const T57 = { _rowIndex: 57, Timestamp: '2026-10-15T16:10:39Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 755 / 765', 'Net Debit/Credit': '3.77', Price: '724.49', IV: '21.4', Notes: '' };
const T62 = { _rowIndex: 62, Timestamp: '2026-10-23T16:14:00Z', Engine: '45DTE', Underlying: 'QQQ', Strategy: 'QQQ - Iron Condor - Normal - 5 contracts', Contracts: '5', 'Wing Strikes': '699 / 709 / 735 / 745', 'Net Debit/Credit': '3.99', Price: '', IV: '',
  Notes: 'Legs: +1 699P 20261120 / -1 709P 20261120 / -1 735C 20261120 / +1 745C 20261120\nRolled from TICKET-57 (699 / 709 / 755 / 765, entry 3.77 cr). Net roll 1.54 cr.' };
const OPEN = [{ ticketRef: 62, timestamp: T62.Timestamp, engine: '45DTE', underlying: 'QQQ', strategy: T62.Strategy, legs: T62['Wing Strikes'], qty: 5, qtyOpen: 5, qtyFilled: 5, entryPrice: 3.99, maxRisk: 3005, maxProfit: 1995, status: 'Open', entryDate: '2026-10-23' }];

describe('portfolio risk, roll ticket without entry price', () => {
  it('takes spot and IV from the ticket it was rolled from, and values it', () => {
    const [p] = buildBook({ open: OPEN, decisions: [T57, T62], closes: [], raw: null, todayYmd: '20261027' });
    expect(p.entry.spot).toBe(724.49);
    expect(p.entry.iv).toBe(21.4);
    const r = positionRisk(p, null, { now: new Date('2026-10-27T15:00:00Z') });
    expect(r.greeks).toBeTruthy();
    expect(Number.isFinite(r.pnl)).toBe(true);
  });
  it('with no parent either, returns no greeks rather than throwing', () => {
    const [p] = buildBook({ open: OPEN, decisions: [T62], closes: [], raw: null, todayYmd: '20261027' });
    expect(p.entry.spot).toBe(null);
    const r = positionRisk(p, null, { now: new Date('2026-10-27T15:00:00Z') });
    expect(r.greeks).toBe(null);
  });
});
