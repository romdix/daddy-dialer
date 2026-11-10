import 'dotenv/config';

function need(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const trimUrl = (v: string) => v.trim().replace(/\/+$/, '');

export const config = {
  port: Number(process.env.PORT || 8080),
  databaseUrl: need('DATABASE_URL', 'postgres://postgres@localhost:5433/romdix_dialer'),
  // Secrets in the DB (Twilio auth token, Telnyx key) are encrypted with this.
  appSecret: need('APP_SECRET', 'dev-only-insecure-secret-change-me'),

  /**
   * Canonical public address. OPTIONAL.
   * Left empty, the app uses whatever domain the request arrived on — so any
   * number of domains pointed at the server just work, no redeploy needed.
   * Set it only when you want one fixed address for Twilio's callbacks.
   */
  publicUrl: trimUrl(process.env.PUBLIC_URL || ''),

  /** Extra hostnames this install answers on (comma separated). Informational. */
  publicUrls: (process.env.PUBLIC_URLS || '')
    .split(',')
    .map(trimUrl)
    .filter(Boolean),

  /** Set to e.g. ".romdix.com" to share the login cookie across subdomains. */
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,

  /** Branding defaults. Applied on first boot only; Settings wins afterwards. */
  brand: {
    name: process.env.BRAND_NAME || '',
    initials: process.env.BRAND_INITIALS || '',
    accent: process.env.BRAND_ACCENT || '',
    logoUrl: process.env.BRAND_LOGO_URL || '',
  },

  isProd: process.env.NODE_ENV === 'production',
  cookieName: 'dd_session',
  sessionDays: 30,

  /**
   * Where call recordings are kept on this server. Mount a volume here so the
   * files survive redeploys (Coolify: custom docker run options -v host:/data/recordings).
   */
  recordingsDir: process.env.RECORDINGS_DIR || '/data/recordings',
};

export const OUTCOMES = [
  'connected_dm',
  'connected_gk',
  'connected_other',
  'voicemail',
  'ivr',
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
