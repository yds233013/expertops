import Link from 'next/link';
import type { AccessGrantStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { assertCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { accessProviders } from '@/server/integrations/access-providers';
import { accessCounts, listAccessGrants } from '@/server/services/access';
import {
  byStatusThenRecent,
  resourceName,
  STATUS_HELP,
  SYSTEM_LABEL,
  SYSTEM_TOKEN,
} from '@/lib/access-format';
import { GrantDetails } from '@/components/project-access';
import {
  Alert,
  Badge,
  Card,
  CellPrimary,
  EmptyState,
  PageHeader,
  StatTile,
  StatusBadge,
  TableShell,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const FILTERS: { key: string; label: string; statuses: AccessGrantStatus[] }[] = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'problems', label: 'Failed', statuses: ['REVOKE_FAILED', 'GRANT_FAILED'] },
  { key: 'in-progress', label: 'In progress', statuses: ['PENDING', 'REVOKING'] },
  { key: 'active', label: 'Active', statuses: ['ACTIVE'] },
  { key: 'revoked', label: 'Removed', statuses: ['REVOKED'] },
];

/**
 * Every grant to a client system, across projects.
 *
 * The page exists for one question: does anyone still have access they should
 * not? A failed revoke answers it, so it leads.
 */
export default async function AccessPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const operator = await requireOperator();
  assertCapability(operator, 'access:read');
  const { status } = await searchParams;
  const filter = FILTERS.find((item) => item.key === status) ?? FILTERS[0]!;

  const [counts, grants] = await Promise.all([
    accessCounts(prisma),
    listAccessGrants(prisma, { statuses: filter.statuses, limit: 200 }),
  ]);
  const rows = [...grants].sort(byStatusThenRecent);
  const providers = accessProviders();
  const modes = { GITHUB: providers.GITHUB.mode, SLACK: providers.SLACK.mode };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const countFor = (statuses: AccessGrantStatus[]) =>
    statuses.length === 0 ? total : statuses.reduce((sum, value) => sum + counts[value], 0);
  const hrefFor = (key: string) => (key === 'all' ? '/access' : `/access?status=${key}`);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Delivery"
        title="Access"
        description="GitHub repositories and Slack channels granted to experts. Access follows a confirmed seat and is revoked when the seat ends. Checks run every minute."
        meta={
          <>
            {(Object.keys(modes) as (keyof typeof modes)[]).map((system) =>
              modes[system] === 'live' ? (
                <Badge key={system} tone="info">
                  {SYSTEM_LABEL[system]} live
                </Badge>
              ) : (
                <Badge
                  key={system}
                  tone="muted"
                  title={`Nobody is given real access. Set ${SYSTEM_TOKEN[system]} to go live.`}
                >
                  {SYSTEM_LABEL[system]} sandbox
                </Badge>
              ),
            )}
          </>
        }
      />

      {counts.REVOKE_FAILED > 0 && (
        <Alert tone="error">
          <strong>
            {counts.REVOKE_FAILED} {counts.REVOKE_FAILED === 1 ? 'person' : 'people'} may still have
            access
          </strong>{' '}
          to a client system after it should have been removed. Retry on the project page, or remove
          it by hand and confirm with a note.
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatTile
          label="Revoke failed"
          value={counts.REVOKE_FAILED}
          tone="danger"
          hint={counts.REVOKE_FAILED > 0 ? 'act now' : undefined}
          sub="Removing failed. They may still have access."
          href={hrefFor('problems')}
        />
        <StatTile
          label="Grant failed"
          value={counts.GRANT_FAILED}
          tone="warning"
          hint={counts.GRANT_FAILED > 0 ? 'needs a person' : undefined}
          sub="Nothing granted. Often a missing GitHub username."
          href={hrefFor('problems')}
        />
        <StatTile
          label="In progress"
          value={counts.PENDING + counts.REVOKING}
          sub={`${counts.PENDING} to grant · ${counts.REVOKING} to remove`}
          href={hrefFor('in-progress')}
        />
        <StatTile label="Active" value={counts.ACTIVE} href={hrefFor('active')} />
        <StatTile label="Removed" value={counts.REVOKED} href={hrefFor('revoked')} />
      </div>

      <Card flush title="Grants" description="Failures first, then the most recently changed.">
        <div className="border-b border-ink-100 px-4 py-2.5">
          <nav className="segmented" aria-label="Filter grants by status">
            {FILTERS.map((item) => (
              <Link
                key={item.key}
                href={hrefFor(item.key)}
                aria-current={item.key === filter.key ? 'page' : undefined}
                className="segmented-item"
              >
                {item.label}{' '}
                <span className="tabular-nums text-ink-400">{countFor(item.statuses)}</span>
              </Link>
            ))}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            title={total === 0 ? 'No access granted yet' : 'No grants match this filter'}
            hint={
              total === 0
                ? 'Add a repository or channel on a project. Everyone with a confirmed seat gets it.'
                : undefined
            }
          />
        ) : (
          <TableShell label="Access grants">
            <thead>
              <tr>
                <th scope="col">Expert</th>
                <th scope="col">Resource</th>
                <th scope="col">Status</th>
                <th scope="col">Account</th>
                <th scope="col">Details</th>
                <th scope="col">Changed</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((grant) => (
                <tr key={grant.id}>
                  <td className="whitespace-nowrap">
                    <CellPrimary href={`/experts/${grant.expert.id}`} meta={grant.expert.reference}>
                      {grant.expert.fullName}
                    </CellPrimary>
                  </td>
                  <td className="min-w-56 max-w-72">
                    <span className="block text-sm font-medium text-ink-900 break-anywhere">
                      {resourceName(grant.resource)}
                    </span>
                    <span className="text-xs text-ink-500">
                      {SYSTEM_LABEL[grant.system]} ·{' '}
                      <Link
                        className="text-accent-700 hover:underline"
                        href={`/projects/${grant.project.id}#access`}
                      >
                        {grant.project.code}
                      </Link>
                    </span>
                  </td>
                  <td>
                    <div className="flex items-center gap-1">
                      <StatusBadge status={grant.status} title={STATUS_HELP[grant.status]} />
                      {grant.provider === 'simulated' && (
                        <Badge
                          tone="muted"
                          title="Recorded here only. No real access was given or removed."
                        >
                          Sandbox
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="whitespace-nowrap font-mono text-xs">
                    {grant.subject ?? <span className="font-sans text-ink-400">none yet</span>}
                  </td>
                  <td className="min-w-48 max-w-80 text-xs">
                    <GrantDetails grant={grant} />
                    {(grant.status === 'GRANT_FAILED' || grant.status === 'REVOKE_FAILED') && (
                      <Link
                        className="mt-1 inline-block font-semibold text-accent-700 hover:underline"
                        href={`/projects/${grant.project.id}#access`}
                      >
                        Fix on the project
                      </Link>
                    )}
                  </td>
                  <td
                    className="whitespace-nowrap text-xs text-ink-500"
                    title={formatDateTime(grant.updatedAt)}
                  >
                    {formatRelative(grant.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        )}
      </Card>
    </div>
  );
}
