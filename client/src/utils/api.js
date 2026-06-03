const BASE = '';

async function fetchJSON(url, opts = {}) {
  const res = await fetch(`${BASE}${url}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    ...opts
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // Auth
  authStatus: () => fetchJSON('/auth/status'),
  authUrl: () => fetchJSON('/auth/google'),

  // Config
  getConfig: () => fetchJSON('/api/config'),
  updateConfig: (key, value) => fetchJSON(`/api/config/${key}`, {
    method: 'PUT', body: JSON.stringify({ value })
  }),

  // CSV upload
  uploadCSV: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${BASE}/api/upload-csv`, {
      method: 'POST', credentials: 'include', body: form
    }).then(r => r.json());
  },

  // Trades
  getTrades: () => fetchJSON('/api/trades'),
  getTracker: () => fetchJSON('/api/tracker'),

  // Stats
  getStats: () => fetchJSON('/api/stats'),
  getPerformance: () => fetchJSON('/api/performance'),

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

  // Journal
  getJournal: () => fetchJSON('/api/journal'),
  addJournalEntry: (entry) => fetchJSON('/api/journal', {
    method: 'POST', body: JSON.stringify(entry)
  })
};
