import twilio from 'twilio';
import type { DialerProvider, OutboundRequest, ProviderSettings } from './types';

const AccessToken = twilio.jwt.AccessToken as any;
const VoiceGrant = AccessToken.VoiceGrant;

function client(s: ProviderSettings) {
  if (!s.twilio_account_sid || !s.twilio_auth_token) {
    throw new Error('Twilio is not configured for this workspace');
  }
  return twilio(s.twilio_account_sid, s.twilio_auth_token);
}

function tokenKey(s: ProviderSettings) {
  // Twilio lets you sign access tokens with an API Key (preferred) or the account auth token.
  // Both halves must be present — mixing one half with the other secret produces
  // AccessTokenInvalid (20101) instead of a clear error.
  if (s.twilio_api_key_sid && s.twilio_api_key_secret) {
    return { keySid: s.twilio_api_key_sid, secret: s.twilio_api_key_secret };
  }
  return { keySid: s.twilio_account_sid!, secret: s.twilio_auth_token! };
}

function xmlEscape(v: string) {
  return v.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string),
  );
}

export const twilioProvider: DialerProvider = {
  id: 'twilio',
  label: 'Twilio',

  isConfigured(s) {
    return Boolean(s.twilio_account_sid && s.twilio_auth_token && s.twilio_number);
  },

  async ensureApp(s, publicUrl, appName) {
    if (!this.isConfigured(s)) return null;
    const c = client(s);
    const friendlyName = (appName || 'Power Dialer').slice(0, 64);

    // Reuse the app if it already exists.
    if (s.twilio_twiml_app) {
      try {
        const app = await c.applications(s.twilio_twiml_app).fetch();
        if (app.voiceUrl !== `${publicUrl}/api/voice/twiml` || app.friendlyName !== friendlyName) {
          await c.applications(s.twilio_twiml_app).update({
            voiceUrl: `${publicUrl}/api/voice/twiml`,
            friendlyName,
          });
        }
        return s.twilio_twiml_app;
      } catch {
        // fall through and create a new one
      }
    }

    const app = await c.applications.create({
      friendlyName,
      voiceUrl: `${publicUrl}/api/voice/twiml`,
      voiceMethod: 'POST',
      statusCallback: `${publicUrl}/api/voice/status`,
      statusCallbackMethod: 'POST',
    });
    return app.sid;
  },

  async browserToken(s, identity) {
    const { keySid, secret } = tokenKey(s);
    const token = new AccessToken(s.twilio_account_sid!, keySid, secret, {
      identity,
      ttl: 3600,
    });
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: s.twilio_twiml_app, incomingAllow: false }));
    return { token: token.toJwt(), identity };
  },

  outboundMarkup(s, r, publicUrl) {
    const base = `${publicUrl}/api/voice`;
    // NOTE: this string goes inside an XML attribute, so the separator must be
    // &amp; — a raw & makes Twilio reject the whole document (error 12100).
    const qs = `callLogId=${encodeURIComponent(r.callLogId)}&amp;workspaceId=${encodeURIComponent(r.workspaceId)}`;
    const rec = r.record === false ? 'do-not-record' : 'record-from-answer';
    // Cold calls need a long ring: call screening on modern phones can delay the
    // answer by 20-30 seconds. Twilio's max is 600, we cap at 90.
    const timeout = Math.max(10, Math.min(90, r.ringTimeout || 60));

    if (r.mode === 'conference') {
      const room = `dd-${r.callLogId.slice(0, 8)}`;
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false">${xmlEscape(room)}</Conference>
  </Dial>
</Response>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial answerOnBridge="true" timeout="${timeout}" callerId="${xmlEscape(r.from)}"
        record="${rec}" recordingStatusCallback="${base}/recording?${qs}">
    <Number statusCallback="${base}/status?${qs}" statusCallbackEvent="initiated ringing answered completed"
            statusCallbackMethod="POST">${xmlEscape(r.to)}</Number>
  </Dial>
</Response>`;
  },

  numbers(s) {
    return s.twilio_number ? [s.twilio_number] : [];
  },
};
