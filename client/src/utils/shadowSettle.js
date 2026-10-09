// Settle shadow verdicts (Oct 2026). Two outcomes, each written once:
//   held     — the underlying's close on the expiry date prices the legs at expiry
//              (entry commission only; nothing to pay at expiry)
//   managed  — the strategy's target / 100% stop / planned time exit along the
//              actual path: 0DTE on the expiry day's 5-min bars, 45DTE on daily
//              closes to the planned close (see engine/managed.js)
// Runs quietly when the Decision Engine opens and on demand from Analytics. Nothing
// is guessed: a record whose bars cannot be found stays pending for the next pass.
import { api } from './api';
import { closeOn, expiryPassed, pnlAtExpiry } from '../engine/shadow';
import { managed0, managed45, commissionPerCt } from '../engine/managed';

function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
    .then(r => r.text()).then(t2 => { try { return JSON.parse(t2); } catch (e) { return null; } })
    .catch(() => null).finally(() => clearTimeout(t));
}

const daysAgo = ymd => {
  const s = String(ymd || '').replace(/-/g, '');
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
};
const monthsFor = rows => Math.min(12, Math.max(1, Math.ceil((Math.max(...rows.map(r => Math.max(daysAgo(r.expiry), daysAgo(r.session_date)))) + 5) / 30)));

/** @returns { settled, pending, skipped, error } */
export async function settleShadows(account, { bridgeUrl, now = new Date() } = {}) {
  let url = bridgeUrl;
  if (url == null) { try { url = localStorage.getItem('bridgeUrl') || ''; } catch (e) { url = ''; } }
  let rows;
  try { rows = await api.getShadow(account, { unsettled: true }); } catch (e) { return { settled: 0, pending: 0, error: e.message }; }
  rows = rows || [];
  const heldDue = rows.filter(r => !r.settled_at && r.expiry && expiryPassed(String(r.expiry), now));
  const man0Due = rows.filter(r => !r.managed_at && r.engine === '0DTE' && r.expiry && expiryPassed(String(r.expiry), now));
  const man45 = rows.filter(r => !r.managed_at && r.engine === '45DTE');
  const due = new Set([...heldDue, ...man0Due].map(r => r.id));
  if (!heldDue.length && !man0Due.length && !man45.length) return { settled: 0, pending: 0 };
  if (!url) return { settled: 0, pending: due.size, error: 'no bridge' };

  const items = new Map();
  const item = id => { if (!items.has(id)) items.set(id, { id }); return items.get(id); };
  let skipped = 0;

  // Daily closes: held outcomes and 45DTE managed.
  const dailyNeed = [...heldDue, ...man45];
  const dailyBy = new Map();
  dailyNeed.forEach(r => { if (!dailyBy.has(r.underlying)) dailyBy.set(r.underlying, []); dailyBy.get(r.underlying).push(r); });
  for (const [und, list] of dailyBy) {
    const d = await getJson(`${url}/api/history?underlying=${encodeURIComponent(und)}&barSize=${encodeURIComponent('1 day')}&months=${monthsFor(list)}`, 60000);
    const bars = d && Array.isArray(d.bars) ? d.bars : [];
    for (const r of list) {
      const legs = Array.isArray(r.legs) ? r.legs : [];
      const entry = Number(r.entry_net);
      if (!r.settled_at && heldDue.includes(r)) {
        const S = closeOn(bars, String(r.expiry));
        if (S == null || !legs.length || !Number.isFinite(entry)) skipped++;
        else {
          const comm = commissionPerCt(legs, 1);
          Object.assign(item(r.id), { settleDate: String(r.expiry), settlePrice: S,
            pnlPerCt: Math.round((pnlAtExpiry(legs, entry, S) - comm) * 100) / 100, commission: comm, source: 'close-net' });
        }
      }
      if (r.engine === '45DTE' && !r.managed_at) {
        const m = managed45(r, bars, now);
        if (m) item(r.id).managed = m;
      }
    }
  }

  // 5-min bars: 0DTE managed, one request per underlying.
  const intraBy = new Map();
  man0Due.forEach(r => { if (!intraBy.has(r.underlying)) intraBy.set(r.underlying, []); intraBy.get(r.underlying).push(r); });
  for (const [und, list] of intraBy) {
    const d = await getJson(`${url}/api/history?underlying=${encodeURIComponent(und)}&barSize=${encodeURIComponent('5 mins')}&months=${Math.min(3, monthsFor(list))}`, 90000);
    const bars = d && Array.isArray(d.bars) ? d.bars : [];
    for (const r of list) {
      const m = managed0(r, bars);
      if (m) item(r.id).managed = m; else skipped++;
    }
  }

  const list = [...items.values()].filter(it => it.pnlPerCt != null || it.managed);
  let settled = 0;
  if (list.length) {
    try { settled = (await api.settleShadow(list)).settled || 0; } catch (e) { return { settled: 0, pending: due.size, error: e.message }; }
  }
  return { settled, pending: Math.max(0, due.size - list.length), skipped };
}
