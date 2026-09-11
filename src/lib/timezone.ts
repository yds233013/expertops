/**
 * Timezone offsets are derived from the IANA database via Intl, so no offset
 * table has to be maintained by hand and daylight saving is handled correctly.
 *
 * Timezone is used strictly as scheduling data (working-hours overlap). It is
 * never treated as a proxy for nationality, location of origin, or any other
 * protected attribute.
 */
const offsetCache = new Map<string, number>();

export function utcOffsetHours(timeZone: string, at: Date = new Date()): number {
  const key = `${timeZone}|${at.getUTCFullYear()}-${at.getUTCMonth()}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;

  let offset = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (match) {
      const sign = match[1] === '-' ? -1 : 1;
      const hours = Number(match[2] ?? 0);
      const minutes = Number(match[3] ?? 0);
      offset = sign * (hours + minutes / 60);
    }
  } catch {
    // Unknown zone: treat as UTC rather than failing a whole match run.
    offset = 0;
  }

  offsetCache.set(key, offset);
  return offset;
}

/**
 * Hours of overlap between two 09:00-17:00 local working days.
 * Returns 0..8, where 8 means identical working hours.
 */
export function workingHoursOverlap(
  timeZoneA: string,
  timeZoneB: string,
  at: Date = new Date(),
  workdayHours = 8,
): number {
  const offsetA = utcOffsetHours(timeZoneA, at);
  const offsetB = utcOffsetHours(timeZoneB, at);
  // Working day 09:00-17:00 local, expressed in UTC.
  const startA = 9 - offsetA;
  const startB = 9 - offsetB;

  // Compare across the wrapped day so e.g. UTC+12 vs UTC-11 is seen as close.
  let best = 0;
  for (const shift of [-24, 0, 24]) {
    const overlapStart = Math.max(startA, startB + shift);
    const overlapEnd = Math.min(startA + workdayHours, startB + shift + workdayHours);
    best = Math.max(best, overlapEnd - overlapStart);
  }
  return Math.max(0, Math.min(workdayHours, best));
}

export function isKnownTimezone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A small, stable list used by the seed and by form dropdowns. */
export const COMMON_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Warsaw',
  'Africa/Nairobi',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
] as const;
