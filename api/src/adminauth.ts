import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config';

export const ADMIN_COOKIE = 'dd_admin';
const TTL_MS = 12 * 60 * 60 * 1000;

export function adminConfigured() {
  return Boolean(config.adminUsername && config.adminPassword);
}

const sign = (payload: string) => crypto.createHmac('sha256', config.appSecret).update(payload).digest('hex');

export function checkAdminCredentials(username: string, password: string): boolean {
  const wantU = String(config.adminUsername || '').trim().toLowerCase();
  const wantP = String(config.adminPassword || '');
  if (!wantU || !wantP) return false;

  const a = Buffer.from(String(username || '').trim().toLowerCase());
  const b = Buffer.from(wantU);
  const c = Buffer.from(String(password || ''));
  const d = Buffer.from(wantP);
  const userOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  const passOk = c.length === d.length && crypto.timingSafeEqual(c, d);
  return userOk && passOk;
}

export function issueAdminCookie(res: Response) {
  const issued = Date.now();
  const payload = `admin.${issued}`;
  res.cookie(ADMIN_COOKIE, `${payload}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    domain: config.cookieDomain,
    maxAge: TTL_MS,
    path: '/',
  });
}

export function clearAdminCookie(res: Response) {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
}

/** True when the request carries a valid, unexpired admin cookie. */
export function isAdminRequest(req: Request): boolean {
  const raw = (req as any).cookies?.[ADMIN_COOKIE];
  if (!raw) return false;
  const parts = String(raw).split('.');
  if (parts.length !== 3) return false;
  const [tag, issued, sig] = parts;
  if (tag !== 'admin') return false;
  const payload = `${tag}.${issued}`;
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const ts = Number(issued);
  return Number.isFinite(ts) && Date.now() - ts < TTL_MS;
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!adminConfigured()) {
    return res
      .status(503)
      .json({ error: 'Admin login is not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD on the server.' });
  }
  if (!isAdminRequest(req)) return res.status(401).json({ error: 'Admin login required' });
  next();
}
