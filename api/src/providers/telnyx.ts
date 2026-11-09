import type { DialerProvider, ProviderSettings } from './types';

/**
 * Telnyx adapter.
 *
 * The browser side uses @telnyx/webrtc which logs in with the SIP connection
 * credentials created under the API key. The Call Control API then gives us
 * webhooks for call state, recording and hangup.
 *
 * Phase 2 work: connection + credential provisioning via /v2/sip_connections,
 * outbound call via /v2/calls, and webhook handling in routes/voice.ts.
 */
export const telnyxProvider: DialerProvider = {
  id: 'telnyx',
  label: 'Telnyx',

  isConfigured(s: ProviderSettings) {
    return Boolean(s.telnyx_api_key && s.telnyx_number);
  },

  async ensureApp(s) {
    if (!this.isConfigured(s)) return null;
    // Telnyx has no TwiML app; the SIP connection is created on first use.
    return s.telnyx_connection_id || null;
  },

  async browserToken() {
    throw new Error('Telnyx calling is not wired up yet — switch the provider to Twilio for now.');
  },

  outboundMarkup() {
    throw new Error('Telnyx calling is not wired up yet — switch the provider to Twilio for now.');
  },

  numbers(s) {
    return s.telnyx_number ? [s.telnyx_number] : [];
  },
};
