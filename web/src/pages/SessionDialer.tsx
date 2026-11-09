import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { Badge } from '../components/ui';
import { QUICK_OUTCOMES, OUTCOME_LABEL, fmtDuration, fmtWhen, outcomeColor } from '../lib/format';
import { useDialer } from '../lib/dialer';

interface Row {
  session_lead_id: string;
  queue_order: number;
  queue_status: string;
  queue_outcome: string | null;
  called_at: string | null;
  id: string;
  business_name: string;
  phone: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  website?: string | null;
  notes?: string | null;
  outcome?: string | null;
  last_called_at?: string | null;
  attempts?: number;
  callback_at?: string | null;
  callable?: boolean;
  reason?: string;
  localLabel?: string;
}

function localDatetimeValue(d: Date) {
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

export function SessionDialer() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const dialer = useDialer();

  const [index, setIndex] = useState(0);
  const [pendingCallLogId, setPendingCallLogId] = useState<string | null>(null);
  const [autoDial, setAutoDial] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [callbackFor, setCallbackFor] = useState<string | null>(null);
  const [callbackAt, setCallbackAt] = useState('');

  const { data, refetch } = useQuery<{ session: any; leads: Row[] }>({
    queryKey: ['session', id],
    queryFn: () => api.get(`/api/sessions/${id}`),
  });

  const leads = data?.leads || [];
  const current = leads[index];

  useEffect(() => {
    if (!leads.length) return;
    const firstPending = leads.findIndex((l) => l.queue_status === 'pending');
    setIndex(firstPending === -1 ? 0 : firstPending);
  }, [data?.session?.id]);

  useEffect(() => {
    if (!dialer.lastEnded) return;
    if (dialer.lastEnded.sessionId !== id) return;
    setPendingCallLogId(dialer.lastEnded.callLogId);
  }, [dialer.lastEnded, id]);

  const done = leads.filter((l) => l.queue_status === 'done').length;
  const pct = leads.length ? Math.round((done / leads.length) * 100) : 0;

  const call = async () => {
    if (!current) return;
    try {
      await dialer.start({
        to: current.phone,
        leadId: current.id,
        sessionId: id!,
        label: current.business_name,
      });
    } catch (e: any) {
      setToast(e?.message || 'Could not start the call');
    }
  };

  const dispose = async (outcome: string) => {
    if (!pendingCallLogId) return;
    if (outcome === 'callback_requested' && !callbackAt) {
      setCallbackFor(pendingCallLogId);
      setCallbackAt(localDatetimeValue(new Date(Date.now() + 60 * 60 * 1000)));
      return;
    }
    await applyOutcome(outcome, outcome === 'callback_requested' ? callbackAt : undefined);
  };

  const applyOutcome = async (outcome: string, cbAt?: string) => {
    if (!pendingCallLogId) return;
    await api.patch(`/api/calls/${pendingCallLogId}/outcome`, { outcome });
    if (cbAt && current) {
      await api.patch(`/api/leads/${current.id}`, { callback_at: new Date(cbAt).toISOString() });
    }
    setPendingCallLogId(null);
    setCallbackFor(null);
    setCallbackAt('');
    const res = await refetch();
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['calls'] });
    qc.invalidateQueries({ queryKey: ['callbacks'] });

    const next = (res.data?.leads || []).findIndex((l: Row) => l.queue_status === 'pending');
    if (next !== -1) {
      setIndex(next);
      if (autoDial) setTimeout(() => call(), 1200);
    } else {
      setToast('Session complete — every lead in this queue has been dialed.');
    }
  };

  const move = (delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < leads.length) setIndex(next);
  };

  const inCall = dialer.status === 'connecting' || dialer.status === 'ringing' || dialer.status === 'live';
  const blocked = current ? current.callable === false : false;

  // Keyboard shortcuts — bound once, always calling the latest handlers.
  const handlers = useRef({ call, hangup: () => dialer.hangup(), dispose, move, blocked, inCall, current });
  handlers.current = { call, hangup: () => dialer.hangup(), dispose, move, blocked, inCall, current };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return;
      const h = handlers.current;

      if (e.code === 'Space') {
        e.preventDefault();
        if (h.inCall) return h.hangup();
        if (!h.blocked && h.current) h.call();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const outcome = QUICK_OUTCOMES[Number(e.key) - 1];
        if (outcome) h.dispose(outcome);
        return;
      }
      if (e.key === 'ArrowRight') h.move(1);
      if (e.key === 'ArrowLeft') h.move(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const upcoming = useMemo(() => leads.slice(index + 1, index + 8), [leads, index]);

  if (!data) return <div className="p-6 text-sm text-muted">Loading…</div>;

  return (
    <div>
      <PageHeader title={data.session.name} sub={`Queue ${leads.length} leads · ${done} dialed`}>
        <button className="btn-ghost !py-1.5 text-xs" onClick={() => nav('/sessions')}>
          Back
        </button>
      </PageHeader>

      <div className="px-6 pt-3">
        <div className="h-1 w-full overflow-hidden rounded-full bg-ink-800">
          <div className="h-full bg-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-1.5 text-2xs text-muted">
          Shortcuts: <span className="text-zinc-300">Space</span> call / hang up ·{' '}
          <span className="text-zinc-300">1–9</span> disposition · <span className="text-zinc-300">← →</span> move
        </p>
      </div>

      <div className="grid gap-4 p-6 lg:grid-cols-3">
        {/* Current lead */}
        <div className="lg:col-span-2 space-y-4">
          {current ? (
            <div className="panel p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="mono text-2xs text-muted">#{index + 1}</span>
                    {current.queue_status === 'done' && (
                      <Badge className={outcomeColor(current.queue_outcome)}>
                        {OUTCOME_LABEL[current.queue_outcome || ''] || 'done'}
                      </Badge>
                    )}
                  </div>
                  <h2 className="mt-1 truncate text-xl font-semibold">{current.business_name || 'Unnamed business'}</h2>
                  <p className="mono mt-1 text-lg text-accent">{current.phone}</p>
                  <p className="mt-1 text-xs text-muted">
                    {[current.address, current.city, current.state].filter(Boolean).join(' · ') || 'No address'}
                    {current.website ? ` · ${current.website}` : ''}
                  </p>
                  <p className="mt-1 text-2xs text-muted">
                    Local time: <span className="text-zinc-300">{current.localLabel || '—'}</span>
                    {Number(current.attempts || 0) > 0 ? ` · ${current.attempts} tries` : ''}
                  </p>
                </div>

                <div className="text-right shrink-0">
                  <div className="mono text-2xl">{fmtDuration(dialer.seconds)}</div>
                  <div className="text-2xs uppercase tracking-wider text-muted">
                    {dialer.status === 'live' ? 'live' : dialer.status === 'connecting' || dialer.status === 'ringing' ? 'dialing' : 'idle'}
                  </div>
                </div>
              </div>

              {blocked && (
                <div className="mt-3 rounded border border-amber-900/50 bg-amber-950/25 px-3 py-2 text-xs text-amber-300">
                  {current.reason || 'This lead cannot be dialed right now.'}
                </div>
              )}

              {current.notes && (
                <div className="mt-4 rounded border border-ink-700 bg-ink-900 p-3">
                  <p className="text-2xs uppercase tracking-wider text-muted">Notes</p>
                  <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{current.notes}</p>
                </div>
              )}

              <div className="mt-4 flex flex-wrap items-center gap-2 text-2xs text-muted">
                <span>Last called: {fmtWhen(current.last_called_at)}</span>
                {current.outcome && (
                  <>
                    <span>·</span>
                    <span>Outcome: {OUTCOME_LABEL[current.outcome] || current.outcome}</span>
                  </>
                )}
              </div>

              <div className="mt-5 flex flex-wrap items-center gap-2">
                {!inCall && !pendingCallLogId && (
                  <button className="btn-primary px-6" onClick={call} disabled={blocked}>
                    {blocked ? 'Blocked' : 'Call now'}
                  </button>
                )}
                {inCall && (
                  <>
                    <button className="btn-ghost" onClick={dialer.toggleMute}>
                      {dialer.muted ? 'Unmute' : 'Mute'}
                    </button>
                    <button className="btn-danger" onClick={dialer.hangup}>
                      Hang up
                    </button>
                  </>
                )}
                {!inCall && (
                  <>
                    <button className="btn-ghost !py-1.5 text-xs" onClick={() => move(-1)} disabled={index === 0}>
                      ← Prev
                    </button>
                    <button
                      className="btn-ghost !py-1.5 text-xs"
                      onClick={() => move(1)}
                      disabled={index >= leads.length - 1}
                    >
                      Skip →
                    </button>
                    <label className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={autoDial}
                        onChange={(e) => setAutoDial(e.target.checked)}
                        className="accent-check"
                      />
                      auto-dial next
                    </label>
                  </>
                )}
              </div>

              {toast && <p className="mt-3 text-xs text-accent">{toast}</p>}
              {dialer.error && <p className="mt-3 text-xs text-red-400">{dialer.error}</p>}
            </div>
          ) : (
            <div className="panel p-8 text-center text-sm text-muted">This queue is empty.</div>
          )}

          {pendingCallLogId && callbackFor !== pendingCallLogId && (
            <div className="panel border-accent/30 p-4">
              <p className="text-xs uppercase tracking-wider text-muted">How did it go?</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {QUICK_OUTCOMES.map((o, i) => (
                  <button
                    key={o}
                    onClick={() => dispose(o)}
                    className={`rounded border px-2.5 py-1.5 text-xs hover:brightness-125 ${outcomeColor(o)}`}
                  >
                    <span className="mono mr-1 text-2xs opacity-60">{i + 1}</span>
                    {OUTCOME_LABEL[o]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {pendingCallLogId && callbackFor === pendingCallLogId && (
            <div className="panel border-accent/30 p-4">
              <p className="text-xs uppercase tracking-wider text-muted">When should we call back?</p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="datetime-local"
                  className="field mono !w-auto"
                  value={callbackAt}
                  onChange={(e) => setCallbackAt(e.target.value)}
                />
                <button
                  className="btn-primary !py-1.5 text-xs"
                  onClick={() => applyOutcome('callback_requested', callbackAt)}
                >
                  Save callback
                </button>
                <button
                  className="btn-ghost !py-1.5 text-xs"
                  onClick={() => {
                    setCallbackFor(null);
                    setCallbackAt('');
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="mt-2 text-2xs text-muted">
                It shows up in Callbacks at the time you pick, and this lead remembers it next session.
              </p>
            </div>
          )}
        </div>

        {/* Queue */}
        <div className="panel h-fit p-3">
          <h3 className="px-1 pb-2 text-2xs uppercase tracking-wider text-muted">Up next</h3>
          <ul className="space-y-0.5">
            {upcoming.length === 0 && <li className="px-1 py-2 text-xs text-muted">End of queue.</li>}
            {upcoming.map((l, i) => (
              <li key={l.session_lead_id}>
                <button
                  className="w-full rounded px-2 py-1.5 text-left hover:bg-ink-800"
                  onClick={() => setIndex(index + 1 + i)}
                >
                  <p className="truncate text-xs text-zinc-300">{l.business_name || 'Unnamed'}</p>
                  <p className="mono text-2xs text-muted">
                    {l.phone} {l.city ? `· ${l.city}` : ''}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
