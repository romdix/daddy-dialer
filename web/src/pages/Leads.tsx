import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { Badge, EmptyState, Modal, Pager } from '../components/ui';
import { ImportDialog } from './ImportDialog';
import { OUTCOMES, OUTCOME_LABEL, STATUS_LABEL, fmtWhen, outcomeColor } from '../lib/format';
import { useDialer } from '../lib/dialer';

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

export function Leads() {
  const qc = useQueryClient();
  const dialer = useDialer();
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
    queryKey: ['lead-facets'],
    queryFn: () => api.get('/api/leads/facets'),
  });

  const query = useQuery<{ rows: Lead[]; total: number; pages: number; page: number }>({
    queryKey: ['leads', filters, page],
    queryFn: () =>
      api.get(
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
  });

  const savePreset = () => {
    const name = prompt('Name this filter preset');
    if (!name) return;
    const next = [...presets.filter((p) => p.name !== name), { name, filters }];
    setPresets(next);
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
  };

  const saveLead = async (patch: Partial<Lead>) => {
    if (!editing) return;
    await api.patch(`/api/leads/${editing.id}`, patch);
    setEditing(null);
    qc.invalidateQueries({ queryKey: ['leads'] });
  };

  return (
    <div>
      <PageHeader title="Leads" sub={`${query.data?.total?.toLocaleString() ?? '—'} leads in this workspace`}>
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
        <button className="btn-primary !py-1.5 text-xs" onClick={() => setImportOpen(true)}>
          Import CSV
        </button>
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
              className="accent-[#22C55E]"
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
                      <button
                        className="btn-ghost !px-2 !py-1 text-xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          dialer.start({ to: l.phone, leadId: l.id, label: l.business_name });
                        }}
                        disabled={dialer.status === 'live' || dialer.status === 'connecting'}
                      >
                        Call
                      </button>
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
        onClose={() => setImportOpen(false)}
        onDone={() => {
          qc.invalidateQueries({ queryKey: ['leads'] });
          qc.invalidateQueries({ queryKey: ['lead-facets'] });
          qc.invalidateQueries({ queryKey: ['dashboard'] });
        }}
      />

      <LeadEditor lead={editing} onClose={() => setEditing(null)} onSave={saveLead} />
    </div>
  );
}

function LeadEditor({
  lead,
  onClose,
  onSave,
}: {
  lead: Lead | null;
  onClose: () => void;
  onSave: (p: Partial<Lead>) => Promise<void>;
}) {
  const [form, setForm] = useState<any>({});
  useEffect(() => {
    if (lead) setForm({ ...lead });
  }, [lead]);

  if (!lead) return null;

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  return (
    <Modal open={!!lead} onClose={onClose} title="Lead" width="max-w-2xl">
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

        <div className="col-span-2">
          <label className="label">Notes</label>
          <textarea className="field h-24" value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" onClick={() => onSave(form)}>
          Save
        </button>
      </div>
    </Modal>
  );
}
