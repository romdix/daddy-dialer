import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Leads } from './Leads';
import { CallerIdsPanel } from '../components/CallerIdsPanel';
import { VoicemailPanel } from '../components/VoicemailPanel';
import { DataPanel } from '../components/DataPanel';
import { OUTCOME_LABEL, STATUS_LABEL } from '../lib/format';

/* ------------------------------------------------------------------ *
 * data helpers
 * ------------------------------------------------------------------ */

async function j<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}
const post = (p: string, b?: any) => j(p, { method: 'POST', body: JSON.stringify(b ?? {}) });
const patch = (p: string, b: any) => j(p, { method: 'PATCH', body: JSON.stringify(b) });
const del = (p: string) => j(p, { method: 'DELETE' });

/* ------------------------------------------------------------------ *
 * small pieces
 * ------------------------------------------------------------------ */

function initials(name?: string | null, email?: string | null) {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
}

function Avatar({ name, email, size = 36 }: { name?: string | null; email?: string | null; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full border border-ink-600 bg-ink-800 font-medium text-zinc-300"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials(name, email)}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-2xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mt-1 mono text-xl text-zinc-100">{value}</p>
      {hint && <p className="mt-0.5 text-2xs text-zinc-600">{hint}</p>}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start justify-between gap-4 py-3 ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <span>
        <span className="block text-sm text-zinc-200">{label}</span>
        {hint && <span className="mt-0.5 block text-2xs text-muted">{hint}</span>}
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-accent/60 bg-accent/30' : 'border-ink-600 bg-ink-800'
        }`}
        aria-pressed={checked}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-all ${
            checked ? 'left-[18px] bg-accent' : 'left-0.5 bg-zinc-500'
          }`}
        />
      </button>
    </label>
  );
}

function Pill({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'ok' | 'off' | 'warn' | 'muted' }) {
  const tones: Record<string, string> = {
    ok: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
    off: 'border-ink-600 bg-ink-800 text-zinc-400',
    warn: 'border-amber-800/60 bg-amber-950/30 text-amber-300',
    muted: 'border-ink-700 bg-ink-900 text-zinc-400',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-2xs ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Bars({
  data,
  selected,
  onPick,
}: {
  data: { day: string; calls: number; answered: number }[];
  selected?: string;
  onPick?: (day: string) => void;
}) {
  const max = Math.max(1, ...data.map((d) => d.calls));
  return (
    <div className="flex h-32 items-end gap-1.5">
      {data.map((d) => (
        <button
          key={d.day}
          type="button"
          onClick={() => onPick?.(d.day)}
          className={`group relative flex h-full flex-1 flex-col justify-end gap-0.5 rounded-sm px-0.5 transition-colors ${
            selected === d.day ? 'bg-ink-800' : 'hover:bg-ink-800/60'
          }`}
          title={`${fmtDay(d.day)} — ${d.calls} calls, ${d.answered} answered`}
        >
          <div
            className="relative w-full rounded-t-sm bg-ink-700/70"
            style={{ height: `${(d.calls / max) * 100}%`, minHeight: d.calls ? 3 : 1 }}
          >
            <div
              className="absolute bottom-0 w-full rounded-t-sm bg-accent/70"
              style={{ height: d.calls ? `${(d.answered / d.calls) * 100}%` : 0 }}
            />
          </div>
        </button>
      ))}
    </div>
  );
}

const fmtTalk = (sec: number) => {
  const s = Number(sec || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/** Every admin timestamp is shown in the business timezone, not the viewer's laptop. */
const fmtNY = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const nyToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

const fmtDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
};

/* ------------------------------------------------------------------ *
 * admin shell
 * ------------------------------------------------------------------ */

type Session = { configured: boolean; signedIn: boolean };
type View =
  | { kind: 'overview' }
  | { kind: 'users' }
  | { kind: 'user'; id: string }
  | { kind: 'calls' }
  | { kind: 'settings' };

export function Admin() {
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<View>({ kind: 'overview' });

  const loadSession = useCallback(async () => {
    try {
      setSession(await j<Session>('/api/admin/session'));
    } catch {
      setSession({ configured: false, signedIn: false });
    }
  }, []);

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (!session) return <Splash />;

  if (!session.configured) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="panel max-w-md p-6">
          <h1 className="text-sm font-semibold">Admin is not configured</h1>
          <p className="mt-2 text-xs text-muted">
            Set <span className="mono text-zinc-300">ADMIN_USERNAME</span> and{' '}
            <span className="mono text-zinc-300">ADMIN_PASSWORD</span> on the server, then redeploy.
          </p>
        </div>
      </div>
    );
  }

  if (!session.signedIn) return <AdminLogin onDone={loadSession} />;

  const signOut = async () => {
    await post('/api/admin/logout');
    setView({ kind: 'overview' });
    loadSession();
  };

  const nav: { key: View['kind']; label: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'users', label: 'Users' },
    { key: 'calls', label: 'Calls' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded bg-accent/15 text-2xs font-bold text-accent">
              A
            </div>
            <span className="text-sm font-semibold tracking-tight">Admin</span>
          </div>

          <nav className="flex items-center gap-1">
            {nav.map((n) => (
              <button
                key={n.key}
                onClick={() => setView({ kind: n.key } as View)}
                className={`rounded px-3 py-1.5 text-xs transition-colors ${
                  view.kind === n.key || (n.key === 'users' && view.kind === 'user')
                    ? 'bg-ink-800 text-zinc-100'
                    : 'text-muted hover:text-zinc-200'
                }`}
              >
                {n.label}
              </button>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <a href="/" className="text-xs text-muted hover:text-zinc-200">
              Open dialer ↗
            </a>
            <button className="btn-ghost !py-1.5 text-xs" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {view.kind === 'overview' && <Overview onOpenUser={(id) => setView({ kind: 'user', id })} />}
        {view.kind === 'users' && (
          <Users onOpenUser={(id) => setView({ kind: 'user', id })} onChanged={loadSession} />
        )}
        {view.kind === 'user' && <UserPage id={view.id} onBack={() => setView({ kind: 'users' })} />}
        {view.kind === 'calls' && <Calls />}
        {view.kind === 'settings' && <AdminSettings />}
      </main>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-muted">
      <span className="mr-2 h-3 w-3 animate-spin rounded-full border-2 border-zinc-700 border-t-accent" />
      Loading…
    </div>
  );
}

function AdminLogin({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/api/admin/login', { username, password });
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6">
        <h1 className="text-base font-semibold">Admin sign in</h1>
        <p className="mt-1 text-xs text-muted">Platform administration for this dialer.</p>

        <div className="mt-5 space-y-3">
          <div>
            <label className="label">Username</label>
            <input
              className="field"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
            />
          </div>
          <div>
            <label className="label">Password</label>
            <input
              className="field"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <button className="btn-primary mt-5 w-full !py-2 text-sm" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * overview
 * ------------------------------------------------------------------ */

function Overview({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    j('/api/admin/overview').then(setData).catch(() => setData({ users: [], totals: {} }));
  }, []);

  if (!data) return <Splash />;
  const t = data.totals || {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Overview</h1>
        <p className="mt-0.5 text-xs text-muted">Everyone on the phones and what they have done.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Team" value={data.users.length} hint={`${data.users.filter((u: any) => u.isActive).length} active`} />
        <Stat label="Leads" value={(t.leads || 0).toLocaleString()} hint={`${t.unassigned || 0} unassigned`} />
        <Stat label="Calls today" value={(t.calls_today || 0).toLocaleString()} />
        <Stat label="Calls this month" value={(t.calls_month || 0).toLocaleString()} />
      </div>

      <UserTable rows={data.users} onOpenUser={onOpenUser} />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * users
 * ------------------------------------------------------------------ */

function UserTable({ rows, onOpenUser }: { rows: any[]; onOpenUser: (id: string) => void }) {
  const [q, setQ] = useState('');
  const filtered = useMemo(
    () =>
      rows.filter((u) =>
        `${u.fullName || ''} ${u.email}`.toLowerCase().includes(q.trim().toLowerCase()),
      ),
    [rows, q],
  );

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
        <h2 className="text-sm font-semibold">Team</h2>
        <input
          className="field !w-56 !py-1.5 text-xs"
          placeholder="Search name or email"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-ink-900">
            <tr>
              <th className="th">Person</th>
              <th className="th">Status</th>
              <th className="th text-right">Today</th>
              <th className="th text-right">7 days</th>
              <th className="th text-right">Answer %</th>
              <th className="th text-right">Leads</th>
              <th className="th">Last call</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const rate = u.callsMonth ? Math.round((u.answeredMonth / u.callsMonth) * 100) : 0;
              return (
                <tr key={u.id} className="cursor-pointer hover:bg-ink-800/40" onClick={() => onOpenUser(u.id)}>
                  <td className="td">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={u.fullName} email={u.email} size={30} />
                      <div className="min-w-0">
                        <p className="truncate text-zinc-200">{u.fullName || 'Unnamed'}</p>
                        <p className="truncate text-2xs text-muted">{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="td">
                    {u.deletedAt ? (
                      <Pill tone="muted">deleted</Pill>
                    ) : u.isActive ? (
                      <Pill tone="ok">active</Pill>
                    ) : (
                      <Pill tone="off">disabled</Pill>
                    )}
                  </td>
                  <td className="td text-right mono">{u.callsToday}</td>
                  <td className="td text-right mono text-zinc-400">{u.callsWeek}</td>
                  <td className="td text-right mono text-zinc-400">{rate}%</td>
                  <td className="td text-right mono text-zinc-400">{u.leadsAssigned}</td>
                  <td className="td text-2xs text-zinc-500">{u.lastCallAt ? fmtNY(u.lastCallAt) : '—'}</td>
                  <td className="td text-right text-muted">→</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && <p className="px-4 py-10 text-center text-xs text-muted">Nobody matches that search.</p>}
    </div>
  );
}

function Users({ onOpenUser, onChanged }: { onOpenUser: (id: string) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const load = useCallback(() => {
    j(`/api/admin/users${showDeleted ? '?includeDeleted=1' : ''}`)
      .then((d) => setRows(d.rows))
      .catch(() => setRows([]));
  }, [showDeleted]);
  useEffect(load, [load]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Users</h1>
          <p className="mt-0.5 text-xs text-muted">Create people, set their permissions, open their leads.</p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
              className="accent-check"
            />
            show deleted
          </label>
          <button className="btn-primary !py-2 text-xs" onClick={() => setAdding(true)}>
            New user
          </button>
        </div>
      </div>

      {rows ? <UserTable rows={rows} onOpenUser={onOpenUser} /> : <Splash />}

      {adding && (
        <NewUserDialog
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            load();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function NewUserDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ fullName: '', email: '', password: '', canUploadLeads: false, canHearRecordings: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await post('/api/admin/users', form);
      onDone();
    } catch (e: any) {
      setError(e?.message || 'Could not create the user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="panel w-full max-w-lg p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold">New user</h2>
        <p className="mt-1 text-xs text-muted">They sign in with this email and password.</p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">Full name</label>
            <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="field" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <label className="label">Temporary password</label>
            <input
              className="field"
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="at least 8 characters"
            />
          </div>
        </div>

        <div className="mt-3 divide-y divide-ink-800 border-y border-ink-800">
          <Toggle
            checked={form.canUploadLeads}
            onChange={(v) => setForm({ ...form, canUploadLeads: v })}
            label="Can upload leads"
            hint="Shows the Import CSV button in their leads page."
          />
          <Toggle
            checked={form.canHearRecordings}
            onChange={(v) => setForm({ ...form, canHearRecordings: v })}
            label="Can listen to recordings"
            hint="No download button either way."
          />
        </div>

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * one user
 * ------------------------------------------------------------------ */

function UserPage({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'leads' | 'settings' | 'calls'>('overview');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    j(`/api/admin/users/${id}`)
      .then(setData)
      .catch((e) => setError(e?.message || 'Could not load the user'));
  }, [id]);

  useEffect(load, [load]);

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (!data) return <Splash />;

  const u = data.user;
  const answerRate = u.callsMonth ? Math.round((u.answeredMonth / u.callsMonth) * 100) : 0;

  return (
    <div className="space-y-5">
      <button className="text-xs text-muted hover:text-accent" onClick={onBack}>
        ← All users
      </button>

      <div className="panel flex flex-wrap items-center gap-4 p-5">
        <Avatar name={u.fullName} email={u.email} size={52} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-lg font-semibold tracking-tight">{u.fullName || 'Unnamed user'}</h1>
            {u.deletedAt ? (
              <Pill tone="muted">deleted</Pill>
            ) : u.isActive ? (
              <Pill tone="ok">active</Pill>
            ) : (
              <Pill tone="off">disabled</Pill>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted">{u.email}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill tone={u.canUploadLeads ? 'ok' : 'muted'}>{u.canUploadLeads ? 'can upload leads' : 'no uploads'}</Pill>
            <Pill tone={u.canHearRecordings ? 'ok' : 'muted'}>
              {u.canHearRecordings ? 'can hear recordings' : 'no recordings'}
            </Pill>
            <Pill tone="muted">{u.leadsAssigned} leads</Pill>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xs uppercase tracking-wider text-muted">Last call</p>
          <p className="mt-0.5 text-xs text-zinc-300">{u.lastCallAt ? fmtNY(u.lastCallAt) : 'never'}</p>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Stat label="Calls today" value={u.callsToday} />
        <Stat label="7 days" value={u.callsWeek} />
        <Stat label="30 days" value={u.callsMonth} />
        <Stat label="Answer rate" value={`${answerRate}%`} hint={`${u.answeredMonth} answered`} />
        <Stat label="Conversations" value={u.connectsMonth} hint="30 days" />
        <Stat label="Talk time" value={fmtTalk(u.talkSecMonth)} hint="30 days" />
      </div>

      <div className="flex gap-1 border-b border-ink-800">
        {[
          ['overview', 'Overview'],
          ['leads', 'Assigned leads'],
          ['settings', 'Settings & permissions'],
          ['calls', 'Call history'],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k as any)}
            className={`-mb-px border-b-2 px-3 py-2 text-xs transition-colors ${
              tab === k ? 'border-accent text-zinc-100' : 'border-transparent text-muted hover:text-zinc-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <UserOverview data={data} userId={u.id} />}
      {tab === 'leads' && <Leads asUserId={u.id} />}
      {tab === 'settings' && <UserSettings user={u} onSaved={load} />}
      {tab === 'calls' && <UserCalls userId={u.id} />}
    </div>
  );
}

function UserOverview({ data, userId }: { data: any; userId: string }) {
  const outcomes: any[] = data.outcomes || [];
  const statuses: any[] = data.statuses || [];
  const totalOutcomes = outcomes.reduce((s, o) => s + o.count, 0) || 1;

  const [day, setDay] = useState<string>(nyToday());
  const [dayData, setDayData] = useState<any>(null);
  const [dayBusy, setDayBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setDayBusy(true);
    j(`/api/admin/users/${userId}/day?date=${day}`)
      .then((d) => alive && setDayData(d))
      .catch(() => alive && setDayData(null))
      .finally(() => alive && setDayBusy(false));
    return () => {
      alive = false;
    };
  }, [userId, day]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="panel p-4 lg:col-span-2">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Last 14 days</h2>
          <div className="flex items-center gap-3 text-2xs text-muted">
            <span className="rounded border border-ink-700 px-1.5 py-0.5">New York time</span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-ink-700" /> calls
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-sm bg-accent/70" /> answered
            </span>
          </div>
        </div>
        <Bars data={data.daily || []} selected={day} onPick={setDay} />
        <div className="mt-2 flex justify-between text-2xs text-zinc-600">
          <span>{data.daily?.[0]?.day ? fmtDay(data.daily[0].day) : ''}</span>
          <span>{data.daily?.length ? fmtDay(data.daily[data.daily.length - 1].day) : ''}</span>
        </div>
        <p className="mt-2 text-2xs text-zinc-600">Click a bar to see that day.</p>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold">Lead status</h2>
        <ul className="mt-3 space-y-2">
          {statuses.length === 0 && <li className="text-xs text-muted">No leads assigned yet.</li>}
          {statuses.map((s) => (
            <li key={s.status} className="flex items-center justify-between text-xs">
              <span className="text-zinc-400">{STATUS_LABEL[s.status] || s.status}</span>
              <span className="mono text-zinc-200">{s.count}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel p-4 lg:col-span-2">
        <h2 className="text-sm font-semibold">Outcomes · 30 days</h2>
        <ul className="mt-3 space-y-2">
          {outcomes.length === 0 && <li className="text-xs text-muted">No calls in the last 30 days.</li>}
          {outcomes.map((o) => (
            <li key={o.outcome} className="text-xs">
              <div className="flex items-center justify-between">
                <span className="text-zinc-400">{o.outcome === 'none' ? 'No outcome' : OUTCOME_LABEL[o.outcome] || o.outcome}</span>
                <span className="mono text-zinc-300">{o.count}</span>
              </div>
              <div className="mt-1 h-1 rounded bg-ink-800">
                <div className="h-1 rounded bg-accent/60" style={{ width: `${(o.count / totalOutcomes) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold">Recent leads</h2>
        <ul className="mt-2 divide-y divide-ink-800">
          {(data.recentLeads || []).map((l: any) => (
            <li key={l.id} className="py-2">
              <p className="truncate text-xs text-zinc-300">{l.business_name || 'Unnamed'}</p>
              <p className="text-2xs text-muted">
                <span className="mono">{l.phone}</span>
                {l.city ? ` · ${l.city}` : ''}
              </p>
            </li>
          ))}
          {(data.recentLeads || []).length === 0 && <li className="py-2 text-xs text-muted">Nothing yet.</li>}
        </ul>
      </div>

      <div className="panel p-4 lg:col-span-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Day detail</h2>
            <p className="mt-0.5 text-2xs text-muted">
              One calendar day in <span className="text-zinc-400">New York time</span>. Pick any date.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-ghost !py-1 text-2xs" onClick={() => setDay(nyToday())}>
              Today
            </button>
            <input
              type="date"
              className="field mono !w-auto !py-1.5 text-xs"
              value={day}
              max={nyToday()}
              onChange={(e) => setDay(e.target.value || nyToday())}
            />
          </div>
        </div>

        {dayBusy && <p className="mt-4 text-xs text-muted">Loading…</p>}

        {!dayBusy && dayData && (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Stat label="Calls" value={dayData.summary.calls} />
              <Stat label="Answered" value={dayData.summary.answered} hint={`${dayData.summary.answerRate}% answer rate`} />
              <Stat label="Conversations" value={dayData.summary.connects} />
              <Stat label="Talk time" value={fmtTalk(dayData.summary.talkSec)} />
              <Stat label="Avg call" value={dayData.summary.avgSec ? fmtTalk(dayData.summary.avgSec) : '—'} />
            </div>

            {dayData.outcomes?.length > 0 && (
              <div className="mt-4">
                <p className="text-2xs uppercase tracking-wider text-muted">Outcomes</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {dayData.outcomes.map((o: any) => (
                    <Pill key={o.outcome} tone="muted">
                      {o.outcome === 'none' ? 'no outcome' : OUTCOME_LABEL[o.outcome] || o.outcome} · {o.count}
                    </Pill>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-4 overflow-hidden rounded border border-ink-800">
              <CallTable data={{ rows: dayData.calls || [] }} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function UserSettings({ user, onSaved }: { user: any; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [callerIds, setCallerIds] = useState<string[]>([]);

  useEffect(() => {
    j('/api/caller-ids')
      .then((d: any) => {
        const rows = Array.isArray(d) ? d : d.rows || [];
        setCallerIds(rows.filter((r: any) => r.active !== false).map((r: any) => r.number));
      })
      .catch(() => setCallerIds([]));
  }, []);

  const save = async (body: any, note = 'Saved') => {
    setSaving(true);
    setMsg(null);
    try {
      await patch(`/api/admin/users/${user.id}`, body);
      setMsg(note);
      onSaved();
    } catch (e: any) {
      setMsg(e?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="panel p-4">
        <h2 className="text-sm font-semibold">Permissions</h2>
        <p className="mt-0.5 text-2xs text-muted">Everything else in the dialer is read-only for this person.</p>
        <div className="mt-2 divide-y divide-ink-800">
          <Toggle
            checked={Boolean(user.canUploadLeads)}
            onChange={(v) => save({ canUploadLeads: v }, v ? 'Uploads allowed' : 'Uploads revoked')}
            label="Upload leads"
            hint="Import CSV on their leads page."
            disabled={saving}
          />
          <Toggle
            checked={Boolean(user.canHearRecordings)}
            onChange={(v) => save({ canHearRecordings: v }, v ? 'Recordings allowed' : 'Recordings revoked')}
            label="Listen to recordings"
            hint="Playback only — there is no download button."
            disabled={saving}
          />
          <Toggle
            checked={Boolean(user.isActive)}
            onChange={(v) => save({ isActive: v }, v ? 'Account enabled' : 'Account disabled')}
            label="Account active"
            hint="Disabled users are signed out and cannot log in."
            disabled={saving}
          />
        </div>
      </div>

      <div className="panel p-4">
        <h2 className="text-sm font-semibold">Dialing</h2>
        <p className="mt-0.5 text-2xs text-muted">Optional per-person overrides. Blank means the team default.</p>

        <div className="mt-3 space-y-3">
          <div>
            <label className="label">Caller ID</label>
            <select
              className="field"
              value={user.callerId || ''}
              onChange={(e) => save({ callerId: e.target.value }, 'Caller ID updated')}
              disabled={saving}
            >
              <option value="">Team default (rotate)</option>
              {callerIds.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Parallel lines</label>
            <select
              className="field"
              value={String(user.parallelLines || 1)}
              onChange={(e) => save({ parallelLines: Number(e.target.value) }, 'Line count updated')}
              disabled={saving}
            >
              <option value="1">1 — one at a time</option>
              <option value="2">2 — two at a time</option>
              <option value="3">3 — three at a time</option>
            </select>
          </div>

          <div>
            <label className="label">Reset password</label>
            <div className="flex gap-2">
              <input
                className="field flex-1"
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="new password, min 8 characters"
              />
              <button
                className="btn-ghost !py-1.5 text-xs"
                disabled={password.length < 8 || saving}
                onClick={async () => {
                  await save({ password }, 'Password reset — they must sign in again');
                  setPassword('');
                }}
              >
                Set
              </button>
            </div>
          </div>
        </div>

        {msg && <p className="mt-3 text-2xs text-accent">{msg}</p>}
      </div>

      <div className="panel border-red-950/60 p-4 lg:col-span-2">
        <h2 className="text-sm font-semibold text-red-300">Danger zone</h2>
        <p className="mt-1 text-2xs text-muted">
          Deleting signs them out and hides the account. Their name stays on past calls, and their leads stay with
          them — out of the way, not handed to anyone else.
        </p>
        {user.deletedAt ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Pill tone="muted">deleted {fmtNY(user.deletedAt)}</Pill>
            <button
              className="btn-ghost !py-1.5 text-xs"
              onClick={async () => {
                await post(`/api/admin/users/${user.id}/restore`);
                window.location.reload();
              }}
            >
              Restore account
            </button>
          </div>
        ) : (
          <button
            className="btn-ghost mt-3 !border-red-900/60 !py-1.5 text-xs !text-red-300"
            onClick={async () => {
              if (!confirm(`Delete ${user.email}? They are signed out and the account is hidden.`)) return;
              await del(`/api/admin/users/${user.id}`);
              window.location.reload();
            }}
          >
            Delete this user
          </button>
        )}
      </div>
    </div>
  );
}

function UserCalls({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    j(`/api/admin/calls?userId=${userId}&page=${page}&limit=25&search=${encodeURIComponent(search)}`)
      .then(setData)
      .catch(() => setData({ rows: [], total: 0, pages: 1 }));
  }, [userId, page, search]);

  return (
    <div className="panel overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-3">
        <h2 className="text-sm font-semibold">Call history</h2>
        <input
          className="field !w-56 !py-1.5 text-xs"
          placeholder="Search number or business"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </div>
      <CallTable data={data} />
      {data && data.pages > 1 && (
        <div className="flex items-center justify-between border-t border-ink-800 px-4 py-3 text-2xs text-muted">
          <span>
            Page {data.page} of {data.pages} · {data.total} calls
          </span>
          <div className="flex gap-2">
            <button className="btn-ghost !py-1 text-2xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <button className="btn-ghost !py-1 text-2xs" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CallTable({ data }: { data: any }) {
  const [open, setOpen] = useState<string | null>(null);

  if (!data) return <div className="p-6 text-xs text-muted">Loading…</div>;
  if (!data.rows?.length) return <div className="p-10 text-center text-xs text-muted">No calls recorded.</div>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-ink-900">
          <tr>
            <th className="th">When (NY)</th>
            <th className="th">Business</th>
            <th className="th">Number</th>
            <th className="th">Result</th>
            <th className="th text-right">Duration</th>
            <th className="th">Person</th>
            <th className="th text-right">Recording</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((c: any) => (
            <Fragment key={c.id}>
              <tr>
                <td className="td whitespace-nowrap text-2xs text-zinc-500">{fmtNY(c.called_at)}</td>
                <td className="td max-w-[220px] truncate">
                  {c.business_name || <span className="text-zinc-600">—</span>}
                </td>
                <td className="td mono text-zinc-400">{c.to_number}</td>
                <td className="td">
                  {c.outcome ? (
                    <Pill tone="muted">{OUTCOME_LABEL[c.outcome] || c.outcome}</Pill>
                  ) : (
                    <span className="text-2xs text-zinc-600">{c.status}</span>
                  )}
                </td>
                <td className="td text-right mono text-zinc-400">{c.duration_sec ? fmtTalk(c.duration_sec) : '—'}</td>
                <td className="td text-2xs text-zinc-500">
                  {c.user_email ? (
                    <>
                      {c.user_email}
                      {c.user_deleted && <span className="text-zinc-600"> (deleted)</span>}
                    </>
                  ) : (
                    <span className="text-zinc-600">(Deleted user)</span>
                  )}
                </td>
                <td className="td text-right whitespace-nowrap">
                  {c.recording_sid || c.recording_path ? (
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="btn-ghost !px-2 !py-1 text-2xs"
                        onClick={() => setOpen(open === c.id ? null : c.id)}
                      >
                        {open === c.id ? 'Hide' : 'Play'}
                      </button>
                      <a
                        className="btn-ghost !px-2 !py-1 text-2xs"
                        href={`/api/admin/calls/${c.id}/recording?download=1`}
                        download
                      >
                        Download
                      </a>
                    </div>
                  ) : (
                    <span className="text-2xs text-zinc-700">—</span>
                  )}
                </td>
              </tr>
              {open === c.id && (
                <tr>
                  <td colSpan={7} className="bg-ink-900/70 px-4 py-2">
                    <audio controls autoPlay preload="none" className="w-full max-w-xl" src={`/api/admin/calls/${c.id}/recording`} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Calls() {
  const [users, setUsers] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    j('/api/admin/users').then((d) => setUsers(d.rows)).catch(() => setUsers([]));
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    j(
      `/api/admin/calls?page=${page}&limit=25${userId ? `&userId=${userId}` : ''}${
        search ? `&search=${encodeURIComponent(search)}` : ''
      }`,
    )
      .then(setData)
      .catch(() => setData({ rows: [], total: 0, pages: 1 }));
  }, [page, userId, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Calls</h1>
          <p className="mt-0.5 text-xs text-muted">Every call across the team, times in New York.</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            className="field !w-64 !py-1.5 text-xs"
            placeholder="Search business or number"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Everyone</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName || u.email}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <CallTable data={data} />
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between border-t border-ink-800 px-4 py-3 text-2xs text-muted">
            <span>
              Page {data.page} of {data.pages} · {data.total} calls
            </span>
            <div className="flex gap-2">
              <button className="btn-ghost !py-1 text-2xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <button className="btn-ghost !py-1 text-2xs" disabled={page >= data.pages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * workspace settings
 * ------------------------------------------------------------------ */

function AdminSettings() {
  const [s, setS] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    j('/api/settings').then(setS).catch(() => setS(null));
  }, []);

  if (!s) return <Splash />;

  const set = (path: string, v: any) => {
    const parts = path.split('.');
    setS((prev: any) => {
      const next = JSON.parse(JSON.stringify(prev));
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
      cur[parts[parts.length - 1]] = v;
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(s),
      }).then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || 'Save failed');
      });
      const fresh = await j('/api/settings');
      setS(fresh);
      setMsg('Saved');
    } catch (e: any) {
      setMsg(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
          <p className="mt-0.5 text-xs text-muted">Shared by everyone. Staff cannot change these.</p>
        </div>
        <button className="btn-primary !py-2 text-xs" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      {msg && <p className="text-xs text-accent">{msg}</p>}
      {s.warnings?.map((w: string) => (
        <p key={w} className="rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          {w}
        </p>
      ))}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Twilio</h2>
          <div className="mt-3 space-y-3">
            <div>
              <label className="label">Account SID</label>
              <input className="field mono" value={s.twilio.accountSid} onChange={(e) => set('twilio.accountSid', e.target.value)} />
            </div>
            <div>
              <label className="label">Auth token</label>
              <input
                className="field mono"
                type="password"
                value={s.twilio.authToken}
                onFocus={(e) => {
                  if (e.target.value.includes('•')) set('twilio.authToken', '');
                }}
                onChange={(e) => set('twilio.authToken', e.target.value)}
                placeholder="leave blank to keep the saved token"
              />
            </div>
            <div>
              <label className="label">Voice number</label>
              <input className="field mono" value={s.twilio.number} onChange={(e) => set('twilio.number', e.target.value)} />
            </div>
          </div>
        </div>

        <div className="panel p-4">
          <h2 className="text-sm font-semibold">Dialing defaults</h2>
          <div className="mt-2 divide-y divide-ink-800">
            <Toggle checked={s.recordingEnabled} onChange={(v) => set('recordingEnabled', v)} label="Record calls" />
            <Toggle
              checked={s.amdEnabled}
              onChange={(v) => set('amdEnabled', v)}
              label="Voicemail detection"
              hint="Adds about $0.0075 per call."
            />
            <Toggle
              checked={s.localPresenceEnabled}
              onChange={(v) => set('localPresenceEnabled', v)}
              label="Local presence"
              hint="Prefer a caller ID in the lead's area code."
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="label">Recording retention (days)</label>
              <input
                className="field mono"
                type="number"
                min={1}
                value={s.recordingRetentionDays}
                onChange={(e) => set('recordingRetentionDays', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label">Ring timeout (seconds)</label>
              <input
                className="field mono"
                type="number"
                min={10}
                max={90}
                value={s.ringTimeoutSec}
                onChange={(e) => set('ringTimeoutSec', Number(e.target.value))}
              />
            </div>
            <div>
              <label className="label">Parallel lines (team default)</label>
              <select className="field" value={String(s.parallelLines)} onChange={(e) => set('parallelLines', Number(e.target.value))}>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      <CallerIdsPanel />
      <VoicemailPanel />
      <DataPanel />
    </div>
  );
}
