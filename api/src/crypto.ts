import crypto from 'node:crypto';
import { config } from './config';

const key = crypto.createHash('sha256').update(config.appSecret).digest();

/** Encrypt a secret for storage. Returns `v1:<iv>:<tag>:<ciphertext>` (base64 parts). */
export function enc(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join(':');
}

export function dec(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored; // legacy / plaintext
  try {
    const [, ivB, tagB, dataB] = stored.split(':');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
    d.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([d.update(Buffer.from(dataB, 'base64')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function mask(secret: string | null | undefined): string | null {
  if (!secret) return null;
  const s = dec(secret);
  if (!s) return null;
  return s.length <= 6 ? '••••' : `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function newToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
