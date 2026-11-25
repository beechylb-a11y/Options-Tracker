// ── Are the engine's numbers honest? (Nov 2026, review recommendation 2) ──
//
// The engine puts three numbers on every ticket: the chance of a win, the chance of the
// full max loss and the EV per contract. Shadow verdicts keep each one with what the
// ticket went on to make, so each can be checked against reality:
//
//  - win chance and chance of max loss: a reliability curve (what it said vs how often
//    it happened, in equal-count groups) and the Brier skill score — how much better the
//    engine's probabilities are than quoting the overall rate on every ticket.
//  - EV: what it said vs what was made, in equal-count groups, and whether a higher EV
//    went on to make more (rank correlation).
//
// Verdicts from one session move together (same tape), so every range here comes from a
// bootstrap that resamples whole sessions, not single tickets. Nothing changes the engine:
// it is a read for Vasa.

import { outcomeOf, wilson, meanCI } from './calibration.js';

export const MIN_LOOKS = 30;      // below this the scores are not read
export const MIN_SESSIONS = 5;    // ...or with fewer sessions than this
const REPS = 1000;

/** Which outcome each engine's numbers describe. 0DTE: held to the close (POP is at
 *  expiry). 45DTE: the managed exit (POP is "closed at target or 21 DTE"). Max loss is
 *  at expiry for both. */
export const OUTCOME = { '0DTE': 'held', '45DTE': 'managed' };

const isNum = v => v !== null && v !== '' && Number.isFinite(Number(v));

/** Small seeded generator so the ranges don't move between renders. */
export function rng(seed = 7) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Shadow rows → pairs for one number.
 * kind 'win'      → { p, y, s }  p = POP 0–1, y = 1 if it made money
 * kind 'maxLoss'  → { p, y, s }  p = P(max loss), y = 1 if held to expiry it lost ≥ 95% of max loss
 * kind 'ev'       → { x, v, s }  x = EV per contract, v = $ made per contract
 * s is the session, for the bootstrap.
 */
export function pairsFor(rows, kind, engine) {
  const out = [];
  for (const r of rows || []) {
    if (engine && r.engine !== engine) continue;
    const s = r.session_date || 'unknown';
    if (kind === 'win') {
      if (!isNum(r.pop)) continue;
      const o = outcomeOf(r, OUTCOME[r.engine] || 'held');
      if (!o) continue;
      let p = Number(r.pop);
      p = p > 1 ? p / 100 : p;                       // stored as percent
      out.push({ p: Math.min(1, Math.max(0, p)), y: o.win ? 1 : 0, s });
    } else if (kind === 'maxLoss') {
      if (!isNum(r.p_max_loss)) continue;
      const o = outcomeOf(r, 'held');
      if (!o || o.R == null) continue;
      let p = Number(r.p_max_loss);
      p = p > 1 ? p / 100 : p;                       // stored as a fraction
      out.push({ p: Math.min(1, Math.max(0, p)), y: o.R <= -0.95 ? 1 : 0, s });
    } else if (kind === 'ev') {
      if (!isNum(r.ev)) continue;
      const o = outcomeOf(r, OUTCOME[r.engine] || 'held');
      if (!o) continue;
      out.push({ x: Number(r.ev), v: o.pnl, s });
    }
  }
  return out;
}

/** Equal-count groups along `key`: about 15 per group, 2 to 6 groups. */
export function equalGroups(pairs, key) {
  const n = pairs.length;
  if (!n) return [];
  const k = Math.max(1, Math.min(6, Math.floor(n / 15) || 1, n));
  const sorted = [...pairs].sort((a, b) => a[key] - b[key]);
  const groups = [];
  for (let i = 0; i < k; i++) {
    const g = sorted.slice(Math.round(i * n / k), Math.round((i + 1) * n / k));
    if (g.length) groups.push(g);
  }
  return groups;
}

function probStats(pairs) {
  const n = pairs.length;
  if (!n) return null;
  let sp = 0, sy = 0, sb = 0;
  for (const q of pairs) { sp += q.p; sy += q.y; sb += (q.p - q.y) ** 2; }
  const said = sp / n, rate = sy / n, brier = sb / n, ref = rate * (1 - rate);
  return { n, said, rate, brier, ref, skill: ref > 0 ? 1 - brier / ref : null, bias: said - rate };
}

/** Resample whole sessions REPS times; returns the 2.5% and 97.5% points of each stat. */
export function sessionBootstrap(pairs, stat, keys, seed = 7) {
  const bySession = new Map();
  for (const q of pairs) { if (!bySession.has(q.s)) bySession.set(q.s, []); bySession.get(q.s).push(q); }
  const sessions = [...bySession.values()];
  if (sessions.length < 2) return null;
  const rand = rng(seed);
  const draws = Object.fromEntries(keys.map(k => [k, []]));
  for (let i = 0; i < REPS; i++) {
    const sample = [];
    for (let j = 0; j < sessions.length; j++) sample.push(...sessions[Math.floor(rand() * sessions.length)]);
    const st = stat(sample);
    if (!st) continue;
    for (const k of keys) if (Number.isFinite(st[k])) draws[k].push(st[k]);
  }
  const pct = (xs, q) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))]; };
  return Object.fromEntries(keys.map(k => [k, { lo: pct(draws[k], 0.025), hi: pct(draws[k], 0.975) }]));
}

const pct0 = v => `${Math.round(v * 100)}%`;
const pctSmall = v => (v > 0 && v < 0.01 ? 'under 1%' : `about ${pct0(v)}`);
const pts = v => `${Math.abs(Math.round(v * 100))} pts`;

/**
 * Reliability of one probability ('win' or 'maxLoss').
 * @returns null with no pairs, else
 *   { n, sessions, said, rate, brier, ref, skill, bias, ci: { skill, bias }, groups: [{ n, said, rate, ci }], read: { tone, text }, enough }
 */
export function reliability(pairs, kind = 'win') {
  const all = probStats(pairs);
  if (!all) return null;
  const sessions = new Set(pairs.map(q => q.s)).size;
  const enough = all.n >= MIN_LOOKS && sessions >= MIN_SESSIONS;
  const ci = sessionBootstrap(pairs, probStats, ['skill', 'bias']);
  const groups = equalGroups(pairs, 'p').map(g => {
    const k = g.reduce((a, q) => a + q.y, 0);
    const said = g.reduce((a, q) => a + q.p, 0) / g.length, ci = wilson(k, g.length);
    // A group misses when what it said sits outside the 95% range of what happened.
    const off = g.length >= 10 && ci && (said < ci.lo || said > ci.hi);
    return { n: g.length, k, said, rate: k / g.length, ci, off };
  });
  return { ...all, sessions, enough, ci, groups, read: readProb(kind, { ...all, sessions, enough, ci, groups }) };
}

function readProb(kind, r) {
  const what = kind === 'win' ? 'a win' : 'the full max loss';
  if (!r.enough) return { tone: 'muted', text: `Too few to read: ${r.n} settled over ${r.sessions} session${r.sessions === 1 ? '' : 's'} (need ${MIN_LOOKS} over ${MIN_SESSIONS}).` };
  const parts = [];
  const sk = r.ci && r.ci.skill;
  let tone = 'muted';
  if (sk && sk.lo != null && sk.lo > 0) { tone = 'good'; parts.push(`Its chance of ${what} sorts tickets better than quoting ${pct0(r.rate)} on every one.`); }
  else if (sk && sk.hi != null && sk.hi < 0) { tone = 'bad'; parts.push(`Its chance of ${what} does worse than quoting ${pct0(r.rate)} on every ticket: the number misleads.`); }
  else parts.push(`Its chance of ${what} is not yet better than quoting ${pct0(r.rate)} on every ticket.`);
  const b = r.ci && r.ci.bias;
  // Half a point either way is rounding, not a lean.
  if (b && b.lo != null && b.lo > 0.005) { parts.push(`It says ${pts(r.bias)} too high on average (said ${pct0(r.said)}, happened ${pct0(r.rate)}).`); if (tone === 'good') tone = 'warn'; }
  else if (b && b.hi != null && b.hi < -0.005) { parts.push(`It says ${pts(r.bias)} too low on average (said ${pct0(r.said)}, happened ${pct0(r.rate)}).`); if (tone === 'good') tone = 'warn'; }
  else parts.push(`On average it is on target within the noise (said ${pct0(r.said)}, happened ${pct0(r.rate)}).`);
  // Name the group that misses worst, even when the average is on target.
  const miss = (r.groups || []).filter(g => g.off).sort((a, b) => Math.abs(b.said - b.rate) - Math.abs(a.said - a.rate))[0];
  if (miss) {
    parts.push(`Where it said ${pctSmall(miss.said)}, it happened ${miss.k} of ${miss.n} times (${pct0(miss.rate)}).`);
    if (tone === 'good' || tone === 'muted') tone = 'warn';
  }
  return { tone, text: parts.join(' ') };
}

/** Spearman rank correlation, ties averaged. */
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = a => {
    const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    for (let i = 0; i < n;) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const m = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (rx[i] - m) * (ry[i] - m); dx += (rx[i] - m) ** 2; dy += (ry[i] - m) ** 2; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

function evStats(pairs) {
  const n = pairs.length;
  if (!n) return null;
  const said = pairs.reduce((a, q) => a + q.x, 0) / n, made = pairs.reduce((a, q) => a + q.v, 0) / n;
  return { n, said, made, gap: made - said, rho: spearman(pairs.map(q => q.x), pairs.map(q => q.v)) };
}

/** EV said vs made. Same shape as reliability(), groups carry { n, said, made, ci }. */
export function evCheck(pairs) {
  const all = evStats(pairs);
  if (!all) return null;
  const sessions = new Set(pairs.map(q => q.s)).size;
  const enough = all.n >= MIN_LOOKS && sessions >= MIN_SESSIONS;
  const ci = sessionBootstrap(pairs, evStats, ['gap', 'rho', 'made']);
  const groups = equalGroups(pairs, 'x').map(g => ({
    n: g.length, said: g.reduce((a, q) => a + q.x, 0) / g.length,
    made: g.reduce((a, q) => a + q.v, 0) / g.length, ci: meanCI(g.map(q => q.v)),
  }));
  return { ...all, sessions, enough, ci, groups, read: readEv({ ...all, sessions, enough, ci }) };
}

const usd = v => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v)).toLocaleString('en-US');
function readEv(r) {
  if (!r.enough) return { tone: 'muted', text: `Too few to read: ${r.n} settled over ${r.sessions} session${r.sessions === 1 ? '' : 's'} (need ${MIN_LOOKS} over ${MIN_SESSIONS}).` };
  const parts = [];
  let tone = 'muted';
  const rho = r.ci && r.ci.rho;
  if (rho && rho.lo != null && rho.lo > 0) { tone = 'good'; parts.push('Tickets with a higher EV went on to make more.'); }
  else if (rho && rho.hi != null && rho.hi < 0) { tone = 'bad'; parts.push('Tickets with a higher EV went on to make less: the ranking is backwards.'); }
  else parts.push('A higher EV has not yet gone on to make more: the ranking is within the noise.');
  const g = r.ci && r.ci.gap;
  if (g && g.lo != null && g.lo > 0) parts.push(`It reads low: said ${usd(r.said)}, made ${usd(r.made)} a contract.`);
  else if (g && g.hi != null && g.hi < 0) { parts.push(`It reads high: said ${usd(r.said)}, made ${usd(r.made)} a contract.`); if (tone === 'good') tone = 'warn'; }
  else parts.push(`Level within the noise: said ${usd(r.said)}, made ${usd(r.made)} a contract.`);
  return { tone, text: parts.join(' ') };
}

/** Everything the panel shows for one engine. */
export function honesty(rows, engine) {
  return {
    engine,
    outcome: OUTCOME[engine] || 'held',
    win: reliability(pairsFor(rows, 'win', engine), 'win'),
    maxLoss: reliability(pairsFor(rows, 'maxLoss', engine), 'maxLoss'),
    ev: evCheck(pairsFor(rows, 'ev', engine)),
  };
}
