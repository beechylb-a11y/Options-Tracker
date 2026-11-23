/* Sizing caps beyond Kelly (23 Nov 2026): contracts = the smallest of Kelly (half for
   a B setup or backwardation), the buying power left under the VIX band, and a CVaR
   cap (one trade's bad day ≤ 2% of the bankroll). */
import { describe, it, expect } from 'vitest';
import { cvar95, losingRun, sizeSteps, CVAR_TRADE_PCT } from '../engine/sizing';
import { calc45DTE } from '../engine/calc45dte';

describe('CVaR95', () => {
  it('is the max loss when the max-loss tail is 5% or more', () => {
    expect(cvar95({ risk: 1890, winP: 0.72, pMaxLoss: 0.08 })).toBeCloseTo(1890, 6);
  });
  it('blends max and partial losses when the tail is thinner than 5%', () => {
    // 2% at max loss 690, 3% of the partial losers at 30% of it
    expect(cvar95({ risk: 690, winP: 0.72, pMaxLoss: 0.02, partialFrac: 0.3 })).toBeCloseTo((0.02 * 690 + 0.03 * 690 * 0.3) / 0.05, 6);
  });
  it('without P(max loss) every loser counts as a max loss, plus commission', () => {
    expect(cvar95({ risk: 500, winP: 0.8, pMaxLoss: null, commission: 2.6 })).toBeCloseTo(502.6, 6);
    expect(cvar95({ risk: 0, winP: 0.8 })).toBeNull();
  });
});

describe('losing run', () => {
  it('3 losses take 10% of $41k at $1,380 each; a run of 3 in 100 trades at 28% losers is 81%', () => {
    const r = losingRun({ lossEach: 1380, capital: 41230, pLoss: 0.28 });
    expect(r.n).toBe(3);
    expect(r.prob).toBeCloseTo(0.807, 2);
  });
});

describe('size steps', () => {
  const capital = { netLiq: 41230, initMargin: 9500, vix: 17.6 };
  it('takes the smallest cap and says which one', () => {
    const s = sizeSteps({ kellyFull: 9, kellyHalf: 4, useHalf: true, riskEach: 1000, capital, cvarEach: 380, bankroll: 40000 });
    // BP: 35% × 41,230 − 9,500 = 4,930 → 4; CVaR: 2% × 40,000 = 800 → 2
    expect(s.steps.map(x => [x.key, x.ct])).toEqual([['kelly', 9], ['half', 4], ['bp', 4], ['cvar', 2]]);
    expect(s.binding).toBe('cvar');
    expect(s.final).toBe(2);
    expect(CVAR_TRADE_PCT).toBe(2);
  });
  it('full Kelly is ignored when half applies; without TWS there is no buying power step', () => {
    const s = sizeSteps({ kellyFull: 6, kellyHalf: 3, useHalf: true, riskEach: 300, capital: null, cvarEach: 100, bankroll: 40000 });
    expect(s.steps.map(x => x.key)).toEqual(['kelly', 'half', 'cvar']);
    expect(s.binding).toBe('half');
    expect(s.final).toBe(3);
  });
  it('the bad-day cap is per account, 2% when not set', () => {
    const at = pct => sizeSteps({ kellyFull: 9, riskEach: 1890, cvarEach: 1890, bankroll: 12801, cvarPct: pct }).cvar;
    expect(at(undefined)).toMatchObject({ pct: 2, ct: 0 });
    expect(at(15)).toMatchObject({ pct: 15, ct: 1 });
    expect(Math.round(at(15).limit)).toBe(1920);
  });
  it('a cap at zero keeps one contract and is reported', () => {
    const s = sizeSteps({ kellyFull: 2, riskEach: 1890, capital: { netLiq: 20000, initMargin: 7500, vix: 14 }, cvarEach: 1890, bankroll: 12801 });
    expect(s.final).toBe(1);
    expect(s.capsAtZero.sort()).toEqual(['bp', 'cvar']);
  });
});

describe('45DTE engine', () => {
  const in45 = { underlying: 'SPY', price: 680, iv: 18, ivr: 45, hv: 15, vix: 17.6, dte: 45, strategy: 'Iron Condor',
    win: 155, risk: 345, pop: 72, bankroll: 40000, startBR: 40000, maxLoss: 8000, maxOpen: 16000, termBias: 'contango' };
  it('reports CVaR, EV per CVaR and the caps, and sizes to the smallest', () => {
    const r = calc45DTE({ ...in45, capital: { netLiq: 41230, initMargin: 13000, vix: 17.6 } });
    expect(r.cvar95).toBeGreaterThan(0);
    expect(r.cvar95).toBeLessThanOrEqual(345 + 10);
    expect(r.sizing.steps.map(s => s.key)).toContain('bp');
    const smallest = Math.max(1, Math.min(...r.sizing.steps.filter(s => s.key !== 'kelly' || !r.sizing.steps.some(x => x.key === 'half')).map(s => s.ct)));
    expect(r.kellyContracts).toBe(smallest);
    expect(r.contracts).toBe(smallest);
    expect(r.losingRun.n).toBeGreaterThan(0);
  });
  it('a typed size still wins over the caps', () => {
    expect(calc45DTE({ ...in45, contractsOverride: 7 }).contracts).toBe(7);
  });
});
