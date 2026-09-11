import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { getProject } from '@/server/services/projects';
import { listStaffingCandidates } from '@/server/services/staffing';
import { ActionButton } from '@/components/action-button';
import { InviteButton } from '@/components/invite-button';
import { ProposeForm } from '@/components/propose-form';
import { WithdrawButton } from '@/components/withdraw-button';
import {
  Badge,
  Card,
  EmptyState,
  FieldRow,
  ProvenanceTag,
  ScoreBar,
  StatTile,
  StatusBadge,
} from '@/components/ui';

export const dynamic = 'force-dynamic';

interface Breakdown {
  requiredSkills: number;
  optionalSkills: number;
  seniority: number;
  rate: number;
  availability: number;
  standing: number;
  notes?: string[];
}

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const operator = await requireOperator();
  const { projectId } = await params;
  const project = await getProject(prisma, projectId);
  const [activity, staffingCandidates] = await Promise.all([
    listActivity(prisma, { projectId, limit: 60 }),
    listStaffingCandidates(prisma, projectId),
  ]);

  const canMatch = roleHasCapability(operator.role, 'matching:run');
  const canInvite = roleHasCapability(operator.role, 'invitation:send');
  const canStaff = roleHasCapability(operator.role, 'staffing:propose');
  const canConfirm = roleHasCapability(operator.role, 'staffing:confirm');
  const canStatus = roleHasCapability(operator.role, 'project:status');

  const matchRun = project.matchRuns[0] ?? null;
  const rankedCandidates = matchRun?.candidates.filter((candidate) => !candidate.excluded) ?? [];
  const excludedCandidates = matchRun?.candidates.filter((candidate) => candidate.excluded) ?? [];
  const invitedExpertIds = new Set(
    project.invitations
      .filter((invitation) => ['DRAFT', 'SENT', 'ACCEPTED'].includes(invitation.status))
      .map((invitation) => invitation.expertId),
  );

  const seatsLeft = project.seatsRequested - project.seatsFilled;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-ink-900">{project.title}</h1>
            <StatusBadge status={project.status} />
          </div>
          <p className="mt-1 text-sm text-ink-600">
            <span className="font-mono text-xs">{project.code}</span> · {project.clientName} ·
            created by {project.createdBy.name}
          </p>
        </div>
        <Link className="btn btn-secondary" href="/projects">
          Back to projects
        </Link>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Seats"
          value={`${project.seatsFilled}/${project.seatsRequested}`}
          hint={seatsLeft > 0 ? `${seatsLeft} open` : 'full'}
          tone={seatsLeft > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Invitations"
          value={project.invitations.length}
          hint={`${project.invitations.filter((i) => i.status === 'ACCEPTED').length} accepted`}
          tone="info"
        />
        <StatTile
          label="Candidates ranked"
          value={matchRun?.candidateCount ?? 0}
          hint={matchRun ? matchRun.algorithmVersion : 'no run yet'}
          tone="neutral"
        />
        <StatTile
          label="Ready to staff"
          value={staffingCandidates.filter((candidate) => candidate.staffable).length}
          hint="verified + available"
          tone="success"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Brief" className="lg:col-span-2">
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <FieldRow label="Client">{project.clientName}</FieldRow>
            <FieldRow label="Seats">{project.seatsRequested}</FieldRow>
            <FieldRow label="Min. experience">{project.minYearsExperience} years</FieldRow>
            <FieldRow label="Rate ceiling">
              {project.maxHourlyRateCents ? centsToRateDisplay(project.maxHourlyRateCents) : 'none'}
            </FieldRow>
            <FieldRow label="Timezone">{project.preferredTimezone}</FieldRow>
            <FieldRow label="Dates">
              {formatDate(project.startDate)} → {formatDate(project.endDate)}
            </FieldRow>
          </dl>
          {project.description && (
            <p className="mt-3 text-sm text-ink-600">{project.description}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-1">
            {project.requirements.map((requirement) => (
              <Badge
                key={requirement.id}
                tone={requirement.required ? 'info' : 'muted'}
                title={`min proficiency ${requirement.minProficiency}, weight ${requirement.weight}`}
              >
                {requirement.skill.name}
                {requirement.required ? ' (required)' : ''}
              </Badge>
            ))}
          </div>
        </Card>

        <Card
          title="Workflow controls"
          description="Status changes are explicit operator actions."
          actions={<ProvenanceTag kind="operator" />}
        >
          <div className="flex flex-col gap-2">
            {canStatus && project.status === 'DRAFT' && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'MATCHING' }}
                label="Open for matching"
                variant="primary"
              />
            )}
            {canStatus && project.status === 'MATCHING' && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'INVITING' }}
                label="Move to inviting"
              />
            )}
            {canStatus && ['STAFFING', 'ACTIVE'].includes(project.status) && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'CLOSED' }}
                label="Close project"
                confirm="Closing is final. The project can no longer be edited or staffed."
              />
            )}
            {canMatch && ['MATCHING', 'INVITING', 'STAFFING'].includes(project.status) && (
              <ActionButton
                url={`/api/projects/${project.id}/match`}
                body={{ limit: 15, includeExcluded: true }}
                label={matchRun ? 'Re-run matching' : 'Run matching'}
                variant="primary"
                pendingLabel="Scoring…"
              />
            )}
            {!canStatus && !canMatch && (
              <p className="text-xs text-ink-500">Your role is read-only for this project.</p>
            )}
          </div>
        </Card>
      </div>

      <Card
        title="Matching"
        description={
          matchRun
            ? `${matchRun.algorithmVersion} · ${matchRun.consideredCount} considered · ${matchRun.candidateCount} ranked · ${matchRun.excludedCount} excluded · ${formatRelative(matchRun.createdAt)}`
            : 'Deterministic rules-based scoring. No language model is involved.'
        }
        actions={<ProvenanceTag kind="automated" />}
      >
        {!matchRun ? (
          <EmptyState
            title="No match run yet"
            hint="Open the project for matching, then run the scorer."
          />
        ) : rankedCandidates.length === 0 ? (
          <EmptyState
            title="Every expert was excluded by a hard filter"
            hint="Loosen a required skill or the experience bar, then run matching again."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Expert</th>
                  <th>Score</th>
                  <th>Why</th>
                  <th>Status</th>
                  <th>Rate</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {rankedCandidates.map((candidate) => {
                  const breakdown = candidate.breakdown as unknown as Breakdown;
                  return (
                    <tr key={candidate.id}>
                      <td className="tabular-nums text-ink-500">{candidate.rank}</td>
                      <td>
                        <Link
                          className="font-medium text-ink-900 hover:underline"
                          href={`/experts/${candidate.expertId}`}
                        >
                          {candidate.expert.fullName}
                        </Link>
                        <div className="text-xs text-ink-500">{candidate.expert.headline}</div>
                      </td>
                      <td>
                        <ScoreBar score={candidate.score} />
                      </td>
                      <td className="max-w-72 text-xs text-ink-600">
                        <span title="Weighted contribution to the score">
                          skills {breakdown.requiredSkills + breakdown.optionalSkills} · seniority{' '}
                          {breakdown.seniority} · rate {breakdown.rate} · availability{' '}
                          {breakdown.availability} · standing {breakdown.standing}
                        </span>
                        {breakdown.notes?.length ? (
                          <div className="mt-0.5 text-amber-800">{breakdown.notes.join('; ')}</div>
                        ) : null}
                      </td>
                      <td>
                        <StatusBadge status={candidate.expert.status} />
                      </td>
                      <td className="tabular-nums">
                        {centsToRateDisplay(
                          candidate.expert.hourlyRateCents,
                          candidate.expert.currency,
                        )}
                      </td>
                      <td>
                        {canInvite ? (
                          <InviteButton
                            projectId={project.id}
                            expertId={candidate.expertId}
                            expertName={candidate.expert.fullName}
                            matchCandidateId={candidate.id}
                            disabled={invitedExpertIds.has(candidate.expertId) || seatsLeft <= 0}
                            disabledReason={
                              invitedExpertIds.has(candidate.expertId)
                                ? 'Already invited'
                                : 'All seats filled'
                            }
                          />
                        ) : (
                          <span className="text-xs text-ink-400">No permission</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {excludedCandidates.length > 0 && (
          <details className="mt-3 rounded-lg border border-ink-200 px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-ink-700">
              {excludedCandidates.length} expert(s) excluded by a hard filter — show reasons
            </summary>
            <ul className="mt-2 space-y-1 text-xs">
              {excludedCandidates.map((candidate) => (
                <li key={candidate.id} className="flex flex-wrap items-baseline gap-2">
                  <Link
                    className="font-medium text-ink-800 hover:underline"
                    href={`/experts/${candidate.expertId}`}
                  >
                    {candidate.expert.fullName}
                  </Link>
                  <StatusBadge status={candidate.expert.status} />
                  <span className="text-rose-700">{candidate.exclusionReason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      <Card
        title="Invitations"
        description="The worker renders each invitation into the simulated outbox and marks it sent."
        actions={<ProvenanceTag kind="simulated" />}
      >
        {project.invitations.length === 0 ? (
          <EmptyState title="No invitations yet" hint="Invite a ranked candidate above." />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Expert</th>
                  <th>Status</th>
                  <th>Sent</th>
                  <th>Deadline</th>
                  <th>Response</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {project.invitations.map((invitation) => (
                  <tr key={invitation.id}>
                    <td>
                      <Link
                        className="font-medium text-ink-900 hover:underline"
                        href={`/experts/${invitation.expertId}`}
                      >
                        {invitation.expert.fullName}
                      </Link>
                      <div className="text-xs text-ink-500">{invitation.expert.email}</div>
                    </td>
                    <td>
                      <StatusBadge status={invitation.status} />
                    </td>
                    <td className="text-ink-600">
                      {invitation.sentAt ? formatRelative(invitation.sentAt) : 'queued'}
                    </td>
                    <td className="text-ink-600" title={formatDateTime(invitation.expiresAt)}>
                      {formatRelative(invitation.expiresAt)}
                    </td>
                    <td className="text-ink-600">
                      {invitation.respondedAt ? formatRelative(invitation.respondedAt) : '—'}
                      {invitation.declineReason && (
                        <div className="text-xs text-ink-500">{invitation.declineReason}</div>
                      )}
                      {invitation.withdrawReason && (
                        <div className="text-xs text-ink-500">{invitation.withdrawReason}</div>
                      )}
                    </td>
                    <td>
                      {['DRAFT', 'SENT'].includes(invitation.status) &&
                      roleHasCapability(operator.role, 'invitation:withdraw') ? (
                        <WithdrawButton invitationId={invitation.id} />
                      ) : (
                        <span className="text-xs text-ink-400">—</span>
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
        title="Staffing"
        description="Only experts who accepted, declared availability, and were verified by an operator can take a seat."
        actions={<ProvenanceTag kind="operator" />}
      >
        {staffingCandidates.length === 0 ? (
          <EmptyState
            title="Nobody has accepted yet"
            hint="Accepted experts appear here with their onboarding and availability state."
          />
        ) : (
          <div className="scroll-x">
            <table className="data">
              <thead>
                <tr>
                  <th>Expert</th>
                  <th>Expert status</th>
                  <th>Declared</th>
                  <th>Assignment</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {staffingCandidates.map((candidate) => (
                  <tr key={candidate.invitation.id}>
                    <td>
                      <Link
                        className="font-medium text-ink-900 hover:underline"
                        href={`/experts/${candidate.expert.id}`}
                      >
                        {candidate.expert.fullName}
                      </Link>
                      <div className="text-xs text-ink-500">
                        accepted {formatRelative(candidate.invitation.respondedAt)}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={candidate.expert.status} />
                    </td>
                    <td className="tabular-nums">
                      {candidate.declaredHours > 0 ? `${candidate.declaredHours} h/week` : '—'}
                    </td>
                    <td>
                      {candidate.existingAssignment ? (
                        <StatusBadge status={candidate.existingAssignment.status} />
                      ) : (
                        <span className="text-xs text-ink-400">none</span>
                      )}
                    </td>
                    <td>
                      {candidate.existingAssignment?.status === 'PROPOSED' && canConfirm ? (
                        <div className="flex flex-wrap gap-2">
                          <ActionButton
                            url={`/api/assignments/${candidate.existingAssignment.id}/confirm`}
                            label="Confirm seat"
                            variant="primary"
                            pendingLabel="Confirming…"
                          />
                          <ActionButton
                            url={`/api/assignments/${candidate.existingAssignment.id}/release`}
                            body={{ reason: 'Proposal withdrawn by operator' }}
                            label="Withdraw proposal"
                          />
                        </div>
                      ) : candidate.existingAssignment?.status === 'CONFIRMED' &&
                        roleHasCapability(operator.role, 'staffing:release') ? (
                        <ActionButton
                          url={`/api/assignments/${candidate.existingAssignment.id}/release`}
                          body={{ reason: 'Released by operator' }}
                          label="Release seat"
                          variant="danger"
                          confirm="This frees the seat and queues a simulated email to the expert."
                        />
                      ) : candidate.blockedReason ? (
                        <span className="text-xs text-amber-800">{candidate.blockedReason}</span>
                      ) : canStaff ? (
                        <ProposeForm
                          projectId={project.id}
                          expertId={candidate.expert.id}
                          expertName={candidate.expert.fullName}
                          declaredHours={candidate.declaredHours}
                          defaultRateCents={candidate.expert.hourlyRateCents}
                        />
                      ) : (
                        <span className="text-xs text-ink-400">No permission</span>
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
        title="Project history"
        description="Append-only, attributed to operator, expert or worker."
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
