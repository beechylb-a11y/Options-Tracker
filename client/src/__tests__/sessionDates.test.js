/* NY session dates (Oct 2026). The print of a QQQ fly built during Monday 5 Oct's
   session, printed at 16:19 ET (07:19 Tuesday in Melbourne), read "2026-10-06
   session". A ticket is dated by when it was built; anything recorded is dated by
   the most recent NY session that has opened. Never by the computer's clock. */
import { describe, it, expect } from 'vitest';
import { ticketSession, lastSessionDate, sessionLabelOf, fmtSessionDate } from '../engine/session';

const at = s => new Date(s);
const MON_1130_ET = '2026-10-05T15:30:00Z';   // 02:30 Tue in Melbourne
const MON_1619_ET = '2026-10-05T20:19:00Z';   // 07:19 Tue in Melbourne
const MON_1648_ET = '2026-10-05T20:48:00Z';   // 07:48 Tue in Melbourne — prep for Tuesday
const TUE_1000_ET = '2026-10-06T14:00:00Z';

describe('ticketSession', () => {
  it('dates a ticket built during the session by that session, however late it is printed', () => {
    expect(ticketSession({ createdAt: MON_1130_ET }, at(MON_1619_ET)).dateISO).toBe('2026-10-05');
    expect(ticketSession({ loggedAt: '2026-10-05T15:36:00Z' }, at(MON_1619_ET)).dateISO).toBe('2026-10-05');
  });
  it('still dates after-close prep for the next session', () => {
    expect(ticketSession({ createdAt: MON_1648_ET }, at(MON_1648_ET)).dateISO).toBe('2026-10-06');
  });
  it('an after-close pull does not move a ticket; a live pull in a later session does', () => {
    expect(ticketSession({ createdAt: MON_1130_ET, pricedAt: MON_1619_ET }).dateISO).toBe('2026-10-05');
    expect(ticketSession({ createdAt: MON_1130_ET, pricedAt: TUE_1000_ET }).dateISO).toBe('2026-10-06');
  });
  it('falls back to the clock rule with nothing to go on', () => {
    expect(ticketSession({}, at(MON_1619_ET)).basis).toBe('now');
  });
});

describe('lastSessionDate', () => {
  it('records in the session just traded, not the next one and not UTC', () => {
    expect(lastSessionDate(at(MON_1619_ET))).toBe('2026-10-05');
    expect(lastSessionDate(at('2026-10-06T01:30:00Z'))).toBe('2026-10-05');   // 12:30 Tue Melbourne, UTC already Tue
    expect(lastSessionDate(at('2026-10-06T12:00:00Z'))).toBe('2026-10-05');   // 08:00 ET Tue, before the open
    expect(lastSessionDate(at(TUE_1000_ET))).toBe('2026-10-06');
    expect(lastSessionDate(at('2026-10-10T15:00:00Z'))).toBe('2026-10-09');   // Saturday → Friday
  });
});

describe('labels', () => {
  it('shows a stored instant as its NY session date', () => {
    expect(sessionLabelOf(MON_1130_ET)).toBe('5 Oct');
    expect(fmtSessionDate('2026-10-05')).toBe('Mon 5 Oct 2026');
  });
});
