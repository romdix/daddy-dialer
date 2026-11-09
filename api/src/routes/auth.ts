import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, q, tx } from '../db';
import { config } from '../config';
import { newToken, sha256, mask } from '../crypto';
import { requireAuth, wrap } from '../middleware';

export const authRouter = Router();

const COOKIE = (token: string) => ({
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProd,
  domain: config.cookieDomain,
  maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  path: '/',
});

async function startSession(res: any, userId: string) {
  const token = newToken();
  const expires = new Date(Date.now() + config.sessionDays * 24 * 60 * 60 * 1000);
  await q(
    `insert into auth_sessions (token_hash, user_id, expires_at) values ($1,$2,$3)`,
    [sha256(token), userId, expires],
  );
  res.cookie(config.cookieName, token, COOKIE(token));
}

authRouter.post(
  '/signup',
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim() || null;

    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const existing = await one(`select id from users where lower(email)=lower($1)`, [email]);
    if (existing) return res.status(409).json({ error: 'That email already has an account. Sign in instead.' });

    const hash = await bcrypt.hash(password, 10);
    const userId = await tx(async (c) => {
      const u = await c.query(`insert into users (email, password_hash, full_name) values ($1,$2,$3) returning id`, [
        email,
        hash,
        fullName,
      ]);
      const uid = u.rows[0].id as string;
      const w = await c.query(`insert into workspaces (name) values ($1) returning id`, [
        `${fullName || email.split('@')[0]}'s workspace`,
      ]);
      const wid = w.rows[0].id as string;
      await c.query(`insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`, [wid, uid]);
      await c.query(`insert into settings (workspace_id) values ($1)`, [wid]);
      return uid;
    });

    await startSession(res, userId);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  wrap(async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await one<{ id: string; password_hash: string }>(
      `select id, password_hash from users where lower(email)=lower($1)`,
      [email],
    );
    if (!user) return res.status(401).json({ error: 'Wrong email or password' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Wrong email or password' });
    await startSession(res, user.id);
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/logout',
  wrap(async (req, res) => {
    const raw = (req as any).cookies?.[config.cookieName];
    if (raw) await q(`delete from auth_sessions where token_hash=$1`, [sha256(raw)]);
    res.clearCookie(config.cookieName, { path: '/' });
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/password',
  requireAuth,
  wrap(async (req, res) => {
    const current = String(req.body?.current || '');
    const next = String(req.body?.next || '');
    if (next.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const user = await one<{ password_hash: string }>(`select password_hash from users where id=$1`, [
      req.ctx!.userId,
    ]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const ok = await bcrypt.compare(current, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is wrong' });

    await q(`update users set password_hash=$2 where id=$1`, [req.ctx!.userId, await bcrypt.hash(next, 10)]);

    // Sign out everywhere else, keep this browser.
    const raw = (req as any).cookies?.[config.cookieName];
    if (raw) {
      await q(`delete from auth_sessions where user_id=$1 and token_hash <> $2`, [req.ctx!.userId, sha256(raw)]);
    }
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  wrap(async (req, res) => {
    const ctx = req.ctx!;
    const s = await one<any>(`select * from settings where workspace_id=$1`, [ctx.workspaceId]);
    res.json({
      user: { id: ctx.userId, email: ctx.email, fullName: ctx.fullName },
      workspace: { id: ctx.workspaceId, name: ctx.workspaceName },
      provider: s?.provider || 'twilio',
      twilio: {
        accountSid: s?.twilio_account_sid || null,
        authToken: mask(s?.twilio_auth_token),
        number: s?.twilio_number || null,
        twimlApp: s?.twilio_twiml_app || null,
      },
      telnyx: {
        apiKey: mask(s?.telnyx_api_key),
        number: s?.telnyx_number || null,
        connectionId: s?.telnyx_connection_id || null,
      },
      recordingEnabled: s?.recording_enabled ?? true,
      ringTimeoutSec: s?.ring_timeout_sec ?? 30,
    });
  }),
);
