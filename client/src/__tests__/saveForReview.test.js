/* Why a verdict was not recorded, said out loud.
   Three tickets were left open on 12 Oct expecting the 20-second auto-capture to
   record them; none were, and nothing in the app could say why. These pin the
   reasons a ticket is ineligible, so the button can be disabled WITH a reason
   instead of the whole thing being silent. */
import { describe, it, expect } from 'vitest';
import { whyNoShadow, shadowLegs, categoryOf } from '../engine/shadow';

const LEGS = [
  { label: 'Long put', strike: 690 }, { label: 'Short put', strike: 700 },
  { label: 'Short call', strike: 800 }, { label: 'Long call', strike: 810 },
];

describe('whyNoShadow', () => {
  it('says nothing when the ticket can be recorded', () => {
    expect(whyNoShadow({ legs: LEGS, price: 750 })).toBe('');
  });

  it('names the blocker rather than just refusing', () => {
    const why = whyNoShadow({ hardBlocker: 'Enter IV, IVR and HV', legs: LEGS, price: 750 });
    expect(why).toMatch(/Enter IV, IVR and HV/);
  });

  it('explains the time-spread exclusion, which is the least guessable one', () => {
    expect(whyNoShadow({ isTimeSpread: true, legs: LEGS, price: 750 })).toMatch(/calendars and diagonals/i);
  });

  it('catches an empty ticket and a missing price', () => {
    expect(whyNoShadow({ legs: [], price: 750 })).toMatch(/no legs/i);
    expect(whyNoShadow({ legs: LEGS, price: 0 })).toMatch(/no underlying price/i);
    expect(whyNoShadow({ legs: LEGS })).toMatch(/no underlying price/i);
  });

  it('reports the blocker first — it is the one the user can act on', () => {
    expect(whyNoShadow({ hardBlocker: 'Backwardation', isTimeSpread: true, legs: [], price: 0 }))
      .toMatch(/Backwardation/);
  });
});

describe('what gets recorded is unchanged by any of this', () => {
  it('still reads legs off the labels', () => {
    expect(shadowLegs(LEGS)).toEqual([
      { strike: 690, right: 'P', qty: 1 }, { strike: 700, right: 'P', qty: -1 },
      { strike: 800, right: 'C', qty: -1 }, { strike: 810, right: 'C', qty: 1 },
    ]);
  });

  it('still categorises a saved-but-not-traded ticket as a verdict, not a trade', () => {
    expect(categoryOf({ blockers: [], verdictWord: 'Take the trade', missingInputs: false, logged: false })).toBe('trade');
    expect(categoryOf({ blockers: [], verdictWord: 'Take the trade', missingInputs: false, logged: true })).toBe('taken');
    expect(categoryOf({ blockers: ['Vol↔Structure'], verdictWord: 'Take the trade', missingInputs: false })).toBe('blocked');
    expect(categoryOf({ blockers: [], verdictWord: 'Pass', missingInputs: false })).toBe('pass');
  });
});
