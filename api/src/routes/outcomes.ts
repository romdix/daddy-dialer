import { Router } from 'express';
import { one, q } from '../db';
import { requireAuth, wrap } from '../middleware';
import { requireAdmin } from '../adminauth';
import { primaryWorkspaceId } from '../workspace';
import { slugify } from '../outcomes';

/** The list the dialer uses to draw its disposition chips. */
export const outcomesRouter = Router();

outcomesRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const rows = await q(
      `select id, key, label, color, kind, sort
         from outcomes
        where workspace_id=$1 and active=true
        order by sort asc, label asc`,
      [req.ctx!.workspaceId],
    );
    res.json({ rows });
  }),
);

/** Admin management: everything, including retired tags. */
export const adminOutcomesRouter = Router();
adminOutcomesRouter.use(requireAdmin);

adminOutcomesRouter.get(
  '/',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const rows = await q(
      `select o.id, o.key, o.label, o.color, o.kind, o.sort, o.active, o.created_at,
              (select count(*) from call_logs c where c.outcome = o.key and c.workspace_id = o.workspace_id)::int as uses
         from outcomes o
        where o.workspace_id=$1
        order by o.active desc, o.sort asc, o.label asc`,
      [ws],
    );
    res.json({ rows });
  }),
);

adminOutcomesRouter.post(
  '/',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const label = String(req.body?.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Give the tag a name' });
    if (label.length > 40) return res.status(400).json({ error: 'Keep the name under 40 characters' });

    const color = String(req.body?.color || 'zinc');
    const kind = String(req.body?.kind || 'custom');

    let key = slugify(label);
    const clash = await one(`select id from outcomes where workspace_id=$1 and key=$2`, [ws, key]);
    if (clash) key = `${key}_${Date.now().toString(36).slice(-3)}`;

    const max = await one<{ n: number }>(
      `select coalesce(max(sort), 0)::int as n from outcomes where workspace_id=$1`,
      [ws],
    );

    const row = await one(
      `insert into outcomes (workspace_id, key, label, color, kind, sort)
       values ($1,$2,$3,$4,$5,$6) returning *`,
      [ws, key, label, color, kind, (max?.n || 0) + 10],
    );
    res.json(row);
  }),
);

adminOutcomesRouter.patch(
  '/:id',
  wrap(async (req, res) => {
    const b = req.body || {};
    const sets: string[] = [];
    const params: any[] = [req.params.id];
    let i = 2;
    const push = (col: string, v: any) => {
      sets.push(`${col}=$${i++}`);
      params.push(v);
    };

    if (typeof b.label === 'string') {
      const label = b.label.trim();
      if (!label) return res.status(400).json({ error: 'Give the tag a name' });
      push('label', label.slice(0, 40));
    }
    if (typeof b.color === 'string') push('color', b.color);
    if (typeof b.kind === 'string') push('kind', b.kind);
    if (b.sort !== undefined) push('sort', Number(b.sort) || 100);
    if (typeof b.active === 'boolean') push('active', b.active);

    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

    const row = await one(`update outcomes set ${sets.join(', ')} where id=$1 returning *`, params);
    if (!row) return res.status(404).json({ error: 'Tag not found' });
    res.json(row);
  }),
);

adminOutcomesRouter.delete(
  '/:id',
  wrap(async (req, res) => {
    // Retire rather than delete: past calls keep their tag.
    const row = await one(`update outcomes set active=false where id=$1 returning id, label`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Tag not found' });
    res.json({ ok: true, retired: row.label });
  }),
);
