// Bridge key (Nov 2026). The bridge now refuses requests that come through ngrok
// without `X-Bridge-Key`. Rather than touch the ~35 fetch() calls that talk to the
// bridge, wrap fetch once: any request whose URL starts with the Bridge URL from
// Settings gets the key from Settings added. Nothing else is touched, so the key
// never goes to the app's own server or anywhere else.
export function withBridgeKey(input, init, store) {
  const base = (store.getItem('bridgeUrl') || '').replace(/\/+$/, '');
  const key = store.getItem('bridgeKey') || '';
  const url = typeof input === 'string' ? input : (input && input.url) || '';
  if (!base || !key || !(url === base || url.startsWith(base + '/'))) return init;
  const headers = new Headers((init && init.headers) || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined));
  headers.set('X-Bridge-Key', key);
  return { ...(init || {}), headers };
}

export function installBridgeAuth() {
  if (typeof window === 'undefined' || window.__bridgeAuthInstalled) return;
  window.__bridgeAuthInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    let next = init;
    try { next = withBridgeKey(input, init, window.localStorage); } catch { /* storage blocked: send as is */ }
    return original(input, next);
  };
}
