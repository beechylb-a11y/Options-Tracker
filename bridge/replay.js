// Trade replay — reconstruct what a multi-leg structure was actually worth, minute
// by minute, from the individual legs.
//
// WHY THIS EXISTS. A TWS chart of a COMBO is not the structure's value. TWS builds
// the combo quote out of the legs' own bid/asks, so one stale or wide leg — doubled
// on a butterfly, whose body is x2 — throws the implied price anywhere. On the SPY
// 759/763/768 fly of 29 Sep the 5-minute bars ran from below -0.40 to above 1.60,
// which would have required SPY to travel eleven points and back inside five
// minutes: 2.2x the whole session's expected move. The wicks were quote artefacts
// and the real bars were about 0.14 tall.
//
// Summing per-leg BID and ASK bars instead gives two things that chart cannot:
// a clean mid series (no phantom range) and the true spread at every bar, so
// execution cost is measured rather than assumed. (Sep 2026.)

// Leg spec: { strike, right: 'C'|'P', ratio } — ratio signed, + long, - short.
// "759C:1,763C:-2,768C:1" → three legs of a 1/-2/+1 broken wing.
export function parseLegs(spec) {
  if (!spec) return [];
  return String(spec).split(',').map(part => {
    const m = part.trim().match(/^(\d+(?:\.\d+)?)\s*([CPcp])\s*:\s*([+-]?\d+(?:\.\d+)?)$/);
    if (!m) throw new Error(`Bad leg "${part.trim()}" — expected e.g. 763C:-2`);
    const ratio = Number(m[3]);
    if (!ratio) throw new Error(`Leg "${part.trim()}" has ratio 0`);
    return { strike: Number(m[1]), right: m[2].toUpperCase(), ratio };
  });
}

// Index bars by timestamp so legs pulled in separate requests can be aligned. IBKR
// returns epoch seconds under formatDate 2; anything else is passed through as the
// key it came with.
const byTime = bars => {
  const m = new Map();
  for (const b of bars || []) m.set(String(b.date), b);
  return m;
};

// Combine per-leg BID/ASK series into the structure's own series.
//
// A bar survives only if EVERY leg quoted at that timestamp. A partial bar would
// silently price a different structure — the exact failure this module exists to
// avoid — so gaps are reported as dropped, not filled.
export function composeCombo(legs, legBars, underlyingBars = []) {
  if (!legs.length) return { bars: [], dropped: 0 };
  const idx = legs.map(l => ({
    bid: byTime(legBars[legKey(l)]?.bid),
    ask: byTime(legBars[legKey(l)]?.ask),
  }));
  const spot = byTime(underlyingBars);

  // Drive off the first leg's timestamps; every other leg must match.
  const stamps = [...idx[0].bid.keys()].sort();
  const out = [];
  let dropped = 0;

  for (const t of stamps) {
    let mid = 0, spread = 0, ok = true;
    for (let i = 0; i < legs.length && ok; i++) {
      const b = idx[i].bid.get(t), a = idx[i].ask.get(t);
      if (!b || !a) { ok = false; break; }
      // Bar bid/ask are themselves OHLC; the close is the quote at the bar's end,
      // which is the one an order at that moment would have met.
      const lb = Number(b.close), la = Number(a.close);
      if (!isFinite(lb) || !isFinite(la) || la < lb) { ok = false; break; }
      mid += legs[i].ratio * (lb + la) / 2;
      // Spread is paid on every leg regardless of direction, so magnitudes add.
      spread += Math.abs(legs[i].ratio) * (la - lb);
    }
    if (!ok) { dropped++; continue; }
    const s = spot.get(t);
    out.push({
      t: Number(t),
      mid: round2(mid),
      spread: round2(spread),
      spot: s ? Number(s.close) : null,
      spotHigh: s ? Number(s.high) : null,
      spotLow: s ? Number(s.low) : null,
    });
  }
  return { bars: out, dropped };
}

export const legKey = l => `${l.strike}${l.right}`;
const round2 = n => Math.round(n * 1000) / 1000;

// Payoff at expiry, per share, before the debit paid. Used for the geometry block
// and to place the observed mid against what the structure can ever be worth.
export function intrinsic(legs, S) {
  return legs.reduce((a, l) => a + l.ratio *
    (l.right === 'C' ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0)), 0);
}

// Strike-to-strike geometry: the widest the structure can ever be worth, and where.
export function geometry(legs) {
  const strikes = [...new Set(legs.map(l => l.strike))].sort((a, b) => a - b);
  let best = { S: null, value: -Infinity };
  for (const K of strikes) {
    const v = intrinsic(legs, K);
    if (v > best.value) best = { S: K, value: v };
  }
  // Breakevens by scanning between and beyond the strikes — the payoff is piecewise
  // linear, so a sign change between two adjacent kinks is a single crossing.
  return { strikes, bodyStrike: best.S, maxIntrinsic: round2(best.value) };
}

// Turn the aligned series into the numbers a postmortem actually argues from.
export function summarise(legs, bars, opts = {}) {
  if (!bars.length) return null;
  const g = geometry(legs);
  const entryT = opts.entryEpoch || bars[0].t;
  const exitT = opts.exitEpoch || bars[bars.length - 1].t;
  const at = T => bars.reduce((best, b) =>
    Math.abs(b.t - T) < Math.abs(best.t - T) ? b : best, bars[0]);
  const e = at(entryT), x = at(exitT);
  const held = bars.filter(b => b.t >= e.t && b.t <= x.t);

  const mids = held.map(b => b.mid);
  const spreads = held.map(b => b.spread).filter(isFinite);
  const avgSpread = spreads.length ? spreads.reduce((a, c) => a + c, 0) / spreads.length : null;

  return {
    bodyStrike: g.bodyStrike,
    maxIntrinsic: g.maxIntrinsic,
    entry: { t: e.t, mid: e.mid, spread: e.spread, spot: e.spot },
    exit: { t: x.t, mid: x.mid, spread: x.spread, spot: x.spot },
    bars: held.length,
    // What the structure was worth across the hold, on real quotes.
    midLow: Math.min(...mids), midHigh: Math.max(...mids),
    midRange: round2(Math.max(...mids) - Math.min(...mids)),
    avgSpread: avgSpread == null ? null : round2(avgSpread),
    // The comparison that matters: the move you could have captured against what it
    // costs to get in and out. A range that is a small multiple of the spread is not
    // an opportunity, whatever the combo chart's wicks suggest.
    rangeInSpreads: avgSpread > 0 ? Math.round(10 * (Math.max(...mids) - Math.min(...mids)) / avgSpread) / 10 : null,
    roundTripCost: avgSpread == null ? null : round2(avgSpread),
    markChange: round2(x.mid - e.mid),
    // Where value sat relative to the ceiling. A butterfly is a terminal-value
    // structure; this is the number that says how little of it was on the table.
    pctOfMaxAtEntry: g.maxIntrinsic > 0 ? Math.round(100 * e.mid / g.maxIntrinsic) : null,
    pctOfMaxAtExit: g.maxIntrinsic > 0 ? Math.round(100 * x.mid / g.maxIntrinsic) : null,
    spotVsBodyEntry: e.spot == null ? null : round2(e.spot - g.bodyStrike),
    spotVsBodyExit: x.spot == null ? null : round2(x.spot - g.bodyStrike),
  };
}

// ════════════════════════════════════════════════════════════════════════
//  SPREAD BY TIME OF DAY
// ════════════════════════════════════════════════════════════════════════
// A 45DTE entry lives or dies on the spread it crosses, and the received wisdom
// about when spreads are tight — wide at the open, tighter mid-morning, widening
// into the close — is a claim about options markets in general, not about the
// strikes this account actually trades. Six-to-eight percent OTM monthlies on QQQ
// are their own market. This measures it instead of assuming it. (Oct 2026.)

// Median, not mean: spreads are right-skewed and one stale print should not move
// the answer for a whole half-hour.
export function median(xs) {
  const a = xs.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  hour: '2-digit', minute: '2-digit', year: 'numeric', month: '2-digit', day: '2-digit',
});

// epoch seconds -> { slot: 'HH:MM' half-hour bucket, date: 'YYYY-MM-DD', mins }
export function etSlot(epochSec) {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(epochSec * 1000)).map(x => [x.type, x.value]));
  const h = p.hour === '24' ? 0 : Number(p.hour);
  const m = Number(p.minute);
  const slotMin = m < 30 ? 0 : 30;
  return {
    slot: `${String(h).padStart(2, '0')}:${slotMin === 0 ? '00' : '30'}`,
    date: `${p.year}-${p.month}-${p.day}`,
    mins: h * 60 + m,
  };
}

// Group composed combo bars into ET half-hours.
//
// `refPrice` is the credit or debit being contemplated; given it, the spread is
// also reported as a percentage of the trade, which is the number that decides
// whether a window is worth waiting for. Without it the absolute spread still
// tells you the shape.
export function spreadProfile(bars, { refPrice = null, minBars = 2 } = {}) {
  if (!Array.isArray(bars) || !bars.length) return null;
  const buckets = new Map();
  for (const b of bars) {
    if (!Number.isFinite(b.spread) || b.spread < 0) continue;
    const { slot, date } = etSlot(b.t);
    // Only the regular session. Pre- and post-market quotes on an option are
    // placeholders and would dominate the answer with noise.
    const hh = Number(slot.slice(0, 2));
    if (hh < 9 || hh > 15) continue;
    if (!buckets.has(slot)) buckets.set(slot, { spreads: [], mids: [], days: new Set() });
    const e = buckets.get(slot);
    e.spreads.push(b.spread);
    if (Number.isFinite(b.mid)) e.mids.push(b.mid);
    e.days.add(date);
  }

  const rows = [...buckets.entries()]
    .map(([slot, e]) => {
      const s = median(e.spreads);
      return {
        slot,
        bars: e.spreads.length,
        days: e.days.size,
        medianSpread: s == null ? null : Math.round(s * 1000) / 1000,
        medianMid: (() => { const m = median(e.mids); return m == null ? null : Math.round(m * 1000) / 1000; })(),
        // Half the spread is what crossing costs one way — the number you actually
        // pay away by not working the order.
        crossCost: s == null ? null : Math.round((s / 2) * 1000) / 1000,
        pctOfTrade: (s != null && refPrice) ? Math.round(1000 * (s / 2) / Math.abs(refPrice)) / 10 : null,
      };
    })
    .filter(r => r.medianSpread != null && r.bars >= minBars)
    .sort((a, b) => (a.slot < b.slot ? -1 : 1));

  if (!rows.length) return null;

  const tightest = rows.reduce((a, r) => (r.medianSpread < a.medianSpread ? r : a), rows[0]);
  const widest = rows.reduce((a, r) => (r.medianSpread > a.medianSpread ? r : a), rows[0]);
  const allDays = new Set();
  for (const e of buckets.values()) for (const d of e.days) allDays.add(d);

  return {
    rows, tightest, widest,
    sessions: allDays.size,
    // Worth acting on only if the best window actually beats the worst by enough to
    // matter. A 10% difference on a 0.20 spread is a cent — not a reason to wait.
    spreadRatio: widest.medianSpread > 0
      ? Math.round(100 * tightest.medianSpread / widest.medianSpread) / 100 : null,
    saving: Math.round((widest.medianSpread - tightest.medianSpread) / 2 * 1000) / 1000,
  };
}
