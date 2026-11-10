import type { Request, Response, NextFunction } from 'express';
import { one } from './db';
import { config } from './config';
import { sha256 } from './crypto';
import { workspaceFor } from './workspace';

export interface Ctx {
  userId: string;
  email: string;
  fullName: string | null;
  workspaceId: string;
  workspaceName: string;
  canUploadLeads: boolean;
  canHearRecordings: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: Ctx;
    }
  }
}

export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  try {
    const raw = (req as any).cookies?.[config.cookieName];
    if (!raw) return next();
    const row = await one<Ctx & { isActive: boolean }>(
      `select u.id as "userId", u.email, u.full_name as "fullName",
              u.can_upload_leads as "canUploadLeads",
              u.can_hear_recordings as "canHearRecordings",
              u.is_active as "isActive",
              w.id as "workspaceId", w.name as "workspaceName"
         from auth_sessions s
         join users u on u.id = s.user_id
         join workspace_members m on m.user_id = u.id
         join workspaces w on w.id = m.workspace_id
        where s.token_hash = $1 and s.expires_at > now()
        order by w.created_at asc
        limit 1`,
      [sha256(raw)],
    );
    // A disabled account keeps its cookie but loses access immediately.
    if (row && row.isActive) req.ctx = row;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/**
 * Resolves which workspace a request acts on: the admin's shared workspace or
 * the signed-in user's. Shared management endpoints hang off this.
 */
export async function attachWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    const ws = await workspaceFor(req);
    if (ws) (req as any).ws = ws;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireWorkspace(req: Request, res: Response, next: NextFunction) {
  if (!(req as any).ws) return res.status(401).json({ error: 'Not signed in' });
  next();
}

/** Gate a route behind a per-user permission granted by the admin. */
export function requirePerm(perm: 'canUploadLeads' | 'canHearRecordings') {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
    if (!req.ctx[perm]) {
      return res.status(403).json({
        error:
          perm === 'canUploadLeads'
            ? 'Your account is not allowed to upload leads. Ask your administrator.'
            : 'Your account is not allowed to listen to recordings.',
      });
    }
    next();
  };
}

export function wrap(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
