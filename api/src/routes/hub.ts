import { Router } from 'express';
import { one, q } from '../db';
import { wrap } from '../middleware';
import { requireAdmin } from '../adminauth';
import { primaryWorkspaceId } from '../workspace';

/**
 * The admin's whole-lead view: every lead in the workspace, whoever owns it.
 * Assign, unassign, export, and open any session's detail.
 */
export const hubRouter = Router();
hubRouter.use(requireAdmin);

function buildFilters(req: any, startIndex = 2): { sql: string; params: any[] } {
  const params: any[] = [];
  const parts: string[] = [];
  let i = startIndex;

  const search = String(req.query.search || '').trim();
  if (search) {
    parts.push(
      `(l.business_name ilike $${i} or l.phone ilike $${i} or coalesce(l.city,'') ilike $${i} or coalesce(l.email,'') ilike $${i})`,
    );
    params.push(`%${search}%`);
    i++;
  }

  const owner = String(req.query.owner || 'all');
  if (owner === 'unassigned') parts.push('l.assigned_user_id is null');
  else if (owner === 'assigned') parts.push('l.assigned_user_id is not null');
  else if (owner !== 'all' && owner) {
    parts.push(`l.assigned_user_id = $${i++}`);
    params.push(owner);
  }

  if (req.query.status && req.query.status !== 'all') {
    parts.push(`l.status = $${i++}`);
    params.push(String(req.query.status));
  }
  if (req.query.outcome && req.query.outcome !== 'all') {
    if (req.query.outcome === 'none') parts.push('l.outcome is null');
    else {
      parts.push(`l.outcome = $${i++}`);
      params.push(String(req.query.outcome));
    }
  }
  if (req.query.uploadId) {
    parts.push(`l.upload_id = $${i++}`);
    params.push(String(req.query.uploadId));
  }

  return { sql: parts.length ? `and ${parts.join(' and ')}` : '', params };
}

const SELECT = `
  select l.*, u.email as owner_email, up.filename as upload_name
    from leads l
    left join users u on u.id = l.assigned_user_id
    left join lead_uploads up on up.id = l.upload_id
   where l.workspace_id = $1`;

hubRouter.get(
  '/leads',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const f = buildFilters(req, 2);

    const rows = await q(
      `${SELECT} ${f.sql} order by l.created_at desc limit ${limit} offset ${offset}`,
      [ws, ...f.params],
    );

    const totalRow = await one<{ n: number }>(
      `select count(*)::int as n from leads l where l.workspace_id=$1 ${f.sql}`,
      [ws, ...f.params],
    );
    const total = totalRow?.n || 0;

    const counts = await one<any>(
      `select count(*)::int as all,
              count(*) filter (where assigned_user_id is null)::int as unassigned,
              count(*) filter (where assigned_user_id is not null)::int as assigned
         from leads where workspace_id=$1`,
      [ws],
    );

    res.json({ rows, total, page, pages: Math.ceil(total / limit) || 1, counts });
  }),
);

/** Assign to a user, or unassign with userId=null. */
hubRouter.post(
  '/assign',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const ids: string[] = Array.isArray(req.body?.leadIds) ? req.body.leadIds.filter(Boolean) : [];
    const userId = req.body?.userId ? String(req.body.userId) : null;
    const reassign = req.body?.reassign === true;
    if (!ids.length) return res.status(400).json({ error: 'Select at least one lead' });

    if (userId) {
      const u = await one(`select id from users where id=$1 and deleted_at is null`, [userId]);
      if (!u) return res.status(404).json({ error: 'User not found' });
    }

    const owned = await one<{ n: number }>(
      `select count(*)::int as n from leads
        where workspace_id=$1 and id = any($2::uuid[])
          and assigned_user_id is not null and assigned_user_id is distinct from $3`,
      [ws, ids, userId],
    );

    if (owned && owned.n > 0 && !reassign && userId) {
      return res.status(409).json({
        error: `${owned.n} of these are already assigned to someone else.`,
        needsConfirm: true,
        owned: owned.n,
      });
    }

    const out = await q(
      `update leads set assigned_user_id=$3, updated_at=now()
        where workspace_id=$1 and id = any($2::uuid[])
          and ($3::uuid is null or assigned_user_id is null or assigned_user_id = $3 or $4::boolean)
        returning id`,
      [ws, ids, userId, reassign],
    );

    res.json({ updated: out.length, skipped: ids.length - out.length, userId });
  }),
);

hubRouter.post(
  '/delete',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const ids: string[] = Array.isArray(req.body?.leadIds) ? req.body.leadIds.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'Select at least one lead' });
    const out = await q(`delete from leads where workspace_id=$1 and id = any($2::uuid[]) returning id`, [ws, ids]);
    res.json({ deleted: out.length });
  }),
);

function csvEscape(v: any): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function sendCsv(res: any, name: string, head: string[], rows: any[][]) {
  const body = [head.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.send(body);
}

hubRouter.get(
  '/leads.csv',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const f = buildFilters(req, 2);
    const rows = await q<any>(
      `${SELECT} ${f.sql} order by l.created_at asc limit 100000`,
      [ws, ...f.params],
    );
    sendCsv(
      res,
      `leads-${new Date().toISOString().slice(0, 10)}.csv`,
      [
        'business_name', 'phone', 'address', 'city', 'state', 'zip', 'website', 'email',
        'owner', 'status', 'outcome', 'attempts', 'last_called_at', 'callback_at', 'notes',
        'upload', 'created_at',
      ],
      rows.map((l) => [
        l.business_name, l.phone, l.address, l.city, l.state, l.zip, l.website, l.email,
        l.owner_email || '', l.status, l.outcome || '', l.attempts,
        l.last_called_at ? new Date(l.last_called_at).toISOString() : '',
        l.callback_at ? new Date(l.callback_at).toISOString() : '',
        l.notes || '', l.upload_name || '',
        new Date(l.created_at).toISOString(),
      ]),
    );
  }),
);

/* ------------------------------- sessions ------------------------------- */

hubRouter.get(
  '/sessions',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q(
      `select s.id, s.name, s.status, s.created_at, s.owner_user_id, u.email as owner_email,
              (select count(*) from session_leads sl where sl.session_id=s.id)::int as total,
              (select count(*) from session_leads sl where sl.session_id=s.id and sl.status='done')::int as done
         from calling_sessions s
         left join users u on u.id = s.owner_user_id
        where s.workspace_id=$1
        order by s.created_at desc limit 200`,
      [ws],
    );
    res.json({ rows });
  }),
);

hubRouter.get(
  '/sessions/:id',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const session = await one(
      `select s.*, u.email as owner_email from calling_sessions s
         left join users u on u.id=s.owner_user_id
        where s.id=$1 and s.workspace_id=$2`,
      [req.params.id, ws],
    );
    if (!session) return res.status(404).json({ error: 'Session not found' });

    const leads = await q<any>(
      `select sl.queue_order, sl.status as queue_status, sl.outcome as queue_outcome, sl.called_at,
              l.id, l.business_name, l.phone, l.city, l.state, l.outcome, l.status
         from session_leads sl join leads l on l.id = sl.lead_id
        where sl.session_id=$1
        order by sl.queue_order asc limit 5000`,
      [req.params.id],
    );
    res.json({ session, leads });
  }),
);

hubRouter.get(
  '/sessions/:id/export.csv',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q<any>(
      `select sl.queue_order, sl.status as queue_status, sl.outcome as queue_outcome, sl.called_at,
              l.business_name, l.phone, l.city, l.state, l.email, l.outcome, l.status
         from session_leads sl join leads l on l.id = sl.lead_id
         join calling_sessions s on s.id = sl.session_id
        where sl.session_id=$1 and s.workspace_id=$2
        order by sl.queue_order asc limit 100000`,
      [req.params.id, ws],
    );
    sendCsv(
      res,
      `session-${req.params.id.slice(0, 8)}.csv`,
      ['#', 'business_name', 'phone', 'city', 'state', 'email', 'queue_status', 'queue_outcome', 'lead_status', 'lead_outcome', 'called_at'],
      rows.map((r) => [
        r.queue_order, r.business_name, r.phone, r.city, r.state, r.email,
        r.queue_status, r.queue_outcome || '', r.status, r.outcome || '',
        r.called_at ? new Date(r.called_at).toISOString() : '',
      ]),
    );
  }),
);
