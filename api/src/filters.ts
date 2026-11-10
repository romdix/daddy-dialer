/** Shared lead-filter -> SQL builder, used by the leads list and session builder. */
export interface LeadFilter {
  search?: string;
  status?: string;
  outcome?: string;
  city?: string;
  state?: string;
  calledAfter?: string;
  calledBefore?: string;
  neverCalled?: boolean;
}

export function buildLeadWhere(f: LeadFilter, startIndex = 2, assignedTo?: string | null): { sql: string; params: any[] } {
  const params: any[] = []; // $1 is workspace id
  const parts: string[] = [];
  let i = startIndex;

  // Staff only ever see the leads the admin gave them.
  if (assignedTo) {
    parts.push(`assigned_user_id = $${i++}`);
    params.push(assignedTo);
  }

  if (f.search?.trim()) {
    parts.push(
      `(business_name || ' ' || phone || ' ' || coalesce(city,'') || ' ' || coalesce(address,'')) ilike $${i++}`,
    );
    params.push(`%${f.search.trim()}%`);
  }
  if (f.status && f.status !== 'all') {
    parts.push(`status = $${i++}`);
    params.push(f.status);
  }
  if (f.outcome && f.outcome !== 'all') {
    if (f.outcome === 'none') parts.push(`outcome is null`);
    else {
      parts.push(`outcome = $${i++}`);
      params.push(f.outcome);
    }
  }
  if (f.city) {
    parts.push(`lower(city) = lower($${i++})`);
    params.push(f.city);
  }
  if (f.state) {
    parts.push(`lower(state) = lower($${i++})`);
    params.push(f.state);
  }
  if (f.neverCalled) parts.push(`last_called_at is null`);
  if (f.calledAfter) {
    parts.push(`last_called_at >= $${i++}`);
    params.push(f.calledAfter);
  }
  if (f.calledBefore) {
    parts.push(`last_called_at <= $${i++}`);
    params.push(f.calledBefore);
  }

  return { sql: parts.length ? `and ${parts.join(' and ')}` : '', params };
}

export const SORTABLE: Record<string, string> = {
  business_name: 'business_name',
  phone: 'phone',
  city: 'city',
  state: 'state',
  status: 'status',
  outcome: 'outcome',
  last_called_at: 'last_called_at',
  created_at: 'created_at',
};

/** Normalize a raw phone into digits with a US country code when it looks domestic. */
export function normalizePhone(raw: string): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  let d = digits;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10) d = '1' + d;
  if (d.startsWith('011') && d.length > 12) d = d.slice(3);

  if (d.length < 10 || d.length > 15) return null;
  if (d[0] === '0') return null;
  return d;
}

export function toE164(norm: string): string {
  return `+${norm}`;
}

export function formatPhone(norm: string): string {
  if (norm.length === 11 && norm.startsWith('1')) {
    return `+1 (${norm.slice(1, 4)}) ${norm.slice(4, 7)}-${norm.slice(7)}`;
  }
  return `+${norm}`;
}
