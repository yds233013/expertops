import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { getExpert } from '@/server/services/experts';
import { CONTACT_PREFERENCE_LABEL } from '@/server/services/contact-preferences';
import { ExpertProfileEditor } from '@/components/expert-profile-editor';
import { ExpertSkillsEditor } from '@/components/expert-skills-editor';
import { PortalLinkPanel } from '@/components/portal-link-panel';
import { VerifyPanel } from '@/components/verify-panel';
import { SimulatedDeliveryBadge } from '@/components/delivery-note';
import { ActivityList } from '@/components/activity-list';
import {
  Badge,
  Card,
  EmptyState,
  FieldRow,
  NextAction,
  PageHeader,
  ProvenanceTag,
  StatTile,
  StatusBadge,
} from '@/components/ui';

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
  // Gate on the capability the route actually checks, not on a neighbouring one.
  const canIssuePortalLink = roleHasCapability(operator.role, 'expert:write');
  const canWrite = roleHasCapability(operator.role, 'expert:write');
  const onboardingCase = expert.onboardingCase;

  const skillNames = (
    await prisma.skill.findMany({ select: { name: true }, orderBy: { name: 'asc' } })
  ).map((skill) => skill.name);

  const liveAssignments = expert.assignments.filter((a) => a.status !== 'RELEASED');
  const openInvitations = expert.invitations.filter((i) => ['DRAFT', 'SENT'].includes(i.status));

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ href: '/experts', label: 'Expert network' }}
        eyebrow={<span className="font-mono">{expert.reference}</span>}
        title={expert.fullName}
        meta={<StatusBadge status={expert.status} />}
        description={expert.headline}
      />

      {onboardingCase?.status === 'SUBMITTED' && (
        <NextAction title="Verify the onboarding submission">
          {canVerify
            ? 'The checklist is complete. Review the answers below and verify or return it.'
            : 'Your role cannot verify submissions. Ask an operator or admin to review.'}
        </NextAction>
      )}
      {expert.contactPreference === 'NO_CONTACT' && (
        <p className="alert alert-warning">
          <strong>Do not contact.</strong> This expert asked not to be contacted, so they are left
          out of matching and no message is queued for them.
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="min-w-0 space-y-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Seats" value={liveAssignments.length} sub="Proposed or confirmed" />
            <StatTile
              label="Open invitations"
              value={openInvitations.length}
              sub={`${expert.invitations.length} in total`}
            />
            <StatTile
              label="Onboarding"
              value={
                onboardingCase
                  ? `${onboardingCase.items.filter((item) => item.completedAt).length}/${onboardingCase.items.length}`
                  : '—'
              }
              sub={
                onboardingCase
                  ? onboardingCase.status.replace(/_/g, ' ').toLowerCase()
                  : 'No case opened'
              }
            />
            <StatTile
              label="Availability"
              value={expert.availability.length}
              sub={expert.availability.length === 1 ? 'window declared' : 'windows declared'}
            />
          </div>

          <Card title="Seats and availability">
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
          <div className="grid gap-5 2xl:grid-cols-2">
            <Card
              title="Skills"
              description="A project's required skills are a hard filter, so an expert with none recorded is excluded from every match."
            >
              {canWrite ? (
                <ExpertSkillsEditor
                  expertId={expert.id}
                  skillNames={skillNames}
                  initial={expert.skills.map((link) => ({
                    name: link.skill.name,
                    proficiency: link.proficiency,
                    yearsUsed: link.yearsUsed,
                  }))}
                />
              ) : expert.skills.length === 0 ? (
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

            {canWrite && (
              <Card
                title="Edit profile"
                description="Seniority, rate and capacity. Qualifying a candidate creates the expert without these, so they are filled in here."
              >
                <ExpertProfileEditor
                  expertId={expert.id}
                  initial={{
                    headline: expert.headline,
                    yearsExperience: expert.yearsExperience,
                    hourlyRateCents: expert.hourlyRateCents,
                    timezone: expert.timezone,
                    weeklyCapacityHours: expert.weeklyCapacityHours,
                  }}
                />
              </Card>
            )}
          </div>

          <Card flush title="Invitations">
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
                          {invitation.status === 'SENT' && <SimulatedDeliveryBadge />}
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

          <Card
            title="History"
            description="Append-only record of everything that touched this expert."
          >
            {activity.events.length === 0 ? (
              <EmptyState title="No history yet" />
            ) : (
              <ActivityList events={activity.events} />
            )}
          </Card>
        </div>

        <aside className="min-w-0 space-y-5">
          <Card title="Profile">
            <dl>
              <FieldRow label="Email">{expert.email}</FieldRow>
              <FieldRow label="Experience">{expert.yearsExperience} years</FieldRow>
              <FieldRow label="Rate">
                {centsToRateDisplay(expert.hourlyRateCents, expert.currency)}
              </FieldRow>
              <FieldRow label="Timezone">{expert.timezone}</FieldRow>
              <FieldRow label="Capacity">{expert.weeklyCapacityHours} h/week</FieldRow>
              <FieldRow label="Contact">
                <span
                  className={
                    expert.contactPreference === 'NO_CONTACT'
                      ? 'font-semibold text-rose-700'
                      : expert.contactPreference === 'UNKNOWN'
                        ? 'text-amber-800'
                        : undefined
                  }
                >
                  {CONTACT_PREFERENCE_LABEL[expert.contactPreference]}
                </span>
                <span className="mt-0.5 block text-xs text-ink-500">
                  {expert.contactPreferenceSetAt
                    ? `Set by them on ${formatDate(expert.contactPreferenceSetAt)}.`
                    : 'They have not set this themselves.'}
                </span>
              </FieldRow>
              <FieldRow label="Added">{formatDate(expert.createdAt)}</FieldRow>
            </dl>
            {expert.bio && <p className="mt-3 text-sm text-ink-600">{expert.bio}</p>}
          </Card>

          {canIssuePortalLink && (
            <Card
              title="Portal access"
              description="How this expert reaches their own portal. They never have a password."
            >
              <PortalLinkPanel expertId={expert.id} expertName={expert.fullName} />
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
