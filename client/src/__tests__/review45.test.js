/* Open 45DTE check-up (Oct 2026): pace against the theta-only plan, and the
   playbook action — take profit, time stop, roll untested side, roll out, close. */
import { describe, it, expect } from 'vitest';
import { reviewOpen45, familyOf, daysBetweenYmd } from '../engine/review45';
import { bsPrice, RATE, divYieldOf } from '../engine/payoffCurve';

const EXP = '20261120';
const ic = [
  { strike: 7000, right: 'P', qty: 1, expiry: EXP },
  { strike: 7050, right: 'P', qty: -1, expiry: EXP },
  { strike: 7750, right: 'C', qty: -1, expiry: EXP },
  { strike: 7800, right: 'C', qty: 1, expiry: EXP },
];
// Model mark (signed value of the holding per share) at spot / IV / date.
const markOf = (legs, S, iv, todayYmd) => legs.reduce((v, l) => v + l.qty * bsPrice(S, l.strike,
  Math.max(0, daysBetweenYmd(todayYmd, l.expiry)) / 365, iv / 100, l.right, RATE, divYieldOf('SPX')), 0);
const entryYmd = '20261006';
const entryNcd = -markOf(ic, 7410, 16, entryYmd);           // the credit the model says it opened for
const entry = { ncd: +entryNcd.toFixed(2), dateYmd: entryYmd, spot: 7410, iv: 16, maxProfit: entryNcd * 100, maxRisk: (50 - entryNcd) * 100 };
const run = (todayYmd, spot, iv, extra = {}) => reviewOpen45({
  strategy: 'Iron Condor - Normal', legs: extra.legs || ic, qtyOpen: 2, entry, underlying: 'SPX',
  now: { todayYmd, spot, iv, mark: markOf(extra.legs || ic, spot, iv, todayYmd), delta: extra.delta ?? 0, ...extra.now },
  trend: extra.trend || null,
});

describe('family', () => {
  it('maps strategies to their playbook', () => {
    expect(familyOf('Iron Condor - Normal')).toBe('condor');
    expect(familyOf('Bull put spread')).toBe('creditVertical');
    expect(familyOf('Calendar spread')).toBe('time');
    expect(familyOf('Asymmetric butterfly')).toBe('longFly');
    expect(familyOf('Broken wing butterfly')).toBe('bwb');
    expect(familyOf('Bull call spread')).toBe('debitVertical');
  });
});

describe('condor check-up', () => {
  it('holds a quiet condor on plan, and splits P&L into time / price / vol', () => {
    const r = run('20261016', 7415, 16);
    expect(r.action).toBe('hold');
    expect(['on plan', 'ahead']).toContain(r.metrics.pace);
    const a = r.metrics.attribution;
    expect(a.time).toBeGreaterThan(0);
    expect(Math.abs(a.time + a.price + a.vol - a.model)).toBeLessThanOrEqual(2);
    expect(Math.abs(a.other)).toBeLessThanOrEqual(2);         // model mark == actual mark here
    expect(r.metrics.daysToClose).toBe(45 - 10 - 21);
  });

  it('takes profit at 50% of max', () => {
    const r = run('20261030', 7420, 13);                       // 24 days on, vol down
    expect(r.metrics.progress).toBeGreaterThanOrEqual(1);
    expect(r.action).toBe('take-profit');
  });

  it('closes or rolls at the 21-DTE time stop', () => {
    const r = run('20261031', 7480, 18);                       // 20 DTE, not tested, small win/loss
    expect(r.metrics.dte).toBe(20);
    expect(['close-or-roll', 'close', 'take-profit']).toContain(r.action);
  });

  it('rolls the untested side when one short is tested', () => {
    const r = run('20261016', 7062, 18, {
      legs: ic.map(l => ({ ...l, delta: l.strike === 7050 ? -0.44 : l.strike === 7750 ? 0.04 : l.strike === 7000 ? -0.30 : 0.02 })),
    });
    expect(r.action).toBe('roll-untested');
    expect(r.headline).toMatch(/untested call/);
    expect(r.steps.join(' ')).toMatch(/down toward price/);
  });

  it('flags a trend against the position delta', () => {
    const r = run('20261016', 7415, 16, { delta: -25, trend: { outlook: 'bullish', hvRegime: 'steady' } });
    expect(r.warnings.join(' ')).toMatch(/trend is bullish/);
  });
});

describe('other structures', () => {
  it('rolls a tested credit spread out in time', () => {
    const legs = [{ strike: 7250, right: 'P', qty: -1, expiry: EXP, delta: -0.48 }, { strike: 7200, right: 'P', qty: 1, expiry: EXP, delta: -0.33 }];
    const r = reviewOpen45({ strategy: 'Bull put spread', legs, qtyOpen: 1, underlying: 'SPX',
      entry: { ncd: 1.6, dateYmd: entryYmd, spot: 7410, iv: 16, maxProfit: 160 },
      now: { todayYmd: '20261016', spot: 7255, iv: 19, mark: markOf(legs, 7255, 19, '20261016') } });
    expect(r.action).toBe('roll-out');
    expect(r.steps.join(' ')).toMatch(/net credit/);
  });

  it('closes a calendar that price has left', () => {
    const legs = [{ strike: 7400, right: 'C', qty: -1, expiry: '20261106' }, { strike: 7400, right: 'C', qty: 1, expiry: '20261204' }];
    const ncd = -markOf(legs, 7400, 16, entryYmd);
    const r = reviewOpen45({ strategy: 'Calendar spread', legs, qtyOpen: 1, underlying: 'SPX',
      entry: { ncd: +ncd.toFixed(2), dateYmd: entryYmd, spot: 7400, iv: 16 },
      now: { todayYmd: '20261020', spot: 7700, iv: 16, mark: markOf(legs, 7700, 16, '20261020') } });
    expect(r.metrics.closeDte).toBe(7);
    expect(r.action).toBe('close');
    expect(r.headline).toMatch(/left the strike/);
  });

  it('leaves a long fly alone and says why', () => {
    const legs = [{ strike: 7350, right: 'P', qty: 1, expiry: EXP }, { strike: 7400, right: 'P', qty: -2, expiry: EXP }, { strike: 7450, right: 'P', qty: 1, expiry: EXP }];
    const ncd = -markOf(legs, 7410, 16, entryYmd);
    const r = reviewOpen45({ strategy: 'Standard butterfly', legs, qtyOpen: 1, underlying: 'SPX',
      entry: { ncd: +ncd.toFixed(2), dateYmd: entryYmd, spot: 7410, iv: 16, maxProfit: (50 + ncd) * 100 },
      now: { todayYmd: '20261016', spot: 7520, iv: 16, mark: markOf(legs, 7520, 16, '20261016') } });
    expect(r.action).toBe('hold');
    expect(r.reasons.join(' ')).toMatch(/not managed/);
  });

  it('says so when it has no legs', () => {
    expect(reviewOpen45({ strategy: 'Iron Condor - Normal', legs: [], now: { todayYmd: '20261016' } }).action).toBe('unknown');
  });
});
