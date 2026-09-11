import { describe, expect, it } from 'vitest';
import { AppError, badRequest, capacityExceeded, errorMessage, isAppError } from '@/lib/errors';
import { formatReference, parseReferenceSequence, slugify } from '@/lib/ids';
import { centsToDisplay, centsToRateDisplay, majorToCents } from '@/lib/money';
import { hoursBetween, hoursFromNow, isPast, secondsFromNow } from '@/lib/time';
import { utcOffsetHours, workingHoursOverlap } from '@/lib/timezone';
import { backoffSeconds } from '@/server/services/jobs';
import { windowsOverlap } from '@/server/services/availability';

describe('errors', () => {
  it('maps each domain code to the right HTTP status', () => {
    expect(badRequest('bad').status).toBe(400);
    expect(new AppError('UNAUTHENTICATED', 'x').status).toBe(401);
    expect(new AppError('FORBIDDEN', 'x').status).toBe(403);
    expect(new AppError('NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('INVALID_STATE', 'x').status).toBe(409);
    expect(capacityExceeded('full').status).toBe(409);
  });

  it('carries structured details alongside the message', () => {
    const error = capacityExceeded('no seats', { seatsTaken: 2, seatsRequested: 2 });
    expect(error.details).toEqual({ seatsTaken: 2, seatsRequested: 2 });
    expect(isAppError(error)).toBe(true);
  });

  it('extracts a readable message from any thrown value', () => {
    expect(errorMessage(badRequest('nope'))).toBe('nope');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain string')).toBe('plain string');
  });
});

describe('reference identifiers', () => {
  it('zero-pads to four digits', () => {
    expect(formatReference('EXP', 1)).toBe('EXP-0001');
    expect(formatReference('PRJ', 42)).toBe('PRJ-0042');
    expect(formatReference('EXP', 12345)).toBe('EXP-12345');
  });

  it('round-trips through the parser', () => {
    expect(parseReferenceSequence('EXP', formatReference('EXP', 7))).toBe(7);
  });

  it('treats a missing or foreign reference as sequence zero', () => {
    expect(parseReferenceSequence('EXP', null)).toBe(0);
    expect(parseReferenceSequence('EXP', 'PRJ-0003')).toBe(0);
    expect(parseReferenceSequence('EXP', 'EXP-abc')).toBe(0);
  });

  it('slugifies skill names into stable keys', () => {
    expect(slugify('Payments Infrastructure')).toBe('payments-infrastructure');
    expect(slugify('  C++  & Rust ')).toBe('c-rust');
    expect(slugify('Post-Merger Integration')).toBe('post-merger-integration');
  });
});

describe('money', () => {
  it('renders cents as a currency string', () => {
    expect(centsToDisplay(20_000)).toBe('$200');
    expect(centsToDisplay(20_050)).toBe('$200.5');
    expect(centsToRateDisplay(18_500)).toBe('$185/h');
  });

  it('converts major units without floating point drift', () => {
    expect(majorToCents(199.99)).toBe(19999);
    expect(majorToCents(0.1 + 0.2)).toBe(30);
  });
});

describe('time', () => {
  it('computes future instants', () => {
    const base = new Date('2026-01-01T00:00:00Z');
    expect(hoursFromNow(3, base).toISOString()).toBe('2026-01-01T03:00:00.000Z');
    expect(secondsFromNow(90, base).toISOString()).toBe('2026-01-01T00:01:30.000Z');
  });

  it('floors the hours between two instants', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-01T05:59:00Z');
    expect(hoursBetween(from, to)).toBe(5);
  });

  it('detects a past deadline inclusively', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(isPast(new Date('2025-12-31T23:59:59Z'), now)).toBe(true);
    expect(isPast(now, now)).toBe(true);
    expect(isPast(new Date('2026-01-01T00:00:01Z'), now)).toBe(false);
  });
});

describe('timezone overlap', () => {
  const winter = new Date('2026-01-15T12:00:00Z');

  it('reads offsets from the IANA database', () => {
    expect(utcOffsetHours('UTC', winter)).toBe(0);
    expect(utcOffsetHours('America/New_York', winter)).toBe(-5);
    expect(utcOffsetHours('Asia/Kolkata', winter)).toBe(5.5);
  });

  it('falls back to UTC for an unknown zone instead of throwing', () => {
    expect(utcOffsetHours('Not/AZone', winter)).toBe(0);
  });

  it('gives a full workday of overlap for the same zone', () => {
    expect(workingHoursOverlap('Europe/London', 'Europe/London', winter)).toBe(8);
  });

  it('shrinks overlap as zones diverge', () => {
    const nearby = workingHoursOverlap('Europe/London', 'Europe/Berlin', winter);
    const distant = workingHoursOverlap('Europe/London', 'Asia/Tokyo', winter);
    expect(nearby).toBeGreaterThan(distant);
    expect(distant).toBeGreaterThanOrEqual(0);
  });

  it('never reports more than a workday or less than zero', () => {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles', 'Australia/Sydney']) {
      const overlap = workingHoursOverlap(zone, 'Europe/London', winter);
      expect(overlap).toBeGreaterThanOrEqual(0);
      expect(overlap).toBeLessThanOrEqual(8);
    }
  });
});

describe('job retry backoff', () => {
  it('grows exponentially and then caps', () => {
    expect(backoffSeconds(1)).toBe(5);
    expect(backoffSeconds(2)).toBe(10);
    expect(backoffSeconds(3)).toBe(20);
    expect(backoffSeconds(20)).toBe(600);
  });

  it('never returns a negative delay', () => {
    expect(backoffSeconds(0)).toBeGreaterThan(0);
    expect(backoffSeconds(-5)).toBeGreaterThan(0);
  });
});

describe('availability window overlap', () => {
  const window = (start: string, end: string) => ({
    startAt: new Date(start),
    endAt: new Date(end),
  });

  it('detects a partial overlap', () => {
    expect(
      windowsOverlap(window('2026-01-01', '2026-02-01'), window('2026-01-15', '2026-03-01')),
    ).toBe(true);
  });

  it('treats touching windows as non-overlapping', () => {
    expect(
      windowsOverlap(window('2026-01-01', '2026-02-01'), window('2026-02-01', '2026-03-01')),
    ).toBe(false);
  });

  it('detects full containment', () => {
    expect(
      windowsOverlap(window('2026-01-01', '2026-06-01'), window('2026-02-01', '2026-03-01')),
    ).toBe(true);
  });
});
