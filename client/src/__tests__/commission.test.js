/* Commission (Oct 2026). One counting rule for the engine, the tickets, the close
   forms and the tax report. The reference case is the 5 Oct 2026 paper trade
   QQQ Oct05 −2×754 +751 +756 put fly: bought 0.35, sold 0.17, TWS Trades summary
   Net Total −18.00, Comm 2.96, Nt Incl. Comm −20.96. */
import { describe, it, expect } from 'vitest';
import {
  unitsFromLegs, unitsFromTicket, roundTripCommission, rateFromFills, pnlFromFills,
  resolveClosePnl, commissionRate, DEFAULT_COMMISSION
} from '../utils/commission';
import { calc0DTE } from '../engine/calc0dte';

const leg = (side, qty, strike, price, commission, right = 'P') =>
  ({ execId: `${side}${strike}${price}`, side, qty, strike, right, expiry: '20261005', price, commission, multiplier: '100', symbol: 'QQQ' });
// opening combo (debit 0.35) and closing combo (credit 0.17), with the BAG rows TWS also reports
const qqqFly = [
  { execId: 'bag1', side: 'BOT', qty: 1, strike: 0, price: 0.35, commission: 0, symbol: 'QQQ' },
  leg('SLD', 2, 754, 1.275, 0.74), leg('BOT', 1, 751, 0.50, 0.37), leg('BOT', 1, 756, 2.40, 0.37),
  { execId: 'bag2', side: 'SLD', qty: 1, strike: 0, price: 0.17, commission: 0, symbol: 'QQQ' },
  leg('BOT', 2, 754, 1.065, 0.74), leg('SLD', 1, 751, 0.30, 0.37), leg('SLD', 1, 756, 2.00, 0.37),
];

describe('commission counting', () => {
  it('counts contracts, not legs: a 1x2x1 fly is four', () => {
    expect(unitsFromLegs([{ label: 'Long put (upper)' }, { label: 'Short put x2 (body)' }, { label: 'Long put (1.5x lower)' }])).toBe(4);
    expect(unitsFromLegs([{ label: 'Long put' }, { label: 'Short put' }, { label: 'Short call' }, { label: 'Long call' }])).toBe(4);
    // a dual-EM vertical suggestion is billed as the one spread you trade
    expect(unitsFromLegs([{ label: 'Short put (VIX)' }, { label: 'Long put (VIX)' }, { label: 'Short put (VIX1D)' }, { label: 'Long put (VIX1D)' }])).toBe(2);
  });

  it('reads a logged ticket: three strikes on a non-iron fly are four contracts', () => {
    expect(unitsFromTicket('751 / 754 / 756', 'QQQ - Asymmetric butterfly - 1 contract')).toBe(4);
    expect(unitsFromTicket('7300 / 7350 / 7350 / 7400', 'SPX - Iron butterfly - 1 contract')).toBe(4);
    expect(unitsFromTicket('7345 / 7290', 'SPX - Bull put spread - 2 contracts')).toBe(2);
    expect(unitsFromTicket('', 'x')).toBe(0);
  });

  it('prices the round trip per contract per side', () => {
    expect(roundTripCommission(4, 1, 0.37)).toBe(2.96);
    expect(roundTripCommission(4, 1, DEFAULT_COMMISSION)).toBe(5.2);
    expect(commissionRate({ commissionPerContract: 0.37 })).toBe(0.37);
    expect(commissionRate({})).toBe(DEFAULT_COMMISSION);
  });

  it('calibrates the rate from fills: $2.96 over 8 contracts is $0.37', () => {
    expect(rateFromFills(qqqFly)).toEqual({ rate: 0.37, commission: 2.96, contracts: 8 });
  });
});

describe('P&L from TWS fills', () => {
  it('matches the TWS Trades summary for a same-day round trip', () => {
    expect(pnlFromFills(qqqFly)).toEqual({ gross: -18, commission: 2.96, net: -20.96, basis: 'prices' });
  });

  it('takes IBKR realised P&L as already net when the entry was on another day', () => {
    const closeOnly = [
      { ...leg('BOT', 2, 754, 1.065, 0.74), realizedPnl: -60 },
      { ...leg('SLD', 1, 751, 0.30, 0.37), realizedPnl: -20.5 },
      { ...leg('SLD', 1, 756, 2.00, 0.37), realizedPnl: 59.5 },
    ];
    const r = pnlFromFills(closeOnly);
    expect(r.basis).toBe('ib-realised');
    expect(r.net).toBe(-21);
    expect(r.gross).toBe(-21 + 1.48);
  });
});

describe('recording a close', () => {
  it('nets gross by the commission given', () => {
    expect(resolveClosePnl({ grossPnl: -18, fees: 2.96 })).toEqual({ gross: -18, fees: 2.96, net: -20.96, feesSource: 'given' });
  });
  it('estimates commission it is not given, from the ticket', () => {
    expect(resolveClosePnl({ grossPnl: 120, units: 4, qty: 2, rate: 0.65 })).toEqual({ gross: 120, fees: 10.4, net: 109.6, feesSource: 'estimate' });
  });
  it('keeps a net figure as net', () => {
    expect(resolveClosePnl({ netPnl: -20.96, fees: 2.96 })).toEqual({ gross: -18, fees: 2.96, net: -20.96, feesSource: 'given' });
  });
});

describe('engine EV is after commission', () => {
  const base = { price: 7410, high: 7421, low: 7398, vwap5: 7409, vwap5_30: 7409, vwapRoll30: 7410, vwapRoll30Prior: 7409,
    vwapAccept: 0.5, atr: 61, em: 38, atr5: 6.5, atr2h: 22, gamStrike: 0, vix: 15.8, vix1d: 12.9, esOvernightHigh: 7430,
    esOvernightLow: 7388, esClose: 7415, priorDayClose: 7398, cashOpen: 7400, esEM: 40, overnightStale: false,
    bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, theta: 38, delta: -4, gamma: -0.2, hours: 3.5,
    underlying: 'SPX', overrideStrategy: null, overrideStrikes: null, vertVariant: 'engine', historyByStrategy: null,
    wingDeltas: { lowerAbsDelta: 0.08, upperAbsDelta: 0.07 }, emSource: 'straddle', straddleCall: 21.5, straddlePut: 20.8,
    straddleHaircut: 1.2533, netCreditDebit: 6.36, win: 636, risk: 3364, pop: 92, comboBid: null, comboAsk: null };

  it('charges the round trip at the account rate in the estimated model', () => {
    const a = calc0DTE({ ...base, commissionPerContract: 0 });
    const b = calc0DTE({ ...base, commissionPerContract: 0.37 });
    expect(b.evBasis.commissionUnits).toBe(4);
    expect(b.evBasis.commission).toBeCloseTo(2.96, 2);
    expect(a.ev - b.ev).toBeCloseTo(2.96, 2);
  });
});

describe('EV losses start at the 100% stop (Oct 2026)', () => {
  const base = { price: 7410, high: 7421, low: 7398, vwap5: 7409, vwap5_30: 7409, vwapRoll30: 7410, vwapRoll30Prior: 7409,
    vwapAccept: 0.5, atr: 61, em: 38, atr5: 6.5, atr2h: 22, gamStrike: 0, vix: 15.8, vix1d: 12.9, esOvernightHigh: 7430,
    esOvernightLow: 7388, esClose: 7415, priorDayClose: 7398, cashOpen: 7400, esEM: 40, overnightStale: false,
    bankroll: 25000, startBR: 25000, maxLoss: 600, maxOpen: 900, theta: 38, delta: -4, gamma: -0.2, hours: 3.5,
    underlying: 'SPX', overrideStrategy: null, overrideStrikes: null, vertVariant: 'engine', historyByStrategy: null,
    wingDeltas: { lowerAbsDelta: 0.08, upperAbsDelta: 0.07 }, emSource: 'straddle', straddleCall: 21.5, straddlePut: 20.8,
    straddleHaircut: 1.2533, netCreditDebit: 6.36, win: 636, risk: 3364, pop: 80, comboBid: null, comboAsk: null, commissionPerContract: 0 };

  it('charges each loser the premium, not P(max loss) × full risk', () => {
    const r = calc0DTE(base);
    expect(r.evBasis.lossModel).toBe('stop');
    expect(r.evBasis.stopLoss.perContract).toBe(636);
    expect(r.evBasis.lossCap * 3364).toBeCloseTo(636, 0);
    expect(r.evBasis.evHeld).toBeLessThan(r.ev);            // the no-stop comparison is worse
  });
  it('moves toward what closed losers actually gave back', () => {
    const r = calc0DTE({ ...base, captureByStrategy: { [calc0DTE(base).legStrat]: { lossCap: 0.40, lossSamples: 10, winCap: null, winSamples: 0, closed: 10 } } });
    expect(r.evBasis.lossCap).toBeCloseTo((10 * 0.40 + 10 * (636 / 3364)) / 20, 4);   // halfway at 10 losers
  });
  it('falls back to the P(max loss) model with no entry price', () => {
    expect(calc0DTE({ ...base, netCreditDebit: 0 }).evBasis.lossModel).not.toBe('stop');
  });
});
