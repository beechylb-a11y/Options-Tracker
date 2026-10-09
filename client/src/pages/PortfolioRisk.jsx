import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Shield, RefreshCw, AlertTriangle, Activity, CalendarClock, GitCompare } from 'lucide-react';
import { api } from '../utils/api';
import OrderTicket from '../components/OrderTicket';
import FillReconcile from '../components/FillReconcile';
import { loadPlan } from '../utils/ticketMath';
import { tradingSession } from '../engine/session';
import { reviewOpen45 } from '../engine/review45';
import {
  buildBook, reconcile, positionRisk, totals, stressGrid, riskBudget, eventsAhead, attention,
  spxDailySd, isoOfYmd, betaOf, stopFor, targetFor,
} from '../engine/portfolio';

// ── Risk now (Oct 2026) ──
// The whole book on one screen: what is on and whether TWS agrees, what it does if
// the market moves, what a bad day costs, how much of the risk budget is used, and
// what needs doing now. Built from the app's own tickets (open + working) and, when
// the bridge is reachable, TWS positions and live leg quotes. Without the bridge it
// still works, valued with a model at the entry price and IV — and says so.

const C = { text: '#e6edf3', muted: '#8b949e', faint: '#6e7681', border: '#30363d', panel: '#0d1117',
  green: '#3fb950', red: '#f85149', amber: '#d29922', blue: '#58a6ff', solid: '#2f81f7' };
const TONE = {
  red: { fg: '#f85149', bg: '#2d0f11', border: '#6e2427' },
  amber: { fg: '#e3b341', bg: '#1f1a0d', border: '#9e6a03' },
  green: { fg: '#3fb950', bg: '#0f2417', border: '#238636' },
  blue: { fg: '#58a6ff', bg: '#0c1d36', border: '#1f6feb' },
  grey: { fg: '#a8b2be', bg: '#161b22', border: '#30363d' },
};
const money = (v, dp = 0) => v == null || !Number.isFinite(v) ? '—'
  : (v >= 0 ? '+$' : '−$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
const plain$ = v => v == null || !Number.isFinite(v) ? '—' : '$' + Math.round(Math.abs(v)).toLocaleString();
const pc = v => (v == null ? C.muted : v >= 0 ? C.green : C.red);

async function getJson(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: ctrl.signal });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return { error: txt.trim().startsWith('<') ? 'bridge returned a web page — pull and restart the bridge' : txt.slice(0, 120) }; }
  } catch (e) { return { error: e.name === 'AbortError' ? 'timed out' : e.message }; }
  finally { clearTimeout(t); }
}

// A few requests at a time: the bridge serialises market-data lines anyway.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

const legsText = legs => (legs || []).map(l => `${l.qty > 0 ? '+' : '−'}${Math.abs(l.qty)} ${l.strike}${l.right}`).join(' / ');

export default function PortfolioRisk({ authenticated, account }) {
  const [base, setBase] = useState(null);         // { open, decisions, cap }
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState({ raw: null, posErr: null, quotes: {}, vix: null, busy: false, ranAt: null, note: '' });
  const [horizon, setHorizon] = useState(0);
  const [ticket, setTicket] = useState(null);
  const [fills, setFills] = useState(null);
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => new Date());

  let bridgeUrl = '';
  try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
  const todayYmd = tradingSession(now).yyyymmdd;

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    let dead = false;
    setLoading(true);
    Promise.all([
      api.getOpenPositions(account),
      api.getDecisions().catch(() => []),
      api.getStats(account).catch(() => null),
    ]).then(([open, decisions, stats]) => {
      if (dead) return;
      setBase({ open: Array.isArray(open) ? open : [], decisions: Array.isArray(decisions) ? decisions : [],
        cap: Number(stats?.config?.maxOpenRisk) || null });
      setErr(null);
    }).catch(e => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [authenticated, account, reload]);

  // Live pass: TWS positions, then quotes for each position's legs, and VIX for the
  // stress grid's standard deviations.
  const refreshLive = useCallback(async () => {
    if (!bridgeUrl || !base) return;
    setLive(l => ({ ...l, busy: true, note: '' }));
    const t0 = new Date();
    const [pos, md] = await Promise.all([
      getJson(bridgeUrl + '/api/positions', 15000),
      getJson(bridgeUrl + '/api/market-data?underlying=SPX', 30000),
    ]);
    const raw = pos && Array.isArray(pos.raw) ? pos.raw : null;
    const book = buildBook({ open: base.open, decisions: base.decisions, raw, todayYmd: tradingSession(t0).yyyymmdd });
    const want = book.filter(p => p.legs && p.live > 0 && (!p.expiry || p.expiry >= tradingSession(t0).yyyymmdd));
    const quotes = {};
    await pool(want, 3, async p => {
      const nearExp = p.legs.map(l => String(l.expiry)).sort()[0];
      const g = await getJson(bridgeUrl + '/api/option-greeks?underlying=' + encodeURIComponent(p.underlying) + '&expiry=' + nearExp
        + '&legs=' + encodeURIComponent(JSON.stringify(p.legs.map(l => ({ strike: l.strike, right: l.right, qty: l.qty, expiry: l.expiry })))), 40000);
      quotes[p.key] = g && !g.error ? g : null;
    });
    const missed = want.filter(p => !quotes[p.key]).length;
    setNow(new Date());
    setLive({ raw, posErr: pos && pos.error ? pos.error : null, quotes, vix: md && md.vix > 0 ? md.vix : null,
      busy: false, ranAt: new Date(), note: missed ? `${missed} position${missed === 1 ? '' : 's'} got no quotes — valued with the model` : '' });
  }, [bridgeUrl, base]);

  useEffect(() => { if (base && bridgeUrl) refreshLive(); }, [base]); // eslint-disable-line react-hooks/exhaustive-deps
  // The clock moves the 0DTE time exits and the theta horizon: re-mark each minute.
  useEffect(() => { const id = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(id); }, []);

  const view = useMemo(() => {
    if (!base) return null;
    const book = buildBook({ open: base.open, decisions: base.decisions, raw: live.raw, todayYmd });
    const risks = {}, reviews = {};
    for (const p of book) {
      if (p.expiry && p.expiry < todayYmd) continue;
      const r = positionRisk(p, live.quotes[p.key] || null, { now });
      if (!r) continue;
      risks[p.key] = r;
      if (p.engine === '45DTE' && r.markSource === 'quotes') {
        const ivs = r.legs.map(l => l.iv).filter(x => x > 0);
        reviews[p.key] = reviewOpen45({
          strategy: p.strategy, legs: r.legs, qtyOpen: p.live, underlying: p.underlying,
          entry: { ncd: p.pos.ncd || 0, dateYmd: p.entry.ymd, spot: p.entry.spot, iv: p.entry.iv,
            maxProfit: p.pos.maxProfitPerContract, maxRisk: p.pos.maxRiskPerContract },
          now: { todayYmd, spot: r.spot, iv: ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : p.entry.iv,
            mark: r.markPS, delta: r.greeks.delta / p.live, theta: r.greeks.theta / p.live, vega: r.greeks.vega / p.live },
        });
      }
    }
    const riskList = Object.values(risks);
    return {
      book, risks, reviews,
      rec: reconcile(book, live.raw, todayYmd),
      tot: totals(riskList),
      grid: stressGrid(riskList, { horizonDays: horizon, now }),
      budget: riskBudget(book, { cap: base.cap, todayYmd }),
      events: eventsAhead(book, todayYmd),
      items: attention(book, { risks, reviews, planOf: loadPlan, now, todayYmd }),
    };
  }, [base, live, horizon, todayYmd, now]);

  function act(p, action) {
    if (action === 'fills') setFills(p.row);
    else setTicket({ row: p.row, tab: action === 'roll' ? 'roll' : 'close' });
  }
  const done = () => { setTicket(null); setFills(null); setReload(x => x + 1); };

  if (!authenticated) {
    return (
      <div className="fade-in">
        <h2 className="font-display text-2xl font-bold mb-2">Portfolio Risk</h2>
        <p className="text-text-muted">Sign in to see your open risk.</p>
      </div>
    );
  }
  if (loading && !base) return <div className="text-text-muted text-sm">Loading open positions…</div>;
  if (err) return <div className="card"><div className="text-red text-sm">Open positions: {err}</div></div>;
  const { book, risks, rec, tot, grid, budget, events, items } = view;
  const openN = book.filter(p => p.live > 0).length, workN = book.filter(p => p.working).length;
  const legless = book.filter(p => p.live > 0 && !p.legs);
  const sd = spxDailySd(live.vix);
  const anyModel = Object.values(risks).some(r => r.greeksSource === 'model' || r.markSource === 'model');

  return (
    <div className="fade-in" data-testid="risk-now">
      <div className="flex items-start justify-between mb-5 gap-3 flex-wrap">
        <div>
          <h2 className="font-display text-2xl font-bold flex items-center gap-2"><Shield size={20} color={C.blue} /> Portfolio Risk</h2>
          <p className="text-text-muted text-sm mt-0.5">
            {openN} open position{openN === 1 ? '' : 's'}{workN ? ` · ${workN} order${workN === 1 ? '' : 's'} working` : ''}
            {live.ranAt && ` · live ${live.ranAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`}
          </p>
          {!bridgeUrl && <p className="text-[12.5px] mt-1" style={{ color: C.amber }}>No IBKR bridge set — values use a model at each ticket's entry price and IV, and TWS can't be checked. Set the bridge URL in Settings for live quotes.</p>}
          {bridgeUrl && live.posErr && <p className="text-[12.5px] mt-1" style={{ color: C.amber }}>TWS positions: {live.posErr} — using the legs logged with each ticket.</p>}
          {live.note && <p className="text-[12.5px] mt-1" style={{ color: C.amber }}>{live.note}</p>}
        </div>
        {bridgeUrl && (
          <button onClick={refreshLive} disabled={live.busy} data-testid="risk-refresh"
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
            style={{ background: C.solid, color: '#0d1117' }}>
            <RefreshCw size={14} className={live.busy ? 'animate-spin' : ''} /> {live.busy ? 'Pulling from TWS…' : 'Refresh live'}
          </button>
        )}
      </div>

      {!book.length ? (
        <div className="card py-12 text-center text-text-faint">Nothing open. Positions appear here once a trade is logged from the Decision Engine.</div>
      ) : (<>
        <Tiles tot={tot} budget={budget} anyModel={anyModel} />

        <Section icon={<AlertTriangle size={15} color={C.amber} />} title="Needs attention" testid="risk-attention"
          sub="Stops, targets, time exits and anything the log and TWS disagree on — most urgent first.">
          {items.length === 0
            ? <div className="text-sm py-2" style={{ color: C.green }}>Nothing needs doing right now. Every open position is inside its plan.</div>
            : <div className="space-y-2">{items.map(it => <AttentionRow key={it.key} it={it} onAct={act} />)}</div>}
        </Section>

        <Section icon={<Activity size={15} color={C.blue} />} title="Stress test" testid="risk-stress"
          sub={`What the open book makes or loses if SPX moves and implied volatility changes${horizon ? ', by tomorrow (a day of theta included; 0DTE at expiry)' : ', right now'}. Each underlying moves by its beta × the SPX move.`}
          right={<Toggle value={horizon} onChange={setHorizon} options={[[0, 'Now'], [1, 'By tomorrow']]} />}>
          {grid.n === 0 ? <div className="text-sm" style={{ color: C.muted }}>No position with known legs to stress.</div>
            : <StressTable grid={grid} sd={sd} book={book} />}
          {legless.length > 0 && <div className="text-[12.5px] mt-2" style={{ color: C.amber }}>
            Left out (legs not found): {legless.map(p => `${p.underlying} ${p.strategy}`).join(', ')} — max loss {plain$(legless.reduce((a, p) => a + (p.maxRisk > 0 && p.qty ? p.maxRisk * p.live / p.qty : 0), 0))} not modelled.</div>}
        </Section>

        <Section icon={<Shield size={15} color={C.blue} />} title="Positions" testid="risk-positions"
          sub="Click a row for its Sell ticket (or the fill screen, for an order still working).">
          <PositionsTable book={book} risks={risks} onAct={act} plan={loadPlan} />
        </Section>

        <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          <Section icon={<Shield size={15} color={C.blue} />} title="Risk budget" testid="risk-budget"
            sub="Max loss of what is open, plus orders still working, against your cap.">
            <Budget budget={budget} />
          </Section>
          <Section icon={<CalendarClock size={15} color={C.amber} />} title="Events before you're out" testid="risk-events"
            sub="Scheduled releases before each position's planned close.">
            {events.length === 0 ? <div className="text-sm" style={{ color: C.muted }}>No scheduled releases before your positions close.</div>
              : <ul className="space-y-1.5">{events.map(e => (
                <li key={e.date + e.label} className="text-[13px]">
                  <span className="mono" style={{ color: C.amber }}>{e.date}{e.time ? ' ' + e.time : ''}</span>
                  <span style={{ color: C.text }}> {e.label}</span>
                  <span style={{ color: C.muted }}> — {e.positions.join(', ')}</span>
                </li>))}</ul>}
          </Section>
        </div>

        <Section icon={<GitCompare size={15} color={C.blue} />} title="Log vs TWS" testid="risk-reconcile"
          sub="Positions TWS holds that no open ticket accounts for, and open tickets TWS doesn't show.">
          <Reconcile rec={rec} bridge={!!bridgeUrl} onAct={act} />
        </Section>
      </>)}

      {ticket && <OrderTicket position={ticket.row} initialTab={ticket.tab} onClose={() => setTicket(null)} onDone={done} />}
      {fills && <FillReconcile positions={[fills]} account={account} onClose={() => setFills(null)} onDone={done} />}
    </div>
  );
}

function Section({ icon, title, sub, right, children, testid }) {
  return (
    <div className="card mb-4" data-testid={testid}>
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">{icon} {title}</h3>
          {sub && <p className="text-xs text-text-muted mt-1">{sub}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function Toggle({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className="px-3 py-1 text-xs"
          style={{ background: value === v ? '#1f6feb' : 'transparent', color: value === v ? '#fff' : C.muted }}>{label}</button>
      ))}
    </div>
  );
}

function Tile({ label, value, tone, sub, tip }) {
  return (
    <div className="card" title={tip} style={{ padding: '12px 14px' }}>
      <div className="text-[11.5px] uppercase tracking-wide" style={{ color: C.muted }}>{label}</div>
      <div className="mono text-xl font-bold mt-1" style={{ color: tone || C.text }}>{value}</div>
      {sub && <div className="text-[11.5px] mt-0.5" style={{ color: C.faint }}>{sub}</div>}
    </div>
  );
}

function Tiles({ tot, budget, anyModel }) {
  const e = budget.exp;
  const used = e.cap ? e.committed / e.cap : null;
  return (
    <div className="grid gap-3 mb-4" data-testid="risk-tiles" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
      <Tile label="Open P&L" value={money(tot.pnl)} tone={pc(tot.pnl)} sub={anyModel ? 'some marks modelled' : 'at the mid'} />
      <Tile label="Delta, SPX-weighted" value={money(tot.spxDelta1)} tone={Math.abs(tot.spxDelta1) < 50 ? C.text : pc(tot.spxDelta1)}
        sub="per 1% SPX move" tip="What the book makes (+) or loses (−) if SPX rises 1% and everything moves with its beta." />
      <Tile label="Theta" value={money(tot.theta)} tone={pc(tot.theta)} sub="per day, nothing moving"
        tip="A day of time decay with price and IV unchanged. For a 0DTE this is what is left of today's decay to the close." />
      <Tile label="Vega" value={money(tot.vega)} tone={pc(tot.vega)} sub="per +1 vol point" />
      <Tile label="Gamma" value={money(tot.gamma1)} tone={pc(tot.gamma1)} sub="from convexity in a 1% move"
        tip="Extra P&L from the bend of the curve in a 1% move of each underlying, either way. Negative = short gamma: moves hurt more the further they go." />
      <Tile label="Risk used" value={e.cap ? `${Math.round(used * 100)}%` : plain$(e.committed)}
        tone={e.overNow ? C.red : e.overIfFilled ? C.amber : C.text}
        sub={e.cap ? `${plain$(e.live)} open${e.working ? ` + ${plain$(e.working)} working` : ''} of ${plain$(e.cap)}` : `${plain$(e.live)} open${e.working ? ` + ${plain$(e.working)} working` : ''} · no cap set`} />
    </div>
  );
}

function AttentionRow({ it, onAct }) {
  const t = TONE[it.tone] || TONE.grey;
  const label = it.action === 'fills' ? 'Enter fills' : it.action === 'roll' ? 'Roll ticket' : 'Sell ticket';
  return (
    <div data-testid="attention-item" data-tone={it.tone}
      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 8, background: t.bg, border: `1px solid ${t.border}` }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ color: t.fg, fontWeight: 700, fontSize: 13.5 }}>{it.title}</div>
        <div style={{ color: C.text, fontSize: 12.5, marginTop: 2 }}>{it.detail}</div>
      </div>
      <button onClick={() => onAct(it.p, it.action)} className="px-3 py-1.5 text-xs font-semibold rounded-md"
        style={{ border: `1px solid ${t.border}`, color: t.fg, background: 'transparent', whiteSpace: 'nowrap' }}>{label}</button>
    </div>
  );
}

function StressTable({ grid, sd, book }) {
  const max = Math.max(1, ...grid.cells.flat().map(c => Math.abs(c.pnl)));
  const bg = v => {
    const a = Math.min(1, Math.abs(v) / max) * 0.55 + 0.05;
    return v >= 0 ? `rgba(63,185,80,${a})` : `rgba(248,81,73,${a})`;
  };
  const w = grid.worst;
  const name = k => { const p = book.find(x => x.key === k); return p ? `${p.underlying} ${p.strategy}` : k; };
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]" style={{ borderCollapse: 'separate', borderSpacing: 3, maxWidth: 760 }}>
          <thead>
            <tr>
              <th className="text-left text-[11.5px] font-normal pr-2" style={{ color: C.muted }}>SPX move</th>
              {grid.ivShifts.map(v => <th key={v} className="text-center text-[11.5px] font-normal" style={{ color: C.muted }}>IV {v > 0 ? '+' : v < 0 ? '−' : '±'}{Math.abs(v)}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.cells.map((row, i) => (
              <tr key={i}>
                <td className="mono pr-2 whitespace-nowrap" style={{ color: C.text }}>
                  {grid.moves[i] > 0 ? '+' : grid.moves[i] < 0 ? '−' : ''}{Math.abs(grid.moves[i])}%
                  {sd && grid.moves[i] !== 0 && <span style={{ color: C.faint }}> ({(grid.moves[i] / sd).toFixed(1)}σ)</span>}
                </td>
                {row.map((c, j) => {
                  const isW = w && c === w;
                  return (
                    <td key={j} className="mono text-center py-1.5 rounded" data-worst={isW ? '1' : undefined}
                      style={{ background: bg(c.pnl), color: '#fff', outline: isW ? '2px solid #fff' : 'none', fontWeight: isW ? 800 : 500 }}>
                      {money(c.pnl)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {w && w.pnl < 0 && (
        <p className="text-[13px] mt-2" style={{ color: C.text }} data-testid="stress-worst">
          Worst case here: <b style={{ color: C.red }}>{money(w.pnl)}</b> if SPX moves {w.move > 0 ? '+' : ''}{w.move}%
          {w.iv ? ` and IV ${w.iv > 0 ? 'rises' : 'falls'} ${Math.abs(w.iv)} points` : ''}
          {grid.top && <> — mostly from <b>{name(grid.top.key)}</b> ({money(grid.top.pnl)})</>}.
          {sd && <span style={{ color: C.muted }}> One SPX day is about {sd.toFixed(2)}% at VIX {(sd * Math.sqrt(252)).toFixed(1)}.</span>}
        </p>
      )}
    </div>
  );
}

function PositionsTable({ book, risks, onAct, plan }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-[11.5px]" style={{ color: C.muted }}>
            <th className="py-1.5 pr-3 font-normal">Position</th>
            <th className="py-1.5 pr-3 font-normal">Legs</th>
            <th className="py-1.5 pr-3 font-normal text-right">Qty</th>
            <th className="py-1.5 pr-3 font-normal text-right">DTE</th>
            <th className="py-1.5 pr-3 font-normal text-right">Entry</th>
            <th className="py-1.5 pr-3 font-normal text-right">Now</th>
            <th className="py-1.5 pr-3 font-normal text-right">P&L</th>
            <th className="py-1.5 pr-3 font-normal text-right">Stop / target</th>
            <th className="py-1.5 pr-3 font-normal text-right" title="$ per 1% SPX move, beta-weighted">Δ SPX 1%</th>
            <th className="py-1.5 pr-3 font-normal text-right">Θ / day</th>
            <th className="py-1.5 pr-3 font-normal text-right">Vega</th>
            <th className="py-1.5 font-normal">Source</th>
          </tr>
        </thead>
        <tbody>
          {book.map(p => {
            const r = risks[p.key];
            const st = stopFor(p, plan(p.timestamp)), tg = targetFor(p);
            const side = p.pos.isCredit ? 'cr' : 'db';
            return (
              <tr key={p.key} className="table-row cursor-pointer" data-testid="risk-row" onClick={() => onAct(p, p.working ? 'fills' : 'sell')}
                style={{ borderTop: `1px solid ${C.border}` }}>
                <td className="py-2 pr-3">
                  <div style={{ color: C.text, fontWeight: 600 }}>{p.underlying} <span style={{ fontWeight: 400 }}>{p.strategy}</span></div>
                  <div className="text-[11.5px]" style={{ color: C.faint }}>{p.engine} · β {betaOf(p.underlying)}{p.working ? ' · order working' : ''}</div>
                </td>
                <td className="py-2 pr-3 mono text-[12px]" style={{ color: p.legs ? C.text : C.amber }}>
                  {p.legs ? legsText(p.legs) : (p.row.legs || '—')}
                  {p.expiry && <div className="text-[11px]" style={{ color: C.faint }}>{isoOfYmd(p.expiry)}</div>}
                </td>
                <td className="py-2 pr-3 mono text-right">{p.working ? <span style={{ color: C.blue }}>{p.resting} wkg</span> : p.live}</td>
                <td className="py-2 pr-3 mono text-right" style={{ color: p.dte != null && p.dte < 0 ? C.red : C.text }}>{p.dte == null ? '—' : p.dte < 0 ? 'exp' : p.dte}</td>
                <td className="py-2 pr-3 mono text-right">{p.pos.ncd ? `${side} ${Math.abs(p.pos.ncd).toFixed(2)}` : '—'}</td>
                <td className="py-2 pr-3 mono text-right" style={{ color: r && r.markSource === 'model' ? C.muted : C.text }}>
                  {r && Number.isFinite(r.closePx) ? Math.max(0, r.closePx).toFixed(2) : '—'}{r && r.markSource === 'model' ? '*' : ''}
                </td>
                <td className="py-2 pr-3 mono text-right" style={{ color: pc(r && r.pnl) }}>{r ? money(r.pnl) : '—'}</td>
                <td className="py-2 pr-3 mono text-right text-[12px]">
                  {st ? <span style={{ color: C.red }}>{money(st.loss)}</span> : '—'}{' / '}{tg ? <span style={{ color: C.green }}>{money(tg.gain)}</span> : '—'}
                </td>
                <td className="py-2 pr-3 mono text-right" style={{ color: pc(r && r.spxDelta1) }}>{r ? money(r.spxDelta1) : '—'}</td>
                <td className="py-2 pr-3 mono text-right" style={{ color: pc(r && r.greeks.theta) }}>{r ? money(r.greeks.theta) : '—'}</td>
                <td className="py-2 pr-3 mono text-right" style={{ color: pc(r && r.greeks.vega) }}>{r ? money(r.greeks.vega) : '—'}</td>
                <td className="py-2 text-[11.5px] whitespace-nowrap" style={{ color: C.muted }}>
                  legs {p.legSource === 'TWS' ? 'TWS' : p.legSource === 'ticket' ? <span style={{ color: C.amber }}>ticket</span> : <span style={{ color: C.amber }}>none</span>}
                  {r && <> · {r.greeksSource === 'quotes' ? 'live' : <span style={{ color: C.amber }}>model</span>}</>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11.5px] mt-2" style={{ color: C.faint }}>* modelled: Black-Scholes at the leg's quoted IV, else the ticket's IV. Stop and target are $ for the open contracts (your saved plan, else 100% of entry; target by the strategy's exit rule).</p>
    </div>
  );
}

function Bar({ parts, total }) {
  return (
    <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: '#21262d' }}>
      {parts.map((x, i) => <div key={i} style={{ width: `${Math.min(100, (x.v / total) * 100)}%`, background: x.c }} />)}
    </div>
  );
}

function Budget({ budget }) {
  const e = budget.exp;
  const scale = Math.max(e.cap || 0, e.committed, 1);
  return (
    <div>
      <div className="flex justify-between text-[12.5px] mb-1">
        <span style={{ color: C.text }}>{plain$(e.live)} open <span style={{ color: C.blue }}>+ {plain$(e.working)} working</span></span>
        <span style={{ color: C.muted }}>{e.cap ? `cap ${plain$(e.cap)}` : 'no cap set (Settings)'}</span>
      </div>
      <Bar total={scale} parts={[{ v: e.live, c: e.overNow ? C.red : C.solid }, { v: e.working, c: '#1f6feb66' }]} />
      {e.cap && <div className="text-[12.5px] mt-1" style={{ color: e.overNow ? C.red : e.overIfFilled ? C.amber : C.muted }}>
        {e.overNow ? 'Over the cap now.' : e.overIfFilled ? 'Over the cap if the working orders fill.' : `${plain$(e.headroom)} of room left.`}</div>}

      <div className="text-[11.5px] uppercase tracking-wide mt-4 mb-1" style={{ color: C.muted }}>By expiry</div>
      <table className="w-full text-[13px]"><tbody>
        {budget.buckets.map(b => (
          <tr key={b.key}><td className="py-0.5" style={{ color: C.text }}>{b.key}</td>
            <td className="py-0.5 mono text-right">{plain$(b.live)}{b.working ? <span style={{ color: C.blue }}> + {plain$(b.working)}</span> : ''}</td>
            <td className="py-0.5 text-right text-[12px]" style={{ color: C.faint }}>{b.n}</td></tr>
        ))}
      </tbody></table>

      <div className="text-[11.5px] uppercase tracking-wide mt-4 mb-1" style={{ color: C.muted }}>By underlying</div>
      <table className="w-full text-[13px]"><tbody>
        {budget.underlyings.map(u => (
          <tr key={u.key}><td className="py-0.5" style={{ color: C.text }}>{u.key}</td>
            <td className="py-0.5 mono text-right">{plain$(u.live)}{u.working ? <span style={{ color: C.blue }}> + {plain$(u.working)}</span> : ''}</td>
            <td className="py-0.5 text-right text-[12px]" style={{ color: C.faint }}>{e.committed > 0 ? Math.round((u.live + u.working) / e.committed * 100) + '%' : ''}</td></tr>
        ))}
      </tbody></table>
      {budget.concentration && budget.underlyings.length > 1 && budget.concentration.share >= 0.6 && (
        <div className="text-[12.5px] mt-2" style={{ color: C.amber }}>{Math.round(budget.concentration.share * 100)}% of the risk is in {budget.concentration.key}.</div>
      )}
    </div>
  );
}

function Reconcile({ rec, bridge, onAct }) {
  if (!rec) return <div className="text-sm" style={{ color: C.muted }}>{bridge ? 'TWS positions not loaded yet — refresh when TWS is running.' : 'Needs the IBKR bridge to compare against TWS.'}</div>;
  if (!rec.extra.length && !rec.missing.length) return <div className="text-sm" style={{ color: C.green }}>The log and TWS agree: every option leg in TWS belongs to an open ticket.</div>;
  return (
    <div className="space-y-3">
      {rec.extra.length > 0 && (
        <div>
          <div className="text-[12.5px] mb-1" style={{ color: C.amber }}>In TWS but not (or not in that size) in the log — log it, or close it in TWS:</div>
          <table className="text-[13px]"><tbody>
            {rec.extra.map(l => (
              <tr key={`${l.underlying}${l.expiry}${l.strike}${l.right}`} data-testid="rec-extra">
                <td className="pr-4 mono" style={{ color: C.text }}>{l.underlying} {isoOfYmd(l.expiry)} {l.strike}{l.right}</td>
                <td className="pr-4 mono" style={{ color: C.muted }}>TWS {l.tws > 0 ? '+' : ''}{l.tws}</td>
                <td className="mono" style={{ color: C.muted }}>log {l.logged > 0 ? '+' : ''}{l.logged}</td>
              </tr>))}
          </tbody></table>
        </div>
      )}
      {rec.missing.length > 0 && (
        <div>
          <div className="text-[12.5px] mb-1" style={{ color: C.amber }}>Open in the log but not in TWS:</div>
          {rec.missing.map(m => (
            <div key={m.key} className="flex items-center gap-3 text-[13px] py-1" data-testid="rec-missing">
              <span style={{ color: C.text }}>{m.p.underlying} {m.p.strategy}</span>
              <span style={{ color: C.muted }}>{m.why}</span>
              <button onClick={() => onAct(m.p, 'sell')} className="ml-auto px-2.5 py-1 text-xs rounded-md" style={{ border: `1px solid ${C.border}`, color: C.text }}>Record close</button>
            </div>))}
        </div>
      )}
    </div>
  );
}
