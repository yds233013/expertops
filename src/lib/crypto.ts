import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getEnv } from './env';

/**
 * Password hashing for operator accounts.
 *
 * bcryptjs is a pure-JS implementation, which keeps `npm install` free of
 * native build steps. Cost 10 is a deliberate local-development trade-off:
 * it keeps the test suite fast while still being a real adaptive hash.
 */
const BCRYPT_COST = process.env.NODE_ENV === 'test' ? 4 : 10;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Opaque bearer tokens (operator sessions, expert magic links).
 *
 * The raw token goes to the client; only an HMAC of it is stored, so a database
 * dump cannot be replayed as a valid session.
 */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHmac('sha256', getEnv().AUTH_SECRET).update(token).digest('hex');
}

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Stable non-secret digest, used for deterministic seed ids and dedupe keys. */
export function stableDigest(input: string, length = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, length);
}
