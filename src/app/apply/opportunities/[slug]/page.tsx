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

  return (
    <div className="space-y-5">
      <p className="text-sm">
        <Link className="text-accent-600 hover:underline" href="/apply/opportunities">
          ← All opportunities
        </Link>
      </p>

      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title">{opportunity.title}</h1>
          <Badge tone={opportunity.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
            {KIND_LABEL[opportunity.kind]}
          </Badge>
        </div>
        <p className="page-subtitle">{opportunity.summary}</p>
      </header>

      {!opportunity.open && <Alert tone="warning">{opportunity.closedReason}</Alert>}

      <Card title="About this opportunity">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="attn-term">Area</dt>
            <dd className="text-sm text-ink-800">{opportunity.domainName}</dd>
          </div>
          {(opportunity.weeklyHoursMin || opportunity.weeklyHoursMax) && (
            <div>
              <dt className="attn-term">Expected hours</dt>
              <dd className="text-sm text-ink-800">
                {opportunity.weeklyHoursMin ?? '—'}–{opportunity.weeklyHoursMax ?? '—'} per week
              </dd>
            </div>
          )}
          {(opportunity.startDate || opportunity.endDate) && (
            <div>
              <dt className="attn-term">Dates</dt>
              <dd className="text-sm text-ink-800">
                {opportunity.startDate ? formatDate(opportunity.startDate) : '—'} →{' '}
                {opportunity.endDate ? formatDate(opportunity.endDate) : '—'}
              </dd>
            </div>
          )}
          {opportunity.applicationDeadline && (
            <div>
              <dt className="attn-term">Apply by</dt>
              <dd className="text-sm text-ink-800">
                {formatDate(opportunity.applicationDeadline)}
              </dd>
            </div>
          )}
          {opportunity.compensationNote && (
            <div className="sm:col-span-2">
              <dt className="attn-term">Compensation</dt>
              <dd className="text-sm text-ink-800">{opportunity.compensationNote}</dd>
            </div>
          )}
        </dl>

        {opportunity.description && (
          <div className="mt-4">
            <h3 className="section-title">Description</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">
              {opportunity.description}
            </p>
          </div>
        )}

        {opportunity.responsibilities && (
          <div className="mt-4">
            <h3 className="section-title">What you would be doing</h3>
            <p className="mt-1 whitespace-pre-wrap text-sm text-ink-700">
              {opportunity.responsibilities}
            </p>
          </div>
        )}

        {opportunity.requiredSkills.length > 0 && (
          <div className="mt-4">
            <h3 className="section-title">Skills we are looking for</h3>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {opportunity.requiredSkills.map((skill) => (
                <Badge key={skill} tone="info">
                  {skill}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      {opportunity.open ? (
        <Card
          title="Apply"
          description="Nothing here is a commitment. An operator reads every application."
        >
          {/* Said immediately above the fields, not in a footer. Somebody about
              to type their name and address should already know that this is a
              practice listing and that no email will arrive. */}
          <Alert tone="warning" className="mb-3">
            <strong>A practice listing, and simulated email.</strong> This is not a real job and
            nobody is hired from it. What you type is stored in a demonstration database. Messages
            are written to an in-app outbox and never sent, so no confirmation will reach your inbox
            — the next step has to be handed to you directly by an operator. Please use details you
            are happy to have sitting in a demo.
          </Alert>
          <ApplyForm slug={opportunity.slug} questions={opportunity.questions} />
        </Card>
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
