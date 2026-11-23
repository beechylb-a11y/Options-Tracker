import React, { useEffect, useState } from 'react';
import { accountColor, accountName } from '../utils/accountColors';
import { isAggExcluded } from '../utils/stats';
import {
  bpBand, bpUsedPct, bpStatus, cushionPct, cushionTone, matchAccount, bankrollOf, bankrollGap,
  positionCapital, BP_LADDER,
} from '../utils/capital';

// Capital and buying power (Nov 2026): per account, what TWS says it is worth, how
// much buying power is tied up against a band that moves with VIX, the cushion
// before a margin call, and each open position's buying power and return on it.
// Paper accounts are shown but not added into anything.

const C = { text: 'var(--c-e6edf3)', muted: 'var(--c-8b949e)', faint: 'var(--c-6e7681)', border: 'var(--c-30363d)',
  green: 'var(--c-3fb950)', red: 'var(--c-f85149)', amber: 'var(--c-d29922)', track: 'var(--c-21262d)' };
const TONE = { red: C.red, amber: C.amber, green: C.green };
const STATUS = {
  low: { tone: null, word: 'room to add' },
  ok: { tone: 'green', word: 'in the band' },
  over: { tone: 'amber', word: 'over the band: new trades size down' },
  high: { tone: 'red', word: 'well over: no new undefined risk' },
};
const usd = v => (v == null || !Number.isFinite(v) ? '—' : '$' + Math.round(v).toLocaleString());
const pct = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(dp) + '%');
const sgnPct = v => (v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(1) + '%');
const SCALE = 60; // the bar runs 0–60% of net liq

function headers() { return { 'ngrok-skip-browser-warning': '1' }; }

export function useAccountSummary(bridgeUrl, everyMs = 60000) {
  const [state, setState] = useState({ accounts: null, error: null, at: null });
  useEffect(() => {
    if (!bridgeUrl) return undefined;
    let dead = false;
    const pull = async (fresh) => {
      try {
        const r = await fetch(bridgeUrl + '/api/account-summary' + (fresh ? '?fresh=1' : ''), { headers: headers() });
        const txt = await r.text();
        let j; try { j = JSON.parse(txt); } catch (e) { j = { error: txt.trim().startsWith('<') ? 'bridge has no account summary yet — pull and restart the bridge' : txt.slice(0, 120) }; }
        if (!dead) setState(j.error ? s => ({ ...s, error: j.error }) : { accounts: j.accounts || {}, error: null, at: j.at || null });
      } catch (e) { if (!dead) setState(s => ({ ...s, error: e.message })); }
    };
    pull(true);
    const id = setInterval(() => pull(false), everyMs);
    return () => { dead = true; clearInterval(id); };
  }, [bridgeUrl, everyMs]);
  return state;
}

function BpBar({ used, band, colour }) {
  const w = x => Math.max(0, Math.min(100, (x / SCALE) * 100));
  return (
    <div>
      <div className="relative" style={{ height: 12, borderRadius: 6, background: C.track }} role="img"
        aria-label={`Buying power in use ${pct(used)} of net liq, target ${band.lo} to ${band.hi}%`}>
        <div className="absolute" style={{ left: w(band.lo) + '%', width: (w(band.hi) - w(band.lo)) + '%', top: -4, bottom: -4, borderRadius: 6,
          border: `1px dashed ${C.green}`, background: 'color-mix(in srgb, var(--c-3fb950) 16%, transparent)' }} />
        <div className="absolute" style={{ left: 0, top: 0, bottom: 0, width: w(used || 0) + '%', borderRadius: 6, background: colour }} />
      </div>
      <div className="flex justify-between mt-1.5 text-[11.5px] mono" style={{ color: C.faint }}>
        <span>0%</span>
        <span style={{ color: C.green }}>target {band.lo}–{band.hi}%{band.vix ? ` at VIX ${band.vix.toFixed(1)}` : ' (no VIX yet)'}</span>
        <span>{SCALE}%</span>
      </div>
    </div>
  );
}

export function AccountCapitalCard({ twsId, s, account, accounts, band }) {
  const paper = account ? isAggExcluded(account.id, accounts) : !!s.paper;
  const colour = account ? accountColor(account.id, accounts) : C.muted;
  const used = bpUsedPct(s);
  const status = bpStatus(used, band);
  const st = status ? STATUS[status] : null;
  const useCol = st && st.tone ? TONE[st.tone] : colour;
  const cush = cushionPct(s);
  const bank = bankrollOf(account);
  const gap = bankrollGap(bank, s.netLiq);
  return (
    <div className="card" data-testid={`capital-${twsId}`} style={{ opacity: paper ? 0.75 : 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="flex items-center gap-2 text-[13px]">
        <span aria-hidden="true" style={{ width: 9, height: 9, borderRadius: 5, background: colour }} />
        <span style={{ color: colour, fontWeight: 600 }}>{account ? account.name : twsId}</span>
        <span className="mono" style={{ color: C.faint }}>{twsId}</span>
        <span className="ml-auto text-[12px]" style={{ color: C.faint }}>{paper ? 'paper · shown, not in totals' : 'real money'}</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="mono" style={{ fontSize: 30, fontWeight: 600, color: C.text }}>{usd(s.netLiq)}</span>
        <span className="text-[13px]" style={{ color: C.muted }}>net liq</span>
      </div>
      <div className="grid gap-2 text-[12.5px]" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', color: C.muted }}>
        <div><div className="mono" style={{ fontSize: 16, fontWeight: 600, color: C.text }}>{usd(s.availableFunds)}</div>available for options</div>
        <div><div className="mono" style={{ fontSize: 16, fontWeight: 600, color: TONE[cushionTone(cush)] || C.text }}>{usd(s.excessLiquidity)}</div>excess liquidity · {pct(cush)} cushion</div>
        <div><div className="mono" style={{ fontSize: 16, fontWeight: 600, color: C.text }}>{s.leverage != null ? s.leverage.toFixed(2) + '×' : '—'}</div>leverage (gross ÷ net liq)</div>
      </div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[14px] font-semibold" style={{ color: C.text }}>Buying power in use</span>
        <span className="mono" style={{ fontSize: 21, fontWeight: 600, color: useCol }} data-testid={`bp-used-${twsId}`}>{pct(used, used != null && used < 1 ? 1 : 0)}</span>
        <span className="text-[12.5px]" style={{ color: C.muted }}>of net liq{st ? ` · ${st.word}` : ''}</span>
      </div>
      <BpBar used={used} band={band} colour={useCol} />
      <div className="text-[12.5px]" style={{ color: gap && gap.flag ? C.amber : C.muted }} data-testid={`bank-gap-${twsId}`}>
        {!account
          ? <>Not linked to an app account: set "TWS account" to {twsId} in Settings › Accounts.</>
          : bank == null ? <>No bankroll set for {account.name}.</>
            : paper && gap && gap.flag ? <>Sizing bankroll {usd(bank)} (Settings) · paper net liq isn't the bankroll you size with.</>
              : gap && gap.flag ? <>Sizing bankroll {usd(bank)} (Settings) · net liq is {Math.abs(gap.pct).toFixed(0)}% {gap.pct > 0 ? 'above' : 'below'} it: update the bankroll so sizing matches.</>
                : <>Sizing bankroll {usd(bank)} (Settings) · in step with net liq.</>}
      </div>
    </div>
  );
}

export function PositionCapitalTable({ rows, accounts }) {
  if (!rows.length) return null;
  const th = 'text-[12px] font-medium pb-2 px-2';
  return (
    <div className="card" data-testid="capital-positions">
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <h4 className="text-[15px] font-medium" style={{ color: C.text }}>Where the buying power is</h4>
        <span className="text-[12px]" style={{ color: C.faint }}>buying power = max loss of the contracts still open</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
          <thead><tr style={{ color: C.faint }}>
            <th className={th + ' text-left'}>Position</th><th className={th + ' text-left'}>Account</th>
            <th className={th + ' text-right'}>Buying power</th><th className={th + ' text-right'}>% net liq</th>
            <th className={th + ' text-right'}>Max return on it</th><th className={th + ' text-right'}>Now</th>
            <th className={th + ' text-right'}>Annualised (max)</th>
          </tr></thead>
          <tbody>
            {rows.map(({ p, c }) => (
              <tr key={p.key} style={{ borderTop: `1px solid ${C.border}` }}>
                <td className="px-2 py-2"><span className="font-semibold" style={{ color: C.text }}>{p.underlying}</span> <span style={{ color: C.muted }}>{p.strategy}</span>
                  <div className="text-[11.5px] mono" style={{ color: C.faint }}>{p.live} ct{p.expiry ? ` · ${c.days} d` : ''}</div></td>
                <td className="px-2 py-2"><span className="inline-flex items-center gap-1.5" style={{ color: accountColor(p.row.account, accounts) }}>
                  <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 4, background: accountColor(p.row.account, accounts) }} />{accountName(p.row.account, accounts) || '—'}</span></td>
                <td className="px-2 py-2 text-right mono">{usd(c.bpr)}</td>
                <td className="px-2 py-2 text-right mono">{pct(c.pctNetLiq, 1)}</td>
                <td className="px-2 py-2 text-right mono">{c.maxRet != null ? pct(c.maxRet * 100) : c.credit ? '—' : 'debit'}</td>
                <td className="px-2 py-2 text-right mono" style={{ color: c.nowRet == null ? C.muted : c.nowRet >= 0 ? C.green : C.red }}>{sgnPct(c.nowRet)}</td>
                <td className="px-2 py-2 text-right mono">{c.annualMax != null ? pct(c.annualMax * 100) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[12px] mt-2" style={{ color: C.faint }}>Return on buying power = P&amp;L ÷ buying power held. Annualised = max return × 365 ÷ days from entry to expiry (simple, not compounded), so 0DTE and 45-day trades compare on one scale.</div>
    </div>
  );
}

// summary: { accounts, error } from useAccountSummary (passed in so tests can feed it)
export default function CapitalPanel({ summary, accounts = [], book = [], risks = {}, vix, account }) {
  const band = bpBand(vix);
  if (summary.error && !summary.accounts) {
    return <div className="text-[13px]" style={{ color: C.amber }} data-testid="capital-error">Account summary: {summary.error}</div>;
  }
  if (!summary.accounts) return <div className="text-[13px]" style={{ color: C.muted }}>Asking TWS for net liq and buying power…</div>;
  const all = Object.entries(summary.accounts).map(([twsId, s]) => ({ twsId, s, acct: matchAccount(twsId, accounts) }));
  const picked = !account || account === 'all' ? all : all.filter(x => x.acct && x.acct.id === account);
  // Real accounts first, paper last.
  picked.sort((a, b) => Number(!!(a.acct ? isAggExcluded(a.acct.id, accounts) : a.s.paper)) - Number(!!(b.acct ? isAggExcluded(b.acct.id, accounts) : b.s.paper)));
  const netLiqOf = appId => { const m = all.find(x => x.acct && x.acct.id === appId); return m ? m.s.netLiq : null; };
  const rows = book
    .filter(p => p.live > 0 && (!account || account === 'all' || p.row.account === account))
    .map(p => ({ p, c: positionCapital(p, risks[p.key], netLiqOf(p.row.account)) }))
    .filter(x => x.c)
    .sort((a, b) => b.c.bpr - a.c.bpr);
  return (
    <div data-testid="capital-panel" className="space-y-4">
      {picked.length === 0
        ? <div className="text-[13px]" style={{ color: C.muted }}>TWS reports no account linked to this one. Set its "TWS account" in Settings › Accounts.</div>
        : <div className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))' }}>
          {picked.map(x => <AccountCapitalCard key={x.twsId} twsId={x.twsId} s={x.s} account={x.acct} accounts={accounts} band={band} />)}
        </div>}
      <PositionCapitalTable rows={rows} accounts={accounts} />
      <div className="text-[12px]" style={{ color: C.faint }} data-testid="bp-ladder">
        Target in use by VIX: {BP_LADDER.map((r, i) => {
          const on = band.vix != null && band.vix >= r.from && band.vix < r.upTo;
          const label = r.upTo === Infinity ? `${r.from}+` : r.from ? `${r.from}–${r.upTo}` : `under ${r.upTo}`;
          return <span key={i} style={on ? { color: C.green, fontWeight: 600 } : undefined}>{i ? ' · ' : ''}{label}: {r.pct}%</span>;
        })}. Over the band, new trades size down; past 1.5× the target, no new undefined risk.
      </div>
      {summary.error && <div className="text-[12px]" style={{ color: C.amber }}>Last refresh failed: {summary.error}</div>}
    </div>
  );
}
