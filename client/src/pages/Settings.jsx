import React, { useEffect, useMemo, useState } from 'react';
import { LogOut, Plus, X, RefreshCw } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$ } from '../utils/format';
import { rateFromFills, DEFAULT_COMMISSION } from '../utils/commission';
import { invalidateCommissionRates } from '../utils/useCommissionRate';
import { ThemeChoice, GlassChoice, useVisionOn, useGlassOn } from '../components/ThemeToggle';
import { accountColor, ACCOUNT_PALETTE } from '../utils/accountColors';
import { isAggExcluded } from '../utils/stats';
import { useAccountSummary } from '../components/CapitalPanel';
import { matchAccount, bankrollOf, bankrollGap } from '../utils/capital';
import { CVAR_TRADE_PCT } from '../engine/sizing';
import Modal from '../components/Modal';
import DataHealthPanel from '../components/DataHealthPanel';

// Settings, grouped by job (Nov 2026): a contents bar, the bridge's health, a card per
// account (edit in a side panel), the risk limits as one row per account with what
// they do to a real trade, TWS accounts linked from what the bridge sees, appearance,
// data, and a danger zone for anything that can't be undone.

const C = { text: 'var(--c-e6edf3)', muted: 'var(--c-8b949e)', faint: 'var(--c-6e7681)', border: 'var(--c-30363d)',
  green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', blue: 'var(--c-58a6ff)', well: 'var(--c-0d1117)' };
const H = { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' };
const pctNum = (v, d) => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : d; };
const commNum = (v, d) => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? n : d; };
const limit$ = (bank, pct) => Math.round((Number(bank) || 0) * (parseFloat(pct) || 0) / 100);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const bridgeUrlOf = () => { try { return (localStorage.getItem('bridgeUrl') || '').replace(/\/+$/, ''); } catch (e) { return ''; } };
const input = 'w-full px-2.5 py-1.5 bg-bg border border-bg-border rounded-lg text-sm text-text mono outline-none focus:border-accent';
const btn = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-full border border-bg-border text-text hover:bg-bg-hover disabled:opacity-50';
const btnDanger = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-[13px] rounded-full border disabled:opacity-50';
const isPaper = (a, accounts) => isAggExcluded(a.id, accounts);
// Local-storage caches on this device that are safe to drop (they rebuild).
export const DEVICE_CACHES = ['sb.marklog.v1', 'ot-engine-scans-v1'];

// What a bankroll's limits allow, in contracts of two common widths, counting the
// whole max loss as the bad day (the engine's CVaR is the same or lower).
export function sizingPreview(bank, cvarPct, maxOpenPct) {
  const cap = limit$(bank, cvarPct), open = limit$(bank, maxOpenPct);
  const n = loss => Math.max(0, Math.min(Math.floor(cap / loss), Math.floor(open / loss)));
  return { cap, open, five: n(380), twentyFive: n(1900) };
}

function Section({ id, title, sub, right, children, danger }) {
  return (
    <section id={id} className="card mb-5" data-testid={`settings-${id}`}
      style={danger ? { borderColor: 'color-mix(in srgb, var(--c-f85149) 55%, transparent)' } : undefined}>
      <div className="flex items-baseline gap-3 mb-3 flex-wrap">
        <h3 className="font-display font-semibold text-[17px]" style={danger ? { color: C.red } : undefined}>{title}</h3>
        {sub && <span className="text-[12.5px]" style={{ color: C.muted }}>{sub}</span>}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </section>
  );
}

// (4) Bridge health strip
function useBridgeHealth() {
  const [h, setH] = useState({ state: 'idle' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const url = bridgeUrlOf();
    if (!url) { setH({ state: 'off' }); return undefined; }
    let dead = false;
    setH(x => ({ ...x, state: x.state === 'idle' ? 'checking' : x.state }));
    fetch(url + '/api/health', { headers: H }).then(async r => {
      if (r.status === 401) throw new Error('the bridge key is missing or wrong');
      return r.json();
    }).then(d => { if (!dead) setH({ state: d.connected ? 'ok' : 'warn', d }); })
      .catch(e => { if (!dead) setH({ state: 'err', err: e.message }); });
    const id = setTimeout(() => setTick(t => t + 1), 60000);
    return () => { dead = true; clearTimeout(id); };
  }, [tick]);
  return [h, () => setTick(t => t + 1)];
}

export function BridgeStrip({ health, onRefresh }) {
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');
  const d = health.d || {};
  const tone = { ok: C.green, warn: C.amber, err: C.red, off: C.faint, checking: C.faint, idle: C.faint }[health.state];
  const word = { ok: 'Bridge connected', warn: 'Bridge up, TWS not connected', err: 'Bridge unreachable', off: 'No bridge set', checking: 'Checking the bridge…', idle: 'Checking the bridge…' }[health.state];
  const since = d.startedAt ? new Date(d.startedAt) : null;
  const pulled = d.commit && d.headOnDisk && d.commit !== d.headOnDisk;
  async function restart() {
    const url = bridgeUrlOf();
    if (!url || !window.confirm('Restart the bridge? It drops the TWS connection for about 10 seconds.')) return;
    setBusy('Restarting…'); setNote('');
    await fetch(url + '/api/restart', { method: 'POST', headers: H }).catch(() => {});
    let back = null;
    for (let i = 0; i < 15 && !back; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try { back = await fetch(url + '/api/health', { headers: H }).then(r => r.json()); } catch (e) { back = null; }
    }
    setNote(back ? (back.connected ? 'Restarted, TWS connected.' : 'Restarted; connecting to TWS…') : 'Did not come back within 30 s: check the Mac.');
    setBusy(''); onRefresh();
  }
  return (
    <div className="card mb-5 flex items-center gap-4 flex-wrap" data-testid="bridge-strip" style={{ boxShadow: `inset 4px 0 0 ${tone}` }}>
      <span className="inline-flex items-center gap-2 text-[15px] font-semibold" data-testid="bridge-state">
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 5, background: tone }} />{word}
      </span>
      {health.state === 'err' && <span className="text-[13px]" style={{ color: C.red }}>{health.err}</span>}
      {d.ok && <>
        <span className="text-[13px] mono" style={{ color: C.muted }}>{d.app || 'TWS'}{d.mode ? ' ' + d.mode : ''}{d.port ? ` · port ${d.port}` : ''}{d.accounts && d.accounts.length ? ` · accounts seen: ${d.accounts.join(', ')}` : ''}</span>
        {since && <span className="text-[13px]" style={{ color: C.muted }}>running since {since.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</span>}
        {d.commit && <span className="text-[13px] mono" data-testid="bridge-code" style={{ color: pulled ? C.amber : C.muted }}>
          {pulled ? `code ${d.commit} loaded, ${d.headOnDisk} pulled: restart to load it` : `code ${d.commit}`}</span>}
        {Array.isArray(d.recentErrors) && d.recentErrors.some(e => e.code === 10167) && <span className="text-[13px]" style={{ color: C.muted }}>some market data delayed</span>}
      </>}
      <span className="ml-auto flex gap-2">
        <button type="button" className={btn} onClick={onRefresh} data-testid="bridge-test"><RefreshCw size={13} /> Test</button>
        {d.canRestart && <button type="button" className={btn} onClick={restart} disabled={!!busy} data-testid="bridge-restart">{busy || 'Restart bridge'}</button>}
      </span>
      {note && <span className="text-[12.5px] w-full" style={{ color: C.muted }}>{note}</span>}
    </div>
  );
}

// (2) + (6) one card per account; a stale bankroll gets a "use net liq" button
export function AccountCard({ a, accounts, twsId, s, onEdit, onUseNetLiq }) {
  const colour = accountColor(a.id, accounts);
  const paper = isPaper(a, accounts);
  const bank = bankrollOf(a);
  const gap = s ? bankrollGap(bank, s.netLiq) : null;
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" data-testid={`acct-card-${a.id}`}
      style={{ border: `1px solid ${C.border}`, background: 'color-mix(in srgb, var(--c-e6edf3) 4%, transparent)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span aria-hidden="true" data-testid="account-colour" style={{ width: 13, height: 13, borderRadius: 7, background: colour }} />
        <b className="text-[16px] font-semibold">{a.name}</b>
        {twsId ? <span className="text-[12.5px] mono" style={{ color: C.muted }}>{twsId}</span>
          : <span className="text-[12.5px]" style={{ color: C.amber }}>Not linked to TWS</span>}
        <span className="ml-auto text-[11.5px] px-2 py-0.5 rounded-full" style={{ color: paper ? C.blue : C.green, background: `color-mix(in srgb, ${paper ? 'var(--c-58a6ff)' : 'var(--c-3fb950)'} 16%, transparent)` }}>
          {paper ? 'paper · not in totals' : 'real money'}</span>
      </div>
      <div className="grid gap-2 text-[12px]" style={{ gridTemplateColumns: 'repeat(3, minmax(0,1fr))', color: C.muted }}>
        <div><div className="mono text-[16px] font-semibold" style={{ color: C.text }} data-testid="account-bankroll">{fmt$(bank)}</div>sizing bankroll</div>
        <div><div className="mono text-[16px] font-semibold" style={{ color: C.text }}>{s ? fmt$(s.netLiq) : '—'}</div>net liq (TWS)</div>
        <div><div className="mono text-[16px] font-semibold" style={{ color: gap && gap.flag ? C.amber : C.text }} data-testid={`acct-gap-${a.id}`}>
          {gap ? `${gap.pct >= 0 ? '+' : '−'}${Math.abs(gap.pct).toFixed(0)}%` : '—'}</div>gap</div>
      </div>
      <div className="text-[12px] mono" style={{ color: C.faint }}>
        max open {a.maxOpenRiskPct ?? 40}% · daily loss {a.maxDailyLossPct ?? 20}% · bad day {a.cvarPct ?? CVAR_TRADE_PCT}% · ${Number(a.commissionPerContract ?? DEFAULT_COMMISSION).toFixed(2)}/ct
      </div>
      {gap && gap.flag && (
        <div className="flex items-center gap-2 flex-wrap rounded-xl px-3 py-2" data-testid={`stale-${a.id}`}
          style={{ border: '1px solid color-mix(in srgb, var(--c-d29922) 55%, transparent)', background: 'color-mix(in srgb, var(--c-d29922) 12%, transparent)' }}>
          <span className="text-[12.5px] flex-1" style={{ color: C.amber }}>
            Net liq is {Math.abs(gap.pct).toFixed(0)}% {gap.pct > 0 ? 'above' : 'below'} the bankroll: sizing is using an old number{paper ? ' (on paper that may be on purpose)' : ''}.</span>
          <button type="button" className={btn} onClick={() => onUseNetLiq(a, s.netLiq)} data-testid={`use-netliq-${a.id}`}>Use net liq</button>
        </div>
      )}
      <div className="flex gap-2"><button type="button" className={btn} onClick={() => onEdit(a)} data-testid={`edit-${a.id}`}>Edit</button></div>
    </div>
  );
}

// The account editor, in a side panel. `a` null = a new account.
function AccountPanel({ a, accounts, twsSeen, onClose, onSave, saving }) {
  const blank = { name: '', startingBankroll: '3000', bankrollSince: todayISO(), maxDailyLossPct: '20', maxOpenRiskPct: '40',
    commissionPerContract: String(DEFAULT_COMMISSION), color: '', twsAccount: '', cvarPct: String(CVAR_TRADE_PCT) };
  const [f, setF] = useState(() => a ? {
    name: a.name, startingBankroll: String(a.startingBankroll ?? ''), bankrollSince: a.bankrollSince || '',
    maxDailyLossPct: String(a.maxDailyLossPct ?? 20), maxOpenRiskPct: String(a.maxOpenRiskPct ?? 40),
    commissionPerContract: String(a.commissionPerContract ?? DEFAULT_COMMISSION), color: a.color || '', twsAccount: a.twsAccount || '',
    cvarPct: String(a.cvarPct ?? CVAR_TRADE_PCT) } : blank);
  const [calib, setCalib] = useState(null);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const live = (parseFloat(f.startingBankroll) || 0) + (a ? Number(a.realisedPnl) || 0 : 0);
  const pv = sizingPreview(live, f.cvarPct, f.maxOpenRiskPct);
  async function calibrate() {
    setCalib({ busy: true });
    try {
      const url = bridgeUrlOf();
      if (!url) { setCalib({ err: 'Set the bridge URL first' }); return; }
      const d = await (await fetch(url + '/api/executions', { headers: H })).json();
      const r = rateFromFills(d.fills || []);
      if (!r) { setCalib({ err: 'No option fills with commission today' }); return; }
      set('commissionPerContract', String(r.rate));
      setCalib({ text: `Today: $${r.commission.toFixed(2)} over ${r.contracts} contracts = $${r.rate.toFixed(3)} each` });
    } catch (e) { setCalib({ err: 'Bridge not reachable: ' + e.message }); }
  }
  const field = (label, k, props = {}, hint) => (
    <label className="flex flex-col gap-1">
      <span className="text-[12px]" style={{ color: C.muted }} title={props.title}>{label}</span>
      <input className={input} value={f[k]} onChange={e => set(k, e.target.value)} {...props} />
      {hint && <span className="text-[11.5px] mono" style={{ color: C.faint }}>{hint}</span>}
    </label>
  );
  const colour = f.color || (a ? accountColor(a.id, accounts) : ACCOUNT_PALETTE[(accounts || []).length % ACCOUNT_PALETTE.length]);
  return (
    <Modal onClose={onClose} width={540} testid="account-panel" panelStyle={{ marginLeft: 'auto' }}>
      <div className="flex items-center gap-2 mb-3">
        <span aria-hidden="true" style={{ width: 13, height: 13, borderRadius: 7, background: colour }} />
        <h3 className="font-display font-semibold text-[19px]">{a ? `Edit ${a.name}` : 'New account'}</h3>
        <button type="button" onClick={onClose} aria-label="Close" className="ml-auto p-1" style={{ color: C.muted }}><X size={18} /></button>
      </div>
      <div className="text-[11.5px] tracking-wider mb-1.5" style={{ color: C.faint }}>IDENTITY</div>
      <div className="grid grid-cols-2 gap-3 mb-3">
        {field('Name', 'name', { placeholder: 'e.g. Main, IRA, Paper', className: input.replace(' mono', '') })}
        <label className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: C.muted }}>TWS account</span>
          <input className={input} value={f.twsAccount} placeholder="U1234567" list="tws-seen" data-testid="tws-account-input"
            onChange={e => set('twsAccount', e.target.value)} />
          <datalist id="tws-seen">{(twsSeen || []).map(id => <option key={id} value={id} />)}</datalist>
          <span className="text-[11.5px]" style={{ color: C.faint }}>{twsSeen && twsSeen.length ? `the bridge sees ${twsSeen.join(', ')}` : 'the IBKR account number'}</span>
        </label>
      </div>
      <div className="flex flex-col gap-1 mb-3">
        <span className="text-[12px]" style={{ color: C.muted }}>Colour on the boards</span>
        <div role="radiogroup" aria-label="Account colour" className="flex gap-2">
          {ACCOUNT_PALETTE.map(c => (
            <button key={c} type="button" role="radio" aria-checked={colour === c} aria-label={c} data-testid="account-colour-option" onClick={() => set('color', c)}
              style={{ width: 26, height: 26, borderRadius: 13, background: c, border: 'none', cursor: 'pointer', boxShadow: colour === c ? '0 0 0 2px var(--c-0d1117), 0 0 0 4px #ffffff' : 'none' }} />
          ))}
        </div>
      </div>
      <div className="text-[11.5px] tracking-wider mb-1.5" style={{ color: C.faint }}>BANKROLL</div>
      <div className="grid grid-cols-2 gap-3 mb-2">
        {field('Starting bankroll ($)', 'startingBankroll', { type: 'number' })}
        {field('P&L counts from', 'bankrollSince', { type: 'date', title: 'Realised P&L from this date on is added to the starting bankroll' })}
      </div>
      <div className="text-[12.5px] mono mb-3" style={{ color: C.muted }} data-testid="bankroll-preview">
        Bankroll now {fmt$(live)}{a ? ` = start ${Number(a.realisedPnl) >= 0 ? '+' : '−'} ${fmt$(Math.abs(Number(a.realisedPnl) || 0))} realised` : ''}
      </div>
      <div className="text-[11.5px] tracking-wider mb-1.5" style={{ color: C.faint }}>RISK</div>
      <div className="grid grid-cols-2 gap-3 mb-2">
        {field('Max daily loss (% of bankroll)', 'maxDailyLossPct', { type: 'number', step: '0.5' }, `= ${fmt$(limit$(live, f.maxDailyLossPct))}`)}
        {field('Max open risk (% of bankroll)', 'maxOpenRiskPct', { type: 'number', step: '0.5' }, `= ${fmt$(limit$(live, f.maxOpenRiskPct))}`)}
        {field('Bad-day cap (CVaR, % of bankroll)', 'cvarPct', { type: 'number', step: '0.5', min: '0.5', 'data-testid': 'cvar-pct-input',
          title: "CVaR95: the average loss across the worst 5% of a trade's outcomes. The Engine sizes so one trade's bad day stays under this share of the bankroll." },
          `= ${fmt$(pv.cap)} a trade`)}
        <label className="flex flex-col gap-1">
          <span className="text-[12px]" style={{ color: C.muted }}>Commission per contract, each way ($)</span>
          <input className={input} type="number" step="0.01" min="0" value={f.commissionPerContract} onChange={e => set('commissionPerContract', e.target.value)} />
          <button type="button" onClick={calibrate} disabled={calib && calib.busy} className="text-left text-[11.5px] underline" style={{ color: C.blue }}>
            {calib && calib.busy ? 'Reading fills…' : 'Set from today’s TWS fills'}</button>
          {calib && (calib.text || calib.err) && <span className="text-[11.5px]" style={{ color: calib.err ? C.amber : C.green }}>{calib.text || calib.err}</span>}
        </label>
      </div>
      <div className="rounded-xl px-3 py-2 mb-4 text-[12.5px]" style={{ background: C.well, color: C.muted }} data-testid="panel-preview">
        Preview: the bad-day cap allows about <b style={{ color: C.text }}>{pv.five}</b> of a 5-wide spread (≈$380 max loss) and <b style={{ color: C.text }}>{pv.twentyFive}</b> of a 25-wide (≈$1,900), within max open risk.
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className={btn} onClick={onClose}>Cancel</button>
        <button type="button" className="px-4 py-1.5 text-[13px] rounded-full font-semibold disabled:opacity-50" data-testid="panel-save"
          style={{ background: '#ffffff', color: '#24221f' }} disabled={!f.name.trim() || saving} onClick={() => onSave(f)}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

// (3) the risk limits, one row per account, edited in place
function RiskRow({ a, accounts, onSave, saving }) {
  const init = { maxDailyLossPct: String(a.maxDailyLossPct ?? 20), maxOpenRiskPct: String(a.maxOpenRiskPct ?? 40), cvarPct: String(a.cvarPct ?? CVAR_TRADE_PCT), commissionPerContract: String(a.commissionPerContract ?? DEFAULT_COMMISSION) };
  const [d, setD] = useState(init);
  useEffect(() => { setD(init); }, [a.maxDailyLossPct, a.maxOpenRiskPct, a.cvarPct, a.commissionPerContract]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = Object.keys(init).some(k => String(init[k]) !== String(d[k]));
  const bank = bankrollOf(a) || 0;
  const pv = sizingPreview(bank, d.cvarPct, d.maxOpenRiskPct);
  const cell = (label, k, hint, step = '0.5', pre = '') => (
    <label className="flex flex-col gap-1 min-w-0">
      <span className="text-[11.5px]" style={{ color: C.muted }}>{label}</span>
      <span className="flex items-center gap-1.5">
        <span className="text-[12px]" style={{ color: C.faint }}>{pre}</span>
        <input className={input} style={{ width: 70 }} type="number" step={step} value={d[k]} data-testid={`risk-${a.id}-${k}`}
          onChange={e => setD(x => ({ ...x, [k]: e.target.value }))} />
        <span className="text-[12px] mono whitespace-nowrap" style={{ color: C.muted }}>{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="grid gap-3 items-center py-3" data-testid={`risk-row-${a.id}`}
      style={{ gridTemplateColumns: '140px repeat(4, minmax(0, 1fr)) minmax(0, 1.4fr)', borderTop: `1px solid ${C.border}` }}>
      <span className="flex items-center gap-2 font-semibold text-[14px]">
        <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 5, background: accountColor(a.id, accounts) }} />{a.name}</span>
      {cell('Max daily loss %', 'maxDailyLossPct', `= ${fmt$(limit$(bank, d.maxDailyLossPct))}`)}
      {cell('Max open risk %', 'maxOpenRiskPct', `= ${fmt$(limit$(bank, d.maxOpenRiskPct))}`)}
      {cell('Bad-day cap %', 'cvarPct', `= ${fmt$(pv.cap)}`)}
      {cell('Commission', 'commissionPerContract', '/ct', '0.01', '$')}
      <span className="text-[12.5px] flex items-center gap-2 flex-wrap" style={{ color: C.muted }} data-testid={`risk-preview-${a.id}`}>
        <span>About <b style={{ color: C.text }}>{pv.five}</b> of a 5-wide, <b style={{ color: C.text }}>{pv.twentyFive}</b> of a 25-wide spread.</span>
        {dirty && <button type="button" className={btn} disabled={saving} onClick={() => onSave(a, d)} data-testid={`risk-save-${a.id}`}>Save</button>}
      </span>
    </div>
  );
}

// (5) link the TWS accounts the bridge sees to app accounts
function LinkTws({ summary, health, accounts, onLink, saving }) {
  const ids = [...new Set([...(summary.accounts ? Object.keys(summary.accounts) : []), ...((health.d && health.d.accounts) || [])])];
  if (!ids.length) return <div className="text-[13px]" style={{ color: C.muted }}>{summary.error ? `Account summary: ${summary.error}` : 'The bridge reports no TWS account yet.'}</div>;
  return (
    <div>
      {ids.map(id => {
        const s = summary.accounts && summary.accounts[id];
        const m = matchAccount(id, accounts);
        const explicit = m && String(m.twsAccount || '').toUpperCase() === id.toUpperCase();
        return (
          <div key={id} className="grid gap-3 items-center py-2.5" data-testid={`link-${id}`}
            style={{ gridTemplateColumns: '140px minmax(0,1fr) minmax(0,1fr) minmax(0,1.4fr)', borderTop: `1px solid ${C.border}` }}>
            <span className="mono font-semibold text-[14px]">{id}</span>
            <span className="text-[12.5px] mono" style={{ color: C.muted }}>{/^DU/i.test(id) ? 'paper' : (s && s.accountType ? s.accountType.toLowerCase() : 'live')}{s ? ` · net liq ${fmt$(s.netLiq)}` : ''}</span>
            <select className={input} style={{ maxWidth: 220 }} value={m ? m.id : ''} disabled={saving} data-testid={`link-select-${id}`}
              onChange={e => onLink(id, e.target.value)}>
              <option value="">Not linked</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <span className="text-[12.5px]" style={{ color: m ? C.green : C.amber }}>
              {m ? (explicit ? 'linked' : 'linked (the one paper account)') : 'not linked: no capital card, no buying power cap'}</span>
          </div>
        );
      })}
    </div>
  );
}

// (7) the danger zone: each action names what it does and asks to type a name
function DangerZone({ accounts, onDelete, onRetag, busy }) {
  const [pick, setPick] = useState(accounts[0] ? accounts[0].id : '');
  const [typed, setTyped] = useState('');
  const [note, setNote] = useState('');
  const a = accounts.find(x => x.id === pick);
  const ok = a && typed.trim() === a.name;
  const red = { color: C.red, borderColor: 'color-mix(in srgb, var(--c-f85149) 55%, transparent)' };
  const row = (title, sub, action) => (
    <div className="flex items-center gap-3 py-2.5 flex-wrap" style={{ borderTop: `1px solid ${C.border}` }}>
      <div className="flex-1 min-w-[220px]"><div className="text-[14px] font-semibold">{title}</div><div className="text-[12.5px]" style={{ color: C.muted }}>{sub}</div></div>
      {action}
    </div>
  );
  return (
    <>
      <div className="flex items-center gap-2 flex-wrap mb-1">
        <span className="text-[12.5px]" style={{ color: C.muted }}>Account</span>
        <select className={input} style={{ maxWidth: 200 }} value={pick} onChange={e => { setPick(e.target.value); setTyped(''); }} data-testid="danger-account">
          {accounts.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <input className={input} style={{ maxWidth: 220 }} placeholder={a ? `type "${a.name}" to confirm` : ''} value={typed} onChange={e => setTyped(e.target.value)} data-testid="danger-confirm" />
      </div>
      {row('Delete this account', 'The account, its colour and limits go. Its trades stay in the log under its id.',
        <button type="button" className={btnDanger} style={red} disabled={!ok || busy} data-testid="danger-delete" onClick={() => { onDelete(a.id); setTyped(''); }}>Delete</button>)}
      {row('Re-tag every trade to this account', 'Overwrites the account on every trade in the log. Use once, when moving to one account.',
        <button type="button" className={btnDanger} style={red} disabled={!ok || busy} data-testid="danger-retag" onClick={async () => { setNote(await onRetag(a)); setTyped(''); }}>Re-tag all</button>)}
      {row('Forget the bridge key on this device', 'The bridge then refuses calls from this browser until the key is entered again.',
        <button type="button" className={btnDanger} style={red} data-testid="danger-key" onClick={() => { if (window.confirm('Forget the bridge key on this device?')) { try { localStorage.removeItem('bridgeKey'); } catch (e) { /* private */ } setNote('Bridge key forgotten on this device.'); } }}>Forget key</button>)}
      {row('Clear this device’s caches', 'Daily marks for the position tiles and saved scans, on this browser only. They rebuild.',
        <button type="button" className={btnDanger} style={red} data-testid="danger-caches" onClick={() => { if (window.confirm('Clear the mark log and saved scans on this device?')) { DEVICE_CACHES.forEach(k => { try { localStorage.removeItem(k); } catch (e) { /* private */ } }); setNote('Caches cleared on this device.'); } }}>Clear</button>)}
      {note && <div className="text-[12.5px] mt-2" style={{ color: C.muted }} data-testid="danger-note">{note}</div>}
    </>
  );
}

export default function SettingsPage({ authenticated, onLogin, accounts: accountsIn, onAccountsChange, userEmail }) {
  const accounts = accountsIn || [];
  const [health, refreshHealth] = useBridgeHealth();
  const summary = useAccountSummary(authenticated ? bridgeUrlOf() : '', 60000);
  const [panel, setPanel] = useState(null);          // null | { a } (a null = new)
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');
  const vision = useVisionOn(), glass = useGlassOn();

  const twsOf = useMemo(() => {
    const out = {};
    for (const id of summary.accounts ? Object.keys(summary.accounts) : []) { const m = matchAccount(id, accounts); if (m) out[m.id] = id; }
    return out;
  }, [summary.accounts, accounts]);
  const twsSeen = [...new Set([...(summary.accounts ? Object.keys(summary.accounts) : []), ...((health.d && health.d.accounts) || [])])];

  async function save(updated, msg) {
    setSaving(true); setNote('');
    try {
      await api.saveAccounts(updated);
      invalidateCommissionRates();
      onAccountsChange(await api.getAccounts().catch(() => updated));
      if (msg) setNote(msg);
      return true;
    } catch (e) { setNote('Could not save: ' + e.message); return false; }
    finally { setSaving(false); }
  }
  async function savePanel(f) {
    const a = panel && panel.a;
    const fields = {
      name: f.name.trim(),
      startingBankroll: parseFloat(f.startingBankroll) || (a ? a.startingBankroll : 3000),
      bankrollSince: f.bankrollSince || (a ? '' : todayISO()),
      maxDailyLossPct: pctNum(f.maxDailyLossPct, 20), maxOpenRiskPct: pctNum(f.maxOpenRiskPct, 40),
      commissionPerContract: commNum(f.commissionPerContract, DEFAULT_COMMISSION),
      twsAccount: String(f.twsAccount || '').trim().toUpperCase(),
      cvarPct: pctNum(f.cvarPct, CVAR_TRADE_PCT),
      ...(f.color ? { color: f.color } : {}),
    };
    const updated = a ? accounts.map(x => x.id === a.id ? { ...x, ...fields } : x)
      : [...accounts, { id: fields.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36), bankroll: fields.startingBankroll,
        maxDailyLoss: limit$(fields.startingBankroll, fields.maxDailyLossPct), maxOpenRisk: limit$(fields.startingBankroll, fields.maxOpenRiskPct), ...fields }];
    if (await save(updated, a ? `${fields.name} saved.` : `${fields.name} created.`)) setPanel(null);
  }
  // Starting bankroll set so the live bankroll (start + realised) equals net liq today.
  const useNetLiq = (a, netLiq) => save(accounts.map(x => x.id === a.id ? { ...x, startingBankroll: Math.round(netLiq - (Number(a.realisedPnl) || 0)) } : x),
    `${a.name}'s bankroll set to TWS net liq ${fmt$(netLiq)}.`);
  const saveRisk = (a, d) => save(accounts.map(x => x.id === a.id ? { ...x, maxDailyLossPct: pctNum(d.maxDailyLossPct, 20), maxOpenRiskPct: pctNum(d.maxOpenRiskPct, 40),
    cvarPct: pctNum(d.cvarPct, CVAR_TRADE_PCT), commissionPerContract: commNum(d.commissionPerContract, DEFAULT_COMMISSION) } : x), `${a.name}'s limits saved.`);
  const link = (twsId, appId) => save(accounts.map(x => {
    if (x.id === appId) return { ...x, twsAccount: twsId };
    if (String(x.twsAccount || '').toUpperCase() === twsId.toUpperCase()) return { ...x, twsAccount: '' };
    return x;
  }), appId ? `${twsId} linked.` : `${twsId} unlinked.`);
  const del = id => save(accounts.filter(a => a.id !== id), 'Account deleted. Its trades stay in the log.');
  async function retag(a) {
    setSaving(true);
    try { const r = await api.backfillAccount(a.id, true); return `Re-tagged ${r.updated} trades to ${a.name}.`; }
    catch (e) { return 'Error: ' + e.message; }
    finally { setSaving(false); }
  }

  const needsLook = accounts.filter(a => {
    const s = twsOf[a.id] && summary.accounts ? summary.accounts[twsOf[a.id]] : null;
    const g = s ? bankrollGap(bankrollOf(a), s.netLiq) : null;
    return (!isPaper(a, accounts) && !twsOf[a.id]) || (g && g.flag);
  }).length;
  const conn = { ok: 'bridge connected', warn: 'TWS not connected', err: 'bridge unreachable', off: 'no bridge set' }[health.state] || 'checking…';
  const nav = [
    ['accounts', 'Accounts', `${accounts.length}${needsLook ? ` · ${needsLook} need${needsLook === 1 ? 's' : ''} a look` : ''}`],
    ['risk', 'Risk & sizing', 'per account'],
    ['connection', 'Connection', conn],
    ['health', 'Data health', 'quotes, bars, settles'],
    ['appearance', 'Appearance', vision ? 'Vision' : glass ? 'Glass' : 'Solid'],
    ['data', 'Data', 'Supabase'],
    ['danger', 'Danger zone', ''],
  ];
  const jump = id => { const el = document.getElementById(id); if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div className="fade-in" style={{ maxWidth: 1180 }} data-testid="settings">
      <h2 className="page-title font-display text-2xl font-bold mb-3">Settings</h2>
      {/* (1) contents */}
      <nav className="flex gap-2 flex-wrap mb-5" data-testid="settings-nav" aria-label="Settings sections">
        {nav.map(([id, t, sub]) => (
          <button key={id} type="button" onClick={() => jump(id)} data-testid={`nav-${id}`}
            className="flex flex-col items-start px-3.5 py-2 rounded-2xl text-left hover:bg-bg-hover" style={{ border: `1px solid ${C.border}` }}>
            <span className="text-[14px] font-semibold" style={id === 'danger' ? { color: C.red } : undefined}>{t}</span>
            <span className="text-[11.5px]" style={{ color: id === 'accounts' && needsLook ? C.amber : C.muted }}>{sub || ' '}</span>
          </button>
        ))}
      </nav>
      {note && <div className="text-[13px] mb-4 px-3 py-2 rounded-lg" style={{ color: /^Could not/.test(note) ? C.red : C.green, border: `1px solid ${C.border}` }} data-testid="settings-note">{note}</div>}

      <BridgeStrip health={health} onRefresh={refreshHealth} />

      <Section id="accounts" title="Accounts" sub="one card each: colour, TWS link, bankroll against net liq"
        right={<button type="button" className={btn} onClick={() => setPanel({ a: null })} data-testid="add-account"><Plus size={13} /> Add account</button>}>
        {accounts.length ? (
          <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            {[...accounts].sort((x, y) => Number(isPaper(x, accounts)) - Number(isPaper(y, accounts))).map(a => (
              <AccountCard key={a.id} a={a} accounts={accounts} twsId={twsOf[a.id] || (a.twsAccount || null)}
                s={twsOf[a.id] && summary.accounts ? summary.accounts[twsOf[a.id]] : null}
                onEdit={x => setPanel({ a: x })} onUseNetLiq={useNetLiq} />
            ))}
          </div>
        ) : <p className="text-sm" style={{ color: C.muted }}>No accounts yet. Add one to track trades, sizing and limits per account.</p>}
      </Section>

      <Section id="risk" title="Risk and sizing" sub="percentages of each account's live bankroll, with the dollars beside them">
        {accounts.map(a => <RiskRow key={a.id} a={a} accounts={accounts} onSave={saveRisk} saving={saving} />)}
        <div className="text-[12px] mt-2" style={{ color: C.faint }}>The preview counts the whole max loss as the bad day; the Engine's CVaR is the same or lower, so it may allow more.</div>
      </Section>

      <Section id="connection" title="Connection" sub="the IBKR bridge on your Mac, and which TWS account is which">
        <div className="grid gap-3 mb-4" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
          <label className="flex flex-col gap-1">
            <span className="text-[12px]" style={{ color: C.muted }}>Bridge URL (ngrok)</span>
            <input className={input} type="text" placeholder="https://abc123.ngrok-free.app" data-testid="bridge-url"
              defaultValue={bridgeUrlOf()} onChange={e => { try { localStorage.setItem('bridgeUrl', e.target.value.replace(/\/+$/, '')); } catch (x) { /* private */ } }}
              onBlur={refreshHealth} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[12px]" style={{ color: C.muted }}>Bridge key</span>
            <input className={input} type="password" autoComplete="off" placeholder="printed by bridge/setup-key.sh"
              defaultValue={(() => { try { return localStorage.getItem('bridgeKey') || ''; } catch (e) { return ''; } })()}
              onChange={e => { try { localStorage.setItem('bridgeKey', e.target.value.trim()); } catch (x) { /* private */ } }} onBlur={refreshHealth} />
            <span className="text-[11.5px]" style={{ color: C.faint }}>Sent only to the bridge URL. Without it the bridge refuses calls through ngrok.</span>
          </label>
        </div>
        <div className="text-[13px] font-semibold mb-1">TWS accounts</div>
        <LinkTws summary={summary} health={health} accounts={accounts} onLink={link} saving={saving} />
      </Section>

      <Section id="health" title="Data health" sub="what the engine is reading right now, and anything missing">
        <DataHealthPanel />
      </Section>

      <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <Section id="appearance" title="Appearance">
          <p className="text-[12.5px] mb-3" style={{ color: C.muted }}>Day, Night or Auto for Solid and Glass. Vision puts every page in one glass frame over a soft room and ignores Day/Night.</p>
          <div className="flex flex-col items-start gap-2"><ThemeChoice /><GlassChoice /></div>
        </Section>
        <Section id="data" title="Data">
          <div className="flex items-center gap-2 mb-2 text-[13.5px]">
            <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 5, background: C.green }} />Signed in as {userEmail || '—'}
            <button type="button" onClick={onLogin} className={`${btn} ml-auto`}><LogOut size={12} /> Sign out</button>
          </div>
          <p className="text-[12.5px] mb-3" style={{ color: C.muted }}>Stored in Supabase (schema <span className="mono">options</span>). The old Google Sheet is a frozen archive.</p>
          <BackfillUntagged accounts={accounts} />
        </Section>
      </div>

      <Section id="danger" title="Danger zone" sub="pick the account and type its name to unlock" danger>
        {accounts.length ? <DangerZone accounts={accounts} onDelete={del} onRetag={retag} busy={saving} />
          : <div className="text-[13px]" style={{ color: C.muted }}>No accounts.</div>}
      </Section>

      {panel && <AccountPanel a={panel.a} accounts={accounts} twsSeen={twsSeen} saving={saving} onClose={() => setPanel(null)} onSave={savePanel} />}
    </div>
  );
}

// Tag trades that have no account to one (safe: never overwrites a tag).
function BackfillUntagged({ accounts }) {
  const [pick, setPick] = useState(accounts[0] ? accounts[0].id : '');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  if (!accounts.length) return null;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[12.5px]" style={{ color: C.muted }}>Tag untagged trades to</span>
      <select className={input} style={{ maxWidth: 180 }} value={pick} onChange={e => setPick(e.target.value)}>
        {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
      <button type="button" className={btn} disabled={busy} onClick={async () => {
        setBusy(true); setMsg('');
        try { const r = await api.backfillAccount(pick); setMsg(`Tagged ${r.updated} untagged trades.`); }
        catch (e) { setMsg('Error: ' + e.message); }
        setBusy(false);
      }}>{busy ? '…' : 'Tag'}</button>
      {msg && <span className="text-[12px]" style={{ color: /^Error/.test(msg) ? C.red : C.green }}>{msg}</span>}
    </div>
  );
}
