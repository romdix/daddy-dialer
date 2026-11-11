import { one } from './db';
import { dec } from './crypto';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';

export interface GhlConfig {
  token: string;
  locationId: string;
  pipelineId?: string;
  stageId?: string;
}

export async function loadGhl(workspaceId: string): Promise<GhlConfig | null> {
  const s = await one<any>(
    `select ghl_token, ghl_location_id, ghl_pipeline_id, ghl_stage_id
       from settings where workspace_id=$1`,
    [workspaceId],
  );
  const token = s?.ghl_token ? dec(s.ghl_token) : '';
  const locationId = String(s?.ghl_location_id || '');
  if (!token || !locationId) return null;
  return { token, locationId, pipelineId: s?.ghl_pipeline_id || undefined, stageId: s?.ghl_stage_id || undefined };
}

async function ghlFetch(cfg: GhlConfig, path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Version: VERSION,
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!res.ok) {
    const msg = data?.message || data?.error || `GoHighLevel error (${res.status})`;
    const err: any = new Error(String(msg));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** Create the contact, or adopt the one GoHighLevel already has for this phone. */
export async function pushContact(cfg: GhlConfig, lead: any): Promise<{ id: string; existing: boolean }> {
  const body: any = {
    locationId: cfg.locationId,
    name: lead.business_name || lead.phone,
    firstName: lead.business_name || undefined,
    phone: lead.phone || undefined,
    email: lead.email || undefined,
    address1: lead.address || undefined,
    city: lead.city || undefined,
    state: lead.state || undefined,
    postalCode: lead.zip || undefined,
    website: lead.website || undefined,
    source: 'Dialer',
    tags: lead.outcome ? [String(lead.outcome)] : [],
  };
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);

  try {
    const data = await ghlFetch(cfg, '/contacts/', { method: 'POST', body: JSON.stringify(body) });
    const id = data?.contact?.id || data?.id;
    if (!id) throw new Error('GoHighLevel did not return a contact id');
    return { id: String(id), existing: false };
  } catch (e: any) {
    // A duplicate phone is reported as an error carrying the existing id.
    const id = e?.data?.meta?.contactId || e?.data?.contactId;
    if (id) return { id: String(id), existing: true };
    throw e;
  }
}

export async function listContacts(
  cfg: GhlConfig,
  opts: { limit?: number; startAfterId?: string | null; query?: string } = {},
): Promise<any[]> {
  const limit = Math.min(100, Math.max(1, opts.limit || 50));
  const params = new URLSearchParams({ locationId: cfg.locationId, limit: String(limit) });
  if (opts.startAfterId) params.set('startAfterId', opts.startAfterId);
  if (opts.query && opts.query.trim()) params.set('query', opts.query.trim());
  const data = await ghlFetch(cfg, `/contacts/?${params}`);
  return Array.isArray(data?.contacts) ? data.contacts : [];
}
