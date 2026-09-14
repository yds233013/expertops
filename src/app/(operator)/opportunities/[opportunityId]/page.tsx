import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatRelative } from '@/lib/time';
import { requireCapability } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { getOpportunity, toPublicOpportunity } from '@/server/services/opportunities';
import { listApplicationsForOpportunity } from '@/server/services/applications';
import { OpportunityActions } from '@/components/opportunity-actions';
import { OpportunityForm } from '@/components/opportunity-form';
import { Alert, Badge, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

const STAGE_FILTERS = [
  'NEW',
  'SCREENING_INVITED',
  'SCREENING_SUBMITTED',
  'IN_REVIEW',
  'QUALIFIED',
  'REJECTED',
] as const;

export default async function OpportunityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ opportunityId: string }>;
  searchParams: Promise<{ search?: string; stage?: string }>;
}) {
  const { operator } = await requireCapability('campaign:read');
  const { opportunityId } = await params;
  const query = await searchParams;

  const opportunity = await getOpportunity(prisma, opportunityId);
  const applications = await listApplicationsForOpportunity(prisma, opportunityId, {
    search: query.search,
    stage: STAGE_FILTERS.includes(query.stage as never) ? query.stage : undefined,
  });

  const canWrite = roleHasCapability(operator.role, 'campaign:write');
  const preview = toPublicOpportunity(opportunity);
  const [domains, projects, campaigns] = await Promise.all([
    prisma.domain.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.project.findMany({
      where: { status: { notIn: ['CLOSED', 'CANCELLED'] } },
      select: { id: true, code: true, title: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sourcingCampaign.findMany({ select: { id: true, name: true }, take: 50 }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={opportunity.title}
        meta={<StatusBadge status={opportunity.status} />}
        description={
          <>
            <span className="font-mono">{opportunity.reference}</span> · {opportunity.domain.name}
            {opportunity.project && (
              <>
                {' · '}
                <Link
                  className="text-accent-600 hover:underline"
                  href={`/projects/${opportunity.project.id}`}
                >
                  {opportunity.project.code}
                </Link>
              </>
            )}
          </>
        }
        actions={
          <Link className="btn btn-secondary" href="/opportunities">
            All opportunities
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card
          title="Preview"
          description="Exactly what an applicant sees. Internal notes are not on it."
        >
          <div className="rounded-lg border border-ink-200 bg-ink-50 px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="section-title">{preview.title}</h3>
              <Badge tone={preview.kind === 'NETWORK_MEMBERSHIP' ? 'muted' : 'info'}>
                {preview.kind === 'NETWORK_MEMBERSHIP' ? 'Expert network' : 'Project engagement'}
              </Badge>
            </div>
            {preview.summary && <p className="mt-1 text-sm text-ink-700">{preview.summary}</p>}
            <dl className="mt-2 text-xs text-ink-600">
              <div>
                {preview.domainName}
                {(preview.weeklyHoursMin || preview.weeklyHoursMax) && (
                  <>
                    {' · '}
                    {preview.weeklyHoursMin ?? '—'}–{preview.weeklyHoursMax ?? '—'} h/week
                  </>
                )}
                {preview.applicationDeadline && (
                  <> · apply by {formatDate(preview.applicationDeadline)}</>
                )}
              </div>
            </dl>
            {preview.description && (
              <p className="mt-2 whitespace-pre-wrap text-sm text-ink-700">{preview.description}</p>
            )}
            {preview.requiredSkills.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {preview.requiredSkills.map((skill) => (
                  <Badge key={skill} tone="info">
                    {skill}
                  </Badge>
                ))}
              </div>
            )}
            {preview.questions.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-ink-600">
                {preview.questions.map((question) => (
                  <li key={question.key}>
                    {question.label}
                    {question.required ? '' : ' (optional)'}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {opportunity.status === 'PUBLISHED' && (
            <p className="mt-2 text-xs text-ink-500">
              Live at{' '}
              <Link
                className="text-accent-600 hover:underline"
                href={`/apply/opportunities/${opportunity.slug}`}
              >
                /apply/opportunities/{opportunity.slug}
              </Link>
            </p>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Status">
            {canWrite ? (
              <OpportunityActions opportunityId={opportunity.id} status={opportunity.status} />
            ) : (
              <p className="text-sm text-ink-600">
                Your role can read opportunities but not publish or close them.
              </p>
            )}
          </Card>

          <Card title="Internal notes" description="Never rendered on a candidate-facing page.">
            {opportunity.internalNotes ? (
              <p className="whitespace-pre-wrap text-sm text-ink-700">
                {opportunity.internalNotes}
              </p>
            ) : (
              <p className="text-sm text-ink-500">Nothing recorded.</p>
            )}
          </Card>
        </div>
      </div>

      <Card
        title={`Applicants (${applications.length})`}
        description="Open one to read what they submitted and send a screening."
      >
        <form className="mb-3 flex flex-wrap items-end gap-3" method="get">
          <div className="min-w-56 flex-1">
            <label className="label" htmlFor="applicant-search">
              Search
            </label>
            <input
              id="applicant-search"
              name="search"
              className="input"
              defaultValue={query.search ?? ''}
              placeholder="Name, email or reference"
            />
          </div>
          <div className="w-56">
            <label className="label" htmlFor="applicant-stage">
              Stage
            </label>
            <select
              id="applicant-stage"
              name="stage"
              className="select"
              defaultValue={query.stage ?? ''}
            >
              <option value="">All stages</option>
              {STAGE_FILTERS.map((stage) => (
                <option key={stage} value={stage}>
                  {stage.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-secondary" type="submit">
            Apply
          </button>
        </form>

        {applications.length === 0 ? (
          <EmptyState
            title="No applications yet"
            hint={
              opportunity.status === 'PUBLISHED'
                ? 'They appear here as people apply.'
                : 'This opportunity is not published, so nobody can apply to it.'
            }
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Application</th>
                  <th>Applicant</th>
                  <th>Stage</th>
                  <th>Submitted</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((application) => (
                  <tr key={application.id}>
                    <td>
                      <Link
                        className="font-mono text-accent-600 hover:underline"
                        href={`/opportunities/${opportunity.id}/applicants/${application.id}`}
                      >
                        {application.reference}
                      </Link>
                      {application.withdrawnAt && (
                        <div className="mt-1">
                          <Badge tone="muted">withdrawn</Badge>
                        </div>
                      )}
                    </td>
                    <td>
                      <Link
                        className="font-medium text-accent-600 hover:underline"
                        href={`/candidates/${application.candidate.id}`}
                      >
                        {application.candidate.fullName}
                      </Link>
                      <div className="text-xs text-ink-500">{application.candidate.email}</div>
                    </td>
                    <td>
                      <StatusBadge status={application.candidate.stage} />
                    </td>
                    <td className="text-xs" title={application.submittedAt.toISOString()}>
                      {formatRelative(application.submittedAt)}
                    </td>
                    <td className="text-xs text-ink-700">{nextAction(application)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {canWrite && opportunity.status !== 'CLOSED' && (
        <Card
          title="Edit"
          description="Editing a published opportunity changes what new applicants see. It never changes what earlier applicants submitted."
        >
          <Alert tone="info" className="mb-3">
            Each application keeps a copy of this opportunity as it read when it was submitted.
          </Alert>
          <OpportunityForm
            domains={domains}
            projects={projects}
            campaigns={campaigns}
            existing={{
              id: opportunity.id,
              title: opportunity.title,
              kind: opportunity.kind,
              projectId: opportunity.projectId,
              summary: opportunity.summary,
              description: opportunity.description,
              responsibilities: opportunity.responsibilities,
              requiredSkills: (opportunity.requiredSkills as string[]) ?? [],
              questions: (
                (opportunity.questions as unknown as Array<{
                  label: string;
                  helpText?: string;
                  required: boolean;
                }>) ?? []
              ).map((question) => ({
                label: question.label,
                helpText: question.helpText ?? '',
                required: question.required,
              })),
              weeklyHoursMin: opportunity.weeklyHoursMin,
              weeklyHoursMax: opportunity.weeklyHoursMax,
              applicationDeadline: opportunity.applicationDeadline?.toISOString() ?? null,
              compensationNote: opportunity.compensationNote,
              internalNotes: opportunity.internalNotes,
            }}
          />
        </Card>
      )}
    </div>
  );
}

function nextAction(application: {
  withdrawnAt: Date | null;
  candidate: { stage: string; expertId: string | null };
}): string {
  if (application.withdrawnAt) return 'Withdrawn by the applicant. Nothing to do.';
  switch (application.candidate.stage) {
    case 'NEW':
      return 'Read the application, then send a screening.';
    case 'SCREENING_INVITED':
      return 'Waiting on the applicant to submit.';
    case 'SCREENING_SUBMITTED':
    case 'IN_REVIEW':
      return 'Score the screening and decide.';
    case 'REVISION_REQUESTED':
      return 'Waiting on a revised submission.';
    case 'QUALIFIED':
      return application.candidate.expertId
        ? 'Qualified. Invite them to a project.'
        : 'Qualified. Record their skills.';
    case 'REJECTED':
      return 'Decided.';
    default:
      return 'Read the application.';
  }
}
