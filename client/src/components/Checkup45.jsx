import React, { useState } from 'react';
import { Stethoscope, RefreshCw, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { api } from '../utils/api';
import { reviewOpen45, ymdOfIso, daysBetweenYmd } from '../engine/review45';
import { review0, nyMinutes } from '../engine/review0';
import { rollChain, legIvsFromNotes } from '../engine/rollChain';
import { computeTrend, trendLabel } from '../engine/trend';
import { matchTicketLegs, legsFromNotes, strategyName, parseStrikes } from '../utils/positionMatch';
import { positionStrip, rollCandidates, planRoll } from '../engine/positionPlan';
import { tradingSession, sessionDateOf } from '../engine/session';
import TradeDetail from './TradeDetail';
import { withEntryFill, loadPlan } from '../utils/ticketMath';
import { ActionBadge, PnlMeter, fmtYmd as fmtYmdV, CushionGauge, ClockGauge, PriceMap, Triggers, reasonChips, Reasons, NextStep } from './CheckupVisual';

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
export const ACTION_LABEL = {
  'take-profit': 'Take profit', hold: 'Hold', watch: 'Watch', 'roll-untested': 'Roll untested side',
  'roll-out': 'Roll out', 'roll-short': 'Roll the short', close: 'Close', 'close-or-roll': 'Close or roll', 'record-expiry': 'Expired', unknown: 'No data',
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
// Entry, max profit and max risk come from the FILLS when they are recorded (the same
// restatement the Open positions table uses), and stop / target from the exit plan
// saved at entry — so the check-up and the Dashboard quote the same numbers.
// (Oct 2026: the Dashboard said stop −$1,995 off the 3.99 fill and the check-up
// worked off the logged entry with the default stop.)
export function exitPlanOf(ts) {
  const plan = ts ? loadPlan(ts) : null;
  if (!plan) return {};
  const stopPct = plan.stopPct !== '' && plan.stopPct != null && isFinite(parseFloat(plan.stopPct)) ? Math.abs(parseFloat(plan.stopPct)) : null;
  const rows = Array.isArray(plan.rows) ? plan.rows.filter(x => Number(x.qty) > 0 && Number(x.pct) > 0) : [];
  const q = rows.reduce((a, x) => a + Number(x.qty), 0);
  const targetPct = q ? rows.reduce((a, x) => a + Number(x.pct) * Number(x.qty), 0) / q : null;
  return { stopPct: stopPct > 0 ? stopPct : null, targetPct };
}

export function ticketInputs(d, openRow, history = null) {
  const contracts = num(d.Contracts) || 1;
  const qtyOpen = openRow && num(openRow.qtyOpen) != null ? num(openRow.qtyOpen) : contracts;
  const entryIso = sessionDateOf(d.Timestamp) || String(d.Timestamp || '').slice(0, 10);
  const filled = openRow ? withEntryFill(openRow) : null;
  const fromFills = !!(filled && filled._entryFromFills);
  const maxProfit = fromFills && num(filled.maxProfit) != null ? num(filled.maxProfit) : num(d['Max Profit']);
  const maxRisk = fromFills && num(filled.maxRisk) != null ? num(filled.maxRisk) : num(d['Max Risk']);
  const lots = fromFills ? (num(filled.qty) || contracts) : contracts;
  const ncd = fromFills ? num(filled.entryPrice) : num(d['Net Debit/Credit']);
  return {
    plan: exitPlanOf(d.Timestamp),
    engine: String(d.Engine || ''),
    key: d.Timestamp || d._rowIndex, underlying: String(d.Underlying || '').toUpperCase(),
    strategy: strategyName(d.Strategy), strikes: d['Wing Strikes'] || '', notes: d.Notes || '',
    qtyOpen, contracts,
    entry: { ncd: ncd || 0, dateYmd: ymdOfIso(entryIso), spot: num(d.Price), iv: num(d.IV),
      legIvs: legIvsFromNotes(d.Notes),
      maxProfit: maxProfit != null ? maxProfit / lots : null, maxRisk: maxRisk != null ? maxRisk / lots : null },
    // Earlier tickets this one was rolled from, and what they banked (Oct 2026).
    chain: history ? rollChain(d, history) : null,
  };
}

// ── One check-up, shared (Oct 2026) ──
// The Dashboard and the Decision Engine both show the verdict for the same trades.
// They read ONE pass: whoever asks first runs it, the other reuses it for a minute,
// so the two screens cannot disagree. force:true always runs a fresh pass.
const CACHE_MS = 60 * 1000;
let lastRun = null;   // { key, at, promise }
export function bridgeUrlOf() {
  try { return localStorage.getItem('bridgeUrl') || ''; } catch (e) { return ''; }
}
export function runCheckup({ tickets, openPositions, bridgeUrl = bridgeUrlOf(), force = false }) {
  const key = (tickets || []).map(d => d.Timestamp || d._rowIndex).sort().join('|');
  if (!force && lastRun && lastRun.key === key && Date.now() - lastRun.at < CACHE_MS) return lastRun.promise;
  const promise = runCheckupNow({ tickets, openPositions, bridgeUrl });
  lastRun = { key, at: Date.now(), promise, result: null };
  promise.then(res => { if (lastRun && lastRun.promise === promise) lastRun.result = res; }).catch(() => {});
  promise.catch(() => { if (lastRun && lastRun.promise === promise) lastRun = null; });
  return promise;
}
export function clearCheckupCache() { lastRun = null; }

/**
 * The check-up for ONE ticket — for the Sell / Roll ticket. Reuses the shared pass when
 * it already holds this ticket and is under a minute old (the Dashboard runs it on
 * load), so the ticket shows exactly what the board showed; otherwise checks just this
 * one, without displacing the shared pass. Null for anything that isn't 45DTE.
 */
export async function checkupFor(dec, openRow, { bridgeUrl = bridgeUrlOf() } = {}) {
  if (!dec || !/45|0DTE/i.test(String(dec.Engine || '')) || !bridgeUrl) return null;
  const key = dec.Timestamp || dec._rowIndex;
  if (lastRun && Date.now() - lastRun.at < CACHE_MS) {
    const res = lastRun.result || await lastRun.promise.catch(() => null);
    const hit = res && (res.list || []).find(x => x.t.key === key);
    if (hit) return hit;
  }
  const res = await runCheckupNow({ tickets: [dec], openPositions: openRow ? [openRow] : null, bridgeUrl }).catch(() => null);
  return res && res.list && res.list[0] ? res.list[0] : null;
}

async function runCheckupNow({ tickets, openPositions, bridgeUrl }) {
  // 45DTE and, since Oct 2026, 0DTE: one pass, so the board, the Sell ticket and the
  // check-up card read the same live mark for every open trade.
  const list = (tickets || []).filter(d => /45|0DTE/i.test(String(d.Engine || '')));
  const todayYmd = tradingSession().yyyymmdd;
  let open = openPositions;
  if (!open) { try { open = await api.getOpenPositions(); } catch (e) { open = []; } }
  const openByTs = {};
  (open || []).forEach(o => { if (o.timestamp) openByTs[o.timestamp] = o; });

  // Every ticket and close, to follow a rolled ticket back to the first one.
  const [allDec, allCloses, pos] = await Promise.all([
    Promise.resolve().then(() => api.getDecisions()).catch(() => []),
    Promise.resolve().then(() => api.getCloses()).catch(() => []),
    getJson(bridgeUrl + '/api/positions', 15000),
  ]);
  const history = { decisions: Array.isArray(allDec) ? allDec : [], closes: Array.isArray(allCloses) ? allCloses : [] };
  const raw = pos && Array.isArray(pos.raw) ? pos.raw : [];
  const posErr = pos && pos.error ? pos.error : null;

  const inputs = list.map(d => ticketInputs(d, openByTs[d.Timestamp], history));
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
    // A vol-surface failure was swallowed here: spot came back undefined, every
    // short read in the money, and the card recommended a roll with no price
    // behind it. Say it instead. (Oct 2026.)
    let quoteErr = vs.error ? `vol surface: ${vs.error}` : null;
    // Where the price came from, and whether it is today's. The bridge now says so
    // rather than handing back a bare number or a zero; a check-up run off a stale
    // close is still worth reading, but only if the reader knows that is what it is.
    const priceNote = (vs.notes || []).find(n => /no live price|entitlement|no ticks|sent no ticks|no price for/i.test(n)) || null;
    let spotFromGreeks = false;
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
        spotFromGreeks = num(g.undPrice) > 0;
        now = { ...now, mark: ok ? mark : undefined, spot: num(g.undPrice) || now.spot,
          delta: g.net ? g.net.delta : undefined, theta: g.net ? g.net.theta : undefined, vega: g.net ? g.net.vega : undefined };
        if (!ok) quoteErr = 'some legs had no quote — P&L not computed';
      } else quoteErr = (g && g.error) || 'no quotes';
    }
    const is0 = /0DTE/i.test(t.engine || '');
    // 0DTE: the move left to the bell, from the ATM IV, for "how close is close".
    const minsLeft = Math.max(1, 16 * 60 - nyMinutes(new Date()));
    const sd0 = now.spot > 0 && now.iv > 0 ? now.spot * (now.iv / 100) * Math.sqrt(minsLeft / (390 * 252)) : null;
    const review = is0
      ? review0({ legs: legs || [], qtyOpen: t.qtyOpen, entry: t.entry, underlying: t.underlying, strategy: t.strategy,
          now: { mark: now.mark, spot: now.spot, sd: sd0, at: new Date() }, stopPct: t.plan && t.plan.stopPct, targetPct: t.plan && t.plan.targetPct })
      : reviewOpen45({ strategy: t.strategy, legs: legs || [], qtyOpen: t.qtyOpen, entry: t.entry, now,
          trend: vs.trend || null, underlying: t.underlying, stopPct: t.plan && t.plan.stopPct, targetPct: t.plan && t.plan.targetPct });

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
    out.push({ t, openRow: openByTs[t.key] || null,
      legs, source, note: m.legs ? m.note : (legs ? '' : m.note), quoteErr, review, trend: vs.trend,
      spot: now.spot, roll,
      // The greeks' undPrice overrides the surface spot where it exists, so a stale
      // surface price only stands if the greeks had none either.
      spotStale: !!vs.spotStale && !spotFromGreeks, spotAsOf: vs.spotAsOf || null, priceNote });
  }
return { list: out, posErr, at: new Date() };
}

export default function Checkup45({ tickets, openPositions }) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [ranAt, setRanAt] = useState(null);

  const list = (tickets || []).filter(d => /45/.test(String(d.Engine || '')));

  async function run() {
    const bridgeUrl = bridgeUrlOf();
    if (!bridgeUrl) { setErr('Set the IBKR Bridge URL in Settings first — the check-up needs live legs and quotes.'); return; }
    setBusy(true); setErr('');
    try {
      const res = await runCheckup({ tickets: list, openPositions, bridgeUrl, force: true });
      setRows(res);
      setRanAt(res.at);
    } catch (e) { setErr(e.message); }
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

const absMoney = v => '$' + Math.abs(Math.round(v || 0)).toLocaleString();   // round first: −13.5 reads $13, as money() does
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtYmd = y => (y && String(y).length === 8 ? `${+String(y).slice(6, 8)} ${MON[+String(y).slice(4, 6) - 1]}` : '—');
function ymdAdd(y, n) {
  const d = new Date(Date.UTC(+y.slice(0, 4), +y.slice(4, 6) - 1, +y.slice(6, 8)) + n * 86400000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
const PACE_COL = { target: '#3fb950', ahead: '#3fb950', 'on plan': '#3fb950', behind: '#d29922', 'off plan': '#f85149', unknown: '#8b949e' };

// The P&L of the open lots split into time / price / IV / not explained, in $ for
// every open contract (the panel used to show these per lot beside a total).
export function breakdown(m, qty) {
  const a = m.attribution;
  if (!a) return null;
  const k = Math.max(1, qty || 1);
  return { time: (a.time || 0) * k, price: (a.price || 0) * k, vol: (a.vol || 0) * k,
    other: a.other != null ? a.other * k : null, skewIncluded: !!a.skewIncluded };
}

/** One plain sentence: where the trade is against its plan, and the position across rolls. */
export function summaryLine(m, chain, qty) {
  const parts = [];
  if (m.daysHeld != null && m.planDays) {
    parts.push(m.daysHeld > m.planDays ? `Past the planned close (${m.planDays} days held).`
      : `Day ${m.daysHeld} of ${m.planDays} in the planned hold${chain ? ' of the rolled ticket' : ''}.`);
  }
  if (m.pnl$ != null) {
    let s = `${m.pnl$ >= 0 ? 'Up' : 'Down'} ${absMoney(m.pnl$)}${chain ? ' on this ticket' : ''}`;
    if (m.plan$ != null) s += `; time decay alone would have it ${m.plan$ >= 0 ? 'up' : 'down'} ${absMoney(m.plan$)}`;
    parts.push(s + '.');
  }
  if (chain && m.pnl$ != null) {
    const pos = m.pnl$ + chain.banked;
    parts.push(`With the ${money(chain.banked)} banked when you rolled${chain.rolls > 1 ? ` (${chain.rolls} rolls)` : ''}, the whole position is ${pos >= 0 ? 'up' : 'down'} ${absMoney(pos)}.`);
  }
  const b = breakdown(m, qty);
  if (b && b.other != null && m.pnl$ != null && Math.abs(b.other) > Math.max(50, Math.abs(b.price) + Math.abs(b.vol))) {
    parts.push(`Most of the ${b.other < 0 ? 'loss' : 'gain'} is not price or IV — see “not explained” below.`);
  }
  return parts.join(' ');
}

/** Rows for the P&L meter: what each earlier ticket banked at its roll (with the roll
 *  trade's net credit/debit), then the open ticket. Null when there was no roll. */
export function pnlSteps(chain, m, q) {
  if (!chain || m.pnl$ == null) return null;
  const rows = chain.links.map((l, i) => {
    const qty = (chain.links[i + 1] && chain.links[i + 1].qty) || q || l.qty;
    return {
      kind: 'roll', label: fmtYmdV(l.closeYmd), v: l.realised, net: l.net,
      title: `${l.strikes || 'TICKET-' + l.ref} · opened ${fmtYmdV(l.entryYmd)} · rolled ${fmtYmdV(l.closeYmd)} · banked ${money(l.realised)}`,
      netTitle: l.net != null && qty ? `Roll trade ${l.net >= 0 ? 'took in' : 'paid'} ${money(Math.abs(l.net) * 100 * qty).replace(/^[+−]/, '')} net (${Math.abs(l.net).toFixed(2)} × 100 × ${qty})` : '',
    };
  });
  rows.push({ kind: 'open', label: 'open', v: m.pnl$, title: `this ticket since ${fmtYmdV(m.entryYmd)}` });
  return rows;
}

export function CheckupCard({ row }) {
  const [more, setMore] = useState(false);
  const [detail, setDetail] = useState(false);
  const [open, setOpen] = useState(false);
  const { t, review: rv, legs, source, note, quoteErr, trend, spot, roll, spotStale, spotAsOf, priceNote } = row;
  const chain = t.chain || null;
  const m = rv.metrics || {};
  const tone = TONE[rv.tone] || TONE.grey;
  const label = ACTION_LABEL[rv.action] || rv.action;
  const banked = chain ? chain.banked : 0;
  const posPnl = m.pnl$ != null ? m.pnl$ + banked : null;
  const nextStep = rv.steps && rv.steps[0];
  const q = t.qtyOpen;
  const targetPx = m.target$ != null && m.ncd != null && q
    ? (m.isCredit ? Math.abs(m.ncd) - m.target$ / (100 * q) : Math.abs(m.ncd) + m.target$ / (100 * q)) : null;
  const closeYmd = m.nearExp && m.closeDte != null ? ymdAdd(m.nearExp, -m.closeDte) : null;
  // The whole position's entry per share: this ticket's plus what the earlier tickets
  // banked, spread over the open contracts — so break-evens are the position's.
  const ncdPos = m.ncd != null ? m.ncd + (chain && q ? banked / (100 * q) : 0) : null;
  const shorts = m.shorts || [];
  const near = shorts.filter(x => x.cushion != null).sort((a, b) => a.cushion - b.cushion)[0] || null;
  const sdExp = near && near.cushionSd ? Math.abs(near.cushion / near.cushionSd) : null;
  const sdStop = sdExp && m.dte > 0 ? sdExp * Math.sqrt(Math.max(0.5, m.daysToClose || 0) / m.dte) : null;
  const chips = reasonChips({ shorts, events: m.events, ivChange: m.ivChange, shortVega: m.shortVega, trendFit: m.trendFit, warnings: rv.warnings });
  const live = rv.action !== 'unknown';
  // Rolled: the P&L bar is built roll by roll and gets its own full-width row.
  const steps = pnlSteps(chain, m, q);
  const meter = <PnlMeter now={posPnl} stop={m.stop$ != null ? banked + m.stop$ : null} target={m.target$ != null ? banked + m.target$ : null}
    plan={m.plan$ != null ? banked + m.plan$ : null} steps={steps} />;
  return (
    <div data-testid="checkup-card" data-action={rv.action}
      style={{ border: `1px solid #30363d`, borderLeft: `5px solid ${tone.fg}`, borderRadius: 12, padding: 16, background: '#0d1117' }}>
      {/* verdict · position · P&L */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <ActionBadge action={rv.action} tone={rv.tone} label={label} />
        <div style={{ minWidth: 0 }}>
          <div data-testid="checkup-title" className="mono" style={{ color: '#ffffff', fontWeight: 800, fontSize: 20, lineHeight: 1.25, letterSpacing: '.01em',
            display: 'flex', flexWrap: 'wrap', columnGap: 14, rowGap: 2 }}>
            <span style={{ whiteSpace: 'nowrap' }}>{t.underlying} {parseStrikes(t.strikes).join('/')}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{String(t.strategy || '').replace(/\s*-\s*Normal\b/i, '')}</span>
            <span style={{ whiteSpace: 'nowrap' }}>{q} ct</span>
            {m.nearExp ? <span style={{ whiteSpace: 'nowrap' }}>exp {fmtYmd(m.nearExp)}</span> : null}
          </div>
          {chain ? <div style={{ color: '#a8b2be', fontSize: 12, marginTop: 3 }}>{chain.rolls} roll{chain.rolls > 1 ? 's' : ''} since {fmtYmd(chain.startYmd)}</div> : null}
        </div>
        {posPnl != null && (
          <div style={{ marginLeft: 'auto', textAlign: 'right' }} data-testid="position-pnl">
            <div className="mono" style={{ fontWeight: 800, fontSize: 28, lineHeight: 1, color: posPnl >= 0 ? '#3fb950' : '#f85149' }}>{money(posPnl)}</div>
            <div style={{ fontSize: 11, color: '#8b949e', marginTop: 3 }}>
              {chain ? <>position · this ticket <span className="mono">{money(m.pnl$)}</span> + banked <span className="mono">{money(banked)}</span></> : 'open P&L'}
            </div>
          </div>
        )}
      </div>
      <div style={{ marginTop: 10, color: tone.fg, fontSize: 15.5, fontWeight: 700 }}>{rv.headline}</div>

      {live && steps && (
        <div style={{ marginTop: 12 }}>{meter}</div>
      )}
      {live && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginTop: steps ? 10 : 12 }}>
          {!steps && meter}
          <CushionGauge near={near} />
          <ClockGauge daysHeld={m.daysHeld} planDays={m.planDays} daysToClose={m.daysToClose} closeYmd={closeYmd} events={m.events} />
        </div>
      )}
      {live && legs && spot > 0 && ncdPos != null && (
        <PriceMap legs={legs} spot={spot} ncdPos={ncdPos} qty={q} shorts={shorts} sdStop={sdStop} closeYmd={closeYmd} underlying={t.underlying} />
      )}
      {live && legs && spot > 0 && ncdPos != null && <Triggers legs={legs} ncdPos={ncdPos} spot={spot} closeYmd={closeYmd} />}
      <Reasons chips={chips} />
      {spotStale && <div data-testid="stale-spot" style={{ marginTop: 8, fontSize: 12, color: '#d29922', display: 'flex', alignItems: 'center', gap: 5 }}>
        <Clock size={12} /> price is the {spotAsOf ? `${spotAsOf.slice(4, 6)}/${spotAsOf.slice(6, 8)} ` : ''}close, not live</div>}
      {!(spot > 0) && priceNote && <div data-testid="no-spot-why" style={{ marginTop: 8, fontSize: 12.5, color: '#f85149' }}>{priceNote}</div>}
      {(note || quoteErr) && <div style={{ marginTop: 6, fontSize: 12, color: '#d29922' }}>{[note, quoteErr].filter(Boolean).join(' · ')}</div>}
      <NextStep text={nextStep} />
      {roll && <RollPlan roll={roll} />}

      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 10 }}>
        <button onClick={() => setOpen(!open)} data-testid="checkup-more"
          style={{ fontSize: 12.5, color: '#58a6ff', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />} {open ? 'Hide details' : 'Details'}
        </button>
        {row.openRow && (
          <button onClick={() => setDetail(true)} data-testid="checkup-details" style={{ fontSize: 12.5, color: '#58a6ff' }}>
            Payoff diagram and live P&L →</button>
        )}
      </div>
      {detail && row.openRow && <TradeDetail row={row.openRow} onClose={() => setDetail(false)} />}

      {/* Everything that used to be the card, one click away. Kept in the DOM. */}
      <div data-testid="checkup-detail-body" style={{ display: open ? 'block' : 'none', marginTop: 10, paddingTop: 10, borderTop: '1px solid #21262d' }}>
        {live && <div data-testid="checkup-summary" style={{ color: '#c9d1d9', fontSize: 13 }}>{summaryLine(m, chain, q)}</div>}
        {live && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 18, marginTop: 12 }}>
            <PnLChart m={m} chain={chain} />
            <Waterfall m={m} chain={chain} qty={q} />
          </div>
        )}
        {live && (
          <div data-testid="exits" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
            {m.target$ != null && <Chip label={chain ? 'target (this ticket)' : 'target'} tone="green" val={`${money(m.target$)}${targetPx != null ? ` · close @${Math.max(0, targetPx).toFixed(2)}` : ''}`}
              tip={`Take profit at ${m.targetLabel}.`} />}
            {m.stopPrice != null && <Chip label={chain ? 'stop (this ticket)' : 'stop'} val={`${money(m.stop$)} · close @${m.stopPrice.toFixed(2)}`}
              tone="red" tip={`Stop guide: ${m.stopPct}% of the entry premium.`} />}
          </div>
        )}
        {live && legs && spot > 0 && <StrikeStrip legs={legs} spot={spot} shorts={shorts} ncd={m.ncd} />}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {m.ivChange ? <Chip label="IV since entry" val={(m.ivChange > 0 ? '+' : '') + m.ivChange + ' pts'} /> : null}
          {trend && <Chip label="trend" val={trendLabel(trend)} tone={m.trendFit < 0 ? 'amber' : m.trendFit > 0 ? 'green' : null} tip={trend.why} />}
          {source && <Chip label="legs" val={source} tone={source === 'TWS' ? null : 'amber'} />}
        </div>
        {rv.warnings.length > 0 && (
          <ul style={{ marginTop: 8, fontSize: 12.5, color: '#e3b341', paddingLeft: 16, listStyle: 'disc' }}>
            {rv.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
        {(rv.steps.length > 1 || rv.reasons.length > 0) && (
          <div style={{ marginTop: 8, fontSize: 13, color: '#c9d1d9' }}>
            {rv.steps.slice(1).map((s2, i) => <div key={'s' + i} style={{ marginBottom: 4 }}>→ {s2}</div>)}
            {rv.reasons.map((s2, i) => <div key={'r' + i} style={{ marginBottom: 4, color: '#a8b2be' }}>{s2}</div>)}
            <div style={{ marginTop: 4, color: '#8b949e', fontSize: 12 }}>Rule: {rv.rule.why || `${rv.rule.target}% target`} · close by {m.closeDte} DTE</div>
          </div>
        )}
        {more && null}
      </div>
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

// P&L against days held, for the whole position: the theta-only plan as a dashed
// path, target and stop as lines, today as a dot, and — for a rolled ticket — what
// the earlier tickets banked before it. Replaces two unlabelled bars (Oct 2026).
function PnLChart({ m, chain }) {
  const planDays = Math.max(1, m.planDays || 1);
  const banked = chain ? chain.banked : 0;
  const start = chain && chain.startYmd ? chain.startYmd : m.entryYmd;
  const off = chain && start && m.entryYmd ? Math.max(0, daysBetweenYmd(start, m.entryYmd)) : 0;
  const held = Math.max(0, m.daysHeld || 0);
  const span = Math.max(off + planDays, off + held);
  const today = off + held;
  const curve = (m.planCurve && m.planCurve.length > 1 ? m.planCurve
    : m.target$ != null ? [{ day: 0, pnl$: 0 }, { day: planDays, pnl$: m.target$ }] : [{ day: 0, pnl$: 0 }])
    .map(c => ({ d: off + c.day, v: banked + c.pnl$ }));
  const now = m.pnl$ != null ? banked + m.pnl$ : null;
  const planNow = m.plan$ != null ? banked + m.plan$ : null;
  const target = m.target$ != null ? banked + m.target$ : null;
  const stop = m.stop$ != null ? banked + m.stop$ : null;
  // Earlier tickets: a dotted step per ticket, from 0 up to what each banked.
  const segs = [];
  if (chain) {
    let acc = 0;
    chain.links.forEach((l, i) => {
      const d0 = l.entryYmd && start ? Math.max(0, daysBetweenYmd(start, l.entryYmd)) : 0;
      const nx = chain.links[i + 1];
      const d1 = nx && nx.entryYmd ? Math.max(d0, daysBetweenYmd(start, nx.entryYmd)) : off;
      segs.push({ d0, d1, v0: acc, v1: acc + l.realised, l });
      acc += l.realised;
    });
  }
  const vals = [0, banked, ...curve.map(c => c.v), now, planNow, target, stop].filter(v => v != null && isFinite(v));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(40, (hi - lo) * 0.08); lo -= pad; hi += pad;
  const W = 640, H = 230, L = 54, R = 104, T = 12, B = 40;
  const X = d => L + (d / span) * (W - L - R);
  const Y = v => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const col = PACE_COL[m.pace] || '#8b949e';
  const path = curve.map((c, i) => `${i ? 'L' : 'M'}${X(c.d).toFixed(1)},${Y(c.v).toFixed(1)}`).join(' ');
  // Keep the right-hand labels from sitting on top of each other.
  const labels = [
    target != null && { v: target, text: `target ${money(target)}`, c: '#3fb950' },
    planNow != null && curve.length > 1 && { v: curve[curve.length - 1].v, text: `plan ${money(curve[curve.length - 1].v)}`, c: '#58a6ff' },
    chain && { v: banked, text: `banked ${money(banked)}`, c: '#a8b2be' },
    stop != null && { v: stop, text: `stop ${money(stop)}`, c: '#f85149' },
  ].filter(Boolean).sort((a, b) => Y(a.v) - Y(b.v));
  let lastY = -99;
  labels.forEach(l => { l.y = Math.max(Y(l.v) + 4, lastY + 13); lastY = l.y; });
  const xTicks = [{ d: 0, t: fmtYmd(start) }];
  if (chain) xTicks.push({ d: off, t: `rolled ${fmtYmd(m.entryYmd)}` });
  if (today > 0 && today < span) xTicks.push({ d: today, t: 'today' });
  xTicks.push({ d: span, t: `${fmtYmd(m.nearExp && m.closeDte != null ? ymdAdd(m.nearExp, -m.closeDte) : null)} close` });
  return (
    <div data-testid="plan-track">
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 2 }}>
        {chain ? 'Position P&L since you opened' : 'P&L since entry'} — going to plan? <b style={{ color: col, textTransform: 'capitalize' }}>{m.pace === 'target' ? 'target reached' : m.pace}</b>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" style={{ display: 'block' }}
        aria-label={`P&L ${now != null ? money(now) : 'unknown'} against a plan of ${planNow != null ? money(planNow) : 'unknown'} by today`}>
        {/* zero */}
        <line x1={L} x2={W - R} y1={Y(0)} y2={Y(0)} stroke="#484f58" strokeWidth="1" />
        <text x={L - 6} y={Y(0) + 4} fontSize="11" fill="#8b949e" textAnchor="end">$0</text>
        {/* target and stop */}
        {target != null && <line x1={X(off)} x2={W - R} y1={Y(target)} y2={Y(target)} stroke="#3fb950" strokeWidth="1.2" strokeDasharray="5 4" />}
        {stop != null && <line x1={X(off)} x2={W - R} y1={Y(stop)} y2={Y(stop)} stroke="#f85149" strokeWidth="1.2" strokeDasharray="5 4" />}
        {/* earlier tickets and the roll */}
        {segs.map((s, i) => (
          <g key={i}>
            <line x1={X(s.d0)} x2={X(s.d1)} y1={Y(s.v0)} y2={Y(s.v1)} stroke="#a8b2be" strokeWidth="1.5" strokeDasharray="2 3" />
            <circle cx={X(s.d1)} cy={Y(s.v1)} r="3" fill="#a8b2be" />
          </g>
        ))}
        {chain && <line x1={X(off)} x2={W - R} y1={Y(banked)} y2={Y(banked)} stroke="#a8b2be" strokeWidth="0.8" opacity="0.5" />}
        {chain && <line x1={X(off)} x2={X(off)} y1={T} y2={H - B} stroke="#d29922" strokeWidth="1" strokeDasharray="3 3" />}
        {/* plan: time decay only */}
        <path d={path} fill="none" stroke="#58a6ff" strokeWidth="1.8" strokeDasharray="6 4" />
        {/* today */}
        {today <= span && <line x1={X(today)} x2={X(today)} y1={T} y2={H - B} stroke="#30363d" strokeWidth="1" />}
        {now != null && planNow != null && <line x1={X(today)} x2={X(today)} y1={Y(planNow)} y2={Y(now)} stroke={col} strokeWidth="2.5" opacity="0.55" />}
        {planNow != null && <circle cx={X(today)} cy={Y(planNow)} r="3.5" fill="#0d1117" stroke="#58a6ff" strokeWidth="1.5" />}
        {now != null && <circle cx={X(today)} cy={Y(now)} r="6" fill={col} stroke="#0d1117" strokeWidth="2" />}
        {now != null && <text x={X(today) + (X(today) > W - R - 120 ? -10 : 10)} y={Y(now) + 4} fontSize="12.5" fontWeight="700" fill={col}
          textAnchor={X(today) > W - R - 120 ? 'end' : 'start'}>now {money(now)}</text>}
        {now != null && planNow != null && Math.abs(now - planNow) > 20 && (
          <text x={X(today) + (X(today) > W - R - 120 ? -10 : 10)} y={(Y(now) + Y(planNow)) / 2 + 4} fontSize="11" fill="#8b949e"
            textAnchor={X(today) > W - R - 120 ? 'end' : 'start'}>{money(now - planNow)} vs plan</text>
        )}
        {labels.map((l, i) => <text key={i} x={W - R + 6} y={l.y} fontSize="11" fill={l.c}>{l.text}</text>)}
        {/* x axis */}
        {xTicks.map((k, i) => (
          <g key={i}>
            <line x1={X(k.d)} x2={X(k.d)} y1={H - B} y2={H - B + 4} stroke="#484f58" />
            <text x={X(k.d)} y={H - B + 16} fontSize="11" fill={k.t === 'today' ? '#e6edf3' : '#8b949e'}
              textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{k.t}</text>
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: '#8b949e', marginTop: 2 }}>
        <span><span style={{ color: '#58a6ff' }}>- - -</span> plan: time decay only, price and IV unchanged</span>
        <span><span style={{ color: col }}>●</span> now</span>
        {chain && <span><span style={{ color: '#a8b2be' }}>···</span> earlier ticket{chain.rolls > 1 ? 's' : ''} (realised; daily path not recorded)</span>}
        <span>{held} of {planDays} days held</span>
      </div>
    </div>
  );
}

// From $0 to where the position is now, one step at a time: banked rolls, then the
// open ticket's time / price / IV and the part the model cannot explain.
function Waterfall({ m, chain, qty }) {
  const b = breakdown(m, qty);
  const rows = [];
  if (chain) rows.push({ k: `Banked when you rolled${chain.rolls > 1 ? ` (${chain.rolls})` : ''}`, v: chain.banked });
  if (b) {
    rows.push({ k: 'Time decay (the plan)', v: b.time });
    rows.push({ k: 'Price move', v: b.price });
    rows.push({ k: b.skewIncluded ? 'IV change (each leg)' : 'IV change (ATM)', v: b.vol });
    if (b.other != null) rows.push({ k: 'Not explained by price or IV', v: b.other, other: true });
  } else if (m.pnl$ != null) rows.push({ k: chain ? 'This ticket' : 'Open P&L', v: m.pnl$ });
  if (!rows.length) return <div style={{ fontSize: 12.5, color: '#8b949e' }}>No live mark — nothing to break down.</div>;
  let acc = 0;
  const steps = rows.map(r => { const s = { ...r, from: acc, to: acc + r.v }; acc += r.v; return s; });
  const total = acc;
  const pts = [0, ...steps.map(s => s.to)];
  const lo = Math.min(...pts), hi = Math.max(...pts), span = Math.max(1, hi - lo);
  const P = v => ((v - lo) / span) * 100;
  const other = steps.find(s => s.other);
  return (
    <div data-testid="attribution">
      <div style={{ fontSize: 12, color: '#8b949e', marginBottom: 6 }}>
        What made the P&L — all {qty} contract{qty === 1 ? '' : 's'}{chain ? ', whole position' : ''}
      </div>
      {steps.map((s, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '172px 1fr 64px', alignItems: 'center', gap: 8, fontSize: 12.5, marginBottom: 4 }}>
          <span style={{ color: s.other ? '#e3b341' : '#c9d1d9' }}>{s.k}</span>
          <div style={{ position: 'relative', height: 12, background: '#161b22', borderRadius: 3 }}>
            <div style={{ position: 'absolute', left: `${P(0)}%`, top: -2, bottom: -2, width: 1, background: '#484f58' }} />
            <div style={{ position: 'absolute', top: 1, bottom: 1, borderRadius: 2,
              left: `${Math.min(P(s.from), P(s.to))}%`, width: `${Math.max(0.6, Math.abs(P(s.to) - P(s.from)))}%`,
              background: s.v >= 0 ? '#3fb950' : '#f85149', opacity: s.other ? 0.6 : 0.9 }} />
          </div>
          <span className="mono" style={{ textAlign: 'right', color: s.v >= 0 ? '#3fb950' : '#f85149' }}>{money(s.v)}</span>
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '172px 1fr 64px', alignItems: 'center', gap: 8, fontSize: 13, borderTop: '1px solid #30363d', paddingTop: 5, marginTop: 2 }}>
        <span style={{ color: '#e6edf3', fontWeight: 700 }}>{chain ? 'Position now' : 'Now'}</span>
        <div style={{ position: 'relative', height: 12 }}>
          <div style={{ position: 'absolute', left: `${P(total)}%`, top: 0, bottom: 0, width: 3, marginLeft: -1, background: total >= 0 ? '#3fb950' : '#f85149' }} />
        </div>
        <span className="mono" style={{ textAlign: 'right', fontWeight: 700, color: total >= 0 ? '#3fb950' : '#f85149' }}>{money(total)}</span>
      </div>
      {other && Math.abs(other.v) >= 25 && (
        <div data-testid="other-explained" style={{ fontSize: 12, color: '#a8b2be', marginTop: 8 }}>
          “Not explained” is the P&L the time, price and IV model can’t account for.{' '}
          {b && b.skewIncluded
            ? 'With each leg’s IV known, that is mostly the entry price against fair value, and wide quotes in today’s mark.'
            : 'Usually skew — the tested side’s IV moving more than the ATM IV — or the entry price against fair value. Tickets logged from now on carry each leg’s IV, so the IV line will include skew.'}
        </div>
      )}
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
  // The nearest short to price, in points and standard deviations: the one number
  // the strip is there to show.
  const near = (shorts || []).filter(x => x.cushion != null).sort((a, b) => a.cushion - b.cushion)[0];
  return (
    <div style={{ marginTop: 14 }}>
    <div data-testid="strike-strip" style={{ position: 'relative', height: 56 }}>
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
    <div data-testid="strip-legend" style={{ fontSize: 12, color: '#a8b2be', marginTop: 2 }}>
      {strip.zone && <><span style={{ color: '#3fb950' }}>Green band</span>: in profit at expiry between <span className="mono">{Math.round(strip.zone.from)}</span> and <span className="mono">{Math.round(strip.zone.to)}</span>. </>}
      <span style={{ color: '#f0883e' }}>Shorts</span> (red when tested), <span style={{ color: '#58a6ff' }}>longs</span>.
      {near && <> Price <span className="mono">{spot}</span> is {near.cushion >= 0
        ? <><span className="mono">{near.cushion.toFixed(1)}</span> {near.right === 'P' ? 'above' : 'below'} the {near.strike}{near.right} short</>
        : <><span className="mono">{Math.abs(near.cushion).toFixed(1)}</span> through the {near.strike}{near.right} short</>}
        {near.cushionSd != null && <> ({Math.abs(near.cushionSd).toFixed(1)}σ{near.absDelta != null ? `, ${Math.round(near.absDelta * 100)}Δ` : ''})</>}.</>}
    </div>
    </div>
  );
}
