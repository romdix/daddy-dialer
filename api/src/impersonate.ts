import type { NextFunction, Request, Response } from 'express';
import { one } from './db';
import { isAdminRequest } from './adminauth';

/**
 * Lets the platform admin operate a rep's lead list with the rep's own queries.
 * The admin UI calls /api/leads?userId=<rep>; this swaps in that user's context
 * so the list, import, edit and delete code paths stay exactly the same.
 */
export async function adminAsUser(req: Request, res: Response, next: NextFunction) {
  if ((req as any).ctx || !isAdminRequest(req)) return next();

  const targetId = String((req.query as any)?.userId || '');
  if (!targetId) return next();

  const u = await one<any>(
    `select u.id, u.email, u.full_name, u.can_upload_leads, u.can_hear_recordings,
            w.id as workspace_id, w.name as workspace_name
       from users u
       join workspace_members m on m.user_id = u.id
       join workspaces w on w.id = m.workspace_id
      where u.id = $1
      order by w.created_at asc
      limit 1`,
    [targetId],
  );
  if (!u) return res.status(404).json({ error: 'User not found' });

  (req as any).ctx = {
    userId: u.id,
    email: u.email,
    fullName: u.full_name,
    workspaceId: u.workspace_id,
    workspaceName: u.workspace_name,
    // The admin is explicitly managing this rep's leads, so uploads are allowed.
    canUploadLeads: true,
    canHearRecordings: true,
  };
  next();
}
