import { PageHeader } from '../components/Shell';
import { useDialer } from '../lib/dialer';
import { useAuth } from '../lib/auth';

/**
 * Staff settings. Anything that affects money, calling or compliance is
 * administered from /admin; a rep can only choose their own microphone here.
 */
export function Settings() {
  const { me } = useAuth();
  const d = useDialer();
  const user = (me?.user || {}) as any;

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
      </div>
    </div>
  );
}
