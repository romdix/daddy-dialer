import { useCallback, useEffect, useState } from 'react';
import { CallerIdsPanel } from '../components/CallerIdsPanel';
import { VoicemailPanel } from '../components/VoicemailPanel';
import { DataPanel } from '../components/DataPanel';

function Label({ children }: { children: React.ReactNode }) {
  return <label className="label">{children}</label>;
}

/* ------------------------------------------------------------------ *
 * Tiny fetch helper — admin endpoints use their own cookie.
 * ------------------------------------------------------------------ */

async function adminApi<T = any>(path: string, init?: { method?: string; body?: any }): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    method: init?.method || 'GET',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

interface UserRow {
  id: string;
  email: string;
  fullName: string | null;
  isActive: boolean;
  canUploadLeads: boolean;
  canHearRecordings: boolean;
  callerId: string | null;
  parallelLines: number;
  leadsAssigned: number;
  callsToday: number;
  callsWeek: number;
  callsMonth: number;
  connectsMonth: number;
  lastCallAt: string | null;
  createdAt: string;
}

const fmt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function Admin() {
  const [session, setSession] = useState<{ configured: boolean; signedIn: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'users' | 'leads' | 'calls' | 'settings'>('overview');
  const [openUser, setOpenUser] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const s = await fetch('/api/admin/session', { credentials: 'include' }).then((r) => r.json());
      setSession(s);
    } catch {
      setSession({ configured: false, signedIn: false });
    }
  }, []);

  useEffect(() => {
    check();
  }, [check]);

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await adminApi('/login', { method: 'POST', body: { username: email, password } });
      await check();
    } catch (e: any) {
      setErr(e?.message || 'Could not sign in');
    }
  };

  if (!session) return <div className="p-10 text-sm text-muted">Loading…</div>;

  if (!session.configured) {
    return (
      <div className="mx-auto max-w-lg p-10">
        <div className="panel p-5">
          <h1 className="text-sm font-semibold">Admin login is not configured</h1>
          <p className="mt-2 text-xs text-muted">
            Set <span className="mono">ADMIN_USERNAME</span> and <span className="mono">ADMIN_PASSWORD</span> in your
            host's environment (Coolify → this app → Environment Variables), redeploy, then reload this page.
          </p>
        </div>
      </div>
    );
  }

  if (!session.signedIn) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="panel p-5">
            <h1 className="text-sm font-semibold">Administrator</h1>
            <p className="mt-1 text-xs text-muted">Manage users, leads and settings.</p>
            <form onSubmit={login} className="mt-4 space-y-3">
              <div>
                <Label>Username</Label>
                <input className="field" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
              </div>
              <div>
                <Label>Password</Label>
                <input
                  className="field"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              {err && <p className="rounded border border-red-900/50 bg-red-950/30 px-2.5 py-2 text-xs text-red-300">{err}</p>}
              <button className="btn-primary w-full">Sign in</button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center gap-4 border-b border-ink-800 px-6 py-3">
        <span className="text-sm font-semibold">Administrator</span>
        <nav className="flex gap-1">
          {(['overview', 'users', 'leads', 'calls', 'settings'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setOpenUser(null);
              }}
              className={`rounded px-3 py-1.5 text-xs capitalize ${
                tab === t ? 'bg-ink-800 text-white' : 'text-muted hover:text-white'
              }`}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <a href="/" className="text-2xs text-muted hover:text-accent">
            Open dialer ↗
          </a>
          <button
            className="text-2xs text-muted hover:text-red-400"
            onClick={async () => {
              await adminApi('/logout', { method: 'POST' });
              check();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="p-6">
        {tab === 'overview' && <Overview onOpenUser={(id) => { setOpenUser(id); setTab('users'); }} />}
        {tab === 'users' && <Users openUserId={openUser} setOpenUserId={setOpenUser} />}
        {tab === 'leads' && <Leads />}
        {tab === 'calls' && <Calls />}
        {tab === 'settings' && <AdminSettings />}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-2xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mono mt-1 text-xl">{value}</p>
    </div>
  );
}

function Overview({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const [data, setData] = useState<{ users: UserRow[]; totals: any } | null>(null);

  useEffect(() => {
    adminApi('/overview').then(setData).catch(() => setData({ users: [], totals: {} }));
  }, []);

  if (!data) return <p className="text-sm text-muted">Loading…</p>;

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Users" value={data.users.length} />
        <Stat label="Leads" value={data.totals?.leads ?? 0} />
        <Stat label="Unassigned leads" value={data.totals?.unassigned ?? 0} />
        <Stat label="Calls today" value={data.totals?.calls_today ?? 0} />
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-2xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-right">Leads</th>
              <th className="px-3 py-2 text-right">Today</th>
              <th className="px-3 py-2 text-right">Week</th>
              <th className="px-3 py-2 text-right">Month</th>
              <th className="px-3 py-2 text-right">Connects</th>
              <th className="px-3 py-2 text-left">Last call</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id} className="border-t border-ink-800 hover:bg-ink-900/60 cursor-pointer" onClick={() => onOpenUser(u.id)}>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`h-1.5 w-1.5 rounded-full ${u.isActive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                    <span>{u.fullName || u.email}</span>
                    <span className="text-2xs text-muted">{u.email}</span>
                  </div>
                </td>
                <td className="px-3 py-2 text-right mono">{u.leadsAssigned}</td>
                <td className="px-3 py-2 text-right mono">{u.callsToday}</td>
                <td className="px-3 py-2 text-right mono">{u.callsWeek}</td>
                <td className="px-3 py-2 text-right mono">{u.callsMonth}</td>
                <td className="px-3 py-2 text-right mono">
                  {u.connectsMonth} <span className="text-2xs text-muted">({pct(u.connectsMonth, u.callsMonth)}%)</span>
                </td>
                <td className="px-3 py-2 text-2xs text-muted">{fmt(u.lastCallAt)}</td>
              </tr>
            ))}
            {!data.users.length && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-xs text-muted">
                  No users yet — create one in the Users tab.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Users({ openUserId, setOpenUserId }: { openUserId: string | null; setOpenUserId: (v: string | null) => void }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    adminApi<{ rows: UserRow[] }>('/users').then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (!openUserId) {
      setDetail(null);
      return;
    }
    adminApi(`/users/${openUserId}`).then(setDetail).catch(() => setDetail(null));
  }, [openUserId]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Users</h2>
        <button className="btn-primary !py-1.5 text-xs" onClick={() => setCreating(true)}>
          New user
        </button>
      </div>

      {msg && <p className="text-2xs text-accent">{msg}</p>}

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-2xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Permissions</th>
              <th className="px-3 py-2 text-right">Leads</th>
              <th className="px-3 py-2 text-right">Calls (month)</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} className="border-t border-ink-800 hover:bg-ink-900/60 cursor-pointer" onClick={() => setOpenUserId(u.id)}>
                <td className="px-3 py-2">
                  <div>{u.fullName || '—'}</div>
                  <div className="text-2xs text-muted">{u.email}</div>
                </td>
                <td className="px-3 py-2 text-2xs text-muted">
                  {u.canUploadLeads ? 'upload' : '—'} · {u.canHearRecordings ? 'recordings' : '—'}
                </td>
                <td className="px-3 py-2 text-right mono">{u.leadsAssigned}</td>
                <td className="px-3 py-2 text-right mono">{u.callsMonth}</td>
                <td className="px-3 py-2 text-2xs">
                  <span className={u.isActive ? 'text-emerald-400' : 'text-red-400'}>{u.isActive ? 'active' : 'disabled'}</span>
                </td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-xs text-muted">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && (
        <UserDetail
          detail={detail}
          onClose={() => setOpenUserId(null)}
          onSaved={(m) => {
            setMsg(m);
            load();
            adminApi(`/users/${detail.user.id}`).then(setDetail).catch(() => {});
          }}
        />
      )}

      {creating && (
        <CreateUser
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            setMsg('User created.');
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState({ email: '', password: '', fullName: '', canUploadLeads: false, canHearRecordings: false });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await adminApi('/users', { method: 'POST', body: form });
      onCreated();
    } catch (e: any) {
      setErr(e?.message || 'Could not create the user');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="panel w-full max-w-md p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold">New user</h3>
        <div className="mt-3 space-y-3">
          <div>
            <Label>Full name</Label>
            <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </div>
          <div>
            <Label>Email</Label>
            <input className="field" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>Password</Label>
            <input
              className="field"
              type="text"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-check"
              checked={form.canUploadLeads}
              onChange={(e) => setForm({ ...form, canUploadLeads: e.target.checked })}
            />
            Can upload leads
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="accent-check"
              checked={form.canHearRecordings}
              onChange={(e) => setForm({ ...form, canHearRecordings: e.target.checked })}
            />
            Can listen to recordings
          </label>
          {err && <p className="text-2xs text-red-400">{err}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" onClick={submit} disabled={busy}>
              {busy ? 'Creating…' : 'Create user'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UserDetail({ detail, onClose, onSaved }: { detail: any; onClose: () => void; onSaved: (m: string) => void }) {
  const u = detail.user;
  const [form, setForm] = useState({
    fullName: u.fullName || '',
    isActive: u.isActive,
    canUploadLeads: u.canUploadLeads,
    canHearRecordings: u.canHearRecordings,
    callerId: u.callerId || '',
    parallelLines: u.parallelLines || 1,
    password: '',
  });
  const [numbers, setNumbers] = useState<{ number: string; label: string | null; active: boolean }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [calls, setCalls] = useState<any[]>([]);

  useEffect(() => {
    adminApi<{ rows: any[] }>('/caller-ids').then((r) => setNumbers(r.rows)).catch(() => {});
    adminApi<{ rows: any[] }>(`/calls?userId=${u.id}&limit=20`).then((r) => setCalls(r.rows)).catch(() => {});
  }, [u.id]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await adminApi(`/users/${u.id}`, { method: 'PATCH', body: form });
      onSaved('Saved.');
      setForm({ ...form, password: '' });
    } catch (e: any) {
      setMsg(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete ${u.email}? Their leads become unassigned and their call history stays.`)) return;
    await adminApi(`/users/${u.id}`, { method: 'DELETE' });
    onClose();
  };

  return (
    <div className="panel p-5">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-sm font-semibold">{u.fullName || u.email}</h3>
          <p className="text-2xs text-muted">{u.email}</p>
        </div>
        <button className="btn-ghost !py-1 text-xs" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Leads assigned" value={u.leadsAssigned} />
        <Stat label="Calls today" value={u.callsToday} />
        <Stat label="Calls this month" value={u.callsMonth} />
        <Stat label="Connects (month)" value={`${u.connectsMonth} (${pct(u.connectsMonth, u.callsMonth)}%)`} />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <Label>Full name</Label>
          <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
        </div>
        <div>
          <Label>Caller ID for this user</Label>
          <select className="field" value={form.callerId} onChange={(e) => setForm({ ...form, callerId: e.target.value })}>
            <option value="">Rotate with everyone</option>
            {numbers.map((n) => (
              <option key={n.number} value={n.number}>
                {n.number}
                {n.label ? ` · ${n.label}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Parallel lines</Label>
          <select
            className="field"
            value={form.parallelLines}
            onChange={(e) => setForm({ ...form, parallelLines: Number(e.target.value) })}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </div>
        <div>
          <Label>Reset password (leave blank to keep)</Label>
          <input
            className="field"
            type="text"
            placeholder="New password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-check"
            checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
          />
          Account active
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-check"
            checked={form.canUploadLeads}
            onChange={(e) => setForm({ ...form, canUploadLeads: e.target.checked })}
          />
          Can upload leads
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            className="accent-check"
            checked={form.canHearRecordings}
            onChange={(e) => setForm({ ...form, canHearRecordings: e.target.checked })}
          />
          Can listen to recordings
        </label>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button className="btn-primary !py-1.5 text-xs" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="btn-danger !py-1.5 text-xs" onClick={remove}>
          Delete user
        </button>
        {msg && <span className="text-2xs text-accent">{msg}</span>}
      </div>

      <h4 className="mt-6 text-2xs uppercase tracking-wider text-muted">Recent calls</h4>
      <div className="mt-2 overflow-hidden rounded border border-ink-800">
        <table className="w-full text-xs">
          <tbody>
            {calls.map((c) => (
              <tr key={c.id} className="border-b border-ink-800/60">
                <td className="px-2 py-1.5 text-muted">{fmt(c.called_at)}</td>
                <td className="px-2 py-1.5">{c.business_name || c.to_number}</td>
                <td className="px-2 py-1.5 mono text-muted">{c.duration_sec}s</td>
                <td className="px-2 py-1.5 text-muted">{c.outcome || c.status}</td>
              </tr>
            ))}
            {!calls.length && (
              <tr>
                <td className="px-2 py-3 text-center text-muted">No calls yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Leads() {
  const [rows, setRows] = useState<any[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [search, setSearch] = useState('');
  const [assigned, setAssigned] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const qsx = `?search=${encodeURIComponent(search)}&assigned=${encodeURIComponent(assigned)}&limit=100`;
    adminApi<{ rows: any[] }>(`/leads${qsx}`).then((r) => setRows(r.rows)).catch(() => setRows([]));
  }, [search, assigned]);

  useEffect(() => {
    adminApi<{ rows: UserRow[] }>('/users').then((r) => setUsers(r.rows)).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const assign = async () => {
    if (!selected.size) return;
    setBusy(true);
    try {
      const r = await adminApi<any>('/leads/assign', {
        method: 'POST',
        body: { leadIds: [...selected], userId: assignTo || null },
      });
      setMsg(`${r.assigned} lead(s) ${assignTo ? 'assigned' : 'unassigned'}.`);
      setSelected(new Set());
      load();
    } catch (e: any) {
      setMsg(e?.message || 'Could not assign');
    } finally {
      setBusy(false);
    }
  };

  const importCsv = async (file: File) => {
    setBusy(true);
    setMsg('Importing…');
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (!lines.length) throw new Error('That file is empty');
      const split = (line: string) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')) || [];
      const header = split(lines[0]).map((h) => h.trim().toLowerCase());
      const idx = (names: string[]) => header.findIndex((h) => names.includes(h));

      const iPhone = idx(['phone', 'phone number', 'number', 'mobile']);
      const iName = idx(['business_name', 'business', 'name', 'company']);
      const iCity = idx(['city']);
      const iState = idx(['state']);
      const iAddr = idx(['address', 'street']);
      if (iPhone === -1) throw new Error('No phone column found (expected a header named phone/number)');

      const records = lines.slice(1).map((line) => {
        const c = split(line);
        return {
          business_name: iName >= 0 ? c[iName] : '',
          phone: c[iPhone],
          city: iCity >= 0 ? c[iCity] : '',
          state: iState >= 0 ? c[iState] : '',
          address: iAddr >= 0 ? c[iAddr] : '',
        };
      });

      const r = await adminApi<any>('/leads/import', {
        method: 'POST',
        body: { records, userId: assignTo || null },
      });
      setMsg(`Imported ${r.created} leads (${r.duplicates} duplicates, ${r.invalid} invalid).`);
      load();
    } catch (e: any) {
      setMsg(e?.message || 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="field !w-64"
          placeholder="Search business, phone, city"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select className="field !w-52" value={assigned} onChange={(e) => setAssigned(e.target.value)}>
          <option value="all">All leads</option>
          <option value="unassigned">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName || u.email}
            </option>
          ))}
        </select>
        <label className="btn-ghost !py-1.5 text-xs cursor-pointer">
          {busy ? 'Working…' : 'Import CSV'}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importCsv(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded border border-ink-700 bg-ink-900 px-3 py-2 text-xs">
        <span className="text-muted">{selected.size} selected</span>
        <select className="field !w-56 !py-1 text-xs" value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
          <option value="">Unassigned</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName || u.email}
            </option>
          ))}
        </select>
        <button className="btn-primary !py-1 text-xs" onClick={assign} disabled={!selected.size || busy}>
          Assign
        </button>
        {msg && <span className="text-accent">{msg}</span>}
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-2xs uppercase tracking-wider text-muted">
            <tr>
              <th className="w-8 px-2 py-2" />
              <th className="px-3 py-2 text-left">Business</th>
              <th className="px-3 py-2 text-left">Phone</th>
              <th className="px-3 py-2 text-left">City</th>
              <th className="px-3 py-2 text-left">Assigned to</th>
              <th className="px-3 py-2 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.id} className="border-t border-ink-800">
                <td className="px-2 py-1.5">
                  <input type="checkbox" className="accent-check" checked={selected.has(l.id)} onChange={() => toggle(l.id)} />
                </td>
                <td className="px-3 py-1.5">{l.business_name || '—'}</td>
                <td className="px-3 py-1.5 mono text-muted">{l.phone}</td>
                <td className="px-3 py-1.5 text-muted">{[l.city, l.state].filter(Boolean).join(', ')}</td>
                <td className="px-3 py-1.5 text-2xs text-muted">{l.assigned_email || 'unassigned'}</td>
                <td className="px-3 py-1.5 text-2xs">{l.outcome || l.status}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted">
                  No leads match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function Calls() {
  const [rows, setRows] = useState<any[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');

  useEffect(() => {
    adminApi<{ rows: UserRow[] }>('/users').then((r) => setUsers(r.rows)).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      adminApi<{ rows: any[] }>(`/calls?limit=100&userId=${encodeURIComponent(userId)}&search=${encodeURIComponent(search)}`)
        .then((r) => setRows(r.rows))
        .catch(() => setRows([]));
    }, 250);
    return () => clearTimeout(t);
  }, [userId, search]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select className="field !w-56" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">All users</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName || u.email}
            </option>
          ))}
        </select>
        <input className="field !w-64" placeholder="Search business or number" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-ink-900 text-2xs uppercase tracking-wider text-muted">
            <tr>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">User</th>
              <th className="px-3 py-2 text-left">Business</th>
              <th className="px-3 py-2 text-left">Number</th>
              <th className="px-3 py-2 text-right">Duration</th>
              <th className="px-3 py-2 text-left">Outcome</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-t border-ink-800">
                <td className="px-3 py-1.5 text-2xs text-muted">{fmt(c.called_at)}</td>
                <td className="px-3 py-1.5 text-2xs">{c.user_email || '—'}</td>
                <td className="px-3 py-1.5">{c.business_name || '—'}</td>
                <td className="px-3 py-1.5 mono text-muted">{c.to_number}</td>
                <td className="px-3 py-1.5 text-right mono">{c.duration_sec}s</td>
                <td className="px-3 py-1.5 text-2xs">{c.outcome || c.status}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-xs text-muted">
                  No calls yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AdminSettings() {
  const [form, setForm] = useState<any>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/settings', { credentials: 'include' })
      .then((r) => r.json())
      .then(setForm)
      .catch(() => setForm(null));
  }, []);

  if (!form) return <p className="text-sm text-muted">Loading…</p>;

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not save');
      setForm({ ...data, twilio: { ...data.twilio, authToken: '' } });
      setMsg('Saved.');
    } catch (e: any) {
      setMsg(e?.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const t = (k: string, v: any) => setForm({ ...form, twilio: { ...form.twilio, [k]: v } });

  return (
    <div className="max-w-3xl space-y-4">
      <div className="panel p-4">
        <h3 className="text-sm font-semibold">Twilio</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Account SID</Label>
            <input className="field mono" value={form.twilio.accountSid || ''} onChange={(e) => t('accountSid', e.target.value)} />
          </div>
          <div>
            <Label>Auth token (blank keeps the saved one)</Label>
            <input className="field mono" value={form.twilio.authToken || ''} onChange={(e) => t('authToken', e.target.value)} />
          </div>
          <div>
            <Label>Default caller ID</Label>
            <input className="field mono" value={form.twilio.number || ''} onChange={(e) => t('number', e.target.value)} />
          </div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="text-sm font-semibold">Calling defaults</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Ring timeout (seconds)</Label>
            <input
              className="field mono"
              type="number"
              min={10}
              max={90}
              value={form.ringTimeoutSec || 60}
              onChange={(e) => setForm({ ...form, ringTimeoutSec: Number(e.target.value) })}
            />
          </div>
          <div>
            <Label>Parallel lines (default)</Label>
            <select
              className="field"
              value={form.parallelLines || 1}
              onChange={(e) => setForm({ ...form, parallelLines: Number(e.target.value) })}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </div>
          <div>
            <Label>Keep Twilio recording copy (days)</Label>
            <input
              className="field mono"
              type="number"
              min={0}
              max={365}
              value={form.recordingRetentionDays ?? 7}
              onChange={(e) => setForm({ ...form, recordingRetentionDays: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="mt-3 space-y-2">
          {[
            ['recordingEnabled', 'Record calls'],
            ['amdEnabled', 'Detect answering machines'],
            ['localPresenceEnabled', 'Local presence (match area code)'],
          ].map(([key, label]) => (
            <label key={key} className="flex items-center justify-between gap-4 text-xs">
              <span>{label}</span>
              <input
                type="checkbox"
                className="accent-check"
                checked={Boolean(form[key])}
                onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary !py-2 text-xs" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        {msg && <span className="text-2xs text-accent">{msg}</span>}
      </div>

      <CallerIdsPanel />
      <VoicemailPanel />
      <DataPanel />
    </div>
  );
}
