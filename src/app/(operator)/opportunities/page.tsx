import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listOpportunities, opportunityCounts } from '@/server/services/opportunities';
import {
  Badge,
  Card,
  CellPrimary,
  EmptyState,
  PageHeader,
  StatTile,
  StatusBadge,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  PROJECT_ENGAGEMENT: 'project engagement',
  NETWORK_MEMBERSHIP: 'expert network',
} as const;

export default async function OpportunitiesPage() {
  await requireCapability('campaign:read');
  const [opportunities, counts] = await Promise.all([
    listOpportunities(prisma),
    opportunityCounts(prisma),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sourcing"
        title="Opportunities"
        description="What people can apply to. A draft is invisible to applicants; a closed one refuses new applications."
        actions={
          <Link className="btn btn-primary" href="/opportunities/new">
            New opportunity
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Published" value={counts.PUBLISHED} sub="Open to applicants" />
        <StatTile label="Draft" value={counts.DRAFT} sub="Not visible to anyone outside" />
        <StatTile label="Closed" value={counts.CLOSED} sub="Refusing new applications" />
        <StatTile
          label="Applications"
          value={opportunities.reduce((sum, row) => sum + row._count.applications, 0)}
          sub="Across every listing"
        />
      </div>

      <Card flush title={`All opportunities (${opportunities.length})`}>
        {opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities yet"
            hint="Create one, then publish it when the description is ready."
            action={
              <Link className="btn btn-primary btn-sm" href="/opportunities/new">
                New opportunity
              </Link>
            }
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Opportunity</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Linked to</th>
                  <th className="text-right">Applications</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opportunity) => (
                  <tr key={opportunity.id}>
                    <td className="min-w-56">
                      <CellPrimary
                        href={`/opportunities/${opportunity.id}`}
                        meta={
                          <>
                            <span className="font-mono">{opportunity.reference}</span> ·{' '}
                            {opportunity.domain.name}
                          </>
                        }
                      >
                        {opportunity.title}
                      </CellPrimary>
                    </td>
                    <td>
                      <Badge tone={opportunity.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
                        {KIND_LABEL[opportunity.kind]}
                      </Badge>
                    </td>
                    <td>
                      <StatusBadge status={opportunity.status} />
                      {opportunity.publishedAt && (
                        <div className="mt-1 text-xs text-ink-500">
                          {formatRelative(opportunity.publishedAt)}
                        </div>
                      )}
                    </td>
                    <td className="text-xs">
                      {opportunity.project ? (
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/projects/${opportunity.project.id}`}
                        >
                          {opportunity.project.code}
                        </Link>
                      ) : (
                        <span className="text-ink-400">—</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums">{opportunity._count.applications}</td>
                    <td className="text-xs">
                      {opportunity.applicationDeadline
                        ? formatDate(opportunity.applicationDeadline)
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
