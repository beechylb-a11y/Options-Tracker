import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X, RefreshCw, Radio } from 'lucide-react';
import { api } from '../utils/api';
import { buildBook, positionRisk, stopFor, targetFor, plannedExit, isoOfYmd } from '../engine/portfolio';
import { payoffSeries, whereIsPrice } from '../engine/tradeView';
import { marketClock } from '../engine/marketClock';
import { tradingSession } from '../engine/session';
import { loadPlan } from '../utils/ticketMath';

// ── Trade details (Oct 2026) ──
// One open trade on demand: a colour payoff diagram — at expiry, now, and at the
// planned exit (15:00 for a 0DTE) — with price, the break-evens, the move left,
// target and stop; what the position is doing now; and the buttons to manage it.
// Click the diagram to pin a price and read what the trade would be worth there.
// A 0DTE refreshes itself every 30 s while the market is open and the bridge answers.

const C = { text: '#e6edf3', muted: '#8b949e', faint: '#6e7681', border: '#30363d', green: '#3fb950', red: '#f85149',
  amber: '#e3b341', blue: '#58a6ff', orange: '#f0883e', bg: '#0d1117', card: '#161b22' };
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
  const auto = !!(p && p.engine === '0DTE' && bridgeUrl && live && (clock.phase === 'open' || clock.phase === 'late'));
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
    const r = positionRisk(pv, quotes, { now, spotHint });
    if (!r || !(r.spot > 0)) return { r, series: null };
    const series = payoffSeries(p, r.legs, r.spot, { now, banked: p.chain ? p.chain.banked : 0 });
    return { r, series, where: whereIsPrice(series, r.spot) };
  }, [p, quotes, now, spotHint]);

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

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9998, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }}
      onClick={onClose}>
      <div data-testid="trade-detail" onClick={e => e.stopPropagation()}
        style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, width: 1040, maxWidth: '97vw', maxHeight: '94vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>
              <span style={{ color: '#79c0ff' }}>{row.underlying}</span> {p ? p.strategy : row.strategy}
              <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 8, padding: '2px 7px', borderRadius: 4, background: '#0c1d36', color: C.blue }}>{row.engine}</span>
            </div>
            <div className="mono" style={{ fontSize: 12.5, color: C.muted, marginTop: 3 }}>
              {p && p.legs ? p.legs.map(l => `${l.qty > 0 ? '+' : '−'}${Math.abs(l.qty)} ${l.strike}${l.right}`).join(' / ') : row.legs}
              {p && p.expiry ? ` · exp ${isoOfYmd(p.expiry)}` : ''} · {p ? (p.live > 0 ? `${p.live} open` : `${p.resting} working (shown as if filled)`) : ''}
              {p && p.pos && p.pos.ncd ? ` · entry ${Math.abs(p.pos.ncd).toFixed(2)} ${p.pos.isCredit ? 'cr' : 'db'}` : ''}
            </div>
            {p && p.chain && <div className="mono" style={{ fontSize: 12, color: '#a8b2be', marginTop: 2 }}>
              rolled from {p.chain.links.map(l => `${l.strikes} (${money(l.realised)})`).join(' · ')}</div>}
          </div>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div className="mono" data-testid="detail-pnl" style={{ fontSize: 24, fontWeight: 800, color: pc(r && r.pnl != null ? r.pnl + banked : null) }}>
              {r && r.pnl != null ? money(r.pnl + banked) : '—'}</div>
            <div style={{ fontSize: 11.5, color: C.muted }}>
              {p && p.chain ? <>position · ticket {money(r && r.pnl)} + roll {money(banked)}</> : 'open P&L'}
              {r && r.markSource === 'model' ? ' · model mark' : r && r.markSource === 'quotes' ? ' · at the mid' : ''}
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ color: C.muted, marginLeft: 4 }}><X size={18} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap', fontSize: 12.5, color: C.muted }}>
          <span className="mono">NY {clock.time} · {clock.status.toLowerCase()}{p && p.engine === '0DTE' && clock.phase === 'open' ? ` · ${clock.detail.split(' · ')[0]}` : ''}</span>
          {at && <span>quotes {at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</span>}
          <button onClick={() => { setStatus('loading'); pull(); }} className="flex items-center gap-1" style={{ color: C.blue }} data-testid="detail-refresh">
            <RefreshCw size={12} className={status === 'loading' ? 'animate-spin' : ''} /> Refresh</button>
          {p && p.engine === '0DTE' && bridgeUrl && (
            <button onClick={() => setLive(v => !v)} className="flex items-center gap-1" style={{ color: auto ? C.green : C.muted }}
              title="Re-pull quotes every 30 s while the market is open">
              <Radio size={12} /> {auto ? 'Live · 30 s' : live ? 'Live (market closed)' : 'Live off'}</button>
          )}
          {note && <span style={{ color: '#d29922' }}>{note}</span>}
          {r && r.spotSource === 'entry' && <span style={{ color: '#d29922' }}>No live price — drawn at the entry price {px(r.spot)}.</span>}
        </div>

        {status === 'nolegs' || (p && !p.legs) ? (
          <div style={{ marginTop: 16, padding: 16, border: `1px dashed ${C.border}`, borderRadius: 8, color: C.muted, fontSize: 13 }}>
            Legs not found: TWS has no position at {row.legs}{bridgeUrl ? '' : ' (no bridge set)'} and the ticket has no Legs line, so the side and
            expiry of each strike are unknown. Open it with the bridge running, or log new trades from the engine — they carry their legs.
          </div>
        ) : !series ? (
          <div style={{ marginTop: 16, color: C.muted, fontSize: 13 }}>{status === 'loading' ? 'Loading…' : 'No price for the underlying — nothing to draw.'}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 290px', gap: 16, marginTop: 12 }}>
            <div>
              <PayoffDiagram series={series} spot={r.spot} pnlNow={posPnl} target={tgtPos ? tgtPos.gain : null} stop={stopPos ? stopPos.loss : null}
                pick={pick} onPick={setPick} underlying={row.underlying} />
              {pick != null && (
                <div data-testid="detail-pick" style={{ marginTop: 6, fontSize: 13, color: C.text, padding: '8px 10px', background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8 }}>
                  If {row.underlying} is at <b className="mono">{px(pick)}</b> ({pick >= r.spot ? '+' : '−'}{px(Math.abs(pick - r.spot))}, {series.sd > 0 ? `${((pick - r.spot) / series.sd).toFixed(1)}σ` : ''}):
                  {' '}now <b className="mono" style={{ color: pc(series.nowAt(pick)) }}>{money(series.nowAt(pick))}</b>
                  {series.exitAt && <> · {series.exitLabel.toLowerCase()} <b className="mono" style={{ color: pc(series.exitAt(pick)) }}>{money(series.exitAt(pick))}</b></>}
                  {' '}· at expiry <b className="mono" style={{ color: pc(series.expiryAt(pick)) }}>{money(series.expiryAt(pick))}</b>
                  <button onClick={() => setPick(null)} style={{ marginLeft: 8, color: C.muted, fontSize: 12 }}>clear</button>
                </div>
              )}
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: C.muted, marginTop: 6 }}>
                <span><span style={{ color: '#c9d1d9' }}>━</span> at expiry (green profit, red loss)</span>
                <span><span style={{ color: C.blue }}>╍</span> now</span>
                {series.exitAt && <span><span style={{ color: C.amber }}>╍</span> {series.exitLabel.toLowerCase()}</span>}
                <span><span style={{ color: C.blue, opacity: 0.6 }}>▮</span> ±1σ move left ({px(series.sd)} pts)</span>
                <span>click to pin a price</span>
              </div>
            </div>
            <Side p={p} r={r} pnl={posPnl} series={series} where={where} stop={stopPos} tgt={tgtPos} clock={clock} closeYmd={closeYmd} todayYmd={todayYmd}
              onSell={onSell ? () => onSell(row) : null} onRoll={onRoll && /45/.test(row.engine || '') && p.live > 0 ? () => onRoll(row) : null} />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v, color, sub, testid }) {
  return (
    <div data-testid={testid} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: `1px solid #21262d` }}>
      <span style={{ color: C.muted, fontSize: 12.5 }}>{k}</span>
      <span style={{ textAlign: 'right' }}>
        <span className="mono" style={{ color: color || C.text, fontSize: 13 }}>{v}</span>
        {sub && <div style={{ fontSize: 11, color: C.faint }}>{sub}</div>}
      </span>
    </div>
  );
}

function Side({ p, r, pnl, series, where, stop, tgt, clock, closeYmd, todayYmd, onSell, onRoll }) {
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
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {onSell && <button onClick={onSell} data-testid="detail-sell" className="px-3 py-1.5 text-sm font-semibold rounded-lg"
          style={{ border: '1px solid #da3633', color: C.red }}>Sell ticket</button>}
        {onRoll && <button onClick={onRoll} className="px-3 py-1.5 text-sm font-semibold rounded-lg"
          style={{ border: '1px solid #9e6a03', color: '#d29922' }}>Roll</button>}
      </div>
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
          <line x1={L} x2={W - R} y1={Y(v)} y2={Y(v)} stroke="#21262d" />
          <text x={L - 6} y={Y(v) + 4} fontSize="11" fill={C.muted} textAnchor="end">{money(v)}</text>
        </g>
      ))}
      {xTicks.map(v => <text key={'x' + v} x={X(v)} y={H - B + 30} fontSize="11" fill={C.faint} textAnchor="middle">{px(v)}</text>)}
      {/* expiry: filled by sign */}
      <path d={area} fill={C.green} opacity="0.22" clipPath="url(#td-up)" />
      <path d={area} fill={C.red} opacity="0.22" clipPath="url(#td-dn)" />
      <line x1={L} x2={W - R} y1={y0} y2={y0} stroke="#6e7681" strokeWidth="1" />
      <path d={line(series.expiry)} fill="none" stroke="#c9d1d9" strokeWidth="2" />
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
          <line x1={X(hp)} x2={X(hp)} y1={T} y2={H - B} stroke="#8b949e" strokeDasharray="2 3" />
          <rect x={Math.min(X(hp) + 8, W - R - 170)} y={T + 18} width="162" height={series.exit ? 62 : 46} rx="5" fill="#0d1117" stroke={C.border} />
          <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 34} fontSize="11.5" fill={C.text}>{underlying} {px(hp)}</text>
          <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 50} fontSize="11.5" fill={C.blue}>now {money(series.nowAt(hp))}</text>
          {series.exit && <text x={Math.min(X(hp) + 16, W - R - 162)} y={T + 66} fontSize="11.5" fill={C.amber}>{series.exitLabel.toLowerCase().replace('at the planned close', 'at close')} {money(series.exitAt(hp))}</text>}
          <text x={Math.min(X(hp) + 96, W - R - 82)} y={T + 50} fontSize="11.5" fill="#c9d1d9">exp {money(series.expiryAt(hp))}</text>
        </g>
      )}
    </svg>
  );
}
