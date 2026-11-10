export type ProviderId = 'twilio' | 'telnyx';

export interface ProviderSettings {
  provider: ProviderId;
  twilio_account_sid?: string | null;
  twilio_auth_token?: string | null;
  twilio_number?: string | null;
  twilio_twiml_app?: string | null;
  twilio_api_key_sid?: string | null;
  twilio_api_key_secret?: string | null;
  telnyx_api_key?: string | null;
  telnyx_connection_id?: string | null;
  telnyx_number?: string | null;
}

export interface OutboundRequest {
  to: string;          // E.164
  from: string;        // E.164
  callLogId: string;   // our row id, embedded in callbacks
  workspaceId: string;
  leadId?: string | null;
  sessionId?: string | null;
  mode?: 'pstn' | 'conference';
  record?: boolean;
  ringTimeout?: number;
  /** Run answering-machine detection (billed per call by the provider). */
  detectVoicemail?: boolean;
  /** Play the voicemail message when a machine answers. */
  voicemailDrop?: boolean;
  /** Explicit conference room (parallel dialling puts several leads in one room). */
  room?: string;
}

export interface DialerProvider {
  id: ProviderId;
  label: string;
  isConfigured(s: ProviderSettings): boolean;
  /** Create/find the provider-side app object needed for browser calling. */
  ensureApp(s: ProviderSettings, publicUrl: string, appName?: string): Promise<string | null>;
  /** Short-lived credential the browser SDK uses to connect. */
  browserToken(s: ProviderSettings, identity: string): Promise<{ token: string; identity: string }>;
  /** Markup the provider fetches when a browser call starts. */
  outboundMarkup(s: ProviderSettings, r: OutboundRequest, publicUrl: string): string;
  /** Conference-based calling (Twilio). The agent joins, then the lead is dialed in. */
  agentMarkup?(r: OutboundRequest, publicUrl: string): string;
  leadMarkup?(r: OutboundRequest): string;
  pointNumberAtInbound?(s: ProviderSettings, number: string, publicUrl: string): Promise<{ ok: boolean; reason?: string; sid?: string }>;
  endCall?(s: ProviderSettings, callSid: string): Promise<void>;
  redirectCall?(s: ProviderSettings, callSid: string, url: string): Promise<void>;
  dialIntoConference?(
    s: ProviderSettings,
    o: {
      to: string;
      from: string;
      callLogId: string;
      workspaceId: string;
      publicUrl: string;
      ringTimeout?: number;
      detectVoicemail?: boolean;
      voicemailDrop?: boolean;
    },
  ): Promise<{ sid: string }>;
  /** Normalized numbers the workspace can call from. */
  numbers(s: ProviderSettings): string[];
}
