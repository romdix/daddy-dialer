import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

export function Login() {
  const nav = useNavigate();
  const { setMe, refresh } = useAuth();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      if (mode === 'signup') {
        await api.post('/api/auth/signup', { email, password, fullName });
      } else {
        await api.post('/api/auth/login', { email, password });
      }
      await refresh();
      nav('/', { replace: true });
    } catch (e: any) {
      setErr(e instanceof ApiError ? e.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="h-8 w-8 rounded bg-accent flex items-center justify-center">
            <span className="text-ink-950 font-bold text-sm">DD</span>
          </div>
          <div>
            <h1 className="text-base font-semibold leading-tight">Daddy Dialer</h1>
            <p className="text-2xs text-muted uppercase tracking-wider">Power Dialer CRM</p>
          </div>
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">{mode === 'login' ? 'Sign in' : 'Create your workspace'}</h2>
          <p className="mt-1 text-xs text-muted">
            {mode === 'login' ? 'Welcome back.' : 'One account, one workspace, ready in a second.'}
          </p>

          <form onSubmit={submit} className="mt-4 space-y-3">
            {mode === 'signup' && (
              <div>
                <label className="label">Your name</label>
                <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Sam" />
              </div>
            )}
            <div>
              <label className="label">Email</label>
              <input
                className="field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                required
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="field"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
                required
              />
            </div>

            {err && (
              <p className="rounded border border-red-900/50 bg-red-950/30 px-2.5 py-2 text-xs text-red-300">{err}</p>
            )}

            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>

          <button
            className="mt-3 text-xs text-muted hover:text-accent"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setErr(null);
            }}
          >
            {mode === 'login' ? 'No account? Create one' : 'Already have an account? Sign in'}
          </button>
        </div>

        <p className="mt-4 text-center text-2xs text-muted">
          Browser calling needs a microphone and an HTTPS address.
        </p>
      </div>
    </div>
  );
}
