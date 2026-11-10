import { useState } from 'react';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { useDialer } from '../lib/dialer';
import { useAuth } from '../lib/auth';

/**
 * Staff settings. Anything that affects money, calling or compliance is
 * administered from /admin; a rep can only touch their own microphone and
 * password here.
 */
export function Settings() {
  const { me, refresh } = useAuth();
  const d = useDialer();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const user = (me?.user || {}) as any;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/auth/password', { current, next });
      setCurrent('');
      setNext('');
      setMsg('Password changed.');
      refresh();
    } catch (e: any) {
      setMsg(e?.message || 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="Settings" sub="Your account and audio device" />

      <div className="max-w-2xl space-y-4 p-6">
        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Your account</h2>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <dt className="text-muted">Name</dt>
            <dd>{user.fullName || '—'}</dd>
            <dt className="text-muted">Email</dt>
            <dd className="mono">{user.email}</dd>
            <dt className="text-muted">Lead uploads</dt>
            <dd>{user.canUploadLeads ? 'allowed' : 'not allowed'}</dd>
            <dt className="text-muted">Recordings</dt>
            <dd>{user.canHearRecordings ? 'allowed' : 'not allowed'}</dd>
          </dl>
          <p className="mt-3 text-2xs text-muted">Ask your administrator if any of these need to change.</p>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Microphone</h2>
          <p className="mt-1 text-xs text-muted">
            Which input device the dialer uses. Bluetooth headsets connected after page load appear here.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <select
              className="field flex-1"
              value={d.inputDevice}
              onChange={(e) => d.selectInputDevice(e.target.value)}
              onFocus={() => d.refreshInputs()}
            >
              {d.inputDevices.length === 0 && <option value="">No microphones found</option>}
              {d.inputDevices.map((m) => (
                <option key={m.deviceId} value={m.deviceId}>
                  {m.label}
                </option>
              ))}
            </select>
            <button className="btn-ghost !py-1.5 text-xs" onClick={() => d.refreshInputs()}>
              Refresh
            </button>
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Change password</h2>
          <form onSubmit={changePassword} className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Current password</label>
              <input
                className="field"
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="label">New password</label>
              <input
                className="field"
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                placeholder="At least 8 characters"
              />
            </div>
            <div className="flex items-center gap-3 sm:col-span-2">
              <button className="btn-primary !py-1.5 text-xs" disabled={busy || next.length < 8}>
                {busy ? 'Saving…' : 'Update password'}
              </button>
              {msg && <span className="text-2xs text-accent">{msg}</span>}
            </div>
          </form>
        </section>

        <p className="text-2xs text-muted">
          Phone numbers, Twilio credentials, recording and dialling options are managed by your administrator at{' '}
          <span className="mono">/admin</span>.
        </p>
      </div>
    </div>
  );
}
