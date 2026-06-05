import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, Image, File, Trash2, ExternalLink, X, Mail, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$, fmtDate, pnlColor } from '../utils/format';

const DOC_TYPES = ['All', 'Confirmation', 'Statement', 'Screenshot', 'CSV', 'Notes', 'Other'];
const MIME_ICONS = { 'application/pdf': FileText, 'image/png': Image, 'image/jpeg': Image, 'image/webp': Image, 'text/csv': File };

export default function Documents({ authenticated }) {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState('All');
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ type: 'Confirmation', tradeDate: '', underlying: '', notes: '' });
  const [deleting, setDeleting] = useState(null);
  const [section, setSection] = useState('docs');
  // Gmail state
  const [scanning, setScanning] = useState(false);
  const [emails, setEmails] = useState([]);
  const [scanDays, setScanDays] = useState('7');
  const [expandedEmail, setExpandedEmail] = useState(null);
  const fileRef = useRef();

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    loadDocs();
  }, [authenticated]);

  function loadDocs() {
    api.getDocuments().then(d => { setDocs(d); setLoading(false); }).catch(() => setLoading(false));
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      await api.uploadDocument(file, uploadForm);
      setShowUpload(false);
      setUploadForm({ type: 'Confirmation', tradeDate: '', underlying: '', notes: '' });
      await loadDocs();
    } catch (err) { console.error(err); }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function handleDelete(fileId) {
    try { await api.deleteDocument(fileId); setDeleting(null); await loadDocs(); } catch (err) { console.error(err); }
  }

  async function handleOpen(fileId) {
    try { const urls = await api.getDocumentUrl(fileId); if (urls.webViewLink) window.open(urls.webViewLink, '_blank'); } catch (err) { console.error(err); }
  }

  async function handleScan() {
    setScanning(true);
    try {
      const days = parseInt(scanDays) || 7;
      const after = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
      const result = await api.scanEmails(100, after);
      setEmails(result.emails || []);
    } catch (err) {
      console.error('Scan failed:', err);
      setEmails([]);
    }
    setScanning(false);
  }

  if (!authenticated) {
    return (<div className="fade-in"><h2 className="font-display text-2xl font-bold mb-2">Documents</h2><p className="text-text-muted">Connect Google to manage documents.</p></div>);
  }

  const filtered = filter === 'All' ? docs : docs.filter(d => d.meta?.type === filter);
  const byMonth = {};
  filtered.forEach(d => {
    const date = d.meta?.tradeDate || d.createdTime?.split('T')[0] || 'Unknown';
    const month = date.substring(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(d);
  });
  const months = Object.keys(byMonth).sort().reverse();

  function formatSize(bytes) {
    const s = parseInt(bytes) || 0;
    if (s < 1024) return `${s} B`;
    if (s < 1048576) return `${(s / 1024).toFixed(1)} KB`;
    return `${(s / 1048576).toFixed(1)} MB`;
  }

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="font-display text-2xl font-bold">Documents</h2>
          <p className="text-text-muted text-sm mt-0.5">{docs.length} document{docs.length !== 1 ? 's' : ''} stored</p>
        </div>
        <div className="flex gap-2">
          <div className="flex border border-[#30363d] rounded-lg overflow-hidden">
            <button onClick={() => setSection('docs')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${section === 'docs' ? 'bg-accent text-white' : 'text-[#8b949e] hover:bg-[#161b22]'}`}>
              <FileText size={12} /> Documents
            </button>
            <button onClick={() => setSection('gmail')}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${section === 'gmail' ? 'bg-accent text-white' : 'text-[#8b949e] hover:bg-[#161b22]'}`}>
              <Mail size={12} /> Gmail scan
            </button>
          </div>
          {section === 'docs' && (
            <button onClick={() => setShowUpload(!showUpload)}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors">
              <Upload size={14} /> Upload
            </button>
          )}
        </div>
      </div>

      {/* ── DOCUMENTS SECTION ── */}
      {section === 'docs' && (
        <>
          {showUpload && (
            <div className="card mb-4 fade-in">
              <h3 className="text-sm font-medium text-white mb-3">Upload a document</h3>
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div>
                  <label className="text-[11px] text-[#c9d1d9] block mb-1">Document type</label>
                  <select value={uploadForm.type} onChange={e => setUploadForm(f => ({ ...f, type: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]">
                    {DOC_TYPES.filter(t => t !== 'All').map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-[#c9d1d9] block mb-1">Trade date</label>
                  <input type="date" value={uploadForm.tradeDate} onChange={e => setUploadForm(f => ({ ...f, tradeDate: e.target.value }))}
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]" />
                </div>
                <div>
                  <label className="text-[11px] text-[#c9d1d9] block mb-1">Underlying</label>
                  <input type="text" value={uploadForm.underlying} onChange={e => setUploadForm(f => ({ ...f, underlying: e.target.value }))} placeholder="SPX, SPY..."
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white placeholder-[#484f58] outline-none focus:border-[#2f81f7]" />
                </div>
                <div>
                  <label className="text-[11px] text-[#c9d1d9] block mb-1">Notes</label>
                  <input type="text" value={uploadForm.notes} onChange={e => setUploadForm(f => ({ ...f, notes: e.target.value }))} placeholder="Optional"
                    className="w-full px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white placeholder-[#484f58] outline-none focus:border-[#2f81f7]" />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 px-4 py-2 bg-green-dim hover:bg-green text-white text-sm font-medium rounded-lg cursor-pointer transition-colors">
                <Upload size={14} /> {uploading ? 'Uploading...' : 'Choose file'}
                <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.csv,.xlsx,.txt,.webp" onChange={handleUpload} className="hidden" disabled={uploading} />
              </label>
            </div>
          )}

          <div className="flex gap-1.5 mb-4">
            {DOC_TYPES.map(t => (
              <button key={t} onClick={() => setFilter(t)}
                className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${filter === t ? 'border-accent bg-accent/10 text-accent' : 'border-[#30363d] text-[#8b949e] hover:bg-[#161b22]'}`}>
                {t}
              </button>
            ))}
          </div>

          {loading ? <div className="text-[#8b949e] text-sm">Loading...</div> : filtered.length === 0 ? (
            <div className="card py-12 text-center text-[#484f58]">
              {docs.length === 0 ? 'No documents uploaded yet.' : `No ${filter.toLowerCase()} documents found.`}
            </div>
          ) : (
            <div className="space-y-4">
              {months.map(month => (
                <div key={month}>
                  <h3 className="text-xs font-semibold text-[#c9d1d9] uppercase tracking-wider mb-2">
                    {month === 'Unknown' ? 'Undated' : new Date(month + '-01').toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}
                  </h3>
                  <div className="space-y-1">
                    {byMonth[month].map(doc => {
                      const Icon = MIME_ICONS[doc.mimeType] || File;
                      const typeBadge = doc.meta?.type || 'Other';
                      const badgeCls = typeBadge === 'Confirmation' ? 'badge-green' : typeBadge === 'Statement' ? 'badge-blue' : typeBadge === 'Screenshot' ? 'badge-amber' : 'badge-red';
                      return (
                        <div key={doc.id} className="flex items-center gap-3 py-2.5 px-4 rounded-lg border border-[#30363d] hover:border-[#484f58] transition-colors">
                          <Icon size={18} className="text-[#8b949e] flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-white truncate">{doc.name}</span>
                              <span className={`badge text-[9px] ${badgeCls}`}>{typeBadge}</span>
                              {doc.meta?.underlying && <span className="text-[10px] text-[#8b949e]">{doc.meta.underlying}</span>}
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-[#484f58] mt-0.5">
                              {doc.meta?.tradeDate && <span>{fmtDate(doc.meta.tradeDate)}</span>}
                              <span>{formatSize(doc.size)}</span>
                              {doc.meta?.notes && <span className="text-[#8b949e]">{doc.meta.notes}</span>}
                            </div>
                          </div>
                          <button onClick={() => handleOpen(doc.id)} className="text-[#8b949e] hover:text-accent transition-colors p-1"><ExternalLink size={14} /></button>
                          {deleting === doc.id ? (
                            <div className="flex items-center gap-1">
                              <button onClick={() => handleDelete(doc.id)} className="text-[10px] px-2 py-1 bg-red-dim text-white rounded">Delete</button>
                              <button onClick={() => setDeleting(null)} className="text-[10px] px-2 py-1 border border-[#30363d] text-[#8b949e] rounded">Cancel</button>
                            </div>
                          ) : (
                            <button onClick={() => setDeleting(doc.id)} className="text-[#484f58] hover:text-red transition-colors p-1"><Trash2 size={14} /></button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── GMAIL SCAN SECTION ── */}
      {section === 'gmail' && (
        <div>
          <div className="card mb-4">
            <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
              <Mail size={14} /> Scan TastyTrade Emails
            </h3>
            <p className="text-xs text-[#8b949e] mb-3">
              Scans your Gmail for TastyTrade order fills, assignments, and exercise notifications. Parses legs, strikes, and strategy automatically.
            </p>
            <div className="flex items-end gap-3">
              <div>
                <label className="text-[11px] text-[#c9d1d9] block mb-1">Scan last</label>
                <select value={scanDays} onChange={e => setScanDays(e.target.value)}
                  className="px-3 py-2 bg-[#0d1117] border border-[#30363d] rounded-lg text-sm text-white outline-none focus:border-[#2f81f7]">
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </div>
              <button onClick={handleScan} disabled={scanning}
                className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
                <RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />
                {scanning ? 'Scanning...' : 'Scan inbox'}
              </button>
              {emails.length > 0 && <span className="text-xs text-[#8b949e]">{emails.length} emails found</span>}
            </div>
          </div>

          {/* Email results */}
          {emails.length > 0 && (
            <div className="space-y-2">
              {emails.map((email, i) => {
                const expanded = expandedEmail === i;
                const typeBadge = email.type === 'order_fill' ? 'badge-green' : email.type === 'assignment' ? 'badge-amber' : 'badge-blue';
                const typeLabel = email.type === 'order_fill' ? 'Order Fill' : email.type === 'assignment' ? 'Assignment' : email.type;
                return (
                  <div key={i} className="card cursor-pointer" onClick={() => setExpandedEmail(expanded ? null : i)}>
                    <div className="flex items-center gap-3">
                      <Mail size={16} className="text-[#8b949e] flex-shrink-0" />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-white">{email.symbol}</span>
                          <span className={`badge text-[9px] ${typeBadge}`}>{typeLabel}</span>
                          {email.strategy && <span className="text-xs text-[#8b949e]">{email.strategy}</span>}
                          {email.orderId && <span className="text-[10px] text-[#484f58]">#{email.orderId}</span>}
                        </div>
                        <div className="text-[10px] text-[#484f58] mt-0.5">
                          {fmtDate(email.emailDate || email.fillDate)}
                          {email.creditDebit && ` — ${fmt$(email.amount)} ${email.creditDebit}`}
                          {email.legs && ` — ${email.legs.length} leg${email.legs.length !== 1 ? 's' : ''}`}
                        </div>
                      </div>
                      {expanded ? <ChevronUp size={14} className="text-[#484f58]" /> : <ChevronDown size={14} className="text-[#484f58]" />}
                    </div>

                    {expanded && (
                      <div className="mt-3 pt-3 border-t border-[#21262d] fade-in">
                        {email.orderType && (
                          <div className="text-xs text-[#c9d1d9] mb-2">Order: {email.orderType}</div>
                        )}
                        <div className="space-y-1">
                          {email.legs?.map((leg, j) => (
                            <div key={j} className="flex items-center gap-3 py-1.5 px-3 rounded border border-[#21262d] text-sm">
                              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${leg.action === 'Sold' || leg.action === 'Assigned' ? 'bg-[#238636] text-white' : 'bg-[#0d1a2e] text-[#58a6ff]'}`}>
                                {leg.action}
                              </span>
                              <span className="text-white font-medium">{leg.qty}x</span>
                              <span className="text-[#c9d1d9]">{leg.symbol}</span>
                              <span className="text-[#8b949e]">{leg.expiry}</span>
                              <span className="text-white">{leg.type} {leg.strike}</span>
                              {leg.price !== undefined && <span className="mono text-[#c9d1d9] ml-auto">@ ${leg.price.toFixed(2)}</span>}
                            </div>
                          ))}
                        </div>
                        {email.strategy && (
                          <div className="mt-2 text-xs text-[#8b949e]">
                            Detected strategy: <span className="text-white font-medium">{email.strategy}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {emails.length === 0 && !scanning && (
            <div className="card py-12 text-center text-[#484f58]">
              Click "Scan inbox" to search for TastyTrade emails. Requires Gmail access permission.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
