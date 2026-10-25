// ── 0DTE credit-spread strike-distance backtest (Oct 2026) ──
//
// A modelled replay of tastylive's "We Tested Every Strike Distance" study (Mar 2026)
// on data we can actually get: SPX and VIX1D hourly bars, VIX and VIX3M daily.
//
//   node tools/odte-spread-bt.js data.json            (Yahoo chart JSONs, see loadYahoo)
//   or in a browser tab: runBT(data, opts) → { text, rows }
//
// What is REAL: the SPX path (entry at 10:30 ET, hourly highs/lows, the 16:00 close)
// and the vol indices at entry. What is MODELLED: every option price. Expired 0DTE
// quotes are not obtainable, so credits and marks come from Black-Scholes on VIX1D with
// a skew. κ (VIX1D EM → remaining-session SD) and the skew are calibrated to the prices
// read out on the show (ATM $20 wide ≈ $7, $20 wide at the IVX EM ≈ $3.30–3.90), and the
// result is reported with a sensitivity run, because the absolute P&L depends on them
// and the RANKING across distances is the part worth trusting.
//
// Pure: no I/O. Works in Node and in a browser.

const SQRT365 = Math.sqrt(365), SQRT252 = Math.sqrt(252);

function ncdf(x) {
  // Abramowitz-Stegun 7.1.26
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
// Price with a TOTAL standard deviation in points (sd = S·σ·√T), r = 0.
function bsPut(S, K, sdPts) {
  if (sdPts <= 1e-9) return Math.max(0, K - S);
  const v = sdPts / S, d1 = (Math.log(S / K) + 0.5 * v * v) / v, d2 = d1 - v;
  return K * ncdf(-d2) - S * ncdf(-d1);
}
function bsCall(S, K, sdPts) { return bsPut(S, K, sdPts) + S - K; }

/** IV multiplier at z SDs out of the money (z ≥ 0), by side. */
function skewMult(z, side, sk) {
  return side === 'put' ? 1 + sk.putA * z + sk.putB * z * z
    : Math.max(0.6, 1 - sk.callA * z + sk.callB * z * z);
}
/** Value of the short spread (what it costs to buy back), per share. */
function spreadValue(side, S, kShort, kLong, sdAtm, sk) {
  const px = K => {
    const z = sdAtm > 0 ? Math.abs(Math.log(K / S)) * S / sdAtm : 0;
    const otm = side === 'put' ? K < S : K > S;
    const sd = sdAtm * (otm ? skewMult(z, side, sk) : 1);
    return side === 'put' ? bsPut(S, K, sd) : bsCall(S, K, sd);
  };
  return px(kShort) - px(kLong);
}

const ET = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  : null;
function etParts(epochSec) {
  const p = {}; for (const x of ET.formatToParts(new Date(epochSec * 1000))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}

/** Yahoo chart JSON → [{ t, day, hm, o, h, l, c }] */
function loadYahoo(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  return r.timestamp.map((t, i) => ({ t, ...etParts(t), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }))
    .filter(b => [b.o, b.h, b.l, b.c].every(v => v != null && v > 0));
}

const byDay = bars => bars.reduce((m, b) => { (m[b.day] = m[b.day] || []).push(b); return m; }, {});

/**
 * Build one record per session: entry at the 10:30 bar's open, the path after, the close,
 * and the regime flags known at entry.
 */
function sessions({ spxH, v1dH, vixD, vix3mD }) {
  const S = byDay(spxH), V = byDay(v1dH);
  const vixBy = Object.fromEntries(vixD.map(b => [b.day, b]));
  const v3By = Object.fromEntries(vix3mD.map(b => [b.day, b]));
  const days = Object.keys(S).sort();
  const closes = [];
  const out = [];
  const END = { '10:30': 11.5, '11:30': 12.5, '12:30': 13.5, '13:30': 14.5, '14:30': 15.5, '15:30': 16 };
  for (const d of days) {
    const bars = S[d].filter(b => END[b.hm]);
    const prevCloses = closes.slice(-20);
    const lastBar = S[d].find(b => b.hm === '15:30');
    if (bars.length === 6 && bars[0].hm === '10:30' && lastBar && V[d]) {
      const vb = V[d].find(b => b.hm === '10:30') || V[d].find(b => b.hm === '09:30');
      const vx = vixBy[d], v3 = v3By[d];
      if (vb && vx) {
        const sma20 = prevCloses.length === 20 ? prevCloses.reduce((a, b) => a + b, 0) / 20 : null;
        const ret5 = closes.length >= 5 ? bars[0].o / closes[closes.length - 5] - 1 : null;
        const vMarks = Object.fromEntries(V[d].map(b => [b.hm, b.c]));
        out.push({
          day: d, S0: bars[0].o, v1d: vb.o, vix: vx.o, vix3m: v3 ? v3.o : null,
          path: bars.map(b => ({ end: END[b.hm], h: b.h, l: b.l, c: b.c, v1d: vMarks[b.hm] || vb.o })),
          close: lastBar.c,
          trend: sma20 == null ? null : (bars[0].o >= sma20 ? 'up' : 'down'),
          ret5, termInverted: v3 ? vx.o >= v3.o : null,
          v1dRatio: vb.o / vx.o,
        });
      }
    }
    if (lastBar) closes.push(lastBar.c);
  }
  return out;
}

const r5 = x => Math.round(x / 5) * 5;
const floor5 = x => Math.floor(x / 5) * 5, ceil5 = x => Math.ceil(x / 5) * 5;

/** Short-strike distance in points for an anchor. */
function anchorDist(a, s, opt) {
  const em1d = s.S0 * s.v1d / 100 / SQRT365, emVix = s.S0 * s.vix / 100 / SQRT365;
  switch (a) {
    case 'ATM': return 0;
    case '½ VIX1D': return 0.5 * em1d;
    case 'VIX1D': return em1d;
    case '½ VIX': return 0.5 * emVix;
    case 'VIX': return emVix;
    case 'IVX': return opt.ivxRatio * em1d;                       // 0DTE straddle/strangle blend
    case 'Engine (VIX √252)': return s.S0 * s.vix / 100 / SQRT252;
    case 'Engine (VIX1D √252)': return s.S0 * s.v1d / 100 / SQRT252;
    default: return null;
  }
}

/** One trade. Returns P&L in $ per 1-lot, net of fees. */
function trade(s, side, dist, width, target, opt) {
  const sk = opt.skew;
  const sdAt = (v1d, hoursLeft) => opt.kappa * s.S0 * v1d / 100 / SQRT365 * Math.sqrt(Math.max(0, hoursLeft) / 6);
  const kS = side === 'put' ? floor5(s.S0 - dist) : ceil5(s.S0 + dist);
  const kL = side === 'put' ? kS - width : kS + width;
  const credit = spreadValue(side, s.S0, kS, kL, sdAt(s.v1d, 5.5), sk);
  if (!(credit > 0.05)) return null;                              // nothing to sell
  const fee1 = opt.feePerContract * 2;                            // two legs, one side
  if (target != null) {
    const want = credit * (1 - target);
    // Two looks per hourly bar, neither optimistic: the bar's best price for us valued
    // with the time left at the bar's START (no decay credited for that hour), and the
    // bar's close valued at its end. A limit at the target fills if either is through it.
    let start = 10.5;
    for (const b of s.path) {
      if (b.end >= 16) break;                                     // the last half hour: hold to the close
      const Sbest = side === 'put' ? b.h : b.l;
      const vBest = spreadValue(side, Sbest, kS, kL, sdAt(b.v1d, 16 - start), sk);
      const vEnd = b.c != null ? spreadValue(side, b.c, kS, kL, sdAt(b.v1d, 16 - b.end), sk) : Infinity;
      if (Math.min(vBest, vEnd) <= want) return { pnl: (credit - want) * 100 - 2 * fee1, credit, win: true, early: true, kS, kL };
      start = b.end;
    }
  }
  const intrinsic = side === 'put' ? Math.min(width, Math.max(0, kS - s.close)) : Math.min(width, Math.max(0, s.close - kS));
  const pnl = (credit - intrinsic) * 100 - fee1;
  return { pnl, credit, win: pnl > 0, early: false, kS, kL };
}

function stats(list) {
  const t = list.filter(Boolean);
  if (!t.length) return null;
  let cum = 0, peak = 0, dd = 0, run = 0, worstRun = 0;
  for (const x of t) {
    cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
    run = x.pnl < 0 ? run + 1 : 0; worstRun = Math.max(worstRun, run);
  }
  const wins = t.filter(x => x.pnl > 0).length;
  return { n: t.length, win: wins / t.length, avg: cum / t.length, total: cum, maxDD: dd,
    worst: Math.min(...t.map(x => x.pnl)), credit: t.reduce((a, x) => a + x.credit, 0) / t.length, worstRun };
}

const DEFAULTS = {
  kappa: 0.90, ivxRatio: 0.63, feePerContract: 0.65,
  skew: { putA: 0.10, putB: 0.03, callA: 0.07, callB: 0.04 },
  anchors: ['ATM', '½ VIX1D', 'IVX', 'VIX1D', '½ VIX', 'VIX', 'Engine (VIX √252)'],
  targets: [0.10, 0.25, 0.50, null], width: 20,
};

/** Calibration check against the prices read on the show. */
function calibrate(opt) {
  // 25 Mar 2026 ~10:00 ET: one-day EM ~70, IVX ~44 → SPX ~6590, VIX1D ≈ 70·√365/6590·100 ≈ 20.3
  const s = { S0: 6590, v1d: 20.3 };
  const sd = opt.kappa * s.S0 * s.v1d / 100 / SQRT365 * Math.sqrt(6 / 6);
  const atm = spreadValue('put', 6590, 6590, 6570, sd, opt.skew);
  const ivx = spreadValue('put', 6590, 6545, 6525, sd, opt.skew);
  return { sdRemaining: sd, atm20: atm, ivx20: ivx };
}

function runBT(data, userOpt = {}) {
  const opt = { ...DEFAULTS, ...userOpt, skew: { ...DEFAULTS.skew, ...(userOpt.skew || {}) } };
  const ss = sessions(data);
  const rows = [];
  const sides = userOpt.sides || ['put'];
  const filters = userOpt.filters || { all: () => true };
  for (const side of sides) {
    for (const [fname, f] of Object.entries(filters)) {
      const sub = ss.filter(f);
      for (const a of opt.anchors) {
        for (const tg of opt.targets) {
          const list = sub.map(s => {
            const d = anchorDist(a, s, opt);
            const w = a.startsWith('Engine') && opt.engineWidth === 'same' ? Math.max(10, r5(d)) : opt.width;
            return trade(s, side, d, w, tg, opt);
          });
          const st = stats(list);
          if (st) rows.push({ side, filter: fname, anchor: a, target: tg, ...st });
        }
      }
    }
  }
  // Realised vs modelled: is VIX1D (× κ) a fair forecast of the 10:30→16:00 move?
  const ratio = ss.length ? ss.reduce((a, s) => a + Math.abs(s.close - s.S0) / (opt.kappa * s.S0 * s.v1d / 100 / SQRT365 * Math.sqrt(5.5 / 6)), 0) / ss.length * Math.sqrt(Math.PI / 2) : null;
  return { rows, sessions: ss.length, first: ss[0] && ss[0].day, last: ss.length ? ss[ss.length - 1].day : null,
    realisedToModelSD: ratio, calib: calibrate(opt), opt };
}

function fmtRows(rows) {
  const pct = x => (x * 100).toFixed(0) + '%';
  return rows.map(r => [r.side, r.filter, r.anchor, r.target == null ? 'expiry' : pct(r.target), r.n, pct(r.win),
    r.credit.toFixed(2), Math.round(r.avg), Math.round(r.total), Math.round(r.maxDD), Math.round(r.worst), r.worstRun].join('|')).join('\n');
}

const API = { runBT, fmtRows, loadYahoo, sessions, trade, spreadValue, calibrate, anchorDist, DEFAULTS };
if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.ODTEBT = API;
