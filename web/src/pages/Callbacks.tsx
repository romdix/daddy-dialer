import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { Badge, EmptyState } from '../components/ui';
import { fmtWhen, outcomeColor } from '../lib/format';
import { useDialer } from '../lib/dialer';

interface Row {
  id: string;
  business_name: string;
  phone: string;
  city?: string | null;
  state?: string | null;
  callback_at: string;
  outcome?: string | null;
  notes?: string | null;
  attempts: number;
  callable: boolean;
  reason?: string;
  localLabel: string;
}

export function Callbacks() {
  const qc = useQueryClient();
  const dialer = useDialer();
  const [err, setErr] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ rows: Row[]; serverNow: string }>({
    queryKey: ['callbacks'],
    queryFn: () => api.get('/api/leads/callbacks'),
    refetchInterval: 60_000,
  });

  const rows = data?.rows || [];
  const now = Date.now();
  const due = rows.filter((r) => new Date(r.callback_at).getTime() <= now);
  const later = rows.filter((r) => new Date(r.callback_at).getTime() > now);

  const call = async (r: Row) => {
    setErr(null);
    try {
      await dialer.start({ to: r.phone, leadId: r.id, label: r.business_name });
    } catch (e: any) {
      setErr(e?.message || 'Could not start the call');
    }
  };

  const done = async (r: Row) => {
    await api.patch(`/api/leads/${r.id}`, { callback_at: null });
    qc.invalidateQueries({ queryKey: ['callbacks'] });
  };

  const Row = ({ r }: { r: Row }) => (
    <div className="flex items-center justify-between gap-3 border-t border-ink-800 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm">{r.business_name || 'Unnamed'}</p>
          {r.outcome && <Badge className={outcomeColor(r.outcome)}>{r.outcome.replace(/_/g, ' ')}</Badge>}
          {r.attempts > 0 && <span className="text-2xs text-muted">{r.attempts} tries</span>}
        </div>
        <p className="mono mt-0.5 text-xs text-zinc-400">
          {r.phone} · {[r.city, r.state].filter(Boolean).join(', ')}
        </p>
        <p className="mt-0.5 text-2xs text-muted">
          Due {fmtWhen(r.callback_at)} · {r.localLabel} their time
          {!r.callable && r.reason ? ` · ${r.reason}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button className="btn-ghost !py-1.5 text-xs" onClick={() => done(r)}>
          Done
        </button>
        <button
          className="btn-primary !py-1.5 text-xs"
          onClick={() => call(r)}
          disabled={!r.callable || dialer.status === 'live' || dialer.status === 'connecting'}
          title={r.callable ? 'Call now' : r.reason}
        >
          Call
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <PageHeader title="Callbacks" sub={`${due.length} due · ${later.length} upcoming`} />

      <div className="p-4 space-y-4">
        {err && <p className="rounded border border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-300">{err}</p>}

        {isLoading ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title="No callbacks scheduled"
            hint="Pick “Callback Requested” after a call and choose a time — it lands here."
          />
        ) : (
          <>
            <div className="panel overflow-hidden">
              <h2 className="border-b border-ink-700 bg-ink-900 px-4 py-2 text-2xs uppercase tracking-wider text-accent">
                Due now
              </h2>
              {due.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted">Nothing due right now.</p>
              ) : (
                due.map((r) => <Row key={r.id} r={r} />)
              )}
            </div>

            <div className="panel overflow-hidden">
              <h2 className="border-b border-ink-700 bg-ink-900 px-4 py-2 text-2xs uppercase tracking-wider text-muted">
                Upcoming
              </h2>
              {later.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted">Nothing scheduled ahead.</p>
              ) : (
                later.map((r) => <Row key={r.id} r={r} />)
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
