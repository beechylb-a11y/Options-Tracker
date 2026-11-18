/* Engine scans survive leaving the page and a refresh (Nov 2026). */
import { describe, it, expect } from 'vitest';
import { saveScans, loadScans, SCANS_KEY, KEEP_MS } from '../utils/scanStore';
import { computeScan } from '../utils/multiScan';

const mem = () => { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };
const data = { SPX: { price: '7410', high: '7421', low: '7398', vwap5: '7409', em: '38', atr: '61', vix: '15.8', vix1d: '12.9', priorDayClose: '7398', cashOpen: '7400' },
  XSP: { price: '741', high: '742.1', low: '739.8', vwap5: '740.9', em: '3.8', atr: '6.1', vix: '15.8', vix1d: '12.9' } };

describe('scan store', () => {
  it('keeps the inputs and recomputes the same results on load', () => {
    const st = mem();
    const at = new Date('2026-11-18T15:00:00Z');
    const results = computeScan('0dte', ['SPX', 'XSP'], data);
    expect(saveScans({ '0dte|index': { results, meta: { SPX: { src: 'bridge' } }, scannedAt: at.toISOString(), manualData: data, list: ['SPX', 'XSP'] } }, st)).toBe(true);
    const saved = JSON.parse(st.m[SCANS_KEY]);
    expect(saved['0dte|index'].results).toBeUndefined();          // only inputs are stored
    const back = loadScans({ now: at.getTime() + 60000, storage: st });
    expect(back['0dte|index'].restored).toBe(true);
    expect(back['0dte|index'].meta).toEqual({ SPX: { src: 'bridge' } });
    expect(back['0dte|index'].results.map(r => r.underlying)).toEqual(results.map(r => r.underlying));
    expect(back['0dte|index'].results.map(r => r.result && r.result.setupScore)).toEqual(results.map(r => r.result && r.result.setupScore));
  });
  it('drops scans older than the keep window, empty-list scans keep their flag, and bad storage reads as none', () => {
    const st = mem();
    const old = new Date(Date.now() - KEEP_MS - 1000).toISOString();
    saveScans({ '0dte|index': { scannedAt: old, manualData: data, list: ['SPX'] }, '45dte|stock': { scannedAt: new Date().toISOString(), empty: true, list: [] } }, st);
    const back = loadScans({ storage: st });
    expect(back['0dte|index']).toBeUndefined();
    expect(back['45dte|stock']).toMatchObject({ empty: true, results: [] });
    expect(loadScans({ storage: { getItem: () => '{bad json' } })).toEqual({});
    expect(saveScans({ x: { scannedAt: 'now' } }, { setItem: () => { throw new Error('quota'); } })).toBe(false);
  });
});
