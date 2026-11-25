import React, { useEffect, useMemo, useState } from 'react';
import { useLiveQuotesEvery } from '../live/streamQuotes';
import { api } from '../utils/api';
import { quoteHealth, barHealth, settleHealth, healthHeadline, FULL_DAY_BARS } from '../utils/dataHealth';

// Data health (Nov 2026, review recommendation 4): every streamed line, the latest
// session's bars per underlying and the settle coverage of the shadow verdicts, with the
// worst failure named first. Bars are pulled on request only (TWS paces history).

const C = { green: 'var(--c-3fb950)', amber: 'var(--c-e3b341)', red: 'var(--c-f85149)', muted: 'var(--c-a8b2be)', faint: 'var(--c-8b949e)', ink: 'var(--c-e6edf3)' };
const TONE = { ok: C.green, warn: C.amber, bad: C.red };
const STATE_WORD = { live: 'Live', frozen: 'Last value', delayed: 'Delayed', stale: 'Stale', off: 'Off', notListed: 'Not listed', notEntitled: 'Not entitled', blocked: 'Blocked' };
const H = { 'ngrok-skip-browser-warning': '1' };
const bridgeUrlOf = () => { try { return (localStorage.getItem('bridgeUrl') || '').replace(/\/+$/, ''); } catch (e) { return ''; } };
const BAR_SKIP = /^VIX/;          // the vol indexes feed the vol watch, not bar-based reads
const ageTxt = ms => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)} s` : ms < 5400000 ? `${Math.round(ms / 60000)} min` : `${Math.round(ms / 3600000)} h`);
const ymdTxt = s => (s ? `${s.slice(6, 8)}/${s.slice(4, 6)}` : '');

// Bar checks survive leaving the page; they are minutes old at worst and cost TWS pacing.
let barCache = { at: 0, bars: {} };

function Dot({ tone }) {
  return <span aria-hidden="true" className="inline-block rounded-full" style={{ width: 9, height: 9, background: TONE[tone] || C.faint }} />;
}

export default function DataHealthPanel({ fetchHistory, now: nowProp, shadowRows }) {
  const state = useLiveQuotesEvery(5000);
  const [, setTick] = useState(0);
  useEffect(() => { if (nowProp) return undefined; const id = setInterval(() => setTick(t => t + 1), 15000); return () => clearInterval(id); }, [nowProp]);
  const now = nowProp || Date.now();
  const q = quoteHealth(state, { now });
  const [bars, setBars] = useState(barCache);
  const [busy, setBusy] = useState('');
  const [rows, setRows] = useState(shadowRows || null);
  useEffect(() => {
    if (shadowRows) return undefined;
    let dead = false;
    // Through a promise, so a missing or failing API reads as no rows, not a crash.
    Promise.resolve().then(() => api.getShadow('all')).then(d => { if (!dead) setRows(Array.isArray(d) ? d : []); }).catch(() => { if (!dead) setRows([]); });
    return () => { dead = true; };
  }, [shadowRows]);
  const settle = useMemo(() => (rows ? settleHealth(rows, { now: new Date(now) }) : null), [rows, now]);
  const head = healthHeadline(q, bars.bars, settle);
  const syms = q.rows.map(r => r.key).filter(k => !BAR_SKIP.test(k));

  async function checkBars() {
    const url = bridgeUrlOf();
    const get = fetchHistory || (async sym => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      try {
        const r = await fetch(`${url}/api/history?underlying=${encodeURIComponent(sym)}&barSize=${encodeURIComponent('5 mins')}&months=1`, { headers: H, signal: ctrl.signal });
        const d = await r.json();
        return Array.isArray(d && d.bars) ? d.bars : [];
      } finally { clearTimeout(t); }
    });
    if (!fetchHistory && !url) return;
    const out = {};
    for (const s of syms) {
      setBusy(`Checking ${s}…`);
      try { out[s] = barHealth(await get(s), { now: new Date(nowProp || Date.now()) }) || { tone: 'bad', text: 'no bars came back', count: 0, expected: FULL_DAY_BARS }; }
      catch (e) { out[s] = { tone: 'bad', text: 'the bridge did not answer', count: 0, expected: FULL_DAY_BARS }; }
    }
    barCache = { at: Date.now(), bars: out };
    setBars(barCache);
    setBusy('');
  }

  const legStates = Object.entries(q.legs.byState);
  return (
    <div data-testid="data-health">
      <div className="flex items-center gap-3 flex-wrap rounded-xl px-4 py-3 mb-4" data-testid="health-head" data-tone={head.tone}
        style={{ boxShadow: `inset 4px 0 0 ${TONE[head.tone]}`, background: 'rgba(0,0,0,0.12)' }}>
        <Dot tone={head.tone} />
        <span className="text-[15px] font-semibold" style={{ color: C.ink }}>{head.text}</span>
        {head.items.length > 1 && <span className="text-[12.5px] w-full pl-5" style={{ color: C.muted }}>{head.items.slice(1, 5).join(' · ')}</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div data-testid="health-quotes">
          <div className="text-[13px] font-semibold mb-1" style={{ color: C.ink }}>Streamed lines {q.marketOpen ? '· market open' : '· market closed'}</div>
          {!q.rows.length && <div className="text-[13px]" style={{ color: C.faint }}>{q.bridge === 'ok' ? 'Nothing streaming.' : 'No stream from the bridge.'}</div>}
          <table className="w-full text-[13px]">
            <tbody>
              {q.rows.map(r => (
                <tr key={r.key} data-testid="health-quote" data-tone={r.tone} title={r.note} style={{ borderTop: '1px solid var(--c-21262d)' }}>
                  <td className="py-1 pr-2"><Dot tone={r.tone} /></td>
                  <td className="pr-2 font-semibold mono">{r.key}</td>
                  <td className="pr-2" style={{ color: r.tone === 'ok' ? C.muted : TONE[r.tone] }}>{STATE_WORD[r.state] || r.state}</td>
                  <td className="text-right num" style={{ color: C.faint }}>{ageTxt(r.age)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.legs.n > 0 && (
            <div className="text-[12.5px] mt-2" style={{ color: q.legs.bad.length ? C.red : C.muted }} data-testid="health-legs">
              Option legs: {q.legs.n} — {legStates.map(([k, n]) => `${n} ${(STATE_WORD[k] || k).toLowerCase()}`).join(', ')}
            </div>
          )}
          {q.rows.filter(r => r.tone !== 'ok').map(r => <div key={r.key} className="text-[12px] mt-1" style={{ color: C.faint }}>{r.key}: {r.note}</div>)}
        </div>

        <div data-testid="health-bars">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[13px] font-semibold" style={{ color: C.ink }}>5-minute bars, latest session</span>
            <button type="button" onClick={checkBars} disabled={!!busy || !syms.length} data-testid="health-check-bars"
              className="ml-auto text-[12.5px] px-3 py-1 rounded-full border border-bg-border hover:bg-bg-hover disabled:opacity-50">{busy || 'Check bars'}</button>
          </div>
          {!Object.keys(bars.bars).length ? (
            <div className="text-[13px]" style={{ color: C.faint }}>A full day is {FULL_DAY_BARS} bars from 09:30 New York. Pulls a month of bars per underlying from TWS, one at a time.</div>
          ) : (
            <table className="w-full text-[13px]">
              <tbody>
                {Object.entries(bars.bars).map(([s, b]) => (
                  <tr key={s} data-testid="health-bar" data-tone={b.tone} style={{ borderTop: '1px solid var(--c-21262d)' }}>
                    <td className="py-1 pr-2 align-top"><Dot tone={b.tone} /></td>
                    <td className="pr-2 font-semibold mono align-top">{s}</td>
                    <td className="pr-2 num align-top" style={{ color: C.muted }}>{b.ymd ? ymdTxt(b.ymd) : ''}</td>
                    <td style={{ color: b.tone === 'ok' ? C.muted : TONE[b.tone] }} title={b.zone ? `bar stamps: ${b.zone}` : undefined}>{b.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {bars.at > 0 && <div className="text-[12px] mt-1" style={{ color: C.faint }}>Checked {new Date(bars.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>}
        </div>

        <div data-testid="health-settle">
          <div className="text-[13px] font-semibold mb-1" style={{ color: C.ink }}>Shadow verdict settles</div>
          {!settle ? <div className="text-[13px]" style={{ color: C.faint }}>Loading…</div> : (
            <>
              <div className="flex items-baseline gap-2">
                <Dot tone={settle.tone} />
                <span className="num text-[22px] font-semibold" style={{ color: C.ink }}>{settle.due ? `${settle.settled} / ${settle.due}` : '—'}</span>
                <span className="text-[12.5px]" style={{ color: C.muted }}>past expiry settled</span>
              </div>
              <div className="text-[12.5px] mt-1" style={{ color: settle.tone === 'ok' ? C.muted : TONE[settle.tone] }} data-testid="health-settle-text">{settle.text}</div>
              {settle.pending.length > 0 && (
                <table className="w-full text-[13px] mt-2">
                  <tbody>
                    {settle.pending.map(g => (
                      <tr key={g.underlying} style={{ borderTop: '1px solid var(--c-21262d)' }}>
                        <td className="py-1 pr-2 font-semibold mono">{g.underlying}</td>
                        <td className="pr-2 num">{g.n}</td>
                        <td style={{ color: C.faint }}>oldest {ymdTxt(g.oldest)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {settle.pending.length > 0 && <div className="text-[12px] mt-1" style={{ color: C.faint }}>Settle from Analytics › Engine verdicts › Settle expired. An underlying that stays here has no bars from the bridge.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
