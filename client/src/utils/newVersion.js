// New version check (Nov 2026). A tab opened before a deploy keeps running the old
// bundle until it is reloaded, so trades logged from it go through the old engine
// (24 Nov: three trades logged after e0d7ad4 went live carried no Engine line).
// The page asks the server which bundle index.html now points at and compares it
// with the one this tab loaded. In dev (no built bundle) it never reports a change.
import { useEffect, useState } from 'react';

const BUNDLE = /\/assets\/index-[A-Za-z0-9_-]+\.js/;

/** The built entry bundle named in a piece of HTML or a script src, or null. */
export function bundleOf(text) {
  const m = String(text || '').match(BUNDLE);
  return m ? m[0] : null;
}

/** The entry bundle this tab is running. */
export function runningBundle(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  for (const s of doc.querySelectorAll('script[src]')) {
    const b = bundleOf(s.getAttribute('src'));
    if (b) return b;
  }
  return null;
}

/** The entry bundle the server is serving now (index.html, never from cache). */
export async function liveBundle(fetchImpl = fetch) {
  const r = await fetchImpl(`/?_v=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
  if (!r || !r.ok) return null;
  return bundleOf(await r.text());
}

/** Is there a newer version than the one this tab runs? */
export function isNewer(running, live) {
  return !!(running && live && running !== live);
}

/**
 * Checks every intervalMs and whenever the tab comes back into view.
 * Returns { stale, live }: stale once the server serves a different bundle.
 */
export function useNewVersion({ enabled = true, intervalMs = 5 * 60 * 1000, fetchImpl, doc } = {}) {
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const running = runningBundle(doc);
    if (!running) return undefined;
    let stop = false;
    const check = async () => {
      try {
        const b = await liveBundle(fetchImpl || fetch);
        if (!stop && b) setLive(b);
      } catch (e) { /* offline or server restarting: try again next time */ }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    const t = setInterval(check, intervalMs);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', check);
    return () => {
      stop = true;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', check);
    };
  }, [enabled, intervalMs, fetchImpl, doc]);
  return { stale: isNewer(runningBundle(doc), live), live };
}
