// ================================================================
//  SCHEDULED EVENT RISK  (Aug 2026)
// ================================================================
// Warnings only. Nothing here touches setup score, EV or Kelly — a macro release
// is a fact about the day, not a judgement about the structure, and folding it
// into the scorecard would have moved every A+/A/B band and made old scores
// incomparable to new ones.
//
// THE DESIGN CONSTRAINT THAT SHAPES THIS FILE. A calendar that fails returns
// "no events", which on a ticket is indistinguishable from "all clear" — the
// failure points at the dangerous answer. So absence of data is reported as
// loudly as presence of an event: an empty BLS set, a stale file, or a horizon
// that does not reach expiry each produce their own warning. Silence on this
// ticket means checked and clear, never "did not know".
import CALENDAR from './econ-calendar.js';

// 09:30 open, 16:00 close. A release at 08:30 is already OUT by the time a 0DTE
// is traded: the risk is a wide opening range and then an IV crush, which is a
// completely different trade from a 14:00 FOMC landing mid-position.
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
};
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

export function calendarMeta(cal = CALENDAR) {
  return {
    generatedAt: cal.generatedAt || null,
    horizonEnd: cal.horizonEnd || null,
    blsLoaded: !!cal.blsLoaded,
    count: (cal.events || []).length,
  };
}

const severityOf = (kind, cal = CALENDAR) => (cal.severity || {})[kind] || 'low';

/** Events on [fromISO, toISO] inclusive, sorted. */
export function eventsInWindow(fromISO, toISO, cal = CALENDAR) {
  return (cal.events || [])
    .filter(e => e.date >= fromISO && e.date <= toISO)
    .sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
}

// ── Coverage: what this calendar cannot tell you ──────────────────────────────
// These are NOTICES, not warnings, and the distinction is load-bearing. The engines
// gate their decision on `warnings.length`, so routing "the calendar has no BLS
// dates" through that array pinned every single ticket at "Trade with caution" for
// as long as the gap existed — a permanent alarm, which is the fastest way to teach
// someone to stop reading alarms. A coverage gap is a statement about MY data, not
// about your trade: it is shown, prominently, but it never moves the decision.
// Only a real scheduled event does that.
function coverageNotices(todayISO, needThroughISO, cal = CALENDAR) {
  const out = [];
  const meta = calendarMeta(cal);
  if (!meta.count) {
    out.push('Event calendar is empty — no macro release dates are loaded, so this ticket has NOT been checked against the calendar');
    return out;
  }
  if (!meta.blsLoaded) {
    // Names the releases that are unchecked and the one command that fixes it. BLS is
    // automated now via its iCalendar feed — the HTML schedule page blocks bots, the
    // .ics does not — so this really does clear on a refresh.
    out.push('Event calendar holds Fed dates only. CPI, PPI and payrolls are NOT being checked — a release on those days will pass unmentioned. Fix: node tools/refresh-calendar.mjs');
  }
  if (meta.generatedAt) {
    const age = daysBetween(meta.generatedAt, todayISO);
    if (age > 120) out.push(`Event calendar last refreshed ${age} days ago — dates may be wrong`);
  }
  if (meta.horizonEnd && needThroughISO > meta.horizonEnd) {
    out.push(`Event calendar only runs to ${meta.horizonEnd}, short of this position's ${needThroughISO} expiry — events after that are unknown, not absent`);
  }
  return out;
}

// ── 0DTE ─────────────────────────────────────────────────────────────────────
/**
 * @param {string} todayISO  YYYY-MM-DD in ET
 * @param {number} nowMinET  minutes past midnight ET, or null to skip timing
 */
export function eventRisk0DTE(todayISO, nowMinET, cal = CALENDAR) {
  const events = eventsInWindow(todayISO, todayISO, cal);
  const notices = coverageNotices(todayISO, todayISO, cal);
  const warnings = [];

  for (const e of events) {
    const sev = severityOf(e.kind, cal);
    const t = toMin(e.time);
    const src = e.source === 'rule' ? ' [DATE INFERRED FROM A CALENDAR RULE, NOT CONFIRMED]' : '';
    const at = e.time ? ` ${e.time} ET` : '';

    if (t == null) {
      warnings.push(`${e.label} today${src} — release time unknown`);
      continue;
    }
    if (t < OPEN_MIN) {
      // Already out before the bell. This is the benign-to-useful case: the number
      // is known, and what follows is usually a wide opening range and then vol
      // collapsing as the day's uncertainty resolves.
      warnings.push(`${e.label} released${at}, before the open${src} — expect a wide opening range and then IV crush; premium sold after the open is selling into that`);
    } else if (t > CLOSE_MIN) {
      // Nothing to act on — a notice, so it does not downgrade the decision.
      notices.push(`${e.label}${at} lands after the close${src} — no 0DTE impact today`);
    } else if (nowMinET != null && t <= nowMinET) {
      notices.push(`${e.label} released${at}, already out${src} — the move is in the tape`);
    } else {
      // The one that actually matters: an event INSIDE the holding window.
      const mins = nowMinET == null ? null : t - nowMinET;
      const when = mins == null ? at
        : mins >= 60 ? `${at} (in ${(mins / 60).toFixed(1)}h)`
        : `${at} (in ${mins} min)`;
      const weight = sev === 'high'
        ? ' — pin structures need price to stop, and this is the event most likely to stop it somewhere else'
        : sev === 'medium' ? ' — expect a vol bump inside your window' : '';
      warnings.push(`${e.label}${when} lands INSIDE your window${src}${weight}`);
    }
  }
  return { warnings, notices, events };
}

// ── 45DTE ────────────────────────────────────────────────────────────────────
/**
 * What the position has to survive between entry and expiry. For a premium
 * seller the count matters more than any single date: each event is another
 * chance for vol to expand through the wings.
 */
export function eventRisk45DTE(todayISO, dte, cal = CALENDAR) {
  const expiryISO = addDays(todayISO, Math.max(0, Math.round(dte || 0)));
  const events = eventsInWindow(todayISO, expiryISO, cal);
  const notices = coverageNotices(todayISO, expiryISO, cal);
  const warnings = [];

  const high = events.filter(e => severityOf(e.kind, cal) === 'high');
  const byKind = {};
  for (const e of events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;

  if (high.length) {
    const summary = Object.entries(byKind)
      .filter(([k]) => severityOf(k, cal) === 'high')
      .map(([k, n]) => `${n}× ${k}`).join(', ');
    warnings.push(`${high.length} major event${high.length > 1 ? 's' : ''} before expiry (${summary}) — ${high.map(e => `${e.label} ${e.date}`).join('; ')}`);
  }

  // An event in the last week is the worst case for a 45DTE credit structure:
  // little time left to recover, and gamma is at its sharpest.
  const lateCutoff = addDays(expiryISO, -7);
  const late = high.filter(e => e.date >= lateCutoff);
  if (late.length) {
    warnings.push(`${late.map(e => e.label).join(', ')} falls in the final week before expiry (${late.map(e => e.date).join(', ')}) — least time to recover, sharpest gamma`);
  }

  // Provenance is a fact about the data, not about the trade — notice, not warning.
  const inferred = events.filter(e => e.source === 'rule');
  if (inferred.length) {
    notices.push(`${inferred.length} date${inferred.length > 1 ? 's' : ''} in this window ${inferred.length > 1 ? 'are' : 'is'} inferred from a calendar rule, not confirmed — verify against the official schedule`);
  }

  return { warnings, notices, events, expiryISO, highCount: high.length, byKind };
}

// ── Dashboard outlook ────────────────────────────────────────────────────────
/**
 * Today plus the next `days`, for the at-a-glance banner. Same calendar, same
 * coverage notices — a dashboard that quietly showed "no events" while holding no
 * BLS dates would be the same trap as the ticket.
 */
export function eventOutlook(todayISO, nowMinET, days = 21, cal = CALENDAR) {
  const throughISO = addDays(todayISO, days);
  const all = eventsInWindow(todayISO, throughISO, cal);
  const today = all.filter(e => e.date === todayISO);
  const upcoming = all.filter(e => e.date > todayISO);
  const t = eventRisk0DTE(todayISO, nowMinET, cal);
  return {
    today, upcoming, throughISO,
    todayWarnings: t.warnings,
    notices: coverageNotices(todayISO, throughISO, cal),
    highToday: today.some(e => severityOf(e.kind, cal) === 'high'),
    daysUntilNextHigh: (() => {
      const nxt = all.find(e => severityOf(e.kind, cal) === 'high' && e.date >= todayISO);
      return nxt ? daysBetween(todayISO, nxt.date) : null;
    })(),
    nextHigh: all.find(e => severityOf(e.kind, cal) === 'high' && e.date >= todayISO) || null,
    severityOf: k => severityOf(k, cal),
  };
}

/** Minutes past midnight in America/New_York, and today's ET date. */
export function nowET() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { dateISO: `${y}-${m}-${day}`, minutes: d.getHours() * 60 + d.getMinutes() };
}
