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

/** Contacts pulled from GoHighLevel become a named upload batch in the pool. */
crmRouter.post(
  '/pull',
  wrap(async (req, res) => {
    const ws = await primaryWorkspaceId();
    const cfg = await loadGhl(ws);
    if (!cfg) return res.status(400).json({ error: 'Connect GoHighLevel first' });

    const amount = Math.min(1000, Math.max(1, Number(req.body?.amount) || 50));
    const query = String(req.body?.query || '').trim();
    const restart = req.body?.restart === true;
    const assignTo = req.body?.userId ? String(req.body.userId) : null;
    if (assignTo) {
      const u = await one(`select id from users where id=$1 and deleted_at is null`, [assignTo]);
      if (!u) return res.status(404).json({ error: 'User not found' });
    }

    // Each pull continues where the last one stopped, so pressing 50 twice does
    // not hand back the same 50 contacts.
    const st = await one<any>(`select ghl_cursor_id from settings where workspace_id=$1`, [ws]);
    let cursor: string | null = restart ? null : st?.ghl_cursor_id || null;

    const collected: any[] = [];
    let atEnd = false;
    let pages = 0;

    while (collected.length < amount && pages < 12) {
      pages++;
      const want = Math.min(100, amount - collected.length);
      let batch: any[];
      try {
        batch = await listContacts(cfg, { limit: want, startAfterId: cursor, query });
      } catch (e: any) {
        return res.status(502).json({ error: e?.message || 'GoHighLevel refused the request' });
      }

      if (!batch.length) {
        atEnd = true;
        break;
      }
      // Some accounts ignore the cursor; refuse to loop on the same page.
      if (collected.length && cursor && batch[0]?.id === collected[collected.length - 1]?.id) {
        atEnd = true;
        break;
      }

      collected.push(...batch);
      cursor = batch[batch.length - 1]?.id || cursor;
      if (batch.length < want) {
        atEnd = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    // At the end of the list the pointer resets, so the next pull starts a fresh
    // pass (existing numbers are skipped, never duplicated).
    await q(`update settings set ghl_cursor_id=$2, ghl_cursor_at=now() where workspace_id=$1`, [
      ws,
      atEnd ? null : cursor,
    ]);

    if (!collected.length) {
      return res.json({ created: 0, duplicates: 0, invalid: 0, received: 0, atEnd: true, uploadName: null });
    }

    const stamp = new Date().toLocaleString('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const uploadName = `GoHighLevel — ${stamp} — ${collected.length} contacts`;
    const up = await one<{ id: string }>(
      `insert into lead_uploads (workspace_id, filename, total) values ($1,$2,0) returning id`,
      [ws, uploadName],
    );

    let created = 0;
    let duplicates = 0;
    let invalid = 0;

    for (const c of collected) {
      const norm = normalizePhone(String(c.phone || c.phoneNumber || ''));
      if (!norm) {
        invalid++;
        continue;
      }
      const name = String(c.companyName || c.businessName || c.name || '').trim().slice(0, 300) || null;
      const row = await one(
        `insert into leads (workspace_id, assigned_user_id, upload_id, business_name, phone, phone_norm,
                            address, city, state, zip, email, ghl_contact_id, metadata)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (workspace_id, phone_norm) do nothing
         returning id`,
        [
          ws,
          assignTo,
          up!.id,
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
      else {
        duplicates++;
        // Already in the lead list: attach it to this batch (keeping an older file if it has one)
        await q(
          `update leads set upload_id = coalesce(upload_id, $3), ghl_contact_id = coalesce(ghl_contact_id, $4)
            where workspace_id=$1 and phone_norm=$2`,
          [ws, norm, up!.id, c.id || null],
        );
      }
    }

    const tot = await one<{ n: number }>(`select count(*)::int as n from leads where upload_id=$1`, [up!.id]);
    await q(`update lead_uploads set total=$2 where id=$1`, [up!.id, tot?.n || created]);

    res.json({
      created,
      duplicates,
      invalid,
      received: collected.length,
      atEnd,
      uploadName: (tot?.n || created) ? uploadName : null,
      uploadId: (tot?.n || created) ? up!.id : null,
    });
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
