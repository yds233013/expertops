import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  actorForExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import {
  confirmAssignment,
  proposeAssignment,
  releaseAssignment,
} from '@/server/services/staffing';
import { recordWithdrawal } from '@/server/services/staffing-gaps';
import { respondToInvitation, sendInvitation } from '@/server/services/invitations';
import { createInvitation } from '@/server/services/invitations';
import { runMatching } from '@/server/services/matching';
import { AppError } from '@/lib/errors';

/**
 * A seat can be vacated two ways, and the project has to hear about both.
 *
 * An expert withdrawing and an operator releasing the same seat leave the
 * project in exactly the same shape: one fewer person, one empty seat. But a
 * full project is ACTIVE, and ACTIVE is not a status in which anyone can be
 * invited or matched. If only one of the two routes reopens the project, the
 * other one leaves a vacancy that can be filled from the people who already
 * accepted and from nobody else — with no control anywhere in the interface to
 * get out of it.
 */
describe('vacating a seat on a full project', () => {
  beforeAll(async () => {
    applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function fullProject() {
    const operator = await makeOperator({ email: 'seat.release@test.local', role: 'ADMIN' });
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, {
      seatsRequested: 1,
      minYearsExperience: 0,
      status: 'STAFFING',
    });
    const expert = await makeStaffableExpert(project.id, { fullName: 'Seated Expert' });
    await prisma.availabilityWindow.create({
      data: {
        expertId: expert.id,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 86_400_000 * 60),
        hoursPerWeek: 20,
      },
    });
    const proposed = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: expert.id,
      allocationHoursPerWeek: 10,
    });
    const confirmed = await confirmAssignment(prisma, actor, proposed.id);
    expect(confirmed.projectBecameActive).toBe(true);
    const active = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(active.status).toBe('ACTIVE');
    return { actor, project, expert, assignmentId: proposed.id };
  }

  it('reopens the project when the expert withdraws', async () => {
    const { project, expert } = await fullProject();

    await recordWithdrawal(prisma, actorForExpert(expert), {
      projectId: project.id,
      expertId: expert.id,
      reason: 'Stepping off.',
    });

    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('STAFFING');
  });

  it('reopens the project when an operator releases the seat', async () => {
    const { actor, project, assignmentId } = await fullProject();

    await releaseAssignment(prisma, actor, assignmentId, 'Released by operator');

    // The seat is empty either way, so the project must be back in a status
    // that can be staffed *and* invited into. Leaving it ACTIVE strands the
    // vacancy: matching and invitations both refuse an ACTIVE project, and no
    // screen offers a way back.
    const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(after.status).toBe('STAFFING');
  });

  it('lets somebody new be invited into the seat an operator released', async () => {
    const { actor, project, assignmentId } = await fullProject();
    await releaseAssignment(prisma, actor, assignmentId, 'Released by operator');

    const replacement = await makeStaffableExpert(project.id, {
      email: 'replacement.candidate@test.local',
      fullName: 'Replacement Candidate',
    });
    // makeStaffableExpert already leaves an accepted invitation, so start from
    // a clean slate for this one: the question is whether a *new* invitation
    // can be created at all.
    await prisma.invitation.deleteMany({
      where: { projectId: project.id, expertId: replacement.id },
    });

    await expect(
      createInvitation(prisma, actor, { projectId: project.id, expertId: replacement.id }),
    ).resolves.toBeTruthy();

    // And the operator can re-run matching to find them in the first place.
    await expect(runMatching(prisma, actor, project.id, { limit: 10 })).resolves.toBeTruthy();
  });

  it('does not reopen a project that still has every seat filled', async () => {
    const operator = await makeOperator({ email: 'two.seats@test.local', role: 'ADMIN' });
    const actor = actorFor(operator);
    const project = await makeProject(operator.id, {
      seatsRequested: 2,
      minYearsExperience: 0,
      status: 'STAFFING',
    });

    const ids: string[] = [];
    for (const name of ['First Seat', 'Second Seat']) {
      const expert = await makeStaffableExpert(project.id, {
        fullName: name,
        email: `${name.toLowerCase().replace(' ', '.')}@test.local`,
      });
      await prisma.availabilityWindow.create({
        data: {
          expertId: expert.id,
          startAt: new Date(Date.now() - 86_400_000),
          endAt: new Date(Date.now() + 86_400_000 * 60),
          hoursPerWeek: 20,
        },
      });
      const proposed = await proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      });
      await confirmAssignment(prisma, actor, proposed.id);
      ids.push(proposed.id);
    }

    const active = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(active.status).toBe('ACTIVE');

    // A third person can be proposed onto a full project — proposing costs
    // nothing — but confirming them must be refused, and the project must not
    // drift out of ACTIVE on the way.
    const third = await makeStaffableExpert(project.id, {
      fullName: 'Third Seat',
      email: 'third.seat@test.local',
    });
    await prisma.availabilityWindow.create({
      data: {
        expertId: third.id,
        startAt: new Date(Date.now() - 86_400_000),
        endAt: new Date(Date.now() + 86_400_000 * 60),
        hoursPerWeek: 20,
      },
    });
    const extra = await proposeAssignment(prisma, actor, {
      projectId: project.id,
      expertId: third.id,
      allocationHoursPerWeek: 10,
    });
    await expect(confirmAssignment(prisma, actor, extra.id)).rejects.toBeInstanceOf(AppError);

    const unchanged = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(unchanged.status).toBe('ACTIVE');
    expect(ids).toHaveLength(2);

    // Releasing the unconfirmed proposal frees no seat, so nothing reopens.
    await releaseAssignment(prisma, actor, extra.id, 'Proposal withdrawn');
    const stillActive = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(stillActive.status).toBe('ACTIVE');
  });

  describe('a leftover invitee accepting', () => {
    it('leaves a full project ACTIVE at its correct headcount', async () => {
      const operator = await makeOperator({ email: 'late.accept@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        seatsRequested: 1,
        minYearsExperience: 0,
        status: 'STAFFING',
      });

      // Two people are invited for one seat, which is normal — a funnel, not a
      // mistake. One is seated; the other has not answered yet.
      const seated = await makeStaffableExpert(project.id, {
        fullName: 'Seated First',
        email: 'seated.first@test.local',
      });
      const latecomer = await makeStaffableExpert(project.id, {
        fullName: 'Answered Later',
        email: 'answered.later@test.local',
      });
      await prisma.availabilityWindow.create({
        data: {
          expertId: seated.id,
          startAt: new Date(Date.now() - 86_400_000),
          endAt: new Date(Date.now() + 86_400_000 * 60),
          hoursPerWeek: 20,
        },
      });

      const proposed = await proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: seated.id,
        allocationHoursPerWeek: 10,
      });
      await confirmAssignment(prisma, actor, proposed.id);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(
        'ACTIVE',
      );

      // The latecomer says yes. Accepting means interested, not seated.
      const invitation = await prisma.invitation.findFirstOrThrow({
        where: { projectId: project.id, expertId: latecomer.id },
      });
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'DRAFT', respondedAt: null },
      });
      await sendInvitation(prisma, actor, invitation.id);
      await respondToInvitation(prisma, latecomer.id, {
        invitationId: invitation.id,
        accept: true,
      });

      const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.seatsFilled).toBe(1);
      expect(after.seatsRequested).toBe(1);

      // Their acceptance is recorded — they are interested, and available if a
      // seat frees — but it reserved nothing.
      const accepted = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
      expect(accepted.status).toBe('ACCEPTED');
      expect(
        await prisma.assignment.count({ where: { projectId: project.id, expertId: latecomer.id } }),
      ).toBe(0);
    });

    it('still reopens a project that has a seat left', async () => {
      const operator = await makeOperator({ email: 'early.accept@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      // INVITING is where a project sits once invitations have gone out —
      // `createInvitation` moves it there, and the factory writes the row
      // directly, so the test sets it explicitly.
      const project = await makeProject(operator.id, {
        seatsRequested: 2,
        minYearsExperience: 0,
        status: 'INVITING',
      });
      const expert = await makeStaffableExpert(project.id, {
        fullName: 'First Yes',
        email: 'first.yes@test.local',
      });
      const invitation = await prisma.invitation.findFirstOrThrow({
        where: { projectId: project.id, expertId: expert.id },
      });
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: 'DRAFT', respondedAt: null },
      });
      await sendInvitation(prisma, actor, invitation.id);
      await respondToInvitation(prisma, expert.id, { invitationId: invitation.id, accept: true });

      const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(after.status).toBe('STAFFING');
    });

    it('cannot be overfilled by confirming one more than the project asked for', async () => {
      const operator = await makeOperator({ email: 'overfill@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        seatsRequested: 1,
        minYearsExperience: 0,
        status: 'STAFFING',
      });

      const ids: string[] = [];
      for (const name of ['One', 'Two']) {
        const expert = await makeStaffableExpert(project.id, {
          fullName: `Seat ${name}`,
          email: `seat.${name.toLowerCase()}@test.local`,
        });
        await prisma.availabilityWindow.create({
          data: {
            expertId: expert.id,
            startAt: new Date(Date.now() - 86_400_000),
            endAt: new Date(Date.now() + 86_400_000 * 60),
            hoursPerWeek: 20,
          },
        });
        const proposed = await proposeAssignment(prisma, actor, {
          projectId: project.id,
          expertId: expert.id,
          allocationHoursPerWeek: 10,
        });
        ids.push(proposed.id);
      }

      await confirmAssignment(prisma, actor, ids[0]!);
      await expect(confirmAssignment(prisma, actor, ids[1]!)).rejects.toBeInstanceOf(AppError);

      const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(after.status).toBe('ACTIVE');
      expect(after.seatsFilled).toBe(1);
      expect(
        await prisma.assignment.count({ where: { projectId: project.id, status: 'CONFIRMED' } }),
      ).toBe(1);
    });
  });
});
