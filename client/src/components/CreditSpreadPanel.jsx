import React, { useEffect, useState, useCallback } from 'react';
import { TrendingUp, TrendingDown, Minus, Clock, RefreshCw, AlertTriangle } from 'lucide-react';
import { emaStack, firstHour, entryWindow, creditPlan, rangeLeft } from '../engine/creditSide';
import { nyMinutes } from '../engine/review0';
import { alpha } from '../utils/theme';

// ── Credit spread, on purpose (Nov 2026) ──
// A 0DTE credit vertical the trader can build whatever structure the engine picked:
// the side and the strike distance come from creditSide.js (the replay's rules), the
// width and the 25% / 50% target from calc0dte as before. Pictures first: three trend
// tiles, the IVX now against its first read, two buttons.

const C = { green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)', grey: 'var(--c-8b949e)',
  text: 'var(--c-e6edf3)', head: 'var(--c-ffffff)', line: 'var(--c-30363d)', panel: 'var(--c-161b22)' };
const TONE = { green: C.green, amber: C.amber, red: C.red, grey: C.grey };
const PROXY = { SPX: 'SPY', XSP: 'SPY', RUT: 'IWM', NDX: 'QQQ' };
const HDR = { headers: { 'ngrok-skip-browser-warning': '1' } };

function nyYmd(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}`;
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

async function history(bridgeUrl, und, barSize, months) {
  const u = `${bridgeUrl}/api/history?underlying=${encodeURIComponent(und)}&barSize=${encodeURIComponent(barSize)}&months=${months}`;
  const r = await fetch(u, HDR);
  const j = await r.json();
  return Array.isArray(j.bars) ? j.bars : [];
}
const toDaily = bars => bars.map(b => [String(b.date).replace(/\D/g, '').slice(0, 8), +b.open, +b.high, +b.low, +b.close]);

/** Daily EMA stack (cached per underlying per day — it is as of yesterday's close) and today's first hour. */
function useTrendRead(underlying, bridgeUrl) {
  const [state, setState] = useState({ ema: null, first: null, busy: false, err: null });
  const load = useCallback(async (force) => {
    if (!bridgeUrl || !underlying) return;
    const ymd = nyYmd(), mins = nyMinutes();
    setState(s => ({ ...s, busy: true, err: null }));
    let ema = null, first = null, err = null;
    try {
      const key = `emaStack:${underlying}:${ymd}`;
      ema = !force && store.get(key);
      if (!ema) {
        let bars = await history(bridgeUrl, underlying, '1 day', 4).catch(() => []);
        let src = underlying;
        if (bars.length < 60 && PROXY[underlying]) { src = PROXY[underlying]; bars = await history(bridgeUrl, src, '1 day', 4).catch(() => []); }
        ema = emaStack(toDaily(bars), ymd);
        if (ema) { ema.source = src; store.set(key, ema); }
      }
    } catch (e) { err = e.message; }
    try {
      if (mins >= 570) {
        let bars = await history(bridgeUrl, underlying, '30 mins', 1).catch(() => []);
        if (!bars.length && PROXY[underlying]) bars = await history(bridgeUrl, PROXY[underlying], '30 mins', 1).catch(() => []);
        first = firstHour(bars, mins);
      }
    } catch (e) { err = err || e.message; }
    setState({ ema: ema || null, first, busy: false, err });
  }, [underlying, bridgeUrl]);
  useEffect(() => { load(false); }, [load]);
  // Until the first hour is in, look again every five minutes.
  useEffect(() => {
    if (state.first && state.first.done) return undefined;
    const id = setInterval(() => { const m = nyMinutes(); if (m >= 570 && m < 960) load(false); }, 5 * 60 * 1000);
    return () => clearInterval(id);
  }, [load, state.first]);
  return { ...state, reload: () => load(true) };
}

/** IVX now against the first read of the day, remembered per underlying per day. */
function useIvxTrack(underlying, ivx, live) {
  const ymd = nyYmd();
  const key = `ivxTrack:${underlying}:${ymd}`;
  const [first, setFirst] = useState(() => store.get(key));
  useEffect(() => {
    if (!live || !(ivx > 0)) return;
    const prev = store.get(key);
    if (!prev) { const v = { ivx, nyMin: nyMinutes() }; store.set(key, v); setFirst(v); }
    else setFirst(prev);
  }, [key, ivx, live]);
  return first;
}

function Tile({ label, icon: Icon, word, sub, tone, testid, title }) {
  const col = TONE[tone] || C.grey;
  return (
    <div data-testid={testid} title={title} style={{ flex: '1 1 150px', minWidth: 140, padding: '10px 12px', borderRadius: 10, border: `1px solid ${alpha(col, '55')}`, background: alpha(col, '12') }}>
      <div style={{ fontSize: 11.5, letterSpacing: '.06em', textTransform: 'uppercase', color: C.grey }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, color: col, fontWeight: 800, fontSize: 17 }}>
        {Icon && <Icon size={17} />}<span className="mono">{word}</span>
      </div>
      {sub && <div className="mono" style={{ fontSize: 11.5, color: C.grey, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function CreditSpreadPanel({ r, price, underlying, bridgeUrl, currentStrat, currentVariant, onBuild, previewLegs }) {
  const t = useTrendRead(underlying, bridgeUrl);
  const mins = nyMinutes();
  const win = entryWindow(mins);
  const plan = creditPlan({ ema: t.ema, first: t.first });
  const ivx = r && r.ivxEM > 0 ? r.ivxEM : null;
  const live = !!(r && r.emIsStraddle);
  const ivxFirst = useIvxTrack(underlying, ivx, live);
  const h = (mins - 570) / 60;
  const p = Number(price) || 0;
  const step = p >= 1000 ? 5 : p >= 100 ? 1 : 0.5;
  const v1dDist = r && r.em365V1D > 0 ? r.em365V1D * Math.min(1.07, rangeLeft(h) / rangeLeft(0.5)) : null;
  const distOf = a => a === 'em1d' ? v1dDist : ivx;
  const shortOf = (side, a) => {
    // Same construction as calc0dte: the anchor distance plus the pullback buffer (a share
    // of the IVX EM once the day has used >40% of its move), rounded to the grid.
    const d = distOf(a);
    if (!(p > 0) || !(d > 0)) return null;
    const buf = (ivx || 0) * (r && r.pullbackFrac > 0 ? Math.min(0.4, r.pullbackFrac) : 0);
    const k = Math.round((side === 'put' ? p - d - buf : p + d + buf) / step) * step;
    return +k.toFixed(step < 1 ? 1 : 0);
  };
  const w = r && r.creditW > 0 ? r.creditW : null;

  // Trend tiles
  const e = t.ema;
  const emaTile = e
    ? { word: e.stack === 'up' ? 'UP' : e.stack === 'down' ? 'DOWN' : 'MIXED', tone: e.stack === 'up' ? 'green' : e.stack === 'down' ? 'red' : 'amber',
        icon: e.stack === 'up' ? TrendingUp : e.stack === 'down' ? TrendingDown : Minus,
        sub: `EMA 5/21/50${e.source && e.source !== underlying ? ' · ' + e.source : ''}`,
        title: `EMA5 ${e.e5.toFixed(2)} · EMA21 ${e.e21.toFixed(2)} · EMA50 ${e.e50.toFixed(2)} (yesterday's close)` }
    : { word: t.busy ? '…' : '—', tone: 'grey', sub: bridgeUrl ? 'EMA 5/21/50 · daily' : 'bridge not set' };
  const f = t.first;
  const fhTile = f
    ? { word: `${f.movePct >= 0 ? '+' : ''}${f.movePct.toFixed(2)}%`, tone: !f.done ? 'grey' : f.dir === 'up' ? 'green' : f.dir === 'down' ? 'red' : 'amber',
        icon: f.dir === 'up' ? TrendingUp : f.dir === 'down' ? TrendingDown : Minus, sub: f.done ? `09:30 → 10:30 · ${f.dir}` : 'in progress' }
    : { word: mins < 570 ? 'pre-open' : t.busy ? '…' : '—', tone: 'grey', sub: '09:30 → 10:30' };
  const vw = r && r.aboveVWAP != null && r.vwapDiff !== 0
    ? { word: r.aboveVWAP ? 'ABOVE' : 'BELOW', tone: r.slopeDirection === 'rising' ? 'green' : r.slopeDirection === 'falling' ? 'red' : 'amber',
        icon: r.slopeDirection === 'rising' ? TrendingUp : r.slopeDirection === 'falling' ? TrendingDown : Minus,
        sub: `VWAP ${r.slope || 'flat'}${/^(SPX|XSP)$/.test(underlying) ? ' · SPY' : ''}` }
    : { word: '—', tone: 'grey', sub: 'VWAP' };

  const btn = side => {
    const isPut = side === 'put';
    const name = isPut ? 'Bull put spread' : 'Bear call spread';
    const blocked = !isPut && plan.blocked.call;
    const suggested = plan.side === side && !blocked;
    const onTicket = currentStrat === name && (currentVariant || 'engine') === plan.anchor;
    // The engine's own strikes for this side and anchor when it can give them; the
    // estimate below only when it can't (marked ~).
    const eng = previewLegs ? previewLegs(side, plan.anchor) : null;
    const engShort = eng && eng.find(l => /short/i.test(l.label || ''));
    const engLong = eng && eng.find(l => l !== engShort);
    const k = engShort ? engShort.strike : shortOf(side, plan.anchor);
    const kLong = engLong ? engLong.strike : (k != null && w ? +(isPut ? k - w : k + w).toFixed(1) : null);
    const approx = !engShort && k != null;
    const col = blocked ? C.red : suggested ? C.green : C.blue;
    return (
      <button key={side} data-testid={`credit-${side}`} disabled={!onBuild}
        onClick={() => { if (blocked && !window.confirm(`${blocked}\n\nBuild the call spread anyway?`)) return; onBuild && onBuild(side, plan.anchor); }}
        style={{ flex: '1 1 220px', textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer', color: C.text,
          border: `${suggested ? 2 : 1}px solid ${blocked ? alpha(C.red, '88') : suggested ? C.green : C.line}`, background: alpha(col, suggested || blocked ? '14' : '08') }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 7, fontWeight: 800, fontSize: 16, color: C.head }}>
            {isPut ? <TrendingUp size={17} color={C.green} /> : <TrendingDown size={17} color={C.red} />}{isPut ? 'Put spread' : 'Call spread'}
          </span>
          {blocked ? <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, fontWeight: 800, color: C.red }}><AlertTriangle size={13} />NOT ADVISED</span>
            : onTicket ? <span style={{ fontSize: 11.5, fontWeight: 800, color: C.blue }}>ON THE TICKET</span>
            : suggested ? <span style={{ fontSize: 11.5, fontWeight: 800, color: C.green }}>SUGGESTED</span> : null}
        </div>
        <div className="mono" style={{ marginTop: 6, fontSize: 13, color: C.text }}>
          {k != null ? <>{approx ? '~' : ''}short <b>{k}</b>{kLong != null ? ` · long ${kLong}` : ''}</> : 'strikes on build'}
        </div>
        <div style={{ marginTop: 3, fontSize: 12, color: C.grey }}>{isPut ? 'profits above the short' : 'profits below the short'} · {plan.anchor === 'em1d' ? 'VIX1D EM' : 'IVX EM'}</div>
      </button>
    );
  };

  const ivxChange = ivxFirst && ivx && ivxFirst.ivx > 0 ? ivx / ivxFirst.ivx - 1 : null;
  const typical = ivxFirst && ivxFirst.nyMin != null ? rangeLeft(h) / rangeLeft((ivxFirst.nyMin - 570) / 60) - 1 : null;
  const hm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  return (
    <section data-testid="credit-panel" style={{ border: `1px solid ${C.line}`, borderRadius: 14, padding: 16, background: C.panel, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 17, fontWeight: 700, color: C.head }}>Credit spread
          <span style={{ fontSize: 13, fontWeight: 400, color: C.grey }}> · any day, your call</span>
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {win.label && <span data-testid="entry-window" title={win.why || ''} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999,
            fontSize: 12.5, fontWeight: 700, color: TONE[win.tone], border: `1px solid ${alpha(TONE[win.tone], '66')}`, background: alpha(TONE[win.tone], '14') }}>
            <Clock size={13} />{win.label}{win.left != null && win.state !== 'pre' && win.state !== 'closed' ? ` · ${win.left}% of range left` : ''}</span>}
          {bridgeUrl && <button onClick={t.reload} title="Re-read trend and first hour" aria-label="Refresh trend read"
            style={{ display: 'inline-flex', padding: 5, borderRadius: 8, border: `1px solid ${C.line}`, background: 'transparent', color: C.grey, cursor: 'pointer' }}>
            <RefreshCw size={13} className={t.busy ? 'animate-spin' : ''} /></button>}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Tile testid="tile-ema" label="Daily trend" {...emaTile} />
        <Tile testid="tile-first" label="First hour" {...fhTile} />
        <Tile testid="tile-vwap" label="VWAP" {...vw} />
      </div>

      {ivx && (
        <div data-testid="ivx-line" className="mono" style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 13, color: C.text }}>
          <span><span style={{ color: C.grey }}>IVX</span> <b>±{ivx.toFixed(ivx < 10 ? 2 : 1)}</b>{!live && <span style={{ color: C.amber }}> est.</span>}</span>
          {live && <span><span style={{ color: C.grey }}>16Δ ≈</span> ±{(ivx / 0.85 * 1.2533).toFixed(ivx < 10 ? 2 : 1)}</span>}
          {ivxChange != null && ivxFirst.nyMin != null && mins - ivxFirst.nyMin >= 5 && (
            <span><span style={{ color: C.grey }}>since {hm(ivxFirst.nyMin)}</span> <b style={{ color: ivxChange <= (typical ?? 0) - 0.03 ? C.green : ivxChange >= (typical ?? 0) + 0.03 ? C.red : C.text }}>
              {ivxChange >= 0 ? '+' : ''}{(ivxChange * 100).toFixed(0)}%</b>
              {typical != null && <span style={{ color: C.grey }}> (typical {(typical * 100).toFixed(0)}%)</span>}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{btn('put')}{btn('call')}</div>

      {(plan.reasons[0] || plan.blocked.call) && (
        <div data-testid="credit-why" style={{ fontSize: 13, lineHeight: 1.45, color: C.text }}>
          {plan.blocked.call ? <span style={{ color: C.red }}>{plan.blocked.call} </span> : null}
          {plan.reasons.join(' ')}
          <span style={{ color: C.grey }}> Width {w ? w : 'fixed'} · target 25% near the money, 50% further out.</span>
        </div>
      )}
      {!plan.reasons.length && !plan.blocked.call && (
        <div style={{ fontSize: 12.5, color: C.grey }}>No lean yet — {t.err ? 'trend read failed: ' + t.err : mins < 630 ? 'the first hour isn’t in.' : 'trend read unavailable.'} Either side builds at the IVX EM.</div>
      )}
    </section>
  );
}
