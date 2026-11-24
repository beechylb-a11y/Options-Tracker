import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

afterEach(cleanup);
import { bundleOf, runningBundle, liveBundle, isNewer } from '../utils/newVersion';
import NewVersionBanner from '../components/NewVersionBanner';

const html = js => `<!doctype html><html><head><script type="module" crossorigin src="${js}"></script></head><body><div id="root"></div></body></html>`;
function docWith(src) {
  const d = document.implementation.createHTMLDocument('t');
  if (src) { const s = d.createElement('script'); s.setAttribute('src', src); d.head.appendChild(s); }
  return d;
}
const fetchServing = js => vi.fn(async () => ({ ok: true, text: async () => html(js) }));

describe('new version check', () => {
  it('finds the entry bundle in HTML and in a script src', () => {
    expect(bundleOf(html('/assets/index-Cc1CPGWw.js'))).toBe('/assets/index-Cc1CPGWw.js');
    expect(bundleOf('/assets/vendor-x.js')).toBe(null);
    expect(runningBundle(docWith('/assets/index-AAA_1.js'))).toBe('/assets/index-AAA_1.js');
  });

  it('dev build (no bundle) never reports a new version', () => {
    expect(runningBundle(docWith('/src/main.jsx'))).toBe(null);
    expect(isNewer(null, '/assets/index-B.js')).toBe(false);
  });

  it('asks the server without the cache', async () => {
    const f = fetchServing('/assets/index-NEW.js');
    expect(await liveBundle(f)).toBe('/assets/index-NEW.js');
    expect(f.mock.calls[0][0]).toMatch(/^\/\?_v=\d+$/);
    expect(f.mock.calls[0][1].cache).toBe('no-store');
  });

  it('a failed fetch is no news', async () => {
    expect(await liveBundle(vi.fn(async () => ({ ok: false })))).toBe(null);
  });
});

describe('NewVersionBanner', () => {
  it('stays hidden while the tab runs the live build', async () => {
    const f = fetchServing('/assets/index-SAME.js');
    render(<NewVersionBanner authenticated fetchImpl={f} doc={docWith('/assets/index-SAME.js')} />);
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(screen.queryByTestId('new-version-banner')).toBeNull();
  });

  it('shows when the server has a newer build, and Reload reloads', async () => {
    const onReload = vi.fn();
    render(<NewVersionBanner authenticated fetchImpl={fetchServing('/assets/index-NEW.js')} doc={docWith('/assets/index-OLD.js')} onReload={onReload} />);
    expect(await screen.findByTestId('new-version-banner')).toBeTruthy();
    expect(screen.getByText(/Reload before you log/)).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-version-reload'));
    expect(onReload).toHaveBeenCalled();
  });

  it('× hides it for that version', async () => {
    render(<NewVersionBanner authenticated fetchImpl={fetchServing('/assets/index-NEW.js')} doc={docWith('/assets/index-OLD.js')} />);
    fireEvent.click(await screen.findByLabelText('Hide until the next version'));
    expect(screen.queryByTestId('new-version-banner')).toBeNull();
  });

  it('does nothing before login', async () => {
    const f = fetchServing('/assets/index-NEW.js');
    render(<NewVersionBanner authenticated={false} fetchImpl={f} doc={docWith('/assets/index-OLD.js')} />);
    expect(f).not.toHaveBeenCalled();
  });
});
