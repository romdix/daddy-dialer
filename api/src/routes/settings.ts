import { Router } from 'express';
import { one, q } from '../db';
import { enc, dec, mask } from '../crypto';
import { requireAuth, wrap } from '../middleware';
import { getProvider } from '../providers';
import { baseUrl } from '../baseurl';
import type { ProviderId } from '../providers/types';

export const settingsRouter = Router();

async function loadRow(workspaceId: string) {
  return one<any>(`select * from settings where workspace_id=$1`, [workspaceId]);
}

function publicView(s: any) {
  return {
    provider: s?.provider || 'twilio',
    twilio: {
      accountSid: s?.twilio_account_sid || '',
      authToken: mask(s?.twilio_auth_token) || '',
      apiKeySid: s?.twilio_api_key_sid || '',
      apiKeySecret: mask(s?.twilio_api_key_secret) || '',
      number: s?.twilio_number || '',
      twimlApp: s?.twilio_twiml_app || '',
    },
    telnyx: {
      apiKey: mask(s?.telnyx_api_key) || '',
      connectionId: s?.telnyx_connection_id || '',
      number: s?.telnyx_number || '',
    },
    recordingEnabled: s?.recording_enabled ?? true,
    ringTimeoutSec: s?.ring_timeout_sec ?? 30,
    compliance: {
      enforce: s?.enforce_compliance ?? true,
      windowStart: s?.call_window_start ?? 8,
      windowEnd: s?.call_window_end ?? 21,
      windowDays: s?.call_window_days ?? '1,2,3,4,5',
      maxAttempts: s?.max_attempts ?? 0,
      defaultTimezone: s?.default_timezone || '',
    },
    configured: getProvider(s?.provider || 'twilio').isConfigured({
      provider: (s?.provider || 'twilio') as ProviderId,
      ...s,
    }),
  };
}

settingsRouter.get(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const s = await loadRow(req.ctx!.workspaceId);
    res.json(publicView(s));
  }),
);

settingsRouter.put(
  '/',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const b = req.body || {};
    const current = await loadRow(ws);

    const provider: ProviderId = b.provider === 'telnyx' ? 'telnyx' : 'twilio';
    const t = b.twilio || {};
    const x = b.telnyx || {};

    // A blank secret field means "leave what is saved alone".
    const authTokenEnc = t.authToken ? enc(String(t.authToken)) : current?.twilio_auth_token ?? null;
    const apiSecretEnc = t.apiKeySecret ? enc(String(t.apiKeySecret)) : current?.twilio_api_key_secret ?? null;
    const telnyxKeyEnc = x.apiKey ? enc(String(x.apiKey)) : current?.telnyx_api_key ?? null;

    const comp = b.compliance || {};

    await q(
      `insert into settings (workspace_id, provider, twilio_account_sid, twilio_auth_token, twilio_number,
                             twilio_api_key_sid, twilio_api_key_secret, telnyx_api_key, telnyx_connection_id,
                             telnyx_number, recording_enabled, ring_timeout_sec,
                             enforce_compliance, call_window_start, call_window_end, call_window_days,
                             max_attempts, default_timezone, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now())
       on conflict (workspace_id) do update set
         provider = excluded.provider,
         twilio_account_sid = excluded.twilio_account_sid,
         twilio_auth_token = excluded.twilio_auth_token,
         twilio_number = excluded.twilio_number,
         twilio_api_key_sid = excluded.twilio_api_key_sid,
         twilio_api_key_secret = excluded.twilio_api_key_secret,
         telnyx_api_key = excluded.telnyx_api_key,
         telnyx_connection_id = excluded.telnyx_connection_id,
         telnyx_number = excluded.telnyx_number,
         recording_enabled = excluded.recording_enabled,
         ring_timeout_sec = excluded.ring_timeout_sec,
         enforce_compliance = excluded.enforce_compliance,
         call_window_start = excluded.call_window_start,
         call_window_end = excluded.call_window_end,
         call_window_days = excluded.call_window_days,
         max_attempts = excluded.max_attempts,
         default_timezone = excluded.default_timezone,
         updated_at = now()`,
      [
        ws,
        provider,
        (t.accountSid ?? current?.twilio_account_sid ?? null) || null,
        authTokenEnc,
        (t.number ?? current?.twilio_number ?? null) || null,
        (t.apiKeySid ?? current?.twilio_api_key_sid ?? null) || null,
        apiSecretEnc,
        telnyxKeyEnc,
        (x.connectionId ?? current?.telnyx_connection_id ?? null) || null,
        (x.number ?? current?.telnyx_number ?? null) || null,
        b.recordingEnabled ?? current?.recording_enabled ?? true,
        Number(b.ringTimeoutSec ?? current?.ring_timeout_sec ?? 30),
        comp.enforce ?? current?.enforce_compliance ?? true,
        Number(comp.windowStart ?? current?.call_window_start ?? 8),
        Number(comp.windowEnd ?? current?.call_window_end ?? 21),
        String(comp.windowDays ?? current?.call_window_days ?? '1,2,3,4,5'),
        Number(comp.maxAttempts ?? current?.max_attempts ?? 0),
        (comp.defaultTimezone ?? current?.default_timezone ?? null) || null,
      ],
    );

    // Make sure the TwiML app exists and points at this deployment.
    let appSid = current?.twilio_twiml_app || null;
    let appError: string | null = null;
    if (provider === 'twilio') {
      const fresh = await loadRow(ws);
      const brand = await one<{ name: string }>(`select name from app_brand where id=1`);
      try {
        appSid = await getProvider('twilio').ensureApp(
          {
            provider: 'twilio',
            twilio_account_sid: fresh.twilio_account_sid,
            twilio_auth_token: dec(fresh.twilio_auth_token),
            twilio_number: fresh.twilio_number,
            twilio_twiml_app: fresh.twilio_twiml_app,
          },
          baseUrl(req),
          brand?.name,
        );
        if (appSid) await q(`update settings set twilio_twiml_app=$2 where workspace_id=$1`, [ws, appSid]);
      } catch (e: any) {
        appError = e?.message || 'Could not create the Twilio app';
      }
    }

    const s = await loadRow(ws);
    res.json({ ...publicView(s), appError });
  }),
);

settingsRouter.post(
  '/resync',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const s = await loadRow(ws);
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) {
      return res.status(400).json({ error: 'Add your Twilio credentials first.' });
    }
    const brand = await one<{ name: string }>(`select name from app_brand where id=1`);
    const url = `${baseUrl(req)}/api/voice/twiml`;
    try {
      const appSid = await getProvider('twilio').ensureApp(
        {
          provider: 'twilio',
          twilio_account_sid: s.twilio_account_sid,
          twilio_auth_token: dec(s.twilio_auth_token),
          twilio_number: s.twilio_number,
          twilio_twiml_app: s.twilio_twiml_app,
        },
        baseUrl(req),
        brand?.name,
      );
      if (appSid) await q(`update settings set twilio_twiml_app=$2 where workspace_id=$1`, [ws, appSid]);
      res.json({ ok: true, url, appSid });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || 'Could not update the Twilio app' });
    }
  }),
);

settingsRouter.post(
  '/test',
  requireAuth,
  wrap(async (req, res) => {
    const ws = req.ctx!.workspaceId;
    const s = await loadRow(ws);
    if (!s?.twilio_account_sid || !s?.twilio_auth_token) {
      return res.status(400).json({ ok: false, error: 'Add your Twilio Account SID and Auth Token first.' });
    }
    try {
      const twilio = require('twilio');
      const client = twilio(s.twilio_account_sid, dec(s.twilio_auth_token));
      const account = await client.api.accounts(s.twilio_account_sid).fetch();
      const numbers = await client.incomingPhoneNumbers.list({ limit: 20 });
      res.json({
        ok: true,
        account: account.friendlyName,
        status: account.status,
        numbers: numbers.map((n: any) => ({ phone: n.phoneNumber, voice: Boolean(n.capabilities?.voice) })),
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message || 'Twilio rejected those credentials' });
    }
  }),
);
