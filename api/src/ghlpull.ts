import { one, q } from './db';
import { loadGhl, listContacts, addContactTag, GhlConfig } from './ghl';
import { normalizePhone } from './filters';

export interface PullOpts {
  amount?: number;
  query?: string;
  restart?: boolean;
  state?: string;
  city?: string;
  assignTo?: string | null;
  label?: string;
  /** false = ignore the import tag and let duplicates be counted instead */
  useTag?: boolean;
}

export interface PullResult {
  created: number;
  duplicates: number;
  invalid: number;
  skippedTagged: number;
  skippedArea: number;
  skippedDnc: number;
  skippedRecent: number;
  received: number;
  atEnd: boolean;
  uploadName: string | null;
  uploadId: string | null;
  tagged: number;
}

const stamp = () =>
  new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * One pull from GoHighLevel.
 *
 * - continues where the last pull stopped (cursor), and resets at the end
 * - skips contacts already carrying the import tag (the permanent bookmark)
 * - skips contacts that are not dialable right now: no phone, do-not-call,
 *   called within the last N days, or outside the requested state/city
 * - files what is left as one named upload batch
 * - tags every contact it filed, in the background, so the next pull ignores them
 */
export async function pullFromGhl(ws: string, opts: PullOpts = {}): Promise<PullResult> {
  const cfg = await loadGhl(ws);
  if (!cfg) {
    const err: any = new Error('Connect GoHighLevel first');
    err.status = 400;
    throw err;
  }

  const s = await one<any>(
    `select ghl_cursor_id, ghl_sync_tag, ghl_skip_recent_days from settings where workspace_id=$1`,
    [ws],
  );

  const amount = Math.min(1000, Math.max(1, Number(opts.amount) || 50));
  const query = String(opts.query || '').trim();
  const state = String(opts.state || '').trim().toUpperCase();
  const city = String(opts.city || '').trim().toLowerCase();
  const tag = String(s?.ghl_sync_tag || 'dialer-imported');
  const useTag = opts.useTag !== false && Boolean(tag);
  const skipDays = Math.max(0, Number(s?.ghl_skip_recent_days ?? 90));

  let cursor: string | null = opts.restart ? null : s?.ghl_cursor_id || null;
  const candidates: any[] = [];
  let atEnd = false;
  let pages = 0;
  let skippedTagged = 0;
  let skippedArea = 0;
  let invalid = 0;

  // Scan further than `amount` when filters reject contacts.
  while (candidates.length < amount && pages < 30) {
    pages++;
    const want = Math.min(100, Math.max(10, amount - candidates.length));
    let batch: any[];
    try {
      batch = await listContacts(cfg, { limit: want, startAfterId: cursor, query });
    } catch (e: any) {
      const err: any = new Error(e?.message || 'GoHighLevel refused the request');
      err.status = 502;
      throw err;
    }

    if (!batch.length) {
      atEnd = true;
      break;
    }
    if (cursor && batch[0]?.id === cursor) {
      atEnd = true;
      break;
    }
    cursor = batch[batch.length - 1]?.id || cursor;

    for (const c of batch) {
      if (useTag) {
        const tags: string[] = Array.isArray(c.tags) ? c.tags.map((t: any) => String(t).toLowerCase()) : [];
        if (tags.includes(tag.toLowerCase())) {
          skippedTagged++;
          continue;
        }
      }
      if (state && String(c.state || '').toUpperCase() !== state) {
        skippedArea++;
        continue;
      }
      if (city && !String(c.city || '').toLowerCase().includes(city)) {
        skippedArea++;
        continue;
      }
      const norm = normalizePhone(String(c.phone || c.phoneNumber || ''));
      if (!norm || norm.length < 10) {
        invalid++;
        continue;
      }
      candidates.push({ contact: c, norm });
      if (candidates.length >= amount) break;
    }

    if (batch.length < want) {
      atEnd = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  // Save the pointer even when nothing survived the filters.
  await q(`update settings set ghl_cursor_id=$2, ghl_cursor_at=now() where workspace_id=$1`, [
    ws,
    atEnd ? null : cursor,
  ]);

  // Quality gate against what we already know.
  const norms = candidates.map((c) => c.norm);
  const existing = norms.length
    ? await q<any>(
        `select phone_norm, outcome, last_called_at from leads
          where workspace_id=$1 and phone_norm = any($2::text[])`,
        [ws, norms],
      )
    : [];
  const byPhone = new Map<string, any>(existing.map((r) => [r.phone_norm, r]));
  const cutoff = skipDays > 0 ? Date.now() - skipDays * 86400000 : 0;

  let skippedDnc = 0;
  let skippedRecent = 0;
  const accepted: { contact: any; norm: string }[] = [];
  for (const c of candidates) {
    const prior = byPhone.get(c.norm);
    if (prior?.outcome === 'do_not_call') {
      skippedDnc++;
      continue;
    }
    if (prior?.last_called_at && cutoff && new Date(prior.last_called_at).getTime() > cutoff) {
      skippedRecent++;
      continue;
    }
    accepted.push(c);
  }

  const base: PullResult = {
    created: 0,
    duplicates: 0,
    invalid,
    skippedTagged,
    skippedArea,
    skippedDnc,
    skippedRecent,
    received: candidates.length,
    atEnd,
    uploadName: null,
    uploadId: null,
    tagged: 0,
  };

  if (!accepted.length) return base;

  const uploadName = `${opts.label || 'GoHighLevel'} — ${stamp()} — ${accepted.length} contacts`;
  const up = await one<{ id: string }>(
    `insert into lead_uploads (workspace_id, filename, total) values ($1,$2,0) returning id`,
    [ws, uploadName],
  );

  let created = 0;
  let duplicates = 0;
  const filed: { leadId: string; contactId: string }[] = [];

  for (const { contact: c, norm } of accepted) {
    const name = String(c.companyName || c.businessName || c.name || '').trim().slice(0, 300) || null;
    const row = await one<{ id: string }>(
      `insert into leads (workspace_id, assigned_user_id, upload_id, business_name, phone, phone_norm,
                          address, city, state, zip, email, ghl_contact_id, metadata)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       on conflict (workspace_id, phone_norm) do nothing
       returning id`,
      [
        ws,
        opts.assignTo || null,
        up!.id,
        name,
        String(c.phone || c.phoneNumber || ''),
        norm,
        c.address1 || null,
        c.city || null,
        c.state || null,
        c.postalCode || null,
        c.email || null,
        c.id || null,
        JSON.stringify(c).slice(0, 4000),
      ],
    );

    if (row) {
      created++;
      if (c.id) filed.push({ leadId: row.id, contactId: String(c.id) });
    } else {
      duplicates++;
      const prior = await one<{ id: string }>(
        `update leads set upload_id = coalesce(upload_id, $3), ghl_contact_id = coalesce(ghl_contact_id, $4)
          where workspace_id=$1 and phone_norm=$2
          returning id`,
        [ws, norm, up!.id, c.id || null],
      );
      if (prior && c.id) filed.push({ leadId: prior.id, contactId: String(c.id) });
    }
  }

  const tot = await one<{ n: number }>(`select count(*)::int as n from leads where upload_id=$1`, [up!.id]);
  const inBatch = tot?.n || 0;
  if (inBatch === 0) await q(`delete from lead_uploads where id=$1`, [up!.id]);
  else await q(`update lead_uploads set total=$2 where id=$1`, [up!.id, inBatch]);

  // Tag what we filed so a later pull never offers it again.
  if (useTag && filed.length) void tagFiled(cfg, filed, tag);

  return {
    ...base,
    created,
    duplicates,
    uploadName: inBatch ? uploadName : null,
    uploadId: inBatch ? up!.id : null,
    tagged: useTag ? filed.length : 0,
  };
}

async function tagFiled(cfg: GhlConfig, filed: { leadId: string; contactId: string }[], tag: string) {
  let ok = 0;
  for (const it of filed) {
    try {
      await addContactTag(cfg, it.contactId, tag);
      await q(`update leads set ghl_tagged_at=now() where id=$1`, [it.leadId]);
      ok++;
    } catch (e: any) {
      console.warn('[ghl] tag failed', it.contactId, e?.message);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`[ghl] tagged ${ok}/${filed.length} contacts as ${tag}`);
}
