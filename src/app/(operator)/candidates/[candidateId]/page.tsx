import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { getCandidate } from '@/server/services/candidates';
import { listActivity } from '@/server/services/activity';
import { listTemplates } from '@/server/services/screening';
import { StartScreeningPanel } from '@/components/start-screening-panel';
import { ScreeningDecisionPanel } from '@/components/screening-decision-panel';
import { ResolveDuplicate } from '@/components/resolve-duplicate';
import { Badge, Card, EmptyState, FieldRow, ProvenanceTag, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CandidateDetailPage({
  params,
}: {
  params: Promise<{ candidateId: string }>;
}) {
  const operator = await requireOperator();
  const { candidateId } = await params;

  const [candidate, activity, templates] = await Promise.all([
    getCandidate(prisma, candidateId),
    listActivity(prisma, { candidateId, limit: 50 }),
    listTemplates(prisma),
  ]);

  const canWrite = roleHasCapability(operator.role, 'candidate:write');
  const canScreen = roleHasCapability(operator.role, 'screening:write');
  const canDecide = roleHasCapability(operator.role, 'screening:decide');
  const openDuplicates = candidate.duplicateFlags.filter((flag) => flag.status === 'OPEN');

  const publishedVersions = templates.flatMap((template) =>
    template.versions
      .filter((version) => version.status === 'PUBLISHED')
      .map((version) => ({
        id: version.id,
        label: `${template.name} v${version.version} (${template.domain.name})`,
      })),
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">{candidate.fullName}</h1>
            <StatusBadge status={candidate.stage} />
            {candidate.contactOptOutAt && <Badge tone="muted">opted out of contact</Badge>}
          </div>
          <p className="mt-1 text-sm text-ink-600">
            <span className="font-mono text-xs">{candidate.reference}</span> · {candidate.email}
          </p>
        </div>
        <Link className="btn btn-secondary" href="/candidates">
          Back to pipeline
        </Link>
      </header>

      {openDuplicates.length > 0 && (
        <Card
          title="This person may already exist"
          description="Nothing is merged automatically. Decide, and both records stay on file either way."
        >
          <ul className="space-y-3">
            {openDuplicates.map((flag) => (
              <li key={flag.id} className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <Badge tone={flag.score >= 90 ? 'danger' : 'warning'}>{flag.score}%</Badge>
                  <p className="mt-1 text-sm text-ink-800">{flag.reason}</p>
                </div>
                {canWrite && <ResolveDuplicate flagId={flag.id} name={candidate.fullName} />}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Relationship">
          <dl>
            <FieldRow label="Source">{candidate.sourceChannel?.name ?? '—'}</FieldRow>
            <FieldRow label="Campaign">
              {candidate.campaign ? `${candidate.campaign.code} · ${candidate.campaign.name}` : '—'}
            </FieldRow>
            <FieldRow label="Referred by">{candidate.referredByExpert?.fullName ?? '—'}</FieldRow>
            <FieldRow label="Owner">{candidate.relationshipOwner?.name ?? 'unassigned'}</FieldRow>
            <FieldRow label="Next action">
              {candidate.nextActionAt ? (
                <>
                  {formatDate(candidate.nextActionAt)}
                  <div className="text-xs text-ink-500">{candidate.nextActionNote}</div>
                </>
              ) : (
                '—'
              )}
            </FieldRow>
            <FieldRow label="Became expert">
              {candidate.expert ? (
                <Link
                  className="text-accent-600 hover:underline"
                  href={`/experts/${candidate.expert.id}`}
                >
                  {candidate.expert.reference}
                </Link>
              ) : (
                'not yet'
              )}
            </FieldRow>
          </dl>
          {candidate.notes && <p className="mt-3 text-sm text-ink-600">{candidate.notes}</p>}
        </Card>

        <Card title="Applications" className="lg:col-span-2">
          {candidate.applications.length === 0 ? (
            <EmptyState title="No applications on file" />
          ) : (
            <ul className="space-y-2">
              {candidate.applications.map((application) => (
                <li key={application.id} className="rounded-lg border border-ink-200 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{application.reference}</span>
                    <StatusBadge status={application.status} />
                    <span className="text-sm text-ink-800">{application.domain.name}</span>
                    <span className="text-xs text-ink-500">
                      {formatRelative(application.submittedAt)}
                    </span>
                  </div>
                  {Array.isArray(application.workSampleLinks) &&
                    application.workSampleLinks.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {(application.workSampleLinks as string[]).map((link) => (
                          <li key={link} className="text-ink-600">
                            {/* Recorded as text. The application never fetches it. */}
                            <code>{link}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Screenings"
        description="A screening runs against one immutable rubric version and keeps it forever."
        actions={<ProvenanceTag kind="operator" />}
      >
        {candidate.screenings.length === 0 ? (
          <div className="space-y-3">
            <EmptyState title="No screening started" />
            {canScreen && publishedVersions.length > 0 && (
              <StartScreeningPanel candidateId={candidate.id} versions={publishedVersions} />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {candidate.screenings.map((screening) => (
              <div key={screening.id} className="rounded-lg border border-ink-200 px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs">{screening.reference}</span>
                  <StatusBadge status={screening.status} />
                  <span className="text-sm text-ink-800">
                    {screening.rubricVersion.template.domain.name}, rubric v
                    {screening.rubricVersion.version}
                  </span>
                  <span className="text-xs text-ink-500" title={formatDateTime(screening.dueAt)}>
                    due {formatRelative(screening.dueAt)}
                  </span>
                </div>

                {screening.submissions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {screening.submissions.map((submission) => (
                      <div key={submission.id} className="text-xs">
                        <Badge tone={submission.isComplete ? 'success' : 'warning'}>
                          revision {submission.revision}
                          {submission.isComplete ? ' complete' : ' incomplete'}
                        </Badge>{' '}
                        <span className="text-ink-500">
                          {formatRelative(submission.submittedAt)}
                        </span>
                        {Array.isArray(submission.missingEvidence) &&
                          submission.missingEvidence.length > 0 && (
                            <ul className="mt-0.5 list-disc pl-5 text-amber-800">
                              {(submission.missingEvidence as string[]).map((missing) => (
                                <li key={missing}>{missing}</li>
                              ))}
                            </ul>
                          )}
                      </div>
                    ))}
                  </div>
                )}

                {screening.reviews.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {screening.reviews.map((review) => (
                      <li key={review.id} className="text-ink-700">
                        {review.reviewer.name}: <strong>{review.decision ?? review.state}</strong>
                        {review.publicFeedback ? ` — ${review.publicFeedback}` : ''}
                        {review.privateNotes ? (
                          <span className="ml-1 rounded bg-ink-100 px-1 text-ink-600">
                            internal: {review.privateNotes}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}

                {screening.conflict && screening.conflict.status === 'OPEN' && (
                  <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-xs text-rose-800">
                    Reviewers disagree: {screening.conflict.summary}. The system will not choose; an
                    admin must record a resolution.
                  </p>
                )}

                {canDecide && ['SUBMITTED', 'IN_REVIEW'].includes(screening.status) && (
                  <div className="mt-3">
                    <ScreeningDecisionPanel
                      screeningId={screening.id}
                      reference={screening.reference}
                      hasOpenConflict={screening.conflict?.status === 'OPEN'}
                      canResolveConflict={roleHasCapability(
                        operator.role,
                        'screening:resolve_conflict',
                      )}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card
        title="History"
        description="Append-only record of everything that touched this person."
      >
        {activity.events.length === 0 ? (
          <EmptyState title="No history yet" />
        ) : (
          <ol className="space-y-2">
            {activity.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <span
                  className="text-xs tabular-nums text-ink-400"
                  title={formatDateTime(event.createdAt)}
                >
                  {formatRelative(event.createdAt)}
                </span>
                <StatusBadge status={event.actorType} />
                <span className="text-ink-800">{event.summary}</span>
                <code className="text-[0.7rem] text-ink-400">{event.action}</code>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
