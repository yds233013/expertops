import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { tokenFromMagicLink } from '../helpers/api';

import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeSkill } from '../helpers/factories';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { createProject, setProjectStatus } from '@/server/services/projects';
import { runMatching } from '@/server/services/matching';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { declareAvailability } from '@/server/services/availability';
import {
  decideVerification,
  getOnboardingCase,
  saveChecklistAnswers,
  submitOnboarding,
} from '@/server/services/onboarding';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { dispatchQueuedMessages } from '@/server/services/outbox';
import { redeemPortalToken } from '@/server/services/portal-access';

/**
 * The end-to-end product slice, exercised through the same business services
 * the UI and the worker call:
 *
 *   project creation → matching → invitation → expert acceptance →
 *   availability → onboarding → operator verification → staffing assignment
 */
describe('end-to-end staffing workflow', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('takes a project from creation to a confirmed seat', async () => {
    const operator = await makeOperator({ name: 'Sam Okafor', role: 'OPERATOR' });
    const actor = actorFor(operator);

    await makeSkill('Payments Infrastructure');
    await makeSkill('Risk Modelling');

    // --- 1. project creation ------------------------------------------------
    const project = await createProject(prisma, actor, {
      title: 'Card settlement reconciliation review',
      clientName: 'Northwind Logistics',
      seatsRequested: 1,
      minYearsExperience: 6,
      maxHourlyRateCents: 30_000,
      preferredTimezone: 'Europe/London',
      requirements: [
        { skillName: 'Payments Infrastructure', required: true, minProficiency: 3, weight: 5 },
        { skillName: 'Risk Modelling', required: false, minProficiency: 2, weight: 2 },
      ],
    });
    expect(project.code).toMatch(/^PRJ-\d{4}$/);
    expect(project.status).toBe('DRAFT');

    await setProjectStatus(prisma, actor, project.id, 'MATCHING');

    // A strong candidate, a weak one, and one who fails the hard filter.
    const strong = await makeExpert({
      fullName: 'Avery Lindqvist',
      yearsExperience: 14,
      hourlyRateCents: 24_000,
      timezone: 'Europe/London',
      weeklyCapacityHours: 25,
      skills: [
        { name: 'Payments Infrastructure', proficiency: 5 },
        { name: 'Risk Modelling', proficiency: 4 },
      ],
    });
    const weak = await makeExpert({
      fullName: 'Rowan Barros',
      yearsExperience: 7,
      hourlyRateCents: 29_000,
      timezone: 'Asia/Tokyo',
      weeklyCapacityHours: 8,
      skills: [{ name: 'Payments Infrastructure', proficiency: 3 }],
    });
    const unqualified = await makeExpert({
      fullName: 'Quinn Mehta',
      yearsExperience: 20,
      skills: [{ name: 'Risk Modelling', proficiency: 5 }],
    });

    // --- 2. matching --------------------------------------------------------
    const matchRun = await runMatching(prisma, actor, project.id, {
      limit: 10,
      includeExcluded: true,
    });

    expect(matchRun.algorithmVersion).toBe('rules-v1');
    const ranked = matchRun.candidates.filter((candidate) => !candidate.excluded);
    expect(ranked[0]!.expertId).toBe(strong.id);
    expect(ranked.map((c) => c.expertId)).toContain(weak.id);

    const excluded = matchRun.candidates.find((c) => c.expertId === unqualified.id);
    expect(excluded?.excluded).toBe(true);
    expect(excluded?.exclusionReason).toContain('Missing required skill');

    // --- 3. invitation ------------------------------------------------------
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: strong.id,
      message: 'Three-week reconciliation review.',
      ttlHours: 48,
    });
    expect(invitation.status).toBe('DRAFT');

    // Creating the invitation queues the send as a background job.
    const queuedSend = await prisma.job.findFirst({ where: { type: 'invitation.send' } });
    expect(queuedSend).not.toBeNull();

    // Sending is the worker's job; it renders into the simulated outbox.
    const sent = await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    expect(sent).not.toBeNull();
    // The token lives in the fragment, so the path carries nothing secret.
    expect(sent!.portalUrl).toContain('/portal/enter#t=');
    expect(new URL(sent!.portalUrl).pathname).toBe('/portal/enter');

    // An invitation is operational, so a default UNKNOWN preference does not
    // stop it and the message is always written.
    expect(sent!.outboxMessageId).not.toBeNull();
    const message = await prisma.outboxMessage.findUniqueOrThrow({
      where: { id: sent!.outboxMessageId! },
    });
    expect(message.status).toBe('QUEUED');
    expect(message.toEmail).toBe(strong.email);

    const dispatched = await dispatchQueuedMessages(prisma);
    expect(dispatched.delivered).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.outboxMessage.findUniqueOrThrow({ where: { id: message.id } })).status,
    ).toBe('SENT');

    // The project moved itself to INVITING as a side effect.
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(
      'INVITING',
    );

    // --- 4. expert acceptance (through a redeemed portal link) --------------
    const rawToken = tokenFromMagicLink(sent!.portalUrl);
    const portalSession = await redeemPortalToken(prisma, rawToken);
    expect(portalSession.expert.id).toBe(strong.id);

    const accepted = await respondToInvitation(prisma, strong.id, {
      invitationId: invitation.id,
      accept: true,
    });
    expect(accepted.status).toBe('ACCEPTED');

    const afterAccept = await prisma.expert.findUniqueOrThrow({ where: { id: strong.id } });
    expect(afterAccept.status).toBe('ONBOARDING');
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(
      'STAFFING',
    );

    // --- 5. availability ----------------------------------------------------
    const window = await declareAvailability(
      prisma,
      { type: 'EXPERT', expertId: strong.id, label: strong.fullName },
      strong.id,
      {
        startAt: new Date(Date.now() + 86_400_000),
        endAt: new Date(Date.now() + 60 * 86_400_000),
        hoursPerWeek: 20,
        projectId: project.id,
      },
    );
    expect(window.hoursPerWeek).toBe(20);

    // --- 6. onboarding ------------------------------------------------------
    const openCase = await getOnboardingCase(prisma, strong.id);
    expect(openCase.status).toBe('IN_PROGRESS');

    const expertActor = { type: 'EXPERT' as const, expertId: strong.id, label: strong.fullName };
    await saveChecklistAnswers(
      prisma,
      expertActor,
      strong.id,
      openCase.items
        .filter((item) => item.required)
        .map((item) => ({
          key: item.key,
          value: item.kind === 'ATTESTATION' ? 'true' : 'None',
        })),
    );

    const submitted = await submitOnboarding(prisma, expertActor, strong.id);
    expect(submitted.status).toBe('SUBMITTED');
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: strong.id } })).status).toBe(
      'PENDING_VERIFICATION',
    );

    // Submitting does NOT staff anyone: verification is a separate human step.
    await expect(
      proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: strong.id,
        allocationHoursPerWeek: 16,
      }),
    ).rejects.toThrow(/PENDING_VERIFICATION/);

    // --- 7. operator verification ------------------------------------------
    const verified = await decideVerification(prisma, actor, {
      expertId: strong.id,
      approve: true,
      note: 'Checked billing reference and conflict declaration.',
    });
    expect(verified.status).toBe('VERIFIED');
    expect(verified.verifiedById).toBe(operator.id);
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: strong.id } })).status).toBe(
      'VERIFIED',
    );

    // --- 8. staffing --------------------------------------------------------
    const proposal = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: strong.id,
      allocationHoursPerWeek: 16,
    });
    expect(proposal.status).toBe('PROPOSED');
    // A proposal alone does not consume a seat.
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(0);

    const confirmation = await confirmAssignment(prisma, actor, proposal.id);
    expect(confirmation.assignment.status).toBe('CONFIRMED');
    expect(confirmation.seatsFilled).toBe(1);
    expect(confirmation.projectBecameActive).toBe(true);

    const finalProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(finalProject.seatsFilled).toBe(1);
    expect(finalProject.status).toBe('ACTIVE');

    // --- 9. the history tells the whole story -------------------------------
    const events = await prisma.activityEvent.findMany({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
    });
    const actions = events.map((event) => event.action);
    expect(actions).toContain('project.created');
    expect(actions).toContain('matching.run');
    expect(actions).toContain('invitation.created');
    expect(actions).toContain('invitation.sent');
    expect(actions).toContain('invitation.accepted');
    expect(actions).toContain('assignment.confirmed');

    // Each step is attributed to the right kind of actor.
    const byAction = new Map(events.map((event) => [event.action, event]));
    expect(byAction.get('project.created')!.actorType).toBe('OPERATOR');
    expect(byAction.get('invitation.accepted')!.actorType).toBe('EXPERT');
    expect(byAction.get('invitation.sent')!.actorType).toBe('SYSTEM');

    // And a confirmation email was queued (simulated, never delivered).
    const confirmationEmail = await prisma.outboxMessage.findFirst({
      where: { template: 'assignment.confirmed', expertId: strong.id },
    });
    expect(confirmationEmail).not.toBeNull();
    expect(confirmationEmail!.bodyText).toContain('not delivered to any mail server');
  });

  it('records a decline, keeps the seat open, and cools the expert off', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await createProject(prisma, actor, {
      title: 'Grid modelling support',
      clientName: 'Calder Energy',
      requirements: [{ skillName: 'Energy Grid Modelling', required: true, minProficiency: 3 }],
    });
    await setProjectStatus(prisma, actor, project.id, 'MATCHING');

    const expert = await makeExpert({
      skills: [{ name: 'Energy Grid Modelling', proficiency: 4 }],
    });

    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);

    const declined = await respondToInvitation(prisma, expert.id, {
      invitationId: invitation.id,
      accept: false,
      declineReason: 'Committed elsewhere until September.',
    });
    expect(declined.status).toBe('DECLINED');
    expect(declined.declineReason).toContain('Committed elsewhere');

    // The expert stays a prospect and no seat is consumed.
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } })).status).toBe(
      'PROSPECT',
    );
    expect(
      (await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).seatsFilled,
    ).toBe(0);

    // A fresh match run now excludes them for the cool-off period.
    const rerun = await runMatching(prisma, actor, project.id, { includeExcluded: true });
    const candidate = rerun.candidates.find((c) => c.expertId === expert.id);
    expect(candidate?.excluded).toBe(true);
    expect(candidate?.exclusionReason).toContain('cool-off');
  });

  it('lets an operator return an onboarding submission and the expert resubmit', async () => {
    const operator = await makeOperator();
    const actor = actorFor(operator);
    const project = await createProject(prisma, actor, {
      title: 'Procurement review',
      clientName: 'Vantage Industrial',
      requirements: [
        { skillName: 'Procurement Transformation', required: true, minProficiency: 2 },
      ],
    });
    await setProjectStatus(prisma, actor, project.id, 'MATCHING');

    const expert = await makeExpert({
      skills: [{ name: 'Procurement Transformation', proficiency: 4 }],
    });
    const invitation = await createInvitation(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
    });
    await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

    const expertActor = { type: 'EXPERT' as const, expertId: expert.id, label: expert.fullName };
    const openCase = await getOnboardingCase(prisma, expert.id);
    await saveChecklistAnswers(
      prisma,
      expertActor,
      expert.id,
      openCase.items
        .filter((item) => item.required)
        .map((item) => ({ key: item.key, value: item.kind === 'ATTESTATION' ? 'true' : 'X' })),
    );
    await submitOnboarding(prisma, expertActor, expert.id);

    const returned = await decideVerification(prisma, actor, {
      expertId: expert.id,
      approve: false,
      note: 'Billing reference is not in our system.',
    });
    expect(returned.status).toBe('REJECTED');
    expect((await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } })).status).toBe(
      'REJECTED',
    );

    // The expert can edit and resubmit after being returned.
    await saveChecklistAnswers(prisma, expertActor, expert.id, [
      { key: 'billing_reference', value: 'SIM-BILL-0042' },
    ]);
    const resubmitted = await submitOnboarding(prisma, expertActor, expert.id);
    expect(resubmitted.status).toBe('SUBMITTED');

    const finallyVerified = await decideVerification(prisma, actor, {
      expertId: expert.id,
      approve: true,
    });
    expect(finallyVerified.status).toBe('VERIFIED');
  });
});
