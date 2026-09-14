import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { listOpportunities, opportunityCounts } from '@/server/services/opportunities';
import { Badge, Card, EmptyState, PageHeader, StatTile, StatusBadge } from '@/components/ui';

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
        title="Opportunities"
        description="What people can apply to. A draft is invisible to applicants; a closed one refuses new applications."
        actions={
          <Link className="btn btn-primary" href="/opportunities/new">
            New opportunity
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Draft" value={counts.DRAFT} hint="not listed" tone="muted" />
        <StatTile label="Published" value={counts.PUBLISHED} tone="success" />
        <StatTile label="Closed" value={counts.CLOSED} tone="muted" />
        <StatTile
          label="Applications"
          value={opportunities.reduce((sum, row) => sum + row._count.applications, 0)}
        />
      </div>

      <Card title={`All opportunities (${opportunities.length})`}>
        {opportunities.length === 0 ? (
          <EmptyState
            title="No opportunities yet"
            hint="Create one, then publish it when the description is ready."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Title</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Linked to</th>
                  <th>Applications</th>
                  <th>Deadline</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opportunity) => (
                  <tr key={opportunity.id}>
                    <td>
                      <Link
                        className="font-mono text-accent-600 hover:underline"
                        href={`/opportunities/${opportunity.id}`}
                      >
                        {opportunity.reference}
                      </Link>
                    </td>
                    <td>
                      <div className="font-medium text-ink-900">{opportunity.title}</div>
                      <div className="text-xs text-ink-500">{opportunity.domain.name}</div>
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
                    <td className="tabular-nums">{opportunity._count.applications}</td>
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
