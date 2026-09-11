import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import { listActivity, recordActivity, SYSTEM_ACTOR } from '@/server/services/activity';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import {
  dispatchQueuedMessages,
  listMessages,
  outboxCounts,
  queueMessage,
} from '@/server/services/outbox';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';

describe('activity history', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('attributes each step to the operator, expert or worker that caused it', async () => {
    const operator = await makeOperator({ name: 'Sam Okafor' });
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    const { events } = await listActivity(prisma, { projectId: project.id });
    const byAction = new Map(events.map((event) => [event.action, event]));

    expect(byAction.get('invitation.created')!.actorType).toBe('OPERATOR');
    expect(byAction.get('invitation.created')!.actorUserId).toBe(operator.id);
    expect(byAction.get('invitation.sent')!.actorType).toBe('SYSTEM');
    expect(byAction.get('invitation.accepted')!.actorType).toBe('EXPERT');
    expect(byAction.get('invitation.accepted')!.actorExpertId).toBe(expert.id);
  });

  it('attributes an automatic status advance to the worker, not the expert', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });

    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    const advances = await prisma.activityEvent.findMany({
      where: { projectId: project.id, action: 'project.status_advanced' },
    });
    expect(advances.length).toBeGreaterThan(0);
    for (const event of advances) {
      // Nobody chose to move the project; the workflow did.
      expect(event.actorType).toBe('SYSTEM');
      expect((event.metadata as Record<string, unknown>).automated).toBe(true);
      // The person whose action triggered it is still recorded.
      expect((event.metadata as Record<string, unknown>).triggeredBy).toBeTruthy();
    }

    const final = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(final.status).toBe('STAFFING');
  });

  it('returns events newest first with a working cursor', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    for (let index = 0; index < 8; index += 1) {
      await recordActivity(prisma, {
        actor,
        entityType: 'project',
        entityId: `entity-${index}`,
        action: 'project.updated',
        summary: `Event ${index}`,
      });
    }

    const firstPage = await listActivity(prisma, { limit: 5 });
    expect(firstPage.events).toHaveLength(5);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listActivity(prisma, { limit: 5, cursor: firstPage.nextCursor! });
    expect(secondPage.events).toHaveLength(3);

    const allIds = [...firstPage.events, ...secondPage.events].map((event) => event.id);
    expect(new Set(allIds).size).toBe(8);
  });

  it('filters to a single expert timeline', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const expertA = await makeExpert();
    const expertB = await makeExpert();

    await recordActivity(prisma, {
      actor,
      entityType: 'expert',
      entityId: expertA.id,
      expertId: expertA.id,
      action: 'expert.updated',
      summary: 'A changed',
    });
    await recordActivity(prisma, {
      actor,
      entityType: 'expert',
      entityId: expertB.id,
      expertId: expertB.id,
      action: 'expert.updated',
      summary: 'B changed',
    });

    const { events } = await listActivity(prisma, { expertId: expertA.id });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('A changed');
  });

  it('rolls the history entry back with the step that failed', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const first = await makeStaffableExpert(project.id);
    const second = await makeStaffableExpert(project.id);

    const proposalA = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: first.id,
      allocationHoursPerWeek: 10,
    });
    const proposalB = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: second.id,
      allocationHoursPerWeek: 10,
    });

    await confirmAssignment(prisma, actor, proposalA.id);
    await expect(confirmAssignment(prisma, actor, proposalB.id)).rejects.toThrow();

    // Only the successful confirmation left a trace, and only one email queued.
    expect(await prisma.activityEvent.count({ where: { action: 'assignment.confirmed' } })).toBe(1);
    expect(await prisma.outboxMessage.count({ where: { template: 'assignment.confirmed' } })).toBe(
      1,
    );
  });
});

describe('simulated outbox', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('queues a message that no external service ever sees', async () => {
    const expert = await makeExpert();
    const message = await queueMessage(prisma, {
      toEmail: expert.email,
      toName: expert.fullName,
      subject: 'Test subject',
      bodyText: 'Test body',
      template: 'invitation.sent',
      expertId: expert.id,
    });

    expect(message.status).toBe('QUEUED');
    expect(message.sentAt).toBeNull();
    expect(await outboxCounts(prisma)).toEqual({ QUEUED: 1, SENT: 0, FAILED: 0 });
  });

  it('delivers in creation order and stops at the limit', async () => {
    for (let index = 0; index < 5; index += 1) {
      await queueMessage(prisma, {
        toEmail: `expert${index}@example.test`,
        subject: `Message ${index}`,
        bodyText: 'body',
        template: 'invitation.sent',
      });
    }

    const result = await dispatchQueuedMessages(prisma, { limit: 3 });
    expect(result.delivered).toBe(3);

    const counts = await outboxCounts(prisma);
    expect(counts.SENT).toBe(3);
    expect(counts.QUEUED).toBe(2);

    const stillQueued = await listMessages(prisma, { status: 'QUEUED' });
    expect(stillQueued.messages.map((m) => m.subject)).toEqual(['Message 4', 'Message 3']);
  });

  it('does not redeliver a message that was already sent', async () => {
    await queueMessage(prisma, {
      toEmail: 'once@example.test',
      subject: 'Once only',
      bodyText: 'body',
      template: 'invitation.sent',
    });

    await dispatchQueuedMessages(prisma);
    const second = await dispatchQueuedMessages(prisma);

    expect(second.delivered).toBe(0);
    const message = await prisma.outboxMessage.findFirstOrThrow();
    expect(message.attempts).toBe(1);
  });

  it('searches message bodies and filters by expert', async () => {
    const expert = await makeExpert();
    await queueMessage(prisma, {
      toEmail: expert.email,
      subject: 'Project invitation: Settlement review',
      bodyText: 'Please respond by Friday.',
      template: 'invitation.sent',
      expertId: expert.id,
    });
    await queueMessage(prisma, {
      toEmail: 'other@example.test',
      subject: 'Something else',
      bodyText: 'Unrelated.',
      template: 'onboarding.nudge',
    });

    const bySearch = await listMessages(prisma, { search: 'settlement' });
    expect(bySearch.messages).toHaveLength(1);

    const byExpert = await listMessages(prisma, { expertId: expert.id });
    expect(byExpert.messages).toHaveLength(1);

    const byTemplate = await listMessages(prisma, { template: 'onboarding.nudge' });
    expect(byTemplate.messages).toHaveLength(1);
  });
});
