/**
 * US state → IANA timezone.
 *
 * States that span multiple zones use the zone where most of the population
 * lives. Good enough for "is it 7am there?" — a lead can override it with its
 * own `timezone` column, and the workspace can set a default.
 */
const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago',
  AK: 'America/Anchorage',
  AZ: 'America/Phoenix',
  AR: 'America/Chicago',
  CA: 'America/Los_Angeles',
  CO: 'America/Denver',
  CT: 'America/New_York',
  DE: 'America/New_York',
  DC: 'America/New_York',
  FL: 'America/New_York',
  GA: 'America/New_York',
  HI: 'Pacific/Honolulu',
  ID: 'America/Boise',
  IL: 'America/Chicago',
  IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',
  KS: 'America/Chicago',
  KY: 'America/New_York',
  LA: 'America/Chicago',
  ME: 'America/New_York',
  MD: 'America/New_York',
  MA: 'America/New_York',
  MI: 'America/Detroit',
  MN: 'America/Chicago',
  MS: 'America/Chicago',
  MO: 'America/Chicago',
  MT: 'America/Denver',
  NE: 'America/Chicago',
  NV: 'America/Los_Angeles',
  NH: 'America/New_York',
  NJ: 'America/New_York',
  NM: 'America/Denver',
  NY: 'America/New_York',
  NC: 'America/New_York',
  ND: 'America/Chicago',
  OH: 'America/New_York',
  OK: 'America/Chicago',
  OR: 'America/Los_Angeles',
  PA: 'America/New_York',
  RI: 'America/New_York',
  SC: 'America/New_York',
  SD: 'America/Chicago',
  TN: 'America/Chicago',
  TX: 'America/Chicago',
  UT: 'America/Denver',
  VT: 'America/New_York',
  VA: 'America/New_York',
  WA: 'America/Los_Angeles',
  WV: 'America/New_York',
  WI: 'America/Chicago',
  WY: 'America/Denver',
  PR: 'America/Puerto_Rico',
  VI: 'America/St_Thomas',
  GU: 'Pacific/Guam',
};

export const FALLBACK_TZ = 'America/New_York';

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface LocalClock {
  tz: string;
  weekday: number; // 0 = Sunday
  hour: number;
  minute: number;
  label: string; // e.g. "2:05 PM"
}

export function timezoneForLead(
  lead: { state?: string | null; timezone?: string | null },
  settings?: { default_timezone?: string | null } | null,
): string {
  if (lead.timezone) return lead.timezone;
  if (settings?.default_timezone) return settings.default_timezone;
  const st = String(lead.state || '').trim().toUpperCase();
  return STATE_TZ[st] || FALLBACK_TZ;
}

export function localClock(tz: string, when: Date = new Date()): LocalClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(when);
  } catch {
    return localClock(FALLBACK_TZ, when);
  }

  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 1;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));

  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? 'AM' : 'PM';
  const label = `${h12}:${String(minute).padStart(2, '0')} ${ampm}`;

  return { tz, weekday, hour, minute, label };
}
