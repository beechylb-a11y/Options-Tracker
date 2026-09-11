#!/usr/bin/env node
/**
 * refresh-calendar.mjs — update client/src/engine/econ-calendar.json
 *
 *   node tools/refresh-calendar.mjs                 # refresh Fed events, keep BLS
 *   node tools/refresh-calendar.mjs --nfp-rule      # also generate NFP by first-Friday rule
 *   node tools/refresh-calendar.mjs --months 9      # horizon (default 9 months)
 *
 * WHAT IS AUTOMATED AND WHAT IS NOT
 * The Fed publishes a machine-readable calendar and it is pulled and verified here.
 * The BLS does not: bls.gov blocks automated requests, so CPI, PPI and payrolls dates
 * are typed in by hand from https://www.bls.gov/schedule/news_release/ — once or twice
 * a year, when the next year's schedule is published. This script never invents them.
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

// Keep every hand-entered BLS/BEA event; replace only what this script owns.
const manual = (prev.events || []).filter(e => e.source === 'manual');
const ruleBased = NFP_RULE ? nfpByRule(today, horizonEnd) : (prev.events || []).filter(e => e.source === 'rule');

const events = [...fed.events, ...manual, ...ruleBased]
  .filter(e => e.date >= today && e.date <= horizonEnd)
  .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

const out = {
  ...prev,
  generatedAt: today,
  horizonEnd,
  blsLoaded: manual.length > 0,
  events,
};
writeFileSync(OUT, header + 'export default ' + JSON.stringify(out, null, 2) + ';\n');

console.log(`\nWrote ${events.length} events to ${OUT}`);
console.log(`Horizon: ${today} → ${horizonEnd}`);
if (!manual.length) {
  console.log(`
⚠ No BLS dates loaded (blsLoaded:false).
  CPI, PPI, payrolls and PCE are NOT being checked. Both engines say so on every
  ticket rather than showing a clean calendar, because an empty calendar and a clear
  calendar are indistinguishable otherwise.

  To fix: open https://www.bls.gov/schedule/news_release/ and add entries with
  source:"manual" to econ-calendar.json — see _blsTemplate_DeleteWhenFilled in the file.
  BLS blocks automated requests, so this step cannot be scripted.`);
}
if (ruleBased.length) {
  console.log(`\n${ruleBased.length} rule-derived date(s) included — flagged as unconfirmed on the ticket.`);
}
