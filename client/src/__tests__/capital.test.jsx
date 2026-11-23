/* Capital and buying power (23 Nov 2026): TWS account summary folded per account,
   buying power in use against a band that moves with VIX, cushion, the Settings
   bankroll against net liq, and each position's buying power and return on it. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { foldSummary, SUMMARY_TAGS } from '../../../bridge/accountSummary.js';
import {
  bpBand, bpUsedPct, bpStatus, cushionPct, matchAccount, bankrollOf, bankrollGap, annualise, positionCapital,
} from '../utils/capital';
import CapitalPanel from '../components/CapitalPanel';

afterEach(cleanup);

const rows = (acct, o) => Object.entries(o).map(([tag, value]) => ({ account: acct, tag, value: String(value), currency: 'USD' }));
const PAPER = { id: 'papertrade-1', name: 'PaperTrade', startingBankroll: 10000, realisedPnl: 2801 };
const LIVE = { id: 'live-1', name: 'Live', startingBankroll: 40000, realisedPnl: 0, twsAccount: 'U7654321' };
const ACCTS = [PAPER, LIVE];

describe('account summary from TWS', () => {
  it('folds the tag rows into one record per account and works out leverage', () => {
    const s = foldSummary([
      ...rows('DUQ739754', { NetLiquidation: 1003420, InitMarginReq: 2007, AvailableFunds: 1001413, ExcessLiquidity: 1001900, Cushion: 0.998, GrossPositionValue: 20068, AccountType: 'INDIVIDUAL' }),
      ...rows('All', { NetLiquidation: 1 }),
      { account: 'DUQ739754', tag: 'BuyingPower', value: 'n/a', currency: 'USD' },
    ]);
    expect(Object.keys(s)).toEqual(['DUQ739754']);
    const r = s.DUQ739754;
    expect(r.netLiq).toBe(1003420);
    expect(r.paper).toBe(true);
    expect(r.buyingPower).toBeUndefined();
    expect(r.leverage).toBeCloseTo(0.02, 2);
    expect(r.accountType).toBe('INDIVIDUAL');
    expect(SUMMARY_TAGS).toContain('ExcessLiquidity');
  });
});

describe('buying power in use', () => {
  it('the target band moves with VIX and stops at half', () => {
    expect(bpBand(12)).toMatchObject({ target: 25, lo: 20, hi: 30 });
    expect(bpBand(17.6)).toMatchObject({ target: 30, lo: 25, hi: 35 });
    expect(bpBand(25)).toMatchObject({ target: 35 });
    expect(bpBand(55)).toMatchObject({ target: 50, hi: 50 });
    expect(bpBand(null)).toMatchObject({ target: 30, vix: null });
  });
  it('is initial margin over net liq, and is graded against the band', () => {
    const b = bpBand(17.6);
    expect(bpUsedPct({ netLiq: 41230, initMargin: 12369 })).toBeCloseTo(30, 0);
    expect(bpUsedPct({ netLiq: 1000, availableFunds: 600 })).toBeCloseTo(40, 5);
    expect(bpUsedPct({ netLiq: 0 })).toBeNull();
    expect(bpStatus(4, b)).toBe('low');
    expect(bpStatus(30, b)).toBe('ok');
    expect(bpStatus(38, b)).toBe('over');
    expect(bpStatus(46, b)).toBe('high');
  });
  it('cushion is excess liquidity over net liq', () => {
    expect(cushionPct({ cushion: 0.81 })).toBeCloseTo(81, 5);
    expect(cushionPct({ netLiq: 1000, excessLiquidity: 90 })).toBeCloseTo(9, 5);
  });
});

describe('accounts and bankroll', () => {
  it('links by the TWS account set in Settings, and a paper login to the one paper account', () => {
    expect(matchAccount('u7654321', ACCTS)).toBe(LIVE);
    expect(matchAccount('DUQ739754', ACCTS)).toBe(PAPER);
    expect(matchAccount('U0000001', ACCTS)).toBeNull();
  });
  it('flags net liq 5% or more away from the sizing bankroll', () => {
    expect(bankrollOf(PAPER)).toBe(12801);
    expect(bankrollGap(40000, 41230).flag).toBe(false);
    expect(bankrollGap(40000, 42400)).toMatchObject({ flag: true });
    expect(bankrollGap(40000, 42400).pct).toBeCloseTo(6, 5);
    expect(bankrollGap(null, 1)).toBeNull();
  });
});

describe('return on buying power', () => {
  it('annualises simply, so short and long trades compare', () => {
    expect(annualise(0.32, 44)).toBeCloseTo(2.6545, 3);
    expect(annualise(0.02, 1)).toBeCloseTo(7.3, 5);
    expect(annualise(0.1, 0)).toBeNull();
  });
  it('a credit spread holds its max loss as buying power', () => {
    // META 670/695: 25 wide, 6.10 credit → max loss 1,890, max profit 610 a contract
    const p = { key: 'm', live: 1, qty: 1, expiry: '20261231', entry: { ymd: '20261117' },
      pos: { isCredit: true, maxRiskPerContract: 1890, maxProfitPerContract: 610 }, row: { account: 'papertrade-1' } };
    const c = positionCapital(p, { pnl: 302 }, 41230);
    expect(c.bpr).toBe(1890);
    expect(c.pctNetLiq).toBeCloseTo(4.58, 2);
    expect(c.maxRet).toBeCloseTo(0.3228, 3);
    expect(c.nowRet).toBeCloseTo(0.1598, 3);
    expect(c.days).toBe(44);
    expect(positionCapital({ ...p, live: 0 }, null, 1)).toBeNull();
  });
});

describe('Capital panel', () => {
  const summary = {
    accounts: foldSummary([
      ...rows('U7654321', { NetLiquidation: 42400, InitMarginReq: 12720, AvailableFunds: 29680, ExcessLiquidity: 33600, Cushion: 0.79, GrossPositionValue: 77900 }),
      ...rows('DUQ739754', { NetLiquidation: 1003420, InitMarginReq: 1890, AvailableFunds: 1001530, ExcessLiquidity: 1001900, Cushion: 0.998 }),
      ...rows('U1111111', { NetLiquidation: 5000, InitMarginReq: 0 }),
    ]),
  };
  const book = [{ key: 'm', underlying: 'META', strategy: 'Put credit spread', live: 1, qty: 1, expiry: '20261231', entry: { ymd: '20261117' },
    pos: { isCredit: true, maxRiskPerContract: 1890, maxProfitPerContract: 610 }, row: { account: 'papertrade-1' } }];

  it('shows each account, real first, paper marked as not counted, and an unlinked one', () => {
    render(<CapitalPanel summary={summary} accounts={ACCTS} book={book} risks={{ m: { pnl: 302 } }} vix={17.6} account="all" />);
    const cards = screen.getAllByTestId(/^capital-(U|DU)/);
    expect(cards.map(c => c.dataset.testid)).toEqual(['capital-U7654321', 'capital-U1111111', 'capital-DUQ739754']);
    expect(screen.getByTestId('bp-used-U7654321').textContent).toBe('30%');
    expect(screen.getByTestId('capital-DUQ739754').textContent).toMatch(/paper · shown, not in totals/);
    expect(screen.getByTestId('bank-gap-U7654321').textContent).toMatch(/6% above it/);
    expect(screen.getByTestId('bank-gap-U1111111').textContent).toMatch(/set "TWS account" to U1111111/);
    expect(screen.getByTestId('capital-positions').textContent).toMatch(/\$1,890/);
    expect(screen.getByTestId('bp-ladder').textContent).toMatch(/15–20: 30%/);
  });
  it('one account picked shows only its card', () => {
    render(<CapitalPanel summary={summary} accounts={ACCTS} book={book} risks={{}} vix={17.6} account="live-1" />);
    expect(screen.getAllByTestId(/^capital-(U|DU)/).map(c => c.dataset.testid)).toEqual(['capital-U7654321']);
    expect(screen.queryByTestId('capital-positions')).toBeNull();
  });
  it('says what is wrong when the bridge has no summary route', () => {
    render(<CapitalPanel summary={{ accounts: null, error: 'bridge has no account summary yet — pull and restart the bridge' }} accounts={ACCTS} />);
    expect(screen.getByTestId('capital-error').textContent).toMatch(/pull and restart/);
  });
});
