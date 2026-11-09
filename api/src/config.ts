import 'dotenv/config';

function need(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: need('DATABASE_URL', 'postgres://postgres@localhost:5433/romdix_dialer'),
  // Secrets in the DB (Twilio auth token, Telnyx key) are encrypted with this.
  appSecret: need('APP_SECRET', 'dev-only-insecure-secret-change-me'),
  // Public base URL, used for TwiML app + webhook callbacks. No trailing slash.
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:8080').replace(/\/+$/, ''),
  isProd: process.env.NODE_ENV === 'production',
  cookieName: 'dd_session',
  sessionDays: 30,
};

export const OUTCOMES = [
  'connected_dm',
  'connected_gk',
  'connected_other',
  'voicemail',
  'busy',
  'no_answer',
  'bad_number',
  'not_interested',
  'do_not_call',
  'callback_requested',
  'appointment_set',
  'dialed',
] as const;

export const STATUSES = ['new', 'in_progress', 'completed', 'disqualified'] as const;
export const SESSION_STATUSES = ['pending', 'active', 'paused', 'completed'] as const;
