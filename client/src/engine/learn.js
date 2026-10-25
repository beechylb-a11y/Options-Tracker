// ── Learning from our own sessions: strike distance × exit (Oct 2026) ──
//
// The strike-distance backtest (tools/odte-spread-bt.js, tastylive's "We Tested Every
// Strike Distance") ran on two years of Yahoo bars and a modelled option price. Its
// questions — how far out to put a 0DTE credit spread's short, and whether to close at
// 25%, at 50% or hold — are the kind the shadow loop exists to answer on OUR data, with
// the engine's own inputs at the moment it looked. So every 0DTE shadow verdict now
// also settles:
//
//   exits  the verdict's OWN legs closed at 25% and at 50% of the entry premium
//          (otherwise held to the close), beside held to expiry. Any structure.
//   grid   counterfactual $-wide credit spreads, put and call side, at the study's
//          three anchors — ½ VIX1D EM, IVX EM, VIX1D EM — each closed at 25% / 50% /
//          held. Priced like the backtest (Black-Scholes, skewed), but on the ticket's
//          own remaining-session SD (the 0DTE straddle when there was one) instead of
//          a calibrated VIX1D. One per session × underlying counts (see gridTable).
//   regime trend (vs the 20-session average), 5-session return, VIX1D/VIX, from the
//          daily bars the settle pass already pulls.
//
// Like the managed outcome this is a model of an exit, not a fill: IBKR keeps no
// quotes for expired options. The path is real (the expiry day's 5-minute bars), the
// marks are modelled. Mid prices, commission $0.65 a leg a side.

import { valueAtExpiry, closeOn } from './shadow.js';
import { barTimeET, value0, commissionPerCt } from './managed.js';
import { maxLossPerCt, wilson, meanCI, MIN_N, SOLID_N } from './calibration.js';

export const LEARN_VERSION = 1;
export const ANCHORS = ['½ VIX1D', 'IVX', 'VIX1D'];
export const EXITS = ['t25', 't50', 'hold'];
export const EXIT_LABEL = { t25: 'Close at 25%', t50: 'Close at 50%', hold: 'Hold to expiry', current: 'Current rule' };
const SKEW = { putA: 0.10, putB: 0.03, callA: 0.07, callB: 0.04 };
const SQRT365 = Math.sqrt(365);
const OPEN = 9 * 60 + 30, BELL = 16 * 60, LAST_FILL = 15 * 60 + 50;
const FEE = 0.65;

// ── pricing (same model as the backtest) ──
function ncdf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
function bsPut(S, K, sd) {
  if (!(sd > 1e-9)) return Math.max(0, K - S);
  const v = sd / S, d1 = (Math.log(S / K) + 0.5 * v * v) / v;
  return K * ncdf(-(d1 - v)) - S * ncdf(-d1);
}
const bsCall = (S, K, sd) => bsPut(S, K, sd) + S - K;
/** What the short spread costs to buy back, per share, with a put/call skew. */
export function spreadValue(side, S, kShort, kLong, sdAtm) {
  const px = K => {
    const z = sdAtm > 0 ? Math.abs(Math.log(K / S)) * S / sdAtm : 0;
    const otm = side === 'put' ? K < S : K > S;
    const m = !otm ? 1 : side === 'put' ? 1 + SKEW.putA * z + SKEW.putB * z * z : Math.max(0.6, 1 - SKEW.callA * z + SKEW.callB * z * z);
    return side === 'put' ? bsPut(S, K, sdAtm * m) : bsCall(S, K, sdAtm * m);
  };
  return px(kShort) - px(kLong);
}

const stepOf = und => (['SPX', 'SPXW', 'NDX', 'NDXP', 'RUT', 'RUTW'].includes(String(und || '').toUpperCase()) ? 5 : 1);
export const creditWidthOf = (und, S) => { const st = stepOf(und); return Math.max(st, Math.round(S * 0.003 / st) * st); };

/** The day's 5-min closes from `fromMin` (exclusive) to the bell, ET minutes. */
function pathOf(bars, day, fromMin) {
  return (bars || []).map(b => ({ t: barTimeET(b.date), S: Number(b.close) }))
    .filter(x => x.t && x.t.ymd === day && x.t.min > fromMin && x.t.min <= BELL && x.S > 0)
    .sort((a, b) => a.t.min - b.t.min);
}
const hhmm = (day, min) => `${day} ${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const r0 = x => Math.round(x);

/** Regime known at entry, from daily bars before the session. */
export function regimeOf(daily, sessionYmd, S0, vix1d, vix) {
  const prior = (daily || []).map(b => ({ y: String(b.date || '').replace(/-/g, '').slice(0, 8), c: Number(b.close) }))
    .filter(x => x.y < sessionYmd && x.c > 0).sort((a, b) => (a.y < b.y ? -1 : 1));
  const last20 = prior.slice(-20);
  const sma = last20.length === 20 ? last20.reduce((a, x) => a + x.c, 0) / 20 : null;
  const c5 = prior.length >= 5 ? prior[prior.length - 5].c : null;
  return {
    trend: sma ? (S0 >= sma ? 'up' : 'down') : null,
    ret5: c5 ? Math.round((S0 / c5 - 1) * 10000) / 10000 : null,
    v1dRatio: vix1d > 0 && vix > 0 ? Math.round(vix1d / vix * 1000) / 1000 : null,
  };
}

/**
 * Everything the loop learns from one 0DTE verdict. null when the day's bars are not
 * there yet (left for the next pass).
 */
export function learnFrom(row, bars5, daily) {
  if (!row || row.engine !== '0DTE') return null;
  const inp = row.inputs || {};
  const day = String(row.expiry);
  const t0 = row.first_seen || row.last_seen;
  const d0 = t0 ? new Date(t0) : null;
  const start = d0 && !isNaN(d0) ? barTimeET(String(Math.floor(d0.getTime() / 1000))) : null;
  const from = start && start.ymd === day ? Math.max(OPEN, start.min) : OPEN;
  const all = pathOf(bars5, day, OPEN - 1);
  if (all.length < 20) return null;
  const path = all.filter(x => x.t.min > from);
  if (!path.length) return null;
  const S0 = Number(row.spot) > 0 ? Number(row.spot) : all.filter(x => x.t.min <= from).pop()?.S;
  const hours0 = Number(inp.hours) > 0 ? Number(inp.hours) : Math.max(0.25, (BELL - from) / 60);
  const sd0 = Number(inp.sdLeft) > 0 ? Number(inp.sdLeft) : Number(inp.em) > 0 ? Number(inp.em) * Math.sqrt(hours0 / 6.5) : null;
  if (!(S0 > 0) || !(sd0 > 0)) return null;
  const sdAt = min => sd0 * Math.sqrt(Math.max(0, (BELL - min) / 60) / hours0);
  const close = closeOn(daily, day) ?? all[all.length - 1].S;
  const marks = path.filter(x => x.t.min <= LAST_FILL);

  // 1. The verdict's own legs, closed at 25% / 50% of the premium or held.
  let exits = null;
  const legs = Array.isArray(row.legs) ? row.legs : [];
  const entry = Number(row.entry_net);
  if (legs.length && Number.isFinite(entry) && entry !== 0) {
    const prem = Math.abs(entry);
    const hs = Number.isFinite(Number(row.entry_half_spread)) && row.entry_half_spread !== null ? Number(row.entry_half_spread) : 0;
    const comm1 = commissionPerCt(legs, 1), comm2 = commissionPerCt(legs, 2);
    const hold = r0((valueAtExpiry(legs, close) + entry) * 100 - comm1);
    const at = pct => {
      for (const x of marks) {
        const p = value0(legs, x.S, sdAt(x.t.min)) + entry;
        if (p >= pct * prem) return { pnl: r0((p - hs) * 100 - comm2), at: hhmm(day, x.t.min) };
      }
      return { pnl: hold, at: null };
    };
    exits = { t25: at(0.25), t50: at(0.50), hold: { pnl: hold } };
  }

  // 2. Counterfactual credit spreads at the study's anchors.
  const vix1d = Number(inp.vix1d), vix = Number(inp.vix);
  const tScale = Math.min(1, Math.sqrt(hours0 / 6));
  const em1d = vix1d > 0 ? S0 * vix1d / 100 / SQRT365 * tScale : null;
  const ivx = Number(inp.ivxEM) > 0 ? Number(inp.ivxEM)
    : inp.emSource === 'straddle' ? sd0 * 0.85 / 1.2533
    : em1d ? 0.63 * em1d : sd0 * 0.85 / 1.2533;
  const dist = { '½ VIX1D': em1d ? 0.5 * em1d : null, IVX: ivx, VIX1D: em1d };
  const W = creditWidthOf(row.underlying, S0);
  const st = stepOf(row.underlying);
  const grid = [];
  for (const side of ['put', 'call']) {
    for (const a of ANCHORS) {
      const d = dist[a];
      if (!(d > 0)) continue;
      const kS = side === 'put' ? Math.floor((S0 - d) / st) * st : Math.ceil((S0 + d) / st) * st;
      const kL = side === 'put' ? kS - W : kS + W;
      const credit = spreadValue(side, S0, kS, kL, sdAt(from));
      if (!(credit > 0.05 * (W / 20))) continue;                       // nothing to sell
      const risk = (W - credit) * 100;
      const intr = side === 'put' ? Math.min(W, Math.max(0, kS - close)) : Math.min(W, Math.max(0, close - kS));
      const hold = (credit - intr) * 100 - 2 * FEE;
      const at = pct => {
        const want = credit * (1 - pct);
        for (const x of marks) {
          if (spreadValue(side, x.S, kS, kL, sdAt(x.t.min)) <= want) return (credit - want) * 100 - 4 * FEE;
        }
        return hold;
      };
      const t25 = at(0.25), t50 = at(0.50);
      grid.push({ side, anchor: a, dist: Math.round(d * 100) / 100, kS, kL, width: W, credit: Math.round(credit * 100) / 100,
        t25: r0(t25), t50: r0(t50), hold: r0(hold), risk: r0(risk) });
    }
  }

  return { v: LEARN_VERSION, exits, grid, regime: regimeOf(daily, day, S0, vix1d, vix),
    model: { S0, sd0: Math.round(sd0 * 100) / 100, ivx: Math.round(ivx * 100) / 100, width: W, close, from: hhmm(day, from) } };
}

// ═══ Reading what has been learned ═══

export const REGIMES = {
  all: { label: 'All sessions', f: () => true },
  up: { label: 'Trend up', f: g => g.trend === 'up' },
  down: { label: 'Trend down', f: g => g.trend === 'down' },
  drop: { label: 'Down >2% in 5 days', f: g => g.ret5 != null && g.ret5 < -0.02 },
  calm: { label: 'VIX1D/VIX < 0.7', f: g => g.v1dRatio != null && g.v1dRatio < 0.7 },
};

const ord = r => String(r.session_date) + String(r.first_seen || '');
/** One learned grid per session × underlying: the earliest look of the day. */
export function gridSessions(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const L = r.learn;
    if (!L || !Array.isArray(L.grid) || !L.grid.length) continue;
    const k = `${r.session_date}|${r.underlying}`;
    if (!by.has(k) || ord(r) < ord(by.get(k))) by.set(k, r);
  }
  return [...by.values()].sort((a, b) => ord(a).localeCompare(ord(b)));
}

function readOf(n, R) {
  if (n < MIN_N || !R || R.lo == null) return { tone: 'muted', text: `too few to tell (${n}, need ${MIN_N})` };
  const early = n >= SOLID_N ? '' : ' — early';
  if (R.lo > 0) return { tone: 'good', text: 'makes money' + early };
  if (R.hi < 0) return { tone: 'bad', text: 'loses money' + early };
  return { tone: 'muted', text: 'not distinguishable from zero' + early };
}
const cell = list => {
  const n = list.length;
  const R = meanCI(list.map(x => x.R));
  return { n, win: wilson(list.filter(x => x.pnl > 0).length, n), pnl: meanCI(list.map(x => x.pnl)),
    total: list.reduce((a, x) => a + x.pnl, 0), R, read: readOf(n, R) };
};

/** Counterfactual grid: side × anchor × exit over learned sessions in a regime. */
export function gridTable(rows, { regime = 'all', underlying = null } = {}) {
  const f = (REGIMES[regime] || REGIMES.all).f;
  const sess = gridSessions(rows).filter(r => (!underlying || r.underlying === underlying) && f(r.learn.regime || {}));
  const out = [];
  for (const side of ['put', 'call']) {
    for (const a of ANCHORS) {
      const cells = sess.map(r => r.learn.grid.find(g => g.side === side && g.anchor === a)).filter(Boolean);
      const row = { side, anchor: a, credit: cells.length ? cells.reduce((s, g) => s + g.credit, 0) / cells.length : null };
      for (const e of EXITS) row[e] = cell(cells.map(g => ({ pnl: g[e], R: g.risk > 0 ? g[e] / g.risk : 0 })));
      out.push(row);
    }
  }
  return { sessions: sess.length, rows: out };
}

const GROUPS = {
  'Credit spreads': s => /Bull put|Bear call/i.test(s),
  'Condors & iron flies': s => /condor|Iron butterfly/i.test(s) && !/Reversed/i.test(s),
  'Butterflies': s => /butterfly/i.test(s) && !/Iron butterfly/i.test(s),
  'Debit spreads': s => /Bull call|Bear put/i.test(s),
};
export const groupOfStrategy = s => Object.keys(GROUPS).find(k => GROUPS[k](String(s || ''))) || 'Other';

/** The verdicts' own legs: 25% / 50% / hold / current rule, in R, per structure group. */
export function exitTable(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const ex = r.learn && r.learn.exits;
    if (!ex) continue;
    const risk = maxLossPerCt(Array.isArray(r.legs) ? r.legs : [], Number(r.entry_net));
    if (!risk) continue;
    const g = groupOfStrategy(r.strategy);
    if (!by.has(g)) by.set(g, { t25: [], t50: [], hold: [], current: [] });
    const b = by.get(g);
    for (const e of EXITS) b[e].push({ pnl: ex[e].pnl, R: ex[e].pnl / risk });
    if (r.managed_at && Number.isFinite(Number(r.pnl_managed))) b.current.push({ pnl: Number(r.pnl_managed), R: Number(r.pnl_managed) / risk });
  }
  return [...by.entries()].map(([group, b]) => ({ group, t25: cell(b.t25), t50: cell(b.t50), hold: cell(b.hold), current: cell(b.current) }))
    .sort((a, b) => b.hold.n - a.hold.n);
}

/**
 * Out-of-sample proposals for the suggestions card, same discipline as suggest.js:
 * chosen on the earlier two-thirds (by date), proven on the latest third against the
 * current default. Nothing below `minN`.
 */
export function learnSuggestions(rows, { minN = 30 } = {}) {
  const out = [], waiting = [];
  const fmtR = v => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + 'R';
  const split = list => { const c = Math.floor(list.length * 2 / 3); return [list.slice(0, c), list.slice(c)]; };
  const sumR = (list, f) => list.reduce((a, x) => a + f(x), 0);

  // A. Exit for 0DTE credit spreads, on the verdicts' own legs.
  const cs = (rows || []).filter(r => r.learn && r.learn.exits && /Bull put|Bear call/i.test(String(r.strategy || '')))
    .map(r => ({ r, risk: maxLossPerCt(Array.isArray(r.legs) ? r.legs : [], Number(r.entry_net)) }))
    .filter(x => x.risk > 0).sort((a, b) => ord(a.r).localeCompare(ord(b.r)));
  if (cs.length >= minN) {
    const [tr, te] = split(cs);
    const R = (x, e) => x.r.learn.exits[e].pnl / x.risk;
    const best = EXITS.reduce((b, e) => (sumR(tr, x => R(x, e)) > sumR(tr, x => R(x, b)) ? e : b), 't25');
    const tb = sumR(te, x => R(x, best)), tc = sumR(te, x => R(x, 't25'));
    if (best !== 't25' && tb > tc) out.push({ id: 'learn-exit', tone: 'change', title: `0DTE credit spreads: ${EXIT_LABEL[best].toLowerCase()} instead of closing at 25%`,
      evidence: `Chosen on the earlier ${tr.length} credit-spread verdicts, checked on the latest ${te.length}: ${fmtR(tb)} total against ${fmtR(tc)} closing at 25%.` });
    else out.push({ id: 'learn-exit', tone: 'keep', title: 'Keep closing 0DTE credit spreads at 25% near the money',
      evidence: `No other exit beat it on the latest ${te.length} of ${cs.length} credit-spread verdicts.` });
  } else waiting.push({ what: 'Exit for 0DTE credit spreads', n: cs.length });

  // B. Where to put the short — the counterfactual grid, put side and call side.
  const sess = gridSessions(rows);
  if (sess.length >= minN) {
    const [tr, te] = split(sess);
    for (const side of ['put', 'call']) {
      const R = (r, a, e) => { const g = r.learn.grid.find(x => x.side === side && x.anchor === a); return g && g.risk > 0 ? g[e] / g.risk : 0; };
      const combos = ANCHORS.flatMap(a => EXITS.map(e => [a, e]));
      const best = combos.reduce((b, c) => (sumR(tr, r => R(r, ...c)) > sumR(tr, r => R(r, ...b)) ? c : b), ['IVX', 't25']);
      const tb = sumR(te, r => R(r, ...best)), tc = sumR(te, r => R(r, 'IVX', 't25'));
      const name = side === 'put' ? 'bull put' : 'bear call';
      if ((best[0] !== 'IVX' || best[1] !== 't25') && tb > tc) out.push({ id: 'learn-grid-' + side, tone: 'change',
        title: `0DTE ${name} spreads: short at the ${best[0]} EM, ${EXIT_LABEL[best[1]].toLowerCase()}`,
        evidence: `Picked from 9 combinations on the earlier ${tr.length} sessions; on the latest ${te.length} it made ${fmtR(tb)} against ${fmtR(tc)} for the current default (IVX EM, close at 25%). Modelled marks on the real path.` });
      else out.push({ id: 'learn-grid-' + side, tone: 'keep', title: `Keep 0DTE ${name} spreads at the IVX EM`,
        evidence: `Across ${sess.length} sessions no other anchor and exit beat it on the latest third.` });
    }
  } else waiting.push({ what: 'Credit-spread strike distance (sessions)', n: sess.length });
  return { suggestions: out, waiting };
}
