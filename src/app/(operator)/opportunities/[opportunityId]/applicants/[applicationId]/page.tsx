import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@/lib/db';
import { formatDateTime, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { getApplication } from '@/server/services/applications';
import { StartScreeningPanel } from '@/components/start-screening-panel';
import { Alert, Badge, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

interface SnapshotQuestion {
  key: string;
  label: string;
  required: boolean;
}

/**
 * One application, as the reviewing operator sees it.
 *
 * The questions rendered here come from the snapshot taken when the person
 * submitted, not from the opportunity as it reads today. An operator who edits
 * the questions next week must not silently relabel answers given last week.
 */
export default async function ApplicantPage({
  params,
}: {
  params: Promise<{ opportunityId: string; applicationId: string }>;
}) {
  const { operator } = await requireCapability('candidate:read');
  const { opportunityId, applicationId } = await params;

  const application = await getApplication(prisma, applicationId);
  if (application.opportunityId !== opportunityId) notFound();

  const canScreen = roleHasCapability(operator.role, 'screening:write');
  const publishedVersions = await prisma.screeningRubricVersion.findMany({
    where: { status: 'PUBLISHED' },
    include: { template: { select: { name: true } } },
    orderBy: { publishedAt: 'desc' },
    take: 50,
  });

  const snapshot = (application.opportunitySnapshot ?? {}) as {
    title?: string;
    reference?: string;
    capturedAt?: string;
    questions?: SnapshotQuestion[];
    requiredSkills?: string[];
  };
  const answers = (application.answers ?? {}) as Record<string, string>;
  const claimedSkills = (application.claimedSkills as string[]) ?? [];
  const links = (application.workSampleLinks as string[]) ?? [];
  const questions = snapshot.questions ?? [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={application.candidate.fullName}
        meta={<StatusBadge status={application.candidate.stage} />}
        description={
          <>
            <span className="font-mono">{application.reference}</span> ·{' '}
            {application.candidate.email} · applied {formatRelative(application.submittedAt)}
          </>
        }
        actions={
          <>
            <Link className="btn btn-secondary" href={`/opportunities/${opportunityId}`}>
              Back to applicants
            </Link>
            <Link className="btn btn-secondary" href={`/candidates/${application.candidate.id}`}>
              Candidate record
            </Link>
          </>
        }
      />

      {application.withdrawnAt && (
        <Alert tone="warning">
          Withdrawn by the applicant {formatRelative(application.withdrawnAt)}
          {application.withdrawReason ? `: ${application.withdrawReason}` : '.'}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-4">
          <Card
            title="What they submitted"
            description={
              snapshot.capturedAt
                ? `Against "${snapshot.title}" as it read on ${formatDateTime(new Date(snapshot.capturedAt))}.`
                : undefined
            }
          >
            <div>
              <h3 className="section-title">Relevant experience</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm text-ink-800">
                {application.experience || <span className="text-ink-500">Nothing given.</span>}
              </p>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="section-title">Skills they claim</h3>
                {claimedSkills.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-500">None listed.</p>
                ) : (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {claimedSkills.map((skill) => (
                      <Badge key={skill} tone="neutral">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="field-hint">Claimed, not verified. A screening is what checks.</p>
              </div>
              <div>
                <h3 className="section-title">Availability</h3>
                <p className="mt-1 text-sm text-ink-800">
                  {application.weeklyHours ? `${application.weeklyHours} h/week` : 'Not given.'}
                </p>
              </div>
            </div>

            {questions.length > 0 && (
              <div className="mt-4">
                <h3 className="section-title">Their answers</h3>
                <dl className="mt-1 space-y-3">
                  {questions.map((question) => (
                    <div key={question.key}>
                      <dt className="attn-term">{question.label}</dt>
                      <dd className="mt-0.5 whitespace-pre-wrap text-sm text-ink-800">
                        {answers[question.key] || (
                          <span className="text-ink-500">Not answered.</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            <div className="mt-4">
              <h3 className="section-title">Evidence</h3>
              {links.length === 0 ? (
                <p className="mt-1 text-sm text-ink-500">No links given.</p>
              ) : (
                <ul className="mt-1 space-y-1 text-sm">
                  {links.map((link) => (
                    <li key={link} className="break-all font-mono text-xs text-ink-700">
                      {link}
                    </li>
                  ))}
                </ul>
              )}
              <p className="field-hint">
                Recorded as text. ExpertOps never opens them, so treat them as claims.
              </p>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card
            title="Send a screening"
            description="Scored against a published rubric version, which never changes once published."
          >
            {application.withdrawnAt ? (
              <p className="text-sm text-ink-600">
                This application is withdrawn. Reopening is the applicant&rsquo;s decision.
              </p>
            ) : !canScreen ? (
              <p className="text-sm text-ink-600">Your role cannot send screenings.</p>
            ) : publishedVersions.length === 0 ? (
              <EmptyState
                title="No published rubric"
                hint="Publish a rubric version first; a draft cannot be used to judge anyone."
              />
            ) : (
              <StartScreeningPanel
                candidateId={application.candidate.id}
                versions={publishedVersions.map((version) => ({
                  id: version.id,
                  label: `${version.template.name} · v${version.version}`,
                }))}
              />
            )}
          </Card>

          <Card title="Decisions">
            <p className="text-sm text-ink-600">
              Qualifying or rejecting is a human decision and lives on the candidate record with the
              screening it was based on.
            </p>
            <Link
              className="btn btn-secondary mt-2"
              href={`/candidates/${application.candidate.id}`}
            >
              Open the candidate record
            </Link>
          </Card>
        </div>
      </div>
    </div>
  );
}
