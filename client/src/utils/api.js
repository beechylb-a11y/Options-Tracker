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
  compareCSV: (file) => {
    const form = new FormData();
    form.append('file', file);
    return fetch(`${BASE}/api/compare-csv`, {
      method: 'POST', credentials: 'include', body: form
    }).then(r => r.json());
  },

  // Trades
  getTrades: () => fetchJSON('/api/trades'),
  getTracker: () => fetchJSON('/api/tracker'),
  updateTrade: (rowIndex, updates) => fetchJSON(`/api/tracker/${rowIndex}`, {
    method: 'PUT', body: JSON.stringify(updates)
  }),
  deleteTrade: (rowIndex) => fetchJSON(`/api/tracker/${rowIndex}`, {
    method: 'DELETE'
  }),

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

  // Trade ticket lifecycle
  closeTicket: (rowIndex, data) => fetchJSON(`/api/decisions/${rowIndex}/close`, {
    method: 'PUT', body: JSON.stringify(data)
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
    return fetch(`${BASE}/api/documents`, {
      method: 'POST', credentials: 'include', body: form
    }).then(r => r.json());
  },
  getDocuments: () => fetchJSON('/api/documents'),
  deleteDocument: (fileId) => fetchJSON(`/api/documents/${fileId}`, { method: 'DELETE' }),
  getDocumentUrl: (fileId) => fetchJSON(`/api/documents/${fileId}/url`)
};
