import { prisma } from '@/lib/db';
import { centsToRateDisplay } from '@/lib/money';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { currentExpert } from '@/server/http/context';
import { listAvailability } from '@/server/services/availability';
import { listInvitationsForExpert } from '@/server/services/invitations';
import { listExpertCommitments } from '@/server/services/staffing-gaps';
import { listSupportForExpert } from '@/server/services/support';
import { listWorkItemsForExpert } from '@/server/services/work';
import { AvailabilityPanel } from '@/components/portal/availability-panel';
import { ContactPreferencePanel } from '@/components/portal/contact-preference-panel';
import { InvitationPanel } from '@/components/portal/invitation-panel';
import { OnboardingPanel } from '@/components/portal/onboarding-panel';
import { SupportPanel } from '@/components/portal/support-panel';
import { WithdrawalPanel } from '@/components/portal/withdrawal-panel';
import { WorkPanel } from '@/components/portal/work-panel';
import { Badge, Card, FieldRow, NextAction, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function PortalHome() {
  const expert = await currentExpert();

  if (!expert) {
    return (
      <Card title="Your session has ended">
        <p className="text-sm text-ink-600">
          Open the most recent link sent to you to sign back in. Portal links are single-use, so an
          older link will not work.
        </p>
      </Card>
    );
  }

  const [invitations, availability, onboardingCase, supportThreads, workItems, commitments] =
    await Promise.all([
      listInvitationsForExpert(prisma, expert.id),
      listAvailability(prisma, expert.id),
      prisma.onboardingCase.findUnique({
        where: { expertId: expert.id },
        include: { items: { orderBy: { position: 'asc' } } },
      }),
      listSupportForExpert(prisma, expert.id),
      listWorkItemsForExpert(prisma, expert.id),
      listExpertCommitments(prisma, expert.id),
    ]);

  const openInvitations = invitations.filter((invitation) => invitation.status === 'SENT');
  const acceptedInvitations = invitations.filter((invitation) => invitation.status === 'ACCEPTED');
  const pastInvitations = invitations.filter(
    (invitation) => !['SENT', 'ACCEPTED'].includes(invitation.status),
  );

  const outstandingChecklistItems =
    onboardingCase && onboardingCase.status !== 'VERIFIED'
      ? onboardingCase.items.filter((item) => item.required && !item.completedAt).length
      : 0;
  const workNeedingSubmission = workItems.filter(
    (item) => item.status === 'ASSIGNED' || item.status === 'REVISION_REQUESTED',
  ).length;

  const nextStep =
    openInvitations.length > 0
      ? `Respond to ${openInvitations.length === 1 ? 'the project invitation' : `${openInvitations.length} project invitations`}.`
      : outstandingChecklistItems > 0
        ? `Complete ${outstandingChecklistItems} remaining onboarding ${outstandingChecklistItems === 1 ? 'item' : 'items'}, then submit the checklist for review.`
        : onboardingCase?.status === 'SUBMITTED'
          ? 'Your checklist is with an ExpertOps operator. Nothing is needed from you right now.'
          : workNeedingSubmission > 0
            ? `Submit ${workNeedingSubmission === 1 ? 'the work item' : `${workNeedingSubmission} work items`} assigned to you.`
            : null;

  return (
    <div className="space-y-5">
      <header>
        <span className="eyebrow">Expert portal</span>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="page-title">Hello, {expert.fullName}</h1>
          <StatusBadge status={expert.status} />
        </div>
        <p className="page-subtitle">
          Respond to invitations, complete onboarding, submit your work and tell us when you are
          free.
        </p>
      </header>

      {/* One instruction, chosen in the order the work actually blocks on: an
          unanswered invitation stops everything, then an unfinished checklist,
          then work that is waiting on them. Listing all three at once is how a
          portal becomes a wall of text nobody reads. */}
      {nextStep ? (
        <NextAction title={nextStep} />
      ) : (
        <p className="alert alert-success">Nothing needs your attention right now.</p>
      )}

      <nav className="section-nav" aria-label="Sections on this page">
        <a href="#invitations">
          Invitations{' '}
          {openInvitations.length > 0 && (
            <span className="section-nav-count">{openInvitations.length}</span>
          )}
        </a>
        <a href="#onboarding">Onboarding</a>
        <a href="#work">
          Work{' '}
          {workNeedingSubmission > 0 && (
            <span className="section-nav-count">{workNeedingSubmission}</span>
          )}
        </a>
        <a href="#availability">Availability</a>
        <a href="#support">Support</a>
        <a href="#settings">Profile and contact</a>
      </nav>

      <div id="invitations" className="scroll-mt-16">
        <Card
          title="Open invitations"
          description={
            openInvitations.length > 0
              ? 'Accepting opens your onboarding checklist. Declining asks for a short reason.'
              : undefined
          }
        >
          {openInvitations.length === 0 ? (
            <p className="text-sm text-ink-500">Nothing awaiting your response.</p>
          ) : (
            <div className="space-y-4">
              {openInvitations.map((invitation) => (
                <div key={invitation.id} className="rounded-lg border border-ink-200 px-3 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="text-sm font-semibold text-ink-900">
                        {invitation.project.title}
                      </h3>
                      <p className="text-xs text-ink-500">
                        {invitation.project.clientName} ·{' '}
                        <span className="font-mono">{invitation.project.code}</span>
                      </p>
                    </div>
                    <Badge tone="warning" title={formatDateTime(invitation.expiresAt)}>
                      respond {formatRelative(invitation.expiresAt)}
                    </Badge>
                  </div>
                  {invitation.project.description && (
                    <p className="mt-2 text-sm text-ink-600">{invitation.project.description}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {invitation.project.requirements.map((requirement) => (
                      <Badge key={requirement.id} tone={requirement.required ? 'info' : 'muted'}>
                        {requirement.skill.name}
                      </Badge>
                    ))}
                  </div>
                  {invitation.message && (
                    <p className="mt-2 rounded-md bg-ink-50 px-3 py-2 text-sm text-ink-700">
                      {invitation.message}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-ink-500">
                    {formatDate(invitation.project.startDate)} →{' '}
                    {formatDate(invitation.project.endDate)}
                  </p>
                  <div className="mt-3">
                    <InvitationPanel invitationId={invitation.id} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div id="onboarding" className="scroll-mt-16">
        <OnboardingPanel
          onboardingCase={
            onboardingCase
              ? {
                  status: onboardingCase.status,
                  items: onboardingCase.items.map((item) => ({
                    id: item.id,
                    key: item.key,
                    label: item.label,
                    helpText: item.helpText,
                    kind: item.kind,
                    required: item.required,
                    value: item.value,
                    complete: Boolean(item.completedAt),
                  })),
                  decisionNote: onboardingCase.decisionNote,
                }
              : null
          }
        />
      </div>

      <div id="work" className="scroll-mt-16">
        <WorkPanel
          items={workItems.map((item) => {
            const latestReview = item.reviews[0] ?? null;
            return {
              id: item.id,
              reference: item.reference,
              title: item.title,
              instructions: item.instructions,
              basis: item.basis,
              status: item.status,
              dueAt: item.dueAt?.toISOString() ?? null,
              projectLabel: `${item.project.code} · ${item.project.title}`,
              lastSubmission: item.submissions[0]
                ? {
                    revision: item.submissions[0].revision,
                    summary: item.submissions[0].summary,
                    content: item.submissions[0].content,
                    hoursClaimed: item.submissions[0].hoursClaimed,
                  }
                : null,
              revisionRequest:
                item.status === 'REVISION_REQUESTED'
                  ? (latestReview?.revisionRequest ?? null)
                  : null,
              reviewSummary: latestReview?.summary ?? null,
            };
          })}
        />
      </div>

      <div id="availability" className="scroll-mt-16">
        <AvailabilityPanel
          windows={availability.map((window) => ({
            id: window.id,
            startAt: window.startAt.toISOString(),
            endAt: window.endAt.toISOString(),
            hoursPerWeek: window.hoursPerWeek,
            note: window.note,
            projectLabel: window.project
              ? `${window.project.code} · ${window.project.title}`
              : null,
          }))}
          projects={acceptedInvitations.map((invitation) => ({
            id: invitation.projectId,
            label: `${invitation.project.code} · ${invitation.project.title}`,
          }))}
        />
      </div>

      <WithdrawalPanel
        commitments={commitments.active.map((commitment) => ({
          projectId: commitment.projectId,
          projectCode: commitment.projectCode,
          projectTitle: commitment.projectTitle,
          clientName: commitment.clientName,
          stage: commitment.stage,
          allocationHoursPerWeek: commitment.allocationHoursPerWeek,
          datesLabel: `${formatDate(commitment.startDate)} → ${formatDate(commitment.endDate)}`,
          outstandingWorkItems: commitment.outstandingWorkItems,
          retainedWorkItems: commitment.retainedWorkItems,
        }))}
        withdrawals={commitments.withdrawn.map((withdrawal) => ({
          projectId: withdrawal.projectId,
          projectCode: withdrawal.projectCode,
          projectTitle: withdrawal.projectTitle,
          withdrawnAtLabel: withdrawal.withdrawnAt ? formatDate(withdrawal.withdrawnAt) : null,
          reason: withdrawal.reason,
        }))}
      />

      <div id="support" className="scroll-mt-16">
        <SupportPanel
          threads={supportThreads.map((thread) => ({
            id: thread.id,
            reference: thread.reference,
            subject: thread.subject,
            message: thread.message,
            category: thread.category,
            status: thread.status,
            createdAt: thread.createdAt.toISOString(),
            project: thread.project
              ? { code: thread.project.code, title: thread.project.title }
              : null,
            replies: thread.replies.map((reply) => ({
              id: reply.id,
              authorType: reply.authorType,
              body: reply.body,
              createdAt: reply.createdAt.toISOString(),
            })),
          }))}
          projects={[...acceptedInvitations, ...openInvitations].map((invitation) => ({
            id: invitation.projectId,
            label: `${invitation.project.code} · ${invitation.project.title}`,
          }))}
        />
      </div>

      <div id="settings" className="scroll-mt-16 space-y-5">
        <Card
          title="Your profile"
          description="Maintained by the ExpertOps team. Ask your contact to change anything here."
        >
          <dl className="grid gap-x-6 sm:grid-cols-2">
            <FieldRow label="Headline">{expert.headline}</FieldRow>
            <FieldRow label="Experience">{expert.yearsExperience} years</FieldRow>
            <FieldRow label="Rate">
              {centsToRateDisplay(expert.hourlyRateCents, expert.currency)}
            </FieldRow>
            <FieldRow label="Timezone">{expert.timezone}</FieldRow>
          </dl>
        </Card>

        <Card
          title="How we contact you"
          description="Yours to change at any time. It applies to the next message we would have sent, not just to new ones."
        >
          <ContactPreferencePanel
            current={expert.contactPreference}
            setAt={expert.contactPreferenceSetAt}
          />
        </Card>
      </div>

      {pastInvitations.length > 0 && (
        <Card title="Past invitations">
          <ul className="space-y-1.5 text-sm">
            {pastInvitations.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink-800">
                  {invitation.project.title}{' '}
                  <span className="font-mono text-xs text-ink-500">{invitation.project.code}</span>
                </span>
                <StatusBadge status={invitation.status} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
