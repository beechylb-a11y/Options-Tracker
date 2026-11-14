import React, { useState } from 'react';
import { Star, ArrowUp, ArrowDown, X, Plus, RefreshCw, Check, AlertTriangle } from 'lucide-react';
import { WATCH_MAX, assetClassOf, cleanSym, validSym, EARNINGS_PENALTY } from '../utils/watchlist';
import { alpha } from '../utils/theme';

// ── Watchlist editor (Nov 2026) ──
// One list for both engines. The two strips at the top are the answer — what each mode
// will scan right now, in order; the table is how you change it.

const C = { green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)', purple: 'var(--c-bc8cff)',
  grey: 'var(--c-8b949e)', text: 'var(--c-e6edf3)', head: 'var(--c-ffffff)', line: 'var(--c-30363d)', sub: 'var(--c-21262d)', panel: 'var(--c-161b22)' };
const MODE = { '0dte': { label: '0DTE', col: 'var(--c-d29922)' }, '45dte': { label: '45DTE', col: 'var(--c-58a6ff)' } };
const CLS = { index: 'Index', etf: 'ETF', stock: 'Stock' };
const fmtYmd = y => { if (!y) return ''; const d = new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)));
  return d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const fmtIso = s => s ? new Date(s + 'T12:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';

function Strip({ mode, rank, ivr, n }) {
  const m = MODE[mode];
  const chip = (sym, on) => {
    const r = ivr && ivr[sym] && ivr[sym].ivr;
    return (
      <span key={sym} title={rank.why[sym] || ''} className="mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 8,
        fontSize: 13, fontWeight: on ? 800 : 500, color: on ? C.head : C.grey, opacity: on ? 1 : 0.65,
        border: `1px solid ${on ? alpha(m.col, '88') : C.line}`, background: on ? alpha(m.col, '18') : 'transparent' }}>
        {rank.why[sym] === 'pinned' && <Star size={11} fill="currentColor" color={m.col} />}{sym}
        {mode === '45dte' && r != null && <span style={{ fontWeight: 700, fontSize: 11.5, color: on ? m.col : C.grey }}>{r}</span>}
        {rank.why[sym] === 'no expiry today' && <span style={{ fontSize: 11 }}>· none today</span>}
      </span>
    );
  };
  return (
    <div data-testid={`wl-strip-${mode}`} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ minWidth: 118, fontSize: 12, fontWeight: 800, letterSpacing: '.05em', color: m.col }}>
        {m.label} SCANS{mode === '45dte' ? <span style={{ fontWeight: 500, color: C.grey }}> · by IVR</span> : <span style={{ fontWeight: 500, color: C.grey }}> · your order</span>}
      </span>
      {rank.scan.length ? rank.scan.map(s => chip(s, true)) : <span style={{ fontSize: 12.5, color: C.grey }}>nothing switched on</span>}
      {rank.rest.length > 0 && <span style={{ color: C.grey, fontSize: 12 }}>· not scanned (top {n} only):</span>}
      {rank.rest.map(s => chip(s, false))}
    </div>
  );
}

function Toggle({ on, onClick, disabled, col, label, testid, title }) {
  return (
    <button data-testid={testid} onClick={onClick} disabled={disabled} title={title} aria-pressed={on}
      style={{ minWidth: 54, padding: '3px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 800, cursor: disabled ? 'not-allowed' : 'pointer',
        color: on ? C.head : C.grey, border: `1px solid ${on ? col : C.line}`, background: on ? alpha(col, '30') : 'transparent', opacity: disabled ? 0.45 : 1 }}>
      {on ? '● ' : '○ '}{label}
    </button>
  );
}

export default function WatchlistPanel({ list, onChange, ivr, chain, earn, rank0, rank45, onRefreshIvr, ivrBusy, ivrAsOf, bridgeUrl, onCheck, saveState }) {
  const [add, setAdd] = useState('');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState('');
  const items = list.items;
  const set = items2 => onChange({ ...list, items: items2 });
  const patch = (i, p) => set(items.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= items.length) return; const a = [...items]; [a[i], a[j]] = [a[j], a[i]]; set(a); };

  async function doAdd() {
    const sym = cleanSym(add);
    setErr('');
    if (!validSym(sym)) { setErr(`“${add}” is not a ticker`); return; }
    if (items.some(x => x.sym === sym)) { setErr(`${sym} is already on the list`); return; }
    if (items.length >= WATCH_MAX) { setErr(`The list holds ${WATCH_MAX} — remove one first`); return; }
    let c = null;
    if (bridgeUrl && onCheck) {
      setAdding(true);
      try { c = await onCheck(sym); } catch (e) { c = { ok: false, error: e.message }; }
      setAdding(false);
      if (c && !c.ok) { setErr(`${sym}: ${c.error || 'no options found'} — not added`); return; }
    }
    set([...items, { sym, on0: !!(c && (c.today || c.dailies)), on45: true, pin: false }]);
    setAdd('');
  }

  return (
    <section data-testid="watchlist-panel" className="card mb-4 fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: C.head }}>Watchlist
          <span className="mono" style={{ fontSize: 13, fontWeight: 500, color: C.grey }}> {items.length}/{WATCH_MAX}</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 12.5, color: C.grey }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>Scan top
            <select data-testid="wl-scan-n" value={list.scanN} onChange={e => onChange({ ...list, scanN: +e.target.value })}
              style={{ padding: '2px 6px', borderRadius: 6, background: 'var(--c-0d1117)', color: C.text, border: `1px solid ${C.line}` }}>
              {[5, 10, 15, 20].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <button onClick={onRefreshIvr} disabled={!bridgeUrl || ivrBusy} title="Re-read IV Rank from the bridge (one request per name)"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 7, border: `1px solid ${C.line}`, color: C.grey, background: 'transparent', cursor: 'pointer' }}>
            <RefreshCw size={12} className={ivrBusy ? 'animate-spin' : ''} /> IVR{ivrAsOf ? ` · ${ivrAsOf}` : ''}
          </button>
          {saveState && <span data-testid="wl-save" style={{ color: saveState === 'saved' ? C.green : saveState === 'error' ? C.red : C.grey }}>
            {saveState === 'saved' ? <><Check size={12} style={{ display: 'inline' }} /> saved</> : saveState === 'error' ? 'not saved' : 'saving…'}</span>}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 10, background: 'var(--c-0d1117)', border: `1px solid ${C.sub}` }}>
        <Strip mode="0dte" rank={rank0} ivr={ivr} n={list.scanN} />
        <Strip mode="45dte" rank={rank45} ivr={ivr} n={list.scanN} />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: C.grey, fontSize: 11.5, letterSpacing: '.05em', textTransform: 'uppercase', textAlign: 'left' }}>
              <th style={{ padding: '4px 6px', width: 56 }}></th><th style={{ padding: '4px 6px' }}>Symbol</th>
              <th style={{ padding: '4px 6px' }}>Scan in</th><th style={{ padding: '4px 6px', minWidth: 130 }}>IV Rank</th>
              <th style={{ padding: '4px 6px' }}>Expiry</th><th style={{ padding: '4px 6px' }}>Earnings</th><th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((x, i) => {
              const cls = assetClassOf(x.sym);
              const ch = chain[x.sym];
              const r = ivr[x.sym];
              const no0 = ch && ch.ok && ch.today === false && !ch.dailies;
              const e = earn[x.sym];
              const rv = r && r.ivr != null ? r.ivr : null;
              const rc = rv == null ? C.grey : rv >= 50 ? C.green : rv >= 30 ? C.amber : C.grey;
              return (
                <tr key={x.sym} data-testid={`wl-row-${x.sym}`} style={{ borderTop: `1px solid ${C.sub}` }}>
                  <td style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>
                    <button onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${x.sym} up`} style={{ color: C.grey, opacity: i === 0 ? 0.3 : 1, background: 'none', border: 0, cursor: 'pointer' }}><ArrowUp size={14} /></button>
                    <button onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label={`Move ${x.sym} down`} style={{ color: C.grey, opacity: i === items.length - 1 ? 0.3 : 1, background: 'none', border: 0, cursor: 'pointer' }}><ArrowDown size={14} /></button>
                  </td>
                  <td style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>
                    <button data-testid={`wl-pin-${x.sym}`} onClick={() => patch(i, { pin: !x.pin })} title={x.pin ? 'Pinned — always scanned' : 'Pin: always in the top list'}
                      style={{ background: 'none', border: 0, cursor: 'pointer', verticalAlign: 'middle', color: x.pin ? C.amber : C.grey }}>
                      <Star size={15} fill={x.pin ? 'currentColor' : 'none'} />
                    </button>
                    <span className="mono" style={{ fontWeight: 800, fontSize: 15, color: C.head, marginLeft: 4 }}>{x.sym}</span>
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 700, padding: '1px 6px', borderRadius: 5, color: C.grey, border: `1px solid ${C.line}` }}>{CLS[cls]}</span>
                  </td>
                  <td style={{ padding: '6px 6px', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Toggle testid={`wl-0-${x.sym}`} on={x.on0 && !no0} disabled={no0} col={MODE['0dte'].col} label="0DTE"
                        title={no0 ? `No daily expiries — next ${fmtYmd(ch.next)}` : 'Scan for same-day trades'} onClick={() => patch(i, { on0: !x.on0 })} />
                      <Toggle testid={`wl-45-${x.sym}`} on={x.on45} col={MODE['45dte'].col} label="45DTE" onClick={() => patch(i, { on45: !x.on45 })} />
                    </span>
                  </td>
                  <td style={{ padding: '6px 6px' }}>
                    {rv != null ? (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }} title={`IV ${r.iv}% · 1-year range ${r.low}–${r.high}% · percentile ${r.ivPctl}`}>
                        <span style={{ position: 'relative', width: 70, height: 6, borderRadius: 3, background: C.sub }}>
                          <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${rv}%`, borderRadius: 3, background: rc }} />
                        </span>
                        <b className="mono" style={{ color: rc }}>{rv}</b>
                      </span>
                    ) : <span style={{ color: C.grey }}>{!x.on45 ? <span title="IV Rank is read for 45DTE names only">—</span>
                      : r && r.error ? <span title={r.error}>—</span> : bridgeUrl ? '…' : '—'}</span>}
                  </td>
                  <td className="mono" style={{ padding: '6px 6px', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {!ch ? <span style={{ color: C.grey }}>{bridgeUrl ? '…' : '—'}</span>
                      : !ch.ok ? <span style={{ color: C.red }}><AlertTriangle size={12} style={{ display: 'inline' }} /> no options</span>
                      : ch.today ? <span style={{ color: C.green }}>✓ today</span>
                      : <span style={{ color: C.grey }}>next {fmtYmd(ch.next)}</span>}
                  </td>
                  <td style={{ padding: '6px 6px', whiteSpace: 'nowrap', fontSize: 12.5 }}>
                    {cls !== 'stock' ? <span style={{ color: C.grey }}>—</span>
                      : e ? <span title={x.on45 && !x.pin ? `Ranks ${EARNINGS_PENALTY} IVR points lower for 45DTE` : ''} style={{ fontWeight: 700, color: C.amber }}>{fmtIso(e)}{x.pin ? '' : ` · −${EARNINGS_PENALTY}`}</span>
                      : <span style={{ color: C.grey }}>none in 45d</span>}
                  </td>
                  <td style={{ padding: '6px 6px', textAlign: 'right' }}>
                    <button onClick={() => set(items.filter((_, j) => j !== i))} aria-label={`Remove ${x.sym}`} title="Remove"
                      style={{ background: 'none', border: 0, cursor: 'pointer', color: C.grey }}><X size={15} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input data-testid="wl-add" value={add} onChange={e => setAdd(e.target.value.toUpperCase())} onKeyDown={e => { if (e.key === 'Enter') doAdd(); }}
          placeholder={items.length >= WATCH_MAX ? 'List full' : 'Add a ticker'} disabled={items.length >= WATCH_MAX || adding}
          className="mono" style={{ width: 140, padding: '6px 10px', borderRadius: 8, background: 'var(--c-0d1117)', color: C.text, border: `1px solid ${C.line}` }} />
        <button data-testid="wl-add-btn" onClick={doAdd} disabled={!add || adding || items.length >= WATCH_MAX}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 8, fontWeight: 700, color: '#fff', background: 'var(--c-1f6feb)', border: 0, cursor: 'pointer', opacity: !add || adding ? 0.6 : 1 }}>
          <Plus size={14} /> {adding ? 'Checking…' : 'Add'}
        </button>
        {err && <span style={{ fontSize: 12.5, color: C.red }}>{err}</span>}
        {!err && <span style={{ fontSize: 12, color: C.grey }}>Checked with the bridge: options listed, expiry today. Shared across accounts and devices.</span>}
      </div>
    </section>
  );
}
