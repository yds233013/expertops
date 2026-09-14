import Link from 'next/link';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/server/http/context';
import { OpportunityForm } from '@/components/opportunity-form';
import { Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewOpportunityPage() {
  await requireCapability('campaign:write');
  const [domains, projects, campaigns] = await Promise.all([
    prisma.domain.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } }),
    prisma.project.findMany({
      where: { status: { notIn: ['CLOSED', 'CANCELLED'] } },
      select: { id: true, code: true, title: true },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sourcingCampaign.findMany({
      select: { id: true, name: true },
      orderBy: { createdAt: 'desc' },
      take: 50,
    }),
  ]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="New opportunity"
        description="Saved as a draft. Nothing is visible to applicants until you publish it."
        actions={
          <Link className="btn btn-secondary" href="/opportunities">
            Cancel
          </Link>
        }
      />
      <Card>
        <OpportunityForm domains={domains} projects={projects} campaigns={campaigns} />
      </Card>
    </div>
  );
}
