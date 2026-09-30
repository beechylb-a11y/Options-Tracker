import React, { useState, useEffect } from 'react';
import { LayoutDashboard, ArrowLeftRight, Brain, BookOpen, TrendingUp, Shield, Library, FolderOpen, Settings, LogOut, FileBarChart } from 'lucide-react';
import { api, setAccessToken, setOnUnauthorized, clearApiCache } from './utils/api';
import { getSupabase } from './utils/supabase';
import Login from './components/Login';
import HeaderStrip from './components/HeaderStrip';
import Dashboard from './pages/Dashboard';
import Trades from './pages/Trades';
import DecisionEngine from './pages/DecisionEngine';
import Journal from './pages/Journal';
import Analytics from './pages/Analytics';
import Reports from './pages/Reports';
import PortfolioRisk from './pages/PortfolioRisk';
import Knowledgebase from './pages/Knowledgebase';
import Documents from './pages/Documents';
import SettingsPage from './pages/Settings';

// Nav grouped by workflow. `key` is the keyboard shortcut (guarded against
// typing in inputs). Tab + account selections persist across reloads.
const NAV_GROUPS = [
  {
    label: 'Trade',
    tabs: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, key: '1' },
      { id: 'decision', label: 'Decision Engine', icon: Brain, key: '2' },
      { id: 'trades', label: 'Trades', icon: ArrowLeftRight, key: '3' },
    ],
  },
  {
    label: 'Review',
    tabs: [
      { id: 'journal', label: 'Journal', icon: BookOpen, key: '4' },
      { id: 'analytics', label: 'Analytics', icon: TrendingUp, key: '5' },
      { id: 'risk', label: 'Portfolio Risk', icon: Shield, key: '6' },
      { id: 'reports', label: 'Reports', icon: FileBarChart, key: '7' },
    ],
  },
  {
    label: 'Reference',
    tabs: [
      { id: 'knowledge', label: 'Knowledgebase', icon: Library, key: '8' },
      { id: 'documents', label: 'Documents', icon: FolderOpen, key: '9' },
      { id: 'settings', label: 'Settings', icon: Settings, key: '0' },
    ],
  },
];

const ALL_TABS = NAV_GROUPS.flatMap(g => g.tabs);
const TAB_IDS = ALL_TABS.map(t => t.id);

const savedTab = () => {
  try {
    const t = localStorage.getItem('ot_tab');
    if (t === 'summary') return 'analytics'; // Summary merged into Analytics
    return TAB_IDS.includes(t) ? t : 'dashboard';
  } catch (e) { return 'dashboard'; }
};
const savedAccount = () => {
  try { return localStorage.getItem('ot_account') || 'all'; } catch (e) { return 'all'; }
};

export default function App() {
  const [tab, setTabState] = useState(savedTab);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [selectedAccount, setSelectedAccountState] = useState(savedAccount);
  const [refreshTick, setRefreshTick] = useState(0);

  const [userEmail, setUserEmail] = useState('');
  const [authNotice, setAuthNotice] = useState('');

  const setTab = id => {
    setTabState(id);
    try { localStorage.setItem('ot_tab', id); } catch (e) {}
  };
  const setSelectedAccount = id => {
    setSelectedAccountState(id);
    try { localStorage.setItem('ot_account', id); } catch (e) {}
  };

  // Supabase session -> API token. The server re-checks every call against the
  // allowlist, so a valid login that is not on it lands back here with a notice.
  useEffect(() => {
    let sub = null;
    let cancelled = false;
    const apply = async (session) => {
      if (cancelled) return;
      setAccessToken(session?.access_token || null);
      clearApiCache();
      if (!session) { setAuthenticated(false); setUserEmail(''); setLoading(false); return; }
      try {
        const st = await api.authStatus();
        setUserEmail(st.email || session.user?.email || '');
        setAuthNotice('');
        setAuthenticated(true);
      } catch (e) {
        setAuthenticated(false);
        setAuthNotice(`${session.user?.email || 'This account'} is not allowed to use this app.`);
        const sb = await getSupabase(); await sb.auth.signOut();
      }
      setLoading(false);
    };
    getSupabase().then(sb => {
      sb.auth.getSession().then(({ data }) => apply(data.session));
      sub = sb.auth.onAuthStateChange((event, session) => {
        if (event === 'TOKEN_REFRESHED') { setAccessToken(session?.access_token || null); return; }
        if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') apply(session);
      }).data.subscription;
    }).catch(e => { setAuthNotice(e.message); setLoading(false); });
    setOnUnauthorized(() => { setAuthenticated(false); });
    return () => { cancelled = true; sub?.unsubscribe(); };
  }, []);

  useEffect(() => {
    if (authenticated) {
      api.getAccounts().then(a => {
        const list = a || [];
        setAccounts(list);
        // A persisted account that no longer exists falls back to 'all'
        setSelectedAccountState(prev =>
          prev !== 'all' && !list.some(x => x.id === prev) ? 'all' : prev
        );
      }).catch(() => {});
    }
  }, [authenticated]);

  // Keyboard shortcuts: 1–9, 0 switch tabs (ignored while typing)
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (typing) return;
      const hit = ALL_TABS.find(t => t.key === e.key);
      if (hit) { e.preventDefault(); setTab(hit.id); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const handleLogout = async () => {
    const sb = await getSupabase();
    await sb.auth.signOut();
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

  if (!authenticated) return <Login notice={authNotice} />;

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="w-[220px] bg-bg-card border-r border-bg-border flex flex-col fixed h-full z-10">
        <div className="p-5 border-b border-bg-border">
          <h1 className="font-display text-lg font-bold tracking-tight">Options Tracker</h1>
          <p className="text-[12.5px] text-text-faint mt-0.5">Portfolio & Decision Engine</p>
        </div>

        <nav className="flex-1 py-2 overflow-y-auto">
          {NAV_GROUPS.map(group => (
            <div key={group.label} className="mb-1">
              <div className="px-5 pt-3 pb-1 text-[12px] text-text-faint uppercase tracking-wider">{group.label}</div>
              {group.tabs.map(t => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={`w-full flex items-center gap-3 px-5 py-2 text-sm transition-colors
                      ${active
                        ? 'text-accent bg-accent/10 border-l-2 border-accent font-medium'
                        : 'text-text-muted hover:text-text hover:bg-bg-hover border-l-2 border-transparent'
                      }`}
                  >
                    <Icon size={16} />
                    <span className="flex-1 text-left">{t.label}</span>
                    {t.key && <span className="text-[12px] text-text-faint mono">{t.key}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="p-4 border-t border-bg-border">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green" />
            <span className="text-xs text-text-muted truncate flex-1" title={userEmail}>{userEmail || 'Signed in'}</span>
            <button onClick={handleLogout} title="Sign out" className="text-text-faint hover:text-text transition-colors">
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 ml-[220px] min-h-screen">
        <HeaderStrip
          authenticated={authenticated}
          account={selectedAccount}
          accounts={accounts}
          onAccountChange={setSelectedAccount}
          onGlobalRefresh={() => setRefreshTick(t => t + 1)}
          onLogin={handleLogout}
        />
        {/* refreshTick remounts the visible page so it refetches after a global
            refresh — except the Decision Engine, where a remount could disturb
            an in-progress ticket (cache is still cleared; data refetches on
            next navigation). */}
        <div className="max-w-[1400px] mx-auto p-6" key={tab === 'decision' ? 'decision' : refreshTick}>
          {tab === 'dashboard' && <Dashboard authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'trades' && <Trades authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'decision' && <DecisionEngine authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'journal' && <Journal authenticated={authenticated} account={selectedAccount} />}
          {tab === 'analytics' && <Analytics authenticated={authenticated} account={selectedAccount} accounts={accounts} />}
          {tab === 'reports' && <Reports authenticated={authenticated} account={selectedAccount} />}
          {tab === 'risk' && <PortfolioRisk authenticated={authenticated} account={selectedAccount} />}
          {tab === 'knowledge' && <Knowledgebase />}
          {tab === 'documents' && <Documents authenticated={authenticated} />}
          {tab === 'settings' && <SettingsPage authenticated={authenticated} onLogin={handleLogout} accounts={accounts} onAccountsChange={setAccounts} userEmail={userEmail} />}
        </div>
      </main>
    </div>
  );
}
