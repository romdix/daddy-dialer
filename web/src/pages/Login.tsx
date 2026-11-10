import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BrandMark, useBrand } from '../lib/brand';

export function Login() {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const { brand } = useBrand();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.post('/api/auth/login', { email, password });
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
          <BrandMark size={32} />
          <div>
            <h1 className="text-base font-semibold leading-tight">{brand.name}</h1>
            <p className="text-2xs text-muted uppercase tracking-wider">Power Dialer CRM</p>
          </div>
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Sign in</h2>
          <p className="mt-1 text-xs text-muted">Use the account your administrator gave you.</p>

          <form onSubmit={submit} className="mt-4 space-y-3">
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
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>

            {err && (
              <p className="rounded border border-red-900/50 bg-red-950/30 px-2.5 py-2 text-xs text-red-300">{err}</p>
            )}

            <button className="btn-primary w-full" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-3 text-2xs text-muted">
            No account? Ask your administrator — accounts are created for you.
          </p>
        </div>

        <p className="mt-4 text-center text-2xs text-muted">
          Browser calling needs a microphone and an HTTPS address.
        </p>
      </div>
    </div>
  );
}
