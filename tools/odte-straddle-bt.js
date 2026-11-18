// ── 0DTE short straddle + 30-day long strangle vs $30 iron fly (Nov 2026) ──
//
// A modelled replay of tastylive's "How To Manage 0DTE Losers" (31 Jan 2024):
//   A. sell the 0DTE ATM straddle, buy a ~30-day strangle at the 30-day expected move
//   B. a $30-wide 0DTE iron fly (sell the straddle, buy ±$30 wings)
// with winners left to the close and losers managed by: nothing, a midday close
// (12:30 / 13:30 ET bracket the study's noon CT), closing only losers at 13:30, or a stop
// at 50 / 100 / 150 / 200% of the straddle credit.
//
// REAL: the SPX path (hourly highs/lows from 10:30, the 16:00 close), VIX1D at entry, VIX
// hourly (the 30-day vol the long strangle is marked on — real vol-spike days included),
// VIX3M and daily SPX for regimes. MODELLED: every option price. 0DTE: Black-Scholes on
// VIX1D × κ moved through the day on tastylive's measured range curve (as in
// odte-timing-bt.js), scaled by the VIX move since entry ^ shockBeta (0DTE vol moves more
// than 30-day vol). 30-day strangle: Black-Scholes on VIX × atm30 with a put/call skew.
// Read rankings, not dollars.
//
// Browser: window.ODTESTR.run({ spxH, v1dH, vixH, vixD, vix3mD, spxD }, opts) → { rows, ... }

(function () {
  const SQRT365 = Math.sqrt(365);
  function ncdf(x) {
    const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
    return 0.5 * (1 + s * y);
  }
  // total SD in points, r = 0
  function bsPut(S, K, sd) { if (sd <= 1e-9) return Math.max(0, K - S); const v = sd / S, d1 = (Math.log(S / K) + 0.5 * v * v) / v; return K * ncdf(-(d1 - v)) - S * ncdf(-d1); }
  const bsCall = (S, K, sd) => bsPut(S, K, sd) + S - K;
  const SK0 = { putA: 0.10, putB: 0.03, callA: 0.07, callB: 0.04 };   // 0DTE (same as the other replays)
  const SK30 = { putA: 0.12, putB: 0.02, callA: 0.10, callB: 0.03 };  // 30-day
  const mult = (z, side, sk) => side === 'P' ? 1 + sk.putA * z + sk.putB * z * z : Math.max(0.6, 1 - sk.callA * z + sk.callB * z * z);
  // one option, IV from the ATM SD with skew by moneyness
  function opt(side, S, K, sdAtm, sk) {
    const z = sdAtm > 0 ? Math.abs(Math.log(K / S)) * S / sdAtm : 0;
    const otm = side === 'P' ? K < S : K > S;
    const sd = sdAtm * (otm ? mult(z, side, sk) : 1);
    return side === 'P' ? bsPut(S, K, sd) : bsCall(S, K, sd);
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
  const HM = ['10:30', '11:30', '12:30', '13:30', '14:30', '15:30'];
  const END = { '10:30': 11.5, '11:30': 12.5, '12:30': 13.5, '13:30': 14.5, '14:30': 15.5, '15:30': 16 };

  // tastylive's median 16Δ range vs the open by hours since 09:30 (see odte-timing-bt.js)
  function rangeLeft(h) {
    const pts = [[0, 1], [1, 0.86], [2, 0.75], [3, 0.655], [3.5, 0.5]];
    if (h >= 6.5) return 0;
    if (h > 3.5) return 0.5 * Math.sqrt((6.5 - h) / 3);
    for (let i = 1; i < pts.length; i++) { const [a, fa] = pts[i - 1], [b, fb] = pts[i]; if (h <= b) return fa + (fb - fa) * (h - a) / (b - a); }
    return 0.5;
  }

  function sessions({ spxH, v1dH, vixH, vixD, vix3mD, spxD }) {
    const S = byDay(spxH), V1 = byDay(v1dH), VX = byDay(vixH);
    const v3By = Object.fromEntries(vix3mD.map(b => [b.day, b]));
    const vxDBy = Object.fromEntries(vixD.map(b => [b.day, b]));
    const dDays = spxD.map(b => b.day), dClose = spxD.map(b => b.c), idx = Object.fromEntries(dDays.map((d, i) => [d, i]));
    const out = [];
    for (const d of Object.keys(S).sort()) {
      const bars = HM.map(hm => S[d].find(b => b.hm === hm));
      if (bars.some(b => !b) || !V1[d] || !VX[d]) continue;
      const v1 = (V1[d].find(b => b.hm === '10:30') || V1[d].find(b => b.hm === '09:30') || {}).o;
      // VIX hourly bars sit on the hour (10:00, 11:00 …). The value at hh:30 is taken as
      // the hh:00 bar's mid; a bar's high spans the two hourly bars it overlaps.
      const vAt = hh => VX[d].find(b => b.hm === `${hh}:00`);
      const vxBars = HM.map(hm => {
        const hh = hm.slice(0, 2), b = vAt(hh), n = vAt(String(+hh + 1).padStart(2, '0'));
        if (!b) return null;
        return { o: (b.o + b.c) / 2, h: Math.max(b.h, n ? n.h : b.h), c: hm === '15:30' ? b.c : (n ? (n.o + n.c) / 2 : b.c) };
      });
      if (!v1 || vxBars.some(b => !b)) continue;
      const i = idx[d];
      if (i == null || i < 21) continue;
      const sma20 = dClose.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
      const v3 = v3By[d];
      // the 15:30 bar's close is ~16:00 for SPX; VIX's own 15:30 bar close is the 16:00 mark
      const vixClose = vxBars[5].c;
      out.push({
        day: d, bars, v1d: v1, vx: vxBars, vix0: vxBars[0].o, vixClose, close: bars[5].c, S0: bars[0].o,
        ret5: dClose[i - 1] / dClose[i - 6] - 1, below20: bars[0].o < sma20,
        backw: v3 ? vxDBy[d] && vxDBy[d].o >= v3.o : null,
        vixUp: vixClose / vxBars[0].o - 1,
      });
    }
    return out;
  }

  const r5 = x => Math.round(x / 5) * 5;

  /**
   * One trade. kind 'SS' (straddle + 30d strangle) | 'IF' (iron fly ±wing).
   * exit: 'hold' | 'c1230' | 'c1330' | 'losers1330' | {stop: 0.5}
   * Returns P&L $ per 1-lot net of fees and strangle slippage.
   */
  function trade(s, kind, exit, o) {
    const S0 = s.S0, K = r5(S0);
    const em1d = S0 * s.v1d / 100 / SQRT365;
    const base = o.kappa * em1d * Math.sqrt(5.5 / 6) / rangeLeft(1);   // remaining SD calibrated at 10:30
    const shock = vix => Math.pow(vix / s.vix0, o.shockBeta);
    const sd0 = (h, vix) => base * rangeLeft(h) * shock(vix);           // h = hours since 09:30
    const straddle = (S, h, vix) => opt('P', S, K, sd0(h, vix), SK0) + opt('C', S, K, sd0(h, vix), SK0);
    const strad0 = straddle(S0, 1, s.vix0);
    // 30-day leg
    const em30 = S0 * s.vix0 / 100 * Math.sqrt(30 / 365);
    const kP = r5(S0 - em30), kC = r5(S0 + em30);
    const sd30 = (S, vix, dLeft) => o.atm30 * S * vix / 100 * Math.sqrt(dLeft / 365);
    const strangle = (S, vix, dLeft) => opt('P', S, kP, sd30(S, vix, dLeft), SK30) + opt('C', S, kC, sd30(S, vix, dLeft), SK30);
    const W = o.wing;
    const wings = (S, h, vix) => opt('P', S, K - W, sd0(h, vix), SK0) + opt('C', S, K + W, sd0(h, vix), SK0);
    // position value to us (long = +), per share. h hours since 09:30, vix the VIX then.
    const dayFrac = h => (h - 1) / 24;                                   // 30-day clock moves with the day
    const val = (S, h, vix) => kind === 'SS'
      ? -straddle(S, h, vix) + strangle(S, vix, 30 - dayFrac(h))
      : -straddle(S, h, vix) + wings(S, h, vix);
    const settle = (S, vix) => {
      const strInt = Math.abs(S - K);
      return kind === 'SS' ? -strInt + strangle(S, vix, 30 - 6.5 / 24)
        : -strInt + Math.max(0, K - W - S) + Math.max(0, S - K - W);
    };
    const entry = val(S0, 1, s.vix0);                                    // negative = credit
    const credit = -entry;
    // costs: $0.65 × legs × sides; the 30d strangle crosses a half-spread each way
    const legs = 4;
    const feeOpen = o.fee * legs, feeClose = o.fee * legs;
    const slip = kind === 'SS' ? o.strHalfSpread * 2 : 0;               // two options, per side
    const done = (v, closedEarly) => {
      // v = position value at exit; at expiry the 0DTE legs settle free, the strangle is sold
      const fees = feeOpen + (closedEarly ? feeClose : o.fee * (kind === 'SS' ? 2 : 0));
      const slips = kind === 'SS' ? slip * 2 : 0;
      return { pnl: (v - entry) * 100 - fees - slips * 100, credit, strad0, early: closedEarly, kP, kC };
    };
    // walk the hourly bars
    let st = 1;                                                          // h at 10:30
    for (let j = 0; j < 6; j++) {
      const b = s.bars[j], vb = s.vx[j], end = END[HM[j]] - 9.5;
      const last = j === 5;
      if (exit && exit.stop != null) {
        // straddle piece through its stop at the bar's worst price (time left at the bar's start, VIX bar high)
        const trig = strad0 * (1 + exit.stop);
        const Sw = Math.abs(b.h - K) > Math.abs(b.l - K) ? b.h : b.l;
        const sw = straddle(Sw, st, vb.h);
        if (!last && sw >= trig) {
          // Filled where the straddle crosses the trigger, the hedge valued at the same
          // point: interpolate between the bar's start (open price, VIX mid) and its worst
          // point. A bar that opens through the stop fills at its open (gap).
          const hedgeAt = (S, vix) => kind === 'SS' ? strangle(S, vix, 30 - dayFrac(st)) : wings(S, st, vix);
          const s0 = straddle(b.o, st, vb.o), h0 = hedgeAt(b.o, vb.o), hW = hedgeAt(Sw, vb.h);
          if (s0 >= trig) return done(-s0 + h0, true);
          const f = (trig - s0) / (sw - s0);
          return done(-trig + h0 + f * (hW - h0), true);
        }
      }
      if (exit === 'c1230' && HM[j] === '12:30') return done(val(b.o, 3, vb.o), true);
      if ((exit === 'c1330' || exit === 'losers1330') && HM[j] === '13:30') {
        const v = val(b.o, 4, vb.o);
        if (exit === 'c1330' || v < entry) return done(v, true);
      }
      st = end;
    }
    return done(settle(s.close, s.vixClose), false);
  }

  function stats(list) {
    const t = list.filter(Boolean); if (!t.length) return null;
    let cum = 0, peak = 0, dd = 0, run = 0, wr = 0;
    for (const x of t) { cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); run = x.pnl < 0 ? run + 1 : 0; wr = Math.max(wr, run); }
    const sorted = t.map(x => x.pnl).sort((a, b) => a - b), k = Math.max(1, Math.round(t.length * 0.05));
    return { n: t.length, win: t.filter(x => x.pnl > 0).length / t.length, avg: cum / t.length, total: cum, maxDD: dd,
      worst: sorted[0], cvar5: sorted.slice(0, k).reduce((a, b) => a + b, 0) / k, best: sorted[sorted.length - 1],
      credit: t.reduce((a, x) => a + x.credit, 0) / t.length, strad: t.reduce((a, x) => a + x.strad0, 0) / t.length, worstRun: wr };
  }

  const EXITS = [['hold', 'hold'], ['c1230', 'close 12:30'], ['c1330', 'close 13:30'], ['losers1330', 'losers 13:30'],
    [{ stop: 0.5 }, 'stop 50%'], [{ stop: 1 }, 'stop 100%'], [{ stop: 1.5 }, 'stop 150%'], [{ stop: 2 }, 'stop 200%']];

  function run(raw, user = {}) {
    const o = { kappa: 0.9, shockBeta: 1.5, atm30: 0.9, wing: 30, fee: 0.65, strHalfSpread: 0.15, ...user };
    const data = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : loadYahoo(v)]));
    const ss = sessions(data);
    const regimes = {
      all: () => true,
      'VIX ≥ 20': s => s.vix0 >= 20,
      'below SMA20': s => s.below20,
      '5d < −2%': s => s.ret5 < -0.02,
      backwardated: s => s.backw === true,
      'VIX up ≥10% on the day': s => s.vixUp >= 0.10,
      'VIX down on the day': s => s.vixUp < 0,
    };
    const rows = [];
    for (const kind of ['SS', 'IF']) for (const [rk, f] of Object.entries(regimes)) {
      const sub = ss.filter(f);
      for (const [ex, label] of EXITS) {
        const st = stats(sub.map(s => trade(s, kind, ex, o)));
        if (st) rows.push({ kind, regime: rk, exit: label, ...st });
      }
    }
    // a sample day for a price check
    const s = ss[ss.length - 1];
    const sample = s ? (() => { const t = trade(s, 'SS', 'hold', o); const f = trade(s, 'IF', 'hold', o); return { day: s.day, S0: s.S0, v1d: s.v1d, vix: s.vix0, straddle: t.strad0, ssNet: t.credit, kP: t.kP, kC: t.kC, flyCredit: f.credit }; })() : null;
    return { sessions: ss.length, first: ss[0] && ss[0].day, last: s && s.day, rows, sample, o, ss,
      counts: Object.fromEntries(Object.entries(regimes).map(([k, f]) => [k, ss.filter(f).length])) };
  }
  const fmt = rows => rows.map(r => [r.kind, r.regime, r.exit, r.n, (r.win * 100).toFixed(0) + '%', Math.round(r.avg), Math.round(r.cvar5), Math.round(r.worst), Math.round(r.maxDD), r.worstRun, r.credit.toFixed(1)].join('|')).join('\n');
  const api = { run, fmt, loadYahoo, sessions, trade, rangeLeft };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ODTESTR = api;
})();
