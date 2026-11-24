import React, { useState } from 'react';
import { useNewVersion } from '../utils/newVersion';

// "A new version is live" (Nov 2026): shows when the server serves a newer build than
// this tab is running. Reload picks it up; × hides it until an even newer one ships.
const T = { fg: 'var(--c-58a6ff)', bd: 'var(--c-1f6feb)', bg: 'color-mix(in srgb, var(--c-58a6ff) 12%, transparent)' };

export default function NewVersionBanner({ authenticated, wrapClass, intervalMs, fetchImpl, doc, onReload }) {
  const { stale, live } = useNewVersion({ enabled: !!authenticated, intervalMs, fetchImpl, doc });
  const [hiddenFor, setHiddenFor] = useState(null);
  if (!stale || hiddenFor === live) return null;
  const reload = onReload || (() => window.location.reload());
  const banner = (
    <div role="status" data-testid="new-version-banner" className="flex items-center gap-3 flex-wrap px-4 py-2.5 rounded-xl mx-1 mb-3"
      style={{ border: `1px solid ${T.bd}`, background: T.bg, boxShadow: `inset 4px 0 0 ${T.fg}` }}>
      <span aria-hidden="true" style={{ color: T.fg, fontSize: 18 }}>↻</span>
      <div className="flex flex-col flex-1 min-w-0">
        <span className="text-[14px] font-semibold" style={{ color: 'var(--c-e6edf3)' }}>A new version of Shadowbook is live</span>
        <span className="text-[12.5px]" style={{ color: 'var(--c-a8b2be)' }}>This tab is still running the old one, so a trade logged here goes through the old engine. Reload before you log.</span>
      </div>
      <button type="button" onClick={reload} data-testid="new-version-reload"
        className="text-[13px] font-semibold px-3 py-1.5 rounded-full" style={{ color: '#0d1117', background: T.fg, minHeight: 32 }}>Reload now</button>
      <button type="button" aria-label="Hide until the next version" onClick={() => setHiddenFor(live)}
        className="text-[16px]" style={{ color: 'var(--c-8b949e)' }}>×</button>
    </div>
  );
  return wrapClass ? <div className={wrapClass}>{banner}</div> : banner;
}
