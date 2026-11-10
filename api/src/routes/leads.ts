import { Router } from 'express';
import { q, one, tx } from '../db';
import { requireAuth, requirePerm, wrap } from '../middleware';
import { buildLeadWhere, normalizePhone, formatPhone, SORTABLE, type LeadFilter } from '../filters';
import { OUTCOMES, STATUSES } from '../config';
import { checkCallable } from '../compliance';

export const leadsRouter = Router();

const FIELDS = [
  'business_name',
  'phone',
  'address',
  'city',
  'state',
  'zip',
  'website',
  'email',
  'notes',
  'status',
  'outcome',
  'timezone',
  'callback_at',
] as const;

function pickFilter(req: any): LeadFilter {
  return {
    search: req.query.search,
    status: req.query.status,
    outcome: req.query.outcome,
    city: req.query.city,
    state: req.query.state,
    calledAfter: req.query.calledAfter,
    calledBefore: req.query.calledBefore,
    neverCalled: req.query.neverCalled === '1',
  };
}

leadsRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const filter = pickFilter(req);
    const where = buildLeadWhere(filter, 2, req.ctx!.userId);
    const params = [ws, ...where.params];

    const sortCol = SORTABLE[String(req.query.sort || 'created_at')] || 'created_at';
    const dir = String(req.query.dir || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
    const order =
      sortCol === 'last_called_at' ? `last_called_at ${dir} nulls last` : `${sortCol} ${dir} nulls last`;

    const rows = await q(
      `select *, count(*) over() as total
         from leads
        where workspace_id = $1 ${where.sql}
        order by ${order}
        limit ${limit} offset ${offset}`,
      params,
    );

    const total = rows.length ? Number(rows[0].total) : 0;
    res.json({ rows: rows.map(({ total: _t, ...r }) => r), total, page, pages: Math.ceil(total / limit) || 1 });
  }),
);

leadsRouter.get(
  '/facets',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const cities = await q(
      `select city as value, count(*)::int as count from leads
        where workspace_id=$1 and assigned_user_id=$2 and coalesce(city,'') <> ''
        group by city order by count desc limit 200`,
      [ws, req.ctx!.userId],
    );
    const states = await q(
      `select state as value, count(*)::int as count from leads
        where workspace_id=$1 and assigned_user_id=$2 and coalesce(state,'') <> ''
        group by state order by count desc limit 100`,
      [ws, req.ctx!.userId],
    );
    const totals = await one(
      `select count(*)::int as all_leads,
              count(*) filter (where status='new')::int as new_leads,
              count(*) filter (where last_called_at is null)::int as never_called
         from leads where workspace_id=$1 and assigned_user_id=$2`,
      [ws, req.ctx!.userId],
    );
    res.json({ cities, states, totals });
  }),
);

/** Leads with a scheduled callback, annotated with local time + callable state. */
leadsRouter.get(
  '/callbacks',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const rows = await q<any>(
      `select * from leads
        where workspace_id=$1 and assigned_user_id=$2 and callback_at is not null
        order by callback_at asc
        limit 500`,
      [ws, req.ctx!.userId],
    );
    const settings = await one<any>(
      `select enforce_compliance, call_window_start, call_window_end, call_window_days,
              max_attempts, default_timezone
         from settings where workspace_id=$1`,
      [ws],
    );
    res.json({
      rows: rows.map((r) => ({ ...r, ...checkCallable(r, settings) })),
      serverNow: new Date().toISOString(),
    });
  }),
);

/** Whole lead list as CSV. */
leadsRouter.get(
  '/export.csv',
  requireAuth,
  wrap(async (req, res) => {
    const ws = (req as any).ws || req.ctx!.workspaceId;
    // Staff export only their own leads; the admin exports the whole workspace.
    const owner = req.ctx?.userId || null;
    const rows = owner
      ? await q<any>(
          `select business_name, phone, address, city, state, zip, website, email,
                  status, coalesce(outcome,'') as outcome, attempts,
                  to_char(last_called_at,'YYYY-MM-DD HH24:MI:SS') as last_called_at,
                  to_char(callback_at,'YYYY-MM-DD HH24:MI:SS') as callback_at,
                  coalesce(notes,'') as notes,
                  to_char(created_at,'YYYY-MM-DD HH24:MI:SS') as created_at
             from leads where workspace_id=$1 and assigned_user_id=$2
            order by created_at asc limit 100000`,
          [ws, owner],
        )
      : await q<any>(
          `select business_name, phone, address, city, state, zip, website, email,
                  status, coalesce(outcome,'') as outcome, attempts,
                  to_char(last_called_at,'YYYY-MM-DD HH24:MI:SS') as last_called_at,
                  to_char(callback_at,'YYYY-MM-DD HH24:MI:SS') as callback_at,
                  coalesce(notes,'') as notes,
                  to_char(created_at,'YYYY-MM-DD HH24:MI:SS') as created_at
             from leads where workspace_id=$1 order by created_at asc limit 100000`,
          [ws],
        );

    const head = [
      'business_name', 'phone', 'address', 'city', 'state', 'zip', 'website', 'email',
      'status', 'outcome', 'attempts', 'last_called_at', 'callback_at', 'notes', 'created_at',
    ];
    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [head.join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.business_name, r.phone, r.address, r.city, r.state, r.zip, r.website, r.email,
          r.status, r.outcome, r.attempts, r.last_called_at, r.callback_at, r.notes, r.created_at,
        ]
          .map(esc)
          .join(','),
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\n'));
  }),
);

/**
 * Do-not-call list import. Any matching lead is marked disqualified and can
 * never be dialled again — the check runs on every call attempt.
 */
leadsRouter.post(
  '/do-not-call',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const numbers: string[] = Array.isArray(req.body?.numbers) ? req.body.numbers : [];
    if (!numbers.length) return res.status(400).json({ error: 'Send a list of phone numbers' });
    if (numbers.length > 20000) return res.status(400).json({ error: 'Send at most 20,000 numbers at a time' });

    const norms = new Set<string>();
    for (const n of numbers) {
      const norm = normalizePhone(String(n || ''));
      if (norm) norms.add(norm);
    }
    if (!norms.size) return res.status(400).json({ error: 'None of those looked like phone numbers' });

    const list = [...norms];
    // Staff may only touch their own leads; the admin sees the whole workspace.
    const mine = req.ctx?.userId;
    const updated = await q<{ id: string }>(
      mine
        ? `update leads set outcome='do_not_call', status='disqualified', updated_at=now()
             where workspace_id=$1 and assigned_user_id=$3 and phone_norm = any($2::text[])
             returning id`
        : `update leads set outcome='do_not_call', status='disqualified', updated_at=now()
             where workspace_id=$1 and phone_norm = any($2::text[])
             returning id`,
      mine ? [ws, list, mine] : [ws, list],
    );

    res.json({ received: numbers.length, valid: list.length, marked: updated.length });
  }),
);

const clean = (v: any) => (v == null || String(v).trim() === '' ? null : String(v).trim());

leadsRouter.post(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const norm = normalizePhone(phone);
    if (!norm || norm.length < 7) return res.status(400).json({ error: 'That phone number does not look usable' });

    const dupe = await one(`select id from leads where workspace_id=$1 and phone_norm=$2`, [ws, norm]);
    if (dupe) return res.status(409).json({ error: 'A lead with that phone number already exists' });

    const row = await one(
      `insert into leads (workspace_id, assigned_user_id, business_name, phone, phone_norm,
                          address, city, state, zip, website, email, notes, status, outcome, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}'::jsonb)
       returning *`,
      [
        ws,
        req.ctx!.userId,
        clean(b.business_name),
        formatPhone(norm),
        norm,
        clean(b.address),
        clean(b.city),
        clean(b.state),
        clean(b.zip),
        clean(b.website),
        clean(b.email),
        clean(b.notes),
        STATUSES.includes(b.status) ? b.status : 'new',
        OUTCOMES.includes(b.outcome) ? b.outcome : null,
      ],
    );
    res.json(row);
  }),
);

leadsRouter.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const row = await one(
      `select * from leads where id=$1 and workspace_id=$2 and assigned_user_id=$3`,
      [req.params.id, req.ctx!.workspaceId, req.ctx!.userId],
    );
    if (!row) return res.status(404).json({ error: 'Lead not found' });
    const calls = await q(
      `select id, outcome, duration_sec, called_at, recording_sid, status, notes
         from call_logs where lead_id=$1 order by called_at desc limit 20`,
      [req.params.id],
    );
    const settings = await one<any>(
      `select enforce_compliance, call_window_start, call_window_end, call_window_days,
              max_attempts, default_timezone
         from settings where workspace_id=$1`,
      [req.ctx!.workspaceId],
    );
    res.json({ ...row, calls, ...checkCallable(row as any, settings) });
  }),
);

leadsRouter.patch(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const b = req.body || {};
    const sets: string[] = [];
    const params: any[] = [req.params.id, ws, req.ctx!.userId];
    let i = 4;

    for (const f of FIELDS) {
      if (!(f in b)) continue;
      let v = b[f];
      if (f === 'status' && !STATUSES.includes(v)) continue;
      if (f === 'outcome' && v && !OUTCOMES.includes(v)) continue;
      if (f === 'phone') {
        const norm = normalizePhone(v);
        if (!norm) return res.status(400).json({ error: 'That phone number does not look valid' });
        sets.push(`phone=$${i++}`, `phone_norm=$${i++}`);
        params.push(formatPhone(norm), norm);
        continue;
      }
      if (v === '') v = null;
      sets.push(`${f}=$${i++}`);
      params.push(v);
    }

    if ((req as any).isAdminAsUser && 'assigned_user_id' in b) {
      sets.push(`assigned_user_id=$${i++}`);
      params.push(b.assigned_user_id || null);
    }

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=now()');

    try {
      const row = await one(
        `update leads set ${sets.join(', ')} where id=$1 and workspace_id=$2 and assigned_user_id=$3 returning *`,
        params,
      );
      if (!row) return res.status(404).json({ error: 'Lead not found' });
      res.json(row);
    } catch (e: any) {
      if (String(e?.message || '').includes('leads_unique_phone')) {
        return res.status(409).json({ error: 'Another lead in this workspace already has that phone number' });
      }
      throw e;
    }
  }),
);

leadsRouter.delete(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const r = await q(`delete from leads where id=$1 and workspace_id=$2 and assigned_user_id=$3 returning id`, [
      req.params.id,
      req.ctx!.workspaceId,
      req.ctx!.userId,
    ]);
    if (!r.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  }),
);

/** Import pre-mapped rows. The browser does the CSV parsing + column mapping. */
leadsRouter.post(
  '/import',
  requireAuth,
  requirePerm('canUploadLeads'),
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const records: any[] = Array.isArray(req.body?.records) ? req.body.records : [];
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
        const params: any[] = [ws, req.ctx!.userId];
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
