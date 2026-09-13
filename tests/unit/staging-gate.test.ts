import { describe, expect, it } from 'vitest';
import {
  gateAllows,
  gateCredentials,
  isGateExempt,
  GATE_CHALLENGE_HEADERS,
} from '@/server/http/staging-gate';

/**
 * The outer gate on a hosted deployment.
 *
 * It is one shared credential in front of everything, so the cases that matter
 * are the ones where it would silently let a stranger through: half of it
 * configured, a malformed header, or the health path being exempt by accident
 * for more than the health path.
 */
const credentials = { user: 'tester', password: 'a-long-shared-password' };
const encode = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

describe('staging gate configuration', () => {
  it('is off when neither half is set', () => {
    expect(gateCredentials({})).toBeNull();
  });

  it('is off — not half-on — when only one half is set', () => {
    expect(gateCredentials({ STAGING_GATE_USER: 'tester' })).toBeNull();
    expect(gateCredentials({ STAGING_GATE_PASSWORD: 'secret' })).toBeNull();
  });

  it('ignores surrounding whitespace, which a dashboard paste adds', () => {
    expect(
      gateCredentials({ STAGING_GATE_USER: ' tester ', STAGING_GATE_PASSWORD: ' secret ' }),
    ).toEqual({ user: 'tester', password: 'secret' });
  });
});

describe('staging gate decisions', () => {
  it('accepts the configured credential', () => {
    expect(gateAllows(encode('tester', 'a-long-shared-password'), credentials)).toBe(true);
  });

  it('refuses a wrong password, a wrong user, and no header at all', () => {
    expect(gateAllows(encode('tester', 'wrong'), credentials)).toBe(false);
    expect(gateAllows(encode('someone', 'a-long-shared-password'), credentials)).toBe(false);
    expect(gateAllows(null, credentials)).toBe(false);
    expect(gateAllows(undefined, credentials)).toBe(false);
  });

  it('refuses anything that is not well-formed Basic', () => {
    expect(gateAllows('Bearer abc', credentials)).toBe(false);
    expect(gateAllows('Basic', credentials)).toBe(false);
    expect(gateAllows('Basic !!!not-base64!!!', credentials)).toBe(false);
    // Base64 that decodes to something with no colon.
    expect(gateAllows(`Basic ${Buffer.from('tester').toString('base64')}`, credentials)).toBe(
      false,
    );
  });

  it('accepts a scheme in any casing, as browsers and curl differ', () => {
    const encoded = Buffer.from('tester:a-long-shared-password').toString('base64');
    expect(gateAllows(`basic ${encoded}`, credentials)).toBe(true);
    expect(gateAllows(`BASIC ${encoded}`, credentials)).toBe(true);
  });

  it('keeps a password that contains colons intact', () => {
    const withColons = { user: 'tester', password: 'a:b:c' };
    expect(gateAllows(encode('tester', 'a:b:c'), withColons)).toBe(true);
  });
});

describe('what the gate lets past', () => {
  it('exempts the health path, which the platform probes without credentials', () => {
    expect(isGateExempt('/api/health')).toBe(true);
  });

  it('exempts nothing else, including paths that merely start the same way', () => {
    for (const path of ['/', '/login', '/portal', '/apply', '/api/auth/login', '/api/health/x']) {
      expect(isGateExempt(path)).toBe(false);
    }
  });

  it('challenges with Basic and asks not to be indexed', () => {
    expect(GATE_CHALLENGE_HEADERS['WWW-Authenticate']).toMatch(/^Basic realm=/);
    expect(GATE_CHALLENGE_HEADERS['X-Robots-Tag']).toContain('noindex');
  });
});
