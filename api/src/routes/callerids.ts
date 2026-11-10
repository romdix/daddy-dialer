import { Router } from 'express';
import { q, one } from '../db';
import { requireWorkspace, wrap } from '../middleware';
import { dec } from '../crypto';
import { normalizePhone, toE164 } from '../filters';
import { baseUrl } from '../baseurl';
import { getProvider } from '../providers';

export const callerIdsRouter = Router();

const list = (ws: string) =>
  q(
    `select id, number, label, active, last_used_at, created_at
       from caller_ids where workspace_id=$1 order by created_at asc`,
    [ws],
  );

callerIdsRouter.get(
  '/',
  requireWorkspace,
  wrap(async (req, res) => {
    res.json({ rows: await list((req as any).ws) });
  }),
);

callerIdsRouter.post(
  '/',
  requireWorkspace,
  wrap(async (req, res) => {
    const ws = (req as any).ws;
    const norm = normalizePhone(String(req.body?.number || ''));
    if (!norm) return res.status(400).json({ error: 'That phone number does not look valid' });
    const label = String(req.body?.label || '').trim().slice(0, 60) || null;
    const row = await one(
      `insert into caller_ids (workspace_id, number, label) values ($1,$2,$3)
       on conflict (workspace_id, number) do update set label = coalesce(excluded.label, caller_ids.label)
       returning *`,
      [ws, toE164(norm), label],
    );
    res.json(row);
  }),
);

callerIdsRouter.patch(
  '/:id',
  requireWorkspace,
  wrap(async (req, res) => {
    const ws = (req as any).ws;
    const sets: string[] = [];
    const params: any[] = [req.params.id, ws];
    let i = 3;
    if (typeof req.body?.label === 'string') {
      sets.push(`label=$${i++}`);
      params.push(req.body.label.trim().slice(0, 60) || null);
    }
    if (typeof req.body?.active === 'boolean') {
      sets.push(`active=$${i++}`);
      params.push(req.body.active);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
    const row = await one(
      `update caller_ids set ${sets.join(', ')} where id=$1 and workspace_id=$2 returning *`,
      params,
    );
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  }),
);

callerIdsRouter.delete(
  '/:id',
  requireWorkspace,
  wrap(async (req, res) => {
    await q(`delete from caller_ids where id=$1 and workspace_id=$2`, [req.params.id, (req as any).ws]);
    res.json({ ok: true });
  }),
);

/** Import every voice-capable number already on the Twilio account. */
callerIdsRouter.post(
  '/sync',
  requireWorkspace,
  wrap(async (req, res) => {
    const ws = (req as any).ws;
    const s = await one<any>(`select * from settings where workspace_id=$1`, [ws]);
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) {
      return res.status(400).json({ error: 'Add your Twilio credentials first.' });
    }
    const twilio = require('twilio');
    const client = twilio(s.twilio_account_sid, dec(s.twilio_auth_token));
    const nums = await client.incomingPhoneNumbers.list({ limit: 50 });
    let added = 0;
    for (const n of nums) {
      if (!n.capabilities?.voice) continue;
      const norm = normalizePhone(n.phoneNumber);
      if (!norm) continue;
      const r = await one(
        `insert into caller_ids (workspace_id, number, label) values ($1,$2,$3)
         on conflict (workspace_id, number) do nothing returning id`,
        [ws, toE164(norm), n.friendlyName || null],
      );
      if (r) added += 1;
    }
    res.json({ rows: await list(ws), found: nums.length, added });
  }),
);

/** Route a number's incoming calls to the browser. */
callerIdsRouter.post(
  '/:id/inbound',
  requireWorkspace,
  wrap(async (req, res) => {
    const ws = (req as any).ws;
    const row = await one<any>(`select * from caller_ids where id=$1 and workspace_id=$2`, [req.params.id, ws]);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const s = await one<any>(`select * from settings where workspace_id=$1`, [ws]);
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) {
      return res.status(400).json({ error: 'Add your Twilio credentials first.' });
    }
    const p = getProvider(s.provider || 'twilio');
    if (!p.pointNumberAtInbound) return res.status(400).json({ error: 'This provider does not support inbound calls' });

    const out = await p.pointNumberAtInbound(
      {
        provider: (s.provider || 'twilio') as any,
        twilio_account_sid: s.twilio_account_sid,
        twilio_auth_token: dec(s.twilio_auth_token),
        twilio_number: s.twilio_number,
      },
      row.number,
      baseUrl(req),
    );
    if (!out.ok) {
      return res.status(400).json({
        error: 'That number is not on your Twilio account — add it in Twilio first, then sync.',
      });
    }
    res.json({ ok: true });
  }),
);
