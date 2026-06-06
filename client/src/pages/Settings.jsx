import React, { useState, useEffect } from 'react';
import { LogIn, Save, ExternalLink, Shield, Plus, Trash2, Edit3, X } from 'lucide-react';
import { api } from '../utils/api';
import { fmt$ } from '../utils/format';

export default function SettingsPage({ authenticated, onLogin, accounts, onAccountsChange }) {
  const [config, setConfig] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  // Account management
  const [showAddAccount, setShowAddAccount] = useState(false);
  const [editingAccount, setEditingAccount] = useState(null);
  const [accountForm, setAccountForm] = useState({ name: '', bankroll: '3000', startingBankroll: '3000', maxDailyLoss: '300', maxOpenRisk: '450' });
  const [savingAccounts, setSavingAccounts] = useState(false);

  useEffect(() => {
    if (!authenticated) { setLoading(false); return; }
    api.getConfig().then(c => { setConfig(c); setLoading(false); }).catch(() => setLoading(false));
  }, [authenticated]);

  async function handleSave() {
    setSaving(true);
    try {
      for (const [key, val] of Object.entries(config)) {
        if (key === 'accounts') continue;
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

  async function handleAddAccount() {
    setSavingAccounts(true);
    try {
      const newAccount = {
        id: accountForm.name.toLowerCase().replace(/\s+/g, '-') + '-' + Date.now().toString(36),
        name: accountForm.name,
        bankroll: parseFloat(accountForm.bankroll) || 3000,
        startingBankroll: parseFloat(accountForm.startingBankroll) || 3000,
        maxDailyLoss: parseFloat(accountForm.maxDailyLoss) || 300,
        maxOpenRisk: parseFloat(accountForm.maxOpenRisk) || 450
      };
      const updated = [...(accounts || []), newAccount];
      await api.saveAccounts(updated);
      onAccountsChange(updated);
      setShowAddAccount(false);
      setAccountForm({ name: '', bankroll: '3000', startingBankroll: '3000', maxDailyLoss: '300', maxOpenRisk: '450' });
    } catch (e) { console.error(e); }
    setSavingAccounts(false);
  }

  async function handleUpdateAccount() {
    setSavingAccounts(true);
    try {
      const updated = (accounts || []).map(a => a.id === editingAccount ? {
        ...a,
        name: accountForm.name,
        bankroll: parseFloat(accountForm.bankroll) || a.bankroll,
        startingBankroll: parseFloat(accountForm.startingBankroll) || a.startingBankroll,
        maxDailyLoss: parseFloat(accountForm.maxDailyLoss) || a.maxDailyLoss,
        maxOpenRisk: parseFloat(accountForm.maxOpenRisk) || a.maxOpenRisk
      } : a);
      await api.saveAccounts(updated);
      onAccountsChange(updated);
      setEditingAccount(null);
    } catch (e) { console.error(e); }
    setSavingAccounts(false);
  }

  async function handleDeleteAccount(id) {
    setSavingAccounts(true);
    try {
      const updated = (accounts || []).filter(a => a.id !== id);
      await api.saveAccounts(updated);
      onAccountsChange(updated);
    } catch (e) { console.error(e); }
    setSavingAccounts(false);
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
            <p className="text-sm text-text-muted mb-3">Connect your Google account to sync with Google Sheets.</p>
            <button onClick={onLogin}
              className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors">
              <LogIn size={14} /> Connect Google Account
            </button>
          </div>
        )}
      </div>

      {/* Accounts */}
      <div className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display font-semibold">Trading Accounts</h3>
          <button onClick={() => { setShowAddAccount(!showAddAccount); setEditingAccount(null); setAccountForm({ name: '', bankroll: '3000', startingBankroll: '3000', maxDailyLoss: '300', maxOpenRisk: '450' }); }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors">
            <Plus size={12} /> Add account
          </button>
        </div>

        {/* Existing accounts */}
        {accounts && accounts.length > 0 ? (
          <div className="space-y-2 mb-4">
            {accounts.map(a => (
              <div key={a.id} className="flex items-center gap-3 p-3 rounded-lg border border-bg-border">
                {editingAccount === a.id ? (
                  <div className="flex-1 fade-in">
                    <div className="grid grid-cols-3 gap-2 mb-2">
                      <div>
                        <label className="text-[10px] text-text-muted block mb-0.5">Name</label>
                        <input value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text outline-none focus:border-accent" />
                      </div>
                      <div>
                        <label className="text-[10px] text-text-muted block mb-0.5">Bankroll ($)</label>
                        <input type="number" value={accountForm.bankroll} onChange={e => setAccountForm(f => ({ ...f, bankroll: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                      </div>
                      <div>
                        <label className="text-[10px] text-text-muted block mb-0.5">Starting ($)</label>
                        <input type="number" value={accountForm.startingBankroll} onChange={e => setAccountForm(f => ({ ...f, startingBankroll: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                      </div>
                      <div>
                        <label className="text-[10px] text-text-muted block mb-0.5">Max daily loss ($)</label>
                        <input type="number" value={accountForm.maxDailyLoss} onChange={e => setAccountForm(f => ({ ...f, maxDailyLoss: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                      </div>
                      <div>
                        <label className="text-[10px] text-text-muted block mb-0.5">Max open risk ($)</label>
                        <input type="number" value={accountForm.maxOpenRisk} onChange={e => setAccountForm(f => ({ ...f, maxOpenRisk: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleUpdateAccount} disabled={savingAccounts}
                        className="flex items-center gap-1 px-3 py-1 text-xs bg-green-dim text-white rounded hover:bg-green disabled:opacity-50">
                        <Save size={10} /> Save
                      </button>
                      <button onClick={() => setEditingAccount(null)} className="px-3 py-1 text-xs border border-bg-border text-text-muted rounded hover:bg-bg-hover">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text">{a.name}</span>
                        <span className="text-[10px] text-text-faint">{a.id}</span>
                      </div>
                      <div className="flex gap-4 text-[10px] text-text-muted mt-0.5">
                        <span>Bankroll: <span className="mono text-text">{fmt$(a.bankroll)}</span></span>
                        <span>Max loss: <span className="mono text-text">{fmt$(a.maxDailyLoss)}</span></span>
                        <span>Max risk: <span className="mono text-text">{fmt$(a.maxOpenRisk)}</span></span>
                      </div>
                    </div>
                    <button onClick={() => { setEditingAccount(a.id); setAccountForm({ name: a.name, bankroll: a.bankroll, startingBankroll: a.startingBankroll, maxDailyLoss: a.maxDailyLoss, maxOpenRisk: a.maxOpenRisk }); setShowAddAccount(false); }}
                      className="text-text-faint hover:text-accent p-1"><Edit3 size={14} /></button>
                    <button onClick={() => handleDeleteAccount(a.id)}
                      className="text-text-faint hover:text-red p-1"><Trash2 size={14} /></button>
                  </>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-muted mb-4">No accounts configured. Add an account to track trades across multiple TastyTrade accounts.</p>
        )}

        {/* Add account form */}
        {showAddAccount && (
          <div className="p-3 rounded-lg border border-accent/30 bg-accent/5 fade-in">
            <div className="grid grid-cols-3 gap-2 mb-2">
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">Account name</label>
                <input value={accountForm.name} onChange={e => setAccountForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Main, IRA, Paper"
                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text placeholder-text-faint outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">Bankroll ($)</label>
                <input type="number" value={accountForm.bankroll} onChange={e => setAccountForm(f => ({ ...f, bankroll: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">Starting bankroll ($)</label>
                <input type="number" value={accountForm.startingBankroll} onChange={e => setAccountForm(f => ({ ...f, startingBankroll: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">Max daily loss ($)</label>
                <input type="number" value={accountForm.maxDailyLoss} onChange={e => setAccountForm(f => ({ ...f, maxDailyLoss: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">Max open risk ($)</label>
                <input type="number" value={accountForm.maxOpenRisk} onChange={e => setAccountForm(f => ({ ...f, maxOpenRisk: e.target.value }))}
                  className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded text-xs text-text mono outline-none focus:border-accent" />
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={handleAddAccount} disabled={!accountForm.name.trim() || savingAccounts}
                className="flex items-center gap-1 px-3 py-1.5 text-xs bg-accent hover:bg-accent-hover text-white rounded-lg disabled:opacity-50">
                <Plus size={10} /> {savingAccounts ? 'Creating...' : 'Create account'}
              </button>
              <button onClick={() => setShowAddAccount(false)} className="px-3 py-1.5 text-xs border border-bg-border text-text-muted rounded-lg hover:bg-bg-hover">Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Global Config (defaults) */}
      <div className="card mb-6">
        <h3 className="font-display font-semibold mb-4">Default Risk Configuration</h3>
        <p className="text-xs text-text-muted mb-3">These defaults are used when no account is selected. Per-account settings override these.</p>
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
          {saved && <span className="text-green text-sm">Saved</span>}
        </div>
      </div>
    </div>
  );
}
