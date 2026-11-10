import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { Badge, EmptyState, Modal, Pager } from '../components/ui';
import { ImportDialog } from './ImportDialog';
import { OUTCOMES, OUTCOME_LABEL, STATUS_LABEL, fmtWhen, outcomeColor } from '../lib/format';
import { useDialer } from '../lib/dialer';
import { useAuth } from '../lib/auth';

interface Lead {
  id: string;
  business_name: string;
  phone: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  website?: string | null;
  email?: string | null;
  notes?: string | null;
  status: string;
  outcome?: string | null;
  last_called_at?: string | null;
  callback_at?: string | null;
  attempts?: number;
}

interface Filters {
  search: string;
  status: string;
  outcome: string;
  city: string;
  state: string;
  neverCalled: boolean;
}

const EMPTY: Filters = { search: '', status: 'all', outcome: 'all', city: '', state: '', neverCalled: false };
const PRESET_KEY = 'dd.presets';

export function Leads({ asUserId }: { asUserId?: string } = {}) {
  const qc = useQueryClient();
  const { me } = useAuth();
  const adminMode = Boolean(asUserId);
  const suffix = asUserId ? `userId=${asUserId}` : '';
  const withUser = (path: string) => (asUserId ? `${path}${path.includes('?') ? '&' : '?'}${suffix}` : path);
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const [editing, setEditing] = useState<Lead | null>(null);
  const [presets, setPresets] = useState<{ name: string; filters: Filters }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => ({ ...f, search: searchInput }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const { data: facets } = useQuery<any>({
    queryKey: ['lead-facets', asUserId],
    queryFn: () => api.get(withUser('/api/leads/facets')),
  });

  const query = useQuery<{ rows: Lead[]; total: number; pages: number; page: number }>({
    queryKey: ['leads', filters, page, asUserId],
    queryFn: () =>
      api.get(
        withUser(
          `/api/leads${qs({
            search: filters.search,
            status: filters.status,
            outcome: filters.outcome,
            city: filters.city,
            state: filters.state,
            neverCalled: filters.neverCalled ? 1 : '',
            page,
            limit: 50,
          })}`,
        ),
      ),
  });

  const savePreset = () => {
    const name = prompt('Name this filter preset');
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, filters }];
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
  };

  const saveLead = async (patch: Partial<Lead>) => {
    if (creating) {
      await api.post(withUser('/api/leads'), patch);
      setCreating(false);
    } else {
      if (!editing) return;
      await api.patch(withUser(`/api/leads/${editing.id}`), patch);
      setEditing(null);
    }
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['lead-facets'] });
  };

  const deleteLead = async (id: string) => {
    if (!confirm('Delete this lead permanently?')) return;
    await api.del(withUser(`/api/leads/${id}`));
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['lead-facets'] });
  };

  return (
    <div>
      <PageHeader
        title={adminMode ? 'Leads' : 'Leads'}
        sub={
          adminMode
            ? `${query.data?.total?.toLocaleString() ?? '—'} leads assigned to this user`
            : `${query.data?.total?.toLocaleString() ?? '—'} leads in this workspace`
        }
      >
        <select
          className="field !w-auto !py-1.5 text-xs"
          value=""
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) {
              setFilters(p.filters);
              setSearchInput(p.filters.search);
              setPage(1);
            }
          }}
        >
          <option value="">Presets…</option>
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="btn-ghost !py-1.5 text-xs" onClick={savePreset}>
          Save filter
        </button>
        {(adminMode || (me?.user as any)?.canUploadLeads) && (
          <button className="btn-primary !py-1.5 text-xs" onClick={() => setImportOpen(true)}>
            Import CSV
          </button>
        )}
        {adminMode && (
          <button className="btn-ghost !py-1.5 text-xs" onClick={() => setCreating(true)}>
            Add lead
          </button>
        )}
      </PageHeader>

      <div className="border-b border-ink-800 bg-ink-900/40 px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field !w-64 !py-1.5 text-xs"
            placeholder="Search business, phone, city, address…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={filters.status}
            onChange={(e) => {
              setFilters({ ...filters, status: e.target.value });
              setPage(1);
            }}
          >
            <option value="all">Any status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={filters.outcome}
            onChange={(e) => {
              setFilters({ ...filters, outcome: e.target.value });
              setPage(1);
            }}
          >
            <option value="all">Any outcome</option>
            <option value="none">No outcome yet</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={filters.city}
            onChange={(e) => {
              setFilters({ ...filters, city: e.target.value });
              setPage(1);
            }}
          >
            <option value="">Any city</option>
            {(facets?.cities || []).map((c: any) => (
              <option key={c.value} value={c.value}>
                {c.value} ({c.count})
              </option>
            ))}
          </select>
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={filters.state}
            onChange={(e) => {
              setFilters({ ...filters, state: e.target.value });
              setPage(1);
            }}
          >
            <option value="">Any state</option>
            {(facets?.states || []).map((s: any) => (
              <option key={s.value} value={s.value}>
                {s.value} ({s.count})
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={filters.neverCalled}
              onChange={(e) => {
                setFilters({ ...filters, neverCalled: e.target.checked });
                setPage(1);
              }}
              className="accent-check"
            />
            never called
          </label>
          <button
            className="text-xs text-muted hover:text-accent"
            onClick={() => {
              setFilters(EMPTY);
              setSearchInput('');
              setPage(1);
            }}
          >
            Reset
          </button>
        </div>
      </div>

      <div className="p-4">
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink-900">
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Phone</th>
                  <th className="th">City</th>
                  <th className="th">Status</th>
                  <th className="th">Outcome</th>
                  <th className="th">Last called</th>
                  <th className="th"></th>
                </tr>
              </thead>
              <tbody>
                {(query.data?.rows || []).map((l) => (
                  <tr key={l.id} className="hover:bg-ink-800/40 cursor-pointer" onClick={() => setEditing(l)}>
                    <td className="td max-w-[260px] truncate">{l.business_name || <span className="text-zinc-600">Unnamed</span>}</td>
                    <td className="td mono text-zinc-300">{l.phone}</td>
                    <td className="td text-zinc-400">
                      {[l.city, l.state].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className="td text-zinc-400">{STATUS_LABEL[l.status] || l.status}</td>
                    <td className="td">
                      {l.outcome ? (
                        <Badge className={outcomeColor(l.outcome)}>{OUTCOME_LABEL[l.outcome] || l.outcome}</Badge>
                      ) : (
                        <span className="text-zinc-700">—</span>
                      )}
                    </td>
                    <td className="td text-zinc-500">{fmtWhen(l.last_called_at)}</td>
                    <td className="td text-right">
                      {!adminMode && <CallButton lead={l} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(query.data?.rows || []).length === 0 && !query.isLoading && (
            <EmptyState
              title="No leads match this view"
              hint="Import a CSV to get started, or clear the filters above."
            />
          )}

          {query.data && query.data.total > 0 && (
            <Pager page={query.data.page} pages={query.data.pages} total={query.data.total} onPage={setPage} />
          )}
        </div>
      </div>

      <ImportDialog
        open={importOpen}
        asUserId={asUserId}
        onClose={() => setImportOpen(false)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['leads'] });
          qc.invalidateQueries({ queryKey: ['lead-facets'] });
          qc.invalidateQueries({ queryKey: ['dashboard'] });
        }}
      />

      <LeadEditor
        lead={creating ? ({ id: '', status: 'new' } as Lead) : editing}
        isNew={creating}
        admin={adminMode}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        onSave={saveLead}
        onDelete={deleteLead}
      />
    </div>
  );
}

function CallButton({ lead }: { lead: Lead }) {
  const dialer = useDialer();
  return (
    <button
      className="btn-ghost !px-2 !py-1 text-xs"
      onClick={(e) => {
        e.stopPropagation();
        dialer.start({ to: lead.phone, leadId: lead.id, label: lead.business_name });
      }}
      disabled={dialer.status === 'live' || dialer.status === 'connecting'}
    >
      Call
    </button>
  );
}

function toLocalInput(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

function LeadEditor({
  lead,
  isNew,
  admin,
  onClose,
  onSave,
  onDelete,
}: {
  lead: Lead | null;
  isNew?: boolean;
  admin?: boolean;
  onClose: () => void;
  onSave: (p: Partial<Lead>) => Promise<void>;
  onDelete?: (id: string) => Promise<void>;
}) {
  const [form, setForm] = useState<any>({});
  const [agents, setAgents] = useState<any[]>([]);
  useEffect(() => {
    if (lead) setForm({ ...lead });
  }, [lead]);
  useEffect(() => {
    if (!admin) return;
    fetch('/api/admin/users?includeDeleted=1', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then((d) => setAgents(d.rows || []))
      .catch(() => setAgents([]));
  }, [admin]);

  if (!lead) return null;

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <Modal open={!!lead} onClose={onClose} title={isNew ? 'New lead' : 'Lead'} width="max-w-2xl">
      <div className="grid grid-cols-2 gap-3">
        {[
          ['business_name', 'Business name'],
          ['phone', 'Phone'],
          ['address', 'Address'],
          ['city', 'City'],
          ['state', 'State'],
          ['zip', 'ZIP'],
          ['website', 'Website'],
          ['email', 'Email'],
        ].map(([k, label]) => (
          <div key={k} className={k === 'address' ? 'col-span-2' : ''}>
            <label className="label">{label}</label>
            <input className="field" value={form[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
          </div>
        ))}

        <div>
          <label className="label">Status</label>
          <select className="field" value={form.status || 'new'} onChange={(e) => set('status', e.target.value)}>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Outcome</label>
          <select className="field" value={form.outcome || ''} onChange={(e) => set('outcome', e.target.value)}>
            <option value="">— none —</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </div>

        {admin && (
          <div className="col-span-2">
            <label className="label">Assigned to</label>
            <select
              className="field"
              value={form.assigned_user_id || ''}
              onChange={(e) => set('assigned_user_id', e.target.value || null)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {(a.fullName ? `${a.fullName} — ${a.email}` : a.email) + (a.deletedAt ? ' (deleted)' : '')}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="col-span-2">
          <label className="label">Callback at</label>
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              className="field mono !w-auto"
              value={toLocalInput(form.callback_at)}
              onChange={(e) =>
                set('callback_at', e.target.value ? new Date(e.target.value).toISOString() : null)
              }
            />
            {form.callback_at && (
              <button className="text-2xs text-muted hover:text-red-400" onClick={() => set('callback_at', null)}>
                clear
              </button>
            )}
          </div>
        </div>

        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="field h-24" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div>
          {admin && !isNew && onDelete && (
            <button
              className="btn-ghost !py-1.5 text-xs !text-red-400 hover:!bg-red-950/40"
              onClick={() => onDelete(lead.id)}
            >
              Delete lead
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => onSave(form)}>
            {isNew ? 'Create lead' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
