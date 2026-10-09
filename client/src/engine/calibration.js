// ── Calibration over shadow verdicts (Oct 2026) ──
//
// Step 2 of the learning loop. Settled verdicts grouped by what the engine said —
// which blocker, which edge-score band, which gamma move-cost band, the verdict word,
// EV sign, strategy — with what they went on to make. The question for every gate:
// does what it stops lose money, and do higher scores actually do better?
//
// Outcomes are in R (P&L ÷ max loss per contract) so an SPX condor and an XSP fly
// average on one scale, with $/contract alongside. Every figure carries its sample
// size and a 95% interval; nothing here is read as a finding below MIN_N.

import { valueAtExpiry } from './shadow.js';

export const MIN_N = 10;          // below this a group is "too few to tell"
export const SOLID_N = 30;        // from here the read is labelled solid

/** Worst case per contract held to expiry, from the legs and entry; null if unbounded. */
export function maxLossPerCt(legs, entryNet) {
  if (!Array.isArray(legs) || !legs.length || !Number.isFinite(entryNet)) return null;
  const ks = legs.map(l => l.strike);
  const hi = Math.max(...ks), lo = Math.min(...ks);
  const pts = [0, lo, ...ks, hi, hi * 2, hi * 4];
  const pnl = S => (valueAtExpiry(legs, S) + entryNet) * 100;
  const vals = pts.map(pnl);
  // Still falling past 2x the top strike means an uncovered short: no defined max loss.
  if (pnl(hi * 4) < pnl(hi * 2) - 1e-6) return null;
  const worst = Math.min(...vals);
  return worst < 0 ? -worst : null;
}

/** One settled row → { r, pnl, R, win } or null. */
export function outcomeOf(row) {
  if (!row || !row.settled_at) return null;
  const pnl = Number(row.pnl_per_ct);
  if (!Number.isFinite(pnl)) return null;
  const risk = maxLossPerCt(Array.isArray(row.legs) ? row.legs : [], Number(row.entry_net));
  return { row, pnl, R: risk ? pnl / risk : null, win: pnl > 0 };
}

export function wilson(k, n, z = 1.96) {
  if (!n) return null;
  const p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / d;
  return { p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function meanCI(xs, z = 1.96) {
  const v = xs.filter(Number.isFinite);
  const n = v.length;
  if (!n) return null;
  const m = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { m, lo: null, hi: null, n };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
  const h = z * sd / Math.sqrt(n);
  return { m, lo: m - h, hi: m + h, n };
}

/** Blocker text without its numbers, so one gate is one group. */
export function blockerKey(b) {
  return String(b || '').split(' — ')[0].replace(/[-+]?\$?\d+(\.\d+)?%?/g, '#').replace(/\s+/g, ' ').trim().slice(0, 70);
}

const band = (x, edges, labels) => {
  if (!Number.isFinite(x)) return null;
  for (let i = 0; i < edges.length; i++) if (x < edges[i]) return labels[i];
  return labels[labels.length - 1];
};
export const DIMENSIONS = {
  category: { label: 'Verdict', keys: r => [({ taken: 'Taken', trade: 'Said trade, not taken', pass: 'Said pass', blocked: 'Blocked', unsized: 'Not sized' })[r.category] || r.category] },
  blocker: { label: 'Blocker', keys: r => r.category === 'blocked' || (r.blockers && r.category === 'taken')
    ? String(r.blockers || '').split(';').map(s => s.trim()).filter(Boolean).map(blockerKey) : [] },
  edge: { label: 'Edge score', order: ['< 40', '40–55', '55–70', '70–85', '85+'],
    keys: r => [band(Number(r.edge_score), [40, 55, 70, 85], ['< 40', '40–55', '55–70', '70–85', '85+'])].filter(Boolean) },
  moveCost: { label: 'Gamma move cost', order: ['< 0.8', '0.8–1.25', '1.25–2', '2+'],
    keys: r => [band(Number(r.move_cost), [0.8, 1.25, 2], ['< 0.8', '0.8–1.25', '1.25–2', '2+'])].filter(Boolean) },
  ev: { label: 'EV sign', keys: r => (r.ev == null || r.ev === '') ? [] : [Number(r.ev) > 0 ? 'EV > 0' : 'EV ≤ 0'] },
  strategy: { label: 'Strategy', keys: r => r.strategy ? [String(r.strategy)] : [] },
  underlying: { label: 'Underlying', keys: r => r.underlying ? [String(r.underlying)] : [] },
};

/**
 * Group settled verdicts along one dimension.
 * @param rows   shadow rows (settled and not)
 * @param dim    a key of DIMENSIONS
 * @param filter { engine: '0DTE'|'45DTE'|null, entry: 'ticket'|null }
 */
export function calibrate(rows, dim, filter = {}) {
  const D = DIMENSIONS[dim];
  if (!D) return [];
  const keep = (rows || []).filter(r => (!filter.engine || r.engine === filter.engine)
    && (!filter.entry || r.entry_source === filter.entry));
  const groups = new Map();
  for (const r of keep) {
    for (const k of D.keys(r)) {
      if (!groups.has(k)) groups.set(k, { key: k, recorded: 0, out: [] });
      const g = groups.get(k);
      g.recorded++;
      const o = outcomeOf(r);
      if (o) g.out.push(o);
    }
  }
  const list = [...groups.values()].map(g => {
    const n = g.out.length, wins = g.out.filter(o => o.win).length;
    const Rs = g.out.map(o => o.R).filter(Number.isFinite);
    return {
      key: g.key, recorded: g.recorded, n,
      winRate: wilson(wins, n),
      R: meanCI(Rs),
      pnl: meanCI(g.out.map(o => o.pnl)),
      total: g.out.reduce((a, o) => a + o.pnl, 0),
      read: readOf(dim, n, meanCI(Rs)),
    };
  });
  const order = D.order;
  return order ? list.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key)) : list.sort((a, b) => b.n - a.n || b.recorded - a.recorded);
}

/** Plain words for one group's result. For a blocker, losing trades blocked is good. */
export function readOf(dim, n, R) {
  if (n < MIN_N || !R || R.lo == null) return { tone: 'muted', text: `too few to tell (${n} settled, need ${MIN_N})` };
  const solid = n >= SOLID_N ? '' : ' — early';
  if (dim === 'blocker') {
    if (R.hi < 0) return { tone: 'good', text: 'doing its job: what it blocks loses' + solid };
    if (R.lo > 0) return { tone: 'bad', text: 'blocking winners: what it stops makes money' + solid };
    return { tone: 'muted', text: 'unclear: blocked trades break even within the noise' + solid };
  }
  if (R.lo > 0) return { tone: 'good', text: 'makes money' + solid };
  if (R.hi < 0) return { tone: 'bad', text: 'loses money' + solid };
  return { tone: 'muted', text: 'not distinguishable from zero' + solid };
}

/** Headline comparisons: blocked vs allowed, and whether edge score sorts outcomes. */
export function headlines(rows, filter = {}) {
  const cat = calibrate(rows, 'category', filter);
  const get = k => cat.find(g => g.key === k);
  const allowedOut = (rows || []).filter(r => (r.category === 'taken' || r.category === 'trade')
    && (!filter.engine || r.engine === filter.engine) && (!filter.entry || r.entry_source === filter.entry))
    .map(outcomeOf).filter(Boolean);
  const allowedR = meanCI(allowedOut.map(o => o.R).filter(Number.isFinite));
  const blocked = get('Blocked');
  const edge = calibrate(rows, 'edge', filter).filter(g => g.n >= MIN_N && g.R);
  let monotone = null;
  if (edge.length >= 3) {
    const ms = edge.map(g => g.R.m);
    monotone = ms.every((m, i) => i === 0 || m >= ms[i - 1] - 0.02);
  }
  return {
    blocked: blocked && blocked.R ? { n: blocked.n, R: blocked.R.m } : null,
    allowed: allowedR ? { n: allowedR.n, R: allowedR.m } : null,
    edgeMonotone: monotone,
    edgeBands: edge.length,
  };
}
