import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/time';
import { listPublishedOpportunities } from '@/server/services/opportunities';
import { Alert, Badge, EmptyState } from '@/components/ui';

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
  const open = opportunities.filter((opportunity) => opportunity.open);

  return (
    <div className="space-y-6">
      <header>
        <span className="eyebrow">
          {open.length} open {open.length === 1 ? 'listing' : 'listings'}
        </span>
        <h1 className="page-title">Open opportunities</h1>
        <p className="page-subtitle">
          Apply to a specific engagement, or to join the expert network generally. You do not need
          an account: give your details once and an operator will be in touch about next steps.
        </p>
      </header>

      <Alert tone="warning">
        <strong>These are practice listings, not real jobs.</strong> They exist so this software can
        be demonstrated end to end. Nobody is hired from them, no work is offered and no money
        changes hands. Email is simulated: messages are written to an in-app outbox and never sent,
        so applying will not put anything in your inbox — an operator has to hand you the next link
        directly.
      </Alert>

      {opportunities.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Nothing open at the moment"
            hint="New opportunities appear here as they are published."
          />
        </div>
      ) : (
        <ul className="grid gap-3">
          {opportunities.map((opportunity) => (
            <li key={opportunity.slug}>
              {/* The whole card is clickable through the title's link, stretched
                  over it; the explicit link at the foot stays for anyone
                  tabbing or reading by links. */}
              <section className="card group relative px-5 py-4 transition-shadow hover:border-ink-300 hover:shadow-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="warning" title="Practice listing: nobody is hired from it">
                    Sample listing
                  </Badge>
                  <Badge tone={opportunity.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
                    {KIND_LABEL[opportunity.kind]}
                  </Badge>
                  {!opportunity.open && <Badge tone="muted">closed</Badge>}
                </div>
                <h2 className="mt-2 text-base font-semibold text-ink-900 group-hover:text-accent-700">
                  <Link
                    href={`/apply/opportunities/${opportunity.slug}`}
                    className="after:absolute after:inset-0 after:rounded-[0.75rem] focus-visible:outline-none"
                    tabIndex={-1}
                  >
                    {opportunity.title}
                  </Link>
                </h2>
                {opportunity.summary && (
                  <p className="mt-1 text-sm text-ink-600">{opportunity.summary}</p>
                )}
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-ink-100 pt-3">
                  <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-500">
                    <div>
                      <dt className="sr-only">Area</dt>
                      <dd>{opportunity.domainName}</dd>
                    </div>
                    {(opportunity.weeklyHoursMin || opportunity.weeklyHoursMax) && (
                      <div>
                        <dt className="sr-only">Hours</dt>
                        <dd>
                          {opportunity.weeklyHoursMin ?? '—'}–{opportunity.weeklyHoursMax ?? '—'}{' '}
                          hours a week
                        </dd>
                      </div>
                    )}
                    {opportunity.applicationDeadline && (
                      <div>
                        <dt className="sr-only">Deadline</dt>
                        <dd>Apply by {formatDate(opportunity.applicationDeadline)}</dd>
                      </div>
                    )}
                  </dl>
                  <Link
                    href={`/apply/opportunities/${opportunity.slug}`}
                    className="relative z-10 text-sm font-semibold text-accent-700 hover:underline"
                  >
                    View and apply <span aria-hidden="true">→</span>
                  </Link>
                </div>
              </section>
            </li>
          ))}
        </ul>
      )}

      <p className="text-sm text-ink-600">
        Looking at this as a reviewer rather than an applicant?{' '}
        <Link className="font-medium text-accent-700 hover:underline" href="/demo">
          Explore the read-only demo
        </Link>{' '}
        of the operator side.
      </p>
    </div>
  );
}
