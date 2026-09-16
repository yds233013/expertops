import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { formatDate } from '@/lib/time';
import { findPublishedBySlug } from '@/server/services/opportunities';
import { ApplyForm } from '@/components/apply/apply-form';
import { Alert, Badge, Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

const KIND_LABEL = {
  PROJECT_ENGAGEMENT: 'Project engagement',
  NETWORK_MEMBERSHIP: 'Expert network',
} as const;

/**
 * One opportunity, as an applicant sees it.
 *
 * Everything on this page comes from the public projection, which cannot return
 * internal notes or the client's identity however the page is written.
 */
export default async function OpportunityPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const opportunity = await findPublishedBySlug(prisma, slug);
  if (!opportunity) notFound();

  const facts: { label: string; value: string }[] = [
    { label: 'Area', value: opportunity.domainName },
  ];
  if (opportunity.weeklyHoursMin || opportunity.weeklyHoursMax) {
    facts.push({
      label: 'Expected hours',
      value: `${opportunity.weeklyHoursMin ?? '—'}–${opportunity.weeklyHoursMax ?? '—'} per week`,
    });
  }
  if (opportunity.startDate || opportunity.endDate) {
    facts.push({
      label: 'Dates',
      value: `${opportunity.startDate ? formatDate(opportunity.startDate) : '—'} → ${
        opportunity.endDate ? formatDate(opportunity.endDate) : '—'
      }`,
    });
  }
  if (opportunity.applicationDeadline) {
    facts.push({ label: 'Apply by', value: formatDate(opportunity.applicationDeadline) });
  }
  if (opportunity.compensationNote) {
    facts.push({ label: 'Compensation', value: opportunity.compensationNote });
  }

  return (
    <div className="space-y-6">
      <header>
        <Link
          className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-ink-500 hover:text-accent-700"
          href="/apply/opportunities"
        >
          <span aria-hidden="true">←</span> All opportunities
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning" title="Practice listing: nobody is hired from it">
            Sample listing
          </Badge>
          <Badge tone={opportunity.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
            {KIND_LABEL[opportunity.kind]}
          </Badge>
        </div>
        <h1 className="page-title mt-2">{opportunity.title}</h1>
        {opportunity.summary && <p className="page-subtitle">{opportunity.summary}</p>}
      </header>

      {!opportunity.open && <Alert tone="warning">{opportunity.closedReason}</Alert>}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_15rem]">
        <Card title="About this opportunity" className="md:order-1">
          <div className="space-y-5">
            {opportunity.description && (
              <section>
                <h3 className="section-title">Description</h3>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-ink-700">
                  {opportunity.description}
                </p>
              </section>
            )}

            {opportunity.responsibilities && (
              <section>
                <h3 className="section-title">What you would be doing</h3>
                <ul className="mt-1.5 space-y-1 text-sm text-ink-700">
                  {opportunity.responsibilities
                    .split('\n')
                    .map((line) => line.trim())
                    .filter(Boolean)
                    .map((line) => (
                      <li key={line} className="flex gap-2">
                        <span aria-hidden="true" className="text-accent-500">
                          •
                        </span>
                        {line}
                      </li>
                    ))}
                </ul>
              </section>
            )}

            {opportunity.requiredSkills.length > 0 && (
              <section>
                <h3 className="section-title">Skills we are looking for</h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {opportunity.requiredSkills.map((skill) => (
                    <Badge key={skill} tone="info">
                      {skill}
                    </Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        </Card>

        <aside className="md:order-2">
          <div className="card px-4 py-3 md:sticky md:top-4">
            <dl className="divide-y divide-ink-100">
              {facts.map((fact) => (
                <div key={fact.label} className="py-2 first:pt-0 last:pb-0">
                  <dt className="text-xs text-ink-500">{fact.label}</dt>
                  <dd className="text-sm font-medium text-ink-900">{fact.value}</dd>
                </div>
              ))}
            </dl>
            {opportunity.open && (
              <a className="btn btn-primary mt-3 w-full" href="#apply">
                Apply
              </a>
            )}
          </div>
        </aside>
      </div>

      {opportunity.open ? (
        <section id="apply" className="card scroll-mt-4">
          <header className="card-header">
            <div>
              <h2 className="section-title">Apply</h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Nothing here is a commitment. An operator reads every application.
              </p>
            </div>
          </header>
          <div className="card-body">
            {/* Said immediately above the fields, not in a footer. Somebody about
                to type their name and address should already know that this is
                a practice listing and that no email will arrive. */}
            <Alert tone="warning" className="mb-4">
              <strong>A practice listing, and simulated email.</strong> This is not a real job and
              nobody is hired from it. What you type is stored in a demonstration database. Messages
              are written to an in-app outbox and never sent, so no confirmation will reach your
              inbox — the next step has to be handed to you directly by an operator. Please use
              details you are happy to have sitting in a demo.
            </Alert>
            <ApplyForm slug={opportunity.slug} questions={opportunity.questions} />
          </div>
        </section>
      ) : (
        <Card title="Applications are closed">
          <p className="text-sm text-ink-600">
            This one is no longer accepting applications.{' '}
            <Link className="text-accent-600 hover:underline" href="/apply/opportunities">
              See what else is open.
            </Link>
          </p>
        </Card>
      )}
    </div>
  );
}
