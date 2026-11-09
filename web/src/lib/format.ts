export const OUTCOMES = [
  'connected_dm',
  'connected_gk',
  'connected_other',
  'voicemail',
  'busy',
  'no_answer',
  'bad_number',
  'not_interested',
  'do_not_call',
  'callback_requested',
  'appointment_set',
  'dialed',
] as const;

export type Outcome = (typeof OUTCOMES)[number];

export const OUTCOME_LABEL: Record<string, string> = {
  connected_dm: 'Connected — DM',
  connected_gk: 'Connected — Gatekeeper',
  connected_other: 'Connected — Other',
  voicemail: 'Voicemail',
  busy: 'Busy',
  no_answer: 'No Answer',
  bad_number: 'Bad Number',
  not_interested: 'Not Interested',
  do_not_call: 'Do Not Call',
  callback_requested: 'Callback Requested',
  appointment_set: 'Appointment Set',
  dialed: 'Dialed',
};

/** The chips shown on the dialer, in the order a rep actually uses them. */
export const QUICK_OUTCOMES: Outcome[] = [
  'connected_dm',
  'connected_gk',
  'connected_other',
  'voicemail',
  'no_answer',
  'busy',
  'callback_requested',
  'appointment_set',
  'not_interested',
  'bad_number',
  'do_not_call',
];

export const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  in_progress: 'In Progress',
  completed: 'Completed',
  disqualified: 'Disqualified',
};

export function outcomeColor(o?: string | null): string {
  switch (o) {
    case 'connected_dm':
    case 'appointment_set':
      return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30';
    case 'connected_gk':
    case 'connected_other':
    case 'callback_requested':
      return 'bg-sky-500/15 text-sky-400 border-sky-500/30';
    case 'voicemail':
    case 'no_answer':
    case 'busy':
      return 'bg-zinc-500/15 text-zinc-400 border-zinc-600/40';
    case 'not_interested':
    case 'bad_number':
    case 'do_not_call':
      return 'bg-red-500/10 text-red-400 border-red-500/25';
    default:
      return 'bg-zinc-500/10 text-zinc-400 border-zinc-700';
  }
}

export function fmtDuration(sec?: number | null): string {
  const s = Number(sec || 0);
  if (!s) return '0:00';
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtWhen(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
