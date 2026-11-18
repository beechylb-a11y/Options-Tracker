// ── Stage an entry + profit target in TWS, untransmitted (Nov 2026) ──
//
// The exit plan's "Stage in TWS" button. The bridge builds the trade as ONE combo
// (BAG) order with the profit target(s) attached as child orders, and places them with
// transmit = false: they land in TWS's order window, filled in, and nothing reaches the
// exchange until the trader checks them and clicks Transmit in TWS.
//
// Deliberately NOT staged: a stop. The trader manages the loss by hand (decision,
// 14 Nov 2026); the stop on the exit plan is a reference level for the check-up only.
//
// Pure: no IB connection here, so the order shapes can be tested. index.js resolves the
// legs' conIds and places what this returns.
//
// Sign convention: the orders read the way the exit-plan card and TWS's own ticket read
// them, prices always positive. A credit trade is a SELL of the combo at the credit
// (SELL 4 @ 0.66) and its profit target a BUY back (BUY 4 @ 0.50); a debit trade BUYs at
// the debit and SELLs at the target. IB reverses every leg when a combo is SOLD, so for a
// credit trade the combo is defined with each leg's side flipped: selling it opens
// exactly the ticket's legs.
//
// Entry time-in-force (17 Nov 2026, reworked 18 Nov): a 0DTE entry must not rest into
// the afternoon — no 0DTE opens after 12:00 ET. It was sent as GTD 12:30 ET, but TWS
// rejects GTD on a combo it routes across exchanges ("Inter exchange combo order should
// be DAY/GTC order" — every SPX spread). So the entry goes DAY and the BRIDGE cancels it
// at 12:30 ET if it has not filled (index.js, cut-off watcher; survives a restart).
// A 45DTE entry goes GTC. The profit target keeps its own TIF (0DTE DAY, 45DTE GTC): if
// the entry fills, the target must not vanish with the trade still on.

export const STAGE_MAX_LOTS = 50;
export const GTD_CUTOFF_ET = '12:30';

const NY = 'America/New_York';
function nyParts(ms) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
  const o = {}; for (const x of f.formatToParts(new Date(ms))) o[x.type] = x.value;
  return { ymd: `${o.year}${o.month}${o.day}`, h: Number(o.hour), m: Number(o.minute), wd: o.weekday };
}
// New York wall-clock (yyyymmdd, hh, mm) → UTC ms, DST-correct.
export function nyToUtcMs(ymd, h, m) {
  const y = +ymd.slice(0, 4), mo = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
  let t = Date.UTC(y, mo, d, h, m);
  for (let i = 0; i < 2; i++) {
    const q = nyParts(t);
    const seen = Date.UTC(+q.ymd.slice(0, 4), +q.ymd.slice(4, 6) - 1, +q.ymd.slice(6, 8), q.h, q.m);
    t += Date.UTC(y, mo, d, h, m) - seen;
  }
  return t;
}
const addDaysYmd = (ymd, n) => {
  const t = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + n));
  return `${t.getUTCFullYear()}${String(t.getUTCMonth() + 1).padStart(2, '0')}${String(t.getUTCDate()).padStart(2, '0')}`;
};
const isWeekend = ymd => { const w = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8))).getUTCDay(); return w === 0 || w === 6; };

/**
 * The GTD for a 0DTE entry: the next New York session whose cut-off is still ahead —
 * today's if it's before 12:30 ET, else the next weekday — capped at the legs' expiry.
 * Staged from Melbourne the evening before, that's the coming session's 12:30.
 * @returns { goodTillDate: 'yyyymmdd hh:mm:ss US/Eastern', ymd, label } | { error }
 */
export function gtdFor(expiry, now = Date.now(), cutoff = GTD_CUTOFF_ET) {
  const [hh, mm] = String(cutoff).split(':').map(Number);
  let day = nyParts(now).ymd;
  while (isWeekend(day) || nyToUtcMs(day, hh, mm) <= now) day = addDaysYmd(day, 1);
  if (expiry && day > expiry) return { error: `Past the ${cutoff} ET entry cut-off for this expiry — no 0DTE entry to stage` };
  const pad = n => String(n).padStart(2, '0');
  return { goodTillDate: `${day} ${pad(hh)}:${pad(mm)}:00 US/Eastern`, ymd: day, label: `GTD ${pad(hh)}:${pad(mm)} ET` };
}

const round2 = x => Math.round(x * 100) / 100;

/**
 * @param p.underlying  'SPX' | 'QQQ' | …
 * @param p.legs        [{ strike, right: 'C'|'P', qty (signed, per lot), expiry 'yyyymmdd' }]
 * @param p.lots        contracts of the combo
 * @param p.side        'credit' | 'debit'
 * @param p.entry       price per share, positive (0.66)
 * @param p.targets     [{ qty, price }] — price per share, positive (0.50 to buy back a credit)
 * @param p.tif         'DAY' | 'GTC' for the targets (0DTE → DAY)
 * @param p.entryTif    'CUTOFF' (or 'GTD') | 'GTC' | 'DAY' for the entry. CUTOFF stages a DAY order
 *                      and returns cancelAt (12:30 ET) for the bridge to cancel it if unfilled —
 *                      TWS rejects GTD on inter-exchange combos. 45DTE → GTC. Left out: DAY.
 * @param p.now         ms, for tests (default Date.now())
 * @param p.account     IB account code (optional: TWS uses its default)
 * @param p.orderRef    tag carried on every order so the fills map back to the ticket
 * @returns { error } | { comboLegs, parent, children, summary, entryTif (label), cancelAt (ms | null) }
 *          comboLegs carry `legKey` for index.js to swap in the conId.
 */
export function buildStage(p) {
  const legs = Array.isArray(p && p.legs) ? p.legs : [];
  if (legs.length < 2 || legs.length > 4) return { error: 'Staging takes a 2–4 leg combo' };
  const lots = Math.round(Number(p.lots));
  if (!(lots >= 1) || lots > STAGE_MAX_LOTS) return { error: `Contracts must be 1–${STAGE_MAX_LOTS}` };
  const side = p.side === 'debit' ? 'debit' : p.side === 'credit' ? 'credit' : null;
  if (!side) return { error: 'Say whether the entry is a credit or a debit' };
  const entry = Number(p.entry);
  if (!(entry > 0)) return { error: 'No entry price' };
  for (const l of legs) {
    if (!(Number(l.strike) > 0) || !/^[CP]$/.test(String(l.right || '').toUpperCase()) || !(Number(l.qty)) || !/^\d{8}$/.test(String(l.expiry || ''))) {
      return { error: 'A leg is missing its strike, right, quantity or expiry' };
    }
  }
  // Per-lot ratios must be whole numbers; IB wants each leg's ratio, not the total.
  const ratios = legs.map(l => Math.abs(Number(l.qty)));
  if (ratios.some(r => !Number.isInteger(r))) return { error: 'Leg ratios must be whole numbers per contract' };

  const targets = (Array.isArray(p.targets) ? p.targets : [])
    .map(t => ({ qty: Math.round(Number(t.qty)), price: Number(t.price) }))
    .filter(t => t.qty > 0 && t.price >= 0);
  const tq = targets.reduce((a, t) => a + t.qty, 0);
  if (tq > lots) return { error: `Targets add up to ${tq} contracts, more than the ${lots} entered` };
  if (side === 'credit' && targets.some(t => t.price >= entry)) return { error: 'A credit trade’s profit target must cost less than the credit taken in' };
  if (side === 'debit' && targets.some(t => t.price <= entry)) return { error: 'A debit trade’s profit target must sell for more than it cost' };

  const credit = side === 'credit';
  const common = {
    orderType: 'LMT',
    transmit: false,                          // ALWAYS — the trader transmits in TWS
    outsideRth: false,
    ...(p.account ? { account: String(p.account) } : {}),
    ...(p.orderRef ? { orderRef: String(p.orderRef).slice(0, 40) } : {}),
  };
  let entryTif = { tif: 'DAY' }, entryLabel = 'DAY';
  if (p.entryTif === 'GTC') { entryTif = { tif: 'GTC' }; entryLabel = 'GTC'; }
  let cancelAt = null;
  if (p.entryTif === 'GTD' || p.entryTif === 'CUTOFF') {
    const firstExp = legs.map(l => String(l.expiry)).sort()[0];
    const g = gtdFor(firstExp, p.now != null ? Number(p.now) : Date.now());
    if (g.error) return { error: g.error };
    const [hh, mm] = GTD_CUTOFF_ET.split(':').map(Number);
    cancelAt = nyToUtcMs(g.ymd, hh, mm);
    entryTif = { tif: 'DAY' }; entryLabel = `DAY · cancels ${GTD_CUTOFF_ET} ET if unfilled`;
  }
  const parent = { ...common, action: credit ? 'SELL' : 'BUY', totalQuantity: lots, lmtPrice: round2(entry), ...entryTif };
  const children = targets.map(t => ({ ...common, action: credit ? 'BUY' : 'SELL', totalQuantity: t.qty, lmtPrice: round2(t.price), tif: p.tif === 'GTC' ? 'GTC' : 'DAY' }));
  const comboLegs = legs.map(l => ({
    legKey: `${String(l.expiry)}|${Number(l.strike)}|${String(l.right).toUpperCase()[0]}`,
    ratio: Math.abs(Number(l.qty)),
    action: (credit ? -1 : 1) * Number(l.qty) > 0 ? 'BUY' : 'SELL',   // flipped for a credit (sold combo)
    exchange: 'SMART',
  }));
  const ks = legs.map(l => Number(l.strike)).join('/');
  const summary = [
    `${credit ? 'SELL' : 'BUY'} ${lots} ${String(p.underlying || '').toUpperCase()} ${ks} @ ${entry.toFixed(2)} ${side === 'credit' ? 'cr' : 'db'} ${entryLabel}`,
    ...targets.map(t => `${credit ? 'BUY' : 'SELL'} ${t.qty} @ ${t.price.toFixed(2)} (profit target) ${p.tif === 'GTC' ? 'GTC' : 'DAY'}`),
  ];
  return { comboLegs, parent, children, summary, entryTif: entryLabel, cancelAt };
}

// ── What-if (Nov 2026) ──
// TWS answers a what-if order (order.whatIf = true) with the margin and commission
// the trade would cost, and never routes it. Its numbers arrive as strings or numbers,
// with IB's UNSET_DOUBLE (1.797…e308) for anything it did not compute.
const UNSET = 1e300;
const whatNum = v => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < UNSET ? n : null;
};
export function whatIfSummary(state) {
  const s = state || {};
  return {
    initMarginChange: whatNum(s.initMarginChange), maintMarginChange: whatNum(s.maintMarginChange),
    equityWithLoanChange: whatNum(s.equityWithLoanChange),
    initMarginAfter: whatNum(s.initMarginAfter), maintMarginAfter: whatNum(s.maintMarginAfter),
    equityWithLoanAfter: whatNum(s.equityWithLoanAfter), equityWithLoanBefore: whatNum(s.equityWithLoanBefore),
    commission: whatNum(s.commission), minCommission: whatNum(s.minCommission), maxCommission: whatNum(s.maxCommission),
    currency: s.commissionCurrency || 'USD',
    warning: s.warningText ? String(s.warningText) : '',
  };
}
/** Excess liquidity left after the trade, when TWS said enough to work it out. */
export function excessAfter(w) {
  if (!w || w.equityWithLoanAfter == null || w.initMarginAfter == null) return null;
  return Math.round((w.equityWithLoanAfter - w.initMarginAfter) * 100) / 100;
}
