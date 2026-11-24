// What is coming in from TWS right now (Nov 2026). A pull used to be silent: numbers
// changed and the only clue was the "Not from Bridge" chips at the foot of the ticket.
// This turns what the ticket knows — the live stream, the last pulls and whether one is
// running — into one state for the chip at the top of the ticket and a row per feed for
// the panel behind it. Pure, so the thresholds are tested.

export const LIVE_MS = 15000;          // a streamed quote younger than this is live
export const STALE_MS = 3 * 60000;     // in session, a pull older than this is stale

const clock = t => {
  const d = new Date(t);
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
const ago = ms => (ms < 1000 ? 'now' : ms < 60000 ? `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s ago` : `${Math.round(ms / 60000)} min ago`);
const tsOf = v => { if (v == null || v === '') return null; const t = typeof v === 'number' ? v : Date.parse(v); return isFinite(t) ? t : null; };

/**
 * @param o.now           ms
 * @param o.bridge        a bridge URL is set
 * @param o.connection    live stream to the bridge: 'open' | 'connecting' | 'off' | …
 * @param o.tws           the bridge's own link to TWS is up (status.connected); false = bridge
 *                        answers but TWS / IB Gateway is not there, so nothing new can arrive
 * @param o.marketOpen    regular session
 * @param o.underlying    { ts } newest streamed quote for the underlying
 * @param o.legs          [{ ts }] newest streamed quote per leg ([] when the ticket has none)
 * @param o.pulls         [{ key, label, busy, at, fallback? }] — market pull, greeks, vol…
 *                        fallback: a string when the data came back delayed / frozen / last close
 * @param o.whatIf        'idle' | 'busy' | 'ok' | 'err' (optional)
 * @returns { state: 'receiving'|'live'|'stale'|'offline', title, sub, feeds: [{ key, label, state, when }] }
 *          feed state: 'pulling' | 'live' | 'done' | 'stale' | 'fallback' | 'waiting' | 'off'
 */
export function inboundStatus(o) {
  const now = o.now ?? Date.now();
  const open = o.connection === 'open';
  const noTws = open && o.tws === false;      // bridge up, TWS not
  const feeds = [];

  // Streamed quotes: live while fresh; older than that, stale in session, done after.
  const streamRow = (key, label, list) => {
    const ts = list.map(q => tsOf(q && q.ts)).filter(t => t != null);
    if (!open || noTws) { feeds.push({ key, label, state: 'off', when: noTws ? 'TWS not connected' : o.connection === 'connecting' ? 'connecting…' : 'stream off' }); return; }
    if (!ts.length) { feeds.push({ key, label, state: 'waiting', when: 'waiting for a tick' }); return; }
    const oldest = Math.min(...ts), age = now - oldest;
    const state = age <= LIVE_MS ? 'live' : (o.marketOpen ? 'stale' : 'done');
    feeds.push({ key, label, state, when: state === 'done' ? `last ${clock(oldest)}` : ago(age), at: oldest });
  };
  streamRow('underlying', 'Underlying', o.underlying ? [o.underlying] : []);
  if (Array.isArray(o.legs) && o.legs.length) streamRow('legs', `Quotes (${o.legs.length} leg${o.legs.length > 1 ? 's' : ''})`, o.legs);

  for (const p of o.pulls || []) {
    const at = tsOf(p.at);
    if (p.busy) feeds.push({ key: p.key, label: p.label, state: 'pulling', when: 'now…' });
    else if (at == null) feeds.push({ key: p.key, label: p.label, state: o.bridge ? 'waiting' : 'off', when: o.bridge ? 'not pulled yet' : 'no bridge' });
    else if (p.fallback) feeds.push({ key: p.key, label: p.label, state: 'fallback', when: `${p.fallback} · ${clock(at)}`, at });
    else feeds.push({ key: p.key, label: p.label, state: o.marketOpen && now - at > STALE_MS ? 'stale' : 'done', when: clock(at), at });
  }
  if (o.whatIf) {
    const w = o.whatIf;
    feeds.push({ key: 'whatif', label: 'What-if margin', state: w === 'busy' ? 'pulling' : w === 'ok' ? 'done' : w === 'err' ? 'stale' : 'waiting',
      when: w === 'busy' ? 'asking…' : w === 'ok' ? 'in' : w === 'err' ? 'no answer' : 'asks on a priced ticket' });
  }

  const has = s => feeds.some(f => f.state === s);
  const stream = feeds.filter(f => f.key === 'underlying' || f.key === 'legs');
  const pulled = feeds.filter(f => f.at != null && f.key !== 'underlying' && f.key !== 'legs');
  const newest = pulled.length ? Math.max(...pulled.map(f => f.at)) : null;
  let state, title, sub;
  if (noTws && !has('pulling')) {
    // The bridge answers but TWS doesn't: say so plainly — what's on the ticket is the last
    // pull (if any), and nothing new can come in until TWS is back.
    state = 'stale'; title = 'Bridge up · TWS not connected';
    sub = newest != null ? `nothing new can arrive — last pull ${clock(newest)}` : 'start TWS or IB Gateway — numbers are yours or the model\'s';
  } else if (has('pulling')) {
    const busy = feeds.filter(f => f.state === 'pulling').map(f => f.label.toLowerCase());
    state = 'receiving'; title = 'Pulling from TWS…'; sub = busy.join(' · ');
  } else if (open && stream.some(f => f.state === 'live')) {
    const liveQ = stream.find(f => f.key === 'legs' && f.state === 'live') || stream.find(f => f.state === 'live');
    state = 'live'; title = 'TWS live';
    sub = [`quotes ${liveQ.when}`, ...pulled.filter(f => f.state === 'done').slice(0, 2).map(f => `${f.label.toLowerCase()} ${f.when}`)].join(' · ');
  } else if (open || newest != null) {
    const ref = stream.find(f => f.at != null) || pulled.find(f => f.at === newest);
    const age = ref ? now - ref.at : null;
    const fb = feeds.find(f => f.state === 'fallback');
    if (fb && !has('stale')) { state = 'stale'; title = `TWS ${fb.when.split(' · ')[0]}`; sub = `${fb.label} came back ${fb.when}`; }
    else if (age != null && (has('stale') || (o.marketOpen && age > STALE_MS))) { state = 'stale'; title = `TWS ${Math.max(1, Math.round(age / 60000))} min old`; sub = `last data ${clock(ref.at)} — prices shown may have moved`; }
    else { state = 'live'; title = open ? 'TWS connected' : 'TWS data in'; sub = newest != null ? `last pull ${clock(newest)}` : 'waiting for the first tick'; }
  } else {
    state = 'offline'; title = 'Typed / model only';
    sub = o.bridge ? 'bridge not connected — numbers are yours or the model\'s' : 'no bridge set — numbers are yours or the model\'s';
  }
  return { state, title, sub, feeds };
}

/**
 * Where one number on the ticket came from: 'tws' (with the time), 'typed', 'target'
 * (the engine's suggested price, not a fill) or 'model'.
 */
export function sourceTag(kind, at) {
  if (kind === 'tws') return { kind, text: at ? `TWS ${clock(tsOf(at))}` : 'TWS' };
  if (kind === 'typed') return { kind, text: 'typed' };
  if (kind === 'target') return { kind, text: 'target' };
  return { kind: 'model', text: 'model' };
}
