import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

interface VoicemailConfig {
  enabled: boolean;
  script: string;
  hasAudio: boolean;
  audioUrl: string | null;
}

/**
 * Voicemail drop: what gets played into an answering machine instead of
 * hanging up. Upload your own recording, or let the app speak a script.
 */
export function VoicemailPanel() {
  const qc = useQueryClient();
  const { data } = useQuery<VoicemailConfig>({
    queryKey: ['voicemail'],
    queryFn: () => api.get('/api/voice/voicemail'),
  });

  const [enabled, setEnabled] = useState(false);
  const [script, setScript] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setScript(data.script || '');
  }, [data?.enabled, data?.script]);

  const save = async (patch: Record<string, unknown> = {}) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.put<VoicemailConfig>('/api/voice/voicemail', { enabled, script, ...patch });
      qc.setQueryData(['voicemail'], res);
      setMsg('Saved.');
    } catch (e: any) {
      setMsg(e?.message || 'Could not save');
    } finally {
      setBusy(false);
      setTimeout(() => setMsg(null), 4000);
    }
  };

  const upload = (file: File) => {
    if (file.size > 8 * 1024 * 1024) {
      setMsg('That file is over 8 MB — use a shorter recording or lower bitrate.');
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      await save({ audioBase64: String(reader.result) });
      if (fileRef.current) fileRef.current.value = '';
    };
    reader.readAsDataURL(file);
  };

  return (
    <section className="panel p-4">
      <h2 className="text-sm font-semibold">Voicemail drop</h2>
      <p className="mt-1 text-xs text-muted">
        When an answering machine picks up, the app can leave a message for you instead of hanging up. Keep it under
        30 seconds — long messages get deleted.
      </p>

      <label className="mt-3 flex items-center justify-between gap-4 text-sm">
        <span>
          Leave a voicemail automatically
          <span className="block text-2xs text-muted">
            Requires “Detect voicemail” above, and waits for the greeting to finish before speaking.
          </span>
        </span>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 accent-check"
        />
      </label>

      <div className="mt-3 grid gap-3">
        <div>
          <label className="label">Your recording (optional, mp3)</label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="audio/mpeg,audio/mp3,audio/wav,audio/*"
              className="text-xs text-muted file:mr-2 file:rounded file:border file:border-ink-600 file:bg-ink-800 file:px-2 file:py-1 file:text-xs file:text-zinc-200"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) upload(f);
              }}
            />
            {data?.hasAudio && (
              <>
                <span className="rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-2xs text-emerald-400">
                  recording saved
                </span>
                <button className="btn-ghost !py-1 !px-2 text-2xs" onClick={() => save({ removeAudio: true })}>
                  Remove
                </button>
              </>
            )}
          </div>
          {data?.hasAudio && data.audioUrl && (
            <audio controls preload="none" className="mt-2 w-full" src={data.audioUrl} />
          )}
          <p className="mt-1 text-2xs text-muted">
            If you don’t upload one, the script below is spoken by Twilio’s voice instead.
          </p>
        </div>

        <div>
          <label className="label">Script (used when no recording)</label>
          <textarea
            className="field min-h-[90px]"
            value={script}
            onChange={(e) => setScript(e.target.value)}
            placeholder="Hi, this is Sam from Acme Roofing. We’re doing free inspections in your area this week. Call me back on…"
          />
          <p className="mt-1 text-2xs text-muted">
            Say your own number in the script — Twilio can’t insert it automatically for the spoken version.
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button className="btn-primary !py-1.5 text-xs" onClick={() => save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save voicemail settings'}
        </button>
        {msg && <span className="text-2xs text-accent">{msg}</span>}
      </div>
    </section>
  );
}
