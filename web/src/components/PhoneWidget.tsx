import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useDialer } from '../lib/dialer';
import { DialPad } from './DialPad';
import { fmtDuration } from '../lib/format';
import { api } from '../lib/api';

/**
 * The floating dial-anything widget. The keypad stays mounted for the whole
 * call — connecting, ringing, live — so nobody loses DTMF mid-dial.
 */
const sanitize = (v: string) =>
  v
    .replace(/[^\d+\s().-]/g, '')
    .replace(/(?!^)\+/g, '')
    .slice(0, 24);

/** Turn whatever was typed or pasted into a clean, readable number. */
export function formatNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const hasPlus = trimmed.startsWith('+');
  let d = trimmed.replace(/\D/g, '');
  if (!d) return trimmed;
  if (!hasPlus && d.startsWith('00')) d = d.slice(2);

  const isUS = d.length === 11 && d.startsWith('1');
  if (isUS) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (!hasPlus && d.length === 10) return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (hasPlus) return `+${d}`;
  return trimmed;
}

export function PhoneWidget() {
  const d = useDialer();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState('');
  const [showMics, setShowMics] = useState(false);
  const { data: callerIds } = useQuery<{ rows: { id: string; number: string; label: string | null; active: boolean }[] }>({
    queryKey: ['caller-ids'],
    queryFn: () => api.get('/api/caller-ids'),
  });

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
    if (inCall) return;
    const to = number.replace(/[^\d+]/g, '');
    if (to.length < 7) return;
    try {
      await d.start({ to, label: to });
    } catch (e: any) {
      /* error surfaces through the dialer context */
    }
  };

  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2">
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
            <div className="mb-3 flex items-center gap-1.5">
              {!inCall && (
                <button
                  type="button"
                  onClick={() => setNumber((n) => '+' + n.trim().replace(/^[+]+/, '').replace(/^0+/, ''))}
                  className="h-10 w-9 shrink-0 rounded-md border border-ink-700 bg-ink-900 text-sm text-zinc-300 hover:border-accent/60"
                  title="Add a country code (+)"
                >
                  +
                </button>
              )}
              <input
                className="field mono !py-2 !text-lg text-center"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                readOnly={inCall}
                placeholder="+1 786 920 0604"
                value={inCall ? d.active?.to || number : number}
                onChange={(e) => setNumber(sanitize(e.target.value))}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (!text) return;
                  e.preventDefault();
                  setNumber(sanitize(formatNumber(text)));
                }}
                onBlur={() => setNumber((n) => sanitize(formatNumber(n)))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !inCall) {
                    e.preventDefault();
                    call();
                  }
                }}
              />
            </div>

            {inCall && (
              <p className="mb-2 rounded border border-ink-700 bg-ink-900/60 px-2 py-1.5 text-2xs text-muted">
                Tap a key to answer a phone menu — <span className="text-zinc-300">1</span> for sales,{' '}
                <span className="text-zinc-300">0</span> for an operator.
              </p>
            )}

            <DialPad onKey={press} compact />

            {!inCall && (
              <div className="mt-2 flex items-center gap-1.5">
                <span className="shrink-0 text-2xs uppercase tracking-wider text-muted">From</span>
                <select
                  className="field flex-1 !py-1 !text-2xs"
                  value={d.callerId}
                  onChange={(e) => d.setCallerId(e.target.value)}
                >
                  <option value="">Rotate automatically</option>
                  {(callerIds?.rows || [])
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.number}>
                        {c.number}
                        {c.label ? ` · ${c.label}` : ''}
                      </option>
                    ))}
                </select>
              </div>
            )}

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
                  <button
                    className="btn-danger flex flex-1 items-center justify-center gap-1.5"
                    onClick={d.hangup}
                  >
                    <PhoneOff size={14} />
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

      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex h-11 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold shadow-lg shadow-accent/20
                     transition hover:bg-accent-dim"
          style={{ color: 'var(--on-accent)' }}
          title="Open the dial pad — use it to answer phone menus"
        >
          <KeypadIcon size={18} />
          <span>{open ? 'Close' : 'Dialpad'}</span>
        </button>

        {inCall && (
          <button
            onClick={d.hangup}
            className="flex h-11 items-center gap-2 rounded-full border border-red-800 bg-red-950 px-4 text-sm font-semibold
                       text-red-200 shadow-lg transition hover:bg-red-900"
            title="Hang up this call"
          >
            <PhoneOff size={18} />
            <span>Hang up</span>
            <span className="mono text-2xs opacity-80">{fmtDuration(d.seconds)}</span>
          </button>
        )}
      </div>
    </div>
  );
}

function KeypadIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="6" cy="6" r="1.8" />
      <circle cx="12" cy="6" r="1.8" />
      <circle cx="18" cy="6" r="1.8" />
      <circle cx="6" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="18" cy="12" r="1.8" />
      <circle cx="6" cy="18" r="1.8" />
      <circle cx="12" cy="18" r="1.8" />
      <circle cx="18" cy="18" r="1.8" />
    </svg>
  );
}

export function PhoneOff({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2A19.79 19.79 0 0 1 3.07 5.18 2 2 0 0 1 5.09 3h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L9.07 10.9" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}
