/* Which ruler the gamma block measures against, decided by the data.

   The 12 Oct SPX and IWM tickets blocked at 5.79 and 7.14 against a limit of 2.0,
   both on ATR — a full day's range applied to a 0DTE that lived four hours. On the
   market's own remaining-session move they read 0.81 and 1.66. These pin that the
   comparison is made out of sample, that it stays quiet without enough evidence,
   and that the caveat on the implied ruler is stated when it wins. */
import { describe, it, expect } from 'vitest';
import { suggestions } from '../engine/suggest';

// A short-gamma 0DTE verdict. R is pnl_managed over the max loss derived from the
// legs: a 10-wide SPX fly bought for 4.00 risks 400 a contract.
const FLY = [
  { strike: 5990, right: 'C', qty: 1 }, { strike: 6000, right: 'C', qty: -2 },
  { strike: 6010, right: 'C', qty: 1 },
];
let n = 0;
const tick = ({ moveCost, hours = 6.5, sdLeft = 20, gamma = -4, theta = 500, pnl }) => {
  n += 1;
  const d = `2026-0${1 + Math.floor(n / 28)}-${String((n % 28) + 1).padStart(2, '0')}`;
  return {
    session_date: d, first_seen: `${d}T15:00:00Z`, engine: '0DTE', underlying: 'SPX',
    strategy: 'Standard butterfly', category: 'taken', verdict: 'Trade', blockers: null,
    legs: FLY, entry_net: -4, edge_score: 60, ev: 20, risk: 400, win: 600, pop: 55,
    move_cost: moveCost, managed_at: `${d}T20:00:00Z`, pnl_managed: pnl,
    exit_reason: 'target', commission: 0, entry_half_spread: 0,
    inputs: { em: 20, sdLeft, vix: 15, vix1d: 6, atr: 60, hours, hoursToBell: hours, gamma, theta },
  };
};
const ids = r => r.suggestions.map(s => s.id);

describe('gamma ruler', () => {
  it('stays quiet until there are enough short-gamma verdicts', () => {
    const rows = Array.from({ length: 12 }, () => tick({ moveCost: 3, pnl: 100 }));
    const r = suggestions(rows);
    expect(ids(r)).not.toContain('gamma-ruler');
    expect(r.waiting.map(w => w.what)).toContain('Which ruler the gamma block uses');
  });

  it('prefers the horizon ruler when the hours explain the outcomes and ATR does not', () => {
    // Every ticket reads 3.0 on ATR, so ATR cannot separate anything. The ones that
    // were only open a short while won; scaled by hours they fall under 2.0.
    const rows = Array.from({ length: 60 }, (_, i) => i % 2 === 0
      ? tick({ moveCost: 3.0, hours: 2.0, pnl: 200 })     // scaled 0.92 — winners
      : tick({ moveCost: 3.0, hours: 6.5, pnl: -200 }));  // scaled 3.00 — losers
    const s = suggestions(rows).suggestions.find(x => x.id === 'gamma-ruler');
    expect(s).toBeTruthy();
    expect(s.tone).toBe('change');
    expect(s.title).toMatch(/hours the trade is actually exposed/);
    expect(s.evidence).toMatch(/latest third|atr at|horizon at/);
  });

  it('keeps ATR when no other ruler separates the outcomes any better', () => {
    const rows = Array.from({ length: 60 }, (_, i) => i % 2 === 0
      ? tick({ moveCost: 1.0, hours: 6.5, pnl: 200 })
      : tick({ moveCost: 5.0, hours: 6.5, pnl: -200 }));
    const s = suggestions(rows).suggestions.find(x => x.id === 'gamma-ruler');
    expect(s).toBeTruthy();
    expect(s.tone).toBe('keep');
  });

  it('states the caveat when the implied ruler is the one that wins', () => {
    // sdLeft separates the outcomes; ATR is flat across both groups.
    const rows = Array.from({ length: 60 }, (_, i) => i % 2 === 0
      ? tick({ moveCost: 3.0, sdLeft: 10, gamma: -4, theta: 500, pnl: 200 })
      : tick({ moveCost: 3.0, sdLeft: 40, gamma: -4, theta: 500, pnl: -200 }));
    const s = suggestions(rows).suggestions.find(x => x.id === 'gamma-ruler');
    expect(s).toBeTruthy();
    if (s.tone === 'change' && /remaining-session/.test(s.title)) {
      expect(s.evidence).toMatch(/implied on both sides/i);
    }
  });

  it('leaves the existing block-level candidate alone', () => {
    const rows = Array.from({ length: 60 }, (_, i) => i % 2 === 0
      ? tick({ moveCost: 1.0, pnl: 200 }) : tick({ moveCost: 5.0, pnl: -200 }));
    expect(ids(suggestions(rows))).toContain('gamma');
  });
});
