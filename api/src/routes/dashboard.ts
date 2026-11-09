import { Router } from 'express';
import { q, one } from '../db';
import { requireAuth, wrap } from '../middleware';

export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;

    const counts = await one<any>(
      `select
         count(*) filter (where called_at >= date_trunc('day', now()))::int as today,
         count(*) filter (where called_at >= date_trunc('week', now()))::int as week,
         count(*) filter (where called_at >= date_trunc('month', now()))::int as month,
         count(*) ::int as all_time,
         count(distinct lead_id) filter (where called_at >= date_trunc('month', now()))::int as unique_leads_month,
         count(*) filter (where called_at >= date_trunc('month', now())
                            and outcome in ('connected_dm','connected_gk','connected_other'))::int as connects_month,
         coalesce(sum(duration_sec) filter (where called_at >= date_trunc('month', now())),0)::int as talk_seconds_month
       from call_logs where workspace_id=$1`,
      [ws],
    );

    const daily = await q(
      `select to_char(d.day, 'YYYY-MM-DD') as day,
              count(c.id)::int as calls,
              count(c.id) filter (where c.outcome in ('connected_dm','connected_gk','connected_other'))::int as connects
         from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') as d(day)
         left join call_logs c
           on c.workspace_id = $1
          and c.called_at >= d.day and c.called_at < d.day + interval '1 day'
        group by d.day order by d.day`,
      [ws],
    );

    const outcomes = await q(
      `select coalesce(outcome,'dialed') as outcome, count(*)::int as count
         from call_logs where workspace_id=$1 and called_at >= now() - interval '30 days'
        group by 1 order by count desc`,
      [ws],
    );

    const leadTotals = await one<any>(
      `select count(*)::int as total,
              count(*) filter (where status='new')::int as new,
              count(*) filter (where last_called_at is null)::int as untouched
         from leads where workspace_id=$1`,
      [ws],
    );

    const connectionRate = counts.month ? counts.connects_month / counts.month : 0;

    res.json({
      calls: counts,
      leads: leadTotals,
      connectionRate,
      avgTalkSeconds: counts.month ? Math.round(counts.talk_seconds_month / Math.max(1, counts.connects_month)) : 0,
      daily,
      outcomes,
    });
  }),
);
