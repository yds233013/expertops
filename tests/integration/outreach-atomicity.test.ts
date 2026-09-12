import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import {
  createBatch,
  decideBatch,
  dispatchBatch,
  submitBatchForApproval,
} from '@/server/services/outreach';

/**
 * Outreach: state, audit and dispatch progress.
 *
 * Two defects are covered here.
 *
 * The first is atomicity. Each operation wrote its business state and its
 * activity entry as separate statements, so a failure in between left a batch
 * that had moved with no record of who moved it or why. Faults are injected
 * with a temporary database constraint, which is the only way to make the
 * second write fail for real rather than by mocking it away.
 *
 * The second is dispatch. Any error at all was written into `skippedReason` and
 * the recipient was dropped permanently — so a transient fault became a
 * permanent eligibility exclusion — and the batch was then marked DISPATCHED
 * regardless, hiding the fact that recipients had been lost.
 */

/** Make writes to a table fail, for the duration of `fn`. */
async function withBrokenTable<T>(table: string, check: string, fn: () => Promise<T>): Promise<T> {
  const name = `tmp_break_${table.toLowerCase()}`;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD CONSTRAINT ${name} CHECK (${check})`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT ${name}`);
  }
}

async function fixture(seats = 5) {
  const operator = await makeOperator({ role: 'ADMIN' });
  const approver = await makeOperator({ role: 'ADMIN' });
  const project = await makeProject(operator.id, { status: 'MATCHING', seatsRequested: seats });
  const experts = await Promise.all([makeExpert(), makeExpert(), makeExpert()]);
  return { operator, approver, project, experts };
}

describe('outreach atomicity and dispatch progress', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('rolls the batch back when its audit entry cannot be written', async () => {
    const { operator, project, experts } = await fixture();

    await expect(
      withBrokenTable('ActivityEvent', "action <> 'outreach.batch_created'", () =>
        createBatch(prisma, actorFor(operator), {
          kind: 'PROJECT_INVITATION',
          projectId: project.id,
          items: experts.map((expert) => ({ expertId: expert.id })),
        }),
      ),
    ).rejects.toThrow();

    // Neither the batch nor its items survived: an unaccountable batch is worse
    // than no batch.
    expect(await prisma.outreachBatch.count()).toBe(0);
    expect(await prisma.outreachBatchItem.count()).toBe(0);
  });

  it('rolls the submission back when its audit entry cannot be written', async () => {
    const { operator, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });

    await expect(
      withBrokenTable('ActivityEvent', "action <> 'outreach.batch_submitted'", () =>
        submitBatchForApproval(prisma, actorFor(operator), batch.id),
      ),
    ).rejects.toThrow();

    const after = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe('DRAFT');

    // And retrying once the fault clears works, leaving one audit entry.
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    expect((await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'PENDING_APPROVAL',
    );
    expect(
      await prisma.activityEvent.count({ where: { action: 'outreach.batch_submitted' } }),
    ).toBe(1);
  });

  it('rolls an approval back when its audit entry cannot be written', async () => {
    const { operator, approver, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);

    await expect(
      withBrokenTable('ActivityEvent', "action <> 'outreach.batch_approved'", () =>
        decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true }),
      ),
    ).rejects.toThrow();

    // An approval with no record of who gave it must not exist.
    const after = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe('PENDING_APPROVAL');
    expect(after.approvedById).toBeNull();
    expect(after.approvedAt).toBeNull();
  });

  it('keeps a transient failure retryable instead of excluding the recipient', async () => {
    const { operator, approver, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });

    // Infrastructure fails for every recipient.
    const result = await withBrokenTable('Invitation', 'false', () =>
      dispatchBatch(prisma, actorFor(approver), batch.id),
    );

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.failed).toHaveLength(3);
    expect(result.complete).toBe(false);

    // The batch is not finished, and says so.
    const after = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.status).toBe('PARTIALLY_DISPATCHED');
    expect(after.dispatchedAt).toBeNull();

    const items = await prisma.outreachBatchItem.findMany({ where: { batchId: batch.id } });
    expect(items.every((item) => item.dispatchState === 'FAILED')).toBe(true);
    expect(items.every((item) => item.skippedReason === null)).toBe(true);
    expect(items.every((item) => (item.lastError ?? '').length > 0)).toBe(true);

    // Retrying once the fault clears invites everyone, exactly once.
    const retry = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(retry.dispatched).toBe(3);
    expect(retry.complete).toBe(true);
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(3);

    const settled = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(settled.status).toBe('DISPATCHED');
    expect(settled.dispatchedAt).not.toBeNull();
  });

  it('excludes a recipient a business rule refused, and does not retry them', async () => {
    const { operator, approver, project, experts } = await fixture();
    // One expert is archived, so the invitation service will refuse them.
    await prisma.expert.update({ where: { id: experts[0]!.id }, data: { status: 'ARCHIVED' } });

    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });

    const result = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(result.dispatched).toBe(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.complete).toBe(true);

    const refused = await prisma.outreachBatchItem.findFirstOrThrow({
      where: { batchId: batch.id, expertId: experts[0]!.id },
    });
    expect(refused.dispatchState).toBe('SKIPPED');
    expect(refused.skippedReason).toMatch(/archived/i);

    // A permanent exclusion is not reconsidered on a second dispatch.
    const again = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(again.dispatched).toBe(0);
    expect(again.alreadySent).toBe(2);
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(2);
  });

  it('does not invite anyone twice when dispatch is repeated', async () => {
    const { operator, approver, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });

    await dispatchBatch(prisma, actorFor(approver), batch.id);
    const repeated = await dispatchBatch(prisma, actorFor(approver), batch.id);
    const concurrent = await Promise.all([
      dispatchBatch(prisma, actorFor(approver), batch.id),
      dispatchBatch(prisma, actorFor(approver), batch.id),
    ]);

    expect(repeated.dispatched).toBe(0);
    expect(concurrent.every((result) => result.dispatched === 0)).toBe(true);
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(3);
    expect(await prisma.activityEvent.count({ where: { action: 'invitation.created' } })).toBe(3);
  });

  it('records each invitation with its audit entry, or neither', async () => {
    const { operator, approver, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });
    await submitBatchForApproval(prisma, actorFor(operator), batch.id);
    await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });

    // The invitation insert succeeds but its activity entry cannot be written.
    const result = await withBrokenTable('ActivityEvent', "action <> 'invitation.created'", () =>
      dispatchBatch(prisma, actorFor(approver), batch.id),
    );

    expect(result.dispatched).toBe(0);
    expect(result.failed).toHaveLength(3);
    // No orphaned invitations: each one rolled back with its audit entry.
    expect(await prisma.invitation.count()).toBe(0);
    // And the attempt is recorded on each recipient, so the retry is informed.
    const items = await prisma.outreachBatchItem.findMany({ where: { batchId: batch.id } });
    expect(items.every((item) => item.attempts === 1)).toBe(true);
  });

  it('refuses to dispatch a batch nobody approved', async () => {
    const { operator, project, experts } = await fixture();
    const batch = await createBatch(prisma, actorFor(operator), {
      kind: 'PROJECT_INVITATION',
      projectId: project.id,
      items: experts.map((expert) => ({ expertId: expert.id })),
    });

    await expect(dispatchBatch(prisma, actorFor(operator), batch.id)).rejects.toThrow(
      /Only an approved batch can be dispatched/,
    );
    expect(await prisma.invitation.count()).toBe(0);
  });
});
