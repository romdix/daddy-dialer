import { Router } from 'express';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { one, q, tx } from '../db';
import { wrap } from '../middleware';
import { dec } from '../crypto';
import {
  adminConfigured,
  checkAdminCredentials,
  clearAdminCookie,
  issueAdminCookie,
  isAdminRequest,
  requireAdmin,
} from '../adminauth';
import { primaryWorkspaceId } from '../workspace';
import { activeOutcomeKeys } from '../outcomes';
import { normalizePhone, formatPhone, toE164 } from '../filters';
import { OUTCOMES, STATUSES } from '../config';
import { getProvider } from '../providers';

export const adminRouter = Router();

/* ------------------------------------------------------------------ *
 * Session
 * ------------------------------------------------------------------ */

adminRouter.get('/session', (req, res) => {
  res.json({ configured: adminConfigured(), signedIn: isAdminRequest(req) });
});

adminRouter.post(
  '/login',
  wrap(async (req, res) => {
    if (!adminConfigured()) {
      return res.status(503).json({
        error: 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD on the server.',
      });
    }
    if (!checkAdminCredentials(String(req.body?.username || ''), String(req.body?.password || ''))) {
      return res.status(401).json({ error: 'Wrong username or password' });
    }
    issueAdminCookie(res);
    res.json({ ok: true });
  }),
);

adminRouter.post('/logout', (_req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

adminRouter.use(requireAdmin);

/* ------------------------------------------------------------------ *
 * Users
 * ------------------------------------------------------------------ */

const userColumns = `u.id, u.email, u.full_name as "fullName", u.is_active as "isActive",
  u.can_upload_leads as "canUploadLeads", u.can_hear_recordings as "canHearRecordings",
  u.caller_id as "callerId", u.parallel_lines as "parallelLines", u.created_at as "createdAt",
  u.deleted_at as "deletedAt"`;

const userStats = `(select count(*) from leads l where l.assigned_user_id = u.id)::int as "leadsAssigned",
  (select count(*) from call_logs c where c.user_id = u.id
     and c.called_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')::int as "callsToday",
  (select count(*) from call_logs c where c.user_id = u.id and c.called_at >= now() - interval '7 days')::int as "callsWeek",
  (select count(*) from call_logs c where c.user_id = u.id and c.called_at >= now() - interval '30 days')::int as "callsMonth",
  (select count(*) from call_logs c where c.user_id = u.id and c.called_at >= now() - interval '30 days'
     and c.duration_sec > 0)::int as "answeredMonth",
  (select count(*) from call_logs c where c.user_id = u.id and c.called_at >= now() - interval '30 days'
     and c.outcome in ('connected_dm','connected_gk','connected_other','appointment_set'))::int as "connectsMonth",
  (select coalesce(sum(c.duration_sec),0) from call_logs c where c.user_id = u.id
     and c.called_at >= now() - interval '30 days')::int as "talkSecMonth",
  (select max(c.called_at) from call_logs c where c.user_id = u.id) as "lastCallAt"`;

adminRouter.get(
  '/overview',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const users = await q(
      `select ${userColumns}, ${userStats} from users u where u.deleted_at is null order by u.created_at asc`,
    );
    const totals = await one<any>(
      `select
         (select count(*) from leads where workspace_id=$1)::int as leads,
         (select count(*) from leads where workspace_id=$1 and assigned_user_id is null)::int as unassigned,
         (select count(*) from leads l
            join users u on u.id = l.assigned_user_id
           where l.workspace_id=$1 and u.deleted_at is not null)::int as with_deleted,
         (select count(*) from call_logs where workspace_id=$1
            and called_at >= date_trunc('day', now() at time zone 'America/New_York') at time zone 'America/New_York')::int as calls_today,
         (select count(*) from call_logs where workspace_id=$1 and called_at >= date_trunc('month', now()))::int as calls_month
       `,
      [ws],
    );
    res.json({ users, totals });
  }),
);

adminRouter.get(
  '/workspace',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const row = await one(`select id, name from workspaces where id=$1`, [ws]);
    res.json(row);
  }),
);

adminRouter.put(
  '/workspace',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (name.length > 60) return res.status(400).json({ error: 'Keep the name under 60 characters' });
    const ws = await primaryWorkspaceId();
    await q(`update workspaces set name=$2 where id=$1`, [ws, name]);
    res.json({ id: ws, name });
  }),
);

adminRouter.get(
  '/users',
  wrap(async (req, res) => {
    const withDeleted = req.query.includeDeleted === '1';
    const rows = await q(
      `select ${userColumns}, ${userStats} from users u
        ${withDeleted ? '' : 'where u.deleted_at is null'}
        order by u.deleted_at nulls first, u.created_at asc`,
    );
    res.json({ rows });
  }),
);

adminRouter.post(
  '/users',
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim() || null;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const exists = await one<any>(`select id, deleted_at from users where lower(email)=lower($1)`, [email]);
    if (exists) {
      return res.status(409).json({
        error: exists.deleted_at
          ? 'That email belongs to a deleted user. Open the deleted list and restore it instead.'
          : 'A user with that email already exists',
      });
    }

    const ws = await primaryWorkspaceId();
    const hash = await bcrypt.hash(password, 10);
    const b = req.body || {};

    const id = await tx(async (c) => {
      const u = await c.query(
        `insert into users (email, password_hash, full_name, can_upload_leads, can_hear_recordings, caller_id, parallel_lines)
         values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [
          email,
          hash,
          fullName,
          Boolean(b.canUploadLeads),
          Boolean(b.canHearRecordings),
          b.callerId || null,
          Math.max(1, Math.min(3, Number(b.parallelLines || 1))),
        ],
      );
      const uid = u.rows[0].id as string;
      await c.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'member')`, [ws, uid]);
      return uid;
    });

    const row = await one(`select ${userColumns}, ${userStats} from users u where u.id=$1`, [id]);
    res.json(row);
  }),
);

adminRouter.get(
  '/users/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    const row = await one(`select ${userColumns}, ${userStats} from users u where u.id=$1`, [id]);
    if (!row) return res.status(404).json({ error: 'User not found' });

    // 14-day activity in New York time, zero-filled so the chart never has gaps.
    const daily = await q(
      `with days as (
         select generate_series(
           ((now() at time zone 'America/New_York')::date - 13),
           ((now() at time zone 'America/New_York')::date),
           interval '1 day'
         )::date as day
       )
       select to_char(d.day, 'YYYY-MM-DD') as day,
              count(c.id)::int as calls,
              count(c.id) filter (where c.duration_sec > 0)::int as answered
         from days d
         left join call_logs c
                on c.user_id = $1
               and (c.called_at at time zone 'America/New_York')::date = d.day
        group by d.day
        order by d.day`,
      [id],
    );

    const outcomes = await q(
      `select coalesce(outcome,'none') as outcome, count(*)::int as count
         from call_logs
        where user_id=$1 and called_at >= now() - interval '30 days'
        group by 1 order by 2 desc`,
      [id],
    );

    const statuses = await q(
      `select status, count(*)::int as count from leads where assigned_user_id=$1 group by 1`,
      [id],
    );

    const recentLeads = await q(
      `select id, business_name, phone, city, state, status, outcome, last_called_at
         from leads where assigned_user_id=$1 order by created_at desc limit 8`,
      [id],
    );

    const recentCalls = await q(
      `select c.id, c.to_number, c.status, c.outcome, c.duration_sec, c.called_at,
              l.business_name
         from call_logs c left join leads l on l.id = c.lead_id
        where c.user_id=$1 order by c.called_at desc limit 10`,
      [id],
    );

    res.json({ user: row, daily, outcomes, statuses, recentLeads, recentCalls });
  }),
);

adminRouter.patch(
  '/users/:id',
  wrap(async (req, res) => {
    const b = req.body || {};
    const sets: string[] = [];
    const params: any[] = [req.params.id];
    let i = 2;

    const push = (col: string, v: any) => {
      sets.push(`${col}=$${i++}`);
      params.push(v);
    };

    if (typeof b.fullName === 'string') push('full_name', b.fullName.trim() || null);
    if (typeof b.isActive === 'boolean') push('is_active', b.isActive);
    if (typeof b.canUploadLeads === 'boolean') push('can_upload_leads', b.canUploadLeads);
    if (typeof b.canHearRecordings === 'boolean') push('can_hear_recordings', b.canHearRecordings);
    if (typeof b.callerId === 'string') push('caller_id', b.callerId.trim() || null);
    if (b.parallelLines !== undefined) push('parallel_lines', Math.max(1, Math.min(3, Number(b.parallelLines) || 1)));
    if (typeof b.password === 'string' && b.password.length >= 8) {
      push('password_hash', await bcrypt.hash(b.password, 10));
      // Force a fresh login everywhere.
      await q(`delete from auth_sessions where user_id=$1`, [req.params.id]);
    }
    if (typeof b.password === 'string' && b.password.length > 0 && b.password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    sets.push('updated_at=now()');

    const row = await one(
      `update users set ${sets.join(', ')} where id=$1 returning id`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'User not found' });

    const fresh = await one(`select ${userColumns}, ${userStats} from users u where u.id=$1`, [req.params.id]);
    res.json(fresh);
  }),
);

adminRouter.delete(
  '/users/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    const user = await one<any>(`select id, deleted_at from users where id=$1`, [id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.deleted_at) return res.json({ ok: true, alreadyDeleted: true });

    // Their leads stay attached to the account: hidden with it, never handed to
    // somebody else. Nothing is reassigned and nothing is destroyed.
    await q(`update users set deleted_at=now(), is_active=false, updated_at=now() where id=$1`, [id]);
    await q(`delete from auth_sessions where user_id=$1`, [id]);

    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/users/:id/restore',
  wrap(async (req, res) => {
    const row = await one(
      `update users set deleted_at=null, is_active=true, updated_at=now() where id=$1 returning id`,
      [req.params.id],
    );
    if (!row) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------ *
 * Leads
 * ------------------------------------------------------------------ */

adminRouter.get(
  '/leads',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const assigned = String(req.query.assigned || 'all');

    const params: any[] = [ws];
    const parts: string[] = [];

    if (search) {
      params.push(`%${search}%`);
      parts.push(`(l.business_name ilike $${params.length} or l.phone ilike $${params.length} or coalesce(l.city,'') ilike $${params.length})`);
    }
    if (assigned === 'unassigned') parts.push(`l.assigned_user_id is null`);
    else if (assigned !== 'all') {
      params.push(assigned);
      parts.push(`l.assigned_user_id = $${params.length}`);
    }

    const where = parts.length ? `and ${parts.join(' and ')}` : '';
    const rows = await q(
      `select l.*, u.email as assigned_email, count(*) over() as total
         from leads l
         left join users u on u.id = l.assigned_user_id
        where l.workspace_id=$1 ${where}
        order by l.created_at desc
        limit ${limit} offset ${offset}`,
      params,
    );
    const total = rows.length ? Number((rows[0] as any).total) : 0;
    res.json({ rows: rows.map(({ total: _t, ...r }: any) => r), total, page, pages: Math.ceil(total / limit) || 1 });
  }),
);

adminRouter.post(
  '/leads/bulk-delete',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const ids = Array.isArray(req.body?.leadIds) ? req.body.leadIds.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'No leads selected' });
    const out = await q(`delete from leads where workspace_id=$1 and id = any($2::uuid[]) returning id`, [ws, ids]);
    res.json({ deleted: out.length });
  }),
);

adminRouter.post(
  '/users/:id/leads/delete-all',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const out = await q(`delete from leads where workspace_id=$1 and assigned_user_id=$2 returning id`, [
      ws,
      req.params.id,
    ]);
    res.json({ deleted: out.length });
  }),
);

adminRouter.post(
  '/leads/assign',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const ids: string[] = Array.isArray(req.body?.leadIds) ? req.body.leadIds : [];
    const userId = req.body?.userId ? String(req.body.userId) : null;
    if (!ids.length) return res.status(400).json({ error: 'Pick at least one lead' });
    if (userId) {
      const u = await one(`select id from users where id=$1`, [userId]);
      if (!u) return res.status(404).json({ error: 'User not found' });
    }
    const out = await q(
      `update leads set assigned_user_id=$3, updated_at=now()
        where workspace_id=$1 and id = any($2::uuid[]) returning id`,
      [ws, ids, userId],
    );
    res.json({ assigned: out.length, userId });
  }),
);

adminRouter.post(
  '/leads/import',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const records: any[] = Array.isArray(req.body?.records) ? req.body.records : [];
    const assignTo = req.body?.userId ? String(req.body.userId) : null;
    if (!records.length) return res.status(400).json({ error: 'No rows to import' });
    if (records.length > 5000) return res.status(400).json({ error: 'Send at most 5,000 rows per batch' });

    let created = 0;
    let duplicates = 0;
    let invalid = 0;
    const seen = new Set<string>();
    const valid: { norm: string; rec: any }[] = [];

    for (const r of records) {
      const norm = normalizePhone(r.phone ?? r.phone_number ?? '');
      if (!norm) {
        invalid++;
        continue;
      }
      if (seen.has(norm)) {
        duplicates++;
        continue;
      }
      seen.add(norm);
      valid.push({ norm, rec: r });
    }

    await tx(async (c) => {
      const CHUNK = 400;
      for (let start = 0; start < valid.length; start += CHUNK) {
        const slice = valid.slice(start, start + CHUNK);
        const values: string[] = [];
        const params: any[] = [ws, assignTo];
        let p = 3;
        for (const { norm, rec } of slice) {
          values.push(
            `($1, $2, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
          );
          params.push(
            String(rec.business_name || rec.name || rec.company || '').trim().slice(0, 300),
            formatPhone(norm),
            norm,
            rec.address || null,
            rec.city || null,
            rec.state || null,
            rec.zip || rec.postal_code || null,
            rec.website || null,
            rec.email || null,
            rec.notes || null,
            JSON.stringify(rec.metadata || {}),
          );
        }
        const result = await c.query(
          `insert into leads (workspace_id, assigned_user_id, business_name, phone, phone_norm, address, city, state, zip,
                              website, email, notes, metadata)
           values ${values.join(',')}
           on conflict (workspace_id, phone_norm) do nothing
           returning id`,
          params,
        );
        created += result.rowCount || 0;
      }
    });

    duplicates += valid.length - created;
    res.json({ created, duplicates, invalid, received: records.length });
  }),
);

adminRouter.patch(
  '/leads/:id',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const b = req.body || {};
    const sets: string[] = [];
    const params: any[] = [req.params.id, ws];
    let i = 3;

    const push = (col: string, v: any) => {
      sets.push(`${col}=$${i++}`);
      params.push(v);
    };

    for (const f of ['business_name', 'address', 'city', 'state', 'zip', 'website', 'email', 'notes']) {
      if (f in b) push(f, b[f] === '' ? null : b[f]);
    }
    if ('status' in b) {
      if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Unknown status' });
      push('status', b.status);
    }
    if ('outcome' in b) {
      const allowed = await activeOutcomeKeys(ws);
      if (b.outcome && !allowed.has(String(b.outcome))) return res.status(400).json({ error: 'Unknown tag' });
      push('outcome', b.outcome || null);
    }
    if ('assigned_user_id' in b) push('assigned_user_id', b.assigned_user_id || null);
    if ('phone' in b) {
      const norm = normalizePhone(String(b.phone || ''));
      if (!norm) return res.status(400).json({ error: 'That phone number does not look valid' });
      push('phone', formatPhone(norm));
      push('phone_norm', norm);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=now()');

    try {
      const row = await one(`update leads set ${sets.join(', ')} where id=$1 and workspace_id=$2 returning *`, params);
      if (!row) return res.status(404).json({ error: 'Lead not found' });
      res.json(row);
    } catch (e: any) {
      if (String(e?.message || '').includes('leads_unique_phone')) {
        return res.status(409).json({ error: 'Another lead already has that phone number' });
      }
      throw e;
    }
  }),
);

adminRouter.delete(
  '/leads/:id',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const r = await q(`delete from leads where id=$1 and workspace_id=$2 returning id`, [req.params.id, ws]);
    if (!r.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/sessions',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q(
      `select s.id, s.name, s.status, s.created_at, u.email as owner_email,
              (select count(*) from session_leads sl where sl.session_id=s.id)::int as total,
              (select count(*) from session_leads sl where sl.session_id=s.id and sl.status='done')::int as done
         from calling_sessions s
         left join users u on u.id = s.owner_user_id
        where s.workspace_id=$1
        order by s.created_at desc
        limit 200`,
      [ws],
    );
    res.json({ rows });
  }),
);

/* ------------------------------------------------------------------ *
 * One calendar day (New York time)
 * ------------------------------------------------------------------ */

const CONNECTED_OUTCOMES = new Set(['connected_dm', 'connected_gk', 'connected_other', 'appointment_set']);

adminRouter.get(
  '/users/:id/day',
  wrap(async (req, res) => {
    const id = req.params.id;
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD is required' });

    const calls = await q<any>(
      `select c.id, c.to_number, c.status, c.outcome, c.duration_sec, c.called_at,
              c.answered_by, c.recording_sid, c.recording_path, l.business_name
         from call_logs c
         left join leads l on l.id = c.lead_id
        where c.user_id = $1
          and (c.called_at at time zone 'America/New_York')::date = $2::date
        order by c.called_at asc`,
      [id, date],
    );

    const talkSec = calls.reduce((s, c) => s + (Number(c.duration_sec) || 0), 0);
    const answered = calls.filter((c) => Number(c.duration_sec) > 0).length;
    const connects = calls.filter((c) => CONNECTED_OUTCOMES.has(String(c.outcome || ''))).length;

    const byOutcome: Record<string, number> = {};
    for (const c of calls) {
      const k = c.outcome || 'none';
      byOutcome[k] = (byOutcome[k] || 0) + 1;
    }

    res.json({
      date,
      timezone: 'America/New_York',
      summary: {
        calls: calls.length,
        answered,
        connects,
        talkSec,
        avgSec: answered ? Math.round(talkSec / answered) : 0,
        answerRate: calls.length ? Math.round((answered / calls.length) * 100) : 0,
      },
      outcomes: Object.entries(byOutcome)
        .map(([outcome, count]) => ({ outcome, count }))
        .sort((a, b) => b.count - a.count),
      calls,
    });
  }),
);

/* ------------------------------------------------------------------ *
 * Call history
 * ------------------------------------------------------------------ */

adminRouter.get(
  '/calls',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const params: any[] = [ws];
    const parts: string[] = [];
    if (req.query.userId) {
      params.push(String(req.query.userId));
      parts.push(`c.user_id = $${params.length}`);
    }
    const search = String(req.query.search || '').trim();
    if (search) {
      params.push(`%${search}%`);
      parts.push(`(coalesce(l.business_name,'') ilike $${params.length} or coalesce(c.to_number,'') ilike $${params.length})`);
    }
    const where = parts.length ? `and ${parts.join(' and ')}` : '';

    const rows = await q(
      `select c.*, l.business_name, u.email as user_email, u.deleted_at as user_deleted, count(*) over() as total
         from call_logs c
         left join leads l on l.id = c.lead_id
         left join users u on u.id = c.user_id
        where c.workspace_id=$1 ${where}
        order by c.called_at desc
        limit ${limit} offset ${offset}`,
      params,
    );
    const total = rows.length ? Number((rows[0] as any).total) : 0;
    res.json({ rows: rows.map(({ total: _t, ...r }: any) => r), total, page, pages: Math.ceil(total / limit) || 1 });
  }),
);

/** Admin playback + download. Same file the rep hears, but full workspace scope. */
adminRouter.get(
  '/calls/:id/recording',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const call = await one<any>(`select * from call_logs where id=$1 and workspace_id=$2`, [
      req.params.id,
      ws,
    ]);
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (!call.recording_path && !call.recording_sid) {
      return res.status(404).json({ error: 'No recording for this call' });
    }

    const download = req.query.download === '1';
    const stamp = new Date(call.called_at).toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const number = String(call.to_number || 'unknown').replace(/[^0-9]/g, '');
    const disposition = `${download ? 'attachment' : 'inline'}; filename="call-${number}-${stamp}.mp3"`;

    if (call.recording_path && fs.existsSync(call.recording_path)) {
      const stat = fs.statSync(call.recording_path);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      return fs.createReadStream(call.recording_path).pipe(res);
    }

    const s = await one<any>(`select * from settings where workspace_id=$1`, [ws]);
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) {
      return res.status(400).json({ error: 'Twilio is not configured' });
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${s.twilio_account_sid}/Recordings/${call.recording_sid}.mp3`;
    const auth = Buffer.from(`${s.twilio_account_sid}:${dec(s.twilio_auth_token)}`).toString('base64');
    const upstream = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });

    if (!upstream.ok || !upstream.body) {
      return res.status(502).json({ error: 'Could not fetch the recording from Twilio' });
    }

    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(Buffer.from(await upstream.arrayBuffer()));
  }),
);

/** Numbers the admin can hand out as caller IDs, for the per-user setting. */
adminRouter.get(
  '/caller-ids',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q(`select number, label, active from caller_ids where workspace_id=$1 order by created_at asc`, [ws]);
    res.json({ rows });
  }),
);
