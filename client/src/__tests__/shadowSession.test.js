/* A verdict belongs to the session it was BUILT for.
   Two SPX/IWM 0DTE tickets searched at 11:35 ET Monday were saved at 19:44 ET the
   same evening — after the close — and the capture stamped them session 2026-10-13
   with a 20261013 expiry and 6.5 hours left. All three are Tuesday's. Settlement
   would have read Tuesday's close for a trade that closed at 15:45 Monday. */
import { describe, it, expect } from 'vitest';
import { ticketSession, tradingSession } from '../engine/session';

// The real moments from the two captured rows.
const BUILT = '2026-10-12T15:35:00Z';   // 11:35 ET Monday
const SAVED = '2026-10-12T23:44:54Z';   // 19:44 ET Monday, after the 16:00 close

describe('dating a verdict', () => {
  it('rolls to the next session when asked at the save instant — the bug', () => {
    const now = tradingSession(new Date(SAVED));
    expect(now.dateISO).toBe('2026-10-13');
    expect(now.isNextSession).toBe(true);
    expect(now.hoursToBell).toBe(6.5);     // a whole session that has not happened
  });

  it('keeps Monday when dated from when the ticket was priced', () => {
    const s = ticketSession({ pricedAt: BUILT }, new Date(SAVED));
    expect(s.dateISO).toBe('2026-10-12');
    expect(s.yyyymmdd).toBe('20261012');
    expect(s.basis).toBe('priced');
    expect(s.isNextSession).toBe(false);
  });

  it('reports the hours the ticket actually had, not a full session', () => {
    const s = ticketSession({ pricedAt: BUILT }, new Date(SAVED));
    expect(s.hoursToBell).toBeCloseTo(4.4, 1);   // 11:35 → 16:00
    expect(s.hoursLeft).toBeCloseTo(3.4, 1);     // 11:35 → 15:00, what the scores use
  });

  it('prefers when it was opened over when it was priced only if that is earlier', () => {
    // createdAt is the tab; pricedAt is the last live pull. The later of the two wins
    // so long as it is not already rolled into the next session.
    const s = ticketSession({ createdAt: '2026-10-12T14:00:00Z', pricedAt: BUILT }, new Date(SAVED));
    expect(s.dateISO).toBe('2026-10-12');
  });

  it('falls back to the clock only when the ticket carries no moment at all', () => {
    expect(ticketSession({}, new Date(SAVED)).basis).toBe('now');
    expect(ticketSession({}, new Date(SAVED)).dateISO).toBe('2026-10-13');
  });

  it('a ticket genuinely built after the close still belongs to the next session', () => {
    // The fix must not drag a legitimately-next-session ticket backwards.
    const s = ticketSession({ pricedAt: SAVED }, new Date(SAVED));
    expect(s.dateISO).toBe('2026-10-13');
  });
});
