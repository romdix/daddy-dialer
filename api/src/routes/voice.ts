import { Router } from 'express';
import fs from 'node:fs';
import { q, one } from '../db';
import { requireAuth, requireWorkspace, wrap } from '../middleware';
import { dec } from '../crypto';
import { ensureConfigured, getProvider, type ProviderSettings } from '../providers';
import { baseUrl } from '../baseurl';
import { normalizePhone, toE164 } from '../filters';
import { checkCallable } from '../compliance';
import { ensureApiKey } from '../twiliokey';
import { attachLocalCopy, copyRecordingToDisk } from '../recordings';
import {
  deleteVoicemailAudio,
  hasVoicemailAudio,
  saveVoicemailAudio,
  tokenMatches,
  voicemailPath,
  voicemailToken,
} from '../voicemail';

export const voiceRouter = Router();

const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v || '');

const xmlEscape = (v: string) =>
  String(v).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));

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

async function ensureTwimlApp(ws: string, s: ProviderSettings, req: any): Promise<ProviderSettings> {
  if (s.provider !== 'twilio' || !s.twilio_account_sid || !s.twilio_auth_token) return s;
  if (s.twilio_twiml_app) return s;
  try {
    const brand = await one<{ name: string }>(`select name from app_brand where id=1`);
    const appSid = await getProvider('twilio').ensureApp(s, baseUrl(req), brand?.name);
    if (appSid) {
      await q(`update settings set twilio_twiml_app=$2 where workspace_id=$1`, [ws, appSid]);
      return { ...s, twilio_twiml_app: appSid };
    }
  } catch (e: any) {
    console.error('[twilio] twiml app setup failed:', e?.message);
  }
  return s;
}

/** Area code of a NANP number (+1 AAA NXX XXXX), or null. */
function areaCode(e164: string): string | null {
  const d = (e164 || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1, 4);
  return null;
}

/** Choose which number to call from: an explicit pick, else rotate by least-recent use. */
async function pickCallerId(
  ws: string,
  fallback: string | null,
  preferred?: string,
  leadPhone?: string,
): Promise<string | null> {
  if (preferred) {
    const norm = normalizePhone(preferred);
    if (norm) {
      const want = toE164(norm);
      const hit = await one<any>(`select number from caller_ids where workspace_id=$1 and number=$2 and active`, [ws, want]);
      if (hit) {
        await q(`update caller_ids set last_used_at=now() where workspace_id=$1 and number=$2`, [ws, hit.number]);
        return hit.number;
      }
    }
  }

  // Local presence: if we own a number in the lead's area code, use it — people
  // answer local numbers far more often than out-of-state ones.
  const settings = await one<any>(`select local_presence_enabled from settings where workspace_id=$1`, [ws]);
  const ac = leadPhone ? areaCode(leadPhone) : null;
  if (settings?.local_presence_enabled !== false && ac) {
    const local = await one<any>(
      `select number from caller_ids
        where workspace_id=$1 and active and number like $2
        order by last_used_at asc nulls first, created_at asc
        limit 1`,
      [ws, `+1${ac}%`],
    );
    if (local) {
      await q(`update caller_ids set last_used_at=now() where workspace_id=$1 and number=$2`, [ws, local.number]);
      return local.number;
    }
  }

  const next = await one<any>(
    `select number from caller_ids
      where workspace_id=$1 and active
      order by last_used_at asc nulls first, created_at asc
      limit 1`,
    [ws],
  );
  if (next) {
    await q(`update caller_ids set last_used_at=now() where workspace_id=$1 and number=$2`, [ws, next.number]);
    return next.number;
  }
  return fallback;
}

/** Read-only health check for the voice setup. Returns no secrets. */
voiceRouter.get(
  '/diag',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const s = await loadSettings(ws);
    const raw = s.twilio_auth_token || '';
    const out: any = {
      provider: s.provider,
      hasAccountSid: /^AC[0-9a-f]{32}$/i.test(s.twilio_account_sid || ''),
      authTokenLength: raw.length,
      authTokenLooksMasked: raw.includes('•'),
      hasNumber: Boolean(s.twilio_number),
      twimlApp: s.twilio_twiml_app || null,
      apiKeyPresent: Boolean(s.twilio_api_key_sid && s.twilio_api_key_secret),
      tokenIssuer: s.twilio_api_key_sid && s.twilio_api_key_secret ? 'api_key' : 'account_sid',
    };
    if (out.hasAccountSid && raw && !out.authTokenLooksMasked) {
      try {
        const twilio = require('twilio');
        const c = twilio(s.twilio_account_sid, raw);
        const acct = await c.api.accounts(s.twilio_account_sid).fetch();
        out.accountOk = true;
        out.accountStatus = acct.status;
        out.accountName = acct.friendlyName;
        const apps = await c.applications.list({ limit: 5 });
        out.twimlAppMatches = apps.some((a: any) => a.sid === s.twilio_twiml_app);
      } catch (e: any) {
        out.accountOk = false;
        out.accountError = e?.message;
      }
    }
    res.json(out);
  }),
);

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

    const signing = await ensureTwimlApp(ws, await ensureApiKey(ws, s), req);
    const creds = await p.browserToken(signing, req.ctx!.userId);
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

    // Pick the caller ID first (explicit choice or rotation), then fall back.
    const fromNumber = await pickCallerId(ws, numbers[0] || null, String(req.body?.callerId || ''), toE164(norm));
    if (!fromNumber) throw Object.assign(new Error('No caller ID number saved in Settings'), { status: 400 });

    const row = await one<any>(
      `insert into call_logs (workspace_id, lead_id, session_id, provider, from_number, to_number, status, called_at, user_id)
       values ($1,$2,$3,$4,$5,$6,'queued', now(), $7)
       returning id`,
      [ws, req.body?.leadId || null, req.body?.sessionId || null, p.id, fromNumber, toE164(norm), req.ctx!.userId],
    );

    const signing = await ensureTwimlApp(ws, await ensureApiKey(ws, s), req);
    const creds = await p.browserToken(signing, req.ctx!.userId);
    if (req.body?.leadId) {
      await q(`update leads set attempts = attempts + 1, last_called_at = now() where id=$1 and workspace_id=$2`, [
        req.body.leadId,
        ws,
      ]);
    }
    res.json({ callLogId: row!.id, ...creds, provider: p.id, fromNumber });
  }),
);

/**
 * Twilio fetches this when the AGENT's browser call starts.
 *
 * Conference model: the browser joins a named room and stays there. Once, and
 * only once, we then place the lead's PSTN leg into the same room. Both legs
 * see each other only when the lead actually answers and joins — which is what
 * makes "connected" a real, observable fact instead of a guess.
 */
voiceRouter.post(
  '/twiml',
  wrap(async (req, res) => {
    const b = req.body || {};
    const callLogId = String(b.callLogId || b.CallLogId || '');
    const workspaceId = String(b.workspaceId || b.WorkspaceId || '');
    const agentSid = String(b.CallSid || '');
    const publicUrl = baseUrl(req);

    const unknown = () =>
      res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Unknown call.</Say></Response>');

    // Parallel dialling: the browser joins one room, and every lead in the batch
    // is rung into it. First one to answer wins; the rest are hung up.
    const batchId = String(b.batchId || b.BatchId || '');
    if (isUuid(batchId) && isUuid(workspaceId)) {
      const batch = await one<any>(`select * from call_batches where id=$1 and workspace_id=$2`, [batchId, workspaceId]);
      if (!batch) return unknown();

      const first = await one<any>(`select * from call_logs where batch_id=$1 order by called_at asc limit 1`, [batchId]);
      if (!first) return unknown();

      const sb = await loadSettings(workspaceId);
      const pb = getProvider(first.provider);
      const agentMarkup = pb.agentMarkup?.bind(pb);
      if (!agentMarkup) return unknown();

      const settingsRow = await one<any>(
        `select recording_enabled, ring_timeout_sec, amd_enabled, voicemail_drop_enabled from settings where workspace_id=$1`,
        [workspaceId],
      );

      if (agentSid) {
        await q(`update call_batches set agent_call_sid=coalesce(agent_call_sid,$2) where id=$1`, [batchId, agentSid]);
      }

      res.type('text/xml').send(
        agentMarkup(
          {
            to: first.to_number,
            from: first.from_number,
            callLogId: first.id,
            workspaceId,
            room: `batch-${batchId}`,
            record: settingsRow?.recording_enabled !== false,
            ringTimeout: settingsRow?.ring_timeout_sec || 60,
            // Machine detection is off in parallel mode: a machine joining would
            // win the race and kill calls where a real person was answering.
            detectVoicemail: false,
            voicemailDrop: false,
          },
          publicUrl,
        ),
      );

      setImmediate(async () => {
        const pending = await q<any>(
          `select * from call_logs where batch_id=$1 and (lead_call_sid is null or lead_call_sid='')`,
          [batchId],
        );
        for (const r of pending) {
          const claimed = await one<any>(
            `update call_logs set lead_call_sid='pending', status='connecting'
              where id=$1 and (lead_call_sid is null or lead_call_sid='') returning id`,
            [r.id],
          );
          if (!claimed) continue;
          try {
            const out = await pb.dialIntoConference!(sb, {
              to: r.to_number,
              from: r.from_number,
              callLogId: r.id,
              workspaceId,
              publicUrl,
              ringTimeout: settingsRow?.ring_timeout_sec || 60,
              detectVoicemail: false,
            });
            await q(`update call_logs set lead_call_sid=$2, provider_call_id=$2 where id=$1`, [r.id, out.sid]);
            console.log('[voice] batch dialed', r.id.slice(0, 8), out.sid);
          } catch (e: any) {
            await q(`update call_logs set status='failed', error=$2, ended_at=now() where id=$1`, [
              r.id,
              String(e?.message || 'Dial failed').slice(0, 300),
            ]);
          }
        }
      });
      return;
    }

    if (!isUuid(callLogId) || !isUuid(workspaceId)) return unknown();

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    console.log('[voice] twiml hit', callLogId.slice(0, 8), 'agent=', agentSid.slice(0, 8), 'row=', call ? 'yes' : 'no');
    if (!call || call.workspace_id !== workspaceId) return unknown();

    const s = await loadSettings(workspaceId);
    const p = getProvider(call.provider);
    const settingsRow = await one<any>(
      `select recording_enabled, ring_timeout_sec, amd_enabled, voicemail_drop_enabled from settings where workspace_id=$1`,
      [workspaceId],
    );

    // Second gate: Twilio is asking us what to dial, so re-check compliance here too.
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
          res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${safe}</Say></Response>`);
          return;
        }
      }
    }

    const request = {
      to: call.to_number,
      from: call.from_number,
      callLogId,
      workspaceId,
      leadId: call.lead_id,
      sessionId: call.session_id,
      mode: 'conference' as const,
      record: settingsRow?.recording_enabled !== false,
      ringTimeout: settingsRow?.ring_timeout_sec || 60,
      detectVoicemail: settingsRow?.amd_enabled !== false,
      voicemailDrop: settingsRow?.voicemail_drop_enabled === true,
    };

    // No conference support (e.g. Telnyx) -> legacy single-leg markup.
    const agentMarkup = p.agentMarkup?.bind(p);
    const dialInto = p.dialIntoConference?.bind(p);
    if (!agentMarkup || !dialInto) {
      res.type('text/xml').send(p.outboundMarkup(s, request, publicUrl));
      return;
    }

    if (agentSid) {
      await q(`update call_logs set agent_call_sid=coalesce(agent_call_sid,$2) where id=$1`, [callLogId, agentSid]);
    }

    // Answer the agent first — a fast, valid TwiML response matters.
    res.type('text/xml').send(agentMarkup(request, publicUrl));

    // Claim the dial atomically. A reconnecting browser hits /twiml again; it must
    // join the room but must NOT cause a second call to the lead.
    const claimed = await one<any>(
      `update call_logs set lead_call_sid='pending', status='connecting'
        where id=$1 and (lead_call_sid is null or lead_call_sid='' or lead_call_sid='pending')
        returning id`,
      [callLogId],
    );
    if (!claimed) {
      console.log('[voice] dial skipped (already dialed)', callLogId.slice(0, 8));
      return;
    }

    setImmediate(async () => {
      try {
        const r = await dialInto(s, {
          to: call.to_number,
          from: call.from_number,
          callLogId,
          workspaceId,
          publicUrl,
          ringTimeout: request.ringTimeout,
          detectVoicemail: request.detectVoicemail,
          voicemailDrop: request.voicemailDrop,
        });
        await q(`update call_logs set lead_call_sid=$2, provider_call_id=$2 where id=$1`, [callLogId, r.sid]);
        console.log('[voice] lead dialed', callLogId.slice(0, 8), r.sid);
      } catch (e: any) {
        console.error('[voice] dial failed', callLogId.slice(0, 8), e?.message);
        await q(`update call_logs set status='failed', error=$2, ended_at=now() where id=$1`, [
          callLogId,
          String(e?.message || 'Dial failed').slice(0, 300),
        ]);
      }
    });
  }),
);

/** Twilio fetches this when the LEAD's phone answers — it joins the room. */
voiceRouter.post(
  '/lead-twiml',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    const workspaceId = String(req.query.workspaceId || req.body.workspaceId || '');
    const hangup = () => res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    if (!isUuid(callLogId) || !isUuid(workspaceId)) return hangup();
    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call || call.workspace_id !== workspaceId) return hangup();

    const p = getProvider(call.provider);
    if (!p.leadMarkup) return hangup();
    const room = call.batch_id ? `batch-${call.batch_id}` : undefined;
    res.type('text/xml').send(
      p.leadMarkup({ to: call.to_number, from: call.from_number, callLogId, workspaceId, room }),
    );
  }),
);

/** Conference participant events: the only trustworthy "they answered" signal. */
voiceRouter.post(
  '/conf',
  wrap(async (req, res) => {
    res.sendStatus(204);
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    if (!isUuid(callLogId)) return;
    const b = req.body || {};
    const ev = String(b.StatusCallbackEvent || '').toLowerCase();
    const participant = String(b.CallSid || '');
    const confSid = String(b.ConferenceSid || '');

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call) return;

    // A keypad digit briefly pulls the lead out of the room to play the tone.
    // That looks like a hang-up, so ignore the leave event just after a digit.
    const recentDtmf = call.dtmf_at && Date.now() - new Date(call.dtmf_at).getTime() < 15000;
    console.log('[voice] conf', callLogId.slice(0, 8), ev, participant.slice(0, 8));

    if (ev === 'start' && confSid) {
      await q(`update call_logs set conference_sid=$2 where id=$1`, [callLogId, confSid]);
      return;
    }

    // The agent is the browser leg; anyone else in the room is the lead.
    const isLead = participant && participant !== call.agent_call_sid;

    if (ev === 'join' && isLead) {
      await q(
        `update call_logs set status='in_progress', connected_at=coalesce(connected_at, now()),
                lead_call_sid = case when lead_call_sid in ('pending','') or lead_call_sid is null then $2 else lead_call_sid end
          where id=$1`,
        [callLogId, participant],
      );

      // Parallel dialling: whoever answers first wins, everyone else is dropped
      // so nobody is left listening to a ringing phone.
      if (call.batch_id) {
        const siblings = await q<any>(
          `select id, lead_call_sid, session_id, lead_id from call_logs
            where batch_id=$1 and id<>$2 and lead_call_sid like 'CA%'
              and status not in ('completed','no_answer','busy','failed','canceled')`,
          [call.batch_id, callLogId],
        );
        if (siblings.length) {
          try {
            const s2 = await loadSettings(call.workspace_id);
            const p2 = getProvider(call.provider);
            for (const sib of siblings) {
              try {
                await p2.endCall?.(s2, sib.lead_call_sid);
              } catch {
                /* already gone */
              }
              await q(
                `update call_logs set status='canceled', ended_at=now(), error='Cancelled — another call was answered first'
                  where id=$1`,
                [sib.id],
              );
              // Keep them out of this session's queue; they were never really tried.
              if (sib.session_id && sib.lead_id) {
                await q(
                  `update session_leads set status='done', called_at=coalesce(called_at, now())
                    where session_id=$1 and lead_id=$2`,
                  [sib.session_id, sib.lead_id],
                );
              }
            }
            console.log('[voice] batch release', callLogId.slice(0, 8), 'dropped', siblings.length);
          } catch (e: any) {
            console.error('[voice] batch release failed', e?.message);
          }
        }
      }
      return;
    }

    if (ev === 'leave' && isLead) {
      if (recentDtmf) {
        console.log('[voice] leave ignored (keypad)', callLogId.slice(0, 8));
        return;
      }
      await q(
        `update call_logs set status='completed', ended_at=now(),
                duration_sec = greatest(duration_sec, coalesce(extract(epoch from (now()-connected_at))::int, 0))
          where id=$1`,
        [callLogId],
      );
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

      // The lead is gone — free the agent's leg too, so nobody sits in an empty
      // room. Slight delay: during a voicemail drop the lead is redirected out
      // of the conference and must not be cut off mid-message.
      let agentSid = String(call.agent_call_sid || '');
      if (!agentSid && call.batch_id) {
        const b = await one<any>(`select agent_call_sid from call_batches where id=$1`, [call.batch_id]);
        agentSid = String(b?.agent_call_sid || '');
      }
      if (agentSid.startsWith('CA')) {
        setTimeout(() => {
          (async () => {
            try {
              const s2 = await loadSettings(call.workspace_id);
              const p2 = getProvider(call.provider);
              await p2.endCall?.(s2, agentSid);
            } catch {
              /* the browser will hang up on its own */
            }
          })();
        }, 2000);
      }
      return;
    }

    if (ev === 'end') {
      await q(
        `update call_logs set ended_at=coalesce(ended_at, now()),
                status = case when connected_at is not null and status not in ('completed') then 'completed' else status end,
                duration_sec = greatest(duration_sec, coalesce(extract(epoch from (now()-connected_at))::int, 0))
          where id=$1`,
        [callLogId],
      );
    }
  }),
);

/** Live state for the dialer UI — polled every couple of seconds during a call. */
voiceRouter.get(
  '/state',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const callLogId = String(req.query.callLogId || '');
    if (!isUuid(callLogId)) return res.status(400).json({ error: 'Bad call id' });

    const row = await one<any>(
      `select id, status, duration_sec, connected_at, ended_at, error, outcome, answered_by,
              extract(epoch from (now()-connected_at))::int as elapsed
         from call_logs where id=$1 and workspace_id=$2`,
      [callLogId, ws],
    );
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      status: row.status,
      connected: Boolean(row.connected_at),
      ended: Boolean(row.ended_at),
      elapsedSec: Math.max(0, row.elapsed || 0),
      outcome: row.outcome || null,
      answeredBy: row.answered_by || null,
      error: row.error || null,
    });
  }),
);

/**
 * Inbound call: Twilio dials this when someone calls one of the workspace's
 * numbers. We log it and ring every member's browser.
 */
voiceRouter.post(
  '/inbound',
  wrap(async (req, res) => {
    const b = req.body || {};
    const xml = (s: string) => res.type('text/xml').send(s);
    const to = toE164(normalizePhone(String(b.To || '')) || '');
    const normFrom = normalizePhone(String(b.From || ''));
    const from = normFrom ? toE164(normFrom) : String(b.From || '');
    if (!to) return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');

    const owner =
      (await one<any>(`select workspace_id from caller_ids where number=$1 limit 1`, [to])) ||
      (await one<any>(`select workspace_id from settings where twilio_number=$1 limit 1`, [to]));
    if (!owner) {
      console.log('[voice] inbound for unclaimed number', to);
      return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>');
    }
    const ws = owner.workspace_id as string;

    // Attach the call to a lead — create one if this caller is new.
    let lead = normFrom
      ? await one<any>(
          `select id, business_name from leads
            where workspace_id=$1 and regexp_replace(phone,'\D','','g')=$2 limit 1`,
          [ws, normFrom],
        )
      : null;
    if (!lead && normFrom) {
      lead = await one<any>(
        `insert into leads (workspace_id, business_name, phone, phone_norm, status, notes)
         values ($1,$2,$3,$4,'new','Created from an inbound call')
         on conflict (workspace_id, phone_norm) do update set updated_at=now()
         returning id, business_name`,
        [ws, from || 'Inbound caller', from, normFrom],
      );
    }

    const row = await one<any>(
      `insert into call_logs (workspace_id, lead_id, provider, from_number, to_number, direction, status, called_at)
       values ($1,$2,'twilio',$3,$4,'inbound','ringing', now()) returning id`,
      [ws, lead?.id || null, from, to],
    );

    const members = await q<{ user_id: string }>(`select user_id from workspace_members where workspace_id=$1`, [ws]);
    const base = baseUrl(req);
    const qs = `callLogId=${encodeURIComponent(row!.id)}&amp;workspaceId=${encodeURIComponent(ws)}`;
    const clients = members
      .map(
        (m) =>
          `<Client><Identity>${xmlEscape(m.user_id)}</Identity><Parameter name="callLogId" value="${xmlEscape(
            row!.id,
          )}"/></Client>`,
      )
      .join('');

    console.log('[voice] inbound', row!.id.slice(0, 8), 'from', from, 'to', to, 'members', members.length);

    if (!clients) {
      return xml(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Nobody is available to take your call right now. Goodbye.</Say></Response>`,
      );
    }

    xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="25" answerOnBridge="true" callerId="${xmlEscape(from)}"
        action="${base}/api/voice/inbound-done?${qs}" method="POST">
    ${clients}
  </Dial>
</Response>`);
  }),
);

/** Called when the inbound <Dial> finishes — nobody picked up, or the call ended. */
voiceRouter.post(
  '/inbound-done',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    const b = req.body || {};
    const st = String(b.DialCallStatus || '').toLowerCase();
    const duration = Number(b.DialCallDuration || 0) || 0;
    const status =
      st === 'completed' ? 'completed' : st === 'no-answer' ? 'no_answer' : st === 'busy' ? 'busy' : st === 'failed' ? 'failed' : 'canceled';

    if (isUuid(callLogId)) {
      await q(
        `update call_logs set status=$2, duration_sec=greatest(duration_sec,$3),
                ended_at=coalesce(ended_at, now()),
                connected_at=coalesce(connected_at, case when $2='completed' then now() else null end)
          where id=$1`,
        [callLogId, status, duration],
      );
    }
    res.type('text/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, nobody is available to take your call. Please try again later.</Say></Response>',
    );
  }),
);

/** Async answering-machine detection result. */
voiceRouter.post(
  '/amd',
  wrap(async (req, res) => {
    res.sendStatus(204);
    const callLogId = String(req.query.callLogId || req.body.callLogId || '');
    if (!isUuid(callLogId)) return;
    const b = req.body || {};
    const answeredBy = String(b.AnsweredBy || '');
    if (!answeredBy) return;
    console.log('[voice] amd', callLogId.slice(0, 8), answeredBy);

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call) return;

    if (/^machine_|^fax/i.test(answeredBy)) {
      // Twilio cannot distinguish a voicemail box from an IVR — both are "machine".
      // The one signal that reliably means a recording is about to start is the
      // beep. So: beep -> voicemail (and the drop may play), anything else machine
      // -> IVR, and we never speak into an auto-attendant.
      const isBeep = answeredBy === 'machine_end_beep';
      const isFax = answeredBy === 'fax';
      const outcome = isFax ? 'bad_number' : isBeep ? 'voicemail' : 'ivr';

      await q(`update call_logs set answered_by=$2, outcome=coalesce(outcome,$3) where id=$1`, [
        callLogId,
        answeredBy,
        outcome,
      ]);
      if (call.lead_id) {
        await q(`update leads set outcome=$2, status=$3, updated_at=now() where id=$1`, [
          call.lead_id,
          outcome,
          outcome === 'bad_number' ? 'disqualified' : 'in_progress',
        ]);
      }

      const leadSid = String(call.lead_call_sid || '');
      const agentSid = String(call.agent_call_sid || '');

      try {
        const s = await loadSettings(call.workspace_id);
        const p = getProvider(call.provider);
        const cfg = await one<any>(
          `select voicemail_drop_enabled, voicemail_script from settings where workspace_id=$1`,
          [call.workspace_id],
        );
        const dropReady =
          cfg?.voicemail_drop_enabled === true &&
          (hasVoicemailAudio(call.workspace_id) || String(cfg?.voicemail_script || '').trim().length > 0);

        if (dropReady && isBeep && p.redirectCall && leadSid.startsWith('CA')) {
          const qs = `callLogId=${encodeURIComponent(callLogId)}&workspaceId=${encodeURIComponent(call.workspace_id)}`;
          await p.redirectCall(s, leadSid, `${baseUrl(req)}/api/voice/voicemail-twiml?${qs}`);
          console.log('[voice] voicemail drop', callLogId.slice(0, 8), answeredBy);
          // Give the redirect a moment to take hold, then release the agent.
          if (p.endCall && agentSid.startsWith('CA')) {
            setTimeout(() => {
              p.endCall!(s, agentSid).catch(() => {});
            }, 2500);
          }
        } else if (isBeep && p.endCall && leadSid.startsWith('CA')) {
          // A voicemail with no drop configured: still skip it.
          await p.endCall(s, leadSid);
        }
        // Anything else (IVR / phone menu / silence) stays connected on purpose:
        // the rep can press 1 and reach a human.
      } catch (e: any) {
        console.error('[voice] amd handling failed', e?.message);
      }
      return;
    }

    await q(`update call_logs set answered_by=$2 where id=$1`, [callLogId, answeredBy]);
  }),
);

/* ------------------------------------------------------------------------- *
 * Voicemail drop
 * ------------------------------------------------------------------------- */

async function voicemailConfig(ws: string) {
  const s = await one<any>(`select voicemail_drop_enabled, voicemail_script from settings where workspace_id=$1`, [ws]);
  const withAudio = hasVoicemailAudio(ws);
  return {
    enabled: s?.voicemail_drop_enabled ?? false,
    script: s?.voicemail_script || '',
    hasAudio: withAudio,
    audioUrl: withAudio
      ? `/api/voice/voicemail-audio?ws=${encodeURIComponent(ws)}&t=${voicemailToken(ws)}`
      : null,
  };
}

voiceRouter.get(
  '/voicemail',
  requireWorkspace,
  wrap(async (req, res) => {
    res.json(await voicemailConfig((req as any).ws));
  }),
);

voiceRouter.put(
  '/voicemail',
  requireWorkspace,
  wrap(async (req, res) => {
    const ws = (req as any).ws;
    const b = req.body || {};

    if (b.removeAudio === true) deleteVoicemailAudio(ws);
    if (typeof b.audioBase64 === 'string' && b.audioBase64.length > 100) {
      try {
        saveVoicemailAudio(ws, b.audioBase64);
      } catch (e: any) {
        return res.status(400).json({ error: e?.message || 'Could not save that audio file' });
      }
    }

    const script = typeof b.script === 'string' ? b.script.slice(0, 2000) : '';
    await q(
      `update settings set voicemail_drop_enabled=$2, voicemail_script=$3, updated_at=now() where workspace_id=$1`,
      [ws, Boolean(b.enabled), script || null],
    );
    res.json(await voicemailConfig(ws));
  }),
);

/** Twilio fetches the uploaded greeting. Token-protected, no login. */
voiceRouter.get(
  '/voicemail-audio',
  wrap(async (req, res) => {
    const ws = String(req.query.ws || '');
    const token = String(req.query.t || '');
    if (!isUuid(ws) || !tokenMatches(ws, token)) return res.status(403).end();
    const file = voicemailPath(ws);
    if (!fs.existsSync(file)) return res.status(404).end();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(fs.statSync(file).size));
    res.setHeader('Cache-Control', 'private, max-age=300');
    fs.createReadStream(file).pipe(res);
  }),
);

/** The lead's call is redirected here once a machine is detected. */
voiceRouter.post(
  '/voicemail-twiml',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || '');
    const workspaceId = String(req.query.workspaceId || '');
    const xml = (s: string) => res.type('text/xml').send(s);

    if (!isUuid(callLogId) || !isUuid(workspaceId)) {
      return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    }

    const s = await one<any>(`select voicemail_script from settings where workspace_id=$1`, [workspaceId]);
    let body: string;
    if (hasVoicemailAudio(workspaceId)) {
      const url = `${baseUrl(req)}/api/voice/voicemail-audio?ws=${encodeURIComponent(workspaceId)}&t=${voicemailToken(
        workspaceId,
      )}`;
      body = `<Play>${xmlEscape(url)}</Play>`;
    } else if (String(s?.voicemail_script || '').trim()) {
      body = `<Say voice="alice">${xmlEscape(String(s!.voicemail_script).trim())}</Say>`;
    } else {
      body = '<Say voice="alice">Sorry we missed you. We will try again another time.</Say>';
    }

    console.log('[voice] voicemail message played', callLogId.slice(0, 8));
    xml(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}<Hangup/></Response>`);
  }),
);

/* ------------------------------------------------------------------------- *
 * Parallel dialling
 * ------------------------------------------------------------------------- */

/** Queue N leads at once. The browser then joins one room with all of them. */
voiceRouter.post(
  '/batch',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const leadIds: string[] = (Array.isArray(req.body?.leadIds) ? req.body.leadIds : [])
      .map((x: any) => String(x))
      .filter(isUuid);
    if (!leadIds.length) return res.status(400).json({ error: 'Pick at least one lead' });

    const s = await loadSettings(ws);
    const p = ensureConfigured(s);
    const numbers = p.numbers(s);
    const cfg = await one<any>(`select parallel_lines from settings where workspace_id=$1`, [ws]);
    const lines = Math.max(1, Math.min(3, Number(req.body?.lines || cfg?.parallel_lines || 1)));
    const picked = leadIds.slice(0, lines);

    const batch = await one<any>(`insert into call_batches (workspace_id, session_id) values ($1,$2) returning id`, [
      ws,
      req.body?.sessionId || null,
    ]);

    const comp = await loadCompliance(ws);
    const calls: any[] = [];
    const blocked: any[] = [];

    for (const leadId of picked) {
      const lead = await one<any>(
        `select id, phone, state, timezone, outcome, attempts, callback_at from leads where id=$1 and workspace_id=$2`,
        [leadId, ws],
      );
      if (!lead) continue;

      const verdict = checkCallable(lead, comp);
      if (!verdict.callable) {
        blocked.push({ leadId, reason: verdict.reason });
        continue;
      }
      const norm = normalizePhone(lead.phone);
      if (!norm) {
        blocked.push({ leadId, reason: 'Phone number is not valid' });
        continue;
      }

      const to = toE164(norm);
      const from = await pickCallerId(ws, numbers[0] || null, String(req.body?.callerId || ''), to);
      const row = await one<any>(
        `insert into call_logs (workspace_id, lead_id, session_id, provider, from_number, to_number, status, called_at, batch_id, user_id)
         values ($1,$2,$3,$4,$5,$6,'queued',now(),$7,$8) returning id`,
        [ws, lead.id, req.body?.sessionId || null, p.id, from, to, batch.id, req.ctx!.userId],
      );
      await q(`update leads set attempts=attempts+1, last_called_at=now() where id=$1`, [lead.id]);
      calls.push({ callLogId: row.id, leadId: lead.id, to, from });
    }

    if (!calls.length) {
      await q(`delete from call_batches where id=$1`, [batch.id]);
      return res.status(409).json({ error: blocked[0]?.reason || 'Nothing in that batch can be dialled', blocked });
    }

    const signing = await ensureTwimlApp(ws, await ensureApiKey(ws, s), req);
    const creds = await p.browserToken(signing, req.ctx!.userId);
    res.json({ batchId: batch.id, token: creds.token, calls, blocked, provider: p.id });
  }),
);

/** Live view of a batch: which number answered, which are still ringing. */
voiceRouter.get(
  '/batch/:id',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const batch = await one<any>(`select * from call_batches where id=$1 and workspace_id=$2`, [req.params.id, ws]);
    if (!batch) return res.status(404).json({ error: 'Not found' });

    const rows = await q<any>(
      `select c.id, c.lead_id, c.status, c.outcome, c.connected_at, c.ended_at,
              extract(epoch from (now()-c.connected_at))::int as elapsed,
              l.business_name, l.phone
         from call_logs c
         left join leads l on l.id = c.lead_id
        where c.batch_id=$1
        order by c.called_at asc`,
      [batch.id],
    );

    const winner = rows.find((r) => r.connected_at) || null;
    res.json({
      batchId: batch.id,
      calls: rows,
      winnerId: winner?.id || null,
      active: rows.some((r) => !r.ended_at),
      elapsedSec: Math.max(0, winner?.elapsed || 0),
    });
  }),
);

/** Hang up everything in a batch (agent pressed hang up). */
voiceRouter.post(
  '/batch/:id/end',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const batch = await one<any>(`select * from call_batches where id=$1 and workspace_id=$2`, [req.params.id, ws]);
    if (!batch) return res.status(404).json({ error: 'Not found' });

    const s = await loadSettings(ws);
    const rows = await q<any>(
      `select id, lead_call_sid, provider from call_logs
        where batch_id=$1 and status not in ('completed','no_answer','busy','failed','canceled')`,
      [batch.id],
    );

    for (const r of rows) {
      const p = getProvider(r.provider);
      if (String(r.lead_call_sid || '').startsWith('CA')) {
        try {
          await p.endCall?.(s, r.lead_call_sid);
        } catch {
          /* already gone */
        }
      }
      await q(`update call_logs set status='canceled', ended_at=now() where id=$1 and ended_at is null`, [r.id]);
    }

    if (batch.agent_call_sid) {
      try {
        await getProvider('twilio').endCall?.(s, batch.agent_call_sid);
      } catch {
        /* ignore */
      }
    }
    await q(`update call_batches set ended_at=now() where id=$1`, [batch.id]);
    res.json({ ok: true });
  }),
);

/* ------------------------------------------------------------------------- *
 * Keypad tones
 *
 * A Twilio conference does not forward one participant's DTMF to another, so
 * pressing "1" for sales would do nothing. Instead we play the tones on the
 * lead's own leg (which the IVR does hear) and walk them back into the room.
 * ------------------------------------------------------------------------- */

voiceRouter.post(
  '/dtmf',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const callLogId = String(req.body?.callLogId || '');
    const digits = String(req.body?.digits || '').replace(/[^0-9*#ABCD]/gi, '').slice(0, 12);
    if (!isUuid(callLogId) || !digits) return res.status(400).json({ error: 'Bad digits' });

    const call = await one<any>(`select * from call_logs where id=$1 and workspace_id=$2`, [callLogId, ws]);
    if (!call) return res.status(404).json({ error: 'Not found' });

    // Inbound calls are a direct bridge, so the browser can send tones itself.
    if (call.direction === 'inbound') return res.json({ native: true });

    const leadSid = String(call.lead_call_sid || '');
    if (!leadSid.startsWith('CA')) return res.status(409).json({ error: 'The call is not connected yet' });

    const s = await loadSettings(ws);
    const p = getProvider(call.provider);
    if (!p.redirectCall) return res.json({ native: true });

    await q(`update call_logs set dtmf_at=now() where id=$1`, [callLogId]);
    const qs = `callLogId=${encodeURIComponent(callLogId)}&workspaceId=${encodeURIComponent(ws)}&digits=${encodeURIComponent(digits)}`;
    await p.redirectCall(s, leadSid, `${baseUrl(req)}/api/voice/dtmf-twiml?${qs}`);
    console.log('[voice] dtmf', callLogId.slice(0, 8), digits);
    res.json({ ok: true });
  }),
);

/** Fetched by the lead's leg: play the tones, then rejoin the room. */
voiceRouter.post(
  '/dtmf-twiml',
  wrap(async (req, res) => {
    const callLogId = String(req.query.callLogId || '');
    const digits = String(req.query.digits || '').replace(/[^0-9*#ABCD]/gi, '').slice(0, 12);
    const xml = (s: string) => res.type('text/xml').send(s);
    if (!isUuid(callLogId) || !digits) return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
    if (!call) return xml('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');

    const room = call.batch_id ? `batch-${call.batch_id}` : `call-${callLogId}`;
    xml(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play digits="${digits}"/>
  <Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false">${xmlEscape(room)}</Conference></Dial>
</Response>`);
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

    console.log('[voice] status', callLogId.slice(0, 8), b.CallStatus, 'dur', b.CallDuration || 0);

    const status = mapStatus(String(b.CallStatus || ''));
    const duration = Number(b.CallDuration || b.RecordingDuration || 0) || 0;

    const sets: string[] = ['status=$2'];
    const params: any[] = [callLogId, status];
    let i = 3;

    // An answered lead leg means the phone was picked up — start the clock.
    if (status === 'in_progress') {
      sets.push('connected_at = coalesce(connected_at, now())');
    }
    if (duration) {
      sets.push(`duration_sec=greatest(duration_sec, $${i++})`);
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
      console.log('[voice] recording', callLogId.slice(0, 8), b.RecordingSid);
      await q(
        `update call_logs set recording_sid=$2, recording_url=$3,
                duration_sec = greatest(duration_sec, $4)
          where id=$1`,
        [callLogId, String(b.RecordingSid), String(b.RecordingUrl || ''), Number(b.RecordingDuration || 0) || 0],
      );

      // Pull the audio onto this server straight away. Twilio bills storage per
      // stored minute every month, so holding it here is what lets us delete theirs.
      try {
        const call = await one<any>(`select * from call_logs where id=$1`, [callLogId]);
        const s = call ? await loadSettings(call.workspace_id) : null;
        if (call && s?.twilio_account_sid && s?.twilio_auth_token) {
          const copied = await copyRecordingToDisk({
            callLogId,
            workspaceId: call.workspace_id,
            recordingSid: String(b.RecordingSid),
            accountSid: s.twilio_account_sid,
            authToken: s.twilio_auth_token,
          });
          if (copied) {
            await attachLocalCopy(callLogId, copied);
            console.log('[voice] recording saved locally', callLogId.slice(0, 8), copied.bytes, 'bytes');
          }
        }
      } catch (e: any) {
        console.error('[voice] local recording copy failed', callLogId.slice(0, 8), e?.message);
      }
    }
    res.sendStatus(204);
  }),
);
