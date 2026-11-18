import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Radio } from 'lucide-react';
import { api } from '../utils/api';
import { buildBook, positionRisk, stopFor, targetFor, plannedExit, isoOfYmd, etWall, daysBetween } from '../engine/portfolio';
import { payoffSeries, whereIsPrice } from '../engine/tradeView';
import { marketClock } from '../engine/marketClock';
import { tradingSession } from '../engine/session';
import { loadPlan } from '../utils/ticketMath';
import { curveAt, probProfit } from '../engine/payoffCurve';
import { liveQuotesFor, legKeysOf, positionCurve, manageVerdict, positionOrders, tradeStory } from '../engine/manageView';
import { useLiveQuotes, useLiveOrders, useLiveWatch, useLiveConnection, useFreshness } from '../live/useLive';
import { comboQuote, FRESH_LABEL, ageText } from '../live/liveStore';
import PayoffChart from './PayoffChart';
import { LiveLegs } from './MarketCard';
import FreshDot from './FreshDot';

// ── Trade details (Oct 2026) ──
// One open trade on demand: a colour payoff diagram — at expiry, now, and at the
// planned exit (15:00 for a 0DTE) — with price, the break-evens, the move left,
// target and stop; what the position is doing now; and the buttons to manage it.
// Click the diagram to pin a price and read what the trade would be worth there.
// A 0DTE refreshes itself every 30 s while the market is open and the bridge answers.

const C = { text: 'var(--c-e6edf3)', muted: 'var(--c-8b949e)', faint: 'var(--c-6e7681)', border: 'var(--c-30363d)', green: 'var(--c-3fb950)', red: 'var(--c-f85149)',
  amber: 'var(--c-e3b341)', blue: 'var(--c-58a6ff)', orange: 'var(--c-f0883e)', bg: 'var(--c-0d1117)', card: 'var(--c-161b22)' };
const money = v => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();
const px = v => v == null || !Number.isFinite(v) ? '—' : (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2));
const pc = v => (v == null ? C.muted : v >= 0 ? C.green : C.red);

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
    const x = await r.text();
    try { return JSON.parse(x); } catch (e) { return { error: 'bridge reply was not JSON' }; }
  } catch (e) { return { error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

export default function TradeDetail({ row, account, onClose, onSell, onRoll }) {
  const [hist, setHist] = useState(null);           // { decisions, closes }
  const [raw, setRaw] = useState(undefined);        // TWS legs, null when unreachable
  const [quotes, setQuotes] = useState(null);
  const [status, setStatus] = useState('loading');
  const [note, setNote] = useState('');
  const [at, setAt] = useState(null);
  const [live, setLive] = useState(true);
  const [pick, setPick] = useState(null);
  const [now, setNow] = useState(() => new Date());
  let bridgeUrl = '';
  try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }

  // Tickets and closes (for the legs logged with the ticket, its roll history), and
  // TWS's legs when the bridge answers.
  useEffect(() => {
    let dead = false;
    (async () => {
      const [decisions, closes] = await Promise.all([
        Promise.resolve().then(() => api.getDecisions()).catch(() => []),
        Promise.resolve().then(() => api.getCloses()).catch(() => []),
      ]);
      let r = null;
      if (bridgeUrl) { const d = await getJson(bridgeUrl + '/api/positions', 10000); r = d && Array.isArray(d.raw) ? d.raw : null; }
      if (dead) return;
      setHist({ decisions: Array.isArray(decisions) ? decisions : [], closes: Array.isArray(closes) ? closes : [] });
      setRaw(r);
    })();
    return () => { dead = true; };
  }, [row && row.ticketRef]);  // eslint-disable-line react-hooks/exhaustive-deps

  const todayYmd = tradingSession(now).yyyymmdd;
  const p = useMemo(() => {
    if (!hist || raw === undefined) return null;
    return buildBook({ open: [row], decisions: hist.decisions, closes: hist.closes, raw, todayYmd })[0] || null;
  }, [hist, raw, row, todayYmd]);

  // The push stream (phase 4): the legs and the underlying are held in the bridge's
  // live book while this is open; once every leg has a price the position is valued
  // off the stream and the 30 s re-pull stops.
  const watch = useMemo(() => (p && p.legs ? p.legs.map(l => ({ underlying: p.underlying, expiry: l.expiry, strike: l.strike, right: l.right, qty: Number(l.qty) || 0 })) : []), [p]);
  useLiveWatch(watch, { underlyings: p ? [p.underlying] : [] });
  const liveQ = useLiveQuotes();
  const liveOrders = useLiveOrders();
  const { connection } = useLiveConnection();
  const streamQ = useMemo(() => (p && p.legs ? liveQuotesFor(p, liveQ) : null), [p, liveQ]);
  const streamFresh = useFreshness(streamQ && streamQ.ts ? { ts: streamQ.ts, delayed: streamQ.delayed } : null);
  const useStream = !!(streamQ && streamFresh !== 'off');

  const [spotHint, setSpotHint] = useState(null);
  const spotAt = useRef(0);
  const pull = useCallback(async () => {
    if (!p) return;
    setNow(new Date());
    if (!p.legs) { setStatus('nolegs'); return; }
    if (!bridgeUrl) { setStatus('ready'); setNote('No IBKR bridge set — valued with a model at the ticket’s entry price and IV.'); return; }
    const nearExp = p.legs.map(l => String(l.expiry)).sort()[0];
    const g = await getJson(`${bridgeUrl}/api/option-greeks?underlying=${encodeURIComponent(p.underlying)}&expiry=${nearExp}&legs=`
      + encodeURIComponent(JSON.stringify(p.legs.map(l => ({ strike: l.strike, right: l.right, qty: l.qty, expiry: l.expiry })))), 40000);
    setQuotes(g && !g.error && Array.isArray(g.legs) ? g : null);
    // No underlying price on the quotes (an older bridge, or TWS left it empty):
    // read it from market data in the background — slow (~8s), so at most once a minute.
    if (!(g && g.undPrice > 0) && Date.now() - spotAt.current > 60000) {
      spotAt.current = Date.now();
      getJson(`${bridgeUrl}/api/market-data?underlying=${encodeURIComponent(p.underlying)}`, 20000)
        .then(m => { if (m && m.price > 0) setSpotHint(Number(m.price)); }).catch(() => {});
    }
    setNote(g && g.error ? `No quotes (${g.error}) — valued with a model.` : '');
    setAt(new Date()); setNow(new Date());
    setStatus('ready');
  }, [p, bridgeUrl]);
  useEffect(() => { pull(); }, [p]);   // eslint-disable-line react-hooks/exhaustive-deps

  const clock = marketClock(now);
  const auto = !!(p && p.engine === '0DTE' && bridgeUrl && live && !useStream && (clock.phase === 'open' || clock.phase === 'late'));
  const timer = useRef(null);
  useEffect(() => {
    clearInterval(timer.current);
    if (auto) timer.current = setInterval(() => pull(), 30000);
    const tick = setInterval(() => setNow(new Date()), 30000);
    return () => { clearInterval(timer.current); clearInterval(tick); };
  }, [auto, pull]);

  const view = useMemo(() => {
    if (!p || !p.legs) return null;
    const pv = p.live > 0 ? p : { ...p, live: p.qty || 1 };      // a working order: as if filled
    const r = positionRisk(pv, useStream ? streamQ : quotes, { now, spotHint });
    if (!r || !(r.spot > 0)) return { r, series: null };
    const series = payoffSeries(p, r.legs, r.spot, { now, banked: p.chain ? p.chain.banked : 0 });
    return { r, series, where: whereIsPrice(series, r.spot) };
  }, [p, quotes, now, spotHint, useStream, streamQ]);

  const plan = row && row.timestamp ? loadPlan(row.timestamp) : null;
  const stop = p ? stopFor(p.live > 0 ? p : { ...p, live: p.qty || 1 }, plan) : null;
  const tgt = p ? targetFor(p.live > 0 ? p : { ...p, live: p.qty || 1 }) : null;
  const banked = p && p.chain ? p.chain.banked : 0;
  const r = view && view.r, series = view && view.series, where = view && view.where;
  // Everything on this panel is the whole position, rolls included — the header P&L
  // already was, but the target, stop, "to go" and the chart's dot were this ticket
  // alone. Same figures as the board and the check-up now. (Oct 2026.)
  const posPnl = r && r.pnl != null ? r.pnl + banked : null;
  const stopPos = stop ? { ...stop, loss: stop.loss + banked } : null;
  const tgtPos = tgt ? { ...tgt, gain: tgt.gain + banked } : null;
  const closeYmd = p ? plannedExit(p) : null;

  // The manage view: the chart's inputs, the verdict and its one action, the orders
  // working on this underlying, and the roll chain as a story.
  const curve = useMemo(() => (p && r && r.spot > 0 ? positionCurve(p, r.legs, r.spot, { now, banked }) : null), [p, r, now, banked]);
  const winChance = useMemo(() => {
    if (!curve) return null;
    const sel = curveAt(curve.cl, { net: curve.net, lo: curve.lo, hi: curve.hi, days: curve.closeDay });
    return probProfit(sel, r.spot, curve.sigmaNear, curve.closeDay);
  }, [curve, r]);
  const canRoll = !!(onRoll && /45/.test(row.engine || '') && p && p.live > 0);
  const w = etWall(now);
  const minsToExit = p && p.engine === '0DTE' && p.expiry === w.ymd && curve && curve.closeEt
    ? (([h, m]) => h * 60 + m)(curve.closeEt.split(':').map(Number)) - w.min : null;
  const daysToClose = p && p.engine !== '0DTE' && closeYmd ? daysBetween(todayYmd, closeYmd) : null;
  const verdict = p && p.legs ? manageVerdict({ engine: p.engine, working: !(p.live > 0), pnl: posPnl, stopLoss: stopPos ? stopPos.loss : null,
    targetGain: tgtPos ? tgtPos.gain : null, where, minsToExit, daysToClose, canRoll, markSource: r && r.markSource,
    closeDte: curve ? curve.closeDte : null, closeYmd }) : null;
  const orders = useMemo(() => positionOrders(liveOrders, p), [liveOrders, p]);
  const story = useMemo(() => tradeStory(p, r && r.pnl != null ? r.pnl : null), [p, r]);
  const closeQuote = useMemo(() => {
    if (!p || !p.legs) return null;
    const keys = legKeysOf(p);
    const c = comboQuote(keys.map((k, i) => ({ key: k, qty: -(Number(p.legs[i].qty) || 0) })), liveQ);
    return c.complete ? c : null;
  }, [p, liveQ]);
  const doSell = onSell ? () => onSell(row) : null;
  const doRoll = canRoll ? () => onRoll(row) : null;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}>
      <div data-testid="trade-detail" onClick={e => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, width: 1040, maxWidth: '97vw', maxHeight: '94vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
              <span style={{ color: 'var(--c-79c0ff)' }}>{row.underlying}</span> {p ? p.strategy : row.strategy}
              <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 8, padding: '2px 7px', borderRadius: 4, background: 'var(--c-0c1d36)', color: C.blue }}>{row.engine}</span>
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {p && p.legs ? p.legs.map(l => `${l.qty > 0 ? '+' : '−'}${Math.abs(l.qty)} ${l.strike}${l.right}`).join(' / ') : row.legs}
              {p && p.expiry ? ` · exp ${isoOfYmd(p.expiry)}` : ''} · {p ? (p.live > 0 ? `${p.live} open` : `${p.resting} working (shown as if filled)`) : ''}
              {p && p.pos && p.pos.ncd ? ` · entry ${Math.abs(p.pos.ncd).toFixed(2)} ${p.pos.isCredit ? 'cr' : 'db'}` : ''}
            </div>
          </div>
          <span style={{ flex: 1 }} />
          <button onClick={onClose} aria-label="Close" style={{ color: C.muted, marginLeft: 4 }}><X size={18} /></button>
        </div>

        {verdict && <DecisionStrip v={verdict} pnl={posPnl} r={r} banked={banked} chain={!!(p && p.chain)} winChance={winChance}
          curve={curve} clock={clock} p={p} todayYmd={todayYmd} closeYmd={closeYmd} minsToExit={minsToExit} onSell={doSell} onRoll={doRoll} />}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5, color: C.muted }}>
          <span className="mono">NY {clock.time} · {clock.status.toLowerCase()}{p && p.engine === '0DTE' && clock.phase === 'open' ? ` · ${clock.detail.split(' · ')[0]}` : ''}</span>
          {useStream
            ? <span data-testid="detail-stream" className="flex items-center gap-1"><FreshDot state={streamFresh} ts={streamQ.ts} size={7} />
                quotes {FRESH_LABEL[streamFresh] || streamFresh} · TWS stream · {ageText(streamQ.ts)}</span>
            : at && <span>quotes {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>}
          <button onClick={() => { setStatus('loading'); pull(); }} className="flex items-center gap-1" style={{ color: C.blue }} data-testid="detail-refresh">
            <RefreshCw size={12} className={status === 'loading' ? 'animate-spin' : ''} /> Refresh</button>
          {p && p.engine === '0DTE' && bridgeUrl && !useStream && (
            <button onClick={() => setLive(v => !v)} className="flex items-center gap-1" style={{ color: auto ? C.green : C.muted }}
              title="Re-pull quotes every 30 s while the market is open">
              <Radio size={12} /> {auto ? 'Live · 30 s' : live ? 'Live (market closed)' : 'Live off'}</button>
          )}
          {note && !useStream && <span style={{ color: 'var(--c-d29922)' }}>{note}</span>}
          {r && r.spotSource === 'entry' && <span style={{ color: 'var(--c-d29922)' }}>No live price — drawn at the entry price {px(r.spot)}.</span>}
        </div>

        {status === 'nolegs' || (p && !p.legs) ? (
          <div style={{ marginTop: 16, padding: 16, border: `1px dashed ${C.border}`, borderRadius: 8, color: C.muted, fontSize: 13 }}>
            Legs not found: TWS has no position at {row.legs}{bridgeUrl ? '' : ' (no bridge set)'} and the ticket has no Legs line, so the side and
            expiry of each strike are unknown. Open it with the bridge running, or log new trades from the engine — they carry their legs.
          </div>
        ) : !series ? (
          <div style={{ marginTop: 16, color: C.muted, fontSize: 13 }}>{status === 'loading' ? 'Loading…' : 'No price for the underlying — nothing to draw.'}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 340px', gap: 16, marginTop: 12 }}>
            <div style={{ minWidth: 0 }}>
              {curve ? (
                <PayoffChart cl={curve.cl} net={curve.net} netSource="ticket" spot={r.spot} lo={curve.lo} hi={curve.hi}
                  sigmaNear={curve.sigmaNear} nearDte={curve.nearDte} closeDay={curve.closeDay} todayYmd={todayYmd}
                  isTimeSpread={curve.isTimeSpread} underlying={row.underlying} divYield={curve.divYield}
                  closeDte={curve.closeDte || undefined} intraday={curve.intraday} closeEt={curve.closeEt}
                  target={tgtPos && tgtPos.gain > 0 ? { dollars: tgtPos.gain, label: `${tgtPos.pct}% target, whole position` } : null}
                  stop={stopPos && stopPos.loss < 0 ? { dollars: stopPos.loss, label: 'stop' } : null}
                  scopeNote={`Whole position: ${curve.lots} lot${curve.lots === 1 ? '' : 's'}, so the entry figure is the net for all of them${banked ? ', rolls included' : ''}.`
                    + (curve.intraday && r.legs.some(l => l.iv > 0) ? ' Live TWS IVs are restated on the trading clock with the same variance to the bell, so the now curve matches the market mark.' : '')} />
              ) : (
                <PayoffDiagram series={series} spot={r.spot} pnlNow={posPnl} target={tgtPos ? tgtPos.gain : null} stop={stopPos ? stopPos.loss : null}
                  pick={pick} onPick={setPick} underlying={row.underlying} />
              )}
              <details data-testid="detail-more" style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', fontSize: 12.5, color: C.muted }}>Detail — every number on this trade</summary>
                <div style={{ marginTop: 8 }}>
                  <Side p={p} r={r} pnl={posPnl} series={series} where={where} stop={stopPos} tgt={tgtPos} clock={clock} closeYmd={closeYmd} todayYmd={todayYmd} />
                </div>
              </details>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
              <section className="card" data-testid="detail-market" style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Market</span>
                  <span style={{ flex: 1 }} />
                  {connection !== 'open' && <span style={{ fontSize: 12, color: C.faint }}>{connection === 'off' ? 'no bridge URL' : 'live stream ' + connection}</span>}
                </div>
                <CloseMarket q={closeQuote} isCredit={!!(p.pos && p.pos.isCredit)} lots={p.live > 0 ? p.live : p.qty || 1} />
                <LiveLegs underlying={p.underlying} legs={watch} />
              </section>
              <WorkingOrders orders={orders} />
              {story && <TradeStory story={story} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const TONE = { green: C.green, amber: C.amber, red: C.red, purple: 'var(--c-a371f7)', grey: C.muted, blue: C.blue };

// Verdict first, one primary action. The other buttons stay, outlined.
function DecisionStrip({ v, pnl, r, banked, chain, winChance, curve, clock, p, todayYmd, closeYmd, minsToExit, onSell, onRoll }) {
  const tone = TONE[v.tone] || C.muted;
  const time = p.engine === '0DTE'
    ? (minsToExit != null ? (minsToExit > 0 ? `${Math.floor(minsToExit / 60)}h ${String(Math.round(minsToExit % 60)).padStart(2, '0')}m to ${curve ? curve.closeEt : '15:00'}` : `past ${curve ? curve.closeEt : '15:00'}`) : clock.status.toLowerCase())
    : closeYmd ? `${Math.max(0, daysBetween(todayYmd, closeYmd))}d to close · ${p.expiry ? daysBetween(todayYmd, p.expiry) : '—'} DTE` : '—';
  const btn = (kind, label, fn, testid) => {
    if (!fn) return null;
    const primary = v.action === kind;
    const col = kind === 'roll' ? 'var(--c-d29922)' : C.red;
    return <button key={kind} type="button" onClick={fn} data-testid={testid} data-primary={primary ? '1' : '0'}
      style={{ padding: '8px 14px', borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: 'pointer',
        border: `1px solid ${col}`, color: primary ? 'var(--c-ffffff)' : col, background: primary ? `color-mix(in srgb, ${col} 32%, transparent)` : 'transparent' }}>{label}</button>;
  };
  const cell = (k, val, sub, color, testid) => (
    <div data-testid={testid} style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint }}>{k}</span>
      <span className="mono" style={{ fontSize: 18, fontWeight: 800, color: color || C.text, whiteSpace: 'nowrap' }}>{val}</span>
      {sub && <span style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>{sub}</span>}
    </div>
  );
  const rest = v.alerts.filter(a => a.text !== v.why);
  return (
    <div data-testid="manage-strip" data-tone={v.tone} style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, border: `1px solid ${C.border}`,
      borderLeft: `4px solid ${tone}`, background: `color-mix(in srgb, ${tone} 7%, var(--c-0d1117))` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <div data-testid="manage-verdict" style={{ fontSize: 16, fontWeight: 800, color: tone }}>{v.title}</div>
          <div style={{ fontSize: 12.5, color: C.text, marginTop: 2 }}>{v.why}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint }}>Open P&L</span>
          <span className="mono" data-testid="detail-pnl" style={{ fontSize: 22, fontWeight: 800, color: pc(pnl) }}>{pnl != null ? money(pnl) : '—'}</span>
          <span style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>
            {chain ? <>ticket {money(r && r.pnl)} + roll {money(banked)}</> : 'whole position'}
            {r && r.markSource === 'model' ? ' · model mark' : r && r.markSource === 'quotes' ? ' · at the mid' : ''}</span>
        </div>
        {cell('Win chance', winChance != null ? `${Math.round(winChance * 100)}%` : '—', curve ? (curve.intraday ? `at ${curve.closeEt}` : 'at the planned close') : null, null, 'manage-pop')}
        {cell('Time left', time.split(' · ')[0], time.split(' · ')[1] || null, v.alerts.some(a => /exit|close day/i.test(a.title || '')) ? TONE[v.tone] : null, 'manage-time')}
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          {v.action === 'roll' ? [btn('roll', 'Roll', onRoll, 'detail-roll'), btn('close', 'Close', onSell, 'detail-sell')]
            : [btn('close', 'Close', onSell, 'detail-sell'), btn('roll', 'Roll', onRoll, 'detail-roll')]}
        </div>
      </div>
      {rest.length > 0 && (
        <div data-testid="manage-alerts" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {rest.map((a, i) => <span key={i} style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 999, border: `1px solid ${TONE[a.tone]}`, color: TONE[a.tone] }}>{a.text}</span>)}
        </div>
      )}
    </div>
  );
}

// What closing costs right now, from the stream: the mid, and crossing the spread.
function CloseMarket({ q, isCredit, lots }) {
  if (!q) return <div style={{ fontSize: 12.5, color: C.faint }}>Close price appears when every leg has a live quote.</div>;
  const t = v => `${Math.abs(v).toFixed(2)} ${v >= 0 ? 'cr' : 'db'}`;
  return (
    <div data-testid="close-market" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 8 }}>
      {[['Close at mid', q.mid, C.text], ['Crossing', q.natural, C.muted]].map(([k, v, col]) => (
        <div key={k} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: C.faint }}>{k}</span>
          <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: col }}>{t(v)}</span>
          <span style={{ fontSize: 11, color: C.faint }}>{money(v * 100 * lots)} for {lots} lot{lots === 1 ? '' : 's'}</span>
        </div>
      ))}
      <span style={{ gridColumn: '1 / -1', fontSize: 11, color: C.faint }}>{isCredit ? 'Buying back a credit trade' : 'Selling a debit trade'} — per spread.</span>
    </div>
  );
}

// Orders TWS is holding on this underlying, from the live book. Purple = working.
function WorkingOrders({ orders }) {
  const P = 'var(--c-a371f7)';
  return (
    <section className="card" data-testid="detail-orders" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Working orders</span>
      {!orders.length ? <span style={{ fontSize: 12.5, color: C.faint }}>None in TWS on this underlying.</span> : orders.map(o => (
        <div key={o.orderId} data-testid="detail-order" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '6px 8px', borderRadius: 8,
          border: `1px solid color-mix(in srgb, ${P} 45%, transparent)`, background: `color-mix(in srgb, ${P} 8%, transparent)` }}>
          <span style={{ color: P, fontWeight: 700, whiteSpace: 'nowrap' }}>{o.action} {o.totalQty}</span>
          <span className="mono" style={{ color: C.text, whiteSpace: 'nowrap' }}>{o.orderType}{o.lmtPrice != null && o.orderType !== 'MKT' ? ` ${Number(o.lmtPrice).toFixed(2)}` : ''}</span>
          <span style={{ color: C.muted }}>{o.status || '—'}{o.filled ? ` · ${o.filled} filled` : ''}</span>
          <span style={{ flex: 1 }} />
          {o.mine && <span style={{ fontSize: 11, color: P, whiteSpace: 'nowrap' }}>this ticket</span>}
          <span className="mono" style={{ fontSize: 11, color: C.faint }}>#{o.orderId}</span>
        </div>
      ))}
      <span style={{ fontSize: 11, color: C.faint }}>Change or cancel in TWS. Nothing here sends orders.</span>
    </section>
  );
}

// How the position got here: each ticket it was rolled from and what it banked.
function TradeStory({ story }) {
  return (
    <section className="card" data-testid="detail-story" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>Trade story</span>
        <span style={{ fontSize: 12, color: C.muted }}>{story.rolls} roll{story.rolls === 1 ? '' : 's'} · banked <b className="mono" style={{ color: pc(story.banked) }}>{money(story.banked)}</b></span>
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {story.steps.map((st, i) => (
          <li key={i} data-testid="story-step" style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 8, flex: 'none', background: st.kind === 'now' ? C.blue : C.muted }} />
            <span style={{ color: C.muted, width: 56 }}>{st.kind === 'opened' ? 'Opened' : st.kind === 'rolled' ? 'Rolled to' : 'Now'}</span>
            <span className="mono" style={{ color: C.text, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{st.strikes}</span>
            <span className="mono" style={{ color: pc(st.kind === 'now' ? st.open : st.realised) }}>
              {st.kind === 'now' ? (st.open != null ? `${money(st.open)} open` : '—') : st.realised != null ? money(st.realised) : '—'}</span>
          </li>
        ))}
      </ol>
      {story.total != null && <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 6 }}>
        Position <b className="mono" style={{ color: pc(story.total) }}>{money(story.total)}</b> = open {money(story.total - story.banked)} + banked {money(story.banked)}</div>}
    </section>
  );
}

function Stat({ k, v, color, sub, testid }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: `1px solid var(--c-21262d)` }}>
      <span style={{ color: C.muted, fontSize: 12.5 }}>{k}</span>
      <span style={{ textAlign: 'right' }}>
        <span className="mono" style={{ color: color || C.text, fontSize: 13 }}>{v}</span>
        {sub && <div style={{ fontSize: 11, color: C.faint }}>{sub}</div>}
      </span>
    </div>
  );
}

function Side({ p, r, pnl, series, where, stop, tgt, clock, closeYmd, todayYmd }) {
  const nr = where && where.near;
  const toStop = stop && pnl != null ? pnl - stop.loss : null;
  const toTgt = tgt && pnl != null ? tgt.gain - pnl : null;
  const days = (a, b) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(4, 6) - 1, +b.slice(6, 8)) - Date.UTC(+a.slice(0, 4), +a.slice(4, 6) - 1, +a.slice(6, 8))) / 86400000);
  const g = r.greeks || {};
  return (
    <div data-testid="detail-side">
      <Stat k="Price" v={`${px(r.spot)}`} sub={where ? (where.inside ? 'inside the profit zone' : 'outside the profit zone') : ''}
        color={where ? (where.inside ? C.green : C.red) : null} />
      {nr && nr.body && <Stat testid="detail-near" k={`Body ${nr.strike}`} v={`${px(nr.away)} pts away`}
        sub={where.nearSd != null ? `${where.nearSd.toFixed(1)}σ of the move left · it wants price here` : ''} color={where.inside ? null : C.red} />}
      {nr && !nr.body && <Stat testid="detail-near" k={`Nearest short ${nr.strike}${nr.right}`} v={nr.away >= 0 ? `${px(nr.away)} pts away` : `${px(-nr.away)} pts through`}
        sub={where.nearSd != null ? `${Math.abs(where.nearSd).toFixed(1)}σ of the move left` : ''} color={nr.away < 0 ? C.red : where.nearSd != null && where.nearSd < 0.5 ? C.amber : null} />}
      {series.breakevens.length > 0 && <Stat k="Break-evens at expiry" v={series.breakevens.map(b => px(b)).join(' – ')} />}
      <Stat k="Max profit / loss at expiry" v={`${money(series.maxProfit)} / ${money(series.maxLoss)}`} />
      {tgt && <Stat testid="detail-target" k="Target" v={`${money(tgt.gain)}`} sub={`close @${tgt.price.toFixed(2)}${toTgt != null ? ` · ${toTgt > 0 ? money(toTgt) + ' to go' : 'reached'}` : ''}`} color={C.green} />}
      {stop && <Stat testid="detail-stop" k="Stop" v={`${money(stop.loss)}`} sub={`close @${stop.price.toFixed(2)}${toStop != null ? ` · ${toStop > 0 ? money(toStop) + ' of room' : 'reached'}` : ''}`} color={C.red} />}
      {p.engine === '0DTE'
        ? <Stat k="Time" v={clock.phase === 'open' ? clock.detail.split(' · ')[0] : clock.status.toLowerCase()} sub={clock.phase === 'open' ? clock.detail.split(' · ')[1] : clock.detail}
            color={clock.phase === 'late' ? C.amber : null} />
        : p.expiry && <Stat k="Time" v={`${days(todayYmd, p.expiry)} DTE`} sub={closeYmd ? `planned close ${isoOfYmd(closeYmd)} · in ${days(todayYmd, closeYmd)}d` : ''}
            color={closeYmd && days(todayYmd, closeYmd) <= 0 ? C.red : closeYmd && days(todayYmd, closeYmd) <= 5 ? C.amber : null} />}
      {series.exitAt && <Stat k={`${series.exitLabel}, price unchanged`} v={money(series.exitAt(r.spot))} color={pc(series.exitAt(r.spot))} />}
      <Stat k="Greeks (all contracts)" v={`delta ${Math.round(g.delta || 0)} · theta ${money(g.theta)}/day`}
        sub={`vega ${money(g.vega)} per vol pt · ${r.greeksSource === 'quotes' ? 'live' : 'model'}`} />
    </div>
  );
}

// The payoff in colour. Expiry is filled green above zero and red below, now and the
// planned exit are dashed, the move left is a band around price.
function PayoffDiagram({ series, spot, pnlNow, target, stop, pick, onPick, underlying }) {
  const [hover, setHover] = useState(null);
  const svgRef = useRef(null);
  const W = 760, H = 330, L = 64, R = 18, T = 16, B = 50;
  const vals = [...series.expiry, ...series.now, ...(series.exit || []), 0, pnlNow, target, stop].filter(v => v != null && Number.isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(20, (hi - lo) * 0.07); lo -= pad; hi += pad;
  const X = s => L + (s - series.lo) / (series.hi - series.lo) * (W - L - R);
  const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const toPrice = cx => series.lo + (cx - L) / (W - L - R) * (series.hi - series.lo);
  const line = arr => arr.map((v, i) => `${i ? 'L' : 'M'}${X(series.xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const area = line(series.expiry) + `L${X(series.hi).toFixed(1)},${Y(0).toFixed(1)}L${X(series.lo).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const y0 = Y(0);
  const step = (() => { const raw = (hi - lo) / 5; const m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(k => k * m).find(s => s >= raw) || raw; })();
  const yTicks = []; for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);
  const xr = series.hi - series.lo;
  const xStep = (() => { const raw = xr / 7; const m = 10 ** Math.floor(Math.log10(raw)); return [1, 2, 2.5, 5, 10].map(k => k * m).find(s => s >= raw) || raw; })();
  const xTicks = []; for (let v = Math.ceil(series.lo / xStep) * xStep; v <= series.hi; v += xStep) xTicks.push(v);
  const evPrice = e => {
    const svg = svgRef.current; if (!svg) return null;
    const b = svg.getBoundingClientRect();
    const cx = (e.clientX - b.left) / b.width * W;
    if (cx < L || cx > W - R) return null;
    return toPrice(cx);
  };
  const hp = hover != null ? hover : null;
  const bandL = X(Math.max(series.lo, spot - series.sd)), bandR = X(Math.min(series.hi, spot + series.sd));
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%" data-testid="payoff-diagram" role="img" style={{ display: 'block', cursor: 'crosshair', background: C.bg, borderRadius: 8 }}
      aria-label={`${underlying} payoff: now ${money(pnlNow)} at ${px(spot)}`}
      onMouseMove={e => setHover(evPrice(e))} onMouseLeave={() => setHover(null)} onClick={e => { const v = evPrice(e); if (v != null) onPick(v); }}>
      <defs>
        <clipPath id="td-up"><rect x={L} y={T} width={W - L - R} height={Math.max(0, y0 - T)} /></clipPath>
        <clipPath id="td-dn"><rect x={L} y={y0} width={W - L - R} height={Math.max(0, H - B - y0)} /></clipPath>
      </defs>
      {/* move left */}
      <rect x={bandL} y={T} width={Math.max(0, bandR - bandL)} height={H - T - B} fill={C.blue} opacity="0.08" />
      {/* grid */}
      {yTicks.map(v => (
        <g key={'y' + v}>
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="var(--c-21262d)" />
          <text x={L - 6} y={Y(v) + 4} fontSize="11" fill={C.muted} textAnchor="end">{money(v)}</text>
        </g>
      ))}
      {xTicks.map(v => <text key={'x' + v} x={X(v)} y={H - B + 30} fontSize="11" fill={C.faint} textAnchor="middle">{px(v)}</text>)}
      {/* expiry: filled by sign */}
      <path d={area} fill={C.green} opacity="0.22" clipPath="url(#td-up)" />
      <path d={area} fill={C.red} opacity="0.22" clipPath="url(#td-dn)" />
      <line x1={L} x2={W - R} y1={y0} y2={y0} stroke="var(--c-6e7681)" strokeWidth="1" />
      <path d={line(series.expiry)} fill="none" stroke="var(--c-c9d1d9)" strokeWidth="2" />
      {series.exit && <path d={line(series.exit)} fill="none" stroke={C.amber} strokeWidth="1.8" strokeDasharray="6 4" />}
      <path d={line(series.now)} fill="none" stroke={C.blue} strokeWidth="2" strokeDasharray="5 3" />
      {/* target and stop */}
      {target != null && <g><line x1={L} x2={W - R} y1={Y(target)} y2={Y(target)} stroke={C.green} strokeDasharray="3 4" />
        <text x={W - R - 4} y={Y(target) - 4} fontSize="11" fill={C.green} textAnchor="end">target {money(target)}</text></g>}
      {stop != null && <g><line x1={L} x2={W - R} y1={Y(stop)} y2={Y(stop)} stroke={C.red} strokeDasharray="3 4" />
        <text x={W - R - 4} y={Y(stop) + 13} fontSize="11" fill={C.red} textAnchor="end">stop {money(stop)}</text></g>}
      {/* break-evens and strikes */}
      {series.breakevens.map((b, i) => (
        <g key={'be' + i}><line x1={X(b)} x2={X(b)} y1={y0 - 5} y2={y0 + 5} stroke={C.green} strokeWidth="2" />
          <text x={X(b)} y={H - B + 14} fontSize="10.5" fill={C.green} textAnchor="middle">BE {px(b)}</text></g>
      ))}
      {series.strikes.map((s, i) => (
        <g key={'k' + i}>
          <line x1={X(s.strike)} x2={X(s.strike)} y1={H - B - 6} y2={H - B} stroke={s.qty < 0 ? C.orange : C.blue} strokeWidth="3" />
          <text x={X(s.strike)} y={H - B - 9} fontSize="10" fill={s.qty < 0 ? C.orange : C.blue} textAnchor="middle">{s.strike}{s.right}</text>
        </g>
      ))}
      {/* price now */}
      <line x1={X(spot)} x2={X(spot)} y1={T} y2={H - B} stroke={C.text} strokeWidth="1" opacity="0.6" />
      <text x={X(spot)} y={T + 11} fontSize="11.5" fontWeight="700" fill={C.text} textAnchor={X(spot) > W - 90 ? 'end' : 'start'} dx={X(spot) > W - 90 ? -5 : 5}>{underlying} {px(spot)}</text>
      {pnlNow != null && <circle cx={X(spot)} cy={Y(pnlNow)} r="6" fill={pc(pnlNow)} stroke={C.bg} strokeWidth="2" />}
      {pnlNow != null && <text x={X(spot) + 9} y={Y(pnlNow) + 4} fontSize="12" fontWeight="700" fill={pc(pnlNow)}>{money(pnlNow)}</text>}
      {/* pinned and hover */}
      {pick != null && <line x1={X(pick)} x2={X(pick)} y1={T} y2={H - B} stroke={C.amber} strokeWidth="1.5" />}
      {hp != null && (
        <g pointerEvents="none">
          <line x1={X(hp)} x2={X(hp)} y1={T} y2={H - B} stroke="var(--c-8b949e)" strokeDasharray="2 3" />
          <rect x={Math.min(X(hp) + 8, W - R - 170)} y={T + 18} width="162" height={series.exit ? 62 : 46} rx="5" fill="var(--c-0d1117)" stroke={C.border} />
          <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 34} fontSize="11.5" fill={C.text}>{underlying} {px(hp)}</text>
          <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 50} fontSize="11.5" fill={C.blue}>now {money(series.nowAt(hp))}</text>
          {series.exit && <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 66} fontSize="11.5" fill={C.amber}>{series.exitLabel.toLowerCase().replace('at the planned close', 'at close')} {money(series.exitAt(hp))}</text>}
          <text x={Math.min(X(hp) + 96, W - R - 82)} y={T + 50} fontSize="11.5" fill="var(--c-c9d1d9)">exp {money(series.expiryAt(hp))}</text>
        </g>
      )}
    </svg>
  );
}
