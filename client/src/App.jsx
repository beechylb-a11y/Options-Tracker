import React, { useState, useEffect } from 'react';
import { LayoutDashboard, ArrowLeftRight, Brain, BookOpen, BarChart3, TrendingUp, Shield, Library, FolderOpen, Settings, LogIn, FileBarChart } from 'lucide-react';
import { api } from './utils/api';
import Dashboard from './pages/Dashboard';
import Trades from './pages/Trades';
import DecisionEngine from './pages/DecisionEngine';
import Journal from './pages/Journal';
import Summary from './pages/Summary';
import Analytics from './pages/Analytics';
import Reports from './pages/Reports';
import PortfolioRisk from './pages/PortfolioRisk';
import Knowledgebase from './pages/Knowledgebase';
import Documents from './pages/Documents';
import SettingsPage from './pages/Settings';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'trades', label: 'Trades', icon: ArrowLeftRight },
  { id: 'decision', label: 'Decision Engine', icon: Brain },
  { id: 'journal', label: 'Journal', icon: BookOpen },
  { id: 'summary', label: 'Summary', icon: BarChart3 },
  { id: 'analytics', label: 'Analytics', icon: TrendingUp },
  { id: 'reports', label: 'Reports', icon: FileBarChart },
  { id: 'risk', label: 'Portfolio Risk', icon: Shield },
  { id: 'knowledge', label: 'Knowledgebase', icon: Library },
  { id: 'documents', label: 'Documents', icon: FolderOpen },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccount] = useState('all');

  useEffect(() => {
    api.authStatus()
      .then(d => { setAuthenticated(d.authenticated); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (authenticated) {
      api.getAccounts().then(a => setAccounts(a || [])).catch(() => {});
    }
  }, [authenticated]);

  const handleLogin = async () => {
    try {
      const { url } = await api.authUrl();
      window.location.href = url;
    } catch (err) {
      console.error('Login error:', err);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-text-muted text-sm">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[220px] bg-bg-card border-r border-bg-border flex flex-col fixed h-full z-10">
        <div className="p-5 border-b border-bg-border">
          <h1 className="font-display text-lg font-bold tracking-tight">Options Tracker</h1>
          <p className="text-[11px] text-text-faint mt-0.5">Portfolio & Decision Engine</p>
        </div>

        <nav className="flex-1 py-3">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-full flex items-center gap-3 px-5 py-2.5 text-sm transition-colors
                  ${active
                    ? 'text-accent bg-accent/10 border-l-2 border-accent font-medium'
                    : 'text-text-muted hover:text-text hover:bg-bg-hover border-l-2 border-transparent'
                  }`}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-bg-border">
          {authenticated && accounts.length > 0 && (
            <div className="mb-3">
              <label className="text-[10px] text-text-faint uppercase tracking-wider block mb-1">Account</label>
              <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)}
                className="w-full px-2 py-1.5 bg-bg border border-bg-border rounded-lg text-xs text-text outline-none focus:border-accent">
                <option value="all">All accounts</option>
                {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          )}
          {authenticated ? (
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green" />
              <span className="text-xs text-text-muted">Google Sheet connected</span>
            </div>
          ) : (
            <button
              onClick={handleLogin}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent hover:bg-accent-hover text-white text-sm font-medium rounded-lg transition-colors"
            >
              <LogIn size={14} />
              Connect Google
            </button>
          )}
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 ml-[220px] min-h-screen">
        <div className="max-w-[1400px] mx-auto p-6">
          {tab === 'dashboard' && <Dashboard authenticated={authenticated} account={selectedAccount} />}
          {tab === 'trades' && <Trades authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'decision' && <DecisionEngine authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'journal' && <Journal authenticated={authenticated} account={selectedAccount} />}
          {tab === 'summary' && <Summary authenticated={authenticated} account={selectedAccount} />}
          {tab === 'analytics' && <Analytics authenticated={authenticated} account={selectedAccount} />}
          {tab === 'reports' && <Reports authenticated={authenticated} account={selectedAccount} />}
          {tab === 'risk' && <PortfolioRisk authenticated={authenticated} account={selectedAccount} />}
          {tab === 'knowledge' && <Knowledgebase />}
          {tab === 'documents' && <Documents authenticated={authenticated} />}
          {tab === 'settings' && <SettingsPage authenticated={authenticated} onLogin={handleLogin} accounts={accounts} onAccountsChange={setAccounts} />}
        </div>
      </main>
    </div>
  );
}
