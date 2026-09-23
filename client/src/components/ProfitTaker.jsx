import React, { useState, useEffect, useMemo } from 'react';
import {
  normalisePosition, targetToPrice, priceToTarget, pnlAt, ibkrLines, ladder,
  LADDER_PRESETS, snap, defaultTick, round2
} from '../utils/ticketMath';

// BUY ticket — the IBKR "Attach ▸ Profit Taker" check, done before you click
// Transmit. Replaces the old ProfitScale tile row.
//
// Single   one profit taker for the whole position (what TWS attaches by default).
// Ladder   one profit taker per tranche, for scaling out of a multi-contract buy.
//          TWS attaches ONE child per parent, so a ladder is entered in TWS as
//          separate closing limits after the fill; this lists each one.
//
// Every row shows the price in both combo conventions and the OFFSET, i.e. the
// number to compare with what TWS pre-fills in the attached order. If your TWS
// preset uses a percentage offset, it is a % of the PARENT price — so the ticket
// also shows the offset as % of entry, which for a debit fly is nowhere near the
// % of max profit you think you are asking for.
//
// props: ncd (per-share, + credit / − debit), win (max profit $ per contract),
//        contracts, underlying, legs (engine legs [{label, strike}]), onPlan(plan)
const cell = { padding: '5px 6px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117',
  color: '#e6edf3', fontSize: 13, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%' };

// Contracts per leg, counting "x2" bodies — a BWB is 4 contracts per unit, not 3.
function contractsPerUnit(legs) {
  if (!Array.isArray(legs) || !legs.length) return 1;
  return legs.reduce((a, l) => a + (/x2\b/i.test(l.label || '') ? 2 : 1), 0);
}

export default function ProfitTaker({ ncd, win, contracts, underlying, legs, onPlan }) {
  const qty = Math.max(1, Number(contracts) || 1);
  const pos = useMemo(() => normalisePosition({
    qty, qtyOpen: qty, entryPrice: ncd, maxProfit: win > 0 ? win * qty : '', underlying
  }), [ncd, win, qty, underlying]);
  const tick = defaultTick(underlying);
  const perUnit = contractsPerUnit(legs);
  const [comm, setComm] = useState(() => { try { const v = parseFloat(localStorage.getItem('commissionPerLeg')); return isFinite(v) ? v : 0.65; } catch (e) { return 0.65; } });
  const roundTrip = q => round2(q * perUnit * (Number(comm) || 0) * 2);

  const [mode, setMode] = useState(qty > 1 ? 'ladder' : 'single');
  const [single, setSingle] = useState({ pct: 50, price: '' });
  const [rows, setRows] = useState(() => ladder(qty, LADDER_PRESETS['0DTE'].pcts));
  const [stopPct, setStopPct] = useState('');

  // Contracts change on the engine → re-split the ladder, keep the targets.
  useEffect(() => {
    setRows(rs => ladder(qty, rs.length ? rs.map(r => r.pct) : [25, 50, 75]));
    if (qty > 1 && mode === 'single') setMode('ladder');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qty]);

  const priceOf = pct => snap(targetToPrice(pos, Number(pct) || 0), tick);
  const effRows = mode === 'single' ? [{ qty, pct: single.pct }] : rows;
  const stop = stopPct !== '' && isFinite(parseFloat(stopPct)) ? priceOf(-Math.abs(parseFloat(stopPct))) : null;

  // Hand the plan up so Log trade can write it into the notes and save it for the
  // SELL ticket to open with.
  useEffect(() => {
    onPlan && onPlan({ rows: effRows.map(r => ({ qty: Number(r.qty) || 0, pct: Number(r.pct) || 0 })), stopPct: stopPct === '' ? '' : Math.abs(parseFloat(stopPct)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(effRows), stopPct]);

  const side = pos.isCredit ? 'debit' : 'credit';
  const allocated = rows.reduce((a, r) => a + (Number(r.qty) || 0), 0);

  const Line = ({ label, q, pct, price }) => {
    const ib = ibkrLines(pos, price);
    const gross = pnlAt(pos, price, q);
    const net = gross - roundTrip(q);
    const pctOfEntry = ib.offsetPctOfEntry;
    return (
      <div className="mono" style={{ fontSize: 12, color: '#a8b2be', lineHeight: 1.6, padding: '4px 0 6px' }}>
        <span style={{ color: '#c9d1d9' }}>{label}</span>{' '}
        <span style={{ color: '#3fb950', fontWeight: 700 }}>+${gross.toFixed(0)}</span>
        <span> gross · </span>
        <span style={{ color: net >= 0 ? '#3fb950' : '#f85149' }}>{net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(0)} net</span>
        <span> of {q} ({pct}% max)</span><br />
        {ib.buyConv}{pos.isCredit && <>&nbsp;&nbsp;·&nbsp;&nbsp;{ib.sellConv}</>}<br />
        TWS offset <b style={{ color: '#e6edf3' }}>{ib.offset >= 0 ? '+' : ''}{ib.offset.toFixed(2)}</b>
        {pctOfEntry != null && <> = <b style={{ color: Math.abs(pctOfEntry - pct) > 10 ? '#d29922' : '#e6edf3' }}>{pctOfEntry.toFixed(0)}%</b> of entry price</>}
        {pctOfEntry != null && Math.abs(pctOfEntry - pct) > 10 && <span style={{ color: '#d29922' }}> — a % preset would need {pctOfEntry.toFixed(0)}%, not {pct}%</span>}
      </div>
    );
  };

  const btn = on => ({ padding: '3px 10px', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid',
    borderColor: on ? '#238636' : '#30363d', background: on ? '#0d2818' : 'transparent', color: on ? '#3fb950' : '#a8b2be' });

  return (
    <div style={{ marginTop: 10, marginBottom: 4, padding: 10, borderRadius: 8, background: '#0d1117', border: '1px solid #21262d' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ background: '#0d2818', color: '#3fb950', borderRadius: 4, padding: '1px 7px', fontSize: 12, fontWeight: 700 }}>BUY</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#e6edf3' }}>Profit taker</span>
        <span className="mono" style={{ fontSize: 12, color: '#8b949e' }}>
          entry {Math.abs(pos.ncd || 0).toFixed(2)} {pos.isCredit ? 'cr' : 'db'} · max {win > 0 ? `$${win.toFixed(0)}` : `$${(Math.abs(pos.ncd || 0) * 100).toFixed(0)}*`}/ct · closes for a {side}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button style={btn(mode === 'single')} onClick={() => setMode('single')}>Single</button>
          <button style={btn(mode === 'ladder')} onClick={() => setMode('ladder')}>Ladder ({qty})</button>
        </span>
      </div>

      {mode === 'single' ? (<>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
          {[25, 30, 40, 50, 75, 100].map(p => (
            <button key={p} onClick={() => setSingle({ pct: p, price: '' })} style={btn(Number(single.pct) === p)}>{p}%</button>
          ))}
          <span style={{ fontSize: 12, color: '#8b949e', marginLeft: 8 }}>or</span>
          <input type="number" step="5" value={single.pct} style={{ ...cell, width: 70 }}
            onChange={e => setSingle({ pct: e.target.value, price: '' })} title="% of max profit" />
          <span style={{ fontSize: 12, color: '#8b949e' }}>% ⇄ LMT</span>
          <input type="number" step={tick} style={{ ...cell, width: 84 }}
            value={single.price !== '' ? single.price : priceOf(single.pct)}
            onChange={e => { const p = parseFloat(e.target.value); const t = isFinite(p) ? priceToTarget(pos, p) : null; setSingle({ price: e.target.value, pct: t != null ? round2(t) : '' }); }} />
        </div>
        <Line label="PT" q={qty} pct={Number(single.pct) || 0} price={single.price !== '' && isFinite(parseFloat(single.price)) ? parseFloat(single.price) : priceOf(single.pct)} />
      </>) : (<>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
          {Object.entries(LADDER_PRESETS).filter(([k]) => k !== 'single50').map(([k, p]) => (
            <button key={k} style={btn(false)} onClick={() => setRows(ladder(qty, p.pcts))}>{p.label}</button>
          ))}
          <button style={{ ...btn(false), borderColor: '#2f81f7', color: '#58a6ff' }} onClick={() => setRows(r => [...r, { qty: 1, pct: 50 }])}>+ Tranche</button>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 12, color: allocated === qty ? '#8b949e' : '#f85149' }}>{allocated} / {qty} allocated</span>
        </div>
        {rows.map((r, i) => {
          const typed = r.price != null && r.price !== '' && isFinite(parseFloat(r.price));
          const price = typed ? parseFloat(r.price) : priceOf(r.pct);
          return (
            <div key={i} style={{ borderTop: i ? '1px solid #21262d' : 'none', paddingTop: 4 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#8b949e', width: 22 }}>T{i + 1}</span>
                <input type="number" min="1" value={r.qty} style={{ ...cell, width: 56 }} title="contracts"
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                <span style={{ fontSize: 12, color: '#8b949e' }}>ct @</span>
                <input type="number" step="5" value={r.pct} style={{ ...cell, width: 64 }} title="% of max profit"
                  onChange={e => setRows(rs => rs.map((x, j) => j === i ? { ...x, pct: e.target.value, price: '' } : x))} />
                <span style={{ fontSize: 12, color: '#8b949e' }}>% →</span>
                <input type="number" step={tick} value={r.price != null && r.price !== '' ? r.price : price} style={{ ...cell, width: 80 }} title="limit price"
                  onChange={e => { const v = e.target.value, p = parseFloat(v); const t = isFinite(p) ? priceToTarget(pos, p) : null; setRows(rs => rs.map((x, j) => j === i ? { ...x, price: v, pct: t != null ? round2(t) : x.pct } : x)); }} />
                <button onClick={() => setRows(rs => rs.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#8b949e', cursor: 'pointer' }}>×</button>
              </div>
              <Line label={`T${i + 1}`} q={Number(r.qty) || 0} pct={Number(r.pct) || 0} price={price} />
            </div>
          );
        })}
      </>)}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid #21262d', paddingTop: 6 }}>
        <span style={{ fontSize: 12, color: '#a8b2be' }}>Stop loss</span>
        <input type="number" step="25" placeholder="% max" value={stopPct} onChange={e => setStopPct(e.target.value)} style={{ ...cell, width: 72 }} />
        {stop != null && (
          <span className="mono" style={{ fontSize: 12, color: '#f85149' }}>
            LMT {stop.toFixed(2)} {pos.isCredit ? 'db' : 'cr'} · {ibkrLines(pos, stop).buyConv} · −${Math.abs(pnlAt(pos, stop, qty)).toFixed(0)}
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#a8b2be' }}>Comm / leg / ct</span>
        <input type="number" step="0.01" value={comm} style={{ ...cell, width: 60 }}
          onChange={e => { setComm(e.target.value); try { localStorage.setItem('commissionPerLeg', e.target.value); } catch (x) { /* */ } }} />
        <span className="mono" style={{ fontSize: 12, color: '#8b949e' }}>{perUnit} leg-ct/unit · RT ${roundTrip(qty).toFixed(2)}</span>
      </div>
      {!(win > 0) && (
        <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: 4 }}>* No Win amount entered — % targets use the entry as max profit. Enter Win for a debit fly or the targets are too tight.</div>
      )}
      <div style={{ fontSize: 11.5, color: '#8b949e', marginTop: 4 }}>
        The plan is written into the trade notes on Log trade and pre-loads the Sell ticket for this position.
      </div>
    </div>
  );
}
