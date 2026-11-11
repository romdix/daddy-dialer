import { q } from './db';

/** Keys the workspace currently accepts as a disposition. */
export async function activeOutcomeKeys(workspaceId: string): Promise<Set<string>> {
  const rows = await q<{ key: string }>(
    `select key from outcomes where workspace_id=$1 and active=true`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.key));
}

export function slugify(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'tag'
  );
}
