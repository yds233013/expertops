import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { applyMigrations, newClient, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import {
  createBatch,
  decideBatch,
  dispatchBatch,
  recipientTotals,
  recordDispatchFailure,
  submitBatchForApproval,
} from '@/server/services/outreach';
import { AppError } from '@/lib/errors';

/**
 * Two dispatch requests overlapping on the same batch.
 *
 * Three defects are covered here, all reproduced before they were repaired:
 *
 *  * A recipient transaction that returned early because another request had
 *    already settled the row still incremented the caller's `dispatched` count.
 *    Two overlapping requests on a batch of three both reported three, so six
 *    invitations were claimed where three existed.
 *  * Failure recording updated the recipient unconditionally, outside the
 *    transaction that had just rolled back. A request that failed slowly could
 *    overwrite a recipient another request had since marked SENT, leaving a
 *    person who *was* invited reading FAILED.
 *  * The batch's final status came from the request's own tally rather than
 *    from the recipient rows, so it described what one caller saw rather than
 *    what the database held.
 *
 * Genuine separate connections, so the races are real.
 */
const clients: PrismaClient[] = [];
function client(): PrismaClient {
  const created = newClient();
  clients.push(created);
  return created;
}

/** Make writes to a table fail for the duration of `fn`. */
async function withBrokenTable<T>(table: string, check: string, fn: () => Promise<T>): Promise<T> {
  const name = `tmp_break_${table.toLowerCase()}`;
  await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD CONSTRAINT ${name} CHECK (${check})`);
  try {
    return await fn();
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DROP CONSTRAINT ${name}`);
  }
}

async function approvedBatch(recipients = 3) {
  const operator = await makeOperator({ role: 'ADMIN' });
  const approver = await makeOperator({ role: 'ADMIN' });
  const project = await makeProject(operator.id, { status: 'MATCHING', seatsRequested: 10 });
  const experts = [];
  for (let index = 0; index < recipients; index += 1) experts.push(await makeExpert());

  const batch = await createBatch(prisma, actorFor(operator), {
    kind: 'PROJECT_INVITATION',
    projectId: project.id,
    items: experts.map((expert) => ({ expertId: expert.id })),
  });
  await submitBatchForApproval(prisma, actorFor(operator), batch.id);
  await decideBatch(prisma, actorFor(approver), { batchId: batch.id, approve: true });
  return { operator, approver, project, experts, batch };
}

describe('overlapping outreach dispatch', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect().catch(() => undefined)));
  });

  it('counts only the work each request actually committed', async () => {
    const { approver, project, batch } = await approvedBatch(3);

    const [first, second] = await Promise.all([
      dispatchBatch(client(), actorFor(approver), batch.id),
      dispatchBatch(client(), actorFor(approver), batch.id),
    ]);

    const invitations = await prisma.invitation.count({ where: { projectId: project.id } });
    expect(invitations).toBe(3);

    // The reported totals add up to what was actually created: no request
    // claims credit for work the other committed.
    expect(first.dispatched + second.dispatched).toBe(invitations);
    // And whatever one request did not do, it reports as taken rather than done.
    expect(first.dispatched + first.takenByAnotherRequest).toBe(3);
    expect(second.dispatched + second.takenByAnotherRequest).toBe(3);

    // Both see the same authoritative picture of the batch.
    expect(first.totals).toEqual({ sent: 3, skipped: 0, failed: 0, pending: 0 });
    expect(second.totals).toEqual(first.totals);
  });

  it('does not let a stale failure overwrite a recipient another request sent', async () => {
    const { approver, project, batch } = await approvedBatch(2);

    // One request succeeds while the other has its invitation writes broken.
    // Whichever order they interleave in, the invariants below must hold.
    const [ok, broken] = await Promise.all([
      dispatchBatch(client(), actorFor(approver), batch.id),
      withBrokenTable('Invitation', 'false', () =>
        dispatchBatch(client(), actorFor(approver), batch.id),
      ),
    ]);

    const items = await prisma.outreachBatchItem.findMany({ where: { batchId: batch.id } });
    const invitations = await prisma.invitation.count({ where: { projectId: project.id } });

    // A recipient holding an invitation is SENT. Nothing overwrote a success.
    for (const item of items) {
      if (item.invitationId) {
        expect(
          item.dispatchState,
          `${item.id} holds an invitation but reads ${item.dispatchState}`,
        ).toBe('SENT');
        expect(item.lastError).toBeNull();
        expect(item.skippedReason).toBeNull();
      }
    }
    expect(items.filter((item) => item.dispatchState === 'SENT')).toHaveLength(invitations);

    // An infrastructure fault never turns into a permanent exclusion.
    expect(items.some((item) => item.skippedReason !== null)).toBe(false);

    // Counts still add up to committed work.
    expect(ok.dispatched + broken.dispatched).toBe(invitations);

    // Whatever is left outstanding is retryable, and a later dispatch finishes it.
    const settled = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(settled.complete).toBe(true);
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(2);
    expect((await recipientTotals(prisma, batch.id)).sent).toBe(2);
  });

  it('refuses a stale failure against a recipient already marked sent', async () => {
    // The guard on its own, deterministically: the compare-and-set is what
    // stops a request that rolled back from trampling a committed success.
    const { approver, batch } = await approvedBatch(1);
    await dispatchBatch(prisma, actorFor(approver), batch.id);

    const item = await prisma.outreachBatchItem.findFirstOrThrow({ where: { batchId: batch.id } });
    expect(item.dispatchState).toBe('SENT');

    const infra = await recordDispatchFailure(prisma, item.id, new Error('connection reset'));
    const business = await recordDispatchFailure(
      prisma,
      item.id,
      new AppError('INVALID_STATE', 'is archived'),
    );

    expect(infra).toBe('taken');
    expect(business).toBe('taken');

    const after = await prisma.outreachBatchItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.dispatchState).toBe('SENT');
    expect(after.invitationId).toBe(item.invitationId);
    expect(after.lastError).toBeNull();
    expect(after.skippedReason).toBeNull();
    expect(after.attempts).toBe(item.attempts);
  });

  it('still distinguishes an eligibility refusal from an infrastructure fault', async () => {
    const { batch } = await approvedBatch(1);
    const item = await prisma.outreachBatchItem.findFirstOrThrow({ where: { batchId: batch.id } });

    expect(await recordDispatchFailure(prisma, item.id, new Error('socket hang up'))).toBe(
      'failed',
    );
    let row = await prisma.outreachBatchItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.dispatchState).toBe('FAILED');
    expect(row.lastError).toMatch(/socket hang up/);
    expect(row.skippedReason).toBeNull();

    // A FAILED row is still retryable, so the domain refusal can land on it.
    expect(
      await recordDispatchFailure(prisma, item.id, new AppError('INVALID_STATE', 'is archived')),
    ).toBe('skipped');
    row = await prisma.outreachBatchItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.dispatchState).toBe('SKIPPED');
    expect(row.skippedReason).toMatch(/is archived/);
    expect(row.lastError).toBeNull();
  });

  it('derives the batch status from the recipient rows, not the caller tally', async () => {
    const { approver, batch } = await approvedBatch(3);

    // Everything fails: the batch is not finished, and says so.
    await withBrokenTable('Invitation', 'false', () =>
      dispatchBatch(prisma, actorFor(approver), batch.id),
    );
    let row = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(row.status).toBe('PARTIALLY_DISPATCHED');
    expect(row.dispatchedAt).toBeNull();

    // Settle two recipients out of band, as another request would have. This
    // request's own loop sees only the third, but the status must reflect all
    // three rows as the database now holds them.
    const items = await prisma.outreachBatchItem.findMany({ where: { batchId: batch.id } });
    await prisma.outreachBatchItem.update({
      where: { id: items[0]!.id },
      data: { dispatchState: 'SKIPPED', skippedReason: 'archived', lastError: null },
    });

    const result = await dispatchBatch(prisma, actorFor(approver), batch.id);
    expect(result.dispatched).toBe(2);
    expect(result.totals).toEqual({ sent: 2, skipped: 1, failed: 0, pending: 0 });
    expect(result.complete).toBe(true);

    row = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(row.status).toBe('DISPATCHED');
    expect(row.dispatchedAt).not.toBeNull();
  });

  it('is safe to repeat, concurrently, on a finished batch', async () => {
    const { approver, project, batch } = await approvedBatch(2);
    await dispatchBatch(prisma, actorFor(approver), batch.id);

    const repeats = await Promise.all([
      dispatchBatch(client(), actorFor(approver), batch.id),
      dispatchBatch(client(), actorFor(approver), batch.id),
      dispatchBatch(client(), actorFor(approver), batch.id),
    ]);

    for (const result of repeats) {
      expect(result.dispatched).toBe(0);
      expect(result.takenByAnotherRequest).toBe(0);
      expect(result.alreadySent).toBe(2);
      expect(result.totals.sent).toBe(2);
      expect(result.complete).toBe(true);
    }
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(2);
    expect(await prisma.activityEvent.count({ where: { action: 'invitation.created' } })).toBe(2);
  });
});

/**
 * Finalisation while another request is finishing the same batch.
 *
 * The totals that decide a batch's final status used to be read *before* the
 * transaction that wrote that status opened. A second request could complete
 * the outstanding recipients and finalise the batch inside that gap, and the
 * first request would arrive holding numbers that were already history: it
 * tried to move a DISPATCHED batch back to PARTIALLY_DISPATCHED, which the
 * transition table refuses, so a request whose own work had entirely succeeded
 * failed with an error about a state it had not caused.
 *
 * The interleaving is forced with promise gates rather than sleeps, so the test
 * asserts an ordering rather than hoping for one.
 */
describe('batch finalisation under a concurrent finish', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  /** A promise plus the function that settles it. */
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { opened, open };
  }

  it('lets both requests finish, with a status that matches the recipients', async () => {
    const { approver, project, experts, batch } = await approvedBatch(2);
    const blocked = experts[0]!;

    // One recipient cannot be invited yet. Request A will therefore leave the
    // batch incomplete and compute totals that say so.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Invitation" ADD CONSTRAINT tmp_block_one_expert CHECK ("expertId" <> '${blocked.id}')`,
    );

    const reachedFinalisation = gate();
    const bHasFinished = gate();

    // Request A: invites the other recipient, fails on the blocked one, then
    // stops at the point where it would finalise.
    const requestA = dispatchBatch(client(), actorFor(approver), batch.id, {
      onBeforeFinalize: async () => {
        reachedFinalisation.open();
        await bHasFinished.opened;
      },
    });

    await reachedFinalisation.opened;

    // A is now holding totals that read "one sent, one still to retry". While it
    // waits, the obstruction clears and request B finishes the batch.
    expect((await recipientTotals(prisma, batch.id)).failed).toBe(1);
    await prisma.$executeRawUnsafe('ALTER TABLE "Invitation" DROP CONSTRAINT tmp_block_one_expert');

    const resultB = await dispatchBatch(client(), actorFor(approver), batch.id);
    expect(resultB.dispatched).toBe(1);
    expect(resultB.complete).toBe(true);
    expect((await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } })).status).toBe(
      'DISPATCHED',
    );

    // Resume A. Before the repair this threw INVALID_STATE: A tried to move a
    // DISPATCHED batch back to PARTIALLY_DISPATCHED on the strength of totals
    // read before B existed.
    bHasFinished.open();
    const resultA = await requestA;

    // Both requests finished, and both report the batch as it actually stands.
    expect(resultA.dispatched).toBe(1);
    expect(resultA.complete).toBe(true);
    expect(resultA.totals).toEqual(resultB.totals);

    // The final status agrees with the recipient rows.
    const totals = await recipientTotals(prisma, batch.id);
    const finalBatch = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(totals).toEqual({ sent: 2, skipped: 0, failed: 0, pending: 0 });
    expect(finalBatch.status).toBe('DISPATCHED');
    expect(finalBatch.dispatchedAt).not.toBeNull();

    // Nobody was invited twice.
    expect(await prisma.invitation.count({ where: { projectId: project.id } })).toBe(2);
    expect(await prisma.activityEvent.count({ where: { action: 'invitation.created' } })).toBe(2);

    // Exactly one transition event says the batch was dispatched; a second
    // would claim a change that never happened.
    expect(
      await prisma.activityEvent.count({ where: { action: 'outreach.batch_dispatched' } }),
    ).toBe(1);

    // And no transition event contradicts the state the batch ended in: every
    // "partly dispatched" entry was written before the batch completed.
    const dispatchedAt = (
      await prisma.activityEvent.findFirstOrThrow({
        where: { action: 'outreach.batch_dispatched' },
      })
    ).createdAt.getTime();
    const partials = await prisma.activityEvent.findMany({
      where: { action: 'outreach.batch_partially_dispatched' },
    });
    for (const event of partials) {
      expect(event.createdAt.getTime()).toBeLessThanOrEqual(dispatchedAt);
    }
  });

  it('reports the same authoritative totals to the request that was held', async () => {
    const { approver, batch } = await approvedBatch(3);

    const reached = gate();
    const released = gate();

    const held = dispatchBatch(client(), actorFor(approver), batch.id, {
      onBeforeFinalize: async () => {
        reached.open();
        await released.opened;
      },
    });
    await reached.opened;

    // While A is held, mark one recipient as permanently refused, exactly as an
    // overlapping request recording an eligibility refusal would.
    const item = await prisma.outreachBatchItem.findFirstOrThrow({
      where: { batchId: batch.id },
      orderBy: { id: 'asc' },
    });
    await prisma.outreachBatchItem.update({
      where: { id: item.id },
      data: { dispatchState: 'SKIPPED', skippedReason: 'archived', invitationId: null },
    });

    released.open();
    const result = await held;

    // A reports what the database holds now, not what it saw before the pause.
    expect(result.totals.skipped).toBe(1);
    expect(result.totals.sent).toBe(2);
    expect(result.complete).toBe(true);

    const stored = await prisma.outreachBatch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(stored.status).toBe('DISPATCHED');

    // The audit entry carries the fresh figures too.
    const event = await prisma.activityEvent.findFirstOrThrow({
      where: { action: 'outreach.batch_dispatched' },
    });
    expect(event.metadata).toMatchObject({ totals: { sent: 2, skipped: 1 } });
  });
});
