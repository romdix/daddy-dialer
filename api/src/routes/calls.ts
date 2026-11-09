import { Router } from 'express';
import { q, one } from '../db';
import { requireAuth, wrap } from '../middleware';
import { OUTCOMES } from '../config';
import { dec } from '../crypto';

export const callsRouter = Router();

callsRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(10, Number(req.query.limit) || 50));
    const offset = (page - 1) * limit;
    const search = String(req.query.search || '').trim();
    const outcome = String(req.query.outcome || '');

    const params: any[] = [ws];
    const parts: string[] = [];
    if (search) {
      params.push(`%${search}%`);
      parts.push(`(coalesce(l.business_name,'') ilike $${params.length} or coalesce(c.to_number,'') ilike $${params.length})`);
    }
    if (outcome && outcome !== 'all') {
      if (outcome === 'none') parts.push(`c.outcome is null`);
      else {
        params.push(outcome);
        parts.push(`c.outcome = $${params.length}`);
      }
    }
    const where = parts.length ? `and ${parts.join(' and ')}` : '';

    const rows = await q(
      `select c.*, l.business_name, s.name as session_name, count(*) over() as total
         from call_logs c
         left join leads l on l.id = c.lead_id
         left join calling_sessions s on s.id = c.session_id
        where c.workspace_id = $1 ${where}
        order by c.called_at desc
        limit ${limit} offset ${offset}`,
      params,
    );

    const total = rows.length ? Number(rows[0].total) : 0;
    res.json({ rows: rows.map(({ total: _t, ...r }) => r), total, page, pages: Math.ceil(total / limit) || 1 });
  }),
);

callsRouter.get(
  '/:id',
  requireAuth,
  wrap(async (req, res) => {
    const row = await one(
      `select c.*, l.business_name, l.city, l.state, s.name as session_name
         from call_logs c
         left join leads l on l.id = c.lead_id
         left join calling_sessions s on s.id = c.session_id
        where c.id=$1 and c.workspace_id=$2`,
      [req.params.id, req.ctx!.workspaceId],
    );
    if (!row) return res.status(404).json({ error: 'Call not found' });
    res.json(row);
  }),
);

/** Set or correct the disposition after the fact. */
callsRouter.patch(
  '/:id/outcome',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const outcome = String(req.body?.outcome || '');
    if (!OUTCOMES.includes(outcome as any)) return res.status(400).json({ error: 'Unknown outcome' });

    const row = await one(
      `update call_logs set outcome=$3 where id=$1 and workspace_id=$2 returning *`,
      [req.params.id, ws, outcome],
    );
    if (!row) return res.status(404).json({ error: 'Call not found' });

    if (row.lead_id) {
      const leadStatus =
        outcome === 'do_not_call' || outcome === 'bad_number'
          ? 'disqualified'
          : outcome === 'appointment_set'
            ? 'completed'
            : 'in_progress';
      await q(`update leads set outcome=$2, status=$3, updated_at=now() where id=$1 and workspace_id=$4`, [
        row.lead_id,
        outcome,
        leadStatus,
        ws,
      ]);
    }
    if (row.session_id && row.lead_id) {
      await q(
        `update session_leads set outcome=$3, status='done'
          where session_id=$1 and lead_id=$2`,
        [row.session_id, row.lead_id, outcome],
      );
    }

    res.json(row);
  }),
);

/** Stream the recording through our auth so the provider URL is never exposed. */
callsRouter.get(
  '/:id/recording',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const call = await one<any>(`select * from call_logs where id=$1 and workspace_id=$2`, [
      req.params.id,
      ws,
    ]);
    if (!call?.recording_sid) return res.status(404).json({ error: 'No recording for this call' });

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
    res.setHeader('Cache-Control', 'private, max-age=3600');

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  }),
);
