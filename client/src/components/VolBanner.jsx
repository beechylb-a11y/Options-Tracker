import React, { useState } from 'react';
import { useVolWatch } from '../live/useVolWatch';

// The volatility banner (Nov 2026): shows only when the watch trips — VIX jumping,
// VIX above VIX3M, the book's vega losing real money, or an open trade's IV moving
// hard against it. Amber = watch, red = act. Dismissed until it gets worse.
const TONE = { amber: { fg: 'var(--c-e3b341)', bd: 'var(--c-9e6a03)', bg: 'color-mix(in srgb, var(--c-d29922) 12%, transparent)' },
  red: { fg: 'var(--c-f85149)', bd: 'var(--c-6e2427)', bg: 'color-mix(in srgb, var(--c-f85149) 12%, transparent)' } };
const $ = v => (v < 0 ? '−$' : '$') + Math.abs(Math.round(v)).toLocaleString();

export function volHeadline(w) {
  const m = w.market, b = w.book;
  if (m.tone && m.vix > 0) {
    return `Volatility is moving: VIX ${m.vixClose ? m.vixClose.toFixed(1) + ' → ' : ''}${m.vix.toFixed(1)}${m.pct != null ? ` (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(0)}%)` : ''} since the close${m.vix1d ? ` · VIX1D ${m.vix1d.toFixed(1)}` : ''}`;
  }
  if (b.flagged.length) return `${b.flagged.length} open position${b.flagged.length === 1 ? ' has' : 's have'} IV moving against ${b.flagged.length === 1 ? 'it' : 'them'}`;
  return b.reasons[0] ? b.reasons[0][0].toUpperCase() + b.reasons[0].slice(1) : 'Volatility watch';
}
export function volDetail(w) {
  const m = w.market, b = w.book, parts = [];
  if (m.term != null) parts.push(`VIX ÷ VIX3M ${m.term.toFixed(2)}${m.term >= 1 ? ' (backwardation)' : ''}`);
  if (b.n) parts.push(`book vega ${$(b.vega)} per IV point`);
  if (b.today != null && Math.abs(b.today) >= 1) parts.push(`the VIX move ≈ ${$(b.today)} today`);
  if (b.flagged.length) parts.push(b.flagged.slice(0, 3).map(x => `${x.underlying} ${x.dIv != null ? (x.dIv >= 0 ? '+' : '') + x.dIv.toFixed(1) + ' IV' : x.reasons[0] || ''}`).join(', '));
  return parts.join(' · ');
}

export default function VolBanner({ authenticated, account, onOpenRisk, wrapClass }) {
  const w = useVolWatch(account, { enabled: !!authenticated });
  const tone = w.book.tone;
  const sig = tone ? `${tone}|${w.book.flagged.length}` : '';
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem('sb.volbanner.hide') || ''; } catch (e) { return ''; } });
  if (!tone) return null;
  // Dismissed: stays hidden until the tone or the count gets worse.
  if (hidden) {
    const [ht, hn] = hidden.split('|');
    if (!(tone === 'red' && ht !== 'red') && !(Number(w.book.flagged.length) > Number(hn))) return null;
  }
  const t = TONE[tone];
  const banner = (
    <div role="status" data-testid="vol-banner" data-tone={tone} className="flex items-center gap-3 flex-wrap px-4 py-2.5 rounded-xl mx-1 mb-3"
      style={{ border: `1px solid ${t.bd}`, background: t.bg, boxShadow: `inset 4px 0 0 ${t.fg}` }}>
      <span aria-hidden="true" style={{ color: t.fg, fontSize: 18 }}>◐</span>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--c-e6edf3)' }} data-testid="vol-headline">{volHeadline(w)}</span>
        <span className="text-[12.5px]" style={{ color: 'var(--c-a8b2be)' }}>{volDetail(w)}</span>
      </div>
      <span className="text-[12px] font-bold px-2.5 py-0.5 rounded-full" style={{ color: '#24221f', background: t.fg }}>{tone === 'red' ? 'Red · act' : 'Amber · watch'}</span>
      {onOpenRisk && <button type="button" onClick={onOpenRisk} className="text-[13px] underline" style={{ color: 'var(--c-58a6ff)' }} data-testid="vol-details">Details</button>}
      <button type="button" aria-label="Hide until it gets worse" onClick={() => { try { sessionStorage.setItem('sb.volbanner.hide', sig); } catch (e) { /* private */ } setHidden(sig); }}
        className="text-[16px]" style={{ color: 'var(--c-8b949e)' }}>×</button>
    </div>
  );
  return wrapClass ? <div className={wrapClass}>{banner}</div> : banner;
}
