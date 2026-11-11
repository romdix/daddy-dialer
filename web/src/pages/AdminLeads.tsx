import { useCallback, useEffect, useState } from 'react';
import { ImportDialog } from './ImportDialog';
import { OutcomeBadge } from '../lib/outcomes';
import { STATUS_LABEL, fmtDateTime } from '../lib/format';

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

/* ------------------------------------------------------------------ *
 * All leads — every owner, one table
 * ------------------------------------------------------------------ */

export function AdminLeads() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [counts, setCounts] = useState<any>({});
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState('all');
  const [status, setStatus] = useState('all');
  const [outcome, setOutcome] = useState('all');
  const [users, setUsers] = useState<any[]>([]);
  const [tags, setTags] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const query = new URLSearchParams({
    page: String(page),
    limit: '50',
    owner,
    status,
    outcome,
  });
  if (search) query.set('search', search);
  const qs = query.toString();

  const load = useCallback(async () => {
    const [d, us, tg] = await Promise.all([
      j(`/api/admin/hub/leads?${qs}`),
      j('/api/admin/users'),
      j('/api/admin/outcomes'),
    ]);
    setRows(d.rows || []);
    setTotal(d.total || 0);
    setPages(d.pages || 1);
    setCounts(d.counts || {});
    setUsers((us.rows || []).filter((u: any) => !u.deletedAt));
    setTags((tg.rows || []).filter((t: any) => t.active));
  }, [qs]);

  useEffect(() => {
    load().catch(() => setRows([]));
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setSelected([]);
  }, [page, owner, status, outcome, search]);

  const pageIds = (rows || []).map((r) => r.id);
  const allChecked = pageIds.length > 0 && pageIds.every((id) => selected.includes(id));

  const assign = async (userId: string | null) => {
    if (!selected.length) return;
    const owned = (rows || []).filter(
      (r) => selected.includes(r.id) && r.assigned_user_id && r.assigned_user_id !== userId,
    );
    if (owned.length && !confirm(`${owned.length} of these are already assigned to someone else. Reassign them?`)) {
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await post('/api/admin/hub/assign', { leadIds: selected, userId, reassign: owned.length > 0 });
      setMsg(userId ? `${r.updated} assigned` : `${r.updated} unassigned`);
      setSelected([]);
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Could not update');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected.length) return;
    if (!confirm(`Delete ${selected.length} leads? This cannot be undone.`)) return;
    setBusy(true);
    try {
      const r = await post('/api/admin/hub/delete', { leadIds: selected });
      setMsg(`${r.deleted} deleted`);
      setSelected([]);
      await load();
    } catch (e: any) {
      setMsg(e?.message || 'Could not delete');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Leads</h1>
          <p className="mt-0.5 text-xs text-muted">
            Every lead in the workspace — assigned or not. {counts.all ?? 0} total · {counts.unassigned ?? 0}{' '}
            unassigned · {counts.assigned ?? 0} assigned.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            className="btn-ghost !py-2 text-xs"
            href={`/api/admin/hub/leads.csv?${qs.replace(/page=\d+&?/, '')}`}
            download
          >
            Export CSV
          </a>
          <button className="btn-primary !py-2 text-xs" onClick={() => setImportOpen(true)}>
            Import CSV
          </button>
        </div>
      </div>

      <div className="panel flex flex-wrap items-end gap-3 p-3">
        <input
          className="field !w-56 !py-1.5 text-xs"
          placeholder="Search name, phone, city, email"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select className="field !w-auto !py-1.5 text-xs" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }}>
          <option value="all">Any owner</option>
          <option value="unassigned">Unassigned</option>
          <option value="assigned">Assigned to anyone</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName || u.email}
            </option>
          ))}
        </select>
        <select className="field !w-auto !py-1.5 text-xs" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="all">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
        <select className="field !w-auto !py-1.5 text-xs" value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }}>
          <option value="all">Any outcome</option>
          <option value="none">No outcome</option>
          {tags.map((t) => (
            <option key={t.key} value={t.key}>{t.label}</option>
          ))}
        </select>
        <span className="ml-auto text-2xs text-muted">{selected.length} selected</span>
      </div>

      {selected.length > 0 && (
        <div className="panel flex flex-wrap items-center gap-3 border-accent/30 p-3 text-xs">
          <select className="field !w-56 !py-1.5 text-xs" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choose a user…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.fullName || u.email}</option>
            ))}
          </select>
          <button className="btn-primary !py-1.5 text-xs" disabled={busy || !target} onClick={() => assign(target)}>
            Assign {selected.length}
          </button>
          <button className="btn-ghost !py-1.5 text-xs" disabled={busy} onClick={() => assign(null)}>
            Unassign
          </button>
          <button className="btn-ghost !py-1.5 text-xs !text-red-300" disabled={busy} onClick={remove}>
            Delete
          </button>
          <button className="text-2xs text-muted underline" onClick={() => setSelected([])}>clear</button>
        </div>
      )}

      {msg && <p className="text-xs text-accent">{msg}</p>}

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-ink-900">
              <tr>
                <th className="th w-8">
                  <input
                    type="checkbox"
                    className="accent-check"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? pageIds : selected.filter((id) => !pageIds.includes(id)))
                    }
                  />
                </th>
                <th className="th">Business</th>
                <th className="th">Phone</th>
                <th className="th">City</th>
                <th className="th">Owner</th>
                <th className="th">Status</th>
                <th className="th">Outcome</th>
                <th className="th">Last called</th>
                <th className="th">Upload</th>
              </tr>
            </thead>
            <tbody>
              {(rows || []).map((l) => (
                <tr key={l.id} className={selected.includes(l.id) ? 'bg-ink-800/60' : undefined}>
                  <td className="td">
                    <input
                      type="checkbox"
                      className="accent-check"
                      checked={selected.includes(l.id)}
                      onChange={(e) =>
                        setSelected(e.target.checked ? [...selected, l.id] : selected.filter((id) => id !== l.id))
                      }
                    />
                  </td>
                  <td className="td max-w-[220px] truncate">{l.business_name || <span className="text-zinc-600">Unnamed</span>}</td>
                  <td className="td mono text-zinc-300">{l.phone}</td>
                  <td className="td text-zinc-400">{[l.city, l.state].filter(Boolean).join(', ') || '—'}</td>
                  <td className="td text-2xs">
                    {l.owner_email ? <span className="text-zinc-300">{l.owner_email}</span> : <span className="text-amber-300">unassigned</span>}
                  </td>
                  <td className="td text-2xs text-zinc-400">{STATUS_LABEL[l.status] || l.status}</td>
                  <td className="td"><OutcomeBadge outcome={l.outcome} /></td>
                  <td className="td text-2xs text-zinc-500">{l.last_called_at ? fmtDateTime(l.last_called_at) : '—'}</td>
                  <td className="td max-w-[160px] truncate text-2xs text-zinc-500">{l.upload_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows && rows.length === 0 && (
          <p className="px-4 py-10 text-center text-xs text-muted">No leads match this view.</p>
        )}
        {pages > 1 && (
          <div className="flex items-center justify-between border-t border-ink-800 px-4 py-3 text-2xs text-muted">
            <span>Page {page} of {pages} · {total} leads</span>
            <div className="flex gap-2">
              <button className="btn-ghost !py-1 text-2xs" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn-ghost !py-1 text-2xs" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      <ImportDialog
        open={importOpen}
        pool
        onClose={() => setImportOpen(false)}
        onDone={async () => {
          setPage(1);
          await load();
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sessions — every user's, with detail and export
 * ------------------------------------------------------------------ */

export function AdminSessions() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  useEffect(() => {
    j('/api/admin/hub/sessions')
      .then((d) => setRows(d.rows || []))
      .catch(() => setRows([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    j(`/api/admin/hub/sessions/${open.id}`)
      .then(setDetail)
      .catch(() => setDetail({ leads: [] }));
  }, [open]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Sessions</h1>
        <p className="mt-0.5 text-xs text-muted">Every calling session, whoever ran it. Open one to see each lead.</p>
      </div>

      <div className="panel overflow-hidden">
        <table className="w-full">
          <thead className="bg-ink-900">
            <tr>
              <th className="th">Session</th>
              <th className="th">Owner</th>
              <th className="th">Created</th>
              <th className="th text-right">Progress</th>
              <th className="th">Status</th>
              <th className="th text-right"></th>
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((s) => (
              <tr key={s.id}>
                <td className="td">{s.name}</td>
                <td className="td text-2xs text-zinc-400">{s.owner_email || '—'}</td>
                <td className="td text-2xs text-zinc-500">{fmtDateTime(s.created_at)}</td>
                <td className="td text-right mono text-zinc-400">{s.done}/{s.total}</td>
                <td className="td text-2xs text-zinc-400">{s.status}</td>
                <td className="td text-right whitespace-nowrap">
                  <button className="btn-ghost !px-2 !py-1 text-2xs" onClick={() => setOpen(s)}>View</button>
                  <a className="btn-ghost !px-2 !py-1 text-2xs" href={`/api/admin/hub/sessions/${s.id}/export.csv`} download>
                    CSV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && rows.length === 0 && <p className="px-4 py-10 text-center text-xs text-muted">No sessions yet.</p>}
      </div>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setOpen(null)}>
          <div className="panel flex max-h-[85vh] w-full max-w-4xl flex-col p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{open.name}</h2>
                <p className="text-2xs text-muted">
                  {open.owner_email || 'no owner'} · {open.done}/{open.total} dialed
                </p>
              </div>
              <div className="flex gap-2">
                <a className="btn-ghost !py-1.5 text-xs" href={`/api/admin/hub/sessions/${open.id}/export.csv`} download>
                  Export CSV
                </a>
                <button className="btn-ghost !py-1.5 text-xs" onClick={() => setOpen(null)}>Close</button>
              </div>
            </div>

            <div className="mt-3 min-h-0 flex-1 overflow-auto rounded border border-ink-800">
              <table className="w-full">
                <thead className="sticky top-0 bg-ink-900">
                  <tr>
                    <th className="th">#</th>
                    <th className="th">Business</th>
                    <th className="th">Phone</th>
                    <th className="th">City</th>
                    <th className="th">Queue</th>
                    <th className="th">Outcome</th>
                    <th className="th">Called</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail?.leads || []).map((l: any) => (
                    <tr key={l.id}>
                      <td className="td mono text-2xs text-zinc-500">{l.queue_order}</td>
                      <td className="td max-w-[200px] truncate">{l.business_name || '—'}</td>
                      <td className="td mono text-zinc-400">{l.phone}</td>
                      <td className="td text-2xs text-zinc-500">{[l.city, l.state].filter(Boolean).join(', ') || '—'}</td>
                      <td className="td text-2xs text-zinc-500">{l.queue_status}</td>
                      <td className="td"><OutcomeBadge outcome={l.queue_outcome || l.outcome} /></td>
                      <td className="td text-2xs text-zinc-500">{l.called_at ? fmtDateTime(l.called_at) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!detail && <p className="p-6 text-center text-xs text-muted">Loading…</p>}
              {detail && (detail.leads || []).length === 0 && (
                <p className="p-8 text-center text-xs text-muted">This session has no leads.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
