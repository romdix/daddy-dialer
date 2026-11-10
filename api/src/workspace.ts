import { one, q } from './db';

let cached: string | null = null;

/** Accepts the admin cookie or a signed-in user; returns the workspace to act on. */
export async function workspaceFor(req: any): Promise<string | null> {
  if (req?.cookies?.dd_admin) {
    const { isAdminRequest } = await import('./adminauth');
    if (isAdminRequest(req)) return primaryWorkspaceId();
  }
  return req?.ctx?.workspaceId || null;
}
export async function primaryWorkspaceId(): Promise<string> {
  if (cached) return cached;
  const existing = await one<any>(`select id from workspaces order by created_at asc limit 1`);
  if (existing?.id) {
    cached = existing.id as string;
    return cached;
  }
  const created = await one<any>(`insert into workspaces (name) values ('Workspace') returning id`);
  await q(`insert into settings (workspace_id) values ($1) on conflict (workspace_id) do nothing`, [created!.id]);
  cached = created!.id as string;
  return cached;
}
