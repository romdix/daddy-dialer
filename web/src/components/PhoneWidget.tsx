import { useState } from 'react';
import { useDialer } from '../lib/dialer';
import { DialPad } from './DialPad';
import { fmtDuration } from '../lib/format';

/**
 * The floating dial-anything widget. The keypad stays mounted for the whole
 * call — connecting, ringing, live — so nobody loses DTMF mid-dial.
 */
export function PhoneWidget() {
  const d = useDialer();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [showMics, setShowMics] = useState(false);

  const inCall = d.status === 'connecting' || d.status === 'ringing' || d.status === 'live';
  const statusText =
    d.status === 'connecting'
      ? 'Connecting…'
      : d.status === 'ringing'
        ? 'Ringing…'
        : d.status === 'live'
          ? 'Live'
          : d.status === 'ended'
            ? 'Call ended'
            : 'Ready';

  const dot =
    d.status === 'live'
      ? 'bg-accent animate-pulse'
      : d.status === 'ringing' || d.status === 'connecting'
        ? 'bg-amber-400 animate-pulse'
        : 'bg-zinc-600';

  const press = (k: string) => {
    if (inCall) {
      d.sendDigit(k);
      return;
    }
    setNumber((n) => n + k);
  };

  const call = async () => {
    const to = number.replace(/[^\d+]/g, '');
    if (to.length < 7) return;
    try {
      await d.start({ to, label: to });
    } catch (e: any) {
      /* error surfaces through the dialer context */
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2">
      {open && (
        <div className="w-[300px] panel shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
              <span className="text-2xs uppercase tracking-wider text-muted">{statusText}</span>
            </div>
            <span className="mono text-2xs text-muted">{inCall ? fmtDuration(d.seconds) : ''}</span>
          </div>

          <div className="px-3 py-3">
            <div className="mb-3 rounded-md border border-ink-700 bg-ink-950 px-3 py-2">
              <div className="mono text-lg tracking-wide text-center truncate">
                {inCall ? d.active?.to || number : number || <span className="text-zinc-600">Enter a number</span>}
              </div>
            </div>

            <DialPad onKey={press} compact />

            <div className="mt-3 flex items-center gap-2">
              {!inCall ? (
                <button className="btn-primary flex-1" onClick={call} disabled={number.replace(/\D/g, '').length < 7}>
                  Call
                </button>
              ) : (
                <>
                  <button
                    className={`btn-ghost flex-1 ${d.muted ? '!border-amber-600/60 !text-amber-400' : ''}`}
                    onClick={d.toggleMute}
                  >
                    {d.muted ? 'Unmute' : 'Mute'}
                  </button>
                  <button className="btn-danger flex-1" onClick={d.hangup}>
                    Hang up
                  </button>
                </>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between">
              <button
                className="text-2xs text-muted hover:text-zinc-200"
                onClick={() => {
                  setShowMics((v) => !v);
                  d.refreshInputs();
                }}
              >
                Microphone
              </button>
              {!inCall && number && (
                <button className="text-2xs text-muted hover:text-zinc-200" onClick={() => setNumber('')}>
                  Clear
                </button>
              )}
            </div>

            {showMics && (
              <select
                className="field mt-2 !py-1.5 text-xs"
                value={d.inputDevice}
                onChange={(e) => d.selectInputDevice(e.target.value)}
              >
                {d.inputDevices.length === 0 && <option value="">No microphones found</option>}
                {d.inputDevices.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label}
                  </option>
                ))}
              </select>
            )}

            {d.error && (
              <p className="mt-2 rounded border border-red-900/50 bg-red-950/30 px-2 py-1.5 text-2xs text-red-300">
                {d.error}
              </p>
            )}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="h-12 w-12 rounded-full bg-accent shadow-lg shadow-accent/20
                   hover:bg-accent-dim transition flex items-center justify-center"
        style={{ color: 'var(--on-accent)' }}
        title="Open dialer"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
      </button>
    </div>
  );
}
