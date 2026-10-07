/* Listed strikes per expiry and right (Oct 2026). QQQ 20 Nov listed puts every $1
   and calls every $5 out there; the engine's $1-grid condor asked for unlisted calls
   and, fixed by hand, had unequal wings — which TWS books as a custom combo. */
import { describe, it, expect } from 'vitest';
import { fitToListed, unlistedLegs, unequalWings, listedLadder, chainCovers } from '../engine/listedStrikes';
import { bracketStrikes } from '../engine/deltaStrikes';
import { calc45DTE } from '../engine/calc45dte';

const range = (a, b, s) => { const o = []; for (let k = a; k <= b + 1e-9; k += s) o.push(+k.toFixed(2)); return o; };
// QQQ 20 Nov: $1 puts 600–780; calls $1 to 780 then $5 beyond
const QQQ = { P: range(600, 780, 1), C: [...range(700, 780, 1), ...range(785, 900, 5)] };
const ic = (lp, sp, sc, lc) => [
  { label: 'Long put', strike: lp }, { label: 'Short put', strike: sp },
  { label: 'Short call', strike: sc }, { label: 'Long call', strike: lc },
];

describe('fitToListed', () => {
  it('moves a condor onto listed calls with one wing width both sides', () => {
    const f = fitToListed(ic(701, 712, 811, 822), QQQ);
    const k = f.legs.map(l => l.strike);
    expect(k[1]).toBe(712);
    expect(k[2]).toBe(810);
    expect(k[1] - k[0]).toBe(k[3] - k[2]);           // equal wings
    expect(k[1] - k[0]).toBe(10);                     // nearest common width to 11
    expect(QQQ.C).toContain(k[3]);
    expect(f.equalWings).toBe(10);
    expect(f.changed).toBe(true);
  });

  it('leaves a condor alone when it is already listed and even', () => {
    const f = fitToListed(ic(702, 712, 810, 820), QQQ);
    expect(f.changed).toBe(false);
  });

  it('keeps an iron fly body on a strike listed for both rights', () => {
    const fly = [{ label: 'Long put (wing)', strike: 740 }, { label: 'Short put (body)', strike: 783 },
      { label: 'Short call (body)', strike: 783 }, { label: 'Long call (wing)', strike: 826 }];
    const f = fitToListed(fly, QQQ);
    const k = f.legs.map(l => l.strike);
    expect(k[1]).toBe(k[2]);
    expect(QQQ.C).toContain(k[2]);
    expect(QQQ.P).toContain(k[1]);
    expect(k[1] - k[0]).toBe(k[3] - k[2]);
  });

  it('snaps a vertical leg by leg without collapsing it', () => {
    const v = [{ label: 'Short call', strike: 811 }, { label: 'Long call', strike: 813 }];
    const f = fitToListed(v, QQQ);
    expect(f.legs[0].strike).toBe(810);
    expect(f.legs[1].strike).toBe(815);               // 813 → 815, not onto the short
  });

  it('ignores a short or truncated chain instead of collapsing the condor (825/825)', () => {
    // what reached the app on 7 Oct: no puts, a stub of calls
    const bad = { P: [], C: [825] };
    const f = fitToListed(ic(706, 717, 807, 818), bad);
    expect(f.changed).toBe(false);
    expect(f.legs.map(l => l.strike)).toEqual([706, 717, 807, 818]);
    expect(f.skipped).toMatch(/only 0 puts/);
    // calls that stop short of the legs
    const cut = { P: QQQ.P, C: range(700, 810, 1) };
    expect(chainCovers(ic(706, 717, 807, 818), cut).ok).toBe(true);   // within one span: still usable
    const cut2 = { P: QQQ.P, C: range(700, 760, 1) };
    expect(chainCovers(ic(706, 717, 807, 818), cut2).ok).toBe(false);
    expect(fitToListed(ic(706, 717, 807, 818), cut2).changed).toBe(false);
    expect(unlistedLegs(ic(706, 717, 807, 818), cut2)).toEqual([]);   // no false alarms off a bad list
  });

  it('never puts a short and its long on one strike', () => {
    const sparse = { P: range(600, 780, 1), C: [700, 750, 800, 825, 830, 835] };
    const f = fitToListed(ic(706, 717, 807, 818), sparse);
    const k = f.legs.map(l => l.strike);
    expect(k[3]).toBeGreaterThan(k[2]);
    expect(k[1]).toBeGreaterThan(k[0]);
    expect(k[1] - k[0]).toBe(k[3] - k[2]);
  });

  it('does nothing without a chain', () => {
    expect(fitToListed(ic(701, 712, 811, 822), null).changed).toBe(false);
  });

  it('flags unlisted strikes and uneven wings', () => {
    expect(unlistedLegs(ic(701, 712, 811, 822), QQQ).map(l => l.strike)).toEqual([811, 822]);
    expect(unequalWings(ic(702, 712, 810, 815))).toEqual({ put: 10, call: 5 });
    expect(unequalWings(ic(702, 712, 810, 820))).toBeNull();
  });

  it('ladders and brackets walk the listed chain', () => {
    expect(listedLadder(QQQ.C, 811, 2)).toEqual([820, 815, 810, 805, 800]);
    expect(bracketStrikes(811, 'QQQ', 1, QQQ.C)).toEqual([805, 810, 815]);
    expect(bracketStrikes(811, 'QQQ', 1)).toEqual([810, 811, 812]);
  });
});

describe('calc45DTE with the listed chain', () => {
  const base = { price: 760, ivr: 45, iv: 20, hv: 16, vix: 18, ivFront: 19, ivBack: 21, skew: 4,
    termBias: 'contango', dte: 44, pop: 0, win: 0, risk: 0, bankroll: 3000, startBR: 3000, maxLoss: 300,
    maxOpen: 450, bpr: 0, theta: 0, vega: 0, delta: 0, underlying: 'QQQ', outlook: 'neutral',
    overrideStrategy: 'Iron Condor - Normal' };

  it('builds the condor on listed strikes with equal wings', () => {
    const r = calc45DTE({ ...base, listedStrikes: QQQ });
    const k = r.legs.map(l => l.strike);
    k.forEach((x, i) => expect((i < 2 ? QQQ.P : QQQ.C)).toContain(x));
    expect(k[1] - k[0]).toBe(k[3] - k[2]);
    expect(r.warnings.join(' ')).not.toMatch(/Not listed|Wings differ/);
  });

  it('warns on a hand edit TWS will not take as an iron condor', () => {
    const r0 = calc45DTE({ ...base, listedStrikes: QQQ });
    const r = calc45DTE({ ...base, listedStrikes: QQQ, overrideStrikes: { 3: r0.legs[2].strike + 5 },
      overrideStrikesStrat: 'Iron Condor - Normal' });
    expect(r.warnings.join(' ')).toMatch(/Wings differ/);
    const r2 = calc45DTE({ ...base, listedStrikes: QQQ, overrideStrikes: { 2: 811 }, overrideStrikesStrat: 'Iron Condor - Normal' });
    expect(r2.warnings.join(' ')).toMatch(/Not listed for this expiry: 811C/);
  });
});
