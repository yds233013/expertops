import Link from 'next/link';
import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { roleHasCapability } from '@/server/auth/permissions';
import { requireOperator } from '@/server/http/context';
import { listActivity } from '@/server/services/activity';
import { getProject } from '@/server/services/projects';
import { listStaffingCandidates } from '@/server/services/staffing';
import { SimulatedDeliveryBadge } from '@/components/delivery-note';
import { ActionButton } from '@/components/action-button';
import { InviteButton } from '@/components/invite-button';
import { ExpertSearchInvite } from '@/components/expert-search-invite';
import { ProposeForm } from '@/components/propose-form';
import { WithdrawButton } from '@/components/withdraw-button';
import { ActivityList } from '@/components/activity-list';
import {
  Badge,
  Card,
  EmptyState,
  KeyValue,
  KeyValueRow,
  NextAction,
  PageHeader,
  ProvenanceTag,
  ScoreBar,
  StatTile,
  StatusBadge,
  TableShell,
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
  const accepted = project.invitations.filter((i) => i.status === 'ACCEPTED').length;
  const awaitingReply = project.invitations.filter((i) => i.status === 'SENT').length;
  // Accepted invitations are already rows in the staffing table, so the
  // invitation list leads with what is still waiting on a reply.
  const openInvitations = project.invitations.filter((i) => ['DRAFT', 'SENT'].includes(i.status));
  const acceptedInvitations = project.invitations.filter((i) => i.status === 'ACCEPTED');
  const closedInvitations = project.invitations.filter(
    (i) => !['DRAFT', 'SENT', 'ACCEPTED'].includes(i.status),
  );
  const proposed = staffingCandidates.filter((c) => c.existingAssignment?.status === 'PROPOSED');
  const readyToPropose = staffingCandidates.filter(
    (c) => !c.existingAssignment && !c.blockedReason,
  );
  // Rows an operator can act on first, then seated people, then the blocked.
  const staffingOrder = (c: (typeof staffingCandidates)[number]) =>
    c.existingAssignment?.status === 'PROPOSED'
      ? 0
      : !c.existingAssignment && !c.blockedReason
        ? 1
        : c.existingAssignment?.status === 'CONFIRMED'
          ? 2
          : 3;
  const staffingRows = [...staffingCandidates].sort((a, b) => staffingOrder(a) - staffingOrder(b));
  const next = nextStep({
    status: project.status,
    hasMatchRun: Boolean(matchRun),
    seatsLeft,
    proposed: proposed.length,
    readyToPropose: readyToPropose.length,
    awaitingReply,
    ranked: rankedCandidates.length,
  });

  return (
    <div className="space-y-5">
      <PageHeader
        back={{ href: '/projects', label: 'Projects' }}
        eyebrow={
          <>
            <span className="font-mono">{project.code}</span> · {project.clientName}
          </>
        }
        title={project.title}
        meta={<StatusBadge status={project.status} />}
        description={`Created by ${project.createdBy.name}. Status changes, invitations and seats are each an explicit operator action.`}
        actions={
          <>
            {canStatus && project.status === 'DRAFT' && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'MATCHING' }}
                label="Open for matching"
                variant="primary"
                size="md"
              />
            )}
            {canMatch && ['MATCHING', 'INVITING', 'STAFFING'].includes(project.status) && (
              <ActionButton
                url={`/api/projects/${project.id}/match`}
                body={{ limit: 15, includeExcluded: true }}
                label={matchRun ? 'Re-run matching' : 'Run matching'}
                variant={matchRun ? 'secondary' : 'primary'}
                size="md"
                pendingLabel="Scoring…"
              />
            )}
            {canStatus && project.status === 'MATCHING' && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'INVITING' }}
                label="Move to inviting"
                size="md"
              />
            )}
            {canStatus && ['STAFFING', 'ACTIVE'].includes(project.status) && (
              <ActionButton
                url={`/api/projects/${project.id}/status`}
                body={{ status: 'CLOSED' }}
                label="Close project"
                size="md"
                confirm="Closing is final. The project can no longer be edited or staffed."
              />
            )}
          </>
        }
      />

      {!canStatus && !canMatch && (
        <p className="alert alert-info">Your role is read-only for this project.</p>
      )}

      <NextAction
        title={next.title}
        action={
          next.href ? (
            <a className="btn btn-secondary btn-sm" href={next.href}>
              {next.cta}
            </a>
          ) : undefined
        }
      >
        {next.detail}
      </NextAction>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Seats"
          value={`${project.seatsFilled}/${project.seatsRequested}`}
          hint={seatsLeft > 0 ? `${seatsLeft} open` : 'full'}
          tone={seatsLeft > 0 ? 'warning' : 'success'}
        />
        <StatTile
          label="Invitations"
          value={project.invitations.length}
          sub={`${accepted} accepted · ${awaitingReply} awaiting a reply`}
        />
        <StatTile
          label="Ranked by matching"
          value={matchRun?.candidateCount ?? 0}
          sub={matchRun ? `${matchRun.excludedCount} excluded by a hard filter` : 'No run yet'}
        />
        <StatTile
          label="Ready to staff"
          value={staffingCandidates.filter((candidate) => candidate.staffable).length}
          sub="Accepted, verified and available"
        />
      </div>

      <nav className="section-nav" aria-label="Sections on this page">
        <a href="#brief">Brief</a>
        <a href="#matching">
          Matching <span className="section-nav-count">{rankedCandidates.length}</span>
        </a>
        <a href="#invitations">
          Invitations <span className="section-nav-count">{project.invitations.length}</span>
        </a>
        <a href="#staffing">
          Staffing <span className="section-nav-count">{staffingCandidates.length}</span>
        </a>
        <a href="#history">History</a>
      </nav>

      <section id="brief" className="card scroll-mt-28">
        <header className="card-header">
          <h2 className="section-title">Brief</h2>
        </header>
        <div className="card-body grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div>
            <KeyValue>
              <KeyValueRow label="Client">{project.clientName}</KeyValueRow>
              <KeyValueRow label="Seats">{project.seatsRequested}</KeyValueRow>
              <KeyValueRow label="Min. experience">{project.minYearsExperience} years</KeyValueRow>
              <KeyValueRow label="Rate ceiling">
                {project.maxHourlyRateCents
                  ? centsToRateDisplay(project.maxHourlyRateCents)
                  : 'None'}
              </KeyValueRow>
              <KeyValueRow label="Timezone">{project.preferredTimezone}</KeyValueRow>
              <KeyValueRow label="Dates">
                {project.startDate || project.endDate
                  ? `${formatDate(project.startDate)} → ${formatDate(project.endDate)}`
                  : 'Not set'}
              </KeyValueRow>
            </KeyValue>
          </div>
          <div>
            <h3 className="label">Requirements</h3>
            <ul className="mt-1 space-y-1.5">
              {project.requirements.map((requirement) => (
                <li
                  key={requirement.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-ink-100 px-3 py-1.5 text-sm"
                >
                  <span className="font-medium text-ink-900">{requirement.skill.name}</span>
                  <span className="flex items-center gap-2 text-xs text-ink-500">
                    at least {requirement.minProficiency}/5
                    <Badge tone={requirement.required ? 'info' : 'muted'}>
                      {requirement.required ? 'required' : 'optional'}
                    </Badge>
                  </span>
                </li>
              ))}
            </ul>
            {project.description && (
              <p className="mt-3 text-sm text-ink-600">{project.description}</p>
            )}
          </div>
        </div>
      </section>

      <div id="matching" className="scroll-mt-28">
        <Card
          flush
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
                            <div className="mt-0.5 text-amber-800">
                              {breakdown.notes.join('; ')}
                            </div>
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
            <details className="border-t border-ink-100 px-4 py-3">
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

          {/* The ranking keeps a fixed number of people. This is how an operator
            reaches an eligible expert who scored below that cut. */}
          <ExpertSearchInvite projectId={project.id} seatsLeft={seatsLeft} canInvite={canInvite} />
        </Card>
      </div>

      <div id="invitations" className="scroll-mt-28">
        <Card
          flush
          title="Invitations"
          description="The worker renders each invitation into the simulated outbox and marks it sent."
          actions={<ProvenanceTag kind="simulated" />}
        >
          {project.invitations.length === 0 ? (
            <EmptyState title="No invitations yet" hint="Invite a ranked candidate above." />
          ) : (
            <>
              {openInvitations.length > 0 ? (
                <InvitationTable
                  rows={openInvitations}
                  canWithdraw={roleHasCapability(operator.role, 'invitation:withdraw')}
                />
              ) : (
                <p className="px-4 py-3 text-sm text-ink-500">Nothing is waiting on a reply.</p>
              )}
              {acceptedInvitations.length > 0 && (
                <details className="border-t border-ink-100 px-4 py-3">
                  <summary className="cursor-pointer text-xs font-semibold text-ink-700">
                    {acceptedInvitations.length} accepted — each is a row under Staffing
                  </summary>
                  <div className="-mx-4 mt-3 border-t border-ink-100">
                    <InvitationTable rows={acceptedInvitations} canWithdraw={false} />
                  </div>
                </details>
              )}
              {closedInvitations.length > 0 && (
                <details className="border-t border-ink-100 px-4 py-3">
                  <summary className="cursor-pointer text-xs font-semibold text-ink-700">
                    {closedInvitations.length} closed{' '}
                    {closedInvitations.length === 1 ? 'invitation' : 'invitations'} — declined,
                    expired or withdrawn
                  </summary>
                  <div className="-mx-4 mt-3 border-t border-ink-100">
                    <InvitationTable rows={closedInvitations} canWithdraw={false} />
                  </div>
                </details>
              )}
            </>
          )}
        </Card>
      </div>

      <div id="staffing" className="scroll-mt-28">
        <Card
          flush
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
                  {staffingRows.map((candidate) => (
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
      </div>

      <div id="history" className="scroll-mt-28">
        <Card
          title="Project history"
          description="Append-only, attributed to operator, expert or worker. Most recent first."
        >
          {activity.events.length === 0 ? (
            <EmptyState title="No history yet" />
          ) : (
            <ActivityList events={activity.events} />
          )}
        </Card>
      </div>
    </div>
  );
}

type Invitation = Awaited<ReturnType<typeof getProject>>['invitations'][number];

function InvitationTable({ rows, canWithdraw }: { rows: Invitation[]; canWithdraw: boolean }) {
  return (
    <TableShell>
      <thead>
        <tr>
          <th>Expert</th>
          <th>Status</th>
          <th>Sent</th>
          <th>Deadline</th>
          <th>Response</th>
          <th className="row-actions">Action</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((invitation) => (
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
              {invitation.status === 'SENT' && <SimulatedDeliveryBadge />}
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
              {['DRAFT', 'SENT'].includes(invitation.status) && canWithdraw ? (
                <WithdrawButton invitationId={invitation.id} />
              ) : (
                <span className="text-xs text-ink-400">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

/**
 * The one thing this project is waiting for.
 *
 * Worked out from state that is already on the page, so it can never disagree
 * with the tables below it — it only says which of them to look at.
 */
function nextStep(state: {
  status: string;
  hasMatchRun: boolean;
  seatsLeft: number;
  proposed: number;
  readyToPropose: number;
  awaitingReply: number;
  ranked: number;
}): { title: string; detail: string; href?: string; cta?: string } {
  if (state.status === 'DRAFT') {
    return {
      title: 'Open the project for matching',
      detail: 'Nothing can be ranked or invited while the project is a draft.',
    };
  }
  if (['CLOSED', 'CANCELLED'].includes(state.status)) {
    return { title: 'This project is closed', detail: 'It can no longer be staffed or edited.' };
  }
  if (state.seatsLeft <= 0) {
    return {
      title: 'Every seat is filled',
      detail: 'Assign work to the seated experts from the delivery screen.',
      href: '/work',
      cta: 'Go to work',
    };
  }
  if (state.proposed > 0) {
    return {
      title: `Confirm ${state.proposed} proposed ${state.proposed === 1 ? 'seat' : 'seats'}`,
      detail: 'A proposal holds nothing until an operator confirms it.',
      href: '#staffing',
      cta: 'Review staffing',
    };
  }
  if (state.readyToPropose > 0) {
    return {
      title: `Propose seats for ${state.readyToPropose} ready ${state.readyToPropose === 1 ? 'expert' : 'experts'}`,
      detail: `${state.seatsLeft} ${state.seatsLeft === 1 ? 'seat is' : 'seats are'} still open.`,
      href: '#staffing',
      cta: 'Review staffing',
    };
  }
  if (!state.hasMatchRun) {
    return {
      title: 'Run matching',
      detail: 'Rank the network against this brief before inviting anyone.',
    };
  }
  if (state.awaitingReply > 0) {
    return {
      title: `Waiting on ${state.awaitingReply} ${state.awaitingReply === 1 ? 'reply' : 'replies'}`,
      detail: `${state.seatsLeft} open ${state.seatsLeft === 1 ? 'seat' : 'seats'}. Reminders are sent automatically; invite more if the replies will not cover it.`,
      href: '#invitations',
      cta: 'See invitations',
    };
  }
  return {
    title: `Invite experts for ${state.seatsLeft} open ${state.seatsLeft === 1 ? 'seat' : 'seats'}`,
    detail:
      state.ranked > 0
        ? `${state.ranked} ranked experts are available to invite.`
        : 'Nobody is ranked. Loosen a requirement and run matching again.',
    href: '#matching',
    cta: 'See the ranking',
  };
}
