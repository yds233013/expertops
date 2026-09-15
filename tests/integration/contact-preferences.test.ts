import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  actorFor,
  actorForExpert,
  makeExpert,
  makeOperator,
  makeProject,
  makeStaffableExpert,
} from '../helpers/factories';
import {
  mayContact,
  queueExpertMessage,
  setContactPreference,
} from '@/server/services/contact-preferences';
import {
  createInvitation,
  remindPendingInvitations,
  sendInvitation,
} from '@/server/services/invitations';
import { loadCandidatePool, runMatching } from '@/server/services/matching';
import { evaluateExclusion } from '@/server/domain/matching-engine';
import { confirmAssignment, proposeAssignment } from '@/server/services/staffing';
import { createWorkItem } from '@/server/services/work';
import { AppError } from '@/lib/errors';

/**
 * Contact preferences, and the moment they are checked.
 *
 * The interesting case is not "an opted-out expert gets no mail" — that is easy
 * to get right at any layer. It is the window between deciding to send
 * something and writing it: a reminder selected an hour ago, for somebody who
 * opted out since. The only way to honour that is to read the preference again
 * immediately before the write, and these tests are what hold that in place.
 */
describe('contact preferences', () => {
  beforeAll(() => {
    applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the rule itself', () => {
    it('treats unknown as "not asked", which is not consent to be chased', () => {
      expect(mayContact('UNKNOWN', 'OPERATIONAL')).toBe(true);
      expect(mayContact('UNKNOWN', 'REMINDER')).toBe(false);
    });

    it('lets essential-only through for things that need acting on', () => {
      expect(mayContact('EMAIL_ESSENTIAL', 'OPERATIONAL')).toBe(true);
      expect(mayContact('EMAIL_ESSENTIAL', 'REMINDER')).toBe(false);
    });

    it('sends everything to somebody who asked for everything', () => {
      expect(mayContact('EMAIL_ALL', 'OPERATIONAL')).toBe(true);
      expect(mayContact('EMAIL_ALL', 'REMINDER')).toBe(true);
    });

    it('stops both for an opt-out', () => {
      expect(mayContact('NO_CONTACT', 'OPERATIONAL')).toBe(false);
      expect(mayContact('NO_CONTACT', 'REMINDER')).toBe(false);
    });
  });

  it('starts every existing record at unknown, inferring nothing from the notes', async () => {
    const expert = await makeExpert();
    // A record carrying exactly the kind of sentence the seeded network has.
    await prisma.expert.update({
      where: { id: expert.id },
      data: { notes: 'Contact preference: prefers email, no calls before 10:00.' },
    });
    // The sentence says something. The record still says nobody asked, which is
    // the honest answer and the whole point of the default.
    const stored = await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } });
    expect(stored.notes).toContain('prefers email');
    expect(stored.contactPreference).toBe('UNKNOWN');
    expect(stored.contactPreferenceSetAt).toBeNull();
  });

  it('records who set a preference and when', async () => {
    const expert = await makeExpert();
    const updated = await setContactPreference(prisma, actorForExpert(expert), {
      expertId: expert.id,
      preference: 'EMAIL_ESSENTIAL',
      setByExpert: true,
    });
    expect(updated.contactPreference).toBe('EMAIL_ESSENTIAL');
    expect(updated.contactPreferenceSetAt).not.toBeNull();

    const event = await prisma.activityEvent.findFirst({
      where: { expertId: expert.id, action: 'expert.contact_preference_set' },
    });
    expect(event?.summary).toContain('invitations and decisions only');
  });

  it('refuses to put somebody back to "not asked"', async () => {
    const expert = await makeExpert();
    await expect(
      setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'UNKNOWN',
        setByExpert: true,
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  describe('queuing a message', () => {
    it('writes an operational message for an expert who has not been asked', async () => {
      const expert = await makeExpert();
      const result = await queueExpertMessage(prisma, {
        expertId: expert.id,
        kind: 'OPERATIONAL',
        subject: 'Something to act on',
        bodyText: 'Body',
        template: 'invitation.sent',
      });
      expect(result.queued).toBe(true);
      expect(result.skippedReason).toBeNull();
      expect(await prisma.outboxMessage.count({ where: { expertId: expert.id } })).toBe(1);
    });

    it('suppresses a reminder for the same expert, and says why', async () => {
      const expert = await makeExpert();
      const result = await queueExpertMessage(prisma, {
        expertId: expert.id,
        kind: 'REMINDER',
        subject: 'Just checking',
        bodyText: 'Body',
        template: 'invitation.reminder',
      });
      expect(result.queued).toBe(false);
      expect(result.skippedReason).toMatch(/reminders are suppressed/i);
      expect(await prisma.outboxMessage.count({ where: { expertId: expert.id } })).toBe(0);
    });

    it('writes nothing at all for an opt-out, operational or not', async () => {
      const expert = await makeExpert();
      await setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'NO_CONTACT',
        setByExpert: true,
      });

      for (const kind of ['OPERATIONAL', 'REMINDER'] as const) {
        const result = await queueExpertMessage(prisma, {
          expertId: expert.id,
          kind,
          subject: 'Anything',
          bodyText: 'Body',
          template: 'invitation.sent',
        });
        expect(result.queued).toBe(false);
        expect(result.skippedReason).toMatch(/asked not to be contacted/i);
      }
      expect(await prisma.outboxMessage.count({ where: { expertId: expert.id } })).toBe(0);
    });

    it('reads the preference at the moment of writing, not before', async () => {
      const expert = await makeExpert();
      await setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'EMAIL_ALL',
        setByExpert: true,
      });

      // Somebody loads the expert, intending to send a reminder…
      const loadedEarlier = await prisma.expert.findUniqueOrThrow({ where: { id: expert.id } });
      expect(mayContact(loadedEarlier.contactPreference, 'REMINDER')).toBe(true);

      // …and the expert opts out before the message is written.
      await setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'NO_CONTACT',
        setByExpert: true,
      });

      const result = await queueExpertMessage(prisma, {
        expertId: expert.id,
        kind: 'REMINDER',
        subject: 'Too late',
        bodyText: 'Body',
        template: 'invitation.reminder',
      });
      expect(result.queued).toBe(false);
      expect(await prisma.outboxMessage.count({ where: { expertId: expert.id } })).toBe(0);
    });
  });

  describe('matching', () => {
    it('excludes an opted-out expert with a reason an operator can read', () => {
      const base = {
        expertId: 'e1',
        status: 'VERIFIED' as const,
        yearsExperience: 10,
        hourlyRateCents: 10_000,
        timezone: 'UTC',
        weeklyCapacityHours: 20,
        skills: [{ slug: 'x', proficiency: 5, yearsUsed: 5 }],
        hasOpenInvitationForProject: false,
        isAssignedToProject: false,
        lastDeclinedAt: null,
        activeAssignmentCount: 0,
      };
      const criteria = {
        minYearsExperience: 0,
        maxHourlyRateCents: null,
        preferredTimezone: 'UTC',
        requirements: [],
        hoursPerWeekNeeded: 10,
      };

      expect(
        evaluateExclusion({ ...base, contactPreference: 'EMAIL_ALL' }, criteria, new Date()),
      ).toBeNull();
      expect(
        evaluateExclusion({ ...base, contactPreference: 'NO_CONTACT' }, criteria, new Date()),
      ).toMatch(/asked not to be contacted/i);
    });

    it('keeps them off a real ranking', async () => {
      const operator = await makeOperator({ email: 'pref.match@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        status: 'MATCHING',
        minYearsExperience: 0,
        requirements: [{ name: 'Distributed Systems', required: false }],
      });

      const skills = [{ name: 'Distributed Systems', proficiency: 4, yearsUsed: 5 }];
      const willing = await makeExpert({
        email: 'willing@test.local',
        fullName: 'Willing Expert',
        skills,
      });
      const optedOut = await makeExpert({
        email: 'quiet@test.local',
        fullName: 'Quiet Expert',
        skills,
      });
      await setContactPreference(prisma, actorForExpert(optedOut), {
        expertId: optedOut.id,
        preference: 'NO_CONTACT',
        setByExpert: true,
      });

      const pool = await loadCandidatePool(prisma, project.id);
      expect(pool.find((c) => c.expertId === optedOut.id)?.contactPreference).toBe('NO_CONTACT');

      const run = await runMatching(prisma, actor, project.id, {
        limit: 50,
        includeExcluded: true,
      });
      const rows = await prisma.matchCandidate.findMany({ where: { matchRunId: run.id } });
      const quiet = rows.find((row) => row.expertId === optedOut.id);
      expect(quiet?.excluded).toBe(true);
      expect(quiet?.exclusionReason).toMatch(/contacted/i);
      expect(rows.find((row) => row.expertId === willing.id)?.excluded).toBe(false);
    });
  });

  describe('invitation dispatch and reminders', () => {
    it('does not queue an invitation for somebody who opted out', async () => {
      const operator = await makeOperator({ email: 'pref.invite@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, { status: 'MATCHING' });
      const expert = await makeExpert({ email: 'nocontact@test.local' });
      await setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'NO_CONTACT',
        setByExpert: true,
      });

      const invitation = await createInvitation(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
      });
      const result = await sendInvitation(prisma, actor, invitation.id);

      // The invitation still moves to SENT — the record of the offer is real —
      // but no message was written for them.
      expect(result?.outboxMessageId).toBeNull();
      expect(await prisma.outboxMessage.count({ where: { expertId: expert.id } })).toBe(0);
    });

    it('suppresses a reminder without marking the invitation as chased', async () => {
      const operator = await makeOperator({ email: 'pref.remind@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, { status: 'MATCHING' });

      const chased = await makeExpert({ email: 'chase.me@test.local', fullName: 'Chase Me' });
      await setContactPreference(prisma, actorForExpert(chased), {
        expertId: chased.id,
        preference: 'EMAIL_ALL',
        setByExpert: true,
      });
      const quiet = await makeExpert({ email: 'leave.me@test.local', fullName: 'Leave Me' });
      await setContactPreference(prisma, actorForExpert(quiet), {
        expertId: quiet.id,
        preference: 'EMAIL_ESSENTIAL',
        setByExpert: true,
      });

      const sentAt = new Date(Date.now() - 48 * 3_600_000);
      for (const expert of [chased, quiet]) {
        const invitation = await createInvitation(prisma, actor, {
          projectId: project.id,
          expertId: expert.id,
        });
        await sendInvitation(prisma, actor, invitation.id);
        await prisma.invitation.update({ where: { id: invitation.id }, data: { sentAt } });
      }
      await prisma.outboxMessage.deleteMany({});

      const result = await remindPendingInvitations(prisma, { remindAfterHours: 24 });
      expect(result.remindedCount).toBe(1);
      expect(result.suppressedCount).toBe(1);

      const reminders = await prisma.outboxMessage.findMany({
        where: { template: 'invitation.reminder' },
      });
      expect(reminders).toHaveLength(1);
      expect(reminders[0]!.expertId).toBe(chased.id);

      // The suppressed one is not left looking chased, so it can be reminded
      // the moment they change their mind.
      const untouched = await prisma.invitation.findFirstOrThrow({
        where: { expertId: quiet.id },
      });
      expect(untouched.remindedAt).toBeNull();
    });
  });

  describe('assigning work', () => {
    it('queues one simulated notification, and only one', async () => {
      const operator = await makeOperator({ email: 'pref.work@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        status: 'STAFFING',
        seatsRequested: 1,
        minYearsExperience: 0,
      });
      const expert = await makeStaffableExpert(project.id, { fullName: 'Working Expert' });
      await prisma.availabilityWindow.create({
        data: {
          expertId: expert.id,
          startAt: new Date(Date.now() - 86_400_000),
          endAt: new Date(Date.now() + 86_400_000 * 30),
          hoursPerWeek: 20,
        },
      });
      const proposed = await proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      });
      await confirmAssignment(prisma, actor, proposed.id);
      await prisma.outboxMessage.deleteMany({});

      const item = await createWorkItem(prisma, actor, {
        assignmentId: proposed.id,
        title: 'Scoping note',
        instructions: 'Two pages.',
        dueAt: new Date(Date.now() + 7 * 86_400_000),
      });

      const messages = await prisma.outboxMessage.findMany({
        where: { template: 'work.assigned' },
      });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.subject).toContain(item.reference);
      expect(messages[0]!.dedupeKey).toBe(`work.assigned:${item.id}`);
      expect(messages[0]!.status).toBe('QUEUED');
      // Simulated: the body carries a portal link, and no mail server exists.
      expect(messages[0]!.devPortalUrl).toContain('/portal/enter#t=');
    });

    it('does not notify an expert who opted out, but still assigns the work', async () => {
      const operator = await makeOperator({ email: 'pref.work2@test.local', role: 'ADMIN' });
      const actor = actorFor(operator);
      const project = await makeProject(operator.id, {
        status: 'STAFFING',
        seatsRequested: 1,
        minYearsExperience: 0,
      });
      const expert = await makeStaffableExpert(project.id, { fullName: 'Quiet Worker' });
      await prisma.availabilityWindow.create({
        data: {
          expertId: expert.id,
          startAt: new Date(Date.now() - 86_400_000),
          endAt: new Date(Date.now() + 86_400_000 * 30),
          hoursPerWeek: 20,
        },
      });
      const proposed = await proposeAssignment(prisma, actor, {
        projectId: project.id,
        expertId: expert.id,
        allocationHoursPerWeek: 10,
      });
      await confirmAssignment(prisma, actor, proposed.id);
      await setContactPreference(prisma, actorForExpert(expert), {
        expertId: expert.id,
        preference: 'NO_CONTACT',
        setByExpert: true,
      });
      await prisma.outboxMessage.deleteMany({});

      const item = await createWorkItem(prisma, actor, {
        assignmentId: proposed.id,
        title: 'Still assigned',
      });

      expect(item.status).toBe('ASSIGNED');
      expect(await prisma.outboxMessage.count({ where: { template: 'work.assigned' } })).toBe(0);
      const event = await prisma.activityEvent.findFirstOrThrow({
        where: { entityId: item.id, action: 'work.assigned' },
      });
      expect((event.metadata as Record<string, unknown>).notificationSkipped).toMatch(
        /asked not to be contacted/i,
      );
    });
  });
});
