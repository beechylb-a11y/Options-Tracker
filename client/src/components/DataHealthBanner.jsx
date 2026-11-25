import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuotesEvery } from '../live/streamQuotes';
import { quoteHealth, bannerIssues } from '../utils/dataHealth';

// Data banner (Nov 2026): in the session only, when a streamed underlying has been off,
// blocked, delayed or quiet past the bridge watchdog's 5 minutes for two minutes running.
// Names the lines and what is wrong, so a ticket isn't priced off a dead line unnoticed.
// Bridge-down and TWS-down are the header's job, not this banner's.

export const HOLD_MS = 2 * 60000;
const T = { fg: 'var(--c-e3b341)', bd: 'var(--c-9e6a03)', bg: 'color-mix(in srgb, var(--c-d29922) 12%, transparent)' };
const R = { fg: 'var(--c-f85149)', bd: 'var(--c-6e2427)', bg: 'color-mix(in srgb, var(--c-f85149) 12%, transparent)' };

/** Issues seen continuously for HOLD_MS. `seen` is mutated: key → first seen ms. */
export function heldIssues(issues, seen, now) {
  const keys = new Set(issues.map(i => i.key));
  for (const k of Object.keys(seen)) if (!keys.has(k)) delete seen[k];
  for (const i of issues) if (!seen[i.key]) seen[i.key] = now;
  return issues.filter(i => now - seen[i.key] >= HOLD_MS);
}

export default function DataHealthBanner({ authenticated, onOpen, wrapClass, now: nowProp }) {
  const state = useLiveQuotesEvery(5000);
  const [, setTick] = useState(0);
  useEffect(() => { if (nowProp) return undefined; const id = setInterval(() => setTick(t => t + 1), 30000); return () => clearInterval(id); }, [nowProp]);
  const seen = useRef({});
  const [hidden, setHidden] = useState(() => { try { return sessionStorage.getItem('sb.databanner.hide') || ''; } catch (e) { return ''; } });
  if (!authenticated) return null;
  const now = nowProp || Date.now();
  const q = quoteHealth(state, { now });
  const list = nowProp ? bannerIssues(q) : heldIssues(bannerIssues(q), seen.current, now);
  if (!list.length) return null;
  const sig = list.map(i => `${i.key}:${i.state}`).sort().join(',');
  if (hidden === sig) return null;
  const bad = list.some(i => i.tone === 'bad');
  const t = bad ? R : T;
  const head = list.length === 1 ? `${list[0].key}: ${list[0].note}` : `${list.length} data lines need a look: ${list.map(i => i.key).join(', ')}`;
  const banner = (
    <div role="status" data-testid="data-banner" data-tone={bad ? 'bad' : 'warn'} className="flex items-center gap-3 flex-wrap px-4 py-2.5 rounded-xl mx-1 mb-3"
      style={{ border: `1px solid ${t.bd}`, background: t.bg, boxShadow: `inset 4px 0 0 ${t.fg}` }}>
      <span aria-hidden="true" style={{ color: t.fg, fontSize: 16 }}>◍</span>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--c-e6edf3)' }} data-testid="data-banner-head">{head}</span>
        <span className="text-[12.5px]" style={{ color: 'var(--c-a8b2be)' }}>
          {list.length > 1 ? list.map(i => `${i.key} ${i.note}`).join(' · ') + ' — ' : ''}tickets and scans on {list.length === 1 ? 'it' : 'these'} read old or missing numbers.
        </span>
      </div>
      {onOpen && <button type="button" onClick={onOpen} className="text-[13px] underline" style={{ color: 'var(--c-58a6ff)' }} data-testid="data-banner-open">Data health</button>}
      <button type="button" aria-label="Hide until it changes" onClick={() => { try { sessionStorage.setItem('sb.databanner.hide', sig); } catch (e) { /* private */ } setHidden(sig); }}
        className="text-[16px]" style={{ color: 'var(--c-8b949e)' }}>×</button>
    </div>
  );
  return wrapClass ? <div className={wrapClass}>{banner}</div> : banner;
}
