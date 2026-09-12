import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { enqueueJob, pruneFinishedJobs, retentionSummary } from '@/server/services/jobs';
import { Worker } from '@/server/worker/runner';
import {
  createInvitation,
  respondToInvitation,
  sendInvitation,
} from '@/server/services/invitations';
import { SYSTEM_ACTOR } from '@/server/services/activity';
import { tokenFromMagicLink } from '../helpers/api';
import { redeemPortalToken } from '@/server/services/portal-access';

/**
 * Deduplication keys outlive the history they were attached to.
 *
 * The defect: `pruneFinishedJobs` deleted any old SUCCEEDED or CANCELLED job,
 * which freed its `dedupeKey` along with it. For a key that identifies a
 * business event rather than a scheduler tick — `onboarding.start:<invitationId>`
 * — that key *is* the record that the event already happened. Freeing it re-arms
 * the effect: the handler issues a fresh portal token and queues another
 * onboarding email every time it runs.
 *
 * Scope is now explicit on the row and never inferred from the shape of the key.
 */
describe('deduplication key retention', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  const longAgo = () => new Date(Date.now() - 30 * 86_400_000);
  const cutoff = () => new Date(Date.now() - 7 * 86_400_000);

  it('prunes disposable scheduler history', async () => {
    for (let tick = 0; tick < 3; tick += 1) {
      const { job } = await enqueueJob(prisma, {
        type: 'outbox.dispatch',
        dedupeKey: `schedule:outbox-dispatch:${1_700_000_000 + tick}`,
        dedupeScope: 'DISPOSABLE',
      });
      await prisma.job.update({
        where: { id: job!.id },
        data: { status: 'SUCCEEDED', finishedAt: longAgo() },
      });
    }
    // A job with no key at all holds nothing worth keeping either.
    const { job: keyless } = await enqueueJob(prisma, { type: 'outbox.dispatch' });
    await prisma.job.update({
      where: { id: keyless!.id },
      data: { status: 'SUCCEEDED', finishedAt: longAgo() },
    });

    expect(await pruneFinishedJobs(prisma, cutoff())).toBe(4);
    expect(await prisma.job.count()).toBe(0);
  });

  it('keeps failures and dead letters visible however old they are', async () => {
    await prisma.job.createMany({
      data: [
        { type: 'outbox.dispatch', status: 'FAILED', finishedAt: longAgo(), lastError: 'reset' },
        { type: 'outbox.dispatch', status: 'DEAD', finishedAt: longAgo(), lastError: 'gave up' },
      ],
    });

    expect(await pruneFinishedJobs(prisma, cutoff())).toBe(0);
    const remaining = await prisma.job.findMany({ orderBy: { status: 'asc' } });
    expect(remaining.map((job) => job.status).sort()).toEqual(['DEAD', 'FAILED']);
    expect(remaining.every((job) => (job.lastError ?? '').length > 0)).toBe(true);
  });

  it('keeps a business-event key after its history would have aged out', async () => {
    const key = 'onboarding.start:inv-0001';
    const { job } = await enqueueJob(prisma, { type: 'onboarding.start', dedupeKey: key });
    await prisma.job.update({
      where: { id: job!.id },
      data: { status: 'SUCCEEDED', finishedAt: longAgo() },
    });

    // Nothing is pruned: the row carries a key that says the event happened.
    expect(await pruneFinishedJobs(prisma, cutoff())).toBe(0);
    expect(await prisma.job.count({ where: { dedupeKey: key } })).toBe(1);

    // And the guarantee still holds: a replay is refused, not re-queued.
    const replay = await enqueueJob(prisma, { type: 'onboarding.start', dedupeKey: key });
    expect(replay.deduplicated).toBe(true);
    expect(replay.job!.id).toBe(job!.id);
    expect(await prisma.job.count({ where: { dedupeKey: key } })).toBe(1);
  });

  it('defaults an unmarked key to durable, so forgetting retains rather than deletes', async () => {
    const { job } = await enqueueJob(prisma, {
      type: 'payment.draft_from_approved_work',
      dedupeKey: 'payment.draft:review-0001',
    });
    expect(job!.dedupeScope).toBe('DURABLE');

    await prisma.job.update({
      where: { id: job!.id },
      data: { status: 'SUCCEEDED', finishedAt: longAgo() },
    });
    expect(await pruneFinishedJobs(prisma, cutoff())).toBe(0);
  });

  it('does not repeat the business effects when the event is replayed after a sweep', async () => {
    // A real onboarding start: accepting an invitation enqueues it.
    const operator = await makeOperator();
    const project = await makeProject(operator.id, { status: 'MATCHING' });
    const expert = await makeExpert();
    const invitation = await createInvitation(prisma, actorFor(operator), {
      projectId: project.id,
      expertId: expert.id,
    });
    const sent = await sendInvitation(prisma, SYSTEM_ACTOR, invitation.id);
    const session = await redeemPortalToken(prisma, tokenFromMagicLink(sent!.portalUrl));
    await respondToInvitation(prisma, session.expert.id, {
      invitationId: invitation.id,
      accept: true,
    });

    const worker = new Worker({ client: prisma, name: 'dedupe-test', batchSize: 10 });
    for (let pass = 0; pass < 4; pass += 1) await worker.tick();

    const key = `onboarding.start:${invitation.id}`;
    const onboardingJob = await prisma.job.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(onboardingJob.status).toBe('SUCCEEDED');

    // What the handler produced, once.
    const emailsBefore = await prisma.outboxMessage.count({
      where: { template: 'onboarding.start' },
    });
    const tokensBefore = await prisma.expertPortalToken.count({
      where: { expertId: expert.id, purpose: 'ONBOARDING' },
    });
    expect(emailsBefore).toBe(1);
    expect(tokensBefore).toBe(1);

    // Age the whole queue and run the real maintenance sweep, not a helper.
    await prisma.job.updateMany({
      where: { status: 'SUCCEEDED' },
      data: { finishedAt: longAgo() },
    });
    await enqueueJob(prisma, {
      type: 'maintenance.sweep',
      payload: { pruneJobsOlderThanDays: 7 },
    });
    await worker.tick();

    // The business-event row survived the sweep.
    expect(await prisma.job.count({ where: { dedupeKey: key } })).toBe(1);

    // Replaying the event enqueues nothing, so the worker has nothing to run
    // and no second email or second live magic link is produced.
    const replay = await enqueueJob(prisma, {
      type: 'onboarding.start',
      payload: { expertId: expert.id },
      dedupeKey: key,
    });
    expect(replay.deduplicated).toBe(true);
    for (let pass = 0; pass < 3; pass += 1) await worker.tick();

    expect(await prisma.outboxMessage.count({ where: { template: 'onboarding.start' } })).toBe(
      emailsBefore,
    );
    expect(
      await prisma.expertPortalToken.count({
        where: { expertId: expert.id, purpose: 'ONBOARDING' },
      }),
    ).toBe(tokensBefore);
  });

  it('reports what is retained and why', async () => {
    const { job: disposable } = await enqueueJob(prisma, {
      type: 'outbox.dispatch',
      dedupeKey: 'schedule:outbox-dispatch:1700000001',
      dedupeScope: 'DISPOSABLE',
    });
    const { job: durable } = await enqueueJob(prisma, {
      type: 'onboarding.start',
      dedupeKey: 'onboarding.start:inv-9',
    });
    await prisma.job.updateMany({
      where: { id: { in: [disposable!.id, durable!.id] } },
      data: { status: 'SUCCEEDED', finishedAt: longAgo() },
    });
    await prisma.job.create({
      data: { type: 'outbox.dispatch', status: 'DEAD', finishedAt: longAgo() },
    });

    expect(await retentionSummary(prisma)).toEqual({
      prunable: 1,
      retainedForDedupe: 1,
      failures: 1,
    });
  });
});
