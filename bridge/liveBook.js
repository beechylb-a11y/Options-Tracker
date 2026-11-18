// ── Live book (Nov 2026) ──
//
// One set of always-on TWS subscriptions, held in memory, that the app reads through
// a single push stream (/api/stream) instead of asking the bridge for a fresh
// snapshot every few seconds. Before this, every poll opened a new reqMktData per
// contract and waited 0.5–6 s for ticks, so each refresh paid the subscribe cost and
// two screens polling at different moments could show different prices.
//
// What is subscribed, and why (the "reasons" on each entry):
//   'watch'     the underlyings and indices the app always shows (SPX, VIX …)
//   'position'  every option leg TWS reports a position in — added and dropped as
//               reqPositions streams changes
//   'ticket'    legs the app is pricing right now (an open ticket); these expire unless
//               the app renews them, so a closed tab stops costing a data line
// An entry with no reason left is unsubscribed.
//
// Pure: no IB calls here, so it can be tested. index.js owns the connection, turns ticks
// into apply*() calls and acts on what want()/expire() report.
//
// Keys: an underlying is its symbol ('SPX'); an option leg is
// 'SPX 20261118 7600 P' — the same key the app builds from a ticket leg (live/keys.js).

export const LIVE_FIELDS = {
  1: 'bid', 2: 'ask', 4: 'last', 6: 'high', 7: 'low', 9: 'close', 14: 'open',
  66: 'bid', 67: 'ask', 68: 'last', 72: 'high', 73: 'low', 75: 'close', 76: 'open',
};
export const DELAYED_FIELDS = new Set([66, 67, 68, 72, 73, 75, 76]);
// A data line is the scarce thing: TWS's own windows share the account's allowance.
export const DEFAULT_MAX_LINES = 60;
export const TICKET_TTL_MS = 120000;

const r2 = v => Math.round(v * 100) / 100;
const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/** 'SPX' | 'SPX 20261118 7600 P' */
export function liveKey(underlying, expiry, strike, right) {
  const u = String(underlying || '').toUpperCase().trim();
  if (!expiry) return u;
  const k = Number(strike);
  const rt = String(right || '').toUpperCase().startsWith('P') ? 'P' : 'C';
  return `${u} ${String(expiry).replace(/-/g, '')} ${Number.isInteger(k) ? k : r2(k)} ${rt}`;
}

/** Inverse of liveKey, for building the contract to subscribe. */
export function parseLiveKey(key) {
  const p = String(key || '').trim().split(/\s+/);
  if (p.length === 1) return { underlying: p[0] };
  if (p.length !== 4) return null;
  return { underlying: p[0], expiry: p[1], strike: Number(p[2]), right: p[3] };
}

/** Mid when both sides are real, else last. */
export function markOf(q) {
  if (!q) return null;
  if (q.bid != null && q.ask != null && q.ask >= q.bid && q.ask > 0) return r2((q.bid + q.ask) / 2);
  return q.last != null ? q.last : null;
}

/**
 * Price of a combo from its legs' live quotes, per share, money-in positive
 * (a credit is +, a debit is −) — the ticket's convention.
 *   legs: [{ key, qty }]  qty signed: + long, − short (per lot; 1 for a vertical leg)
 * Returns { mid, natural, far, complete }: natural is what you get crossing the
 * spread (sell longs at the bid… for an opening trade it is the worst side), far
 * is the other side. null fields when any leg lacks a quote.
 */
export function comboQuote(legs, quotes) {
  let mid = 0, natural = 0, far = 0, complete = true;
  for (const l of legs || []) {
    const q = quotes[l.key] || quotes.get?.(l.key);
    const m = markOf(q);
    if (!q || m == null || q.bid == null || q.ask == null) { complete = false; continue; }
    // Buying a long leg costs the ask at worst; selling a short leg gets the bid.
    mid -= l.qty * m;
    natural -= l.qty * (l.qty > 0 ? q.ask : q.bid);
    far -= l.qty * (l.qty > 0 ? q.bid : q.ask);
  }
  if (!complete) return { mid: null, natural: null, far: null, complete };
  return { mid: r2(mid), natural: r2(natural), far: r2(far), complete };
}

export function createLiveBook({ now = () => Date.now(), maxLines = DEFAULT_MAX_LINES } = {}) {
  const entries = new Map();   // key → { key, reasons: Map<reason, expiresAt|Infinity>, quote, seq }
  const positions = new Map(); // 'acct|key' → { account, key, qty, avgCost, multiplier, seq }
  const orders = new Map();    // orderId → { orderId, status, filled, remaining, avgFillPrice, lmtPrice, action, totalQty, legs, ref, seq }
  let seq = 0;
  let posSeq = 0, ordSeq = 0;  // last change to the positions / orders lists, deletions included
  let status = { connected: false, farmOk: true, refused: 0 };

  const bump = () => ++seq;

  function entry(key) {
    let e = entries.get(key);
    if (!e) { e = { key, reasons: new Map(), quote: { key }, seq: 0, subscribed: false }; entries.set(key, e); }
    return e;
  }

  const lines = () => [...entries.values()].filter(e => e.reasons.size > 0).length;

  /**
   * Ask for a key. Returns 'new' when it needs subscribing, 'held' when it already
   * is, 'refused' when the line budget is spent (only tickets are refused: watched
   * underlyings and real positions always get a line).
   */
  function want(key, reason, ttlMs = Infinity) {
    const e = entries.get(key);
    const had = !!(e && e.reasons.size > 0);
    if (!had && reason === 'ticket' && lines() >= maxLines) { status = { ...status, refused: status.refused + 1 }; return 'refused'; }
    const x = entry(key);
    const until = ttlMs === Infinity ? Infinity : now() + ttlMs;
    x.reasons.set(reason, Math.max(x.reasons.get(reason) || 0, until));
    return had ? 'held' : 'new';
  }

  /** Drop one reason. Returns true when nothing holds the key any more (unsubscribe it). */
  function release(key, reason) {
    const e = entries.get(key);
    if (!e) return false;
    e.reasons.delete(reason);
    if (e.reasons.size === 0) { entries.delete(key); bump(); return true; }
    return false;
  }

  /** Expired ticket reasons → keys to unsubscribe. */
  function expire() {
    const t = now(), gone = [];
    for (const e of entries.values()) {
      for (const [r, until] of e.reasons) if (until !== Infinity && until <= t) e.reasons.delete(r);
      if (e.reasons.size === 0) gone.push(e.key);
    }
    for (const k of gone) entries.delete(k);
    if (gone.length) bump();
    return gone;
  }

  function touch(e) { e.quote.ts = now(); e.seq = bump(); }

  function applyTick(key, field, value) {
    const e = entries.get(key);
    const name = LIVE_FIELDS[field];
    if (!e || !name) return false;
    const v = num(value);
    if (v == null || v < 0 || (v === 0 && name !== 'bid')) return false; // −1 placeholders; a 0 bid is real on far OTM legs
    e.quote[name] = v;
    if (DELAYED_FIELDS.has(field)) e.quote.delayed = true;
    e.quote.mark = markOf(e.quote);
    touch(e);
    return true;
  }

  /** Model greeks (tickType 13) and the underlying price they were computed off. */
  function applyGreeks(key, g) {
    const e = entries.get(key);
    if (!e || !g) return false;
    const set = (k, v, scale = 1) => { const n = num(v); if (n != null && Math.abs(n) < 1e9) e.quote[k] = n * scale; };
    set('iv', g.iv); set('delta', g.delta); set('gamma', g.gamma); set('theta', g.theta); set('vega', g.vega); set('und', g.und);
    touch(e);
    return true;
  }

  function applyMdType(key, type) {
    const e = entries.get(key);
    if (!e) return;
    e.quote.mdType = type;
    if (type === 3 || type === 4) e.quote.delayed = true;
    e.seq = bump();
  }

  // IBKR's not-subscribed family. Some (10090, 10167) arrive alongside real or delayed
  // ticks, so this is a note on the quote, not a verdict: the app goes by the ticks.
  function markNotEntitled(key, code = null) {
    const e = entries.get(key);
    if (!e) return;
    e.quote.notEntitled = true;
    if (code != null) e.quote.entCode = code;
    e.seq = bump();
  }

  function setPosition(account, key, qty, avgCost, multiplier = 100) {
    const id = `${account}|${key}`;
    if (!qty) { if (positions.delete(id)) posSeq = bump(); return; }
    positions.set(id, { account, key, qty: Number(qty), avgCost: num(avgCost) || 0, multiplier: Number(multiplier) || 100 });
    posSeq = bump();
  }

  function setOrder(orderId, patch) {
    const prev = orders.get(orderId) || { orderId };
    patch = Object.fromEntries(Object.entries(patch || {}).filter(([, v]) => v !== undefined));
    // Finished orders stay a while so the app sees the final state, then go (pruneOrders).
    orders.set(orderId, { ...prev, ...patch, orderId, ts: now() });
    ordSeq = bump();
  }

  function pruneOrders(maxAgeMs = 30 * 60000) {
    const t = now();
    for (const [id, o] of orders) {
      if (/^(Filled|Cancelled|ApiCancelled|Inactive)$/.test(o.status || '') && t - (o.ts || 0) > maxAgeMs) { orders.delete(id); ordSeq = bump(); }
    }
  }

  function setStatus(patch) { status = { ...status, ...patch }; bump(); }

  const quoteOut = e => ({ ...e.quote, reasons: [...e.reasons.keys()] });

  function snapshot() {
    return {
      seq,
      at: now(),
      status: { ...status, lines: lines(), maxLines },
      quotes: Object.fromEntries([...entries.values()].map(e => [e.key, quoteOut(e)])),
      positions: [...positions.values()],
      orders: [...orders.values()],
    };
  }

  /**
   * What changed after `since` (a seq the client already has). Keys that left the
   * book are listed in `removed`, so a client never keeps a quote nobody updates.
   */
  function changesSince(since, knownKeys = null) {
    const quotes = {};
    for (const e of entries.values()) if (e.seq > since) quotes[e.key] = quoteOut(e);
    const removed = knownKeys ? [...knownKeys].filter(k => !entries.has(k)) : [];
    return {
      seq,
      at: now(),
      status: { ...status, lines: lines(), maxLines },
      quotes,
      removed,
      positions: posSeq > since || since === 0 ? [...positions.values()] : null,
      orders: ordSeq > since || since === 0 ? [...orders.values()] : null,
    };
  }

  return {
    want, release, expire, applyTick, applyGreeks, applyMdType, markNotEntitled,
    setPosition, setOrder, pruneOrders, setStatus, snapshot, changesSince,
    keys: () => [...entries.keys()],
    has: k => entries.has(k),
    isSubscribed: k => !!entries.get(k)?.subscribed,
    setSubscribed: (k, v) => { const e = entries.get(k); if (e) e.subscribed = v; },
    get seq() { return seq; },
    lines,
  };
}

/** One SSE frame. `data` is JSON; event names: snapshot | delta | ping. */
export function sseFrame(event, data, id) {
  return (id != null ? `id: ${id}\n` : '') + `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
