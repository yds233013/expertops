import Link from 'next/link';
import { prisma } from '@/lib/db';
import { formatDate, formatDateTime, formatRelative } from '@/lib/time';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { campaignProgress, getCampaign } from '@/server/services/sourcing';
import { computeProjectGap } from '@/server/services/staffing-gaps';
import { listActivity } from '@/server/services/activity';
import { CampaignStatusControl } from '@/components/campaign-actions';
import { Badge, Card, EmptyState, FieldRow, StatTile, StatusBadge } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * One campaign, answering the questions an operator actually has:
 * how short is the project, where are these people coming from, who is in the
 * pipeline, who owns the relationship, and what is due next.
 */
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const operator = await requireOperator();
  const { campaignId } = await params;

  const [campaign, progress] = await Promise.all([
    getCampaign(prisma, campaignId),
    campaignProgress(prisma, campaignId),
  ]);

  const [gap, activity] = await Promise.all([
    campaign.projectId ? computeProjectGap(prisma, campaign.projectId) : Promise.resolve(null),
    listActivity(prisma, { entityType: 'campaign', entityId: campaign.id, limit: 30 }),
  ]);

  const canWrite = roleHasCapability(operator.role, 'campaign:write');

  // Referrals and channels, counted from the candidates this campaign produced.
  const bySource = new Map<string, number>();
  let referred = 0;
  for (const candidate of campaign.candidates) {
    const label = candidate.sourceChannel?.name ?? 'No channel recorded';
    bySource.set(label, (bySource.get(label) ?? 0) + 1);
    if (candidate.referredByExpertId) referred += 1;
  }

  const nextActions = campaign.candidates
    .filter((candidate) => candidate.nextActionAt)
    .sort((a, b) => a.nextActionAt!.getTime() - b.nextActionAt!.getTime());

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="page-title">{campaign.name}</h1>
            <StatusBadge status={campaign.status} />
          </div>
          <p className="mt-1 text-sm text-ink-600">
            <span className="font-mono text-xs">{campaign.code}</span> · {campaign.domain.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CampaignStatusControl
            campaignId={campaign.id}
            status={campaign.status}
            canWrite={canWrite}
          />
          <Link className="btn btn-secondary" href="/campaigns">
            All campaigns
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Qualified"
          value={progress.qualified}
          hint={`target ${progress.targetCount}`}
        />
        <StatTile label="In pipeline" value={progress.inPipeline} />
        <StatTile
          label="Still needed"
          value={progress.shortfall}
          tone={progress.shortfall > 0 ? 'warning' : 'success'}
          hint={progress.shortfall > 0 ? 'short' : 'target met'}
        />
        <StatTile label="Referred by an expert" value={referred} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Ownership">
          <dl>
            <FieldRow label="Owner">{campaign.owner?.name ?? 'unassigned'}</FieldRow>
            <FieldRow label="Domain">{campaign.domain.name}</FieldRow>
            <FieldRow label="Opened">{formatDate(campaign.createdAt)}</FieldRow>
            <FieldRow label="Closes">
              {campaign.closesAt ? formatDate(campaign.closesAt) : 'no end date'}
            </FieldRow>
          </dl>
          {campaign.notes && <p className="mt-3 text-sm text-ink-600">{campaign.notes}</p>}
        </Card>

        <Card title="The shortage this exists to close" className="lg:col-span-2">
          {!campaign.project ? (
            <EmptyState
              title="Not tied to a project"
              hint="This campaign builds general bench strength rather than filling named seats."
            />
          ) : !gap ? (
            <EmptyState title="Project not found" />
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  className="text-sm font-medium text-accent-600 hover:underline"
                  href={`/projects/${campaign.project.id}`}
                >
                  {campaign.project.code} · {campaign.project.title}
                </Link>
                <StatusBadge status={campaign.project.status} />
                {gap.daysUntilStart !== null && (
                  <Badge tone={gap.daysUntilStart < 14 ? 'warning' : 'muted'}>
                    starts in {gap.daysUntilStart} days
                  </Badge>
                )}
              </div>

              <dl className="grid gap-x-6 sm:grid-cols-2">
                <FieldRow label="Seats requested">{gap.seatsRequested}</FieldRow>
                <FieldRow label="Seats confirmed">{gap.seatsFilled}</FieldRow>
                <FieldRow label="Proposed">{gap.seatsProposed}</FieldRow>
                <FieldRow label="Invitations open">{gap.openInvitations}</FieldRow>
                <FieldRow label="Accepted, not staffed">{gap.acceptedNotStaffed}</FieldRow>
                <FieldRow label="Unfilled">
                  <span className={gap.gap > 0 ? 'font-semibold text-amber-800' : ''}>
                    {gap.gap}
                  </span>
                </FieldRow>
              </dl>

              {gap.needsSourcing && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                  Nothing is left in the funnel for this project. Sourcing is the work, not chasing
                  responses.
                </p>
              )}

              {gap.blockedReady.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-ink-900">
                    Accepted but not yet able to take a seat
                  </h3>
                  <ul className="mt-1 space-y-1 text-sm">
                    {gap.blockedReady.map((blocked) => (
                      <li key={blocked.expertId} className="text-ink-700">
                        <Link
                          className="text-accent-600 hover:underline"
                          href={`/experts/${blocked.expertId}`}
                        >
                          {blocked.fullName}
                        </Link>
                        : {blocked.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Where these candidates came from"
        description="Channel and referral mix for this campaign only."
      >
        {bySource.size === 0 ? (
          <EmptyState title="No candidates recorded against this campaign yet" />
        ) : (
          <ul className="space-y-1">
            {[...bySource.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([label, count]) => (
                <li
                  key={label}
                  className="flex items-center justify-between border-b border-ink-100 py-1.5 text-sm last:border-b-0"
                >
                  <span className="text-ink-800">{label}</span>
                  <span className="tabular-nums text-ink-600">{count}</span>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card title="Candidates" description="Everyone sourced through this campaign.">
        {campaign.candidates.length === 0 ? (
          <EmptyState title="No candidates yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3 font-semibold">Candidate</th>
                  <th className="py-2 pr-3 font-semibold">Stage</th>
                  <th className="py-2 pr-3 font-semibold">Source</th>
                  <th className="py-2 pr-3 font-semibold">Screening</th>
                  <th className="py-2 font-semibold">Next action</th>
                </tr>
              </thead>
              <tbody>
                {campaign.candidates.map((candidate) => (
                  <tr key={candidate.id} className="border-b border-ink-100 last:border-b-0">
                    <td className="py-2 pr-3">
                      <Link
                        className="font-medium text-accent-600 hover:underline"
                        href={`/candidates/${candidate.id}`}
                      >
                        {candidate.fullName}
                      </Link>
                      <div className="font-mono text-xs text-ink-500">{candidate.reference}</div>
                    </td>
                    <td className="py-2 pr-3">
                      <StatusBadge status={candidate.stage} />
                    </td>
                    <td className="py-2 pr-3 text-ink-700">
                      {candidate.sourceChannel?.name ?? '—'}
                      {candidate.referredByExpertId && (
                        <Badge tone="info" title="Referred by an existing expert">
                          referral
                        </Badge>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {candidate.screenings[0] ? (
                        <StatusBadge status={candidate.screenings[0].status} />
                      ) : (
                        <span className="text-xs text-ink-500">none</span>
                      )}
                    </td>
                    <td className="py-2 text-ink-700">
                      {candidate.nextActionAt ? (
                        <>
                          <span title={formatDateTime(candidate.nextActionAt)}>
                            {formatRelative(candidate.nextActionAt)}
                          </span>
                          {candidate.nextActionNote && (
                            <div className="text-xs text-ink-500">{candidate.nextActionNote}</div>
                          )}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="What is due next" description="Sorted by the date the operator set.">
        {nextActions.length === 0 ? (
          <EmptyState title="No follow-ups scheduled" />
        ) : (
          <ol className="space-y-1.5">
            {nextActions.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-baseline gap-2 border-b border-ink-100 py-1.5 text-sm last:border-b-0"
              >
                <span
                  className="text-xs tabular-nums text-ink-500"
                  title={formatDateTime(candidate.nextActionAt!)}
                >
                  {formatDate(candidate.nextActionAt!)}
                </span>
                <Link
                  className="font-medium text-accent-600 hover:underline"
                  href={`/candidates/${candidate.id}`}
                >
                  {candidate.fullName}
                </Link>
                <span className="text-ink-700">{candidate.nextActionNote || 'follow up'}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title="History">
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
                <span className="text-ink-800">{event.summary}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
