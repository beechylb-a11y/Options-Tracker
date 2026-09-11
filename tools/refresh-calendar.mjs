#!/usr/bin/env node
/**
 * refresh-calendar.mjs — update client/src/engine/econ-calendar.json
 *
 *   node tools/refresh-calendar.mjs                 # refresh Fed events, keep BLS
 *   node tools/refresh-calendar.mjs --nfp-rule      # also generate NFP by first-Friday rule
 *   node tools/refresh-calendar.mjs --months 9      # horizon (default 9 months)
 *
 * WHAT IS AUTOMATED AND WHAT IS NOT
 * Fed events come from federalreserve.gov/json/calendar.json.
 * BLS releases come from the published iCalendar feed, bls.gov/schedule/news_release/bls.ics.
 * (The HTML schedule page blocks automated requests; the .ics does not, and it is better
 * data anyway — it carries the exact release TIME, which is what decides whether a 0DTE
 * event lands before the open or inside the session.)
 *
 * PCE is BEA, not BLS, and is in neither feed. It stays a manual entry.
 *
 * HOW FOMC STATEMENTS ARE TOLD FROM MINUTES
 * The Fed feed tags both as type "FOMC" with no further distinction. But a statement
 * day appears TWICE in the feed (the meeting spans two days) while the minutes release
 * appears once, and minutes land almost exactly three weeks after the meeting. Both
 * signals are checked and must agree; anything ambiguous is written with
 * source:"fed-json-unverified" and flagged so you can eyeball it rather than trust it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// A .js module, not .json: a bare JSON import needs an import attribute under plain
// Node, so the engines would build fine under Vite and throw the moment a script
// imported them outside the bundler.
const OUT = join(HERE, '..', 'client', 'src', 'engine', 'econ-calendar.js');
const FED_URL = 'https://www.federalreserve.gov/json/calendar.json';
const BLS_URL = 'https://www.bls.gov/schedule/news_release/bls.ics';
const BEA_URL = 'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics';

// BEA publishes PCE under this name. "Personal Income and Outlays" IS the PCE release —
// the price index the Fed actually targets — and nothing in the feed says "PCE", so
// matching on the obvious word would silently find nothing.
const BEA_KINDS = {
  'Personal Income and Outlays': { kind: 'PCE', label: 'PCE (Personal Income and Outlays)' },
  'GDP (Advance Estimate)': { kind: 'GDP', label: 'GDP advance estimate' },
  'Gross Domestic Product': { kind: 'GDP', label: 'GDP' },
};

// Which BLS releases are worth a warning, and how hard. The feed carries ~270 events a
// year, the overwhelming majority of which (state and metro breakdowns, annual surveys,
// productivity revisions) never move SPX by a tick. Warning on those would bury the
// three that matter. Anything not on this list is deliberately dropped.
const BLS_KINDS = {
  'Employment Situation': { kind: 'NFP', label: 'Employment Situation (payrolls)' },
  'Consumer Price Index': { kind: 'CPI', label: 'CPI' },
  'Producer Price Index': { kind: 'PPI', label: 'PPI' },
  'Employment Cost Index': { kind: 'ECI', label: 'Employment Cost Index' },
  'Job Openings and Labor Turnover Survey': { kind: 'JOLTS', label: 'JOLTS' },
};

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const MONTHS = parseInt(argOf('--months', '9'), 10);
const NFP_RULE = args.includes('--nfp-rule');

const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

const today = iso(new Date());
const horizonEnd = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() + MONTHS); return iso(d); })();

// ── Fed ──────────────────────────────────────────────────────────────────────
async function fedEvents() {
  const res = await fetch(FED_URL, { headers: { 'User-Agent': 'options-tracker/1.0' } });
  if (!res.ok) throw new Error(`Fed calendar HTTP ${res.status}`);
  const text = await res.text();
  const data = JSON.parse(text.slice(text.indexOf('{')));

  // Flatten whatever shape the feed arrives in, keeping only FOMC rows.
  const rows = [];
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.month && n.days && n.type) rows.push(n);
      Object.values(n).forEach(walk);
    }
  };
  walk(data);

  const fomcDates = rows
    .filter(r => String(r.type).toUpperCase() === 'FOMC')
    .flatMap(r => String(r.days).split(/[^0-9]+/).filter(Boolean)
      .map(d => `${r.month}-${String(d).padStart(2, '0')}`));

  // Count occurrences: a two-day meeting is listed twice, minutes once.
  const counts = fomcDates.reduce((m, d) => (m[d] = (m[d] || 0) + 1, m), {});
  const uniq = [...new Set(fomcDates)].sort();

  const statements = uniq.filter(d => counts[d] >= 2);
  const singles = uniq.filter(d => counts[d] === 1);

  // Cross-check: a single ~21 days after a statement is that statement's minutes.
  const events = [];
  for (const d of statements) {
    events.push({ date: d, time: '14:00', kind: 'FOMC', label: 'FOMC statement', source: 'fed-json' });
  }
  const unverified = [];
  for (const d of singles) {
    const parent = statements.find(s => { const g = daysBetween(s, d); return g >= 18 && g <= 24; });
    if (parent) {
      events.push({ date: d, time: '14:00', kind: 'FOMC_MINUTES', label: 'FOMC minutes', source: 'fed-json' });
    } else {
      events.push({ date: d, time: '14:00', kind: 'FOMC', label: 'FOMC (unconfirmed — statement or minutes?)', source: 'fed-json-unverified' });
      unverified.push(d);
    }
  }
  return { events, unverified, statements: statements.length, minutes: events.filter(e => e.kind === 'FOMC_MINUTES').length };
}

// ── Shared iCalendar parser ──────────────────────────────────────────────────
// Handles both feeds, which do NOT agree on time representation:
//   BLS  DTSTART;TZID=US-Eastern:20250103T100000   already Eastern, use as-is
//   BEA  DTSTART:20260930T123000Z                  UTC, must be converted
// 12:30Z is 08:30 ET in September and 07:30 ET in December — reading the digits
// raw would report a pre-open PCE as a 12:30 intraday event, a four-hour error in
// the exact direction that matters, since the whole 0DTE distinction is whether a
// release lands before the bell or inside the position. Conversion goes through
// Intl with a real timezone so DST is handled rather than assumed.
const ET_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});
function utcToET(y, mo, d, h, mi) {
  const parts = Object.fromEntries(
    ET_PARTS.formatToParts(new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi))).map(p => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

function parseIcs(raw, kinds, source, defaultTime) {
  // RFC 5545 line folding: a continuation line begins with a space or tab and belongs
  // to the previous one. Unfold before parsing or long SUMMARY values split in half.
  const lines = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let cur = null, skipped = 0;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) { cur = {}; continue; }
    if (line.startsWith('END:VEVENT')) {
      if (cur && cur.date && cur.summary) {
        // BEA titles carry the reference period ("Personal Income and Outlays, August
        // 2026"), so match on the leading phrase rather than the whole string.
        const key = Object.keys(kinds).find(k => cur.summary === k || cur.summary.startsWith(k + ','));
        if (key) out.push({ date: cur.date, time: cur.time || defaultTime, kind: kinds[key].kind, label: kinds[key].label, source });
        else skipped++;
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const dt = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?/.exec(line);
    if (dt) {
      const [, y, mo, d, h, mi, , z] = dt;
      if (h && z) { const et = utcToET(y, mo, d, h, mi); cur.date = et.date; cur.time = et.time; }
      else { cur.date = `${y}-${mo}-${d}`; if (h) cur.time = `${h}:${mi}`; }
      continue;
    }
    if (line.startsWith('SUMMARY:')) {
      cur.summary = line.slice(8).replace(/\\,/g, ',').replace(/\\;/g, ';').trim();
    }
  }
  return { events: out, skipped };
}

async function fetchIcs(url, kinds, source, defaultTime) {
  const res = await fetch(url, { headers: { 'User-Agent': 'options-tracker/1.0' } });
  if (!res.ok) throw new Error(`${source} HTTP ${res.status}`);
  return parseIcs(await res.text(), kinds, source, defaultTime);
}

const blsEvents = () => fetchIcs(BLS_URL, BLS_KINDS, 'bls-ics', '08:30');
const beaEvents = () => fetchIcs(BEA_URL, BEA_KINDS, 'bea-ics', '08:30');

// ── NFP by rule (opt-in, explicitly marked as unconfirmed) ───────────────────
// First Friday of each month is right most of the time and wrong often enough to
// matter, so these are written with source:"rule" and the engines label them
// "[DATE INFERRED FROM A CALENDAR RULE, NOT CONFIRMED]" on the ticket.
function nfpByRule(fromISO, toISO) {
  const out = [];
  const d = new Date(fromISO + 'T00:00:00Z');
  d.setUTCDate(1);
  while (iso(d) <= toISO) {
    const probe = new Date(d);
    while (probe.getUTCDay() !== 5) probe.setUTCDate(probe.getUTCDate() + 1);
    const s = iso(probe);
    if (s >= fromISO && s <= toISO) {
      out.push({ date: s, time: '08:30', kind: 'NFP', label: 'Employment Situation (first-Friday estimate)', source: 'rule' });
    }
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
// Read the current module without importing it (import caches, and we rewrite the
// file in place). The header comment block is preserved verbatim on write.
const rawPrev = readFileSync(OUT, 'utf8');
const header = rawPrev.slice(0, rawPrev.indexOf('export default'));
const prev = JSON.parse(
  rawPrev.slice(rawPrev.indexOf('export default') + 'export default'.length).trim().replace(/;\s*$/, '')
);

let fed;
try {
  fed = await fedEvents();
  console.log(`Fed: ${fed.statements} statements, ${fed.minutes} minutes releases`);
  if (fed.unverified.length) {
    console.log(`  ⚠ ${fed.unverified.length} FOMC date(s) could not be classified: ${fed.unverified.join(', ')}`);
    console.log(`    Written as source:"fed-json-unverified" — check them against federalreserve.gov.`);
  }
} catch (e) {
  console.error(`Fed calendar fetch FAILED: ${e.message}`);
  console.error('Keeping the existing Fed events. The file has NOT been marked fresh —');
  console.error('the staleness warning will keep firing on the ticket until this succeeds.');
  process.exit(1);
}

let bls = { events: [], skipped: 0 };
let blsOk = false;
try {
  bls = await blsEvents();
  blsOk = true;
  const byKind = bls.events.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {});
  console.log(`BLS: ${bls.events.length} market-moving releases (${Object.entries(byKind).map(([k, n]) => `${n}× ${k}`).join(', ')}), ${bls.skipped} minor releases ignored`);
} catch (e) {
  console.error(`BLS feed FAILED: ${e.message}`);
  console.error('Keeping existing BLS entries. blsLoaded will reflect what is actually there,');
  console.error('so the ticket keeps saying which releases are unchecked rather than going quiet.');
}

let bea = { events: [], skipped: 0 };
let beaOk = false;
try {
  bea = await beaEvents();
  beaOk = true;
  const byKind = bea.events.reduce((m, e) => (m[e.kind] = (m[e.kind] || 0) + 1, m), {});
  console.log(`BEA: ${bea.events.length} releases (${Object.entries(byKind).map(([k, n]) => `${n}× ${k}`).join(', ')}), ${bea.skipped} minor releases ignored`);
} catch (e) {
  console.error(`BEA feed FAILED: ${e.message} — keeping existing BEA entries.`);
}

// Keep every hand-entered event (anything none of the three feeds carries).
const manual = (prev.events || []).filter(e => e.source === 'manual');
const prevBls = (prev.events || []).filter(e => e.source === 'bls-ics');
const prevBea = (prev.events || []).filter(e => e.source === 'bea-ics');
const ruleBased = NFP_RULE ? nfpByRule(today, horizonEnd) : (prev.events || []).filter(e => e.source === 'rule');

const events = [...fed.events, ...(blsOk ? bls.events : prevBls), ...(beaOk ? bea.events : prevBea), ...manual, ...ruleBased]
  .filter(e => e.date >= today && e.date <= horizonEnd)
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

// blsLoaded is derived from what actually landed in the window, never assumed: an
// empty result after a "successful" fetch still has to read as not-loaded downstream.
const blsRows = events.filter(e => e.source === 'bls-ics' || e.source === 'manual');
const fedRows = events.filter(e => e.source === 'fed-json');
const beaRows = events.filter(e => e.source === 'bea-ics');
const blsInWindow = blsRows.length;

// PER-SOURCE COVERAGE, not one asserted horizon. `horizonEnd` is only the window this
// script ASKED for; the two publishers schedule different distances ahead, and BLS in
// particular may stop well short of a 45-day option. Recording where each source
// actually runs out is what lets the ticket say "CPI is unchecked past this date"
// instead of showing an empty calendar and letting it read as a quiet stretch.
const maxDate = rows => rows.length ? rows.map(e => e.date).sort().at(-1) : null;

const out = {
  ...prev,
  generatedAt: today,
  horizonEnd,
  blsLoaded: blsInWindow > 0,
  blsThrough: maxDate(blsRows),
  fedThrough: maxDate(fedRows),
  beaThrough: maxDate(beaRows),
  events,
};
console.log(`  Fed events run to: ${out.fedThrough || '—'}`);
console.log(`  BLS events run to: ${out.blsThrough || '—'}`);
console.log(`  BEA events run to: ${out.beaThrough || '—'}`);
writeFileSync(OUT, header + 'export default ' + JSON.stringify(out, null, 2) + ';\n');

console.log(`\nWrote ${events.length} events to ${OUT}`);
console.log(`Horizon: ${today} → ${horizonEnd}`);
if (!blsInWindow) {
  console.log(`
⚠ No BLS releases landed in the window (blsLoaded:false).
  CPI, PPI and payrolls are NOT being checked, and both engines say so on every ticket
  rather than showing a clean calendar — an empty calendar and a clear calendar are
  otherwise indistinguishable.`);
} else {
  const nextCpi = events.find(e => e.kind === 'CPI');
  const nextNfp = events.find(e => e.kind === 'NFP');
  console.log(`  next CPI: ${nextCpi ? `${nextCpi.date} ${nextCpi.time} ET` : '—'}`);
  console.log(`  next NFP: ${nextNfp ? `${nextNfp.date} ${nextNfp.time} ET` : '—'}`);
}
const nextPce = events.find(e => e.kind === 'PCE');
console.log(`  next PCE: ${nextPce ? `${nextPce.date} ${nextPce.time} ET` : '— (BEA feed returned none)'}`);
if (ruleBased.length) {
  console.log(`\n${ruleBased.length} rule-derived date(s) included — flagged as unconfirmed on the ticket.`);
}
