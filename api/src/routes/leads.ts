import { Router } from 'express';
import { q, one, tx } from '../db';
import { requireAuth, wrap } from '../middleware';
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
    const where = buildLeadWhere(filter, 2);
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
        where workspace_id=$1 and coalesce(city,'') <> ''
        group by city order by count desc limit 200`,
      [ws],
    );
    const states = await q(
      `select state as value, count(*)::int as count from leads
        where workspace_id=$1 and coalesce(state,'') <> ''
        group by state order by count desc limit 100`,
      [ws],
    );
    const totals = await one(
      `select count(*)::int as all_leads,
              count(*) filter (where status='new')::int as new_leads,
              count(*) filter (where last_called_at is null)::int as never_called
         from leads where workspace_id=$1`,
      [ws],
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
        where workspace_id=$1 and callback_at is not null
        order by callback_at asc
        limit 500`,
      [ws],
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

leadsRouter.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const row = await one(
      `select * from leads where id=$1 and workspace_id=$2`,
      [req.params.id, req.ctx!.workspaceId],
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
    const params: any[] = [req.params.id, ws];
    let i = 3;

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

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=now()');

    try {
      const row = await one(
        `update leads set ${sets.join(', ')} where id=$1 and workspace_id=$2 returning *`,
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
    const r = await q(`delete from leads where id=$1 and workspace_id=$2 returning id`, [
      req.params.id,
      req.ctx!.workspaceId,
    ]);
    if (!r.length) return res.status(404).json({ error: 'Lead not found' });
    res.json({ ok: true });
  }),
);

/** Import pre-mapped rows. The browser does the CSV parsing + column mapping. */
leadsRouter.post(
  '/import',
  requireAuth,
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
        const params: any[] = [ws];
        let p = 2;

        for (const { norm, rec } of slice) {
          values.push(
            `($1, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`,
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
          `insert into leads (workspace_id, business_name, phone, phone_norm, address, city, state, zip,
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
