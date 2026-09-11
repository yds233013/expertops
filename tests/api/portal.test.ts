import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, cookieValue, operatorToken } from '../helpers/api';
import { makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { PORTAL_COOKIE } from '@/server/http/context';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { createInvitation, sendInvitation } from '@/server/services/invitations';
import { issuePortalToken } from '@/server/services/portal-access';

import { POST as portalSession, DELETE as endSession } from '@/app/api/portal/session/route';
import { GET as portalMe } from '@/app/api/portal/me/route';
import { POST as respond } from '@/app/api/portal/invitations/[invitationId]/respond/route';
import {
  GET as listAvailability,
  POST as addAvailability,
} from '@/app/api/portal/availability/route';
import { DELETE as removeAvailability } from '@/app/api/portal/availability/[windowId]/route';
import { GET as getOnboarding, PATCH as saveOnboarding } from '@/app/api/portal/onboarding/route';
import { POST as submitOnboarding } from '@/app/api/portal/onboarding/submit/route';

async function portalFixture() {
  const operator = await makeOperator();
  const opToken = await operatorToken(operator);
  const project = await makeProject(operator.id, { status: 'MATCHING' });
  const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

  const invitation = await createInvitation(
    prisma,
    { type: 'OPERATOR', userId: operator.id, label: operator.name },
    { projectId: project.id, expertId: expert.id },
  );
  const sent = await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
  const rawToken = sent!.portalUrl.split('/').pop()!;

  const session = await callRoute(
    portalSession,
    buildRequest('POST', '/api/portal/session', { body: { token: rawToken } }),
  );
  const portalToken = cookieValue(session.response, PORTAL_COOKIE)!;

  return { operator, opToken, project, expert, invitation, portalToken };
}

describe('portal API: session', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('exchanges a magic link for a portal cookie', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });

    const result = await callRoute(
      portalSession,
      buildRequest('POST', '/api/portal/session', { body: { token: issued.token } }),
    );

    expect(result.status).toBe(200);
    expect(result.body.expert.id).toBe(expert.id);
    expect(result.body.expert).not.toHaveProperty('notes');
    expect(cookieValue(result.response, PORTAL_COOKIE)).toBeTruthy();
  });

  it('rejects a reused magic link with 401', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });

    await callRoute(
      portalSession,
      buildRequest('POST', '/api/portal/session', { body: { token: issued.token } }),
    );
    const second = await callRoute(
      portalSession,
      buildRequest('POST', '/api/portal/session', { body: { token: issued.token } }),
    );

    expect(second.status).toBe(401);
    expect(second.body.error.message).toContain('already been used');
  });

  it('requires a portal session for every portal endpoint', async () => {
    const unauthenticated = await Promise.all([
      callRoute(portalMe, buildRequest('GET', '/api/portal/me')),
      callRoute(listAvailability, buildRequest('GET', '/api/portal/availability')),
      callRoute(getOnboarding, buildRequest('GET', '/api/portal/onboarding')),
      callRoute(submitOnboarding, buildRequest('POST', '/api/portal/onboarding/submit')),
    ]);
    for (const result of unauthenticated) {
      expect(result.status).toBe(401);
    }
  });

  it('signs the expert out', async () => {
    const { portalToken } = await portalFixture();
    expect(
      (await callRoute(portalMe, buildRequest('GET', '/api/portal/me', { portalToken }))).status,
    ).toBe(200);

    await callRoute(endSession, buildRequest('DELETE', '/api/portal/session', { portalToken }));

    expect(
      (await callRoute(portalMe, buildRequest('GET', '/api/portal/me', { portalToken }))).status,
    ).toBe(401);
  });

  it('does not expose an operator session as a portal session', async () => {
    const { opToken } = await portalFixture();
    const result = await callRoute(
      portalMe,
      buildRequest('GET', '/api/portal/me', { portalToken: opToken }),
    );
    expect(result.status).toBe(401);
  });
});

describe('portal API: invitations', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('shows the expert their own invitations only', async () => {
    const { portalToken, expert } = await portalFixture();
    const other = await makeExpert();
    const operator = await makeOperator();
    const otherProject = await makeProject(operator.id, { status: 'MATCHING' });
    await createInvitation(
      prisma,
      { type: 'OPERATOR', userId: operator.id, label: operator.name },
      { projectId: otherProject.id, expertId: other.id },
    );

    const result = await callRoute(
      portalMe,
      buildRequest('GET', '/api/portal/me', { portalToken }),
    );
    expect(result.status).toBe(200);
    expect(result.body.invitations).toHaveLength(1);
    expect(result.body.expert.id).toBe(expert.id);
  });

  it('accepts an invitation and opens the onboarding checklist', async () => {
    const { portalToken, invitation, expert } = await portalFixture();

    const result = await callRoute(
      respond,
      buildRequest('POST', `/api/portal/invitations/${invitation.id}/respond`, {
        portalToken,
        body: { accept: true },
      }),
      { invitationId: invitation.id },
    );

    expect(result.status).toBe(200);
    expect(result.body.invitation.status).toBe('ACCEPTED');
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } })).status).toBe(
      'ONBOARDING',
    );

    const onboarding = await callRoute(
      getOnboarding,
      buildRequest('GET', '/api/portal/onboarding', { portalToken }),
    );
    expect(onboarding.status).toBe(200);
    expect(onboarding.body.onboardingCase.status).toBe('IN_PROGRESS');
    expect(onboarding.body.onboardingCase.items.length).toBeGreaterThan(0);
  });

  it('requires a reason to decline', async () => {
    const { portalToken, invitation } = await portalFixture();
    const result = await callRoute(
      respond,
      buildRequest('POST', `/api/portal/invitations/${invitation.id}/respond`, {
        portalToken,
        body: { accept: false },
      }),
      { invitationId: invitation.id },
    );
    expect(result.status).toBe(400);
  });

  it("returns 404 when answering another expert's invitation", async () => {
    const first = await portalFixture();
    const second = await portalFixture();

    const result = await callRoute(
      respond,
      buildRequest('POST', `/api/portal/invitations/${first.invitation.id}/respond`, {
        portalToken: second.portalToken,
        body: { accept: true },
      }),
      { invitationId: first.invitation.id },
    );
    expect(result.status).toBe(404);
  });
});

describe('portal API: availability', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('adds and removes a general availability window', async () => {
    const { portalToken } = await portalFixture();

    const added = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken,
        body: {
          startAt: '2026-10-01',
          endAt: '2026-12-01',
          hoursPerWeek: 20,
        },
      }),
    );
    expect(added.status).toBe(201);

    const listed = await callRoute(
      listAvailability,
      buildRequest('GET', '/api/portal/availability', { portalToken }),
    );
    expect(listed.body.availability).toHaveLength(1);

    const removed = await callRoute(
      removeAvailability,
      buildRequest('DELETE', `/api/portal/availability/${added.body.window.id}`, { portalToken }),
      { windowId: added.body.window.id },
    );
    expect(removed.status).toBe(204);
    expect(await prisma.availabilityWindow.count()).toBe(0);
  });

  it('rejects an overlapping window with 409', async () => {
    const { portalToken } = await portalFixture();
    const body = { startAt: '2026-10-01', endAt: '2026-12-01', hoursPerWeek: 20 };

    await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', { portalToken, body }),
    );
    const overlapping = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken,
        body: { startAt: '2026-11-01', endAt: '2027-01-01', hoursPerWeek: 10 },
      }),
    );
    expect(overlapping.status).toBe(409);
  });

  it('refuses project availability before the invitation is accepted', async () => {
    const { portalToken, project } = await portalFixture();
    const result = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken,
        body: {
          startAt: '2026-10-01',
          endAt: '2026-12-01',
          hoursPerWeek: 20,
          projectId: project.id,
        },
      }),
    );
    expect(result.status).toBe(409);
    expect(result.body.error.message).toContain('after accepting its invitation');
  });

  it("cannot delete another expert's window", async () => {
    const first = await portalFixture();
    const second = await portalFixture();

    const added = await callRoute(
      addAvailability,
      buildRequest('POST', '/api/portal/availability', {
        portalToken: first.portalToken,
        body: { startAt: '2026-10-01', endAt: '2026-12-01', hoursPerWeek: 20 },
      }),
    );

    const result = await callRoute(
      removeAvailability,
      buildRequest('DELETE', `/api/portal/availability/${added.body.window.id}`, {
        portalToken: second.portalToken,
      }),
      { windowId: added.body.window.id },
    );
    expect(result.status).toBe(404);
    expect(await prisma.availabilityWindow.count()).toBe(1);
  });
});

describe('portal API: onboarding', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function acceptedFixture() {
    const fixture = await portalFixture();
    await callRoute(
      respond,
      buildRequest('POST', `/api/portal/invitations/${fixture.invitation.id}/respond`, {
        portalToken: fixture.portalToken,
        body: { accept: true },
      }),
      { invitationId: fixture.invitation.id },
    );
    return fixture;
  }

  it('saves partial progress then submits a complete checklist', async () => {
    const { portalToken, expert } = await acceptedFixture();

    const initial = await callRoute(
      getOnboarding,
      buildRequest('GET', '/api/portal/onboarding', { portalToken }),
    );
    const items = initial.body.onboardingCase.items as Array<{
      key: string;
      kind: string;
      required: boolean;
    }>;

    const partial = await callRoute(
      saveOnboarding,
      buildRequest('PATCH', '/api/portal/onboarding', {
        portalToken,
        body: { answers: [{ key: 'nda_accepted', value: 'true' }] },
      }),
    );
    expect(partial.status).toBe(200);

    const blockedSubmit = await callRoute(
      submitOnboarding,
      buildRequest('POST', '/api/portal/onboarding/submit', { portalToken }),
    );
    expect(blockedSubmit.status).toBe(409);
    expect(blockedSubmit.body.error.details.outstanding.length).toBeGreaterThan(0);

    await callRoute(
      saveOnboarding,
      buildRequest('PATCH', '/api/portal/onboarding', {
        portalToken,
        body: {
          answers: items
            .filter((item) => item.required)
            .map((item) => ({
              key: item.key,
              value: item.kind === 'ATTESTATION' ? 'true' : 'None',
            })),
        },
      }),
    );

    const submitted = await callRoute(
      submitOnboarding,
      buildRequest('POST', '/api/portal/onboarding/submit', { portalToken }),
    );
    expect(submitted.status).toBe(200);
    expect(submitted.body.onboardingCase.status).toBe('SUBMITTED');
    expect(submitted.body.awaitingOperatorVerification).toBe(true);

    // Submitting does not verify: the expert is waiting on a human.
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } })).status).toBe(
      'PENDING_VERIFICATION',
    );
  });

  it('rejects an unknown checklist key with 400', async () => {
    const { portalToken } = await acceptedFixture();
    const result = await callRoute(
      saveOnboarding,
      buildRequest('PATCH', '/api/portal/onboarding', {
        portalToken,
        body: { answers: [{ key: 'date_of_birth', value: '1990-01-01' }] },
      }),
    );
    expect(result.status).toBe(400);
    expect(result.body.error.message).toContain('Unknown checklist item');
  });

  it('locks the checklist after submission', async () => {
    const { portalToken } = await acceptedFixture();
    const initial = await callRoute(
      getOnboarding,
      buildRequest('GET', '/api/portal/onboarding', { portalToken }),
    );
    const items = initial.body.onboardingCase.items as Array<{
      key: string;
      kind: string;
      required: boolean;
    }>;

    await callRoute(
      saveOnboarding,
      buildRequest('PATCH', '/api/portal/onboarding', {
        portalToken,
        body: {
          answers: items
            .filter((item) => item.required)
            .map((item) => ({
              key: item.key,
              value: item.kind === 'ATTESTATION' ? 'true' : 'None',
            })),
        },
      }),
    );
    await callRoute(
      submitOnboarding,
      buildRequest('POST', '/api/portal/onboarding/submit', { portalToken }),
    );

    const locked = await callRoute(
      saveOnboarding,
      buildRequest('PATCH', '/api/portal/onboarding', {
        portalToken,
        body: { answers: [{ key: 'conflict_check', value: 'Changed my mind' }] },
      }),
    );
    expect(locked.status).toBe(409);
  });
});
