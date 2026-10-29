/* 0DTE check-up (Oct 2026): live verdict with the exit clock, and the advice that
   depends on how the underlying settles. */
import { describe, it, expect } from 'vitest';
import { review0, cashSettled } from '../engine/review0';
import { closingFills, comboTranches } from '../utils/fillMatch';

// IWM 278/280/283 call fly, 8 lots, 0.37 debit
const fly = [{ strike: 278, right: 'C', qty: 1 }, { strike: 280, right: 'C', qty: -2 }, { strike: 283, right: 'C', qty: 1 }];
const at = (h, m) => new Date(Date.UTC(2026, 9, 28, h + 4, m));   // EDT = UTC−4
const base = { legs: fly, qtyOpen: 8, entry: { ncd: -0.37, maxProfit: 163 }, underlying: 'IWM', strategy: 'Asymmetric butterfly' };

describe('0DTE verdict', () => {
  it('knows how things settle', () => {
    expect(cashSettled('SPX')).toBe(true); expect(cashSettled('XSP')).toBe(true);
    expect(cashSettled('IWM')).toBe(false); expect(cashSettled('SPY')).toBe(false);
  });
  it('holds mid-session and quotes live P&L, target and stop', () => {
    const r = review0({ ...base, now: { mark: 0.45, spot: 279.4, at: at(12, 30) } });
    expect(r.action).toBe('hold');
    expect(r.metrics.pnl$).toBe(64);           // (0.45 − 0.37) × 800
    expect(r.metrics.stop$).toBe(-296);
    expect(r.metrics.settle).toBe('shares');
    expect(r.metrics.minutesToExit).toBe(150);
  });
  it('takes profit at the target', () => {
    const r = review0({ ...base, now: { mark: 0.60, spot: 280.1, at: at(13, 0) } });
    expect(r.action).toBe('take-profit');
  });
  it('stock-settled: past 15:00 says close by 15:45, then close now', () => {
    const a = review0({ ...base, now: { mark: 0.48, spot: 280.6, at: at(15, 10) } });
    expect(a.action).toBe('watch'); expect(a.headline).toMatch(/15:45/);
    expect(a.steps.join(' ')).toMatch(/settles into shares/);
    const b = review0({ ...base, now: { mark: 0.48, spot: 280.6, at: at(15, 50) } });
    expect(b.action).toBe('close'); expect(b.steps.join(' ')).toMatch(/assigned/);
  });
  it('cash-settled: well clear of the strikes after 15:00, let it settle', () => {
    const condor = [{ strike: 6800, right: 'P', qty: 1 }, { strike: 6820, right: 'P', qty: -1 }, { strike: 6900, right: 'C', qty: -1 }, { strike: 6920, right: 'C', qty: 1 }];
    const r = review0({ legs: condor, qtyOpen: 1, entry: { ncd: 2.1, maxProfit: 210 }, underlying: 'SPX', strategy: 'Iron Condor - Normal',
      now: { mark: -1.8, spot: 6860, sd: 8, at: at(15, 20) } });
    expect(r.action).toBe('hold'); expect(r.headline).toMatch(/Let it settle/);
  });
  it('the gamma warning names the nearest short', () => {
    const r = review0({ ...base, now: { mark: 0.50, spot: 279.8, at: at(14, 40) } });
    expect(r.action).toBe('watch'); expect(r.steps[0]).toMatch(/Gamma.*280C/);
  });
});

describe('closing fills from TWS', () => {
  const leg = (stem, n, strike, side, qty, price) => ({ execId: `0002.${stem}.0${n}.01`, time: '20261028 14:08:40 US/Eastern', symbol: 'IWM', secType: 'OPT', side, qty, price, permId: 6122, strike, right: 'C', expiry: '20261028', commission: 1.1 });
  const sale = (stem, lots) => [leg(stem, 2, 283, 'SLD', lots, 0.09), leg(stem, 3, 280, 'BOT', 2 * lots, 0.81), leg(stem, 4, 278, 'SLD', lots, 2.05)];
  const ex = [...sale('a1', 2), ...sale('a2', 1), ...sale('a3', 5)];
  it('finds the close on the ticket strikes and averages it', () => {
    const c = closingFills(comboTranches(ex), { underlying: 'IWM', strikes: [278, 280, 283], isCredit: false, entryDate: '2026-10-28' });
    expect(c.qty).toBe(8);
    expect(c.avgPrice).toBeCloseTo(0.52, 4);
    expect(c.exitFees).toBeCloseTo(9 * 1.1, 2);
  });
  it('skips fills already recorded', () => {
    const tr = comboTranches(ex);
    const c = closingFills(tr, { underlying: 'IWM', strikes: [278, 280, 283], isCredit: false, recordedNotes: [`T1 — TWS 2026-10-28 14:08:40 ET, IBKR commission [${tr[0].key}]`] });
    expect(c.qty).toBe(6);
  });
});
