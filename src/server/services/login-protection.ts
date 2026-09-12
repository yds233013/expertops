import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';

/**
 * Throttling repeated sign-in failures.
 *
 * Without this, the login endpoint is an unlimited password oracle: the
 * constant-time comparison in `login` hides *which* accounts exist, but nothing
 * stopped an attacker trying a million passwords against one that does.
 *
 * Two independent windows, because they catch different attacks:
 *
 *  * **Per email.** Someone working through a password list against one
 *    account. Counted on the address as typed, so an attempt against an address
 *    that does not exist still counts — a counter hung off a user row could not
 *    see those, and that is the shape credential stuffing usually takes.
 *  * **Per client address.** Someone spraying one common password across many
 *    accounts. Deliberately looser, because a shared office address is a real
 *    thing and locking a building out is its own outage.
 *
 * Lockout is a refusal to *attempt*, not a flag on the account: nothing is
 * written to the user, so an attacker cannot lock a colleague out permanently.
 * The window simply has to pass.
 */
export const EMAIL_ATTEMPT_LIMIT = 8;
export const IP_ATTEMPT_LIMIT = 30;
export const LOCKOUT_WINDOW_MINUTES = 15;

/** Kept well past the lockout window so a burst is still visible afterwards. */
export const ATTEMPT_RETENTION_HOURS = 72;

export interface AttemptContext {
  email: string;
  clientIp?: string | null;
}

function windowStart(now: Date): Date {
  return new Date(now.getTime() - LOCKOUT_WINDOW_MINUTES * 60_000);
}

export interface LockoutState {
  locked: boolean;
  /** Failures inside the window, for the address and for the client. */
  emailFailures: number;
  ipFailures: number;
  retryAfterSeconds: number;
}

/**
 * How close this caller is to being locked out.
 *
 * Only failures since the last success count: signing in successfully clears
 * the slate for that address, so a person who mistypes a password four times
 * and then gets it right is not one mistake away from a lockout tomorrow.
 */
export async function lockoutState(
  db: Db,
  context: AttemptContext,
  now: Date = clockNow(),
): Promise<LockoutState> {
  const since = windowStart(now);
  const email = context.email.trim().toLowerCase();

  const lastSuccess = await db.loginAttempt.findFirst({
    where: { email, succeeded: true, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const emailSince = lastSuccess ? lastSuccess.createdAt : since;

  const [emailFailures, ipFailures, oldest] = await Promise.all([
    db.loginAttempt.count({
      where: { email, succeeded: false, createdAt: { gt: emailSince } },
    }),
    context.clientIp
      ? db.loginAttempt.count({
          where: { clientIp: context.clientIp, succeeded: false, createdAt: { gte: since } },
        })
      : Promise.resolve(0),
    db.loginAttempt.findFirst({
      where: { email, succeeded: false, createdAt: { gt: emailSince } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  const locked = emailFailures >= EMAIL_ATTEMPT_LIMIT || ipFailures >= IP_ATTEMPT_LIMIT;
  // When the oldest failure in the window ages out, one attempt frees up.
  const freesAt = oldest
    ? oldest.createdAt.getTime() + LOCKOUT_WINDOW_MINUTES * 60_000
    : now.getTime();
  const retryAfterSeconds = locked ? Math.max(1, Math.ceil((freesAt - now.getTime()) / 1000)) : 0;

  return { locked, emailFailures, ipFailures, retryAfterSeconds };
}

/** Thrown instead of attempting a password comparison at all. */
export function tooManyAttempts(retryAfterSeconds: number): AppError {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return new AppError(
    'RATE_LIMITED',
    `Too many failed sign-in attempts. Try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    { retryAfterSeconds },
  );
}

export async function recordAttempt(
  db: Db,
  context: AttemptContext & { succeeded: boolean },
  now: Date = clockNow(),
): Promise<void> {
  await db.loginAttempt.create({
    data: {
      email: context.email.trim().toLowerCase(),
      succeeded: context.succeeded,
      clientIp: context.clientIp ?? null,
      createdAt: now,
    },
  });
}

/** Housekeeping, called by the maintenance sweep. */
export async function pruneLoginAttempts(db: Db, now: Date = clockNow()): Promise<number> {
  const cutoff = new Date(now.getTime() - ATTEMPT_RETENTION_HOURS * 3_600_000);
  const result = await db.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return result.count;
}

/**
 * The client address, as far as it can be trusted.
 *
 * Behind a proxy this comes from a header the proxy sets, and a header can be
 * forged by anyone talking to the application directly. It is therefore used
 * only to widen throttling, never to grant anything.
 */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim().slice(0, 64) || null;
  const real = request.headers.get('x-real-ip');
  return real ? real.trim().slice(0, 64) : null;
}
