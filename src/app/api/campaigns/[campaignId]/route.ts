import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { campaignProgress, getCampaign, setCampaignStatus } from '@/server/services/sourcing';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ campaignId: string }> };

const bodySchema = z.object({
  action: z.literal('set_status'),
  status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED']),
});

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'campaign:read');
  const { campaignId } = await params;
  const [campaign, progress] = await Promise.all([
    getCampaign(prisma, campaignId),
    campaignProgress(prisma, campaignId),
  ]);
  return ok({ campaign, progress });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'campaign:write');
  const { campaignId } = await params;
  const body = await parseJson(request, bodySchema);
  return ok({ campaign: await setCampaignStatus(prisma, actor, campaignId, body.status) });
});
