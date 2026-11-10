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

/** Room name for a call. Deterministic, so a retry joins the same room. */
export function conferenceRoom(callLogId: string) {
  return `call-${callLogId}`;
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
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: s.twilio_twiml_app, incomingAllow: true }));
    return { token: token.toJwt(), identity };
  },

  /** Point one of the account's numbers at our inbound handler. */
  async pointNumberAtInbound(s, number, publicUrl) {
    const c = client(s);
    const list = await c.incomingPhoneNumbers.list({ phoneNumber: number, limit: 1 });
    if (!list.length) return { ok: false, reason: 'not-on-account' };
    await c.incomingPhoneNumbers(list[0].sid).update({
      voiceUrl: `${publicUrl}/api/voice/inbound`,
      voiceMethod: 'POST',
    });
    return { ok: true, sid: list[0].sid };
  },

  /** Hang up a single call leg (used when a machine answers). */
  async endCall(s, callSid) {
    const c = client(s);
    await c.calls(callSid).update({ status: 'completed' });
  },

  /** Send a live call to new instructions (used for the voicemail drop). */
  async redirectCall(s, callSid, url) {
    const c = client(s);
    await c.calls(callSid).update({ url, method: 'POST' });
  },

  /**
   * What the AGENT's browser gets when it connects. It joins the conference room
   * immediately, so the media path is live before the lead's phone even rings.
   * endConferenceOnExit: when the agent hangs up, the whole room closes.
   */
  agentMarkup(r: OutboundRequest, publicUrl: string) {
    const base = `${publicUrl}/api/voice`;
    // Inside an XML attribute the separator must be &amp;.
    const qs = `callLogId=${encodeURIComponent(r.callLogId)}&amp;workspaceId=${encodeURIComponent(r.workspaceId)}`;
    const room = r.room || conferenceRoom(r.callLogId);
    const record =
      r.record === false
        ? ''
        : ` record="record-from-start" recordingStatusCallback="${base}/recording?${qs}" recordingStatusCallbackMethod="POST"`;
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false"${record}
                statusCallback="${base}/conf?${qs}" statusCallbackMethod="POST"
                statusCallbackEvent="start end join leave">${xmlEscape(room)}</Conference>
  </Dial>
</Response>`;
  },

  /**
   * What the LEAD's phone gets. Joining the same room bridges the two parties.
   * endConferenceOnExit: when the lead hangs up, the agent's leg closes too.
   */
  leadMarkup(r: OutboundRequest) {
    const room = r.room || conferenceRoom(r.callLogId);
    // endConferenceOnExit=false on purpose: when the lead is pulled out for a
    // voicemail drop we redirect their leg, and tearing the room down first
    // would cut the message off. The server ends the agent's leg afterwards.
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>
    <Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false">${xmlEscape(room)}</Conference>
  </Dial>
</Response>`;
  },

  /** Places the outbound PSTN leg that joins the lead into the conference room. */
  async dialIntoConference(s, o) {
    const c = client(s);
    const qs = `callLogId=${encodeURIComponent(o.callLogId)}&workspaceId=${encodeURIComponent(o.workspaceId)}`;
    const timeout = Math.max(15, Math.min(90, o.ringTimeout || 60));
    const call = await c.calls.create({
      to: o.to,
      from: o.from,
      url: `${o.publicUrl}/api/voice/lead-twiml?${qs}`,
      method: 'POST',
      timeout,
      statusCallback: `${o.publicUrl}/api/voice/status?${qs}`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      // Asynchronous detection: the call proceeds normally while Twilio listens,
      // and reports "human" vs "machine" a few seconds later. No dead air.
      // Billed per call, so it can be switched off in Settings.
      ...(o.detectVoicemail === false
        ? {}
        : {
            // DetectMessageEnd is required to ever see machine_end_beep — the
            // cheaper 'Enable' mode only reports machine_start, so a voicemail
            // would never be recognised and the call would stay connected.
            machineDetection: 'DetectMessageEnd' as const,
            asyncAmd: 'true',
            asyncAmdStatusCallback: `${o.publicUrl}/api/voice/amd?${qs}`,
            asyncAmdStatusCallbackMethod: 'POST',
          }),
    });
    return { sid: call.sid };
  },

  /** Legacy single-leg markup, kept for the Telnyx path / plain PSTN mode. */
  outboundMarkup(s, r, publicUrl) {
    const base = `${publicUrl}/api/voice`;
    const qs = `callLogId=${encodeURIComponent(r.callLogId)}&amp;workspaceId=${encodeURIComponent(r.workspaceId)}`;
    const rec = r.record === false ? 'do-not-record' : 'record-from-answer';
    const timeout = Math.max(10, Math.min(90, r.ringTimeout || 60));
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
