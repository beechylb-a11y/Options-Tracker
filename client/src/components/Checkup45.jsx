import React, { useState } from 'react';
import { Stethoscope, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../utils/api';
import { reviewOpen45, ymdOfIso } from '../engine/review45';
import { computeTrend, trendLabel } from '../engine/trend';
import { matchTicketLegs, legsFromNotes, strategyName, parseStrikes } from '../utils/positionMatch';
import { positionStrip, rollCandidates, planRoll } from '../engine/positionPlan';
import { tradingSession, sessionDateOf } from '../engine/session';

// ── Open 45DTE check-up (Oct 2026) ──
// One card per open 45DTE ticket: what to do now (hold / take profit / roll /
// close), and whether it is going to plan — P&L against the theta-only path,
// split into what time, price and volatility did. Data: TWS positions and leg
// quotes, the vol surface (ATM IV + daily trend), and the logged ticket.

const BLUE = { fg: '#58a6ff', solid: '#2f81f7', bg: '#0c1d36', border: '#1f6feb' };
const TONE = {
  green: { fg: '#3fb950', bg: '#0f2417', border: '#238636' },
  amber: { fg: '#e3b341', bg: '#1f1a0d', border: '#9e6a03' },
  red: { fg: '#f85149', bg: '#2d0f11', border: '#6e2427' },
  grey: { fg: '#a8b2be', bg: '#161b22', border: '#30363d' },
};
const ACTION_LABEL = {
  'take-profit': 'Take profit', hold: 'Hold', watch: 'Watch', 'roll-untested': 'Roll untested side',
  'roll-out': 'Roll out', 'roll-short': 'Roll the short', close: 'Close', 'close-or-roll': 'Close or roll', unknown: 'No data',
};
const money = v => v == null ? '—' : (v >= 0 ? '+$' : '−$') + Math.abs(Math.round(v)).toLocaleString();
const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };

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

// Build everything reviewOpen45 needs for one ticket.
export function ticketInputs(d, openRow) {
  const contracts = num(d.Contracts) || 1;
  const qtyOpen = openRow && num(openRow.qtyOpen) != null ? num(openRow.qtyOpen) : contracts;
  const entryIso = sessionDateOf(d.Timestamp) || String(d.Timestamp || '').slice(0, 10);
  const maxProfit = num(d['Max Profit']), maxRisk = num(d['Max Risk']);
  return {
    key: d.Timestamp || d._rowIndex, underlying: String(d.Underlying || '').toUpperCase(),
    strategy: strategyName(d.Strategy), strikes: d['Wing Strikes'] || '', notes: d.Notes || '',
    qtyOpen, contracts,
    entry: { ncd: num(d['Net Debit/Credit']) || 0, dateYmd: ymdOfIso(entryIso), spot: num(d.Price), iv: num(d.IV),
      maxProfit: maxProfit != null ? maxProfit / contracts : null, maxRisk: maxRisk != null ? maxRisk / contracts : null },
  };
}

export default function Checkup45({ tickets, openPositions }) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [ranAt, setRanAt] = useState(null);

  const list = (tickets || []).filter(d => /45/.test(String(d.Engine || '')));

  async function run() {
    let bridgeUrl = '';
    try { bridgeUrl = localStorage.getItem('bridgeUrl') || ''; } catch (e) { /* private mode */ }
    if (!bridgeUrl) { setErr('Set the IBKR Bridge URL in Settings first — the check-up needs live legs and quotes.'); return; }
    setBusy(true); setErr('');
    const todayYmd = tradingSession().yyyymmdd;
    let open = openPositions;
    if (!open) { try { open = await api.getOpenPositions(); } catch (e) { open = []; } }
    const openByTs = {};
    (open || []).forEach(o => { if (o.timestamp) openByTs[o.timestamp] = o; });

    const pos = await getJson(bridgeUrl + '/api/positions', 15000);
    const raw = pos && Array.isArray(pos.raw) ? pos.raw : [];
    const posErr = pos && pos.error ? pos.error : null;

    const inputs = list.map(d => ticketInputs(d, openByTs[d.Timestamp]));
    const unds = [...new Set(inputs.map(t => t.underlying))];
    const surf = {};
    await Promise.all(unds.map(async u => {
      const vs = await getJson(bridgeUrl + '/api/vol-surface?underlying=' + u, 45000);
      surf[u] = vs && !vs.error ? { ...vs, trend: computeTrend(vs.daily) } : { error: vs && vs.error };
    }));

    const out = [];
    for (const t of inputs) {
      const m = matchTicketLegs({ ...t, todayYmd }, raw);
      let legs = m.legs, source = m.legs ? 'TWS' : null;
      if (!legs) { legs = legsFromNotes(t.notes); source = legs ? 'ticket notes' : null; }
      const vs = surf[t.underlying] || {};
      let now = { todayYmd, spot: num(vs.spot), iv: num(vs.iv) };
      let quoteErr = null;
      if (legs) {
        const nearExp = legs.map(l => l.expiry).sort()[0];
        const g = await getJson(bridgeUrl + '/api/option-greeks?underlying=' + t.underlying + '&expiry=' + nearExp
          + '&legs=' + encodeURIComponent(JSON.stringify(legs.map(l => ({ strike: l.strike, right: l.right, qty: l.qty, expiry: l.expiry })))), 40000);
        if (g && !g.error && Array.isArray(g.legs)) {
          let mark = 0, ok = true;
          legs = legs.map((l, i) => {
            const gl = g.legs[i] && g.legs[i].greeks;
            const mid = gl && gl.bid != null && gl.ask != null ? (gl.bid + gl.ask) / 2 : gl && gl.optPrice;
            if (mid == null) ok = false; else mark += l.qty * mid;
            return { ...l, iv: gl ? gl.iv : null, delta: gl ? gl.delta : null };
          });
          now = { ...now, mark: ok ? mark : undefined, spot: num(g.undPrice) || now.spot,
            delta: g.net ? g.net.delta : undefined, theta: g.net ? g.net.theta : undefined, vega: g.net ? g.net.vega : undefined };
          if (!ok) quoteErr = 'some legs had no quote — P&L not computed';
        } else quoteErr = (g && g.error) || 'no quotes';
      }
      const review = reviewOpen45({ strategy: t.strategy, legs: legs || [], qtyOpen: t.qtyOpen, entry: t.entry, now,
        trend: vs.trend || null, underlying: t.underlying });

      // "Short to roughly 25-30 delta" left the reader to find the strike. When a roll
      // is the action, ask the chain which LISTED strike that actually is, and quote
      // the pair — including what buying the old one back costs, so the credit is the
      // net and not the gross. Two extra calls, only for a ticket that needs them.
      let roll = null;
      if (review.action === 'roll-untested' && legs && now.spot > 0) {
        try {
          const sh = (review.metrics.shorts || []);
          const testedS = sh.find(x => x.tested);
          const oldShort = sh.find(x => !x.tested && x.untested);
          const right = oldShort && oldShort.right;
          const wing = right ? legs.filter(l => l.qty > 0 && l.right === right)
            .sort((a, b) => Math.abs(a.strike - oldShort.strike) - Math.abs(b.strike - oldShort.strike))[0] : null;
          const keepWidth = wing ? Math.abs(wing.strike - oldShort.strike) : 0;
          const exp = oldShort ? oldShort.expiry : null;
          if (right && keepWidth > 0 && exp) {
            const ls = await getJson(bridgeUrl + '/api/listed-strikes?underlying=' + t.underlying + '&expiry=' + exp, 30000);
            const listed = ls && !ls.error ? (right === 'C' ? ls.calls : ls.puts) : null;
            const cands = rollCandidates({ listed, spot: now.spot, right, keepWidth, oldShort: oldShort.strike });
            if (cands.length) {
              // Candidates, their wings, and the pair being replaced — one request.
              const want = [...new Set([...cands, ...cands.map(k => right === 'C' ? k + keepWidth : k - keepWidth),
                oldShort.strike, wing.strike])].sort((a, b) => a - b);
              const q = await getJson(bridgeUrl + '/api/option-greeks?underlying=' + t.underlying + '&expiry=' + exp
                + '&legs=' + encodeURIComponent(JSON.stringify(want.map(k => ({ strike: k, right, qty: 1, expiry: exp })))), 40000);
              if (q && !q.error && Array.isArray(q.legs)) {
                const mid = gl => (gl && gl.bid != null && gl.ask != null) ? (gl.bid + gl.ask) / 2 : (gl ? gl.optPrice : null);
                const quoted = want.map((k, i) => {
                  const gl = q.legs[i] && q.legs[i].greeks;
                  return { strike: k, right, delta: gl ? gl.delta : null, bid: gl ? gl.bid : null, ask: gl ? gl.ask : null, optPrice: gl ? gl.optPrice : null, _mid: mid(gl) };
                });
                const oS = quoted.find(x => x.strike === oldShort.strike), oL = quoted.find(x => x.strike === wing.strike);
                const closeOld = (oS && oS._mid != null && oL && oL._mid != null) ? +(oS._mid - oL._mid).toFixed(2) : null;
                roll = planRoll({ quoted: quoted.filter(x => cands.includes(x.strike) || want.includes(x.strike)),
                  keepWidth, right, spot: now.spot, ncd: review.metrics.ncd,
                  oldShort: oldShort.strike, oldLong: wing.strike,
                  testedShort: testedS ? testedS.strike : null, closeOld });
              }
            }
          }
        } catch (e) { roll = null; }   // a roll suggestion is a convenience, never a blocker
      }
      out.push({ t, legs, source, note: m.legs ? m.note : (legs ? '' : m.note), quoteErr, review, trend: vs.trend, spot: now.spot, roll });
    }
    setRows({ list: out, posErr });
    setRanAt(new Date());
    setBusy(false);
  }

  return (
    <div className="card mb-4 fade-in" data-testid="checkup" style={{ borderColor: BLUE.border, borderTop: `4px solid ${BLUE.solid}` }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 className="text-sm font-medium text-white flex items-center gap-2">
            <Stethoscope size={15} color={BLUE.fg} /> Open 45DTE check-up
          </h3>
          <p className="text-xs text-text-muted mt-1">
            Is each trade going to plan, and what does the playbook say now — hold, take profit, roll or close.
          </p>
          {ranAt && <p className="text-[12.5px] mono mt-1" style={{ color: '#a8b2be' }}>Checked {ranAt.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false })}</p>}
        </div>
        <button onClick={run} disabled={busy || !list.length} data-testid="checkup-run"
          className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
          style={{ background: BLUE.solid, color: '#0d1117' }}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          {busy ? 'Checking…' : `Check ${list.length} open trade${list.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {err && <div className="text-sm mb-3" style={{ color: '#f85149' }}>{err}</div>}
      {rows && rows.posErr && <div className="text-[12.5px] mb-3" style={{ color: '#d29922' }}>TWS positions: {rows.posErr} — using the legs logged with each ticket where there are any.</div>}
      {!list.length && <div className="py-6 text-center text-sm" style={{ color: '#8b949e' }}>No open 45DTE tickets.</div>}
      {list.length > 0 && !rows && !busy && (
        <div className="py-6 text-center text-sm" style={{ color: '#8b949e' }}>
          {list.map(d => d.Underlying + ' ' + strategyName(d.Strategy)).join(' · ')}
        </div>
      )}
      <div className="space-y-3">
        {rows && rows.list.map(row => <CheckupCard key={row.t.key} row={row} />)}
      </div>
    </div>
  );
}

function CheckupCard({ row }) {
  const [more, setMore] = useState(false);
  const { t, review: rv, legs, source, note, quoteErr, trend, spot, roll } = row;
  const m = rv.metrics || {};
  const tone = TONE[rv.tone] || TONE.grey;
  const label = ACTION_LABEL[rv.action] || rv.action;
  return (
    <div data-testid="checkup-card" data-action={rv.action}
      style={{ border: `1px solid #30363d`, borderLeft: `4px solid ${tone.fg}`, borderRadius: 10, padding: 14, background: '#0d1117' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span data-testid="checkup-action" style={{ padding: '4px 10px', borderRadius: 6, fontWeight: 800, fontSize: 13, letterSpacing: '.02em',
          textTransform: 'uppercase', color: tone.fg, background: tone.bg, border: `1px solid ${tone.border}` }}>{label}</span>
        <span style={{ color: '#e6edf3', fontWeight: 600 }}>{t.underlying} {t.strategy}</span>
        <span className="mono" style={{ color: '#8b949e', fontSize: 12.5 }}>{parseStrikes(t.strikes).join(' / ')} · {t.qtyOpen} open</span>
        {m.pnl$ != null && <span className="mono" style={{ marginLeft: 'auto', fontWeight: 700, color: m.pnl$ >= 0 ? '#3fb950' : '#f85149' }}>{money(m.pnl$)}</span>}
      </div>
      <div style={{ marginTop: 6, color: tone.fg, fontSize: 13.5 }}>{rv.headline}</div>

      {rv.action !== 'unknown' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,1fr)', gap: 16, marginTop: 12 }}>
          <PlanTrack m={m} />
          <Attribution a={m.attribution} />
        </div>
      )}
      {rv.action !== 'unknown' && legs && spot > 0 && <StrikeStrip legs={legs} spot={spot} shorts={m.shorts || []} ncd={m.ncd} />}
      {roll && <RollPlan roll={roll} />}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
        {m.dte != null && <Chip label="DTE" val={m.dte} tone={m.daysToClose <= 5 ? 'amber' : null}
          tip={`Time stop at ${m.closeDte} DTE — ${m.daysToClose > 0 ? m.daysToClose + ' days away' : 'reached'}`} />}
        {m.daysToClose != null && <Chip label="time stop" val={m.daysToClose > 0 ? `in ${m.daysToClose}d` : 'now'} tone={m.daysToClose <= 0 ? 'red' : m.daysToClose <= 5 ? 'amber' : null} />}
        {m.stopPrice != null && <Chip label="stop" val={`@${m.stopPrice.toFixed(2)} · ${money(m.stop$)}`}
          tone={m.toStop$ != null && m.toStop$ <= 0 ? 'red' : m.toStop$ != null && m.stop$ && m.toStop$ < Math.abs(m.stop$) * 0.3 ? 'amber' : null}
          tip={`Stop guide: ${m.stopPct}% of the entry premium.${m.toStop$ != null ? ` ${m.toStop$ > 0 ? money(m.toStop$) + ' of room left' : 'Reached.'}` : ''}`} />}
        {m.ivChange ? <Chip label="IV since entry" val={(m.ivChange > 0 ? '+' : '') + m.ivChange + ' pts'}
          tone={(m.shortVega && m.ivChange >= 2) || (!m.shortVega && m.ivChange <= -2) ? 'amber' : (m.shortVega && m.ivChange < 0) ? 'green' : null} /> : null}
        {trend && <Chip label="trend" val={trendLabel(trend)} tone={m.trendFit < 0 ? 'amber' : m.trendFit > 0 ? 'green' : null}
          tip={(m.trendFit < 0 ? 'Against your delta. ' : m.trendFit > 0 ? 'With your delta. ' : '') + trend.why} />}
        {m.events && m.events.length > 0 && <Chip label="events" val={m.events.length + ' before stop'} tone="amber"
          tip={m.events.map(e => `${e.label} ${e.date}`).join(' · ')} />}
        {source && <Chip label="legs" val={source} tone={source === 'TWS' ? null : 'amber'} />}
      </div>

      {(note || quoteErr) && <div style={{ marginTop: 8, fontSize: 12.5, color: '#d29922' }}>{[note, quoteErr].filter(Boolean).join(' · ')}</div>}
      {rv.warnings.length > 0 && (
        <ul style={{ marginTop: 8, fontSize: 12.5, color: '#e3b341', paddingLeft: 16, listStyle: 'disc' }}>
          {rv.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      {(rv.steps.length > 0 || rv.reasons.length > 0) && (
        <div style={{ marginTop: 8 }}>
          <button onClick={() => setMore(!more)} style={{ fontSize: 12.5, color: '#58a6ff', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {more ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {more ? 'Hide' : 'How and why'}
          </button>
          {more && (
            <div style={{ marginTop: 6, fontSize: 13, color: '#c9d1d9' }}>
              {rv.steps.map((s, i) => <div key={'s' + i} style={{ marginBottom: 4 }}>→ {s}</div>)}
              {rv.reasons.map((s, i) => <div key={'r' + i} style={{ marginBottom: 4, color: '#a8b2be' }}>{s}</div>)}
              <div style={{ marginTop: 4, color: '#8b949e', fontSize: 12 }}>Rule: {rv.rule.why || `${rv.rule.target}% target`} · close by {m.closeDte} DTE</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ label, val, tone, tip }) {
  const c = tone ? TONE[tone] : TONE.grey;
  return (
    <span title={tip} style={{ display: 'inline-flex', gap: 5, padding: '3px 8px', borderRadius: 6, fontSize: 12.5,
      background: c.bg, border: `1px solid ${c.border}`, color: tone ? c.fg : '#c9d1d9' }}>
      <span style={{ color: '#8b949e' }}>{label}</span><span className="mono">{val}</span>
    </span>
  );
}

// Time elapsed of the planned hold against progress to the profit target, with
// the theta-only plan as a ghost marker. One glance: are we where we should be?
function PlanTrack({ m }) {
  const W = 100;
  const tf = Math.max(0, Math.min(1, m.timeFrac || 0));
  const prog = m.progress;
  const planProg = m.plan$ != null && m.target$ ? m.plan$ / m.target$ : null;
  const clamp = x => Math.max(-0.5, Math.min(1.2, x));
  const pace = m.pace;
  const col = pace === 'target' || pace === 'ahead' || pace === 'on plan' ? '#3fb950' : pace === 'behind' ? '#d29922' : '#f85149';
  const X = x => ((clamp(x) + 0.5) / 1.7) * W;           // −50% … +120% of target across the bar
  return (
    <div data-testid="plan-track">
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 4 }}>
        Going to plan? <b style={{ color: col, textTransform: 'capitalize' }}>{pace === 'target' ? 'target reached' : pace}</b>
      </div>
      <svg viewBox={`0 0 ${W} 30`} width="100%" height="44" preserveAspectRatio="none" role="img"
        aria-label={`Profit ${prog != null ? Math.round(prog * 100) : '—'}% of target; ${Math.round(tf * 100)}% of planned hold elapsed`}>
        {/* time row */}
        <rect x="0" y="3" width={W} height="5" rx="2.5" fill="#21262d" />
        <rect x="0" y="3" width={tf * W} height="5" rx="2.5" fill="#58a6ff" opacity="0.8" />
        {/* profit row */}
        <rect x="0" y="16" width={W} height="9" rx="3" fill="#21262d" />
        <line x1={X(0)} x2={X(0)} y1="14" y2="27" stroke="#484f58" strokeWidth="0.6" />
        <line x1={X(1)} x2={X(1)} y1="13" y2="28" stroke="#3fb950" strokeWidth="0.8" strokeDasharray="1.5 1" />
        {prog != null && <rect x={Math.min(X(0), X(prog))} y="16" width={Math.abs(X(prog) - X(0))} height="9" rx="2" fill={col} opacity="0.85" />}
        {planProg != null && <rect x={X(planProg) - 0.6} y="14" width="1.2" height="13" fill="#e6edf3" opacity="0.9" />}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#a8b2be' }} className="mono">
        <span>{m.daysHeld}d of {m.daysHeld + Math.max(0, m.daysToClose)}d hold</span>
        <span>{money(m.pnl$)} of {money(m.target$)} target{m.plan$ != null ? ` · plan ${money(m.plan$)}` : ''}</span>
      </div>
    </div>
  );
}

// What time, price and volatility each did since entry (per lot × open lots).
function Attribution({ a }) {
  if (!a) return <div style={{ fontSize: 12.5, color: '#8b949e' }}>Entry price or IV not logged — no time / price / vol split.</div>;
  const parts = [['Time', a.time], ['Price', a.price], ['Vol', a.vol]];
  if (a.other != null && Math.abs(a.other) >= 5) parts.push(['Other', a.other]);
  const max = Math.max(1, ...parts.map(p => Math.abs(p[1] || 0)));
  return (
    <div data-testid="attribution">
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 4 }}>Since entry, per lot</div>
      {parts.map(([k, v]) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '44px 1fr 56px', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: '#a8b2be' }}>{k}</span>
          <div style={{ position: 'relative', height: 8, background: '#161b22', borderRadius: 4 }}>
            <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#484f58' }} />
            <div style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 4, background: v >= 0 ? '#3fb950' : '#f85149',
              left: v >= 0 ? '50%' : `${50 - 50 * Math.abs(v) / max}%`, width: `${50 * Math.abs(v || 0) / max}%` }} />
          </div>
          <span className="mono" style={{ textAlign: 'right', color: v >= 0 ? '#3fb950' : '#f85149' }}>{money(v)}</span>
        </div>
      ))}
    </div>
  );
}

// Strikes against spot: shorts red (amber when pressured, filled when tested), longs blue.
// The roll the card recommends, as a pair of strikes and a price — and what it
// costs. A roll described only as "for extra credit" reads as free money. It is a
// trade: cushion on the side under pressure, bought with room on the side that was
// winning. Both halves, or neither. (Oct 2026.)
function RollPlan({ roll }) {
  const r = roll;
  const side = r.right === 'C' ? 'call' : 'put';
  const good = r.worthIt === true;
  return (
    <div data-testid="roll-plan" style={{ marginTop: 12, padding: '10px 12px', borderRadius: 8,
      background: '#161b22', border: '1px solid #30363d' }}>
      <div style={{ fontSize: 13, color: '#e6edf3' }}>
        Roll the {side} spread to{' '}
        <b className="mono">{r.shortStrike}/{r.longStrike}</b>{' '}
        <span className="mono" style={{ color: '#8b949e' }}>({Math.round(r.delta * 100)}Δ)</span>
        {r.net != null && <> for about <b className="mono" style={{ color: r.net >= 0 ? '#3fb950' : '#f85149' }}>
          {r.net >= 0 ? '+' : ''}{r.net.toFixed(2)}</b></>}
        {r.closeCost != null && <span style={{ color: '#8b949e' }}> (net of {r.closeCost.toFixed(2)} to close the old pair)</span>}
      </div>
      {r.cushionGained != null && r.roomGiven != null && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: good ? '#3fb950' : '#d29922' }}>
          Buys <b className="mono">{r.cushionGained.toFixed(2)}</b> of cushion on the tested side;
          gives up <b className="mono">{r.roomGiven.toFixed(2)}</b> on this one
          {r.breakevenBefore != null && <span style={{ color: '#8b949e' }} className="mono">
            {' '}(break-even {Math.round(r.breakevenBefore)} → {Math.round(r.breakevenAfter)})</span>}.
        </div>
      )}
      {r.distanceToNewShort != null && (
        <div style={{ marginTop: 4, fontSize: 12, color: '#8b949e' }}>
          The new short sits <span className="mono">{r.distanceToNewShort.toFixed(0)}</span> from price.
          {!good && ' Worth it only if you think the move continues — it is not free credit.'}
        </div>
      )}
    </div>
  );
}

function StrikeStrip({ legs, spot, shorts, ncd }) {
  // Strikes alone never said where price sat among them, nor where the trade stops
  // making money. Both come from one pure geometry now (engine/positionPlan), so the
  // band and the markers cannot drift apart. (Oct 2026.)
  const sh = k => shorts.find(s => s.strike === k.strike && s.right === k.right);
  const tested = (shorts || []).find(s => s.tested);
  const strip = positionStrip({ legs, spot, ncd, testedStrike: tested ? tested.strike : null });
  const uniq = [];
  legs.forEach(l => { if (!uniq.some(u => u.strike === l.strike && u.right === l.right)) uniq.push(l); });
  if (!strip) {
    return <div data-testid="strike-strip" style={{ fontSize: 12, color: '#8b949e', marginTop: 12 }}>
      Entry price not logged — no break-even band.</div>;
  }
  const X = v => strip.at(v) * 100;
  return (
    <div data-testid="strike-strip" style={{ position: 'relative', height: 56, marginTop: 14 }}>
      {strip.zone && (
        <div title={`Break-even ${strip.zone.from} to ${strip.zone.to} — profitable at expiry between them`}
          style={{ position: 'absolute', left: `${strip.zone.x0 * 100}%`, width: `${(strip.zone.x1 - strip.zone.x0) * 100}%`,
            top: 15, height: 14, background: 'rgba(63,185,80,0.14)', border: '1px solid rgba(63,185,80,0.45)', borderRadius: 3 }} />
      )}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 21, height: 2, background: '#30363d' }} />
      {strip.breakevens.map((b, i) => (
        <div key={'be' + i} title={`Break-even ${b.value}`}
          style={{ position: 'absolute', left: `${b.x * 100}%`, top: 15, transform: 'translateX(-50%)' }}>
          <div style={{ width: 1, height: 14, background: '#3fb950', opacity: 0.85 }} />
          <div className="mono" style={{ fontSize: 10, color: '#3fb950', position: 'absolute', top: 15,
            left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{Math.round(b.value)}</div>
        </div>
      ))}
      {uniq.map((l, i) => {
        const s2 = sh(l);
        const c = l.qty < 0 ? (s2 && s2.tested ? '#f85149' : s2 && s2.pressured ? '#d29922' : '#f0883e') : '#58a6ff';
        return (
          <div key={i} style={{ position: 'absolute', left: `${X(l.strike)}%`, top: 9, transform: 'translateX(-50%)', textAlign: 'center' }}
            title={`${l.qty > 0 ? '+' : ''}${l.qty} ${l.strike}${l.right} ${l.expiry}${s2 && s2.absDelta != null ? ` · ${Math.round(s2.absDelta * 100)}\u0394` : ''}${s2 && s2.tested ? ' · tested' : ''}`}>
            <div style={{ width: 3, height: 24, margin: '0 auto', background: c, borderRadius: 1, opacity: s2 && s2.tested ? 1 : 0.85 }} />
            <div className="mono" style={{ fontSize: 10.5, color: c, whiteSpace: 'nowrap' }}>{l.strike}{l.right}</div>
          </div>
        );
      })}
      <div style={{ position: 'absolute', left: `${strip.spot.x * 100}%`, top: 15, transform: 'translateX(-50%)' }}
        title={`Spot ${spot} — ${strip.spot.inProfit ? 'inside' : 'outside'} the break-evens`}>
        <div style={{ width: 12, height: 12, borderRadius: '50%',
          background: strip.spot.inProfit ? '#e6edf3' : '#f85149', border: '2px solid #0d1117' }} />
        <div className="mono" style={{ fontSize: 10.5, color: '#e6edf3', position: 'absolute', top: -14, left: '50%', transform: 'translateX(-50%)', whiteSpace: 'nowrap' }}>{spot}</div>
      </div>
    </div>
  );
}
