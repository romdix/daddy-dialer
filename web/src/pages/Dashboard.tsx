import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { PageHeader } from '../components/Shell';
import { OUTCOME_LABEL, fmtDuration, outcomeColor } from '../lib/format';
import { Badge } from '../components/ui';

interface Dash {
  calls: {
    today: number;
    week: number;
    month: number;
    all_time: number;
    unique_leads_month: number;
    connects_month: number;
    talk_seconds_month: number;
  };
  leads: { total: number; new: number; untouched: number };
  connectionRate: number;
  avgTalkSeconds: number;
  daily: { day: string; calls: number; connects: number }[];
  outcomes: { outcome: string; count: number }[];
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel px-4 py-3">
      <p className="text-2xs uppercase tracking-wider text-muted">{label}</p>
      <p className="mono mt-1 text-2xl leading-none">{value}</p>
      {sub && <p className="mt-1 text-2xs text-muted">{sub}</p>}
    </div>
  );
}

export function Dashboard() {
  const { data, isLoading } = useQuery<Dash>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/api/dashboard'),
    refetchInterval: 60_000,
  });

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title="Dashboard" />
        <div className="p-6 text-sm text-muted">Loading…</div>
      </div>
    );
  }

  const pct = (data.connectionRate * 100).toFixed(1);

  return (
    <div>
      <PageHeader title="Dashboard" sub="Live view of your dialing activity" />

      <div className="p-6 space-y-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <Kpi label="Calls today" value={String(data.calls.today)} />
          <Kpi label="This week" value={String(data.calls.week)} />
          <Kpi label="This month" value={String(data.calls.month)} sub={`${data.calls.unique_leads_month} unique leads`} />
          <Kpi label="Connection rate" value={`${pct}%`} sub={`${data.calls.connects_month} connects`} />
          <Kpi label="Avg talk time" value={fmtDuration(data.avgTalkSeconds)} sub="per connect" />
        </div>

        <div className="grid gap-4 lg:grid-cols-3">
          <div className="panel p-4 lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium">Daily calls</h2>
              <span className="text-2xs text-muted">last 14 days</span>
            </div>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.daily} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22C55E" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#22C55E" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="day"
                    tick={{ fill: '#8A9099', fontSize: 10 }}
                    tickFormatter={(v: string) => v.slice(5)}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fill: '#8A9099', fontSize: 10 }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#14161B', border: '1px solid #232730', borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: '#8A9099' }}
                  />
                  <Area type="monotone" dataKey="calls" stroke="#22C55E" strokeWidth={1.5} fill="url(#g1)" />
                  <Area type="monotone" dataKey="connects" stroke="#38BDF8" strokeWidth={1.2} fillOpacity={0} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="panel p-4">
            <h2 className="mb-3 text-sm font-medium">Last 30 days by outcome</h2>
            {data.outcomes.length === 0 ? (
              <p className="text-xs text-muted">No calls logged yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.outcomes.map((o) => (
                  <li key={o.outcome} className="flex items-center justify-between gap-2">
                    <Badge className={outcomeColor(o.outcome)}>{OUTCOME_LABEL[o.outcome] || o.outcome}</Badge>
                    <span className="mono text-xs text-zinc-400">{o.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi label="Leads in workspace" value={data.leads.total.toLocaleString()} />
          <Kpi label="Never called" value={data.leads.untouched.toLocaleString()} />
          <Kpi label="Still new" value={data.leads.new.toLocaleString()} />
          <Kpi label="All-time calls" value={data.calls.all_time.toLocaleString()} />
        </div>
      </div>
    </div>
  );
}
