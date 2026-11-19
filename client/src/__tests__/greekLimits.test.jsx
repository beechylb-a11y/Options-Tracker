/* Book greek limits (Nov 2026): theta, delta and a +10 vol shock as a share of the
   bankroll, for the 45DTE book only; warnings on a 45DTE ticket that would push the
   book past a band; gauges on the Risk page. */
import React from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { LIMITS, spyDeltas, spyPriceFrom, bookLimits, bookGreeks, tradeLimitWarnings, thetaTone, deltaTone, vegaTone, ratioTone } from '../engine/greekLimits';
import { calc45DTE } from '../engine/calc45dte';
import { STRESS_IV } from '../engine/portfolio';
import RiskGauges from '../components/RiskGauges';

afterEach(() => cleanup());

describe('units', () => {
  it('$ per 1% SPX → SPY deltas; SPY price falls back to SPX/10, then XSP', () => {
    expect(spyDeltas(366.5, 733)).toBeCloseTo(50, 6);           // 50 SPY deltas × $7.33 per 1%
    expect(spyDeltas(-733, 733)).toBeCloseTo(-100, 6);
    expect(spyDeltas(100, null)).toBeNull();
    expect(spyPriceFrom({ spy: 733.1, spx: 7342 })).toBe(733.1);
    expect(spyPriceFrom({ spx: 7342 })).toBeCloseTo(734.2, 6);
    expect(spyPriceFrom({ xsp: 734 })).toBe(734);
    expect(spyPriceFrom({})).toBeNull();
  });
  it('the stress grid now carries a +10 vol column', () => {
    expect(STRESS_IV).toEqual([-5, 0, 5, 10]);
  });
});

describe('bands', () => {
  it('theta: under 0.1% is under target, 0.1–0.3% green, amber past 0.3%, red past 0.5%, negative amber', () => {
    expect(thetaTone(0.0005)).toBe('low');
    expect(thetaTone(0.002)).toBe('green');
    expect(thetaTone(0.003)).toBe('green');
    expect(thetaTone(0.0031)).toBe('amber');
    expect(thetaTone(0.0051)).toBe('red');
    expect(thetaTone(-0.001)).toBe('amber');
  });
  it('delta: inside ±band green, outside amber, past twice red; vega loss 3% / 5%; Δ/Θ 1 / 5', () => {
    expect([deltaTone(0.9), deltaTone(1.2), deltaTone(2.1)]).toEqual(['green', 'amber', 'red']);
    expect([vegaTone(0.02), vegaTone(0.04), vegaTone(0.06)]).toEqual(['green', 'amber', 'red']);
    expect([ratioTone(0.5), ratioTone(2), ratioTone(6)]).toEqual(['green', 'amber', 'red']);
  });
  it('bookLimits on a $50k bankroll: band ±50 SPY deltas, theta $50–$150, vega lines $1,500 / $2,500', () => {
    const l = bookLimits({ n: 3, theta: 120, spxDelta1: -366.5, vega10: -1800 }, { netLiq: 50000, spyPrice: 733 });
    expect(l.deltaBand).toBe(50);
    expect(l.deltaSpy).toBeCloseTo(-50, 6);
    expect(l.deltaTone).toBe('green');
    expect(l.thetaPct).toBeCloseTo(0.0024, 6);
    expect(l.thetaTone).toBe('green');
    expect(l.thetaBand).toEqual({ floor: 50, amber: 150, red: 250 });
    expect(l.vegaLossPct).toBeCloseTo(0.036, 6);
    expect(l.vegaTone).toBe('amber');
    expect(l.ratio).toBeCloseTo(50 / 120, 6);
  });
  it('no bankroll → no percentages', () => {
    const l = bookLimits({ theta: 100, spxDelta1: 50 }, { netLiq: 0, spyPrice: 733 });
    expect([l.netLiq, l.thetaPct, l.deltaFrac]).toEqual([null, null, null]);
  });
  it('bookGreeks sums only the book asked for', () => {
    const risks = [
      { p: { engine: '45DTE' }, greeks: { theta: 40, vega: -90 }, spxDelta1: 100 },
      { p: { engine: '0DTE' }, greeks: { theta: 400, vega: -5 }, spxDelta1: -700 },
      { p: { engine: '45DTE' }, greeks: { theta: 25, vega: -60 }, spxDelta1: -30 },
    ];
    expect(bookGreeks(risks, r => r.p.engine === '45DTE')).toEqual({ n: 2, theta: 65, spxDelta1: 70, vega: -150 });
  });
});

describe('ticket warnings', () => {
  const book = { theta: 100, spxDelta1: 200, vega: -300, netLiq: 50000, spyPrice: 733 };
  it('a trade that takes theta past 0.3% or delta past the band says so; one that stays inside says nothing', () => {
    // +$30/day × 2 = book $160/day → 0.32%
    const t = tradeLimitWarnings(book, { theta: 30, delta: 0, vega: -20, contracts: 2, price: 7340, beta: 1 });
    expect(t).toHaveLength(1);
    expect(t[0]).toMatch(/Book theta would be \$160\/day, 0\.32% of bankroll — over the 0\.3% line/);
    // delta +4 share-deltas × 3 ct at SPX 7340: +$880.8 per 1% → book 1080.8 → 147 SPY deltas
    const d = tradeLimitWarnings(book, { theta: 0, delta: 4, vega: 0, contracts: 3, price: 7340, beta: 1 });
    expect(d[0]).toMatch(/Book delta would be 147 SPY deltas long, past the ±50 band/);
    expect(tradeLimitWarnings(book, { theta: 5, delta: -0.1, vega: -10, contracts: 1, price: 7340, beta: 1 })).toEqual([]);
  });
  it('no bankroll or no size → no warnings', () => {
    expect(tradeLimitWarnings({ ...book, netLiq: 0 }, { theta: 500, contracts: 5, price: 7340 })).toEqual([]);
    expect(tradeLimitWarnings(book, { theta: 500, contracts: 0, price: 7340 })).toEqual([]);
  });
  it('the 45DTE engine adds them to the ticket warnings when the book is passed in, and only then', () => {
    const inp = { underlying: 'SPX', price: 7340, ivr: 40, iv: 16, hv: 14, vix: 16, termBias: 'contango',
      dte: 45, outlook: 'neutral', pop: 70, win: 300, risk: 700, bankroll: 50000, startBR: 50000, maxLoss: 1000, maxOpen: 3000,
      overrideStrategy: 'Iron Condor - Normal', theta: 60, vega: -120, delta: 0, bpr: 700, contractsOverride: 2 };
    const without = calc45DTE(inp);
    const withBook = calc45DTE({ ...inp, book45: { theta: 100, spxDelta1: 0, netLiq: 50000, spyPrice: 734 } });
    expect(without.warnings.some(w => /Book theta/.test(w))).toBe(false);
    expect(withBook.warnings.some(w => /Book theta would be \$220\/day, 0\.44% of bankroll/.test(w))).toBe(true);
    expect(withBook.decision).toBe(without.decision);   // warns, never blocks
  });
});

describe('gauges', () => {
  it('ask for a bankroll when there is none', () => {
    render(<RiskGauges lim={bookLimits({ theta: 10 }, { netLiq: 0 })} />);
    expect(screen.getByTestId('gauges-no-bankroll')).toBeTruthy();
  });
  it('show each book number against its band, and the 0DTE book outside the limits', () => {
    const lim = bookLimits({ n: 2, theta: 180, spxDelta1: -440, vega10: -1200 }, { netLiq: 50000, spyPrice: 733 });
    render(<RiskGauges lim={lim} zero={{ n: 1, theta: 640, spxDelta1: -900 }} />);
    expect(screen.getByTestId('gauge-theta').textContent).toMatch(/0\.36%.*\$180 a day of \$50,000/);
    expect(screen.getByTestId('gauge-theta-tone').textContent).toBe('over the line');
    expect(screen.getByTestId('gauge-delta').textContent).toMatch(/−60.*short · band ±50/);
    expect(screen.getByTestId('gauge-delta-tone').textContent).toBe('over the line');
    expect(screen.getByTestId('gauge-vega').textContent).toMatch(/2\.4%.*loses \$1,200 if IV jumps 10/);
    expect(screen.getByTestId('gauge-vega-tone').textContent).toBe('inside the band');
    expect(screen.getByTestId('gauges-zero').textContent).toMatch(/0DTE book \(1\) is outside these limits — θ \$640\/day/);
    expect(LIMITS.theta.red).toBe(0.005);
  });
});
