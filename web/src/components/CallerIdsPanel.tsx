import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface CallerId {
  id: string;
  number: string;
  label: string | null;
  active: boolean;
  last_used_at: string | null;
}

/**
 * The numbers this workspace can call from. Adding more than one lets the dialer
 * rotate so a single number doesn't get flagged as spam.
 */
export function CallerIdsPanel() {
  const qc = useQueryClient();
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data } = useQuery<{ rows: CallerId[] }>({
    queryKey: ['caller-ids'],
    queryFn: () => api.get('/api/caller-ids'),
  });
  const rows = data?.rows || [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['caller-ids'] });

  const add = async () => {
    if (!number.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/caller-ids', { number: number.trim(), label: label.trim() });
      setNumber('');
      setLabel('');
      refresh();
      setMsg('Added. Calls now rotate across your active numbers.');
    } catch (e: any) {
      setMsg(e?.message || 'Could not add that number');
    } finally {
      setBusy(false);
    }
  };

  const sync = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<any>('/api/caller-ids/sync', {});
      refresh();
      setMsg(`Your Twilio account has ${r.found} numbers, ${r.added} were new.`);
    } catch (e: any) {
      setMsg(e?.message || 'Could not reach Twilio');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (row: CallerId) => {
    await api.patch(`/api/caller-ids/${row.id}`, { active: !row.active });
    refresh();
  };

  const remove = async (row: CallerId) => {
    if (!confirm(`Remove ${row.number}? It stays on your Twilio account.`)) return;
    await api.del(`/api/caller-ids/${row.id}`);
    refresh();
  };

  const inbound = async (row: CallerId) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post(`/api/caller-ids/${row.id}/inbound`, {});
      setMsg(`${row.number} now rings the app when someone calls it.`);
      refresh();
    } catch (e: any) {
      setMsg(e?.message || 'Could not set up inbound calling');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-4">
      <h2 className="text-sm font-semibold">Caller IDs &amp; incoming calls</h2>
      <p className="mt-1 text-xs text-muted">
        The numbers you call from. With more than one active, each call uses the number that has been used least
        recently, so no single number takes all the spam reports. You can also point a number at the app so its
        incoming calls ring here.
      </p>

      <div className="mt-3 space-y-1.5">
        {rows.length === 0 && (
          <p className="rounded border border-ink-700 bg-ink-900 px-3 py-2 text-xs text-muted">
            No numbers yet. Add the Twilio number you own below, or press “Import from Twilio”.
          </p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded border border-ink-700 bg-ink-900 px-3 py-2"
          >
            <span className="mono text-sm text-zinc-200">{r.number}</span>
            {r.label && <span className="text-2xs text-muted">{r.label}</span>}
            <span
              className={`rounded border px-1.5 py-0.5 text-2xs ${
                r.active
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                  : 'border-ink-600 bg-ink-800 text-muted'
              }`}
            >
              {r.active ? 'in rotation' : 'paused'}
            </span>
            {r.last_used_at && (
              <span className="text-2xs text-muted">
                last used {new Date(r.last_used_at).toLocaleString()}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              <button className="btn-ghost !py-1 !px-2 text-2xs" onClick={() => inbound(r)} disabled={busy}>
                Ring app on inbound
              </button>
              <button className="btn-ghost !py-1 !px-2 text-2xs" onClick={() => toggle(r)}>
                {r.active ? 'Pause' : 'Resume'}
              </button>
              <button className="btn-danger !py-1 !px-2 text-2xs" onClick={() => remove(r)}>
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <div>
          <label className="label">Number (E.164)</label>
          <input
            className="field mono"
            placeholder="+13072493905"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Label (optional)</label>
          <input className="field" placeholder="Sales line" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <button className="btn-primary !py-2 text-xs" onClick={add} disabled={busy || !number.trim()}>
            Add
          </button>
          <button className="btn-ghost !py-2 text-xs" onClick={sync} disabled={busy}>
            Import from Twilio
          </button>
        </div>
      </div>

      {msg && <p className="mt-2 text-2xs text-accent">{msg}</p>}
      <p className="mt-2 text-2xs leading-relaxed text-muted">
        Every number must already belong to your Twilio account — this app never buys numbers for you. “Ring app on
        inbound” tells Twilio to send that number’s incoming calls to your browser.
      </p>
    </section>
  );
}
