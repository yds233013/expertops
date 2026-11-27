import Link from 'next/link';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import type { AccessSystem } from '@prisma/client';
import type { listProjectAccess } from '@/server/services/access';
import {
  byStatusThenRecent,
  resourceName,
  STATUS_HELP,
  SYSTEM_LABEL,
  SYSTEM_TOKEN,
} from '@/lib/access-format';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { ActionButton } from '@/components/action-button';
import { AddAccessResourceForm, ConfirmManualRevokeForm } from '@/components/access-actions';
import { Badge, Card, EmptyState, StatusBadge, TableShell } from '@/components/ui';

type ProjectAccess = Awaited<ReturnType<typeof listProjectAccess>>;
type Resource = ProjectAccess['resources'][number];
type Grant = Resource['grants'][number];

/**
 * The repositories and channels a project's experts need, and who holds them.
 *
 * Read top to bottom: is each system live, what is managed, and for each
 * resource whose access is in which state. Problems sort first in every list.
 */
export function ProjectAccessSection({
  projectId,
  access,
  canManage,
  permissions,
}: {
  projectId: string;
  access: ProjectAccess;
  canManage: boolean;
  permissions: readonly string[];
}) {
  const current = access.resources.filter((resource) => !resource.removedAt);
  const removed = access.resources.filter((resource) => resource.removedAt);

  return (
    <Card
      title="Access to client systems"
      description="Everyone with a confirmed seat gets access to these, and loses it when the seat ends. Checks run every minute."
    >
      <div className="space-y-4">
        <ul className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(access.modes) as AccessSystem[]).map((system) => (
            <ModeRow key={system} system={system} mode={access.modes[system]} />
          ))}
        </ul>

        {current.length === 0 ? (
          <EmptyState
            title="No repositories or channels yet"
            hint={
              canManage
                ? 'Add what experts on this project need below. Access is granted on the next check.'
                : 'An operator adds what experts on this project need.'
            }
          />
        ) : (
          <div className="space-y-3">
            {current.map((resource) => (
              <ResourceBlock
                key={resource.id}
                projectId={projectId}
                resource={resource}
                canManage={canManage}
              />
            ))}
          </div>
        )}

        {removed.length > 0 && (
          <details className="rounded-lg border border-ink-200">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-700">
              {removed.length} removed {removed.length === 1 ? 'resource' : 'resources'}
            </summary>
            <div className="space-y-3 border-t border-ink-100 p-3">
              {removed.map((resource) => (
                <ResourceBlock
                  key={resource.id}
                  projectId={projectId}
                  resource={resource}
                  canManage={canManage}
                />
              ))}
            </div>
          </details>
        )}

        {canManage && (
          <details className="rounded-lg border border-ink-200" open={current.length === 0}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-semibold text-accent-700">
              Add a repository or channel
            </summary>
            <div className="border-t border-ink-100 p-3">
              <AddAccessResourceForm projectId={projectId} permissions={permissions} />
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function ModeRow({ system, mode }: { system: AccessSystem; mode: 'live' | 'simulated' }) {
  return (
    <li className="rounded-md border border-ink-200 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink-900">{SYSTEM_LABEL[system]}</span>
        {mode === 'live' ? (
          <Badge tone="info">Live</Badge>
        ) : (
          <Badge tone="muted" title="Grants are recorded here. Nobody is given real access.">
            Simulated
          </Badge>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ink-500">
        {mode === 'live' ? (
          'Grants and revokes are made for real.'
        ) : (
          <>
            Nothing is granted for real. Set <code>{SYSTEM_TOKEN[system]}</code> to go live.
          </>
        )}
      </p>
    </li>
  );
}

function ResourceBlock({
  projectId,
  resource,
  canManage,
}: {
  projectId: string;
  resource: Resource;
  canManage: boolean;
}) {
  const isRemoved = Boolean(resource.removedAt);
  const name = resourceName(resource);
  const grants = [...resource.grants].sort(byStatusThenRecent);
  const active = grants.filter((grant) => grant.status === 'ACTIVE').length;

  return (
    <section
      aria-label={`${SYSTEM_LABEL[resource.system]} ${name}`}
      className={clsx(
        'min-w-0 rounded-lg border',
        isRemoved ? 'border-ink-100 bg-ink-50/60' : 'border-ink-200',
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 px-3 py-2.5">
        <div className={clsx('min-w-0', isRemoved && 'opacity-70')}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{SYSTEM_LABEL[resource.system]}</Badge>
            <h3 className="text-sm font-semibold text-ink-900 break-anywhere">
              {resource.system === 'GITHUB' ? (
                <a
                  className="font-mono hover:text-accent-700 hover:underline"
                  href={`https://github.com/${resource.resource}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {name}
                  <span className="sr-only"> (opens GitHub in a new tab)</span>
                </a>
              ) : (
                name
              )}
            </h3>
            {resource.system === 'GITHUB' && (
              <Badge tone="muted" title="GitHub permission granted to each expert">
                {resource.permission}
              </Badge>
            )}
            {isRemoved && <Badge tone="muted">removed</Badge>}
          </div>
          <p className="mt-0.5 text-xs text-ink-500">
            {resource.system === 'GITHUB' ? (
              resource.label || 'Repository'
            ) : (
              <>
                Channel <span className="font-mono">{resource.resource}</span>
              </>
            )}
            {isRemoved
              ? ` · removed ${formatDate(resource.removedAt)}`
              : ` · ${active} with access`}
          </p>
        </div>
        {canManage && !isRemoved && (
          <ActionButton
            url={`/api/projects/${projectId}/access`}
            body={{ action: 'remove', resourceId: resource.id }}
            label="Remove"
            pendingLabel="Removing…"
            confirm={`Everyone's access to ${name} is revoked on the next check.`}
          />
        )}
      </header>

      {grants.length === 0 ? (
        <p className="border-t border-ink-100 px-3 py-2.5 text-sm text-ink-500">
          {isRemoved
            ? 'Nobody had access.'
            : 'Nobody holds a confirmed seat yet, so nobody has access.'}
        </p>
      ) : (
        <div className="border-t border-ink-100">
          <TableShell label={`Access to ${name}`}>
            <thead>
              <tr>
                <th scope="col">Expert</th>
                <th scope="col">Status</th>
                <th scope="col">Account</th>
                <th scope="col">Details</th>
                {canManage && (
                  <th scope="col" className="row-actions">
                    Action
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {grants.map((grant) => (
                <GrantRow
                  key={grant.id}
                  projectId={projectId}
                  grant={grant}
                  resourceLabel={name}
                  canManage={canManage}
                />
              ))}
            </tbody>
          </TableShell>
        </div>
      )}
    </section>
  );
}

function GrantRow({
  projectId,
  grant,
  resourceLabel,
  canManage,
}: {
  projectId: string;
  grant: Grant;
  resourceLabel: string;
  canManage: boolean;
}) {
  const failed = grant.status === 'GRANT_FAILED' || grant.status === 'REVOKE_FAILED';
  return (
    <tr className={clsx(grant.status === 'REVOKED' && 'text-ink-500')}>
      <td className="whitespace-nowrap">
        <Link
          className="font-medium text-ink-900 hover:underline"
          href={`/experts/${grant.expert.id}`}
        >
          {grant.expert.fullName}
        </Link>
        <div className="font-mono text-xs text-ink-500">{grant.expert.reference}</div>
      </td>
      <td>
        <div className="flex items-center gap-1">
          <StatusBadge status={grant.status} title={STATUS_HELP[grant.status]} />
          {grant.provider === 'simulated' && (
            <Badge tone="muted" title="Recorded here only. No real access was given or removed.">
              Simulated
            </Badge>
          )}
        </div>
      </td>
      <td className="whitespace-nowrap font-mono text-xs">
        {grant.subject ?? <span className="font-sans text-ink-400">none yet</span>}
      </td>
      <td className="min-w-48 max-w-80 text-xs">
        <GrantDetails grant={grant} />
      </td>
      {canManage && (
        <td>
          {failed ? (
            <div className="flex flex-col items-start gap-2">
              <ActionButton
                url={`/api/projects/${projectId}/access`}
                body={{ action: 'retry', grantId: grant.id }}
                label="Retry"
                pendingLabel="Retrying…"
              />
              {grant.status === 'REVOKE_FAILED' && (
                <ConfirmManualRevokeForm
                  projectId={projectId}
                  grantId={grant.id}
                  who={`${grant.expert.fullName} on ${resourceLabel}`}
                />
              )}
            </div>
          ) : (
            <span className="text-xs text-ink-400">—</span>
          )}
        </td>
      )}
    </tr>
  );
}

/** What happened to this grant, in one or two short lines. */
export function GrantDetails({
  grant,
}: {
  grant: Pick<
    Grant,
    | 'status'
    | 'invitationPending'
    | 'lastError'
    | 'revokeReason'
    | 'grantedAt'
    | 'revokedAt'
    | 'attempts'
  >;
}) {
  const lines: ReactNode[] = [];
  if (grant.status === 'REVOKE_FAILED') {
    lines.push(
      <span key="warn" className="font-semibold text-rose-800">
        May still have access.
      </span>,
    );
  }
  if (grant.invitationPending && grant.status === 'ACTIVE') {
    lines.push(
      <span key="invite" className="text-amber-900">
        Invited, not accepted yet.
      </span>,
    );
  }
  if (grant.lastError && grant.status !== 'ACTIVE' && grant.status !== 'REVOKED') {
    lines.push(
      <span key="error" className="text-rose-800 break-anywhere">
        {grant.lastError}
        {grant.attempts > 1 && <span className="text-ink-500"> ({grant.attempts} attempts)</span>}
      </span>,
    );
  }
  if (grant.revokeReason && grant.status !== 'ACTIVE' && grant.status !== 'PENDING') {
    lines.push(
      <span key="reason" className="text-ink-600">
        Reason: {grant.revokeReason}
      </span>,
    );
  }
  if (grant.status === 'REVOKED' && grant.revokedAt) {
    lines.push(
      <span key="revoked" className="text-ink-500" title={formatDateTime(grant.revokedAt)}>
        Removed {formatRelative(grant.revokedAt)}
      </span>,
    );
  } else if (grant.status === 'ACTIVE' && grant.grantedAt) {
    lines.push(
      <span key="granted" className="text-ink-500" title={formatDateTime(grant.grantedAt)}>
        Granted {formatRelative(grant.grantedAt)}
      </span>,
    );
  }
  if (lines.length === 0) return <span className="text-ink-400">—</span>;
  return <div className="flex flex-col gap-0.5">{lines}</div>;
}
