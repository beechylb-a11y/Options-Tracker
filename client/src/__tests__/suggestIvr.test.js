/* The IV-rank floor is a CANDIDATE, not a rule. These tests pin the three things
   that keep it honest: it stays quiet until there is enough evidence, it only
   proposes a floor that beat no-floor out of sample, and it says so plainly when
   no floor earns its place. */
import { describe, it, expect } from 'vitest';
import { suggestions } from '../engine/suggest';

// A settled 45DTE credit sale, shaped like a shadow_verdicts row. R comes from
// pnl_managed over the max loss that outcomeOf derives from the LEGS, so the legs
// have to be real: a 10-wide QQQ condor taken for 2.00 risks 800 a contract.
let n = 0;
const CONDOR = [
  { strike: 690, right: 'P', qty: 1 }, { strike: 700, right: 'P', qty: -1 },
  { strike: 800, right: 'C', qty: -1 }, { strike: 810, right: 'C', qty: 1 },
];
const sale = (ivr, pnl, { strategy = 'Iron Condor - Normal', date, legs = CONDOR } = {}) => {
  n += 1;
  const d = date || `2026-0${1 + Math.floor(n / 28)}-${String((n % 28) + 1).padStart(2, '0')}`;
  return {
    session_date: d, first_seen: `${d}T14:00:00Z`, engine: '45DTE', underlying: 'QQQ',
    strategy, category: 'taken', verdict: 'Trade', blockers: null,
    legs, entry_net: 2, edge_score: 60, ev: 50, risk: 800, win: 200, pop: 70,
    managed_at: `${d}T20:00:00Z`, pnl_managed: pnl, exit_reason: 'target',
    commission: 0, entry_half_spread: 0,
    inputs: { iv: 22, ivr, hv: 18, vix: 15, dte: 45 },
  };
};

const ids = r => r.suggestions.map(s => s.id);

describe('IV rank floor as a shadow-loop candidate', () => {
  it('waits rather than guessing when there is not enough evidence', () => {
    const rows = Array.from({ length: 12 }, (_, i) => sale(i < 6 ? 15 : 45, i < 6 ? -300 : 300));
    const r = suggestions(rows);
    expect(ids(r)).not.toContain('ivr');
    expect(r.waiting.map(w => w.what)).toContain('Minimum IV rank for credit structures');
  });

  it('proposes a floor when low-IVR sales lose and high-IVR sales do not', () => {
    // 60 sales, strictly alternating so both halves of the chronological split see
    // each kind: below 30 loses, at or above 30 wins.
    const rows = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? sale(15, -400) : sale(45, 400));
    const r = suggestions(rows);
    const s = r.suggestions.find(x => x.id === 'ivr');
    expect(s).toBeTruthy();
    expect(s.tone).toBe('change');
    expect(s.title).toMatch(/below IV rank \d+/);
    expect(s.evidence).toMatch(/latest third/);
  });

  it('says no floor earns its place when IV rank does not separate the outcomes', () => {
    // Same P&L either side of every candidate threshold: nothing to find.
    const rows = Array.from({ length: 60 }, (_, i) => sale(10 + (i % 5) * 10, i % 2 ? 200 : -200));
    const s = suggestions(rows).suggestions.find(x => x.id === 'ivr');
    expect(s).toBeTruthy();
    expect(s.tone).toBe('keep');
  });

  it('ignores 0DTE and debit structures — the rule is about selling premium', () => {
    const rows = [
      ...Array.from({ length: 40 }, () => ({ ...sale(15, -400), engine: '0DTE' })),
      ...Array.from({ length: 40 }, () => sale(15, -400, { strategy: 'Bull call spread' })),
    ];
    const r = suggestions(rows);
    expect(ids(r)).not.toContain('ivr');
    const w = r.waiting.find(x => x.what === 'Minimum IV rank for credit structures');
    expect(w.n).toBe(0);
  });
});
