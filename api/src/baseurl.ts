import type { Request } from 'express';
import { config } from './config';

/**
 * The address this request arrived on.
 *
 * PUBLIC_URL (if set) wins, because Twilio and other third parties need one
 * fixed address. Otherwise we trust the proxy headers, so the same container
 * can answer on any number of domains without reconfiguration.
 */
export function baseUrl(req: Request): string {
  if (config.publicUrl) return config.publicUrl;

  const proto =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ||
    req.protocol ||
    'http';

  const host =
    (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ||
    req.get('host') ||
    'localhost';

  return `${proto}://${host}`;
}
