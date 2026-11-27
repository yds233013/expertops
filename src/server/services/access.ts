import {
  Prisma,
  type AccessGrant,
  type AccessGrantStatus,
  type AccessSystem,
  type ProjectAccessResource,
} from '@prisma/client';
import { type Db } from '@/lib/db';
import { now as clockNow } from '@/lib/clock';
import { badRequest, invalidState, notFound } from '@/lib/errors';
import {
  accessProviders,
  GITHUB_PERMISSIONS,
  GITHUB_REPO_PATTERN,
  GITHUB_USERNAME_PATTERN,
  SLACK_CHANNEL_PATTERN,
  type AccessProviders,
} from '@/server/integrations/access-providers';
import { type Actor, recordActivity, SYSTEM_ACTOR } from './activity';
import { raiseAttention, resolveIfPresent } from './attention';

/**
 * Access to client systems: GitHub repositories and Slack channels.
 *
 * ## The rule
 *
 * An expert should have access to a project's resources exactly while they
 * hold a CONFIRMED seat on a project that is not CLOSED or CANCELLED, and are
 * VERIFIED. Nothing else grants access, and losing any of those removes it.
 *
 * ## How it is enforced
 *
 * By reconciliation, not by events. `reconcileAccess` runs every minute (and
 * straight after a staffing change). It works out who should have what,
 * compares that with the grant rows, moves rows to PENDING or REVOKING, and
 * then performs the pending calls. A missed trigger therefore costs at most a
 * minute, and a crash halfway through is finished by the next run.
 *
 * ## Why a revoke cannot be lost or reordered
 *
 * Each grant row is locked (`FOR UPDATE SKIP LOCKED`) for the duration of its
 * provider call, inside the job's transaction. A planner that wants to flip
 * that row to REVOKING waits for the lock, so a grant call can never land
 * after the revoke that should have followed it. If the transaction rolls back
 * after a call succeeded, the row is still PENDING or REVOKING and the next
 * run repeats a call that is idempotent at the provider.
 */

const OPEN_FOR_ACCESS: Prisma.ProjectWhereInput = { status: { notIn: ['CLOSED', 'CANCELLED'] } };
export const MAX_ACCESS_ATTEMPTS = 5;
/** Calls per run, and the wall-clock budget for them, under the worker lease. */
const CALLS_PER_RUN = 10;
const RUN_BUDGET_MS = 60_000;
const INVITATION_RECHECK_MS = 6 * 3_600_000;

const LIVE_STATES: AccessGrantStatus[] = [
  'PENDING',
  'ACTIVE',
  'REVOKING',
  'GRANT_FAILED',
  'REVOKE_FAILED',
];

function grantAttentionKey(grantId: string) {
  return `access:grant:${grantId}`;
}
function revokeAttentionKey(grantId: string) {
  return `access:revoke:${grantId}`;
}

/**
 * Queue a reconcile now, coalesced per second; the minute schedule backs it up.
 *
 * Written as ON CONFLICT DO NOTHING rather than through `enqueueJob`, because
 * callers are often inside a transaction (releasing a seat), and a unique
 * violation there would abort the caller's whole transaction, not just this
 * insert.
 */
export async function triggerAccessReconcile(db: Db, at: Date = clockNow()) {
  await db.job.createMany({
    data: [
      {
        type: 'access.reconcile',
        payload: {},
        runAt: at,
        priority: 20,
        maxAttempts: 5,
        dedupeKey: `access.reconcile:${Math.floor(at.getTime() / 1000)}`,
        dedupeScope: 'DISPOSABLE',
        status: 'PENDING',
      },
    ],
    skipDuplicates: true,
  });
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface AddResourceInput {
  projectId: string;
  system: AccessSystem;
  resource: string;
  label?: string;
  permission?: string;
}

/** HUMAN ACTION. Add a repository or channel that experts on this project need. */
export async function addAccessResource(db: Db, actor: Actor, input: AddResourceInput) {
  const project = await db.project.findUnique({ where: { id: input.projectId } });
  if (!project) throw notFound('Project not found.');

  const resource = input.resource.trim();
  let permission = 'push';
  if (input.system === 'GITHUB') {
    const normalised = resource
      .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '');
    if (!GITHUB_REPO_PATTERN.test(normalised)) {
      throw badRequest('Enter the repository as owner/name, for example acme/eval-harness.');
    }
    permission = input.permission ?? 'push';
    if (!(GITHUB_PERMISSIONS as readonly string[]).includes(permission)) {
      throw badRequest(`Permission must be one of ${GITHUB_PERMISSIONS.join(', ')}.`);
    }
    return saveResource(db, actor, project, {
      ...input,
      resource: normalised.toLowerCase(),
      permission,
    });
  }
  if (!SLACK_CHANNEL_PATTERN.test(resource)) {
    throw badRequest(
      'Enter the Slack channel id (it starts with C, e.g. C08ABCDEF12). Find it under the channel name → About.',
    );
  }
  return saveResource(db, actor, project, { ...input, resource, permission: 'member' });
}

async function saveResource(
  db: Db,
  actor: Actor,
  project: { id: string; code: string },
  input: AddResourceInput & { permission: string },
) {
  const saved = await db.projectAccessResource.upsert({
    where: {
      projectId_system_resource: {
        projectId: project.id,
        system: input.system,
        resource: input.resource,
      },
    },
    create: {
      projectId: project.id,
      system: input.system,
      resource: input.resource,
      label: input.label?.trim().slice(0, 120) ?? '',
      permission: input.permission,
      createdById: actor.userId ?? null,
    },
    update: {
      removedAt: null,
      label: input.label?.trim().slice(0, 120) ?? undefined,
      permission: input.permission,
    },
  });
  await recordActivity(db, {
    actor,
    entityType: 'project',
    entityId: project.id,
    projectId: project.id,
    action: 'access.resource_added',
    summary: `${actor.label} added ${describeResource(saved)} to ${project.code}; everyone staffed on it will get access`,
    metadata: { resourceId: saved.id, system: saved.system, resource: saved.resource },
  });
  await triggerAccessReconcile(db);
  return saved;
}

/** HUMAN ACTION. Stop managing a resource. Everyone's access to it is removed. */
export async function removeAccessResource(db: Db, actor: Actor, resourceId: string) {
  const resource = await db.projectAccessResource.findUnique({
    where: { id: resourceId },
    include: { project: true },
  });
  if (!resource) throw notFound('Access resource not found.');
  if (resource.removedAt) return resource;
  const updated = await db.projectAccessResource.update({
    where: { id: resourceId },
    data: { removedAt: clockNow() },
  });
  await recordActivity(db, {
    actor,
    entityType: 'project',
    entityId: resource.projectId,
    projectId: resource.projectId,
    action: 'access.resource_removed',
    summary: `${actor.label} removed ${describeResource(resource)} from ${resource.project.code}; access will be revoked`,
    metadata: { resourceId },
  });
  await triggerAccessReconcile(db);
  return updated;
}

export function describeResource(
  resource: Pick<ProjectAccessResource, 'system' | 'resource' | 'label'>,
) {
  const name =
    resource.system === 'GITHUB'
      ? `github.com/${resource.resource}`
      : `Slack ${resource.label || resource.resource}`;
  return name;
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Set an expert's GitHub username. Changing it moves access: grants to the old
 * login are revoked (always using the login they were made to), and new ones
 * are made to the new login.
 */
export async function setGithubUsername(
  db: Db,
  actor: Actor,
  expertId: string,
  raw: string | null,
) {
  const username = raw?.trim().replace(/^@/, '') || null;
  if (username && !GITHUB_USERNAME_PATTERN.test(username)) {
    throw badRequest('That is not a valid GitHub username.');
  }
  const expert = await db.expert.findUnique({ where: { id: expertId } });
  if (!expert) throw notFound('Expert not found.');
  if ((expert.githubUsername ?? null)?.toLowerCase() === username?.toLowerCase()) return expert;

  const updated = await db.expert.update({
    where: { id: expertId },
    data: { githubUsername: username },
  });
  const at = clockNow();
  await db.accessGrant.updateMany({
    where: { expertId, system: 'GITHUB', status: 'ACTIVE' },
    data: { status: 'REVOKING', revokeReason: 'GitHub username changed', attempts: 0 },
  });
  // Not granted yet: start again with the new name.
  const retried = await db.accessGrant.findMany({
    where: { expertId, system: 'GITHUB', status: { in: ['PENDING', 'GRANT_FAILED'] } },
    select: { id: true },
  });
  await db.accessGrant.updateMany({
    where: { id: { in: retried.map((g) => g.id) } },
    data: { status: 'PENDING', subject: null, attempts: 0, lastError: null },
  });
  for (const grant of retried) {
    await resolveIfPresent(db, grantAttentionKey(grant.id), 'GitHub username updated.', {
      now: at,
    });
  }
  await recordActivity(db, {
    actor,
    entityType: 'expert',
    entityId: expertId,
    expertId,
    action: 'expert.github_username_set',
    summary: username
      ? `${actor.label} set ${expert.fullName}'s GitHub username to ${username}`
      : `${actor.label} cleared ${expert.fullName}'s GitHub username`,
    metadata: { previous: expert.githubUsername, username },
  });
  await triggerAccessReconcile(db, at);
  return updated;
}

/** HUMAN ACTION. Try a failed grant or revoke again after fixing the cause. */
export async function retryAccessGrant(db: Db, actor: Actor, grantId: string) {
  const grant = await db.accessGrant.findUnique({
    where: { id: grantId },
    include: { expert: true, resource: true },
  });
  if (!grant) throw notFound('Access grant not found.');
  const next =
    grant.status === 'GRANT_FAILED'
      ? 'PENDING'
      : grant.status === 'REVOKE_FAILED'
        ? 'REVOKING'
        : null;
  if (!next) throw invalidState(`This grant is ${grant.status}; only a failed one can be retried.`);
  await db.accessGrant.updateMany({
    where: { id: grantId, status: grant.status },
    data: {
      status: next,
      attempts: 0,
      // A failed grant may have failed on the subject itself, so resolve again.
      ...(next === 'PENDING' ? { subject: null } : {}),
    },
  });
  await recordActivity(db, {
    actor,
    entityType: 'expert',
    entityId: grant.expertId,
    expertId: grant.expertId,
    projectId: grant.projectId,
    action: 'access.retry',
    summary: `${actor.label} retried ${next === 'PENDING' ? 'granting' : 'revoking'} ${describeResource(grant.resource)} for ${grant.expert.fullName}`,
  });
  await triggerAccessReconcile(db);
  return { status: next };
}

/**
 * HUMAN CONFIRMATION. Record that access was removed by hand, after a revoke
 * the system could not complete. The note is the evidence.
 */
export async function confirmManualRevoke(db: Db, actor: Actor, grantId: string, note: string) {
  if (!note.trim()) throw badRequest('Say what you did, so the record means something.');
  const grant = await db.accessGrant.findUnique({
    where: { id: grantId },
    include: { expert: true, resource: true },
  });
  if (!grant) throw notFound('Access grant not found.');
  if (grant.status !== 'REVOKE_FAILED') {
    throw invalidState('Only a failed revoke can be confirmed as done by hand.');
  }
  const at = clockNow();
  await db.accessGrant.updateMany({
    where: { id: grantId, status: 'REVOKE_FAILED' },
    data: {
      status: 'REVOKED',
      revokedAt: at,
      lastError: `Removed by hand: ${note.trim().slice(0, 300)}`,
    },
  });
  await resolveIfPresent(db, revokeAttentionKey(grantId), `Removed by hand by ${actor.label}.`, {
    now: at,
  });
  await recordActivity(db, {
    actor,
    entityType: 'expert',
    entityId: grant.expertId,
    expertId: grant.expertId,
    projectId: grant.projectId,
    action: 'access.revoked_manually',
    summary: `${actor.label} confirmed removing ${grant.expert.fullName} from ${describeResource(grant.resource)} by hand`,
    metadata: { grantId, note: note.trim() },
  });
  return { status: 'REVOKED' as const };
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  planned: { toGrant: number; toRevoke: number; closed: number };
  granted: number;
  revoked: number;
  failed: number;
  retrying: number;
  invitationsAccepted: number;
}

type Desired = {
  resource: ProjectAccessResource;
  expertId: string;
  assignmentId: string;
};

function pairKey(resourceId: string, expertId: string) {
  return `${resourceId}:${expertId}`;
}

async function revokeReasonFor(
  db: Db,
  grant: AccessGrant & { resource: ProjectAccessResource },
): Promise<string> {
  if (grant.resource.removedAt) return 'Resource removed from the project';
  const [project, expert, assignment] = await Promise.all([
    db.project.findUnique({ where: { id: grant.projectId }, select: { status: true } }),
    db.expert.findUnique({ where: { id: grant.expertId }, select: { status: true } }),
    db.assignment.findUnique({
      where: { projectId_expertId: { projectId: grant.projectId, expertId: grant.expertId } },
      select: { status: true },
    }),
  ]);
  if (project && (project.status === 'CLOSED' || project.status === 'CANCELLED')) {
    return `Project ${project.status.toLowerCase()}`;
  }
  if (expert && expert.status !== 'VERIFIED') return `Expert is ${expert.status.toLowerCase()}`;
  if (assignment?.status === 'COMPLETED') return 'Engagement completed';
  if (assignment?.status === 'RELEASED') return 'Seat released';
  return 'No longer staffed on the project';
}

export async function reconcileAccess(
  db: Db,
  options: { now?: Date; providers?: AccessProviders } = {},
): Promise<ReconcileResult> {
  const at = options.now ?? clockNow();
  const providers = options.providers ?? accessProviders();
  const result: ReconcileResult = {
    planned: { toGrant: 0, toRevoke: 0, closed: 0 },
    granted: 0,
    revoked: 0,
    failed: 0,
    retrying: 0,
    invitationsAccepted: 0,
  };

  // --- 1. Who should have what ---------------------------------------------
  const assignments = await db.assignment.findMany({
    where: {
      status: 'CONFIRMED',
      project: { ...OPEN_FOR_ACCESS, accessResources: { some: { removedAt: null } } },
      expert: { status: 'VERIFIED' },
    },
    select: {
      id: true,
      expertId: true,
      project: { select: { accessResources: { where: { removedAt: null } } } },
    },
  });
  const desired = new Map<string, Desired>();
  for (const assignment of assignments) {
    for (const resource of assignment.project.accessResources) {
      desired.set(pairKey(resource.id, assignment.expertId), {
        resource,
        expertId: assignment.expertId,
        assignmentId: assignment.id,
      });
    }
  }

  // --- 2. Plan: move rows towards the desired state -------------------------
  const live = await db.accessGrant.findMany({
    where: { status: { in: LIVE_STATES } },
    include: { resource: true },
  });
  const liveByPair = new Map(live.map((g) => [pairKey(g.resourceId, g.expertId), g]));

  for (const [key, want] of desired) {
    const grant = liveByPair.get(key);
    const mode = providers[want.resource.system].mode;
    if (!grant) {
      // None live: create one, or reopen a revoked one.
      const reopened = await db.accessGrant.updateMany({
        where: { resourceId: want.resource.id, expertId: want.expertId, status: 'REVOKED' },
        data: {
          status: 'PENDING',
          subject: null,
          assignmentId: want.assignmentId,
          attempts: 0,
          lastError: null,
          revokeReason: null,
          invitationId: null,
          invitationPending: false,
        },
      });
      if (reopened.count === 0) {
        await db.accessGrant.createMany({
          data: [
            {
              resourceId: want.resource.id,
              projectId: want.resource.projectId,
              expertId: want.expertId,
              assignmentId: want.assignmentId,
              system: want.resource.system,
              provider: mode,
            },
          ],
          skipDuplicates: true,
        });
      }
      result.planned.toGrant += 1;
    } else if (grant.status === 'ACTIVE' && grant.provider === 'simulated' && mode === 'live') {
      // A simulated grant never reached the real system. Now one is configured,
      // make it real.
      await db.accessGrant.updateMany({
        where: { id: grant.id, status: 'ACTIVE' },
        data: { status: 'PENDING', subject: null, attempts: 0 },
      });
      result.planned.toGrant += 1;
    }
  }

  for (const grant of live) {
    if (desired.has(pairKey(grant.resourceId, grant.expertId))) continue;
    if (grant.status === 'REVOKING' || grant.status === 'REVOKE_FAILED') continue;
    const reason = await revokeReasonFor(db, grant);
    if (grant.status === 'GRANT_FAILED' || (grant.status === 'PENDING' && !grant.subject)) {
      // Nothing was ever granted: no call needed.
      const closed = await db.accessGrant.updateMany({
        where: { id: grant.id, status: grant.status },
        data: { status: 'REVOKED', revokedAt: at, revokeReason: reason },
      });
      if (closed.count) {
        await resolveIfPresent(db, grantAttentionKey(grant.id), reason, { now: at });
        result.planned.closed += 1;
      }
      continue;
    }
    // ACTIVE, or PENDING with a subject (a grant call may have landed before a
    // rollback). Revoking is idempotent, so revoke.
    const moved = await db.accessGrant.updateMany({
      where: { id: grant.id, status: grant.status },
      data: { status: 'REVOKING', revokeReason: reason, attempts: 0 },
    });
    if (moved.count) result.planned.toRevoke += 1;
  }

  // --- 3. Execute pending calls, one locked row at a time -------------------
  const started = Date.now();
  const ids = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "AccessGrant"
    WHERE status IN ('PENDING', 'REVOKING')
    ORDER BY CASE WHEN status = 'REVOKING' THEN 0 ELSE 1 END, "updatedAt"
    LIMIT ${CALLS_PER_RUN}
    FOR UPDATE SKIP LOCKED
  `);

  for (const { id } of ids) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    const grant = await db.accessGrant.findUnique({
      where: { id },
      include: { resource: true, expert: true, project: { select: { code: true } } },
    });
    if (!grant || (grant.status !== 'PENDING' && grant.status !== 'REVOKING')) continue;
    const provider = providers[grant.system];
    const ref = { resource: grant.resource.resource, permission: grant.resource.permission };
    const what = `${describeResource(grant.resource)} on ${grant.project.code}`;

    if (grant.status === 'REVOKING') {
      if (!grant.subject) {
        await db.accessGrant.update({
          where: { id },
          data: { status: 'REVOKED', revokedAt: at, lastError: null },
        });
        result.revoked += 1;
        continue;
      }
      if (grant.provider === 'live' && provider.mode === 'simulated') {
        await failGrant(
          db,
          grant,
          'REVOKE_FAILED',
          'This access was granted with a live token that is no longer configured. Restore the token, or remove access by hand and confirm it here.',
          at,
          what,
        );
        result.failed += 1;
        continue;
      }
      const outcome = await provider.revoke(ref, {
        subject: grant.subject,
        invitationId: grant.invitationPending ? grant.invitationId : null,
      });
      if (outcome.kind === 'done') {
        await db.accessGrant.update({
          where: { id },
          data: {
            status: 'REVOKED',
            revokedAt: at,
            attempts: 0,
            lastError: null,
            invitationPending: false,
            provider: provider.mode,
          },
        });
        await resolveIfPresent(db, revokeAttentionKey(id), 'Access removed.', { now: at });
        await recordActivity(db, {
          actor: SYSTEM_ACTOR,
          entityType: 'expert',
          entityId: grant.expertId,
          expertId: grant.expertId,
          projectId: grant.projectId,
          action: 'access.revoked',
          summary: `Removed ${grant.expert.fullName} from ${what}${provider.mode === 'simulated' ? ' (simulated)' : ''}: ${grant.revokeReason ?? 'no longer staffed'}`,
          metadata: { grantId: id, subject: grant.subject, provider: provider.mode },
        });
        result.revoked += 1;
      } else {
        result[await retryOrFail(db, grant, outcome, 'REVOKE_FAILED', at, what)] += 1;
      }
      continue;
    }

    // PENDING: resolve who, then grant.
    let subject = grant.subject;
    if (!subject) {
      const resolved = await provider.resolveSubject(grant.expert);
      if (resolved.kind !== 'ok') {
        result[await retryOrFail(db, grant, resolved, 'GRANT_FAILED', at, what)] += 1;
        continue;
      }
      subject = resolved.subject;
      if (grant.system === 'SLACK' && provider.mode === 'live' && !grant.expert.slackUserId) {
        await db.expert.update({ where: { id: grant.expertId }, data: { slackUserId: subject } });
      }
      // Recorded before the call, so a rollback-and-retry revokes the right
      // person even if the expert's details change in between.
      await db.accessGrant.update({ where: { id }, data: { subject } });
    }
    const outcome = await provider.grant(ref, subject);
    if (outcome.kind === 'done') {
      await db.accessGrant.update({
        where: { id },
        data: {
          status: 'ACTIVE',
          grantedAt: at,
          attempts: 0,
          lastError: null,
          provider: provider.mode,
          invitationId: outcome.invitationId ?? null,
          invitationPending: outcome.invitationPending ?? false,
          lastVerifiedAt: at,
        },
      });
      await resolveIfPresent(db, grantAttentionKey(id), 'Access granted.', { now: at });
      await recordActivity(db, {
        actor: SYSTEM_ACTOR,
        entityType: 'expert',
        entityId: grant.expertId,
        expertId: grant.expertId,
        projectId: grant.projectId,
        action: 'access.granted',
        summary: `${outcome.invitationPending ? 'Invited' : 'Gave'} ${grant.expert.fullName} ${outcome.invitationPending ? 'to' : 'access to'} ${what}${provider.mode === 'simulated' ? ' (simulated)' : ''}`,
        metadata: { grantId: id, subject, provider: provider.mode },
      });
      result.granted += 1;
    } else {
      result[await retryOrFail(db, grant, outcome, 'GRANT_FAILED', at, what)] += 1;
    }
  }

  // --- 4. Notice accepted GitHub invitations --------------------------------
  const invites = await db.accessGrant.findMany({
    where: {
      status: 'ACTIVE',
      invitationPending: true,
      OR: [
        { lastVerifiedAt: null },
        { lastVerifiedAt: { lt: new Date(at.getTime() - INVITATION_RECHECK_MS) } },
      ],
    },
    include: { resource: true },
    take: 5,
  });
  for (const invite of invites) {
    if (!invite.subject || providers[invite.system].mode !== invite.provider) continue;
    const accepted = await providers[invite.system].invitationAccepted(
      { resource: invite.resource.resource, permission: invite.resource.permission },
      invite.subject,
    );
    await db.accessGrant.updateMany({
      where: { id: invite.id, status: 'ACTIVE' },
      data: {
        lastVerifiedAt: at,
        ...(accepted ? { invitationPending: false, invitationId: null } : {}),
      },
    });
    if (accepted) result.invitationsAccepted += 1;
  }

  return result;
}

async function retryOrFail(
  db: Db,
  grant: AccessGrant & { expert: { fullName: string } },
  outcome: { kind: 'retry' | 'failed'; error: string },
  failState: 'GRANT_FAILED' | 'REVOKE_FAILED',
  at: Date,
  what: string,
): Promise<'retrying' | 'failed'> {
  const attempts = grant.attempts + 1;
  if (outcome.kind === 'retry' && attempts < MAX_ACCESS_ATTEMPTS) {
    await db.accessGrant.update({
      where: { id: grant.id },
      data: { attempts, lastError: outcome.error.slice(0, 500) },
    });
    return 'retrying';
  }
  await failGrant(db, { ...grant, attempts }, failState, outcome.error, at, what);
  return 'failed';
}

async function failGrant(
  db: Db,
  grant: AccessGrant & { expert: { fullName: string } },
  failState: 'GRANT_FAILED' | 'REVOKE_FAILED',
  error: string,
  at: Date,
  what: string,
) {
  await db.accessGrant.update({
    where: { id: grant.id },
    data: { status: failState, attempts: grant.attempts, lastError: error.slice(0, 500) },
  });
  const revoke = failState === 'REVOKE_FAILED';
  await raiseAttention(
    db,
    {
      dedupeKey: revoke ? revokeAttentionKey(grant.id) : grantAttentionKey(grant.id),
      category: revoke ? 'access.revoke_failed' : 'access.grant_failed',
      severity: revoke ? 'HIGH' : 'MEDIUM',
      title: revoke
        ? `${grant.expert.fullName} may still have access to ${what}`
        : `${grant.expert.fullName} could not be given access to ${what}`,
      blocker: error.slice(0, 500),
      impact: revoke
        ? 'Someone who is no longer staffed can still reach client code or conversations.'
        : 'The expert cannot start work that needs this system.',
      nextAction: revoke
        ? 'Remove the access by hand and confirm it on the project, or fix the cause and retry.'
        : 'Fix the cause shown, then retry from the project’s Access section.',
      projectId: grant.projectId,
      expertId: grant.expertId,
      metadata: { grantId: grant.id },
    },
    { now: at },
  );
  await recordActivity(db, {
    actor: SYSTEM_ACTOR,
    entityType: 'expert',
    entityId: grant.expertId,
    expertId: grant.expertId,
    projectId: grant.projectId,
    action: revoke ? 'access.revoke_failed' : 'access.grant_failed',
    summary: `${revoke ? 'Removing' : 'Granting'} ${what} for ${grant.expert.fullName} failed: ${error.slice(0, 200)}`,
    metadata: { grantId: grant.id },
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProjectAccess(db: Db, projectId: string) {
  const providers = accessProviders();
  const resources = await db.projectAccessResource.findMany({
    where: { projectId },
    orderBy: [{ removedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }],
    include: {
      grants: {
        include: {
          expert: { select: { id: true, fullName: true, reference: true, githubUsername: true } },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  return {
    modes: { GITHUB: providers.GITHUB.mode, SLACK: providers.SLACK.mode },
    resources,
  };
}

export async function listExpertAccess(db: Db, expertId: string) {
  return db.accessGrant.findMany({
    where: { expertId },
    include: { resource: true, project: { select: { id: true, code: true, title: true } } },
    orderBy: [{ updatedAt: 'desc' }],
  });
}

export async function accessCounts(db: Db): Promise<Record<AccessGrantStatus, number>> {
  const rows = await db.accessGrant.groupBy({ by: ['status'], _count: { _all: true } });
  const counts: Record<AccessGrantStatus, number> = {
    PENDING: 0,
    ACTIVE: 0,
    REVOKING: 0,
    REVOKED: 0,
    GRANT_FAILED: 0,
    REVOKE_FAILED: 0,
  };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** Every grant, newest change first, optionally narrowed to some states. */
export async function listAccessGrants(
  db: Db,
  options: { statuses?: AccessGrantStatus[]; limit?: number } = {},
) {
  return db.accessGrant.findMany({
    where: options.statuses?.length ? { status: { in: options.statuses } } : {},
    include: {
      resource: true,
      project: { select: { id: true, code: true, title: true } },
      expert: { select: { id: true, fullName: true, reference: true } },
    },
    // Problems first, then most recently changed.
    orderBy: [{ updatedAt: 'desc' }],
    take: Math.min(options.limit ?? 200, 500),
  });
}
