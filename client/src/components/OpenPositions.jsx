import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { exposure, STATUS } from '../engine/fills';
import OrderTicket from './OrderTicket';
import FillReconcile from './FillReconcile';
import EditTicketModal from './EditTicketModal';
import TradeDetail from './TradeDetail';
import { normalisePosition, stopToPrice, targetToPrice, pnlAt, loadPlan, withEntryFill } from '../utils/ticketMath';
import { exitRuleFor } from '../engine/data';
import { ticketExpiry, daysBetweenYmd } from '../utils/ticketExpiry';
import { tradingSession } from '../engine/session';
import { STOP_LOSS_PCT } from '../engine/data';
import { rollChain } from '../engine/rollChain';
import { stopOf, entryOf, targetOf, liveRiskOf, liveRiskTotal } from '../utils/positionLines';
import PositionBoard, { boardRow } from './PositionBoard';
import { runCheckup, bridgeUrlOf } from './Checkup45';

// The trading session the trade belongs to, and the moment it was logged on YOUR clock.
// The server files a trade by its New York session (an after-close log rolls to the
// next one), and showed the ET time beside it: logged 14:14 in Melbourne read
// "2026-10-08 23:14". (Oct 2026.)
function openedOf(r) {
  const at = r.timestamp ? new Date(r.timestamp) : null;
  const local = at && !isNaN(at) ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  const localDay = at && !isNaN(at) ? at.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '';
  return { session: r.entryDate || '', local, localDay, et: r.entryTime || '' };
}

// Open and partially-closed positions, each expandable to its tranches.
//
// Until closes were tranched there was nothing to look at: a position was either
// absent from the log or finished. A half-closed trade is the one state where you
// genuinely cannot reconstruct where you stand from the ticket alone, because the
// ticket shows the blended result and says nothing about what is still at risk.
// (Sep 2026.)
//
// compact — Dashboard mode: totals plus one line per position, no tranche detail.
export default function OpenPositions({ authenticated, account, compact = false, maxOpenRisk = null }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState({});
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ticket, setTicket] = useState(null);   // { row, tab } — the SELL ticket in play
  const [reload, setReload] = useState(0);
  const [reconciling, setReconciling] = useState(false);   // true = all working, or one row
  const [cancelling, setCancelling] = useState(null);
  const [editing, setEditing] = useState(null);   // the row being corrected
  const [detail, setDetail] = useState(null);     // the row whose details are open
  const [cap, setCap] = useState(null);         // account open-risk cap, when not passed in
  const [chains, setChains] = useState({});     // ticketRef → what earlier rolled tickets banked
  const [expiries, setExpiries] = useState({}); // ticketRef → { expiry, source, startYmd }
  const [decisions, setDecisions] = useState(null);   // every ticket, for the check-up
  const [check, setCheck] = useState({ byTs: {}, at: null, busy: false, err: '' });

  // The cap is a property of the account, not of the page that happens to be
  // showing positions. The Dashboard already has it and passes it; everywhere else
  // it is fetched here rather than threaded through three components. (Oct 2026.)
  useEffect(() => {
    if (!authenticated || maxOpenRisk != null) return;
    let dead = false;
    api.getStats(account)
      .then(d => { if (!dead) setCap(Number(d?.config?.maxOpenRisk) || null); })
      .catch(() => {});
    return () => { dead = true; };
  }, [authenticated, account, maxOpenRisk]);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    let dead = false;
    setLoading(true);
    api.getOpenPositions(account)
      .then(d => { if (!dead) { setRows(Array.isArray(d) ? d.map(withEntryFill) : []); setErr(null); } })
      .catch(e => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [authenticated, account, reload]);

  // A rolled ticket's position includes what the tickets before it banked: the
  // roll closed them, so their P&L is not on this row (Oct 2026). Looked up after
  // the rows load so the table never waits on it.
  useEffect(() => {
    if (!authenticated || !rows.length) return;
    let dead = false;
    Promise.all([
      Promise.resolve().then(() => api.getDecisions()).catch(() => []),
      Promise.resolve().then(() => api.getCloses()).catch(() => []),
    ]).then(([decisions, closes]) => {
      if (dead || !Array.isArray(decisions)) return;
      const out = {}, exps = {};
      const todayYmd = tradingSession().yyyymmdd;
      for (const r of rows) {
        const d = decisions.find(x => (r.timestamp && x.Timestamp === r.timestamp) || Number(x._rowIndex) === Number(r.ticketRef));
        const c = d ? rollChain(d, { decisions, closes: Array.isArray(closes) ? closes : [] }) : null;
        if (c) out[r.ticketRef] = c;
        const e = d ? ticketExpiry(d, decisions, { todayYmd }) : null;
        exps[r.ticketRef] = { ...(e || {}), startYmd: c && c.startYmd ? c.startYmd : null };
      }
      setChains(out);
      setExpiries(exps);
      setDecisions(decisions);
    });
    return () => { dead = true; };
  }, [authenticated, rows]);

  // The Dashboard board shows the check-up's verdict for every open 45DTE ticket, so
  // it runs the same shared pass the Decision Engine's check-up does (one minute
  // cache: whichever screen asks first, the other reuses it). (Oct 2026.)
  async function recheck(force = false) {
    if (!compact || !decisions) return;
    const tickets = rows.filter(r => /45/.test(r.engine || '') && !(r.status === STATUS.WORKING))
      .map(r => decisions.find(d => (r.timestamp && d.Timestamp === r.timestamp) || Number(d._rowIndex) === Number(r.ticketRef)))
      .filter(Boolean);
    if (!tickets.length) return;
    if (!bridgeUrlOf()) { setCheck(c => ({ ...c, err: 'no bridge URL — live P&L off' })); return; }
    setCheck(c => ({ ...c, busy: true, err: '' }));
    try {
      const res = await runCheckup({ tickets, openPositions: rows, force });
      const byTs = {};
      // Keyed by ticket ref: res.list is in the order of the tickets passed in.
      (res.list || []).forEach((x, i) => { if (tickets[i]) byTs[Number(tickets[i]._rowIndex)] = x; byTs[x.t.key] = byTs[x.t.key] || x; });
      const offline = res.posErr && /connection failed|nothing listening|not connected|ECONNREFUSED|timed out/i.test(res.posErr);
      setCheck({ byTs, at: res.at || new Date(), busy: false, err: res.posErr ? (offline ? 'TWS offline — no live prices' : 'TWS: ' + res.posErr.slice(0, 80)) : '' });
    } catch (e) { setCheck(c => ({ ...c, busy: false, err: e.message })); }
  }
  useEffect(() => { recheck(false); }, [decisions]);   // eslint-disable-line react-hooks/exhaustive-deps

  // The ticket ref IS the 1-based Decisions row, which is what the status route
  // addresses, so no lookup is needed.
  // Row click (Oct 2026): an order still resting goes to the fill screen for that
  // one ticket; anything filled goes to its Sell ticket. A part-filled order has
  // contracts still to come, so it goes to fills too (its Sell button stays).
  const isWaiting = r => r.status === STATUS.WORKING || r.status === STATUS.PART_FILLED;
  function openRow(r) {
    if (isWaiting(r)) setReconciling(r);
    else setTicket({ row: r, tab: 'close' });
  }

  async function cancelTicket(r) {
    if (!window.confirm(`Mark the ${r.underlying} ${r.strategy} order cancelled? Nothing filled, so no trade is recorded.`)) return;
    setCancelling(r.ticketRef);
    try {
      await api.updateTicketStatus(r.ticketRef, 'Cancelled');
      setReload(x => x + 1);
    } catch (e) {
      setErr('Could not cancel: ' + e.message);
    } finally { setCancelling(null); }
  }

  const n = v => { const x = parseFloat(v); return isFinite(x) ? x : 0; };
  // Risk still live is the OPEN portion only — the closed contracts cannot lose
  // any more, and counting them would overstate exposure on every partial.
  const openRisk = liveRiskTotal(rows);
  const realised = rows.reduce((a, r) => a + n(r.realisedPnl), 0);
  const rollBanked = Object.values(chains).reduce((a, c) => a + (c.banked || 0), 0);
  const partials = rows.filter(r => r.status === 'Partial' || r.status === STATUS.PART_CLOSED).length;
  // Money at risk and money committed are different questions, and only one of
  // them is urgent. A resting order can fill at any moment, so it counts against
  // the cap in full — but folding it into one number would hide the difference.
  // (Oct 2026.)
  const exp = exposure(rows, { maxOpenRisk: maxOpenRisk != null ? maxOpenRisk : cap });
  // Anything still waiting on contracts is what the reconcile button is for.
  const working = rows.filter(r => r.status === STATUS.WORKING || r.status === STATUS.PART_FILLED);

  if (loading) return <div className="card"><div className="text-text-muted text-sm">Loading open positions…</div></div>;
  if (err) return <div className="card"><div className="text-red text-sm">Open positions: {err}</div></div>;

  if (!rows.length) {
    return (
      <div className="card">
        <div className="flex items-center justify-between">
          <span className="text-sm" style={{ fontWeight: 600 }}>Open positions</span>
          <span className="text-text-muted text-sm">Nothing open</span>
        </div>
      </div>
    );
  }

  // Four colours for five states. Amber is "not all the way through" on either side
  // of the trade; purple marks a ticket that is not a position yet at all, because
  // reading a resting order as open is the mistake this whole table exists to stop.
  const PILL = {
    [STATUS.WORKING]: ['#1c1333', '#bc8cff'],
    [STATUS.PART_FILLED]: ['#1f1a0d', '#d29922'],
    [STATUS.PART_CLOSED]: ['#1f1a0d', '#d29922'],
    Partial: ['#1f1a0d', '#d29922'],
  };
  const Pill = ({ s }) => {
    const [bg, color] = PILL[s] || ['#0d1a2e', '#2f81f7'];
    return <span className="badge" style={{ background: bg, color }}>{s}</span>;
  };
  const money = v => (n(v) >= 0 ? '+$' : '−$') + Math.abs(n(v)).toFixed(0);

  const modals = (
    <>
      {ticket && (
        <OrderTicket position={ticket.row} initialTab={ticket.tab}
          onClose={() => setTicket(null)}
          onDone={() => { setTicket(null); setReload(x => x + 1); }} />
      )}
      {detail && (
        <TradeDetail row={detail} account={account} onClose={() => setDetail(null)}
          onSell={r => { setDetail(null); setTicket({ row: r, tab: 'close' }); }}
          onRoll={r => { setDetail(null); setTicket({ row: r, tab: 'roll' }); }} />
      )}
      {editing && (
        <EditTicketModal position={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); setReload(x => x + 1); }} />
      )}
      {reconciling && (
        <FillReconcile positions={reconciling === true ? rows : [reconciling]} account={account}
          onClose={() => setReconciling(false)}
          onDone={() => setReload(x => x + 1)} />
      )}
    </>
  );

  // Dashboard: the board — verdict, P&L, stop→target, price against the strikes, time.
  if (compact) {
    const on = (k, r) => {
      if (k === 'details') setDetail(r);
      else if (k === 'edit') setEditing(r);
      else if (k === 'sell') setTicket({ row: r, tab: 'close' });
      else if (k === 'roll') setTicket({ row: r, tab: 'roll' });
      else if (k === 'cancel') cancelTicket(r);
      else if (k === 'reconcile') setReconciling(r);
    };
    const board = rows.map(r => boardRow(r, { chain: chains[r.ticketRef] || null, expiry: expiries[r.ticketRef] || null, check: check.byTs[Number(r.ticketRef)] || check.byTs[r.timestamp] || null }));
    return (
      <>
        <PositionBoard rows={board} on={on} cap={exp.cap || null} checkedAt={check.at} checking={check.busy}
          checkErr={check.err} onRecheck={() => recheck(true)} />
        {modals}
      </>
    );
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="text-sm" style={{ fontWeight: 600 }}>
          Open positions
          <span className="text-text-muted" style={{ fontWeight: 400 }}>
            {' '}· {rows.length}{partials > 0 && ` · ${partials} part-closed`}
          </span>
        </span>
        <span className="text-sm mono" style={{ display: 'flex', gap: 16 }}>
          <span><span className="text-text-muted">Risk live </span>
            <b>${openRisk.toFixed(0)}</b></span>
          {exp.working > 0 && (
            <span title={`${exp.workingCount} order${exp.workingCount === 1 ? '' : 's'} resting. `
              + `If every one fills, committed risk is $${exp.committed.toFixed(0)}`
              + (exp.cap ? ` against a $${exp.cap} cap.` : '.')}>
              <span className="text-text-muted">Working </span>
              <b style={{ color: exp.overIfFilled ? '#d29922' : undefined }}>
                ${exp.working.toFixed(0)}
              </b>
            </span>
          )}
          {exp.cap && exp.overIfFilled && (
            <span style={{ color: exp.overNow ? '#f85149' : '#d29922' }}>
              {exp.overNow
                ? `over the $${exp.cap} cap now`
                : `$${exp.committed.toFixed(0)} if all fill · cap $${exp.cap}`}
            </span>
          )}
          {(realised !== 0 || rollBanked !== 0) && (
            <span title={`Closed so far on these positions: ${money(realised)} from tranches${rollBanked ? `, ${money(rollBanked)} from rolls (the tickets they were rolled from)` : ''}`}>
              <span className="text-text-muted">Banked </span>
              <b className={realised + rollBanked >= 0 ? 'win' : 'loss'}>{money(realised + rollBanked)}</b></span>
          )}
          {!compact && working.length > 0 && (
            <button onClick={() => setReconciling(true)}
              title="Pull today's TWS executions and match them to these working orders — nothing is written until you confirm"
              className="text-[12px] px-2 py-0.5 rounded"
              style={{ border: '1px solid #8957e5', color: '#bc8cff', background: 'transparent', cursor: 'pointer' }}>
              Reconcile fills
            </button>
          )}
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-text-faint text-[12px] uppercase tracking-wider">
              <th className="text-left py-2 pr-2">Opened</th>
              <th className="text-left py-2 pr-2">Position</th>
              {!compact && <th className="text-left py-2 pr-2">Legs</th>}
              <th className="text-right py-2 pr-2" title="Days since the position was opened (since the first ticket, for a rolled one), and days to expiry">Days</th>
              <th className="text-right py-2 pr-2">Open / Qty</th>
              <th className="text-right py-2 pr-2" title="Net credit or debit per contract; for an order not yet filled, the limit it was sent at">Entry</th>
              <th className="text-right py-2 pr-2">Risk live</th>
              <th className="text-right py-2 pr-2" title={`Stop: the plan saved at entry, otherwise the ${STOP_LOSS_PCT}%-of-premium guide (credit: buy back at 2× the credit; debit: close when it is worth nothing). The loss is for all contracts.`}>Stop</th>
              <th className="text-right py-2 pr-2" title="Profit target: the exit plan saved at entry, otherwise the strategy's rule (0DTE: % of the entry; 45DTE: % of max profit). The amount is for all contracts.">Target</th>
              {!compact && <th className="text-right py-2 pr-2">Avg exit</th>}
              <th className="text-right py-2 pr-2" title="Closed so far: tranches sold, plus what a roll banked on the ticket it replaced">Banked</th>
              <th className="text-left py-2 pl-2">Status</th>
              <th className="py-2 pl-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isOpen = !!open[r.ticketRef];
              const liveRisk = n(r.qty) > 0 ? n(r.maxRisk) * (n(r.qtyOpen) / n(r.qty)) : 0;
              const expandable = !compact && (r.closes || []).length > 0;
              // Contracts ordered and not yet in. Blank qtyFilled means a legacy
              // ticket that never tracked fills, so nothing is resting.
              const resting = r.qtyFilled === '' || r.qtyFilled == null
                ? 0 : Math.max(0, n(r.qty) - n(r.qtyFilled));
              return (
                <React.Fragment key={r.ticketRef}>
                  <tr data-testid="op-row" data-status={r.status}
                    onClick={() => openRow(r)}
                    className="op-row"
                    style={{ borderTop: '1px solid #21262d', cursor: 'pointer' }}
                    title={isWaiting(r) ? 'Order not filled yet — click to enter the fills' : 'Click to open the Sell ticket'}>
                    {(() => { const o = openedOf(r); return (
                      <td className="py-2 pr-2 text-text-muted" style={{ whiteSpace: 'nowrap' }}
                        title={`Session ${o.session}${o.et ? ` · ${o.et} New York` : ''}${o.local ? ` · logged ${o.localDay} ${o.local} your time` : ''}`}>
                        {o.session} <span className="text-text-faint">{o.local || o.et}</span>
                      </td>); })()}
                    <td className="py-2 pr-2">
                      {expandable && <span className="text-text-faint" role="button" data-testid="op-tranches"
                        title={isOpen ? 'Hide tranches' : `Show ${r.closes.length} tranche${r.closes.length > 1 ? 's' : ''}`}
                        onClick={e => { e.stopPropagation(); setOpen(o => ({ ...o, [r.ticketRef]: !o[r.ticketRef] })); }}>{isOpen ? '▾ ' : '▸ '}</span>}
                      <b>{r.underlying}</b> <span className="text-text-muted">{r.strategy}</span>
                    </td>
                    {!compact && <td className="py-2 pr-2 mono text-text-muted">{r.legs}</td>}
                    {(() => {
                      const ex = expiries[r.ticketRef] || {};
                      const today = tradingSession().yyyymmdd;
                      const opened = String(r.entryDate || '').replace(/-/g, '');
                      const held = opened.length === 8 ? Math.max(0, daysBetweenYmd(opened, today)) : null;
                      const total = ex.startYmd ? Math.max(0, daysBetweenYmd(ex.startYmd, today)) : null;
                      const dte = ex.expiry ? daysBetweenYmd(today, ex.expiry) : null;
                      return (
                        <td className="py-2 pr-2 text-right mono" data-testid="op-days" style={{ whiteSpace: 'nowrap' }}
                          title={`${total != null ? `${total} days since the first ticket opened, ${held} since the roll` : `${held ?? '—'} days in the trade`}${ex.expiry ? ` · expires ${ex.expiry.slice(0, 4)}-${ex.expiry.slice(4, 6)}-${ex.expiry.slice(6, 8)} (${dte} DTE)` : ' · expiry not known — no Legs line on the ticket'}`}>
                          {total != null ? total : held != null ? held : '—'}d
                          {dte != null && <div className="text-[11px]" style={{ color: dte <= 0 ? '#f85149' : '#8b949e' }}>{dte <= 0 ? (dte === 0 ? 'expires today' : 'expired') : `${dte} DTE`}</div>}
                        </td>);
                    })()}
                    <td className="py-2 pr-2 text-right mono">
                      <b>{r.qtyOpen}</b><span className="text-text-muted"> / {r.qty}</span>
                      {resting > 0 && (
                        <span style={{ color: '#bc8cff' }} title={`${resting} contract${resting === 1 ? '' : 's'} still resting at ${r.limitPrice || 'the limit'}`}>
                          {' '}+{resting}
                        </span>
                      )}
                    </td>
                    {(() => { const en = entryOf(r); return (
                      <td className="py-2 pr-2 text-right mono" data-testid="op-entry" style={{ whiteSpace: 'nowrap', color: en ? (en.side === 'cr' ? '#3fb950' : '#e3b341') : '#8b949e' }}
                        title={en && en.filled ? `Average of the recorded fills${en.asked != null ? ` (asked ${en.asked.toFixed(2)})` : ''} — Edit to correct a fill` : 'Entry as logged'}>
                        {en ? <>{isWaiting(r) && <span className="text-text-faint">lmt </span>}{en.side} {en.price.toFixed(2)}</> : '—'}
                      </td>); })()}
                    <td className="py-2 pr-2 text-right mono">
                      ${liveRisk.toFixed(0)}
                      {resting > 0 && (
                        <span style={{ color: '#bc8cff', fontSize: 11.5 }}
                          title="Risk committed but not yet carried — it lands the moment the rest fills">
                          {' '}+{(n(r.qty) > 0 ? n(r.maxRisk) * (resting / n(r.qty)) : 0).toFixed(0)}
                        </span>
                      )}
                    </td>
                    {(() => { const st = stopOf(r); return (
                      <td className="py-2 pr-2 text-right mono" data-testid="op-stop" style={{ color: st ? '#f85149' : '#8b949e', whiteSpace: 'nowrap' }}
                        title={st ? `Stop: ${st.isCredit ? 'buy the spread back' : 'sell it'} at ${st.price.toFixed(2)} — ${st.pct}% of the ${st.isCredit ? 'credit' : 'debit'}${st.guide ? ' (guide)' : ' (your plan)'}; ${money(st.loss)} on ${st.qty} contract${st.qty === 1 ? '' : 's'}${st.ifFilled ? ' once filled' : ''}` : 'No entry price on the ticket'}>
                        {st ? <><span className="text-text-faint">{st.isCredit ? 'buy back ' : 'sell '}</span>@{st.price.toFixed(2)} <span className="text-text-muted">{money(st.loss)}</span></> : '—'}
                      </td>); })()}
                    {(() => { const tg = targetOf(r); return (
                      <td className="py-2 pr-2 text-right mono" data-testid="op-target" style={{ color: tg ? '#3fb950' : '#8b949e', whiteSpace: 'nowrap' }}
                        title={tg ? tg.legs.map((x, i) => `${tg.legs.length > 1 ? `T${i + 1}: ` : ''}${x.qty}x ${tg.side} @ ${x.price.toFixed(2)} (+${x.pct}% of ${tg.basis === 'entry' ? 'entry' : 'max profit'})`).join('\n') + (tg.plan ? '\n(your exit plan)' : '\n(strategy rule)') : 'No entry price on the ticket'}>
                        {tg ? <><span className="text-text-faint">{tg.side} </span>@{tg.price.toFixed(2)}{tg.legs.length > 1 ? `→${tg.last.toFixed(2)}` : ''} <span>{money(tg.gain)}</span></> : '—'}
                      </td>); })()}
                    {!compact && <td className="py-2 pr-2 text-right mono text-text-muted">{r.avgExit === '' ? '—' : r.avgExit}</td>}
                    <td className={'py-2 pr-2 text-right mono ' + (n(r.realisedPnl) >= 0 ? 'win' : 'loss')}>
                      {chains[r.ticketRef]
                        ? <span className={n(r.realisedPnl) + chains[r.ticketRef].banked >= 0 ? 'win' : 'loss'}>{money(n(r.realisedPnl) + chains[r.ticketRef].banked)}</span>
                        : r.realisedPnl === '' ? '—' : money(r.realisedPnl)}
                      {chains[r.ticketRef] && (
                        <div data-testid="op-roll-banked" className="text-[11px]" style={{ color: chains[r.ticketRef].banked >= 0 ? '#3fb950' : '#f85149' }}
                          title={'Banked by the ticket' + (chains[r.ticketRef].rolls > 1 ? 's' : '') + ' this was rolled from: '
                            + chains[r.ticketRef].links.map(l => `${l.strikes} ${money(l.realised)}`).join(' · ')}>
                          {n(r.realisedPnl) ? <>incl. {money(chains[r.ticketRef].banked)} roll</> : 'from the roll'}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pl-2"><Pill s={r.status} /></td>
                    <td className="py-2 pl-2 text-right" style={{ whiteSpace: 'nowrap' }}>
                      {/* A working order has nothing to sell. Cancelling it is the
                          only action that makes sense, and without it the committed
                          risk never clears. (Oct 2026.) */}
                      <button onClick={e => { e.stopPropagation(); setDetail(r); }} data-testid="op-details"
                        title="Payoff diagram, where price is against the strikes, target, stop and greeks — click the chart to test a price"
                        className="text-[12px] px-2 py-0.5 rounded mr-1"
                        style={{ border: '1px solid #1f6feb', color: '#58a6ff', background: 'transparent', cursor: 'pointer' }}>Details</button>
                      <button onClick={e => { e.stopPropagation(); setEditing(r); }} data-testid="op-edit"
                        title="Correct what was logged — contracts, strikes, entry price, limit, max risk/profit"
                        className="text-[12px] px-2 py-0.5 rounded mr-1"
                        style={{ border: '1px solid #30363d', color: '#a8b2be', background: 'transparent', cursor: 'pointer' }}>Edit</button>
                      {r.status === STATUS.WORKING ? (
                        <button onClick={e => { e.stopPropagation(); cancelTicket(r); }}
                          title="Mark this order cancelled — it stops counting against the open-risk cap"
                          className="text-[12px] px-2 py-0.5 rounded"
                          style={{ border: '1px solid #8957e5', color: '#bc8cff', background: 'transparent', cursor: 'pointer' }}>
                          {cancelling === r.ticketRef ? 'Cancelling…' : 'Cancel'}
                        </button>
                      ) : (
                      <button onClick={e => { e.stopPropagation(); setTicket({ row: r, tab: 'close' }); }}
                        title="Sell ticket — close in tranches"
                        className="text-[12px] px-2 py-0.5 rounded"
                        style={{ border: '1px solid #da3633', color: '#f85149', background: 'transparent', cursor: 'pointer' }}>Sell</button>
                      )}
                      {r.status !== STATUS.WORKING && /45/.test(r.engine || '') && (
                        <button onClick={e => { e.stopPropagation(); setTicket({ row: r, tab: 'roll' }); }}
                          title="Roll — close old legs, open new ones as one combo"
                          className="text-[12px] px-2 py-0.5 rounded ml-1"
                          style={{ border: '1px solid #9e6a03', color: '#d29922', background: 'transparent', cursor: 'pointer' }}>Roll</button>
                      )}
                    </td>
                  </tr>
                  {isOpen && r.closes.map((c, i) => (
                    <tr key={c.closeId || i} style={{ background: '#0d1117' }}>
                      <td className="py-1.5 pr-2 text-text-faint text-[12px]">{c.closeDate}</td>
                      <td className="py-1.5 pr-2 text-text-muted text-[12px]" colSpan={compact ? 1 : 2}>
                        &nbsp;&nbsp;&nbsp;tranche {i + 1}{c.notes ? ` — ${c.notes}` : ''}
                      </td>
                      <td></td>
                      <td className="py-1.5 pr-2 text-right mono text-[12px]">{c.qtyClosed}</td>
                      <td className="py-1.5 pr-2 text-right mono text-[12px] text-text-muted">@ {c.closePrice}</td>
                      <td></td>
                      <td></td>
                      <td></td>
                      {!compact && <td className="py-1.5 pr-2"></td>}
                      <td className={'py-1.5 pr-2 text-right mono text-[12px] ' + (c.pnl >= 0 ? 'win' : 'loss')}>{money(c.pnl)}</td>
                      <td className="py-1.5 pl-2"></td>
                      <td></td>
                    </tr>
                  ))}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {ticket && (
        <OrderTicket position={ticket.row} initialTab={ticket.tab}
          onClose={() => setTicket(null)}
          onDone={() => { setTicket(null); setReload(x => x + 1); }} />
      )}
      {detail && (
        <TradeDetail row={detail} account={account} onClose={() => setDetail(null)}
          onSell={r => { setDetail(null); setTicket({ row: r, tab: 'close' }); }}
          onRoll={r => { setDetail(null); setTicket({ row: r, tab: 'roll' }); }} />
      )}
      {editing && (
        <EditTicketModal position={editing} onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); setReload(x => x + 1); }} />
      )}
      {reconciling && (
        <FillReconcile positions={reconciling === true ? rows : [reconciling]} account={account}
          onClose={() => setReconciling(false)}
          onDone={() => setReload(x => x + 1)} />
      )}
    </div>
  );
}
