import React, { useState } from 'react';
import { api } from '../utils/api';

// Correct a logged ticket (Oct 2026). A typo in the contracts, a strike, or the entry
// price used to stay wrong for the life of the trade, and every number built on it
// (risk, stop, P&L) with it. Only the fields the trade log is built from can change;
// the engine's own record of the decision (scores, greeks, market snapshot) cannot.
// The server notes each change on the ticket, old -> new.
//
// props: position (an open-positions row), onClose, onDone
const n = v => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
const field = { padding: '6px 8px', borderRadius: 6, border: '1px solid #30363d', background: '#0d1117', color: '#e6edf3',
  fontSize: 13.5, fontFamily: 'JetBrains Mono,monospace', outline: 'none', width: '100%' };

// "QQQ - Iron Condor - Normal - 5 contracts" carries the count; keep it in step.
export function strategyWithCount(strategy, qty) {
  const s = String(strategy || '');
  if (!(qty > 0)) return s;
  const word = `${qty} contract${qty === 1 ? '' : 's'}`;
  return /\d+\s+contracts?\s*$/i.test(s) ? s.replace(/\d+\s+contracts?\s*$/i, word) : s;
}

export default function EditTicketModal({ position: p, onClose, onDone }) {
  const entry0 = n(p.entryPrice);
  const lim0 = n(p.limitPrice);
  const working = p.status === 'Working' || p.status === 'Part filled';
  const [f, setF] = useState({
    underlying: p.underlying || '',
    strategy: p.strategy || '',
    contracts: String(p.qty ?? ''),
    wingStrikes: p.legs || '',
    entry: entry0 != null ? String(Math.abs(entry0)) : '',
    side: entry0 != null && entry0 < 0 ? 'db' : 'cr',
    limit: lim0 != null ? String(Math.abs(lim0)) : '',
    maxProfit: p.maxProfit != null ? String(p.maxProfit) : '',
    maxRisk: p.maxRisk != null ? String(p.maxRisk) : '',
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setF(o => ({ ...o, [k]: v }));

  // The patch: only what differs from the row, signed the way the ticket stores it.
  function patch() {
    const out = {};
    const sgn = v => (n(v) == null ? '' : (f.side === 'db' ? -Math.abs(n(v)) : Math.abs(n(v))));
    const qty = n(f.contracts);
    if (f.underlying.trim().toUpperCase() !== String(p.underlying || '')) out.underlying = f.underlying.trim().toUpperCase();
    if (qty !== n(p.qty)) out.contracts = qty;
    const strat = qty !== n(p.qty) ? strategyWithCount(f.strategy, qty) : f.strategy;
    if (strat !== (p.strategy || '')) out.strategy = strat;
    if (f.wingStrikes.trim() !== String(p.legs || '')) out.wingStrikes = f.wingStrikes.trim();
    if (sgn(f.entry) !== (entry0 == null ? '' : entry0)) out.netCreditDebit = sgn(f.entry);
    if (working && sgn(f.limit) !== (lim0 == null ? '' : lim0)) out.limitPrice = sgn(f.limit);
    if (n(f.maxProfit) !== n(p.maxProfit)) out.maxProfit = n(f.maxProfit) ?? '';
    if (n(f.maxRisk) !== n(p.maxRisk)) out.maxRisk = n(f.maxRisk) ?? '';
    return out;
  }
  const changes = patch();
  const nChanges = Object.keys(changes).length;
  const bad = !(n(f.contracts) > 0) ? 'Contracts must be more than zero'
    : f.entry !== '' && n(f.entry) == null ? 'Entry must be a number'
    : null;

  async function save() {
    setSaving(true); setErr(null);
    try {
      await api.editTicket(p.ticketRef, changes);
      onDone && onDone();
    } catch (e) {
      setErr(e.message || 'Save failed');
      setSaving(false);
    }
  }

  const label = { fontSize: 12, color: '#8b949e', marginBottom: 4, display: 'block' };
  const pill = on => ({ padding: '5px 10px', borderRadius: 6, fontSize: 12.5, cursor: 'pointer',
    border: `1px solid ${on ? '#58a6ff' : '#30363d'}`, background: on ? '#58a6ff22' : 'transparent', color: on ? '#e6edf3' : '#a8b2be' });
  const L = (txt, k, el) => <label style={{ display: 'block' }}><span style={label}>{txt}</span>{el || <input style={field} value={f[k]} onChange={e => set(k, e.target.value)} aria-label={txt} />}</label>;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div data-testid="edit-ticket" style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 12, padding: 20, width: 560, maxWidth: '96vw', maxHeight: '92vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#e6edf3' }}>Edit logged trade</div>
            <div style={{ fontSize: 12.5, color: '#a8b2be', marginTop: 4 }}>
              Correct what was entered wrong. The change is noted on the ticket (old → new) and the open positions recalculate.
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', color: '#a8b2be', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12 }}>
          {L('Underlying', 'underlying')}
          {L('Strategy', 'strategy')}
          {L('Contracts', 'contracts')}
          {L('Strikes (low → high)', 'wingStrikes')}
          {L('Entry, per contract', 'entry')}
          <label style={{ display: 'block' }}><span style={label}>Credit or debit</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button type="button" style={pill(f.side === 'cr')} onClick={() => set('side', 'cr')}>credit</button>
              <button type="button" style={pill(f.side === 'db')} onClick={() => set('side', 'db')}>debit</button>
            </span>
          </label>
          {working && L('Limit sent, per contract', 'limit')}
          {working && <span style={{ fontSize: 12, color: '#8b949e', alignSelf: 'end' }}>Signed the same way as the entry.</span>}
          {L('Max profit ($, all contracts)', 'maxProfit')}
          {L('Max risk ($, all contracts)', 'maxRisk')}
        </div>

        {n(p.qtyFilled) > 0 && (
          <div style={{ marginTop: 12, fontSize: 12.5, color: '#d29922' }}>
            This ticket has recorded fills; its average entry comes from those, not from the entry above.
          </div>
        )}
        {(bad || err) && <div style={{ marginTop: 12, fontSize: 12.5, color: '#f85149' }}>{bad || err}</div>}

        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button data-testid="edit-save" onClick={save} disabled={!nChanges || !!bad || saving}
            style={{ padding: '9px 16px', borderRadius: 8, border: 'none', fontSize: 13.5, fontWeight: 700,
              background: nChanges && !bad ? '#238636' : '#1c2128', color: nChanges && !bad ? '#fff' : '#8b949e',
              cursor: nChanges && !bad && !saving ? 'pointer' : 'default' }}>
            {saving ? 'Saving…' : nChanges ? `Save ${nChanges} change${nChanges === 1 ? '' : 's'}` : 'No changes'}
          </button>
          <button onClick={onClose} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #30363d', background: 'transparent', color: '#a8b2be', fontSize: 13, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
