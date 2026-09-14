import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/time';
import { listPublishedOpportunities } from '@/server/services/opportunities';
import { Badge, Card, EmptyState } from '@/components/ui';

export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  PROJECT_ENGAGEMENT: 'Project engagement',
  NETWORK_MEMBERSHIP: 'Expert network',
} as const;

/**
 * What an applicant sees before they have any relationship with us.
 *
 * Only published opportunities reach this page, and the query is what enforces
 * it — a draft is never one forgotten filter away from being listed.
 */
export default async function OpportunitiesPage() {
  const opportunities = await listPublishedOpportunities(prisma);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="page-title">Open opportunities</h1>
        <p className="page-subtitle">
          Apply to a specific engagement, or to join the expert network generally. You do not need
          an account: give your details once and we will be in touch about next steps.
        </p>
      </header>

      {opportunities.length === 0 ? (
        <EmptyState
          title="Nothing open at the moment"
          hint="New opportunities appear here as they are published."
        />
      ) : (
        <ul className="space-y-3">
          {opportunities.map((opportunity) => (
            <li key={opportunity.slug}>
              <Card>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="section-title">{opportunity.title}</h2>
                      <Badge tone={opportunity.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
                        {KIND_LABEL[opportunity.kind]}
                      </Badge>
                      {!opportunity.open && <Badge tone="warning">closed</Badge>}
                    </div>
                    <p className="mt-1 text-sm text-ink-600">{opportunity.summary}</p>
                    <p className="mt-2 text-xs text-ink-500">
                      {opportunity.domainName}
                      {opportunity.weeklyHoursMin || opportunity.weeklyHoursMax ? (
                        <>
                          {' · '}
                          {opportunity.weeklyHoursMin ?? '—'}–{opportunity.weeklyHoursMax ?? '—'}{' '}
                          h/week
                        </>
                      ) : null}
                      {opportunity.applicationDeadline && (
                        <> · apply by {formatDate(opportunity.applicationDeadline)}</>
                      )}
                    </p>
                  </div>
                  <Link
                    className="btn btn-secondary"
                    href={`/apply/opportunities/${opportunity.slug}`}
                  >
                    View and apply
                  </Link>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
