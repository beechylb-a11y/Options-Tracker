import React, { useState, useEffect } from 'react';
import { LogIn, Save, ExternalLink, Shield } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$ } from '../utils/format';

export default function SettingsPage({ authenticated, onLogin }) {
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    api.getConfig().then(c => { setConfig(c); setLoading(false); }).catch(() => setLoading(false));
  }, [authenticated]);

  async function handleSave() {
    setSaving(true);
    try {
      for (const [key, val] of Object.entries(config)) {
        await api.updateConfig(key, val);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) { console.error(e); }
    setSaving(false);
  }

  function updateField(key, value) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  const fields = [
    { key: 'currentBankroll', label: 'Current Bankroll ($)', type: 'number' },
    { key: 'startingBankroll', label: 'Starting Bankroll ($)', type: 'number' },
    { key: 'maxDailyLoss', label: 'Max Daily Loss ($)', type: 'number' },
    { key: 'maxOpenRisk', label: 'Max Open Risk ($)', type: 'number' },
    { key: 'riskPerContract', label: 'Risk Per Contract ($)', type: 'number' },
    { key: 'winAmount', label: 'Win Amount ($)', type: 'number' }
  ];

  return (
    <div className="fade-in max-w-2xl">
      <h2 className="font-display text-2xl font-bold mb-6">Settings</h2>

      {/* Auth */}
      <div className="card mb-6">
        <div className="flex items-center gap-3 mb-4">
          <Shield size={18} className="text-accent" />
          <h3 className="font-display font-semibold">Google Connection</h3>
        </div>
        {authenticated ? (
          <div className="flex items-center gap-3">
            <div className="w-2.5 h-2.5 rounded-full bg-green" />
            <span className="text-sm text-text">Connected to Google Sheets</span>
            <a href={`https://docs.google.com/spreadsheets/d/${import.meta.env.VITE_SPREADSHEET_ID || 'your-sheet-id'}`}
              target="_blank" rel="noopener noreferrer"
              className="ml-auto flex items-center gap-1 text-xs text-accent hover:text-accent-hover transition-colors">
              <ExternalLink size={12} /> Open Sheet
            </a>
          </div>
        ) : (
          <div>
            <p className="text-sm text-text-muted mb-3">Connect your Google account to sync with Google Sheets for trade storage, config, and stats.</p>
            <button onClick={onLogin}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors">
              <LogIn size={14} /> Connect Google Account
            </button>
          </div>
        )}
      </div>

      {/* Config */}
      <div className="card mb-6">
        <h3 className="font-display font-semibold mb-4">Risk & Bankroll Configuration</h3>
        {loading ? (
          <div className="text-text-muted text-sm">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {fields.map(f => (
              <div key={f.key}>
                <label className="text-xs text-text-muted block mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={config[f.key] || ''}
                  onChange={e => updateField(f.key, e.target.value)}
                  className="w-full px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text mono outline-none focus:border-accent transition-colors"
                />
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 mt-4">
          <button onClick={handleSave} disabled={saving || !authenticated}
            className="flex items-center gap-2 px-4 py-2 bg-green-dim hover:bg-green text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
            <Save size={14} /> {saving ? 'Saving...' : 'Save Config'}
          </button>
          {saved && <span className="text-green text-sm">Saved to Google Sheet</span>}
        </div>
      </div>

      {/* Instructions */}
      <div className="card">
        <h3 className="font-display font-semibold mb-3">Setup Instructions</h3>
        <div className="text-sm text-text-muted space-y-2">
          <p><strong className="text-text">1. Google Cloud Console:</strong> Create OAuth 2.0 credentials (Web application). Add your Railway URL + /auth/google/callback as an authorized redirect URI.</p>
          <p><strong className="text-text">2. Google Sheet:</strong> Create a new Google Sheet. Copy the Sheet ID from the URL (between /d/ and /edit). Set it as SPREADSHEET_ID environment variable.</p>
          <p><strong className="text-text">3. Railway:</strong> Set environment variables: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI (your Railway URL + /auth/google/callback), SPREADSHEET_ID, CLIENT_URL (your Railway URL).</p>
          <p><strong className="text-text">4. Enable APIs:</strong> In Google Cloud Console, enable Google Sheets API and Google Drive API.</p>
          <p><strong className="text-text">5. Connect:</strong> Click "Connect Google Account" above to authenticate and auto-create the required sheet tabs.</p>
        </div>
      </div>
    </div>
  );
}
