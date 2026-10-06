const BASE = '';

// ── Auth: the Supabase access token is attached to every server call. ──
// App.jsx keeps it current (sign-in, silent refresh, sign-out).
let accessToken = null;
let onUnauthorized = null;
export function setAccessToken(t) { accessToken = t || null; }
export function setOnUnauthorized(fn) { onUnauthorized = fn; }
function authHeaders() {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}
function check401(res) {
  if (res.status === 401 && onUnauthorized) onUnauthorized();
  return res;
}

// ── Lightweight GET cache: in-flight request dedupe + 30s TTL ──
const GET_TTL_MS = 30 * 1000;
const getCache = new Map();   // url -> { time, data }
const inflight = new Map();   // url -> Promise

export function clearApiCache() {
  getCache.clear();
  inflight.clear();
}

function fetchJSON(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    // Mutations invalidate all cached GETs
    clearApiCache();
    return doFetchJSON(url, opts);
  }
  const hit = getCache.get(url);
  if (hit && Date.now() - hit.time < GET_TTL_MS) return Promise.resolve(hit.data);
  if (inflight.has(url)) return inflight.get(url);
  const p = doFetchJSON(url, opts)
    .then(data => {
      getCache.set(url, { time: Date.now(), data });
      inflight.delete(url);
      return data;
    })
    .catch(err => {
      inflight.delete(url);
      throw err;
    });
  inflight.set(url, p);
  return p;
}

async function doFetchJSON(url, opts = {}) {
  const res = check401(await fetch(`${BASE}${url}`, {
    credentials: 'include',
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...opts.headers }
  }));
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Auth
  authStatus: () => fetchJSON('/auth/status'),
  authConfig: () => fetch(`${BASE}/auth/config`).then(r => r.json()),

  // Config
  getConfig: () => fetchJSON('/api/config'),
  updateConfig: (key, value) => fetchJSON(`/api/config/${key}`, {
    method: 'PUT', body: JSON.stringify({ value })
  }),
  getAccounts: () => fetchJSON('/api/accounts'),
  saveAccounts: (accounts) => fetchJSON('/api/accounts', {
    method: 'PUT', body: JSON.stringify({ accounts })
  }),
  backfillAccount: (accountId, force) => fetchJSON('/api/accounts/backfill', {
    method: 'PUT', body: JSON.stringify({ accountId, force: !!force })
  }),

  // CSV upload
  uploadCSV: (file, account) => {
    const form = new FormData();
    form.append('file', file);
    if (account) form.append('account', account);
    clearApiCache();
    return fetch(`${BASE}/api/upload-csv`, {
      method: 'POST', credentials: 'include', headers: authHeaders(), body: form
    }).then(r => r.json());
  },
  compareCSV: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${BASE}/api/compare-csv`, {
      method: 'POST', credentials: 'include', headers: authHeaders(), body: form
    }).then(r => r.json());
  },

  // Trades
  getTrades: () => fetchJSON('/api/trades'),
  getTracker: () => fetchJSON('/api/tracker'),
  getCloses: () => fetchJSON('/api/closes'),
  getStrategyHistory: (account) => fetchJSON(`/api/strategy-history${account && account !== 'all' ? '?account=' + account : ''}`),
  getCaptureStats: (account) => fetchJSON(`/api/capture-stats${account && account !== 'all' ? '?account=' + account : ''}`),
  updateTrade: (rowIndex, updates) => fetchJSON(`/api/tracker/${rowIndex}`, {
    method: 'PUT', body: JSON.stringify(updates)
  }),
  closeTrade: (rowIndex, data) => fetchJSON(`/api/tracker/${rowIndex}/close`, {
    method: 'PUT', body: JSON.stringify(data)
  }),
  reconcile: (fills) => fetchJSON('/api/reconcile', {
    method: 'POST', body: JSON.stringify({ fills })
  }),
  deleteTrade: (rowIndex) => fetchJSON(`/api/tracker/${rowIndex}`, {
    method: 'DELETE'
  }),

  // Stats
  getStats: (account) => fetchJSON(`/api/stats${account && account !== 'all' ? '?account=' + account : ''}`),
  getPerformance: (account) => fetchJSON(`/api/performance${account && account !== 'all' ? '?account=' + account : ''}`),

  // Trade log (opens), sale log (tranches), open positions
  getTradeLog: () => fetchJSON('/api/tradelog'),
  rebuildTradeLog: () => fetchJSON('/api/tradelog/rebuild', { method: 'POST' }),
  getCloses: (account) => fetchJSON(`/api/closes${account && account !== 'all' ? '?account=' + account : ''}`),
  getOpenPositions: (account) => fetchJSON(`/api/positions/open${account && account !== 'all' ? '?account=' + account : ''}`),

  // Decisions
  logDecision: (data) => fetchJSON('/api/decisions', {
    method: 'POST', body: JSON.stringify(data)
  }),
  getDecisions: () => fetchJSON('/api/decisions'),

  // Comparison
  getComparison: () => fetchJSON('/api/comparison'),

  // Uncategorised trades
  getUncategorised: () => fetchJSON('/api/uncategorised'),
  categoriseTrade: (rowIndex, strategy, orderId) => fetchJSON(`/api/categorise/${rowIndex}`, {
    method: 'PUT', body: JSON.stringify({ strategy, orderId })
  }),

  // Trade ticket lifecycle
  closeTicket: (rowIndex, data) => fetchJSON(`/api/decisions/${rowIndex}/close`, {
    method: 'PUT', body: JSON.stringify(data)
  }),
  backfillTicketVol: (rowIndex, snap) => fetchJSON(`/api/decisions/${rowIndex}/vol`, {
    method: 'PUT', body: JSON.stringify(snap)
  }),
  updateTicketNotes: (rowIndex, notes) => fetchJSON(`/api/decisions/${rowIndex}/notes`, {
    method: 'PUT', body: JSON.stringify({ notes })
  }),
  updateTicketStatus: (rowIndex, status) => fetchJSON(`/api/decisions/${rowIndex}/status`, {
    method: 'PUT', body: JSON.stringify({ status })
  }),

  // Journal
  getJournal: () => fetchJSON('/api/journal'),
  addJournalEntry: (entry) => fetchJSON('/api/journal', {
    method: 'POST', body: JSON.stringify(entry)
  }),

  // Documents
  uploadDocument: (file, metadata) => {
    const form = new FormData();
    form.append('file', file);
    Object.entries(metadata || {}).forEach(([k, v]) => form.append(k, v));
    clearApiCache();
    return fetch(`${BASE}/api/documents`, {
      method: 'POST', credentials: 'include', headers: authHeaders(), body: form
    }).then(r => r.json());
  },
  getDocuments: () => fetchJSON('/api/documents'),
  deleteDocument: (fileId) => fetchJSON(`/api/documents/${fileId}`, { method: 'DELETE' }),
  getDocumentUrl: (fileId) => fetchJSON(`/api/documents/${fileId}/url`),

};
