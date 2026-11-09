import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { Badge, EmptyState, Pager } from '../components/ui';
import { OUTCOMES, OUTCOME_LABEL, fmtDateTime, fmtDuration, outcomeColor } from '../lib/format';

interface CallRow {
  id: string;
  business_name?: string | null;
  to_number?: string | null;
  from_number?: string | null;
  outcome?: string | null;
  status: string;
  duration_sec: number;
  recording_sid?: string | null;
  transcript?: string | null;
  called_at: string;
  session_name?: string | null;
  provider: string;
}

export function CallLog() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [outcome, setOutcome] = useState('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<{ rows: CallRow[]; total: number; pages: number; page: number }>({
    queryKey: ['calls', page, search, outcome],
    queryFn: () => api.get(`/api/calls${qs({ page, limit: 50, search, outcome })}`),
  });

  const setOutcomeFor = async (id: string, o: string) => {
    await api.patch(`/api/calls/${id}/outcome`, { outcome: o });
    qc.invalidateQueries({ queryKey: ['calls'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };

  return (
    <div>
      <PageHeader title="Call Log" sub={`${data?.total?.toLocaleString() ?? '—'} calls recorded`} />

      <div className="border-b border-ink-800 bg-ink-900/40 px-6 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="field !w-64 !py-1.5 text-xs"
            placeholder="Search business or number…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <select
            className="field !w-auto !py-1.5 text-xs"
            value={outcome}
            onChange={(e) => {
              setOutcome(e.target.value);
              setPage(1);
            }}
          >
            <option value="all">Any outcome</option>
            <option value="none">No outcome</option>
            {OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABEL[o]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="p-4">
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-ink-900">
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Number</th>
                  <th className="th">Outcome</th>
                  <th className="th">Duration</th>
                  <th className="th">Rec</th>
                  <th className="th">When</th>
                  <th className="th">Session</th>
                </tr>
              </thead>
              <tbody>
                {(data?.rows || []).map((c) => (
                  <>
                    <tr
                      key={c.id}
                      className="cursor-pointer hover:bg-ink-800/40"
                      onClick={() => setOpenId(openId === c.id ? null : c.id)}
                    >
                      <td className="td max-w-[240px] truncate">{c.business_name || <span className="text-zinc-600">Unknown</span>}</td>
                      <td className="td mono text-zinc-300">{c.to_number}</td>
                      <td className="td">
                        {c.outcome ? (
                          <Badge className={outcomeColor(c.outcome)}>{OUTCOME_LABEL[c.outcome] || c.outcome}</Badge>
                        ) : (
                          <span className="text-zinc-700">{c.status}</span>
                        )}
                      </td>
                      <td className="td mono">{fmtDuration(c.duration_sec)}</td>
                      <td className="td">
                        {c.recording_sid ? <span className="text-accent">●</span> : <span className="text-zinc-700">—</span>}
                      </td>
                      <td className="td text-zinc-500">{fmtDateTime(c.called_at)}</td>
                      <td className="td max-w-[160px] truncate text-zinc-500">{c.session_name || '—'}</td>
                    </tr>
                    {openId === c.id && (
                      <tr key={c.id + '-x'} className="bg-ink-900/60">
                        <td className="td" colSpan={7}>
                          <div className="grid gap-4 py-2 md:grid-cols-2">
                            <div>
                              <p className="mb-1 text-2xs uppercase tracking-wider text-muted">Recording</p>
                              {c.recording_sid ? (
                                <audio controls preload="none" className="w-full" src={`/api/calls/${c.id}/recording`} />
                              ) : (
                                <p className="text-xs text-muted">No recording for this call.</p>
                              )}
                              <dl className="mt-3 grid grid-cols-2 gap-1 text-xs">
                                <dt className="text-muted">Provider</dt>
                                <dd className="mono">{c.provider}</dd>
                                <dt className="text-muted">From</dt>
                                <dd className="mono">{c.from_number}</dd>
                                <dt className="text-muted">Status</dt>
                                <dd className="mono">{c.status}</dd>
                              </dl>
                            </div>
                            <div>
                              <p className="mb-1 text-2xs uppercase tracking-wider text-muted">Outcome</p>
                              <select
                                className="field !py-1.5 text-xs"
                                value={c.outcome || ''}
                                onChange={(e) => setOutcomeFor(c.id, e.target.value)}
                              >
                                <option value="">— none —</option>
                                {OUTCOMES.map((o) => (
                                  <option key={o} value={o}>
                                    {OUTCOME_LABEL[o]}
                                  </option>
                                ))}
                              </select>

                              <p className="mb-1 mt-3 text-2xs uppercase tracking-wider text-muted">Transcript</p>
                              <p className="text-xs text-zinc-400 whitespace-pre-wrap">
                                {c.transcript || 'Transcription is not enabled yet.'}
                              </p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>

          {(data?.rows || []).length === 0 && !isLoading && (
            <EmptyState title="No calls yet" hint="Calls appear here the moment they finish, with recording and duration." />
          )}

          {data && data.total > 0 && (
            <Pager page={data.page} pages={data.pages} total={data.total} onPage={setPage} />
          )}
        </div>
      </div>
    </div>
  );
}
