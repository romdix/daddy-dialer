import { Router } from 'express';
import { one, q, tx } from '../db';
import { wrap } from '../middleware';
import { requireAdmin } from '../adminauth';
import { primaryWorkspaceId } from '../workspace';
import { normalizePhone, formatPhone } from '../filters';

/**
 * The admin's own lead pool. Leads here have no owner; per-rep leads never
 * appear in these queries. Uploads are remembered by file name so a whole
 * file can be handed to a rep later.
 */
export const poolRouter = Router();
poolRouter.use(requireAdmin);

const clean = (v: any) => (v == null ? null : String(v).trim() || null);

/* ------------------------------- pool leads ------------------------------ */

poolRouter.get(
  '/leads',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const uploadId = String(req.query.uploadId || '');

    const params: any[] = [ws];
    const parts: string[] = ['l.assigned_user_id is null'];
    if (search) {
      params.push(`%${search}%`);
      parts.push(
        `(l.business_name ilike $${params.length} or l.phone ilike $${params.length} or coalesce(l.city,'') ilike $${params.length})`,
      );
    }
    if (uploadId) {
      params.push(uploadId);
      parts.push(`l.upload_id = $${params.length}`);
    }

    const rows = await q(
      `select l.*, up.filename as upload_name, count(*) over() as total
         from leads l
         left join lead_uploads up on up.id = l.upload_id
        where l.workspace_id=$1 and ${parts.join(' and ')}
        order by l.created_at asc
        limit ${limit} offset ${offset}`,
      params,
    );
    const total = rows.length ? Number((rows[0] as any).total) : 0;
    res.json({
      rows: rows.map(({ total: _t, ...r }: any) => r),
      total,
      page,
      pages: Math.ceil(total / limit) || 1,
    });
  }),
);

poolRouter.post(
  '/leads',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const b = req.body || {};
    const phone = String(b.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });

    const norm = normalizePhone(phone);
    if (!norm || norm.length < 7) return res.status(400).json({ error: 'That phone number does not look usable' });

    const dupe = await one(`select id from leads where workspace_id=$1 and phone_norm=$2`, [ws, norm]);
    if (dupe) return res.status(409).json({ error: 'A lead with that phone number already exists' });

    const row = await one(
      `insert into leads (workspace_id, business_name, phone, phone_norm, address, city, state, zip,
                          website, email, notes, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}'::jsonb) returning *`,
      [
        ws,
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
      ],
    );
    res.json(row);
  }),
);

poolRouter.delete(
  '/leads/:id',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const r = await q(
      `delete from leads where id=$1 and workspace_id=$2 and assigned_user_id is null returning id`,
      [req.params.id, ws],
    );
    if (!r.length) return res.status(404).json({ error: 'Lead not found in the pool' });
    res.json({ ok: true });
  }),
);

/* -------------------------------- uploads -------------------------------- */

poolRouter.get(
  '/uploads',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q(
      `select up.id, up.filename, up.created_at,
              count(l.id)::int as total,
              count(l.id) filter (where l.assigned_user_id is null)::int as remaining,
              count(distinct l.assigned_user_id)::int as assignees
         from lead_uploads up
         left join leads l on l.upload_id = up.id
        where up.workspace_id = $1
        group by up.id
        order by up.created_at desc
        limit 200`,
      [ws],
    );
    res.json({ rows });
  }),
);

poolRouter.post(
  '/import',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const records: any[] = Array.isArray(req.body?.records) ? req.body.records : [];
    const filename = String(req.body?.filename || 'upload.csv').slice(0, 200);
    if (!records.length) return res.status(400).json({ error: 'No rows to import' });
    if (records.length > 5000) return res.status(400).json({ error: 'Send at most 5,000 rows per batch' });

    let invalid = 0;
    const seen = new Set<string>();
    const valid: { norm: string; rec: any }[] = [];
    for (const r of records) {
      const norm = normalizePhone(r.phone ?? r.phone_number ?? '');
      if (!norm) {
        invalid++;
        continue;
      }
      if (seen.has(norm)) continue;
      seen.add(norm);
      valid.push({ norm, rec: r });
    }

    const created = await tx(async (c) => {
      const up = await c.query(
        `insert into lead_uploads (workspace_id, filename, total) values ($1,$2,$3) returning id`,
        [ws, filename, valid.length],
      );
      const uploadId = up.rows[0].id as string;

      let made = 0;
      const CHUNK = 400;
      for (let start = 0; start < valid.length; start += CHUNK) {
        const slice = valid.slice(start, start + CHUNK);
        const values: string[] = [];
        const params: any[] = [ws, uploadId];
        let p = 3;
        for (const { norm, rec } of slice) {
          values.push(`($1, $2, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
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
          `insert into leads (workspace_id, upload_id, business_name, phone, phone_norm, address, city, state,
                              zip, website, email, notes, metadata)
           values ${values.join(',')}
           on conflict (workspace_id, phone_norm) do nothing
           returning id`,
          params,
        );
        made += result.rowCount || 0;
      }
      await c.query(`update lead_uploads set total=$2 where id=$1`, [uploadId, made]);
      return made;
    });

    res.json({ created, duplicates: valid.length - created, invalid, received: records.length });
  }),
);

poolRouter.post(
  '/uploads/:id/assign',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const userId = String(req.body?.userId || '');
    if (!userId) return res.status(400).json({ error: 'Pick a user' });
    const user = await one<any>(`select id, deleted_at from users where id=$1`, [userId]);
    if (!user || user.deleted_at) return res.status(404).json({ error: 'User not found' });

    const limit = Math.max(1, Math.min(100000, Number(req.body?.limit) || 100000));
    const out = await q(
      `update leads set assigned_user_id=$3, updated_at=now()
        where id in (
          select id from leads
           where workspace_id=$1 and upload_id=$2 and assigned_user_id is null
           order by created_at asc limit $4
        )
        returning id`,
      [ws, req.params.id, userId, limit],
    );
    res.json({ assigned: out.length });
  }),
);

poolRouter.delete(
  '/uploads/:id',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    // Only the part of the file nobody has been given yet is removed.
    const gone = await q(
      `delete from leads where workspace_id=$1 and upload_id=$2 and assigned_user_id is null returning id`,
      [ws, req.params.id],
    );
    await q(`delete from lead_uploads where id=$1 and workspace_id=$2`, [req.params.id, ws]);
    res.json({ ok: true, removed: gone.length });
  }),
);

/* -------------------------------- assign --------------------------------- */

poolRouter.post(
  '/assign',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const userId = String(req.body?.userId || '');
    if (!userId) return res.status(400).json({ error: 'Pick a user' });
    const user = await one<any>(`select id, deleted_at from users where id=$1`, [userId]);
    if (!user || user.deleted_at) return res.status(404).json({ error: 'User not found' });

    const ids: string[] = Array.isArray(req.body?.leadIds) ? req.body.leadIds : [];
    const uploadId = req.body?.uploadId ? String(req.body.uploadId) : '';
    const limit = Math.max(1, Math.min(100000, Number(req.body?.limit) || 0));

    const params: any[] = [ws];
    const parts: string[] = ['workspace_id = $1', 'assigned_user_id is null'];
    if (uploadId) {
      params.push(uploadId);
      parts.push(`upload_id = $${params.length}`);
    }
    if (ids.length) {
      params.push(ids);
      parts.push(`id = any($${params.length}::uuid[])`);
    }
    params.push(userId);
    const userIdx = params.length;

    const sql = ids.length
      ? `update leads set assigned_user_id=$${userIdx}, updated_at=now()
          where ${parts.join(' and ')} returning id`
      : `update leads set assigned_user_id=$${userIdx}, updated_at=now()
          where id in (
            select id from leads where ${parts.join(' and ')} order by created_at asc
            ${limit ? `limit ${Number(limit)}` : ''}
          ) returning id`;

    const out = await q(sql, params);
    res.json({ assigned: out.length });
  }),
);
