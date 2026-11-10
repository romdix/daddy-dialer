import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

const dir = () => path.join(config.recordingsDir, 'voicemail');

export function voicemailPath(workspaceId: string) {
  return path.join(dir(), `${workspaceId}.mp3`);
}

/** Long-lived token so Twilio can fetch the audio without a login. */
export function voicemailToken(workspaceId: string) {
  return crypto.createHmac('sha256', config.appSecret).update(`vm:${workspaceId}`).digest('hex').slice(0, 32);
}

export function tokenMatches(workspaceId: string, token: string) {
  const want = voicemailToken(workspaceId);
  if (!token || token.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

export function saveVoicemailAudio(workspaceId: string, base64: string) {
  const raw = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < 1024) throw new Error('That audio file looks empty');
  if (buf.length > 8 * 1024 * 1024) throw new Error('Audio must be under 8 MB');
  fs.mkdirSync(dir(), { recursive: true });
  const file = voicemailPath(workspaceId);
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { file, bytes: buf.length };
}

export function hasVoicemailAudio(workspaceId: string) {
  return fs.existsSync(voicemailPath(workspaceId));
}

export function deleteVoicemailAudio(workspaceId: string) {
  const file = voicemailPath(workspaceId);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
