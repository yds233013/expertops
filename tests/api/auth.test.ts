import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, cookieValue, operatorToken } from '../helpers/api';
import { makeOperator } from '../helpers/factories';
import { OPERATOR_COOKIE } from '@/server/http/context';
import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { GET as healthRoute } from '@/app/api/health/route';

describe('POST /api/auth/login', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('returns the operator, their capabilities, and a session cookie', async () => {
    const operator = await makeOperator({ role: 'ADMIN', password: 'correct-password' });

    const result = await callRoute(
      loginRoute,
      buildRequest('POST', '/api/auth/login', {
        body: { email: operator.email, password: 'correct-password' },
      }),
    );

    expect(result.status).toBe(200);
    expect(result.body.user.email).toBe(operator.email);
    expect(result.body.user.role).toBe('ADMIN');
    expect(result.body.capabilities).toContain('jobs:manage');
    expect(result.body.user).not.toHaveProperty('passwordHash');
    expect(cookieValue(result.response, OPERATOR_COOKIE)).toBeTruthy();
  });

  it('sets an httpOnly cookie', async () => {
    const operator = await makeOperator({ password: 'correct-password' });
    const result = await callRoute(
      loginRoute,
      buildRequest('POST', '/api/auth/login', {
        body: { email: operator.email, password: 'correct-password' },
      }),
    );
    expect(result.response.headers.get('set-cookie')).toContain('HttpOnly');
  });

  it('returns 401 for a wrong password', async () => {
    const operator = await makeOperator({ password: 'correct-password' });
    const result = await callRoute(
      loginRoute,
      buildRequest('POST', '/api/auth/login', {
        body: { email: operator.email, password: 'wrong-password' },
      }),
    );
    expect(result.status).toBe(401);
    expect(result.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 400 for a malformed body', async () => {
    const result = await callRoute(
      loginRoute,
      buildRequest('POST', '/api/auth/login', { body: { email: 'a' } }),
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe('BAD_REQUEST');
    expect(result.body.error.details).toBeDefined();
  });
});

describe('GET /api/auth/me', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('returns 401 without a session cookie', async () => {
    const result = await callRoute(meRoute, buildRequest('GET', '/api/auth/me'));
    expect(result.status).toBe(401);
  });

  it('returns 401 for a forged session cookie', async () => {
    const result = await callRoute(
      meRoute,
      buildRequest('GET', '/api/auth/me', { operatorToken: 'forged-token-value' }),
    );
    expect(result.status).toBe(401);
  });

  it('returns the signed-in operator and their capability list', async () => {
    const operator = await makeOperator({ role: 'VIEWER' });
    const token = await operatorToken(operator);

    const result = await callRoute(
      meRoute,
      buildRequest('GET', '/api/auth/me', { operatorToken: token }),
    );
    expect(result.status).toBe(200);
    expect(result.body.user.role).toBe('VIEWER');
    expect(result.body.capabilities).not.toContain('staffing:confirm');
  });
});

describe('POST /api/auth/logout', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('invalidates the session so the next request is unauthenticated', async () => {
    const operator = await makeOperator();
    const token = await operatorToken(operator);

    expect(
      (await callRoute(meRoute, buildRequest('GET', '/api/auth/me', { operatorToken: token })))
        .status,
    ).toBe(200);

    await callRoute(
      logoutRoute,
      buildRequest('POST', '/api/auth/logout', { operatorToken: token }),
    );

    expect(
      (await callRoute(meRoute, buildRequest('GET', '/api/auth/me', { operatorToken: token })))
        .status,
    ).toBe(401);
  });

  it('is harmless when nobody is signed in', async () => {
    const result = await callRoute(logoutRoute, buildRequest('POST', '/api/auth/logout'));
    expect(result.status).toBe(200);
  });
});

describe('GET /api/health', () => {
  beforeAll(() => applyMigrations());

  it('reports database reachability without requiring a session', async () => {
    const result = await callRoute(healthRoute, buildRequest('GET', '/api/health'));
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('ok');
    expect(typeof result.body.databaseLatencyMs).toBe('number');
  });
});
