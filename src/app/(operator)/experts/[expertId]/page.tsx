import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { getExpert } from '@/server/services/experts';
import { VerifyPanel } from '@/components/verify-panel';
import { Badge, Card, EmptyState, FieldRow, ProvenanceTag, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ExpertDetailPage({
  params,
}: {
  params: Promise<{ expertId: string }>;
}) {
  const operator = await requireOperator();
  const { expertId } = await params;
  const expert = await getExpert(prisma, expertId);
  const activity = await listActivity(prisma, { expertId, limit: 40 });

  const canVerify = roleHasCapability(operator.role, 'onboarding:verify');
  const onboardingCase = expert.onboardingCase;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-ink-900">{expert.fullName}</h1>
            <StatusBadge status={expert.status} />
          </div>
          <p className="mt-1 text-sm text-ink-600">
            <span className="font-mono text-xs">{expert.reference}</span> · {expert.headline}
          </p>
        </div>
        <Link className="btn btn-secondary" href="/experts">
          Back to network
        </Link>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Profile" className="lg:col-span-1">
          <dl>
            <FieldRow label="Email">{expert.email}</FieldRow>
            <FieldRow label="Experience">{expert.yearsExperience} years</FieldRow>
            <FieldRow label="Rate">
              {centsToRateDisplay(expert.hourlyRateCents, expert.currency)}
            </FieldRow>
            <FieldRow label="Timezone">{expert.timezone}</FieldRow>
            <FieldRow label="Capacity">{expert.weeklyCapacityHours} h/week</FieldRow>
            <FieldRow label="Added">{formatDate(expert.createdAt)}</FieldRow>
          </dl>
          {expert.bio && <p className="mt-3 text-sm text-ink-600">{expert.bio}</p>}
        </Card>

        <Card title="Skills" description="Self-reported, adjustable by an operator.">
          {expert.skills.length === 0 ? (
            <EmptyState title="No skills recorded" />
          ) : (
            <ul className="space-y-1.5">
              {expert.skills.map((link) => (
                <li key={link.id} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink-800">{link.skill.name}</span>
                  <Badge tone="muted" title={`${link.yearsUsed} years used`}>
                    {link.proficiency}/5
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="Onboarding"
          description="Submitted by the expert, verified by a human operator."
          actions={<ProvenanceTag kind="operator" />}
        >
          {!onboardingCase ? (
            <EmptyState
              title="No onboarding case"
              hint="A case opens automatically when the expert accepts an invitation."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <StatusBadge status={onboardingCase.status} />
                <span className="text-xs text-ink-500">
                  {onboardingCase.submittedAt
                    ? `submitted ${formatRelative(onboardingCase.submittedAt)}`
                    : 'not submitted'}
                </span>
              </div>
              <ul className="space-y-1 text-sm">
                {onboardingCase.items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3">
                    <span className={item.completedAt ? 'text-ink-800' : 'text-ink-400'}>
                      {item.label}
                      {!item.required && <span className="text-ink-400"> (optional)</span>}
                    </span>
                    <Badge tone={item.completedAt ? 'success' : 'muted'}>
                      {item.completedAt ? 'done' : 'open'}
                    </Badge>
                  </li>
                ))}
              </ul>
              {onboardingCase.items.some((item) => item.value && item.kind !== 'ATTESTATION') && (
                <dl className="border-t border-ink-100 pt-2">
                  {onboardingCase.items
                    .filter((item) => item.value && item.kind !== 'ATTESTATION')
                    .map((item) => (
                      <FieldRow key={item.id} label={item.key.replace(/_/g, ' ')}>
                        {item.value}
                      </FieldRow>
                    ))}
                </dl>
              )}
              {onboardingCase.decisionNote && (
                <p className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-600">
                  Operator note: {onboardingCase.decisionNote}
                </p>
              )}
              {onboardingCase.status === 'SUBMITTED' && canVerify && (
                <VerifyPanel expertId={expert.id} expertName={expert.fullName} />
              )}
              {onboardingCase.status === 'SUBMITTED' && !canVerify && (
                <p className="text-xs text-ink-500">
                  Your role cannot verify submissions. Ask an operator or admin to review.
                </p>
              )}
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Invitations">
          {expert.invitations.length === 0 ? (
            <EmptyState title="No invitations yet" />
          ) : (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Expires</th>
                    <th>Responded</th>
                  </tr>
                </thead>
                <tbody>
                  {expert.invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/projects/${invitation.projectId}`}
                        >
                          {invitation.project.code}
                        </Link>
                        <div className="text-xs text-ink-500">{invitation.project.title}</div>
                      </td>
                      <td>
                        <StatusBadge status={invitation.status} />
                      </td>
                      <td className="text-ink-600">{formatDateTime(invitation.expiresAt)}</td>
                      <td className="text-ink-600">
                        {invitation.respondedAt ? formatRelative(invitation.respondedAt) : '—'}
                        {invitation.declineReason && (
                          <div className="text-xs text-ink-500">{invitation.declineReason}</div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Availability and seats">
          <div className="space-y-4">
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Declared availability
              </h3>
              {expert.availability.length === 0 ? (
                <p className="text-sm text-ink-500">None declared.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {expert.availability.map((window) => (
                    <li key={window.id} className="flex items-center justify-between gap-3">
                      <span className="text-ink-800">
                        {formatDate(window.startAt)} → {formatDate(window.endAt)}
                        {window.project && (
                          <span className="text-ink-500"> · {window.project.code}</span>
                        )}
                      </span>
                      <Badge tone="info">{window.hoursPerWeek} h/week</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-500">
                Assignments
              </h3>
              {expert.assignments.length === 0 ? (
                <p className="text-sm text-ink-500">Not staffed on any project.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {expert.assignments.map((assignment) => (
                    <li key={assignment.id} className="flex items-center justify-between gap-3">
                      <Link
                        className="text-accent-600 hover:underline"
                        href={`/projects/${assignment.projectId}`}
                      >
                        {assignment.project.code} · {assignment.project.title}
                      </Link>
                      <StatusBadge status={assignment.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="History"
        description="Append-only record of everything that touched this expert."
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
