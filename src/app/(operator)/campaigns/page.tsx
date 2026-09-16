import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireOperator } from '@/server/http/context';
import { roleHasCapability } from '@/server/auth/permissions';
import { listCampaigns, sourceChannelEffectiveness } from '@/server/services/sourcing';
import { listDomains } from '@/server/services/qualifications';
import { CreateCampaignForm } from '@/components/campaign-actions';
import { Badge, Card, EmptyState, ProvenanceTag, StatusBadge, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function CampaignsPage() {
  const operator = await requireOperator();
  const [campaigns, domains, effectiveness, projects, owners] = await Promise.all([
    listCampaigns(prisma),
    listDomains(prisma),
    sourceChannelEffectiveness(prisma),
    prisma.project.findMany({
      where: { status: { in: ['DRAFT', 'MATCHING', 'INVITING', 'STAFFING'] } },
      select: { id: true, code: true, title: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
    prisma.user.findMany({
      where: { isActive: true, role: { in: ['OPERATOR', 'ADMIN'] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  const canWrite = roleHasCapability(operator.role, 'campaign:write');

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Sourcing"
        title="Sourcing campaigns"
        description="A campaign exists to close a specific shortage. Progress is counted in qualified people, not in applications received."
      />

      {canWrite && (
        <Card title="Open a campaign" actions={<ProvenanceTag kind="operator" />}>
          {domains.length === 0 ? (
            <EmptyState title="No domains yet" />
          ) : (
            <CreateCampaignForm
              domains={domains.map((domain) => ({ id: domain.id, name: domain.name }))}
              projects={projects.map((project) => ({
                id: project.id,
                label: `${project.code} · ${project.title}`,
              }))}
              owners={owners}
            />
          )}
        </Card>
      )}

      <Card title="Campaigns">
        {campaigns.length === 0 ? (
          <EmptyState title="No campaigns yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-left text-xs uppercase tracking-wide text-ink-500">
                  <th className="py-2 pr-3 font-semibold">Campaign</th>
                  <th className="py-2 pr-3 font-semibold">Domain</th>
                  <th className="py-2 pr-3 font-semibold">Project</th>
                  <th className="py-2 pr-3 font-semibold">Owner</th>
                  <th className="py-2 pr-3 font-semibold">Candidates</th>
                  <th className="py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((campaign) => (
                  <tr key={campaign.id} className="border-b border-ink-100 last:border-b-0">
                    <td className="py-2 pr-3">
                      <Link
                        className="font-medium text-accent-600 hover:underline"
                        href={`/campaigns/${campaign.id}`}
                      >
                        {campaign.name}
                      </Link>
                      <div className="font-mono text-xs text-ink-500">{campaign.code}</div>
                    </td>
                    <td className="py-2 pr-3 text-ink-700">{campaign.domain.name}</td>
                    <td className="py-2 pr-3 text-ink-700">{campaign.project?.code ?? '—'}</td>
                    <td className="py-2 pr-3 text-ink-700">
                      {campaign.owner?.name ?? 'unassigned'}
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-ink-700">
                      {campaign._count.candidates} / {campaign.targetCount}
                    </td>
                    <td className="py-2">
                      <StatusBadge status={campaign.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Where qualified people actually come from"
        description="Counted by qualified outcome rather than by volume."
      >
        {effectiveness.length === 0 ? (
          <EmptyState title="No source channels recorded" />
        ) : (
          <ul className="space-y-2">
            {effectiveness.map((channel) => (
              <li
                key={channel.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-100 py-2 last:border-b-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink-900">{channel.name}</span>
                  <Badge tone="muted">{channel.kind.replace(/_/g, ' ').toLowerCase()}</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs text-ink-600">
                  <span>{channel.total} candidates</span>
                  <span>{channel.qualified} qualified</span>
                  <span>{channel.inFlight} in flight</span>
                  <Badge tone={channel.qualifiedRate === null ? 'muted' : 'info'}>
                    {channel.qualifiedRate === null
                      ? 'no outcome yet'
                      : `${channel.qualifiedRate}% qualified`}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
