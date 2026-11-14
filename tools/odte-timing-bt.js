// ── 0DTE credit verticals: entry time, EM basis and EMA trend (Nov 2026) ──
//
// Extends tools/odte-spread-bt.js (same option model, same caveats) to answer:
//   1. Entry time — the 09:30 open, 10:30, 11:30 or 12:30 (Yahoo hourly bars open on
//      the half hour). tastylive (Julia Spina, 26 Sep 2026): the 16Δ range is widest at
//      the open, −13–15% after the first hour, −25% after two, about half by 13:00.
//   2. EM basis — short strike from the FULL-day EM (as measured at 10:00, the study's
//      entry) or from the move REMAINING at entry (× √(hours left ÷ 6)).
//   3. Trend — daily EMA 5 / 21 / 50 stack (the tastytrade chart) known at entry:
//      put spreads, call spreads, or the side the trend points to.
//
// REAL: the SPX path from entry (hourly highs/lows, 16:00 close), VIX1D at the entry
// hour, daily closes for the EMAs. MODELLED: every option price (Black-Scholes on VIX1D
// × κ, with skew). Read rankings, not dollars.
//
// Browser: window.ODTET.run({ spxH, v1dH, spxD, vixD }, opts) → { text, rows }

(function () {
  const SQRT365 = Math.sqrt(365);
  function ncdf(x) {
    const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  }
  function bsPut(S, K, sd) { if (sd <= 1e-9) return Math.max(0, K - S); const v = sd / S, d1 = (Math.log(S / K) + 0.5 * v * v) / v; return K * ncdf(-(d1 - v)) - S * ncdf(-d1); }
  const bsCall = (S, K, sd) => bsPut(S, K, sd) + S - K;
  const SK = { putA: 0.10, putB: 0.03, callA: 0.07, callB: 0.04 };
  const skewMult = (z, side) => side === 'put' ? 1 + SK.putA * z + SK.putB * z * z : Math.max(0.6, 1 - SK.callA * z + SK.callB * z * z);
  function spreadValue(side, S, kS, kL, sdAtm) {
    const px = K => {
      const z = sdAtm > 0 ? Math.abs(Math.log(K / S)) * S / sdAtm : 0;
      const otm = side === 'put' ? K < S : K > S;
      const sd = sdAtm * (otm ? skewMult(z, side) : 1);
      return side === 'put' ? bsPut(S, K, sd) : bsCall(S, K, sd);
    };
    return px(kS) - px(kL);
  }
  const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const et = t => { const p = {}; for (const x of ET.formatToParts(new Date(t * 1000))) p[x.type] = x.value; return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` }; };
  function loadYahoo(j) {
    const r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) return [];
    const q = r.indicators.quote[0];
    return r.timestamp.map((t, i) => ({ t, ...et(t), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] })).filter(b => [b.o, b.h, b.l, b.c].every(v => v != null && v > 0));
  }
  const byDay = bars => bars.reduce((m, b) => { (m[b.day] = m[b.day] || []).push(b); return m; }, {});
  const HM = ['09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:30'];
  const START = { '09:30': 9.5, '10:30': 10.5, '11:30': 11.5, '12:30': 12.5, '13:30': 13.5, '14:30': 14.5, '15:30': 15.5 };

  // EMA of daily closes; returns the value after each close.
  function emaSeries(closes, n) { const k = 2 / (n + 1); const out = []; let e = null; for (const c of closes) { e = e == null ? c : c * k + e * (1 - k); out.push(e); } return out; }

  function sessions({ spxH, v1dH, spxD, vixD }) {
    const S = byDay(spxH), V = byDay(v1dH);
    const vixBy = Object.fromEntries(vixD.map(b => [b.day, b]));
    const dDays = spxD.map(b => b.day), dClose = spxD.map(b => b.c);
    const e5 = emaSeries(dClose, 5), e21 = emaSeries(dClose, 21), e50 = emaSeries(dClose, 50);
    const idxOf = Object.fromEntries(dDays.map((d, i) => [d, i]));
    const out = [];
    for (const d of Object.keys(S).sort()) {
      const bars = HM.map(hm => S[d].find(b => b.hm === hm));
      if (bars.some(b => !b) || !V[d] || !vixBy[d]) continue;
      const i = idxOf[d];
      if (i == null || i < 60) continue;                       // EMA50 warm-up
      // EMAs as of yesterday's close (what the chart shows before today's bar settles)
      const E5 = e5[i - 1], E21 = e21[i - 1], E50 = e50[i - 1];
      const ema = E5 > E21 && E21 > E50 ? 'up' : E5 < E21 && E21 < E50 ? 'down' : 'mixed';
      const v1d = Object.fromEntries(HM.map(hm => { const b = V[d].find(x => x.hm === hm); return [hm, b ? b.o : null]; }));
      out.push({ day: d, bars, v1d, close: bars[6].c, open: bars[0].o, ema, E21, ret5: dClose[i - 1] / dClose[i - 6] - 1, vix: vixBy[d].o });
    }
    return out;
  }

  const floor5 = x => Math.floor(x / 5) * 5, ceil5 = x => Math.ceil(x / 5) * 5;

  // How the priced range shrinks through the day: tastylive's median 16Δ range vs the
  // open (Julia Spina, 26 Sep 2026) — −14% after 1 h, −25% after 2 h, −35% after 3 h,
  // half by 13:00. VIX1D × √(hours left) shrinks far slower (−8 / −14 / −20%), because
  // VIX1D leans on next-day options as the day goes on; pricing off it made late entries
  // look rich. h = hours since 09:30.
  function rangeLeft(h) {
    const pts = [[0, 1], [1, 0.86], [2, 0.75], [3, 0.655], [3.5, 0.5]];
    if (h >= 6.5) return 0;
    if (h > 3.5) return 0.5 * Math.sqrt((6.5 - h) / 3);
    for (let i = 1; i < pts.length; i++) { const [a, fa] = pts[i - 1], [b, fb] = pts[i]; if (h <= b) return fa + (fb - fa) * (h - a) / (b - a); }
    return 0.5;
  }

  // One $W-wide credit spread entered at hm. anchor: '½ VIX1D' | 'IVX' | 'VIX1D'. basis: 'full' | 'remaining'.
  // Vol level: VIX1D at 10:30 for every entry (its intraday drift is the artefact above).
  function trade(s, side, hm, anchor, basis, target, o) {
    const e = HM.indexOf(hm), S0 = s.bars[e].o, v1d = s.v1d['10:30'] || s.v1d['09:30'];
    if (!v1d) return null;
    const h0 = START[hm] - 9.5;
    const em1d = S0 * v1d / 100 / SQRT365;                      // tastytrade one-day EM (÷√365)
    const mult = anchor === '½ VIX1D' ? 0.5 : anchor === 'IVX' ? o.ivxRatio : 1;
    // full = the size measured at the study's 10:00 entry; remaining = moved along the curve to now
    const dist = mult * em1d * (basis === 'remaining' ? rangeLeft(h0) / rangeLeft(0.5) : 1);
    const kS = side === 'put' ? floor5(S0 - dist) : ceil5(S0 + dist);
    const kL = side === 'put' ? kS - o.width : kS + o.width;
    // remaining SD calibrated at 10:30 to the October replay (κ·EM·√(5.5/6)), then the curve
    const base = o.kappa * em1d * Math.sqrt(5.5 / 6) / rangeLeft(1);
    const sdAt = h => base * rangeLeft(h);
    const credit = spreadValue(side, S0, kS, kL, sdAt(h0));
    if (!(credit > 0.05)) return null;
    const fee1 = o.fee * 2;
    if (target != null) {
      const want = credit * (1 - target);
      let st = h0;
      for (let j = e; j < 6; j++) {                             // last half hour: hold to the close
        const b = s.bars[j], end = START[HM[j + 1]] - 9.5;
        const vBest = spreadValue(side, side === 'put' ? b.h : b.l, kS, kL, sdAt(st));
        const vEnd = spreadValue(side, b.c, kS, kL, sdAt(end));
        if (Math.min(vBest, vEnd) <= want) return { pnl: (credit - want) * 100 - 2 * fee1, credit, dist, early: true };
        st = end;
      }
    }
    const intr = side === 'put' ? Math.min(o.width, Math.max(0, kS - s.close)) : Math.min(o.width, Math.max(0, s.close - kS));
    return { pnl: (credit - intr) * 100 - fee1, credit, dist, early: false, breach: intr > 0 };
  }

  function stats(list) {
    const t = list.filter(Boolean); if (!t.length) return null;
    let cum = 0, peak = 0, dd = 0, run = 0, wr = 0;
    for (const x of t) { cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); run = x.pnl < 0 ? run + 1 : 0; wr = Math.max(wr, run); }
    return { n: t.length, win: t.filter(x => x.pnl > 0).length / t.length, avg: cum / t.length, maxDD: dd, worst: Math.min(...t.map(x => x.pnl)),
      credit: t.reduce((a, x) => a + x.credit, 0) / t.length, dist: t.reduce((a, x) => a + x.dist, 0) / t.length, worstRun: wr };
  }

  function run(raw, user = {}) {
    const o = { kappa: 0.9, ivxRatio: 0.63, width: 20, fee: 0.65, ...user };
    const data = { spxH: loadYahoo(raw.spxH), v1dH: loadYahoo(raw.v1dH), spxD: loadYahoo(raw.spxD), vixD: loadYahoo(raw.vixD) };
    const ss = sessions(data);
    const rows = [];
    const add = (tag, list) => { const st = stats(list); if (st) rows.push({ tag, ...st }); };
    const T = [0.25, 0.5, null];
    // A. Entry time × basis × anchor (puts and calls, all days)
    for (const side of ['put', 'call']) for (const hm of ['09:30', '10:30', '11:30', '12:30']) for (const basis of ['remaining', 'full']) for (const a of ['½ VIX1D', 'IVX']) for (const tg of T)
      add(`A|${side}|${hm}|${basis}|${a}|${tg == null ? 'exp' : tg * 100 + '%'}`, ss.map(s => trade(s, side, hm, a, basis, tg, o)));
    // B. EMA trend split at 10:30, IVX remaining
    const pick = { with: s => s.ema === 'up' ? 'put' : s.ema === 'down' ? 'call' : null, against: s => s.ema === 'up' ? 'call' : s.ema === 'down' ? 'put' : null };
    for (const hm of ['10:30', '11:30']) for (const a of ['½ VIX1D', 'IVX', 'VIX1D']) for (const tg of T) {
      const tl = tg == null ? 'exp' : tg * 100 + '%';
      for (const reg of ['up', 'down', 'mixed']) for (const side of ['put', 'call'])
        add(`B|${hm}|${a}|${tl}|ema ${reg}|${side}`, ss.filter(s => s.ema === reg).map(s => trade(s, side, hm, a, 'remaining', tg, o)));
      for (const [k, f] of Object.entries(pick)) add(`B|${hm}|${a}|${tl}|${k}-trend|side`, ss.map(s => { const sd = f(s); return sd ? trade(s, sd, hm, a, 'remaining', tg, o) : null; }));
    }
    // C. Model-light: the move left vs what VIX1D priced, by entry hour; and how the 1-SD range shrinks
    const light = ['09:30', '10:30', '11:30', '12:30', '13:30'].map(hm => {
      const e = HM.indexOf(hm), left = 16 - START[hm];
      let r = 0, n = 0, sz = 0;
      for (const s of ss) { const v = s.v1d[hm]; if (!v) continue; const S0 = s.bars[e].o; const sd = S0 * v / 100 / SQRT365 * Math.sqrt(left / 6.5);
        r += Math.abs(s.close - S0) / sd; sz += (v / s.v1d['09:30']) * Math.sqrt(left / 6.5); n++; }
      return { hm, n, realisedToImplied: r / n * Math.sqrt(Math.PI / 2), rangeVsOpen: sz / n };
    });
    const regimes = ['up', 'down', 'mixed'].map(k => ({ k, n: ss.filter(s => s.ema === k).length }));
    return { sessions: ss.length, first: ss[0] && ss[0].day, last: ss.length ? ss[ss.length - 1].day : null, rows, light, regimes, o };
  }
  const fmt = rows => rows.map(r => [r.tag, r.n, (r.win * 100).toFixed(0) + '%', r.credit.toFixed(2), r.dist.toFixed(0), Math.round(r.avg), Math.round(r.worst), Math.round(r.maxDD), r.worstRun].join('|')).join('\n');
  const api = { run, fmt, loadYahoo, sessions, trade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ODTET = api;
})();
