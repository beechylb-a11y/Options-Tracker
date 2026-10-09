// Settle shadow verdicts whose expiry has passed (Oct 2026): the underlying's close on
// the expiry date, through the bridge's daily history, prices the held-to-expiry P&L.
// Runs quietly when the Decision Engine opens and on demand from Analytics. Nothing
// is guessed: a record whose close cannot be found stays unsettled for the next pass.
import { api } from './api';
import { closeOn, expiryPassed, pnlAtExpiry } from '../engine/shadow';

function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal })
    .then(r => r.text()).then(t2 => { try { return JSON.parse(t2); } catch (e) { return null; } })
    .catch(() => null).finally(() => clearTimeout(t));
}

const ymdDaysAgo = ymd => {
  const d = new Date(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
};

/** @returns { settled, pending, skipped, error } */
export async function settleShadows(account, { bridgeUrl, now = new Date() } = {}) {
  let url = bridgeUrl;
  if (url == null) { try { url = localStorage.getItem('bridgeUrl') || ''; } catch (e) { url = ''; } }
  let rows;
  try { rows = await api.getShadow(account, { unsettled: true }); } catch (e) { return { settled: 0, pending: 0, error: e.message }; }
  const due = (rows || []).filter(r => r.expiry && expiryPassed(String(r.expiry), now));
  if (!due.length) return { settled: 0, pending: 0 };
  if (!url) return { settled: 0, pending: due.length, error: 'no bridge' };

  const byUnd = new Map();
  due.forEach(r => { if (!byUnd.has(r.underlying)) byUnd.set(r.underlying, []); byUnd.get(r.underlying).push(r); });
  const items = [];
  let skipped = 0;
  for (const [und, list] of byUnd) {
    const oldest = Math.max(...list.map(r => ymdDaysAgo(String(r.expiry))));
    const months = Math.min(12, Math.ceil((oldest + 5) / 30));
    const d = await getJson(`${url}/api/history?underlying=${encodeURIComponent(und)}&barSize=${encodeURIComponent('1 day')}&months=${months}`, 60000);
    const bars = d && Array.isArray(d.bars) ? d.bars : [];
    for (const r of list) {
      const S = closeOn(bars, String(r.expiry));
      const legs = Array.isArray(r.legs) ? r.legs : [];
      const entry = Number(r.entry_net);
      if (S == null || !legs.length || !Number.isFinite(entry)) { skipped++; continue; }
      items.push({ id: r.id, settleDate: String(r.expiry), settlePrice: S, pnlPerCt: pnlAtExpiry(legs, entry, S), source: 'close' });
    }
  }
  let settled = 0;
  if (items.length) {
    try { settled = (await api.settleShadow(items)).settled || 0; } catch (e) { return { settled: 0, pending: due.length, error: e.message }; }
  }
  return { settled, pending: due.length - settled, skipped };
}
