import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  actorForExpert,
  makeConfirmedAssignment,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import { runMatching, searchExpertsForProject } from '@/server/services/matching';
import { createInvitation } from '@/server/services/invitations';
import { recordWithdrawal } from '@/server/services/staffing-gaps';
import { releaseAssignment } from '@/server/services/staffing';

/**
 * The three things the 17 September 2026 acceptance run found.
 *
 * Each test is written from the operator's problem rather than the code path,
 * because each of these was invisible until somebody drove the product.
 */
describe('repairs from the hosted acceptance run', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  describe('inviting an eligible expert outside the recommendation cut-off', () => {
    it('finds them by name, email or reference, and invites without a match run row', async () => {
      const operator = await makeOperator({ email: 'repairs.invite@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        title: 'Ranked cut-off',
        status: 'MATCHING',
        seatsRequested: 1,
        minYearsExperience: 1,
        requirements: [{ name: 'Code Review', required: true, minProficiency: 3 }],
      });

      // A field of stronger candidates, and one eligible person behind them.
      // Plain experts, not `makeStaffableExpert`: that helper hands each one an
      // accepted invitation for the project, which the engine then excludes.
      for (let i = 0; i < 12; i += 1) {
        await makeExpert({
          fullName: `Ranked Person ${i}`,
          email: `ranked.${i}@example.test`,
          status: 'VERIFIED',
          yearsExperience: 20,
          hourlyRateCents: 9_000,
          skills: [{ name: 'Code Review', proficiency: 5, yearsUsed: 12 }],
        });
      }
      const outsider = await makeExpert({
        fullName: 'Quiet Newcomer',
        email: 'quiet.newcomer@example.test',
        yearsExperience: 2,
        hourlyRateCents: 24_000,
        skills: [{ name: 'Code Review', proficiency: 3, yearsUsed: 2 }],
      });

      // A run that keeps only the top three: the outsider is not on it.
      const run = await runMatching(prisma, actor, project.id, { limit: 3 });
      const persisted = run.candidates.filter((c) => !c.excluded).map((c) => c.expertId);
      expect(persisted).not.toContain(outsider.id);
      expect(persisted).toHaveLength(3);

      // The search still finds them, scored and ranked against the same brief.
      const byName = await searchExpertsForProject(prisma, project.id, { search: 'Newcomer' });
      expect(byName.map((m) => m.expertId)).toContain(outsider.id);
      const hit = byName.find((m) => m.expertId === outsider.id)!;
      expect(hit.excluded).toBe(false);
      expect(hit.inLatestRun).toBe(false);
      expect(hit.rank).toBeGreaterThan(3);
      expect(hit.score).toBeGreaterThan(0);

      expect(
        (await searchExpertsForProject(prisma, project.id, { search: outsider.reference })).map(
          (m) => m.expertId,
        ),
      ).toContain(outsider.id);
      expect(
        (await searchExpertsForProject(prisma, project.id, { search: 'quiet.newcomer@' })).map(
          (m) => m.expertId,
        ),
      ).toContain(outsider.id);

      // And they can enter the ordinary invitation workflow.
      const invitation = await createInvitation(prisma, actor, {
        projectId: project.id,
        expertId: outsider.id,
      });
      expect(invitation.status).toBe('DRAFT');
      expect(invitation.matchCandidateId).toBeNull();

      // Inviting is not staffing: no seat is taken by any of this.
      const after = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
      expect(after.seatsFilled).toBe(0);
      expect(await prisma.assignment.count({ where: { projectId: project.id } })).toBe(0);
    });

    it('explains an ineligible expert rather than offering them, and the service still refuses', async () => {
      const operator = await makeOperator({ email: 'repairs.excluded@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        title: 'Hard filter',
        status: 'MATCHING',
        seatsRequested: 1,
        minYearsExperience: 10,
        requirements: [{ name: 'Code Review', required: true, minProficiency: 4 }],
      });
      const archived = await makeExpert({
        fullName: 'Archived Person',
        email: 'archived.person@example.test',
        status: 'ARCHIVED',
        skills: [{ name: 'Code Review', proficiency: 5 }],
      });
      const tooJunior = await makeExpert({
        fullName: 'Junior Person',
        email: 'junior.person@example.test',
        yearsExperience: 1,
        skills: [{ name: 'Code Review', proficiency: 5 }],
      });

      const matches = await searchExpertsForProject(prisma, project.id, { search: 'Person' });
      // Archived people are not offered at all.
      expect(matches.map((m) => m.expertId)).not.toContain(archived.id);

      const junior = matches.find((m) => m.expertId === tooJunior.id)!;
      expect(junior.excluded).toBe(true);
      expect(junior.exclusionReason).toBeTruthy();

      // The server is the authority, not the list.
      await expect(
        createInvitation(prisma, actor, { projectId: project.id, expertId: archived.id }),
      ).rejects.toThrow(/archived/i);
    });

    it('refuses a second live invitation for the same expert', async () => {
      const operator = await makeOperator({ email: 'repairs.dupe@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        title: 'Duplicate guard',
        status: 'MATCHING',
        seatsRequested: 1,
        requirements: [{ name: 'Code Review', required: true, minProficiency: 3 }],
      });
      const expert = await makeExpert({
        fullName: 'Invited Once',
        email: 'invited.once@example.test',
        status: 'VERIFIED',
        skills: [{ name: 'Code Review', proficiency: 4, yearsUsed: 5 }],
      });

      await createInvitation(prisma, actor, { projectId: project.id, expertId: expert.id });
      await expect(
        createInvitation(prisma, actor, { projectId: project.id, expertId: expert.id }),
      ).rejects.toThrow(/already has a/i);
    });

    it('needs a real search term', async () => {
      const operator = await makeOperator({ email: 'repairs.term@test.local', role: 'ADMIN' });
      const project = await makeProject(operator.id, {
        requirements: [{ name: 'Code Review', required: true }],
      });
      expect(await searchExpertsForProject(prisma, project.id, { search: ' ' })).toEqual([]);
      expect(await searchExpertsForProject(prisma, project.id, { search: 'a' })).toEqual([]);
    });
  });

  describe('history wording for a released seat', () => {
    it('reads as a withdrawal when the expert released their own seat', async () => {
      const operator = await makeOperator({ email: 'repairs.withdrew@test.local', role: 'ADMIN' });
      const project = await makeProject(operator.id, {
        title: 'Self withdrawal',
        status: 'ACTIVE',
        seatsRequested: 1,
        requirements: [{ name: 'Code Review', required: true }],
      });
      const expert = await makeStaffableExpert(project.id, {
        fullName: 'Robin Ash',
        email: 'robin.ash@example.test',
      });
      await makeConfirmedAssignment(project.id, expert.id);

      await recordWithdrawal(prisma, actorForExpert(expert), {
        expertId: expert.id,
        projectId: project.id,
        reason: 'A deadline moved.',
      });

      const released = await prisma.activityEvent.findFirstOrThrow({
        where: { action: 'assignment.released', projectId: project.id },
      });
      expect(released.summary).toContain('Robin Ash withdrew from');
      expect(released.summary).not.toMatch(/Robin Ash released Robin Ash/);
      expect((released.metadata as { selfInitiated?: boolean }).selfInitiated).toBe(true);

      // The dedicated withdrawal record is unchanged.
      const withdrew = await prisma.activityEvent.findFirstOrThrow({
        where: { action: 'assignment.expert_withdrew', projectId: project.id },
      });
      expect(withdrew.summary).toBe(`Robin Ash withdrew from ${project.code}`);
    });

    it('still names the operator when an operator releases somebody', async () => {
      const operator = await makeOperator({ email: 'repairs.release@test.local', role: 'ADMIN' });
      const project = await makeProject(operator.id, {
        title: 'Operator release',
        status: 'ACTIVE',
        seatsRequested: 1,
        requirements: [{ name: 'Code Review', required: true }],
      });
      const expert = await makeStaffableExpert(project.id, {
        fullName: 'Sam Reed',
        email: 'sam.reed@example.test',
      });
      const assignment = await makeConfirmedAssignment(project.id, expert.id);

      await releaseAssignment(prisma, actorFor(operator), assignment.id, 'Client paused the work.');

      const released = await prisma.activityEvent.findFirstOrThrow({
        where: { action: 'assignment.released', projectId: project.id },
      });
      expect(released.summary).toContain(operator.name);
      expect(released.summary).toContain('released Sam Reed from');
      expect((released.metadata as { selfInitiated?: boolean }).selfInitiated).toBe(false);
    });
  });
});
