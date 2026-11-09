import { localClock, timezoneForLead } from './timezone';

export interface ComplianceSettings {
  enforce_compliance?: boolean | null;
  call_window_start?: number | null;
  call_window_end?: number | null;
  call_window_days?: string | null;
  max_attempts?: number | null;
  default_timezone?: string | null;
}

export interface CallableLead {
  state?: string | null;
  timezone?: string | null;
  outcome?: string | null;
  attempts?: number | null;
  callback_at?: string | null;
}

export interface CallableVerdict {
  callable: boolean;
  reason?: string;
  localLabel: string;
  timezone: string;
}

/**
 * The single place that decides whether a number may be dialed.
 *
 * Do-not-call is enforced unconditionally — it is a legal flag, not a
 * preference. Hours and attempt limits follow the workspace settings.
 */
export function checkCallable(
  lead: CallableLead,
  settings: ComplianceSettings | null | undefined,
  now: Date = new Date(),
): CallableVerdict {
  const tz = timezoneForLead(lead, settings);
  const clock = localClock(tz, now);

  const dnc = lead.outcome === 'do_not_call';
  if (dnc) {
    return { callable: false, reason: 'Marked do not call — dialing blocked', localLabel: clock.label, timezone: tz };
  }

  if (settings?.enforce_compliance === false) {
    return { callable: true, localLabel: clock.label, timezone: tz };
  }

  const days = String(settings?.call_window_days ?? '1,2,3,4,5')
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => !Number.isNaN(d));

  if (days.length && !days.includes(clock.weekday)) {
    return {
      callable: false,
      reason: `Not a calling day (${clock.tz.split('/').pop()?.replace('_', ' ')} local time)`,
      localLabel: clock.label,
      timezone: tz,
    };
  }

  const start = Number(settings?.call_window_start ?? 8);
  const end = Number(settings?.call_window_end ?? 21);

  if (clock.hour < start || clock.hour >= end) {
    return {
      callable: false,
      reason: `Outside calling hours — it is ${clock.label} where they are (window ${start}:00–${end}:00)`,
      localLabel: clock.label,
      timezone: tz,
    };
  }

  const max = Number(settings?.max_attempts ?? 0);
  if (max > 0 && Number(lead.attempts || 0) >= max) {
    return {
      callable: false,
      reason: `Already dialed ${lead.attempts} times — limit is ${max}`,
      localLabel: clock.label,
      timezone: tz,
    };
  }

  return { callable: true, localLabel: clock.label, timezone: tz };
}
