import React, { useState } from 'react';
import { ExternalLink, Zap } from 'lucide-react';

const ENGINE_URL = 'https://script.google.com/macros/s/AKfycbyaO8BnJaLjcoiVM5_HEr6XW6d4X-PzglitQOe_HmoiFQrpqCatllID6bajXnmj-6Co/exec';

export default function DecisionEngine({ authenticated }) {
  const [mode, setMode] = useState('0dte');

  return (
    <div className="fade-in">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="font-display text-2xl font-bold">Decision Engine</h2>
          <p className="text-text-muted text-sm mt-0.5">Pre-trade analysis and strategy selection</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex border border-bg-border rounded-lg overflow-hidden">
            <button onClick={() => setMode('0dte')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${mode === '0dte' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              <Zap size={14} className="inline mr-1" /> 0DTE
            </button>
            <button onClick={() => setMode('45dte')}
              className={`px-4 py-2 text-sm font-medium transition-colors ${mode === '45dte' ? 'bg-accent text-white' : 'text-text-muted hover:text-text hover:bg-bg-hover'}`}>
              45 DTE
            </button>
          </div>
          <a href={ENGINE_URL} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-2 px-3 py-2 text-sm border border-bg-border rounded-lg hover:bg-bg-hover transition-colors text-text-muted">
            <ExternalLink size={14} />
            Open in new tab
          </a>
        </div>
      </div>

      {/* Embed the Apps Script web app */}
      <div className="card p-0 overflow-hidden" style={{ height: 'calc(100vh - 140px)' }}>
        <iframe
          src={ENGINE_URL + (mode === '45dte' ? '?mode=45' : '')}
          style={{ width: '100%', height: '100%', border: 'none', background: '#f4f4f2', borderRadius: '12px' }}
          title="Decision Engine"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  );
}
