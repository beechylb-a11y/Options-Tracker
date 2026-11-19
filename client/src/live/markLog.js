// ── Daily P&L marks per open ticket (Nov 2026) ──
//
// The position tile colours each day of a trade by how it stood: green while up, red
// while under water. Nothing on the server keeps a mark per day yet, so this browser
// keeps one: the last live position P&L it saw each New York trading day, per ticket.
// Days this browser never saw stay uncoloured (they draw in the trade's status colour).
// Kept for 120 days; small (a number per ticket per day).

const KEY = 'sb.marklog.v1';
const KEEP_DAYS = 120;

function read() {
  try { const o = JSON.parse(localStorage.getItem(KEY) || '{}'); return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}
function write(o) {
  try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* storage full or blocked: marks are a nicety */ }
}
const ymdNum = y => Number(String(y).replace(/-/g, ''));
function cutoff(todayYmd) {
  const t = String(todayYmd);
  const d = new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) - KEEP_DAYS * 864e5);
  return Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
}

/** Record the position P&L of each priced row for today. rows: [{ key, posPnl }]. */
export function recordMarks(rows, todayYmd) {
  const priced = (rows || []).filter(r => r && r.key != null && r.posPnl != null && isFinite(r.posPnl));
  if (!priced.length || !todayYmd) return;
  const o = read(), cut = cutoff(todayYmd);
  let changed = false;
  for (const r of priced) {
    const k = String(r.key), v = Math.round(r.posPnl);
    const day = (o[k] = o[k] || {});
    if (day[todayYmd] !== v) { day[todayYmd] = v; changed = true; }
    for (const y of Object.keys(day)) if (ymdNum(y) < cut) { delete day[y]; changed = true; }
  }
  if (changed) write(o);
}

/** { yyyymmdd: pnl } for one ticket. */
export function marksFor(key) {
  return read()[String(key)] || {};
}
