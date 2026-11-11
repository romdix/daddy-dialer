import { Router } from 'express';
import { one, q } from '../db';
import { wrap } from '../middleware';
import { requireAdmin } from '../adminauth';
import { primaryWorkspaceId } from '../workspace';
import { enc, dec } from '../crypto';
import { loadGhl, pushContact, listContacts } from '../ghl';
import { normalizePhone, formatPhone } from '../filters';

export const crmRouter = Router();
crmRouter.use(requireAdmin);

crmRouter.get(
  '/status',
  wrap(async (_req, res) => {
    const ws = await primaryWorkspaceId();
    const s = await one<any>(
      `select ghl_token, ghl_location_id, ghl_pipeline_id, ghl_stage_id from settings where workspace_id=$1`,
      [ws],
    );
    const hasToken = Boolean(s?.ghl_token && dec(s.ghl_token));
    res.json({
      configured: hasToken && Boolean(s?.ghl_location_id),
      hasToken,
      locationId: s?.ghl_location_id || '',
      pipelineId: s?.ghl_pipeline_id || '',
      stageId: s?.ghl_stage_id || '',
    });
  }),
);

crmRouter.put(
  '/settings',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const b = req.body || {};
    const sets: string[] = [];
    const params: any[] = [ws];
    let i = 2;
    const push = (col: string, v: any) => {
      sets.push(`${col}=$${i++}`);
      params.push(v);
    };

    // A blank token means "keep the saved one".
    if (typeof b.token === 'string' && b.token.trim()) push('ghl_token', enc(b.token.trim()));
    if (typeof b.locationId === 'string') push('ghl_location_id', b.locationId.trim() || null);
    if (typeof b.pipelineId === 'string') push('ghl_pipeline_id', b.pipelineId.trim() || null);
    if (typeof b.stageId === 'string') push('ghl_stage_id', b.stageId.trim() || null);

    if (sets.length) await q(`update settings set ${sets.join(', ')} where workspace_id=$1`, params);
    res.json({ ok: true });
  }),
);

/** Contacts pulled from GoHighLevel become unassigned leads (or go straight to a rep). */
crmRouter.post(
  '/pull',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const cfg = await loadGhl(ws);
    if (!cfg) return res.status(400).json({ error: 'Connect GoHighLevel first' });

    const limit = Math.min(100, Math.max(1, Number(req.body?.limit) || 50));
    const assignTo = req.body?.userId ? String(req.body.userId) : null;
    if (assignTo) {
      const u = await one(`select id from users where id=$1 and deleted_at is null`, [assignTo]);
      if (!u) return res.status(404).json({ error: 'User not found' });
    }

    let contacts: any[];
    try {
      contacts = await listContacts(cfg, limit);
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'GoHighLevel refused the request' });
    }

    let created = 0;
    let duplicates = 0;
    let invalid = 0;

    for (const c of contacts) {
      const norm = normalizePhone(String(c.phone || c.phoneNumber || ''));
      if (!norm) {
        invalid++;
        continue;
      }
      const name = String(c.companyName || c.businessName || c.name || '').trim().slice(0, 300) || null;
      const row = await one(
        `insert into leads (workspace_id, assigned_user_id, business_name, phone, phone_norm,
                            address, city, state, zip, email, ghl_contact_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         on conflict (workspace_id, phone_norm) do nothing
         returning id`,
        [
          ws,
          assignTo,
          name,
          formatPhone(norm),
          norm,
          c.address1 || null,
          c.city || null,
          c.state || null,
          c.postalCode || null,
          c.email || null,
          c.id || null,
          JSON.stringify({ ghl: { id: c.id, tags: c.tags || [] } }),
        ],
      );
      if (row) created++;
      else duplicates++;
    }

    res.json({ created, duplicates, invalid, received: contacts.length });
  }),
);

/** Push leads to GoHighLevel, filtered by session, rep, tag or an explicit list. */
crmRouter.post(
  '/push',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const cfg = await loadGhl(ws);
    if (!cfg) return res.status(400).json({ error: 'Connect GoHighLevel first' });

    const b = req.body || {};
    const ids: string[] = Array.isArray(b.leadIds) ? b.leadIds.filter(Boolean) : [];
    const params: any[] = [ws];
    const parts: string[] = ['l.workspace_id = $1'];
    let sql = '';

    if (ids.length) {
      params.push(ids);
      parts.push(`l.id = any($${params.length}::uuid[])`);
    } else {
      if (b.sessionId) {
        params.push(String(b.sessionId));
        parts.push(`l.id in (select lead_id from session_leads where session_id = $${params.length})`);
      }
      if (b.userId) {
        params.push(String(b.userId));
        parts.push(`l.assigned_user_id = $${params.length}`);
      }
      if (b.outcome) {
        params.push(String(b.outcome));
        parts.push(`l.outcome = $${params.length}`);
      }
    }
    if (b.onlyUnpushed) parts.push('l.ghl_contact_id is null');

    sql = `select l.* from leads l where ${parts.join(' and ')} order by l.created_at asc limit 200`;

    const leads = await q<any>(sql, params);
    if (!leads.length) return res.json({ pushed: 0, failed: 0, existing: 0, total: 0, errors: [] });

    let pushed = 0;
    let existing = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const lead of leads) {
      try {
        const out = await pushContact(cfg, lead);
        await q(`update leads set ghl_contact_id=$2, ghl_pushed_at=now(), updated_at=now() where id=$1`, [
          lead.id,
          out.id,
        ]);
        if (out.existing) existing++;
        else pushed++;
      } catch (e: any) {
        failed++;
        if (errors.length < 5) errors.push(`${lead.phone}: ${e?.message || 'failed'}`);
      }
      // Stay well inside GoHighLevel's rate limit.
      await new Promise((r) => setTimeout(r, 120));
    }

    res.json({ pushed, existing, failed, total: leads.length, errors });
  }),
);
