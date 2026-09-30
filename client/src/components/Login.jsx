import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { getSupabase } from '../utils/supabase';

// Email + password sign-in against Supabase Auth. Only emails on the server's
// allowlist (options.allowed_users) get past the API, even with a valid login.
export default function Login({ notice }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setInfo('');
    try {
      const sb = await getSupabase();
      const { error: err } = await sb.auth.signInWithPassword({ email: email.trim(), password });
      if (err) setError(err.message);
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function reset() {
    if (!email.trim()) { setError('Enter your email first.'); return; }
    setBusy(true); setError(''); setInfo('');
    try {
      const sb = await getSupabase();
      const { error: err } = await sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
      if (err) setError(err.message); else setInfo('Password reset email sent.');
    } catch (err) { setError(err.message); }
    setBusy(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm">
        <h1 className="font-display text-lg font-bold tracking-tight">Options Tracker</h1>
        <p className="text-[12.5px] text-text-faint mt-0.5 mb-5">Sign in to continue</p>
        {notice && <div className="text-xs text-amber mb-3">{notice}</div>}
        <label className="text-[12.5px] text-text-muted block mb-1">Email</label>
        <input type="email" autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} required
          className="w-full mb-3 px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text outline-none focus:border-accent" />
        <label className="text-[12.5px] text-text-muted block mb-1">Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required
          className="w-full mb-4 px-3 py-2 bg-bg border border-bg-border rounded-lg text-sm text-text outline-none focus:border-accent" />
        {error && <div className="text-xs text-red mb-3">{error}</div>}
        {info && <div className="text-xs text-green mb-3">{info}</div>}
        <button type="submit" disabled={busy}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent hover:bg-accent-hover disabled:opacity-60 text-white text-sm font-medium rounded-lg transition-colors">
          <LogIn size={14} /> {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" onClick={reset} disabled={busy}
          className="w-full mt-2 text-[12.5px] text-text-muted hover:text-text transition-colors">
          Forgot password?
        </button>
      </form>
    </div>
  );
}
