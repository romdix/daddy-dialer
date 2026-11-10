import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config';
import { q, one } from './db';
import { dec } from './crypto';

const baseDir = () => config.recordingsDir;

export function localPath(workspaceId: string, callLogId: string) {
  return path.join(baseDir(), workspaceId, `${callLogId}.mp3`);
}

/**
 * Pull a finished recording off Twilio and keep it on this server.
 * Twilio charges storage per stored minute every month, so the copy is what
 * lets us delete theirs.
 */
export async function copyRecordingToDisk(o: {
  callLogId: string;
  workspaceId: string;
  recordingSid: string;
  accountSid: string;
  authToken: string;
}): Promise<{ file: string; bytes: number; sha: string } | null> {
  if (!o.recordingSid || !o.accountSid || !o.authToken) return null;

  const dir = path.join(baseDir(), o.workspaceId);
  fs.mkdirSync(dir, { recursive: true });

  const url = `https://api.twilio.com/2010-04-01/Accounts/${o.accountSid}/Recordings/${o.recordingSid}.mp3`;
  const auth = 'Basic ' + Buffer.from(`${o.accountSid}:${o.authToken}`).toString('base64');
  const res = await fetch(url, { headers: { Authorization: auth } });
  if (!res.ok) throw new Error(`Twilio returned ${res.status} fetching the recording`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 128) throw new Error('Downloaded recording was empty');

  const file = localPath(o.workspaceId, o.callLogId);
  // Write to a temp name first so a crash never leaves a half file in place.
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);

  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  return { file, bytes: buf.length, sha };
}

/** Delete Twilio's copy for calls we already hold locally. */
export async function purgeTwilioRecordings(limit = 50) {
  const rows = await q<any>(
    `select c.id, c.recording_sid, c.workspace_id, s.twilio_account_sid, s.twilio_auth_token
       from call_logs c
       join settings s on s.workspace_id = c.workspace_id
      where c.recording_path is not null
        and c.recording_purged_at is null
        and c.recording_sid is not null
        and c.recording_copied_at is not null
        and c.recording_copied_at < now() - (coalesce(s.recording_retention_days, 7) || ' days')::interval
      order by c.recording_copied_at asc
      limit $1`,
    [limit],
  );

  let purged = 0;
  for (const r of rows) {
    // Only ever delete after confirming our own file is still there.
    if (!fs.existsSync(localPath(r.workspace_id, r.id))) continue;
    try {
      const auth =
        'Basic ' + Buffer.from(`${r.twilio_account_sid}:${dec(r.twilio_auth_token)}`).toString('base64');
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${r.twilio_account_sid}/Recordings/${r.recording_sid}.json`,
        { method: 'DELETE', headers: { Authorization: auth } },
      );
      if (res.ok || res.status === 404) {
        await q(`update call_logs set recording_purged_at=now() where id=$1`, [r.id]);
        purged += 1;
      }
    } catch (e: any) {
      console.error('[recordings] purge failed', r.id.slice(0, 8), e?.message);
    }
  }
  if (purged) console.log('[recordings] deleted', purged, 'from Twilio');
  return purged;
}

/** Whole-workspace usage, in bytes, for the Settings screen. */
export async function recordingUsage() {
  const rows = await q<any>(
    `select workspace_id, count(*)::int as files, coalesce(sum(recording_bytes),0)::bigint as bytes
       from call_logs where recording_path is not null group by workspace_id`,
  );
  return rows;
}

export async function attachLocalCopy(callLogId: string, copied: { file: string; bytes: number; sha: string }) {
  await q(
    `update call_logs set recording_path=$2, recording_bytes=$3, recording_sha256=$4, recording_copied_at=now()
      where id=$1`,
    [callLogId, copied.file, copied.bytes, copied.sha],
  );
}

export async function findCallForRecording(callLogId: string) {
  return one<any>(`select * from call_logs where id=$1`, [callLogId]);
}
