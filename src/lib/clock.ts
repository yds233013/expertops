/**
 * Clock abstraction.
 *
 * Every service, job handler and scheduled sweep reads "now" through a Clock
 * rather than calling `new Date()` directly. Tests and the demo script can then
 * advance time deterministically without sleeping and without a time-travel
 * HTTP endpoint existing in the application at all.
 *
 * The production clock is the system clock and cannot be moved. `FixedClock`
 * and `OffsetClock` are exported for tests and for `scripts/demo.ts`, which run
 * in-process; nothing in `src/app` can reach them over HTTP.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at an instant, advanced explicitly by a test. */
export class FixedClock implements Clock {
  private current: Date;

  constructor(start: Date = new Date()) {
    this.current = new Date(start.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  advance(ms: number): Date {
    this.current = new Date(this.current.getTime() + ms);
    return this.now();
  }

  advanceHours(hours: number): Date {
    return this.advance(hours * 3_600_000);
  }

  advanceDays(days: number): Date {
    return this.advance(days * 86_400_000);
  }
}

/** A clock that tracks the system clock at a fixed offset. */
export class OffsetClock implements Clock {
  constructor(private offsetMs: number = 0) {}

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  shift(ms: number): void {
    this.offsetMs += ms;
  }
}

/**
 * The ambient clock used by services that are not handed one explicitly.
 *
 * Only test setup and the demo script may replace it, and only in-process.
 * Guarded so an accidental call in a production build is a loud failure rather
 * than a silent time shift.
 */
let ambient: Clock = systemClock;

export function getClock(): Clock {
  return ambient;
}

export function now(): Date {
  return ambient.now();
}

export function setAmbientClock(clock: Clock): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The ambient clock cannot be replaced in a production build.');
  }
  ambient = clock;
}

export function resetAmbientClock(): void {
  ambient = systemClock;
}
