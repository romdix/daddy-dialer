import { one, q } from './db';
import { enc } from './crypto';
import type { ProviderSettings } from './providers/types';

/**
 * Twilio browser (Voice SDK) tokens must be signed with an API Key.
 *
 * The JWT puts the signing key in `iss`; when that is an Account SID Twilio
 * answers AccessTokenInvalid (20101). Every workspace therefore needs an
 * SK... key, so we create one automatically and store it encrypted.
 */
export async function createApiKey(accountSid: string, authToken: string, friendlyName: string) {
  const auth = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Keys.json`, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ FriendlyName: friendlyName.slice(0, 64) }).toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twilio refused to create an API key (${res.status}): ${body.slice(0, 160)}`);
  }
  const json: any = await res.json();
  if (!json?.sid || !json?.secret) throw new Error('Twilio returned no API key secret');
  return { sid: json.sid as string, secret: json.secret as string };
}

/**
 * Make sure the workspace has an API key. Returns settings that can sign tokens.
 * Never throws — a failure falls back to the old behaviour and the call error
 * will explain itself.
 */
export async function ensureApiKey(ws: string, s: ProviderSettings): Promise<ProviderSettings> {
  if (s.provider !== 'twilio') return s;
  if (s.twilio_api_key_sid && s.twilio_api_key_secret) return s;
  if (!s.twilio_account_sid || !s.twilio_auth_token) return s;

  try {
    if (s.twilio_api_key_sid && !s.twilio_api_key_secret) {
      // A half-configured key is worse than none: clear it and start over.
      await q(`update settings set twilio_api_key_sid=null, twilio_api_key_secret=null where workspace_id=$1`, [ws]);
    }
    const brand = await one<{ name: string }>(`select name from app_brand where id=1`);
    const key = await createApiKey(
      s.twilio_account_sid,
      s.twilio_auth_token,
      `${brand?.name || 'Dialer'} browser calling`,
    );
    await q(`update settings set twilio_api_key_sid=$2, twilio_api_key_secret=$3 where workspace_id=$1`, [
      ws,
      key.sid,
      enc(key.secret),
    ]);
    console.log('[twilio] provisioned API key', key.sid);
    return { ...s, twilio_api_key_sid: key.sid, twilio_api_key_secret: key.secret };
  } catch (e: any) {
    console.error('[twilio] could not provision API key:', e?.message);
    return s;
  }
}
