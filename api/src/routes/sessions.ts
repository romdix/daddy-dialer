import { Router } from 'express';
import { q, one, tx } from '../db';
import { requireAuth, wrap } from '../middleware';
import { buildLeadWhere, type LeadFilter } from '../filters';
import { SESSION_STATUSES } from '../config';
import { checkCallable } from '../compliance';

export const sessionsRouter = Router();

const MAX_QUEUE = 2000;

sessionsRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const rows = await q(
      `select s.*,
              count(sl.id)::int as total,
              count(sl.id) filter (where sl.status='done')::int as done,
              count(sl.id) filter (where sl.status='pending')::int as remaining
         from calling_sessions s
         left join session_leads sl on sl.session_id = s.id
        where s.workspace_id = $1 and s.owner_user_id = $2
        group by s.id
        order by s.created_at desc
        limit 200`,
      [ws, req.ctx!.userId],
    );
    res.json({ rows });
  }),
);

sessionsRouter.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const session = await one(
      `select * from calling_sessions where id=$1 and workspace_id=$2 and owner_user_id=$3`,
      [req.params.id, ws, req.ctx!.userId],
    );
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const leads = await q(
      `select sl.id as session_lead_id, sl.queue_order, sl.status as queue_status, sl.outcome as queue_outcome,
              sl.called_at, l.*
         from session_leads sl
         join leads l on l.id = sl.lead_id
        where sl.session_id = $1
        order by sl.queue_order asc
        limit ${MAX_QUEUE}`,
      [req.params.id],
    );

    const settings = await one<any>(
      `select enforce_compliance, call_window_start, call_window_end, call_window_days,
              max_attempts, default_timezone
         from settings where workspace_id=$1`,
      [ws],
    );

    res.json({ session, leads: leads.map((l: any) => ({ ...l, ...checkCallable(l, settings) })) });
  }),
);

sessionsRouter.post(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const name = String(req.body?.name || '').trim() || `Session ${new Date().toLocaleDateString()}`;
    const f: LeadFilter = req.body?.filter || {};
    const excludeDnc = req.body?.excludeDoNotCall !== false;

    const where = buildLeadWhere(f, 3, req.ctx!.userId);
    const dnc = excludeDnc ? `and coalesce(outcome,'') <> 'do_not_call'` : '';

    const out = await tx(async (c) => {
      const s = await c.query(
        `insert into calling_sessions (workspace_id, name, owner_user_id) values ($1,$2,$3) returning *`,
        [ws, name, req.ctx!.userId],
      );
      const sessionId = s.rows[0].id as string;

      // One row per phone number: the queue must never call the same business
      // twice, even if the import contains the same number in two formats.
      const ins = await c.query(
        `with picked as (
           select distinct on (regexp_replace(phone,'\\D','','g'))
                  id, business_name, last_called_at
             from leads
            where workspace_id = $2 ${where.sql} ${dnc}
            order by regexp_replace(phone,'\\D','','g'),
                     coalesce(last_called_at, 'epoch'::timestamptz) asc,
                     business_name asc
         )
         insert into session_leads (session_id, lead_id, queue_order)
         select $1, id, row_number() over (order by coalesce(last_called_at, 'epoch'::timestamptz) asc, business_name asc)
           from picked
          order by coalesce(last_called_at, 'epoch'::timestamptz) asc, business_name asc
          limit ${MAX_QUEUE}
         on conflict (session_id, lead_id) do nothing
         returning id`,
        [sessionId, ws, ...where.params],
      );

      return { session: s.rows[0], count: ins.rowCount || 0 };
    });

    res.json({ ...out.session, lead_count: out.count });
  }),
);

sessionsRouter.patch(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const status = String(req.body?.status || '');
    if (!SESSION_STATUSES.includes(status as any)) return res.status(400).json({ error: 'Unknown status' });

    const row = await one(
      `update calling_sessions set status=$3,
              started_at = case when $3='active' and started_at is null then now() else started_at end,
              completed_at = case when $3='completed' then now() else completed_at end
        where id=$1 and workspace_id=$2 and owner_user_id=$4 returning *`,
      [req.params.id, ws, status, req.ctx!.userId],
    );
    if (!row) return res.status(404).json({ error: 'Session not found' });
    res.json(row);
  }),
);

sessionsRouter.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    await q(
      `delete from calling_sessions where id=$1 and workspace_id=$2 and owner_user_id=$3`,
      [req.params.id, req.ctx!.workspaceId, req.ctx!.userId],
    );
    res.json({ ok: true });
  }),
);
