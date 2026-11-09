import type { Request, Response, NextFunction } from 'express';
import { one } from './db';
import { config } from './config';
import { sha256 } from './crypto';

export interface Ctx {
  userId: string;
  email: string;
  fullName: string | null;
  workspaceId: string;
  workspaceName: string;
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
    const row = await one<Ctx>(
      `select u.id as "userId", u.email, u.full_name as "fullName",
              w.id as "workspaceId", w.name as "workspaceName"
         from auth_sessions s
         join users u on u.id = s.user_id
         join workspace_members m on m.user_id = u.id
         join workspaces w on w.id = m.workspace_id
        where s.token_hash = $1 and s.expires_at > now()
        order by m.created_at asc
        limit 1`,
      [sha256(raw)],
    );
    if (row) req.ctx = row;
    next();
  } catch (e) {
    next(e);
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.ctx) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function wrap(fn: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}
