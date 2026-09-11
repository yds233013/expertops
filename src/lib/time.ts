export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function hoursFromNow(hours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + hours * HOUR_MS);
}

export function minutesFromNow(minutes: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + minutes * MINUTE_MS);
}

export function secondsFromNow(seconds: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + seconds * 1000);
}

/** Whole hours between two instants, rounded down. */
export function hoursBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / HOUR_MS);
}

export function isPast(date: Date, now: Date = new Date()): boolean {
  return date.getTime() <= now.getTime();
}

const DATE_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  timeZone: 'UTC',
});

const DATETIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return DATE_FORMATTER.format(typeof date === 'string' ? new Date(date) : date);
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return '—';
  return `${DATETIME_FORMATTER.format(typeof date === 'string' ? new Date(date) : date)} UTC`;
}

export function formatRelative(
  date: Date | string | null | undefined,
  now: Date = new Date(),
): string {
  if (!date) return '—';
  const target = typeof date === 'string' ? new Date(date) : date;
  const deltaMs = target.getTime() - now.getTime();
  const abs = Math.abs(deltaMs);
  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [DAY_MS, 'day'],
    [HOUR_MS, 'hour'],
    [MINUTE_MS, 'minute'],
  ];
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [ms, unit] of units) {
    if (abs >= ms) return rtf.format(Math.round(deltaMs / ms), unit);
  }
  return rtf.format(Math.round(deltaMs / 1000), 'second');
}
