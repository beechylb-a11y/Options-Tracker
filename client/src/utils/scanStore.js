// Decision Engine scans survive leaving the page and a browser refresh (Nov 2026).
//
// Only the scan's inputs are kept — the list it scanned, the data it pulled, when,
// and the per-symbol notes — and the results are recomputed from them on load with
// the same computeScan the scan used. A scan older than KEEP_MS is dropped: the page
// already asks for a re-run after 15 min, and yesterday's numbers are not a scan.
import { computeScan } from './multiScan';

export const SCANS_KEY = 'ot-engine-scans-v1';
export const KEEP_MS = 16 * 60 * 60 * 1000;

const slim = s => ({ list: s.list || Object.keys(s.manualData || {}), meta: s.meta || {}, scannedAt: s.scannedAt || null,
  manualData: s.manualData || {}, ...(s.empty ? { empty: true } : {}) });

export function saveScans(scans, storage = globalThis.localStorage) {
  try {
    const out = {};
    Object.entries(scans || {}).forEach(([g, s]) => { if (s && s.scannedAt) out[g] = slim(s); });
    storage.setItem(SCANS_KEY, JSON.stringify(out));
    return true;
  } catch (e) { return false; }   // private window or over quota: the scans stay in memory
}

export function loadScans({ now = Date.now(), storage = globalThis.localStorage } = {}) {
  let raw;
  try { raw = JSON.parse(storage.getItem(SCANS_KEY) || 'null'); } catch (e) { raw = null; }
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  Object.entries(raw).forEach(([g, s]) => {
    const t = s && s.scannedAt ? Date.parse(s.scannedAt) : NaN;
    if (!Number.isFinite(t) || now - t > KEEP_MS) return;
    const mode = g.split('|')[0];
    try {
      const list = Array.isArray(s.list) ? s.list : Object.keys(s.manualData || {});
      out[g] = { ...slim({ ...s, list }), results: s.empty ? [] : computeScan(mode, list, s.manualData || {}), restored: true };
    } catch (e) { /* a scan that no longer computes is dropped, not shown broken */ }
  });
  return out;
}
