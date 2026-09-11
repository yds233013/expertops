import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, operatorToken } from '../helpers/api';
import { makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { prisma } from '@/lib/db';
import {
  checkCsrf,
  generateCsrfToken,
  isSafeMethod,
  signCsrfToken,
  verifyCsrfSignature,
} from '@/server/http/csrf';
import { issuePortalToken } from '@/server/services/portal-access';

import { POST as loginRoute } from '@/app/api/auth/login/route';
import { POST as logoutRoute } from '@/app/api/auth/logout/route';
import { GET as meRoute } from '@/app/api/auth/me/route';
import { GET as listExperts, POST as createExpert } from '@/app/api/experts/route';
import { POST as createProject } from '@/app/api/projects/route';
import { POST as createInvite } from '@/app/api/projects/[projectId]/invitations/route';
import { POST as portalSession } from '@/app/api/portal/session/route';
import { POST as addAvailability } from '@/app/api/portal/availability/route';

/**
 * Cross-site request forgery protection.
 *
 * The application is cookie-authenticated, so a state-changing request carrying
 * a session cookie must prove it came from the application's own origin. These
 * tests drive the real route handlers with the headers a cross-origin attacker
 * would and would not be able to set.
 */
describe('CSRF: token mechanics', () => {
  it('signs and verifies a token', () => {
    const signed = signCsrfToken(generateCsrfToken());
    expect(verifyCsrfSignature(signed)).toBe(true);
  });

  it('rejects a tampered or unsigned token', () => {
    const signed = signCsrfToken(generateCsrfToken());
    expect(verifyCsrfSignature(`${signed}x`)).toBe(false);
    expect(verifyCsrfSignature('not-a-token')).toBe(false);
    expect(verifyCsrfSignature('')).toBe(false);
  });

  it('signs identically in the Node and Edge implementations', async () => {
    // Middleware mints the cookie on the Edge runtime; the guards verify it on
    // Node. If the two digests ever diverged, every mutation would be rejected.
    const { generateEdgeToken, signEdgeToken } = await import('@/server/http/csrf-edge');
    const raw = generateEdgeToken();

    const edgeSigned = await signEdgeToken(raw, process.env.AUTH_SECRET!);
    const nodeSigned = signCsrfToken(raw);

    expect(edgeSigned).toBe(nodeSigned);
    expect(verifyCsrfSignature(edgeSigned)).toBe(true);
  });

  it('treats read methods as safe', () => {
    expect(isSafeMethod('GET')).toBe(true);
    expect(isSafeMethod('head')).toBe(true);
    expect(isSafeMethod('OPTIONS')).toBe(true);
    expect(isSafeMethod('POST')).toBe(false);
    expect(isSafeMethod('DELETE')).toBe(false);
  });

  it('passes a GET through without any token at all', () => {
    const request = new Request('http://localhost:3000/api/experts', { method: 'GET' });
    expect(checkCsrf(request, undefined).ok).toBe(true);
  });

  it('names the reason a mutation was rejected', () => {
    const token = signCsrfToken(generateCsrfToken());

    const foreignOrigin = new Request('http://localhost:3000/api/experts', {
      method: 'POST',
      headers: { origin: 'https://attacker.example', host: 'localhost:3000' },
    });
    expect(checkCsrf(foreignOrigin, token).reason).toContain('attacker.example');

    const noOrigin = new Request('http://localhost:3000/api/experts', { method: 'POST' });
    expect(checkCsrf(noOrigin, token).reason).toContain('no Origin or Referer');

    const noHeader = new Request('http://localhost:3000/api/experts', {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', host: 'localhost:3000' },
    });
    expect(checkCsrf(noHeader, token).reason).toContain('x-csrf-token');
  });

  it('accepts a Referer when Origin is absent', () => {
    const token = signCsrfToken(generateCsrfToken());
    const request = new Request('http://localhost:3000/api/experts', {
      method: 'POST',
      headers: {
        referer: 'http://localhost:3000/experts/new',
        host: 'localhost:3000',
        'x-csrf-token': token,
      },
    });
    expect(checkCsrf(request, token).ok).toBe(true);
  });
});

describe('CSRF: operator mutations', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function signedIn() {
    const operator = await makeOperator({ role: 'ADMIN' });
    return { operator, token: await operatorToken(operator) };
  }

  const expertBody = {
    fullName: 'Cross Origin',
    email: 'cross.origin@example.test',
    headline: 'Consultant',
  };

  it('rejects a mutation from a foreign origin', async () => {
    const { token } = await signedIn();
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: expertBody,
        origin: 'https://attacker.example',
      }),
    );

    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('cross-site request forgery');
    expect(await prisma.expert.count()).toBe(0);
  });

  it('rejects a mutation with no Origin or Referer at all', async () => {
    const { token } = await signedIn();
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: expertBody,
        origin: null,
      }),
    );
    expect(result.status).toBe(403);
    expect(await prisma.expert.count()).toBe(0);
  });

  it('rejects a same-origin mutation with no CSRF header', async () => {
    const { token } = await signedIn();
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: expertBody,
        csrfHeader: null,
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('Missing x-csrf-token');
    expect(await prisma.expert.count()).toBe(0);
  });

  it('rejects a header that does not match the cookie', async () => {
    const { token } = await signedIn();
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: expertBody,
        csrfHeader: signCsrfToken(generateCsrfToken()), // a different valid token
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('did not match');
  });

  it('rejects a forged (unsigned) CSRF cookie even when echoed correctly', async () => {
    const { token } = await signedIn();
    const forged = 'attacker-chosen-value';
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', {
        operatorToken: token,
        body: expertBody,
        csrfCookie: forged,
        csrfHeader: forged,
      }),
    );
    expect(result.status).toBe(403);
    expect(result.body.error.message).toContain('malformed');
  });

  it('accepts a well-formed same-origin mutation', async () => {
    const { token } = await signedIn();
    const result = await callRoute(
      createExpert,
      buildRequest('POST', '/api/experts', { operatorToken: token, body: expertBody }),
    );
    expect(result.status).toBe(201);
    expect(await prisma.expert.count()).toBe(1);
  });

  it('leaves read endpoints reachable without a CSRF token', async () => {
    const { token } = await signedIn();
    await makeExpert();

    const result = await callRoute(
      listExperts,
      buildRequest('GET', '/api/experts', {
        operatorToken: token,
        csrfCookie: null,
        csrfHeader: null,
        origin: null,
      }),
    );
    expect(result.status).toBe(200);
    expect(result.body.experts).toHaveLength(1);
  });

  it('protects every consequential operator mutation, not just one', async () => {
    const { operator, token } = await signedIn();
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const attacks = [
      callRoute(
        createProject,
        buildRequest('POST', '/api/projects', {
          operatorToken: token,
          body: { title: 'Forged', clientName: 'Forged' },
          origin: 'https://attacker.example',
        }),
      ),
      callRoute(
        createInvite,
        buildRequest('POST', `/api/projects/${project.id}/invitations`, {
          operatorToken: token,
          body: { expertId: expert.id },
          origin: 'https://attacker.example',
        }),
        { projectId: project.id },
      ),
      callRoute(
        logoutRoute,
        buildRequest('POST', '/api/auth/logout', {
          operatorToken: token,
          origin: 'https://attacker.example',
        }),
      ),
    ];

    for (const result of await Promise.all(attacks)) {
      expect(result.status).toBe(403);
    }

    // Nothing happened: no project, no invitation, session still valid.
    expect(await prisma.project.count()).toBe(1);
    expect(await prisma.invitation.count()).toBe(0);
    const stillSignedIn = await callRoute(
      meRoute,
      buildRequest('GET', '/api/auth/me', { operatorToken: token }),
    );
    expect(stillSignedIn.status).toBe(200);
  });
});

describe('CSRF: login and expert portal', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('rejects a cross-origin login attempt', async () => {
    const operator = await makeOperator({ password: 'correct-password' });
    const result = await callRoute(
      loginRoute,
      buildRequest('POST', '/api/auth/login', {
        body: { email: operator.email, password: 'correct-password' },
        origin: 'https://attacker.example',
      }),
    );
    expect(result.status).toBe(403);
    expect(await prisma.session.count()).toBe(0);
  });

  it('rejects a cross-origin magic-link redemption', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });

    const result = await callRoute(
      portalSession,
      buildRequest('POST', '/api/portal/session', {
        body: { token: issued.token },
        origin: 'https://attacker.example',
      }),
    );
    expect(result.status).toBe(403);
    expect(await prisma.expertPortalSession.count()).toBe(0);

    // The link was not consumed by the rejected attempt.
    const stored = await prisma.expertPortalToken.findFirstOrThrow();
    expect(stored.usedAt).toBeNull();
  });

  it('protects expert portal mutations the same way as operator ones', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });
    const session = await callRoute(
      portalSession,
      buildRequest('POST', '/api/portal/session', { body: { token: issued.token } }),
    );
    expect(session.status).toBe(200);

    const portalCookie = /expertops_portal=([^;]*)/.exec(
      session.response.headers.get('set-cookie') ?? '',
    )?.[1];
    expect(portalCookie).toBeTruthy();

    const forged = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken: portalCookie,
        body: { startAt: '2026-10-01', endAt: '2026-12-01', hoursPerWeek: 20 },
        origin: 'https://attacker.example',
      }),
    );
    expect(forged.status).toBe(403);
    expect(await prisma.availabilityWindow.count()).toBe(0);

    const genuine = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken: portalCookie,
        body: { startAt: '2026-10-01', endAt: '2026-12-01', hoursPerWeek: 20 },
      }),
    );
    expect(genuine.status).toBe(201);
  });
});
