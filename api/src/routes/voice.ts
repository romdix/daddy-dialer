import { Router } from 'express';
import { q, one } from '../db';
import { requireAuth, wrap } from '../middleware';
import { dec } from '../crypto';
import { ensureConfigured, getProvider, type ProviderSettings } from '../providers';
import { baseUrl } from '../baseurl';
import { normalizePhone, toE164 } from '../filters';
import { checkCallable } from '../compliance';

export const voiceRouter = Router();

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');

async function loadSettings(ws: string): Promise<ProviderSettings> {
  const s = await one<any>(`select * from settings where workspace_id=$1`, [ws]);
  if (!s) throw Object.assign(new Error('Workspace settings missing'), { status: 400 });
  return {
    provider: s.provider || 'twilio',
    twilio_account_sid: s.twilio_account_sid,
    twilio_auth_token: dec(s.twilio_auth_token),
    twilio_number: s.twilio_number,
    twilio_twiml_app: s.twilio_twiml_app,
    twilio_api_key_sid: s.twilio_api_key_sid,
    twilio_api_key_secret: dec(s.twilio_api_key_secret),
    telnyx_api_key: dec(s.telnyx_api_key),
    telnyx_connection_id: s.telnyx_connection_id,
    telnyx_number: s.telnyx_number,
  };
}

async function loadCompliance(ws: string) {
  return one<any>(
    `select enforce_compliance, call_window_start, call_window_end, call_window_days,
            max_attempts, default_timezone
       from settings where workspace_id=$1`,
    [ws],
  );
}

/** Step 1 — the browser asks for a short-lived credential before dialing. */
voiceRouter.get(
  '/token',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const s = await loadSettings(ws);
    const p = ensureConfigured(s);
    const numbers = p.numbers(s);
    if (!numbers.length) throw Object.assign(new Error('No caller ID number saved in Settings'), { status: 400 });

    const creds = await p.browserToken(s, req.ctx!.userId);
    res.json({ ...creds, provider: p.id, fromNumber: numbers[0] });
  }),
);

/** Step 2 — create our call row, then let the browser dial. */
voiceRouter.post(
  '/start',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;

    // Compliance is checked before anything else, so the reason shown is the
    // real one (do-not-call / hours / attempts) rather than a config error.
    const norm = normalizePhone(String(req.body?.to || ''));
    if (!norm) return res.status(400).json({ error: 'That phone number does not look valid' });

    if (req.body?.leadId) {
      const lead = await one<any>(
        `select id, state, timezone, outcome, attempts, callback_at
           from leads where id=$1 and workspace_id=$2`,
        [req.body.leadId, ws],
      );
      if (lead) {
        const verdict = checkCallable(lead, await loadCompliance(ws));
        if (!verdict.callable) {
          return res.status(409).json({ error: verdict.reason, blocked: true });
        }
      }
    }

    const s = await loadSettings(ws);
    const p = ensureConfigured(s);
    const numbers = p.numbers(s);
    if (!numbers.length) throw Object.assign(new Error('No caller ID number saved in Settings'), { status: 400 });

    const row = await one<any>(
      `insert into call_logs (workspace_id, lead_id, session_id, provider, from_number, to_number, status, called_at)
       values ($1,$2,$3,$4,$5,$6,'queued', now())
       returning id`,
      [ws, req.body?.leadId || null, req.body?.sessionId || null, p.id, numbers[0], toE164(norm)],
    );

    const creds = await p.browserToken(s, req.ctx!.userId);
    if (req.body?.leadId) {
      await q(`update leads set attempts = attempts + 1, last_called_at = now() where id=$1 and workspace_id=$2`, [
        req.body.leadId,
        ws,
      ]);
    }
    res.json({ callLogId: row!.id, ...creds, provider: p.id, fromNumber: numbers[0] });
  }),
);

/** Twilio fetches this when the browser call starts. */
voiceRouter.post(
  '/twiml',
  wrap(async (req, res) => {
    const b = req.body || {};
    const callLogId = String(b.callLogId || b.CallLogId || '');
    const workspaceId = String(b.workspaceId || b.WorkspaceId || '');
    const rawTo = String(b.dialTo || b.DialTo || '');

    if (!isUuid(callLogId) || !isUuid(workspaceId)) {
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unknown call.</Say></Response>');
      return;
    }

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call || call.workspace_id !== workspaceId) {
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unknown call.</Say></Response>');
      return;
    }

    if (b.CallSid) {
      await q(
        `update call_logs set provider_call_id=$2, status='dialing' where id=$1 and (provider_call_id is null or provider_call_id='')`,
        [callLogId, String(b.CallSid)],
      );
    }

    const s = await loadSettings(workspaceId);
    const p = getProvider(call.provider);
    const settingsRow = await one<any>(`select recording_enabled, ring_timeout_sec from settings where workspace_id=$1`, [
      workspaceId,
    ]);

    // Second gate: Twilio is asking us what to dial, so re-check there too.
    if (call.lead_id) {
      const lead = await one<any>(
        `select id, state, timezone, outcome, attempts, callback_at
           from leads where id=$1 and workspace_id=$2`,
        [call.lead_id, workspaceId],
      );
      if (lead) {
        const verdict = checkCallable(lead, await loadCompliance(workspaceId));
        if (!verdict.callable) {
          const safe = String(verdict.reason || 'Calling blocked').replace(/[<>&"']/g, ' ');
          await q(`update call_logs set status='blocked', error=$2 where id=$1`, [callLogId, verdict.reason]);
          res.type('text/xml').send(
            `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${safe}</Say></Response>`,
          );
          return;
        }
      }
    }

    const markup = p.outboundMarkup(
      s,
      {
        to: toE164(normalizePhone(rawTo) || call.to_number.replace(/\D/g, '')),
        from: call.from_number,
        callLogId,
        workspaceId,
        leadId: call.lead_id,
        sessionId: call.session_id,
        mode: b.mode === 'conference' ? 'conference' : 'pstn',
        record: settingsRow?.recording_enabled !== false,
        ringTimeout: settingsRow?.ring_timeout_sec || 30,
      },
      baseUrl(req),
    );

    res.type('text/xml').send(markup);
  }),
);

function mapStatus(callStatus: string): string {
  const s = (callStatus || '').toLowerCase();
  if (s === 'answered' || s === 'in-progress') return 'in_progress';
  if (s === 'ringing') return 'ringing';
  if (s === 'initiated' || s === 'queued') return 'dialing';
  if (s === 'busy') return 'busy';
  if (s === 'no-answer') return 'no_answer';
  if (s === 'failed') return 'failed';
  if (s === 'canceled') return 'canceled';
  if (s === 'completed') return 'completed';
  return s || 'unknown';
}

/** Twilio reports call progress here. */
voiceRouter.post(
  '/status',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    const b = req.body || {};
    if (!isUuid(callLogId)) return res.sendStatus(204);

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call) return res.sendStatus(204);

    const status = mapStatus(String(b.CallStatus || ''));
    const duration = Number(b.CallDuration || b.RecordingDuration || 0) || 0;

    const sets: string[] = ['status=$2'];
    const params: any[] = [callLogId, status];
    let i = 3;

    if (duration) {
      sets.push(`duration_sec=$${i++}`);
      params.push(duration);
    }
    if (['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(status)) {
      sets.push('ended_at = coalesce(ended_at, now())');
      if (status === 'completed' && duration === 0) {
        sets[0] = `status=$2`;
        params[1] = 'no_answer';
      }
    }
    if (b.RecordingSid) {
      sets.push(`recording_sid=$${i++}`);
      params.push(String(b.RecordingSid));
    }

    await q(`update call_logs set ${sets.join(', ')} where id=$1`, params);

    if (duration || ['completed', 'busy', 'no_answer'].includes(status)) {
      if (call.lead_id) {
        await q(`update leads set last_called_at=now(), updated_at=now() where id=$1`, [call.lead_id]);
      }
      if (call.session_id && call.lead_id) {
        await q(
          `update session_leads set called_at=coalesce(called_at, now()),
                  status = case when status='pending' then 'done' else status end
            where session_id=$1 and lead_id=$2`,
          [call.session_id, call.lead_id],
        );
      }
    }

    res.sendStatus(204);
  }),
);

/** Twilio reports the finished recording here. */
voiceRouter.post(
  '/recording',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    const b = req.body || {};
    if (isUuid(callLogId) && b.RecordingSid) {
      await q(
        `update call_logs set recording_sid=$2, recording_url=$3,
                duration_sec = greatest(duration_sec, $4)
          where id=$1`,
        [callLogId, String(b.RecordingSid), String(b.RecordingUrl || ''), Number(b.RecordingDuration || 0) || 0],
      );
    }
    res.sendStatus(204);
  }),
);
