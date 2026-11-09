import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { EmptyState, Modal } from '../components/ui';
import { OUTCOMES, OUTCOME_LABEL, fmtWhen } from '../lib/format';

interface Session {
  id: string;
  name: string;
  status: string;
  created_at: string;
  total: number;
  done: number;
  remaining: number;
}

const SESSION_BADGE: Record<string, string> = {
  pending: 'bg-zinc-500/15 text-zinc-400 border-zinc-600/40',
  active: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  completed: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
};

export function Sessions() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [filter, setFilter] = useState({ status: 'new', outcome: '', city: '', state: '', search: '', neverCalled: true });
  const [excludeDnc, setExcludeDnc] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery<{ rows: Session[] }>({
    queryKey: ['sessions'],
    queryFn: () => api.get('/api/sessions'),
  });

  const { data: preview } = useQuery<{ total: number }>({
    queryKey: ['session-preview', filter, excludeDnc],
    queryFn: () =>
      api.get(
        `/api/leads?limit=10&page=1&status=${filter.status || 'all'}&outcome=${filter.outcome || 'all'}` +
          `&city=${encodeURIComponent(filter.city)}&state=${encodeURIComponent(filter.state)}` +
          `&search=${encodeURIComponent(filter.search)}${filter.neverCalled ? '&neverCalled=1' : ''}`,
      ),
  });

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await api.post<any>('/api/sessions', {
        name: name || `Session ${new Date().toLocaleDateString()}`,
        filter,
        excludeDoNotCall: excludeDnc,
      });
      qc.invalidateQueries({ queryKey: ['sessions'] });
      setOpen(false);
      nav(`/sessions/${s.id}`);
    } catch (e: any) {
      setErr(e?.message || 'Could not build the session');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this session? The leads stay in your workspace.')) return;
    await api.del(`/api/sessions/${id}`);
    qc.invalidateQueries({ queryKey: ['sessions'] });
  };

  return (
    <div>
      <PageHeader title="Sessions" sub="Build a queue from a slice of your leads and power through it">
        <button className="btn-primary !py-1.5 text-xs" onClick={() => setOpen(true)}>
          New session
        </button>
      </PageHeader>

      <div className="p-4">
        {!data?.rows?.length ? (
          <EmptyState
            title="No calling sessions yet"
            hint="A session is a frozen queue of leads — same list every time you open it, with progress tracked."
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {data.rows.map((s) => {
              const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
              return (
                <div key={s.id} className="panel p-4 hover:border-ink-600 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <button className="text-left" onClick={() => nav(`/sessions/${s.id}`)}>
                      <h3 className="text-sm font-medium hover:text-accent">{s.name}</h3>
                      <p className="mt-0.5 text-2xs text-muted">{fmtWhen(s.created_at)}</p>
                    </button>
                    <span className={`rounded border px-1.5 py-0.5 text-2xs ${SESSION_BADGE[s.status] || ''}`}>
                      {s.status}
                    </span>
                  </div>

                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
                    <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>

                  <div className="mt-2 flex items-center justify-between text-2xs text-muted">
                    <span className="mono">
                      {s.done}/{s.total} done
                    </span>
                    <span className="mono">{s.remaining} left</span>
                  </div>

                  <div className="mt-3 flex gap-2">
                    <button className="btn-ghost flex-1 !py-1.5 text-xs" onClick={() => nav(`/sessions/${s.id}`)}>
                      Open dialer
                    </button>
                    <button className="btn-danger !px-2 !py-1.5 text-xs" onClick={() => remove(s.id)}>
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New calling session" width="max-w-xl">
        <div className="space-y-3">
          <div>
            <label className="label">Session name</label>
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Austin plumbers — Monday" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="label">Status</label>
              <select className="field" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                <option value="all">Any</option>
                <option value="new">New only</option>
                <option value="in_progress">In progress</option>
                <option value="completed">Completed</option>
                <option value="disqualified">Disqualified</option>
              </select>
            </div>
            <div>
              <label className="label">Outcome</label>
              <select className="field" value={filter.outcome} onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}>
                <option value="">Any</option>
                <option value="none">No outcome yet</option>
                {OUTCOMES.map((o) => (
                  <option key={o} value={o}>
                    {OUTCOME_LABEL[o]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">City</label>
              <input className="field" value={filter.city} onChange={(e) => setFilter({ ...filter, city: e.target.value })} placeholder="Austin" />
            </div>
            <div>
              <label className="label">State</label>
              <input className="field" value={filter.state} onChange={(e) => setFilter({ ...filter, state: e.target.value })} placeholder="TX" />
            </div>
          </div>

          <div>
            <label className="label">Keyword</label>
            <input className="field" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} placeholder="roofing" />
          </div>

          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={filter.neverCalled}
              onChange={(e) => setFilter({ ...filter, neverCalled: e.target.checked })}
              className="accent-[#22C55E]"
            />
            Only leads never called
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={excludeDnc} onChange={(e) => setExcludeDnc(e.target.checked)} className="accent-[#22C55E]" />
            Leave out Do-Not-Call leads
          </label>

          <div className="rounded border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-muted">
            <span className="mono text-zinc-200">{preview?.total ?? '—'}</span> leads match this filter
            {preview && preview.total > 2000 ? ' (the first 2,000 go in the queue)' : ''}
          </div>

          {err && <p className="text-xs text-red-400">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" onClick={create} disabled={busy || !preview?.total}>
              {busy ? 'Building…' : 'Build session'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
