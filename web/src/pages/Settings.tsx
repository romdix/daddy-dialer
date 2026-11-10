import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { CallerIdsPanel } from '../components/CallerIdsPanel';
import { VoicemailPanel } from '../components/VoicemailPanel';
import { DataPanel } from '../components/DataPanel';
import { useDialer } from '../lib/dialer';
import { useAuth } from '../lib/auth';
import { useBrand, onAccent } from '../lib/brand';

interface SettingsShape {
  provider: 'twilio' | 'telnyx';
  twilio: { accountSid: string; authToken: string; apiKeySid: string; apiKeySecret: string; number: string; twimlApp: string };
  telnyx: { apiKey: string; connectionId: string; number: string };
  recordingEnabled: boolean;
  recordingRetentionDays: number;
  amdEnabled: boolean;
  ringTimeoutSec: number;
  compliance: {
    enforce: boolean;
    windowStart: number;
    windowEnd: number;
    windowDays: string;
    maxAttempts: number;
    defaultTimezone: string;
  };
  configured: boolean;
  warnings?: string[];
}

const COMPLIANCE_DEFAULTS = {
  enforce: true,
  windowStart: 8,
  windowEnd: 21,
  windowDays: '1,2,3,4,5',
  maxAttempts: 0,
  defaultTimezone: '',
};

const DAY_LABELS: [number, string][] = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
];

export function Settings() {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const dialer = useDialer();
  const { brand, save: saveBrand } = useBrand();
  const { data } = useQuery<SettingsShape>({ queryKey: ['settings'], queryFn: () => api.get('/api/settings') });
  const [form, setForm] = useState<SettingsShape | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  const [bName, setBName] = useState(brand.name);
  const [bInitials, setBInitials] = useState(brand.initials);
  const [bAccent, setBAccent] = useState(brand.accent);
  const [bLogo, setBLogo] = useState(brand.logoUrl || '');
  const [brandMsg, setBrandMsg] = useState<string | null>(null);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  const resyncTwilio = async () => {
    setResyncMsg('Working…');
    try {
      const r = await api.post<any>('/api/settings/resync');
      setResyncMsg(`Twilio now points at ${r.url}`);
    } catch (e: any) {
      setResyncMsg(e?.message || 'Could not update Twilio');
    }
    setTimeout(() => setResyncMsg(null), 6000);
  };

  useEffect(() => {
    setBName(brand.name);
    setBInitials(brand.initials);
    setBAccent(brand.accent);
    setBLogo(brand.logoUrl || '');
  }, [brand.name, brand.initials, brand.accent, brand.logoUrl]);

  const saveBranding = async () => {
    setBrandMsg(null);
    try {
      await saveBrand({ name: bName, initials: bInitials, accent: bAccent, logoUrl: bLogo || null });
      setBrandMsg('Branding saved');
      setTimeout(() => setBrandMsg(null), 2500);
    } catch (e: any) {
      setBrandMsg(e?.message || 'Could not save branding');
    }
  };

  useEffect(() => {
    if (data && !form)
      setForm({
        ...data,
        // Never keep a masked secret in form state — saving it back would corrupt the real one.
        twilio: { ...data.twilio, authToken: '', apiKeySecret: '' },
        telnyx: { ...data.telnyx, apiKey: '' },
        compliance: { ...COMPLIANCE_DEFAULTS, ...(data.compliance || {}) },
      });
  }, [data, form]);

  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwMsg, setPwMsg] = useState<string | null>(null);
  const changePassword = async () => {
    setPwMsg(null);
    if (pw.next !== pw.confirm) return setPwMsg('The two new passwords do not match');
    try {
      await api.post('/api/auth/password', { current: pw.current, next: pw.next });
      setPw({ current: '', next: '', confirm: '' });
      setPwMsg('Password changed. Other browsers were signed out.');
    } catch (e: any) {
      setPwMsg(e?.message || 'Could not change the password');
    }
  };

  const setComp = (patch: Partial<SettingsShape['compliance']>) =>
    setForm((f) => (f ? { ...f, compliance: { ...COMPLIANCE_DEFAULTS, ...f.compliance, ...patch } } : f));

  const comp = { ...COMPLIANCE_DEFAULTS, ...(form?.compliance || {}) };
  const days = comp.windowDays.split(',').map((d) => Number(d.trim()));
  const toggleDay = (d: number) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    setComp({ windowDays: next.sort((a, b) => a - b).join(',') });
  };

  if (!form) return <div className="p-6 text-sm text-muted">Loading…</div>;

  const setT = (k: string, v: string) => setForm({ ...form, twilio: { ...form.twilio, [k]: v } });
  const setX = (k: string, v: string) => setForm({ ...form, telnyx: { ...form.telnyx, [k]: v } });

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await api.put<any>('/api/settings', form);
      setForm({
        ...res,
        twilio: { ...res.twilio, authToken: '', apiKeySecret: '' },
        telnyx: { ...res.telnyx, apiKey: '' },
      });
      setSaved(true);
      if (res.appError) setErr(`Saved, but Twilio app setup failed: ${res.appError}`);
      qc.invalidateQueries({ queryKey: ['settings'] });
      refresh();
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setErr(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTest({ loading: true });
    try {
      const typed = form.twilio.authToken && !form.twilio.authToken.includes('•') ? form.twilio.authToken : undefined;
      const res = await api.post<any>('/api/settings/test', {
        accountSid: form.twilio.accountSid,
        authToken: typed,
        number: form.twilio.number,
      });
      setTest(res);
    } catch (e: any) {
      setTest({ ok: false, error: e?.message });
    }
  };

  return (
    <div>
      <PageHeader title="Settings" sub="Phone provider, credentials and audio">
        <button className="btn-primary !py-1.5 text-xs" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : saved ? 'Saved ✓' : 'Save changes'}
        </button>
      </PageHeader>

      <div className="max-w-3xl space-y-4 p-6">
        {err && <p className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{err}</p>}
        {(data?.warnings || []).map((w) => (
          <p key={w} className="rounded border border-amber-900/50 bg-amber-950/25 px-3 py-2 text-xs text-amber-300">
            {w}
          </p>
        ))}

        <section className="panel p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">White label</h2>
              <p className="mt-1 text-xs text-muted">
                Your product name, logo and accent colour. Applies everywhere — sidebar, login screen, browser tab and icon.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {brandMsg && <span className="text-2xs text-accent">{brandMsg}</span>}
              <button className="btn-ghost !py-1.5 text-xs" onClick={saveBranding}>
                Save branding
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Product name</label>
              <input
                className="field"
                value={bName}
                maxLength={48}
                onChange={(e) => setBName(e.target.value)}
                placeholder="Acme Dialer"
              />
            </div>
            <div>
              <label className="label">Initials (when no logo)</label>
              <input
                className="field mono"
                value={bInitials}
                maxLength={3}
                onChange={(e) => setBInitials(e.target.value.toUpperCase())}
                placeholder="AD"
              />
            </div>
            <div>
              <label className="label">Accent colour</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={bAccent}
                  onChange={(e) => setBAccent(e.target.value.toUpperCase())}
                  className="h-9 w-12 cursor-pointer rounded border border-ink-700 bg-ink-900"
                />
                <input className="field mono" value={bAccent} onChange={(e) => setBAccent(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label">Logo URL (optional)</label>
              <input
                className="field"
                value={bLogo}
                onChange={(e) => setBLogo(e.target.value)}
                placeholder="https://cdn.example.com/logo.png"
              />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3 rounded border border-ink-700 bg-ink-900 p-3">
            <div
              className="flex h-10 w-10 items-center justify-center overflow-hidden rounded"
              style={{ background: bLogo ? 'transparent' : bAccent, color: onAccent(bAccent) }}
            >
              {bLogo ? (
                <img src={bLogo} alt="" className="h-10 w-10 rounded object-cover" />
              ) : (
                <span className="text-xs font-bold">{(bInitials || 'AD').toUpperCase()}</span>
              )}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm">{bName || 'Your product'}</p>
              <p className="text-2xs text-muted">Preview — this is what the sidebar and login screen will show.</p>
            </div>
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Domain &amp; address</h2>
          <p className="mt-1 text-xs text-muted">
            Domains are handled by your host (Coolify), not by this app. The app answers on whatever domain reaches
            it, so you can point several at once.
          </p>

          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded border border-ink-700 bg-ink-900 px-3 py-2">
              <dt className="text-2xs uppercase tracking-wider text-muted">You are on</dt>
              <dd className="mono mt-0.5 truncate">{typeof window !== 'undefined' ? window.location.origin : '—'}</dd>
            </div>
            <div className="rounded border border-ink-700 bg-ink-900 px-3 py-2">
              <dt className="text-2xs uppercase tracking-wider text-muted">Twilio calls back to</dt>
              <dd className="mono mt-0.5 truncate">{brand.canonicalUrl || '—'}/api/voice/twiml</dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="btn-ghost !py-1.5 text-xs" onClick={resyncTwilio}>
              Re-sync Twilio address
            </button>
            {resyncMsg && <span className="text-2xs text-accent">{resyncMsg}</span>}
          </div>

          <p className="mt-3 text-2xs leading-relaxed text-muted">
            Add domains in Coolify under <span className="text-zinc-300">Domains</span> — separate several with a
            comma. If you set the <span className="mono text-zinc-300">PUBLIC_URL</span> environment variable, Twilio
            always uses that one fixed address; leave it unset and Twilio follows whichever domain you were on when
            you saved Settings. Hit <span className="text-zinc-300">Re-sync Twilio address</span> after changing
            domains and calls keep working.
          </p>
        </section>

        <CallerIdsPanel />

        <VoicemailPanel />

        <DataPanel />

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Phone provider</h2>
          <p className="mt-1 text-xs text-muted">Pick which service places your calls. You can switch any time.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(['twilio', 'telnyx'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setForm({ ...form, provider: p })}
                className={`rounded-md border px-3 py-3 text-left transition ${
                  form.provider === p
                    ? 'border-accent/60 bg-accent-soft'
                    : 'border-ink-700 bg-ink-900 hover:border-ink-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">{p}</span>
                  {form.provider === p && <span className="text-2xs text-accent">ACTIVE</span>}
                </div>
                <p className="mt-0.5 text-2xs text-muted">
                  {p === 'twilio' ? 'Most reliable browser calling' : 'Half the per-minute price'}
                </p>
              </button>
            ))}
          </div>
          {form.provider === 'telnyx' && (
            <p className="mt-2 rounded border border-amber-900/40 bg-amber-950/20 px-2.5 py-1.5 text-2xs text-amber-300">
              Telnyx calling is still being wired up. Keep Twilio selected for now.
            </p>
          )}
        </section>

        <section className={`panel p-4 ${form.provider !== 'twilio' ? 'opacity-60' : ''}`}>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">Twilio</h2>
            <a
              className="text-2xs text-muted hover:text-accent"
              href="https://console.twilio.com"
              target="_blank"
              rel="noreferrer"
            >
              Open Twilio console ↗
            </a>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="label">Account SID</label>
              <input
                className="field mono"
                placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                value={form.twilio.accountSid}
                onChange={(e) => setT('accountSid', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Auth Token</label>
              <input
                className="field mono"
                type="password"
                placeholder={data?.twilio.authToken || 'paste once, then it is hidden'}
                value={form.twilio.authToken}
                onChange={(e) => setT('authToken', e.target.value)}
              />
              <p className="mt-1 text-2xs text-muted">Leave blank to keep the saved token.</p>
            </div>
            <div>
              <label className="label">Caller ID number</label>
              <input
                className="field mono"
                placeholder="+15125550100"
                value={form.twilio.number}
                onChange={(e) => setT('number', e.target.value)}
              />
            </div>
            <div>
              <label className="label">TwiML app (automatic)</label>
              <input className="field mono text-muted" value={form.twilio.twimlApp || 'created when you save'} readOnly />
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button className="btn-ghost !py-1.5 text-xs" onClick={runTest}>
              Test credentials
            </button>
            {test?.loading && <span className="text-2xs text-muted">Checking…</span>}
            {test && !test.loading && (
              <span className={`text-2xs ${test.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                {test.ok ? `Connected to "${test.account}" (${test.status})` : test.error}
              </span>
            )}
            {test?.ok && form.twilio.authToken && !form.twilio.authToken.includes('•') && (
              <span className="text-2xs text-amber-400">Press “Save changes” to keep these.</span>
            )}
          </div>

          {test?.ok && test.numbers?.length > 0 && (
            <div className="mt-2 rounded border border-ink-700 bg-ink-900 p-2">
              <p className="mb-1 text-2xs uppercase tracking-wider text-muted">Numbers on this account</p>
              <div className="flex flex-wrap gap-1.5">
                {test.numbers.map((n: any) => (
                  <button
                    key={n.phone}
                    onClick={() => setT('number', n.phone)}
                    className="rounded border border-ink-700 px-2 py-1 mono text-2xs hover:border-accent/60"
                  >
                    {n.phone} {n.voice ? '' : '(no voice)'}
                  </button>
                ))}
              </div>
            </div>
          )}
        </section>

        <section className={`panel p-4 ${form.provider !== 'telnyx' ? 'opacity-60' : ''}`}>
          <h2 className="text-sm font-semibold">Telnyx</h2>
          <p className="mt-1 text-2xs text-muted">
            Create an API key in the Telnyx portal, paste it here. The SIP connection is created automatically.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="label">API key</label>
              <input
                className="field mono"
                type="password"
                placeholder={data?.telnyx.apiKey || 'KEYxxxxxxxxxxxx'}
                value={form.telnyx.apiKey}
                onChange={(e) => setX('apiKey', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Number</label>
              <input className="field mono" value={form.telnyx.number} onChange={(e) => setX('number', e.target.value)} />
            </div>
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Calling</h2>
          <div className="mt-3 space-y-3">
            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                Record calls
                <span className="block text-2xs text-muted">
                  Copied to this server after each call, then removed from Twilio.
                </span>
              </span>
              <input
                type="checkbox"
                checked={form.recordingEnabled}
                onChange={(e) => setForm({ ...form, recordingEnabled: e.target.checked })}
                className="h-4 w-4 accent-check"
              />
            </label>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                Detect voicemail
                <span className="block text-2xs text-muted">
                  Twilio listens for the first few seconds and marks machines automatically. Billed at
                  $0.0075 per call — turn it off to save that fee.
                </span>
              </span>
              <input
                type="checkbox"
                checked={form.amdEnabled}
                onChange={(e) => setForm({ ...form, amdEnabled: e.target.checked })}
                className="h-4 w-4 accent-check"
              />
            </label>

            <div>
              <label className="label">Keep the Twilio copy for (days)</label>
              <input
                className="field mono !w-24"
                type="number"
                min={0}
                max={365}
                value={form.recordingRetentionDays}
                onChange={(e) => setForm({ ...form, recordingRetentionDays: Number(e.target.value) })}
              />
              <p className="mt-1 text-2xs text-muted">
                Your own copy is never deleted. Twilio charges storage for every stored minute each month, so this
                is just a safety window — after it passes, their copy is removed.
              </p>
            </div>

            <div>
              <label className="label">Ring timeout (seconds)</label>
              <input
                className="field !w-32 mono"
                type="number"
                min={10}
                max={60}
                value={form.ringTimeoutSec}
                onChange={(e) => setForm({ ...form, ringTimeoutSec: Number(e.target.value) })}
              />
            </div>

            <div>
              <label className="label">Microphone</label>
              <select
                className="field"
                value={dialer.inputDevice}
                onChange={(e) => dialer.selectInputDevice(e.target.value)}
                onFocus={() => dialer.refreshInputs()}
              >
                {dialer.inputDevices.length === 0 && <option value="">No microphones detected yet</option>}
                {dialer.inputDevices.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-2xs text-muted">
                Bluetooth headsets connected after page load show up here — pick one and it is used without a refresh.
              </p>
            </div>
          </div>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Calling rules</h2>
          <p className="mt-1 text-xs text-muted">
            Call at any hour — there is no time-of-day restriction. Do-not-call leads are always blocked, whatever
            this says.
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="label">Max attempts per lead</label>
              <input
                type="number"
                min={0}
                className="field mono !w-32"
                value={comp.maxAttempts}
                onChange={(e) => setComp({ maxAttempts: Number(e.target.value) })}
              />
              <p className="mt-1 text-2xs text-muted">0 = unlimited</p>
            </div>
            <div>
              <label className="label">Default timezone (optional)</label>
              <input
                className="field mono"
                placeholder="America/New_York"
                value={comp.defaultTimezone}
                onChange={(e) => setComp({ defaultTimezone: e.target.value })}
              />
              <p className="mt-1 text-2xs text-muted">Used when a lead has no state.</p>
            </div>
          </div>

          <p className="mt-3 text-2xs text-muted">Save changes with the button at the top of the page.</p>
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-semibold">Change password</h2>
          <p className="mt-1 text-xs text-muted">Signing out of every other browser when you change it.</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div>
              <label className="label">Current</label>
              <input type="password" className="field" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </div>
            <div>
              <label className="label">New</label>
              <input type="password" className="field" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </div>
            <div>
              <label className="label">Confirm</label>
              <input type="password" className="field" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button className="btn-ghost !py-1.5 text-xs" onClick={changePassword} disabled={!pw.current || !pw.next}>
              Update password
            </button>
            {pwMsg && <span className="text-2xs text-accent">{pwMsg}</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
