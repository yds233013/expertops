import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listScreenings } from '@/server/services/screening';
import { AssignReviewerPanel, ReviewForm } from '@/components/review-form';
import { ScreeningDecisionPanel } from '@/components/screening-decision-panel';
import { Badge, Card, EmptyState, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * The review queue.
 *
 * Everything a reviewer or a deciding operator needs is on one page: the
 * submission, the rubric it is being judged against, the other reviewers'
 * decisions, and the controls to act. Private notes appear here and nowhere
 * a candidate can reach.
 */
export default async function ScreeningsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const operator = await requireOperator();
  const { filter } = await searchParams;

  const screenings = await listScreenings(prisma, {
    ...(filter === 'mine' ? { reviewerId: operator.id } : {}),
    ...(filter === 'overdue' ? { overdueOnly: true } : {}),
    ...(filter === 'submitted' ? { status: 'SUBMITTED' as const } : {}),
  });

  const reviewers = await prisma.user.findMany({
    where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const canReview = roleHasCapability(operator.role, 'screening:review');
  const canWrite = roleHasCapability(operator.role, 'screening:write');
  const canDecide = roleHasCapability(operator.role, 'screening:decide');
  const canResolveConflict = roleHasCapability(operator.role, 'screening:resolve_conflict');

  const tabs = [
    { label: 'All open', href: '/screenings', active: !filter },
    { label: 'Assigned to me', href: '/screenings?filter=mine', active: filter === 'mine' },
    {
      label: 'Just submitted',
      href: '/screenings?filter=submitted',
      active: filter === 'submitted',
    },
    { label: 'Review overdue', href: '/screenings?filter=overdue', active: filter === 'overdue' },
  ];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-lg font-semibold text-ink-900">Screening review</h1>
        <p className="mt-1 text-sm text-ink-600">
          Each screening is judged against the rubric version it started on. Two reviewers who
          disagree raise a conflict; the system never breaks the tie.
        </p>
      </header>

      <nav className="flex flex-wrap gap-2" aria-label="Screening filters">
        {tabs.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={tab.active ? 'page' : undefined}
            className={
              tab.active
                ? 'rounded-md bg-ink-900 px-3 py-1.5 text-sm font-medium text-white'
                : 'rounded-md border border-ink-200 px-3 py-1.5 text-sm text-ink-700 hover:bg-ink-100'
            }
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      {screenings.length === 0 ? (
        <Card>
          <EmptyState title="No screenings match this filter" />
        </Card>
      ) : (
        screenings.map((screening) => {
          const submission = screening.submissions[0];
          const myReview = screening.reviews.find(
            (review) => review.reviewerId === operator.id && review.state === 'ASSIGNED',
          );
          const answers = (submission?.answers ?? {}) as Record<string, string>;
          const links = (submission?.workSampleLinks ?? []) as string[];

          return (
            <Card
              key={screening.id}
              title={
                <Link
                  className="text-accent-600 hover:underline"
                  href={`/candidates/${screening.candidate.id}`}
                >
                  {screening.candidate.fullName}
                </Link>
              }
              description={`${screening.reference} · ${screening.rubricVersion.template.domain.name} · rubric v${screening.rubricVersion.version}`}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  {screening.conflict?.status === 'OPEN' && <Badge tone="danger">conflict</Badge>}
                  <StatusBadge status={screening.status} />
                </div>
              }
            >
              <div className="space-y-4">
                <p className="text-xs text-ink-600">
                  {screening.reviewDueAt ? (
                    <>
                      Review due{' '}
                      <span title={formatDateTime(screening.reviewDueAt)}>
                        {formatRelative(screening.reviewDueAt)}
                      </span>
                      .{' '}
                    </>
                  ) : null}
                  Candidate deadline{' '}
                  <span title={formatDateTime(screening.dueAt)}>
                    {formatRelative(screening.dueAt)}
                  </span>
                  .
                </p>

                {submission ? (
                  <section>
                    <h3 className="text-sm font-semibold text-ink-900">
                      Submission, revision {submission.revision}
                      {!submission.isComplete && (
                        <Badge tone="warning"> required evidence missing</Badge>
                      )}
                    </h3>
                    <dl className="mt-2 space-y-2">
                      {screening.rubricVersion.criteria.map((criterion) => (
                        <div key={criterion.key} className="rounded-md bg-ink-50 px-3 py-2">
                          <dt className="text-xs font-semibold text-ink-500">{criterion.label}</dt>
                          <dd className="mt-0.5 whitespace-pre-line text-sm text-ink-800">
                            {answers[criterion.key]?.trim() || '(left blank)'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {links.length > 0 && (
                      <ul className="mt-2 space-y-0.5 text-xs text-ink-600">
                        {links.map((link) => (
                          <li key={link}>
                            {/* Recorded as text. ExpertOps never fetches it. */}
                            <code>{link}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                    {submission.note && (
                      <p className="mt-2 text-sm text-ink-700">{submission.note}</p>
                    )}
                  </section>
                ) : (
                  <EmptyState title="Nothing submitted yet" />
                )}

                {screening.reviews.length > 0 && (
                  <section>
                    <h3 className="text-sm font-semibold text-ink-900">Reviews</h3>
                    <ul className="mt-1 space-y-1 text-sm">
                      {screening.reviews.map((review) => (
                        <li key={review.id} className="text-ink-700">
                          {review.reviewer.name}:{' '}
                          <strong>{review.decision ?? review.state.toLowerCase()}</strong>
                          {review.publicFeedback && ` — ${review.publicFeedback}`}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {screening.conflict?.status === 'OPEN' && (
                  <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800">
                    Reviewers disagree: {screening.conflict.summary}. An admin must record a
                    resolution before a decision can be made.
                  </p>
                )}

                {canWrite && ['SUBMITTED', 'IN_REVIEW'].includes(screening.status) && (
                  <AssignReviewerPanel screeningId={screening.id} reviewers={reviewers} />
                )}

                {canReview && myReview && submission && (
                  <ReviewForm
                    reviewId={myReview.id}
                    reference={screening.reference}
                    passThreshold={screening.rubricVersion.passThreshold}
                    criteria={screening.rubricVersion.criteria.map((criterion) => ({
                      key: criterion.key,
                      label: criterion.label,
                      scoringGuidance: criterion.scoringGuidance,
                      maxScore: criterion.maxScore,
                      weight: criterion.weight,
                      isGating: criterion.isGating,
                    }))}
                  />
                )}

                {canDecide && ['SUBMITTED', 'IN_REVIEW'].includes(screening.status) && (
                  <ScreeningDecisionPanel
                    screeningId={screening.id}
                    reference={screening.reference}
                    hasOpenConflict={screening.conflict?.status === 'OPEN'}
                    canResolveConflict={canResolveConflict}
                  />
                )}
              </div>
            </Card>
          );
        })
      )}
    </div>
  );
}
