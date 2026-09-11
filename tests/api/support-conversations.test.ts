import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { buildRequest, callRoute, cookieValue, operatorToken } from '../helpers/api';
import { makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { PORTAL_COOKIE } from '@/server/http/context';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { createInvitation, sendInvitation } from '@/server/services/invitations';
import { POST as portalSession } from '@/app/api/portal/session/route';
import {
  GET as portalSupportList,
  POST as portalSupportRaise,
} from '@/app/api/portal/support/route';
import { POST as portalSupportReply } from '@/app/api/portal/support/[requestId]/route';
import { GET as operatorSupportList } from '@/app/api/support-requests/route';
import { POST as operatorSupportAct } from '@/app/api/support-requests/[requestId]/route';

/**
 * Support conversations across both interfaces.
 *
 * The rule under test is the one that matters most here: an internal operator
 * note must never reach an expert, in any response, by any route.
 */
async function fixture() {
  const operator = await makeOperator({ role: 'ADMIN' });
  const opToken = await operatorToken(operator);
  const project = await makeProject(operator.id, { status: 'MATCHING' });
  const expert = await makeExpert();

  const invitation = await createInvitation(
    prisma,
    { type: 'OPERATOR', userId: operator.id, label: operator.name },
    { projectId: project.id, expertId: expert.id },
  );
  const sent = await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
  const session = await callRoute(
    portalSession,
    buildRequest('POST', '/api/portal/session', {
      body: { token: sent!.portalUrl.split('/').pop()! },
    }),
  );
  return {
    operator,
    opToken,
    project,
    expert,
    portalToken: cookieValue(session.response, PORTAL_COOKIE)!,
  };
}

describe('support conversations', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('carries a thread from expert to operator and back', async () => {
    const { opToken, project, expert, portalToken } = await fixture();

    const raised = await callRoute(
      portalSupportRaise,
      buildRequest('POST', '/api/portal/support', {
        portalToken,
        body: {
          subject: 'Cannot reach the annotation tool',
          message: 'The sign-in page rejects my account.',
          category: 'ACCESS',
          projectId: project.id,
        },
      }),
    );
    expect(raised.status).toBe(201);
    const requestId = raised.body.request.id;

    // The operator sees it in their queue.
    const queue = await callRoute(
      operatorSupportList,
      buildRequest('GET', '/api/support-requests', { operatorToken: opToken }),
    );
    expect(queue.body.requests.map((r: { id: string }) => r.id)).toContain(requestId);

    // An internal note, then a public reply.
    const note = await callRoute(
      operatorSupportAct,
      buildRequest('POST', `/api/support-requests/${requestId}`, {
        operatorToken: opToken,
        body: { action: 'reply', body: 'Account was disabled for inactivity.', internalOnly: true },
      }),
      { requestId },
    );
    expect(note.status).toBe(200);

    const publicReply = await callRoute(
      operatorSupportAct,
      buildRequest('POST', `/api/support-requests/${requestId}`, {
        operatorToken: opToken,
        body: { action: 'reply', body: 'Your access is restored, please try again.' },
      }),
      { requestId },
    );
    expect(publicReply.status).toBe(200);

    // The expert sees only the public reply.
    const expertView = await callRoute(
      portalSupportList,
      buildRequest('GET', '/api/portal/support', { portalToken }),
    );
    const thread = expertView.body.requests.find((r: { id: string }) => r.id === requestId);
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0].body).toMatch(/access is restored/);
    expect(JSON.stringify(expertView.body)).not.toContain('disabled for inactivity');
    expect(JSON.stringify(expertView.body)).not.toContain('internalOnly');
    expect(thread.status).toBe('WAITING_ON_EXPERT');

    // The expert replies, and the thread comes back to the operator.
    const expertReply = await callRoute(
      portalSupportReply,
      buildRequest('POST', `/api/portal/support/${requestId}`, {
        portalToken,
        body: { body: 'That worked, thank you.' },
      }),
      { requestId },
    );
    expect(expertReply.status).toBe(200);
    expect(
      await prisma.supportRequest.findUniqueOrThrow({ where: { id: requestId } }),
    ).toMatchObject({ status: 'WAITING_ON_OPS' });

    // The operator's own view keeps both, and says which is internal.
    const operatorThread = await callRoute(
      operatorSupportList,
      buildRequest('GET', '/api/support-requests', { operatorToken: opToken }),
    );
    const full = operatorThread.body.requests.find((r: { id: string }) => r.id === requestId);
    expect(full.replies).toHaveLength(3);
    expect(full.replies.filter((r: { internalOnly: boolean }) => r.internalOnly)).toHaveLength(1);
    expect(expert.id).toBe(full.expertId);
  });

  it('refuses an internal note from an expert', async () => {
    const { opToken, portalToken } = await fixture();
    const raised = await callRoute(
      portalSupportRaise,
      buildRequest('POST', '/api/portal/support', {
        portalToken,
        body: { subject: 'Question', message: 'Scope question.' },
      }),
    );
    const requestId = raised.body.request.id;

    // The expert route has no internalOnly field at all, and the operator route
    // requires an operator session, so the expert cookie is rejected there.
    const attempt = await callRoute(
      operatorSupportAct,
      buildRequest('POST', `/api/support-requests/${requestId}`, {
        portalToken,
        body: { action: 'reply', body: 'sneaky', internalOnly: true },
      }),
      { requestId },
    );
    expect(attempt.status).toBe(401);

    const stored = await prisma.supportReply.findMany({ where: { requestId } });
    expect(stored.filter((reply) => reply.internalOnly)).toHaveLength(0);
    expect(opToken).toBeTruthy();
  });

  it('refuses one expert reaching another expert’s thread', async () => {
    const { portalToken } = await fixture();
    const other = await fixture();

    const raised = await callRoute(
      portalSupportRaise,
      buildRequest('POST', '/api/portal/support', {
        portalToken: other.portalToken,
        body: { subject: 'Private matter', message: 'Only for the other expert.' },
      }),
    );
    const requestId = raised.body.request.id;

    const intrusion = await callRoute(
      portalSupportReply,
      buildRequest('POST', `/api/portal/support/${requestId}`, {
        portalToken,
        body: { body: 'not my thread' },
      }),
      { requestId },
    );
    expect(intrusion.status).toBe(404);

    const mine = await callRoute(
      portalSupportList,
      buildRequest('GET', '/api/portal/support', { portalToken }),
    );
    expect(mine.body.requests).toHaveLength(0);
    expect(JSON.stringify(mine.body)).not.toContain('Private matter');
  });

  it('requires a session and a same-origin request to reply', async () => {
    const { portalToken } = await fixture();
    const raised = await callRoute(
      portalSupportRaise,
      buildRequest('POST', '/api/portal/support', {
        portalToken,
        body: { subject: 'Tooling', message: 'The editor crashes.' },
      }),
    );
    const requestId = raised.body.request.id;

    const anonymous = await callRoute(
      portalSupportReply,
      buildRequest('POST', `/api/portal/support/${requestId}`, { body: { body: 'hello' } }),
      { requestId },
    );
    expect(anonymous.status).toBe(401);

    const crossOrigin = await callRoute(
      portalSupportReply,
      buildRequest('POST', `/api/portal/support/${requestId}`, {
        portalToken,
        origin: 'https://attacker.example',
        body: { body: 'forged' },
      }),
      { requestId },
    );
    expect(crossOrigin.status).toBe(403);
    expect(await prisma.supportReply.count({ where: { requestId } })).toBe(0);
  });
});
