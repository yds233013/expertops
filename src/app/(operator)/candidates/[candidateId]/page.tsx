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
import { ActivityList } from '@/components/activity-list';
import {
  Badge,
  Card,
  EmptyState,
  FieldRow,
  NextAction,
  PageHeader,
  ProvenanceTag,
  StatusBadge,
} from '@/components/ui';

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

  const next = nextStepFor(candidate.stage, openDuplicates.length);

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ href: '/candidates', label: 'Candidate pipeline' }}
        eyebrow={<span className="font-mono">{candidate.reference}</span>}
        title={candidate.fullName}
        meta={
          <>
            <StatusBadge status={candidate.stage} />
            {candidate.contactOptOutAt && <Badge tone="muted">opted out of contact</Badge>}
          </>
        }
        description={[candidate.email, candidate.headline].filter(Boolean).join(' · ')}
      />

      {next && <NextAction title={next.title}>{next.detail}</NextAction>}

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

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
        <div className="min-w-0 space-y-5">
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
                  <div
                    key={screening.id}
                    className="rounded-lg border border-ink-200 bg-white px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs">{screening.reference}</span>
                      <StatusBadge status={screening.status} />
                      <span className="text-sm text-ink-800">
                        {screening.rubricVersion.template.domain.name}, rubric v
                        {screening.rubricVersion.version}
                      </span>
                      <span
                        className="text-xs text-ink-500"
                        title={formatDateTime(screening.dueAt)}
                      >
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
                            {review.reviewer.name}:{' '}
                            <strong>{review.decision ?? review.state}</strong>
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
                      <p className="alert alert-error mt-2 text-xs">
                        Reviewers disagree: {screening.conflict.summary}. The system will not
                        choose; an admin must record a resolution.
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

          <Card title="Applications">
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
          <Card
            title="History"
            description="Append-only record of everything that touched this person."
          >
            {activity.events.length === 0 ? (
              <EmptyState title="No history yet" />
            ) : (
              <ActivityList events={activity.events} />
            )}
          </Card>
        </div>
        <aside className="min-w-0 space-y-5">
          <Card title="Relationship">
            <dl>
              <FieldRow label="Source">{candidate.sourceChannel?.name ?? '—'}</FieldRow>
              <FieldRow label="Campaign">
                {candidate.campaign
                  ? `${candidate.campaign.code} · ${candidate.campaign.name}`
                  : '—'}
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
        </aside>
      </div>
    </div>
  );
}

/** What this person's record is waiting for, in the words an operator would use. */
function nextStepFor(stage: string, duplicates: number): { title: string; detail: string } | null {
  if (duplicates > 0) {
    return {
      title: 'Decide whether this is someone already on file',
      detail: 'The record is on hold until a person resolves the possible duplicate below.',
    };
  }
  switch (stage) {
    case 'NEW':
      return {
        title: 'Send a screening',
        detail: 'Choose a published rubric version under Screenings. The invitation is simulated.',
      };
    case 'SCREENING_INVITED':
      return {
        title: 'Waiting for the candidate to submit',
        detail: 'Reminders go out automatically, up to the reminder cap.',
      };
    case 'SCREENING_SUBMITTED':
    case 'IN_REVIEW':
      return {
        title: 'Review the submission',
        detail: 'Score it against the rubric, then request a revision, qualify or decline.',
      };
    case 'REVISION_REQUESTED':
      return {
        title: 'Waiting for a revised submission',
        detail: 'The candidate has the reviewer’s public feedback. Private notes stay here.',
      };
    default:
      return null;
  }
}
