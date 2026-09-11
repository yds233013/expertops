import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { login, resolveSession } from '@/server/services/auth';
import { declareAvailability } from '@/server/services/availability';
import {
  createInvitation,
  expireOverdueInvitations,
  remindPendingInvitations,
  respondToInvitation,
  sendInvitation,
  withdrawInvitation,
} from '@/server/services/invitations';
import { runMatching } from '@/server/services/matching';
import {
  decideVerification,
  getOnboardingCase,
  saveChecklistAnswers,
  submitOnboarding,
} from '@/server/services/onboarding';
import { issuePortalToken, redeemPortalToken } from '@/server/services/portal-access';
import { createProject, setProjectStatus, updateProject } from '@/server/services/projects';
import {
  confirmAssignment,
  proposeAssignment,
  releaseAssignment,
} from '@/server/services/staffing';

async function expectAppError(promise: Promise<unknown>, code: string, messagePattern?: RegExp) {
  try {
    await promise;
  } catch (error) {
    expect(error, `expected an AppError, received ${String(error)}`).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    if (messagePattern) expect((error as AppError).message).toMatch(messagePattern);
    return error as AppError;
  }
  throw new Error(`expected the call to reject with ${code}`);
}

describe('failure cases: authentication and access', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('rejects a wrong password without revealing that the account exists', async () => {
    await makeOperator({ email: 'known@expertops.test', password: 'correct-password' });

    const wrongPassword = await expectAppError(
      login(prisma, { email: 'known@expertops.test', password: 'incorrect-password' }),
      'UNAUTHENTICATED',
    );
    const unknownAccount = await expectAppError(
      login(prisma, { email: 'nobody@expertops.test', password: 'anything-at-all' }),
      'UNAUTHENTICATED',
    );
    expect(wrongPassword.message).toBe(unknownAccount.message);
  });

  it('refuses to sign in a deactivated operator', async () => {
    await makeOperator({
      email: 'gone@expertops.test',
      password: 'correct-password',
      isActive: false,
    });
    await expectAppError(
      login(prisma, { email: 'gone@expertops.test', password: 'correct-password' }),
      'UNAUTHENTICATED',
      /deactivated/,
    );
  });

  it('treats an expired session token as signed out', async () => {
    const operator = await makeOperator({ password: 'correct-password' });
    const session = await login(prisma, {
      email: operator.email,
      password: 'correct-password',
    });
    expect(await resolveSession(prisma, session.token)).not.toBeNull();

    await prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await resolveSession(prisma, session.token)).toBeNull();
  });

  it('treats a tampered session token as signed out', async () => {
    const operator = await makeOperator({ password: 'correct-password' });
    const session = await login(prisma, { email: operator.email, password: 'correct-password' });
    expect(await resolveSession(prisma, `${session.token}x`)).toBeNull();
  });
});

describe('failure cases: expert portal links', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('rejects an unknown portal token', async () => {
    await expectAppError(redeemPortalToken(prisma, 'not-a-real-token'), 'UNAUTHENTICATED');
  });

  it('burns a portal token after one use', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id });

    await redeemPortalToken(prisma, issued.token);
    await expectAppError(
      redeemPortalToken(prisma, issued.token),
      'UNAUTHENTICATED',
      /already been used/,
    );
  });

  it('rejects an expired portal token', async () => {
    const expert = await makeExpert();
    const issued = await issuePortalToken(prisma, { expertId: expert.id, ttlHours: 1 });
    await prisma.expertPortalToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await expectAppError(redeemPortalToken(prisma, issued.token), 'UNAUTHENTICATED', /expired/);
  });

  it('rejects a portal token belonging to an archived expert', async () => {
    const expert = await makeExpert({ status: 'ARCHIVED' });
    const issued = await issuePortalToken(prisma, { expertId: expert.id });
    await expectAppError(
      redeemPortalToken(prisma, issued.token),
      'UNAUTHENTICATED',
      /no longer active/,
    );
  });
});

describe('failure cases: projects and matching', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses to open a project for matching with no requirements', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await createProject(prisma, actor, {
      title: 'Requirement-free project',
      clientName: 'Test Client',
      requirements: [],
    });
    await expectAppError(
      setProjectStatus(prisma, actor, project.id, 'MATCHING'),
      'INVALID_STATE',
      /no skill requirements/,
    );
  });

  it('refuses an illegal project status jump', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'DRAFT' });
    await expectAppError(
      setProjectStatus(prisma, actor, project.id, 'ACTIVE'),
      'INVALID_STATE',
      /cannot move from DRAFT to ACTIVE/,
    );
  });

  it('refuses to match a project that is still a draft', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'DRAFT' });
    await expectAppError(
      runMatching(prisma, actorFor(operator), project.id),
      'INVALID_STATE',
      /Matching runs only for/,
    );
  });

  it('rejects an end date before the start date', async () => {
    const operator = await makeOperator();
    await expectAppError(
      createProject(prisma, actorFor(operator), {
        title: 'Backwards project',
        clientName: 'Test Client',
        startDate: new Date('2026-09-01'),
        endDate: new Date('2026-08-01'),
        requirements: [{ skillName: 'Distributed Systems', required: true }],
      }),
      'BAD_REQUEST',
      /end date cannot be before/,
    );
  });

  it('rejects a duplicate skill requirement', async () => {
    const operator = await makeOperator();
    await expectAppError(
      createProject(prisma, actorFor(operator), {
        title: 'Duplicated requirement',
        clientName: 'Test Client',
        requirements: [
          { skillName: 'Distributed Systems', required: true },
          { skillName: 'distributed systems', required: false },
        ],
      }),
      'BAD_REQUEST',
      /listed twice/,
    );
  });

  it('refuses to shrink seats below what is already filled', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal.id);

    await expectAppError(
      updateProject(prisma, actor, project.id, { seatsRequested: 0 }),
      'BAD_REQUEST',
      /positive integer/,
    );

    const project3 = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 3 });
    const staffable = await makeStaffableExpert(project3.id);
    const proposal3 = await proposeAssignment(prisma, actor, {
      projectId: project3.id,
      expertId: staffable.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal3.id);
    // Filled = 1, so asking for 1 is fine but the project cannot be edited once
    // closed. Reducing below the filled count is the failure we care about.
    await prisma.project.update({ where: { id: project3.id }, data: { seatsFilled: 2 } });
    await expectAppError(
      updateProject(prisma, actor, project3.id, { seatsRequested: 1 }),
      'INVALID_STATE',
      /already filled/,
    );
  });

  it('refuses to edit a closed project', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    await setProjectStatus(prisma, actor, project.id, 'CLOSED');
    await expectAppError(
      updateProject(prisma, actor, project.id, { title: 'Reopened' }),
      'INVALID_STATE',
      /CLOSED/,
    );
  });
});

describe('failure cases: invitations', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function setup() {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    return { operator, actor, project, expert };
  }

  it('refuses a second invitation while one is already open', async () => {
    const { actor, project, expert } = await setup();
    await createInvitation(prisma, actor, { projectId: project.id, expertId: expert.id });
    await expectAppError(
      createInvitation(prisma, actor, { projectId: project.id, expertId: expert.id }),
      'CONFLICT',
      /already has a DRAFT invitation/,
    );
  });

  it('refuses to invite an archived expert', async () => {
    const { actor, project } = await setup();
    const archived = await makeExpert({ status: 'ARCHIVED' });
    await expectAppError(
      createInvitation(prisma, actor, { projectId: project.id, expertId: archived.id }),
      'INVALID_STATE',
      /archived/,
    );
  });

  it('refuses to invite onto a project whose last seat was just filled', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const staffed = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: staffed.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal.id);

    // Filling the last seat moves the project to ACTIVE, which is itself closed
    // to new invitations.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(
      'ACTIVE',
    );

    const other = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    await expectAppError(
      createInvitation(prisma, actor, { projectId: project.id, expertId: other.id }),
      'INVALID_STATE',
      /Invitations can only be sent/,
    );
  });

  it('refuses to invite when no seats remain even if the project is still staffing', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const staffed = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: staffed.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal.id);

    // Shrink the brief to a single seat: the project stays STAFFING, but there
    // is no capacity left for another invitation.
    await prisma.project.update({ where: { id: project.id }, data: { seatsRequested: 1 } });

    const other = await makeExpert({ skills: [{ name: 'Distributed Systems', proficiency: 4 }] });
    await expectAppError(
      createInvitation(prisma, actor, { projectId: project.id, expertId: other.id }),
      'INVALID_STATE',
      /seat\(s\) filled/,
    );
  });

  it('refuses to answer an expired invitation', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expectAppError(
      respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true }),
      'INVALID_STATE',
      /expired/,
    );
  });

  it('refuses to answer an invitation twice', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    await expectAppError(
      respondToInvitation(prisma, expert.id, {
        invitationId: invitation.id,
        accept: false,
        declineReason: 'changed my mind',
      }),
      'INVALID_STATE',
      /already ACCEPTED|terminal state/,
    );
  });

  it("hides another expert's invitation rather than leaking its existence", async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);

    const intruder = await makeExpert();
    await expectAppError(
      respondToInvitation(prisma, intruder.id, { invitationId: invitation.id, accept: true }),
      'NOT_FOUND',
    );
  });

  it('requires a reason when declining', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await expectAppError(
      respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: false }),
      'BAD_REQUEST',
      /short reason/,
    );
  });

  it('refuses to withdraw an invitation the expert already accepted', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    await expectAppError(
      withdrawInvitation(prisma, actor, invitation.id, 'No longer needed'),
      'INVALID_STATE',
    );
  });

  it('expires an overdue invitation exactly once and queues one notice', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const first = await expireOverdueInvitations(prisma);
    const second = await expireOverdueInvitations(prisma);

    expect(first.expiredCount).toBe(1);
    expect(second.expiredCount).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.expired' } })).toBe(1);
  });

  it('sends at most one reminder per invitation', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      ttlHours: 72,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { sentAt: new Date(Date.now() - 48 * 3_600_000) },
    });

    const first = await remindPendingInvitations(prisma, { remindAfterHours: 24 });
    const second = await remindPendingInvitations(prisma, { remindAfterHours: 24 });

    expect(first.remindedCount).toBe(1);
    expect(second.remindedCount).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.reminder' } })).toBe(
      1,
    );
  });

  it('does not remind an invitation that is about to expire anyway', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: {
        sentAt: new Date(Date.now() - 48 * 3_600_000),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });

    const result = await remindPendingInvitations(prisma, {
      remindAfterHours: 24,
      minHoursRemaining: 2,
    });
    expect(result.remindedCount).toBe(0);
  });

  it('does not send an invitation twice', async () => {
    const { actor, project, expert } = await setup();
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    expect(await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id)).not.toBeNull();
    expect(await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id)).toBeNull();
    expect(await prisma.outboxMessage.count({ where: { template: 'invitation.sent' } })).toBe(1);
  });
});

describe('failure cases: availability', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('rejects a window that ends before it starts', async () => {
    const expert = await makeExpert();
    await expectAppError(
      declareAvailability(
        prisma,
        { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
        expert.id,
        {
          startAt: new Date('2026-09-01'),
          endAt: new Date('2026-08-01'),
          hoursPerWeek: 10,
        },
      ),
      'BAD_REQUEST',
      /must be after the start/,
    );
  });

  it('rejects an unrealistic weekly commitment', async () => {
    const expert = await makeExpert();
    await expectAppError(
      declareAvailability(
        prisma,
        { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
        expert.id,
        {
          startAt: new Date('2026-08-01'),
          endAt: new Date('2026-09-01'),
          hoursPerWeek: 100,
        },
      ),
      'BAD_REQUEST',
      /cannot exceed 60/,
    );
  });

  it('rejects an overlapping window', async () => {
    const expert = await makeExpert();
    const actor = { type: 'EXPERT' as const, expertId: expert.id, label: expert.fullName };
    await declareAvailability(prisma, actor, expert.id, {
      startAt: new Date('2026-08-01'),
      endAt: new Date('2026-10-01'),
      hoursPerWeek: 10,
    });
    await expectAppError(
      declareAvailability(prisma, actor, expert.id, {
        startAt: new Date('2026-09-01'),
        endAt: new Date('2026-11-01'),
        hoursPerWeek: 20,
      }),
      'INVALID_STATE',
      /overlaps/,
    );
  });

  it('refuses project availability without an accepted invitation', async () => {
    const operator = await makeOperator();
    const project = await makeProject(operator.id);
    const expert = await makeExpert();
    await expectAppError(
      declareAvailability(
        prisma,
        { type: 'EXPERT', expertId: expert.id, label: expert.fullName },
        expert.id,
        {
          startAt: new Date('2026-08-01'),
          endAt: new Date('2026-10-01'),
          hoursPerWeek: 10,
          projectId: project.id,
        },
      ),
      'INVALID_STATE',
      /after accepting its invitation/,
    );
  });
});

describe('failure cases: onboarding and verification', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function expertWithOpenCase() {
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
    return {
      operator,
      actor,
      project,
      expert,
      expertActor: { type: 'EXPERT' as const, expertId: expert.id, label: expert.fullName },
    };
  }

  it('refuses to submit an incomplete checklist and names what is missing', async () => {
    const { expert, expertActor } = await expertWithOpenCase();
    const error = await expectAppError(
      submitOnboarding(prisma, expertActor, expert.id),
      'INVALID_STATE',
      /required item/,
    );
    const details = error.details as { outstanding: Array<{ key: string }> };
    expect(details.outstanding.length).toBeGreaterThan(0);
    expect(details.outstanding.map((item) => item.key)).toContain('nda_accepted');
  });

  it('rejects an unknown checklist key', async () => {
    const { expert, expertActor } = await expertWithOpenCase();
    await expectAppError(
      saveChecklistAnswers(prisma, expertActor, expert.id, [
        { key: 'social_security_number', value: 'x' },
      ]),
      'BAD_REQUEST',
      /Unknown checklist item/,
    );
  });

  it('rejects a non-boolean answer to an attestation', async () => {
    const { expert, expertActor } = await expertWithOpenCase();
    await expectAppError(
      saveChecklistAnswers(prisma, expertActor, expert.id, [
        { key: 'nda_accepted', value: 'maybe' },
      ]),
      'BAD_REQUEST',
      /must be answered true or false/,
    );
  });

  it('rejects a blank answer to a required text item', async () => {
    const { expert, expertActor } = await expertWithOpenCase();
    await expectAppError(
      saveChecklistAnswers(prisma, expertActor, expert.id, [
        { key: 'conflict_check', value: '   ' },
      ]),
      'BAD_REQUEST',
      /is required/,
    );
  });

  async function submitFull() {
    const context = await expertWithOpenCase();
    const openCase = await getOnboardingCase(prisma, context.expert.id);
    await saveChecklistAnswers(
      prisma,
      context.expertActor,
      context.expert.id,
      openCase.items
        .filter((item) => item.required)
        .map((item) => ({ key: item.key, value: item.kind === 'ATTESTATION' ? 'true' : 'None' })),
    );
    await submitOnboarding(prisma, context.expertActor, context.expert.id);
    return context;
  }

  it('locks the checklist once submitted', async () => {
    const { expert, expertActor } = await submitFull();
    await expectAppError(
      saveChecklistAnswers(prisma, expertActor, expert.id, [
        { key: 'conflict_check', value: 'Actually, one' },
      ]),
      'INVALID_STATE',
      /waiting on operator review/,
    );
  });

  it('refuses to submit the same checklist twice', async () => {
    const { expert, expertActor } = await submitFull();
    await expectAppError(
      submitOnboarding(prisma, expertActor, expert.id),
      'INVALID_STATE',
      /already SUBMITTED/,
    );
  });

  it('requires a reason when an operator returns a submission', async () => {
    const { expert, actor } = await submitFull();
    await expectAppError(
      decideVerification(prisma, actor, { expertId: expert.id, approve: false }),
      'BAD_REQUEST',
      /reason is required/,
    );
  });

  it('refuses to verify a case that was never submitted', async () => {
    const { expert, actor } = await expertWithOpenCase();
    await expectAppError(
      decideVerification(prisma, actor, { expertId: expert.id, approve: true }),
      'INVALID_STATE',
      /cannot move from IN_PROGRESS to VERIFIED/,
    );
  });

  it('refuses a second verification decision on the same case', async () => {
    const { expert, actor } = await submitFull();
    await decideVerification(prisma, actor, { expertId: expert.id, approve: true });
    await expectAppError(
      decideVerification(prisma, actor, {
        expertId: expert.id,
        approve: false,
        note: 'changed mind',
      }),
      'INVALID_STATE',
    );
  });

  it('reports a missing onboarding case rather than inventing one', async () => {
    const expert = await makeExpert();
    await expectAppError(getOnboardingCase(prisma, expert.id), 'NOT_FOUND');
  });
});

describe('failure cases: staffing', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('refuses to staff an expert whose onboarding is not verified', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeExpert({ status: 'PROSPECT' });
    await prisma.invitation.create({
      data: {
        projectId: project.id,
        expertId: expert.id,
        status: 'ACCEPTED',
        expiresAt: new Date(Date.now() + 86_400_000),
        respondedAt: new Date(),
      },
    });

    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      }),
      'INVALID_STATE',
      /Only VERIFIED experts can be staffed/,
    );
  });

  it('refuses to staff an expert who never accepted an invitation', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeExpert({ status: 'VERIFIED' });

    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      }),
      'INVALID_STATE',
      /has not accepted an invitation/,
    );
  });

  it('refuses to staff an expert with no declared availability', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeStaffableExpert(project.id);
    await prisma.availabilityWindow.deleteMany({ where: { expertId: expert.id } });

    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      }),
      'INVALID_STATE',
      /has not declared availability/,
    );
  });

  it('refuses an allocation larger than the expert declared', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING' });
    const expert = await makeStaffableExpert(project.id, { weeklyCapacityHours: 12 });

    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 30,
      }),
      'INVALID_STATE',
      /exceeds the 12h\/week/,
    );
  });

  it('refuses to staff a project that is still a draft', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'DRAFT' });
    const expert = await makeExpert({ status: 'VERIFIED' });

    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      }),
      'INVALID_STATE',
      /Staffing is only possible/,
    );
  });

  it('refuses to confirm a seat when the project is already full', async () => {
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
    await expectAppError(
      confirmAssignment(prisma, actor, proposalB.id),
      'CAPACITY_EXCEEDED',
      /no seats left/,
    );
  });

  it('refuses to confirm the same assignment twice', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 2 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal.id);

    await expectAppError(confirmAssignment(prisma, actor, proposal.id), 'INVALID_STATE');
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(1);
  });

  it('refuses to confirm an expert whose verification was revoked after the proposal', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });

    await prisma.expert.update({ where: { id: expert.id }, data: { status: 'ARCHIVED' } });

    await expectAppError(
      confirmAssignment(prisma, actor, proposal.id),
      'INVALID_STATE',
      /can no longer be confirmed/,
    );
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(0);
  });

  it('requires a reason to release a seat, and frees it once released', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, { status: 'STAFFING', seatsRequested: 1 });
    const expert = await makeStaffableExpert(project.id);
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    await confirmAssignment(prisma, actor, proposal.id);

    await expectAppError(
      releaseAssignment(prisma, actor, proposal.id, '   '),
      'BAD_REQUEST',
      /reason is required/,
    );

    const released = await releaseAssignment(prisma, actor, proposal.id, 'Client paused the work');
    expect(released.seatsFilled).toBe(0);
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(0);
    expect(await prisma.outboxMessage.count({ where: { template: 'assignment.released' } })).toBe(
      1,
    );
  });

  it('reports a missing project or assignment as NOT_FOUND', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    await expectAppError(
      proposeAssignment(prisma, actor, {
        projectId: 'does-not-exist',
        expertId: 'nor-this',
        allocationHoursPerWeek: 5,
      }),
      'NOT_FOUND',
    );
    await expectAppError(confirmAssignment(prisma, actor, 'does-not-exist'), 'NOT_FOUND');
  });
});
