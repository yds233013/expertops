import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type SourcingCampaignStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import {
  createCampaign,
  listCampaigns,
  listSourceChannels,
  sourceChannelEffectiveness,
} from '@/server/services/sourcing';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  name: z.string().min(1).max(160),
  domainId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  targetCount: z.number().int().min(1).max(500).optional(),
  ownerId: z.string().nullable().optional(),
  notes: z.string().max(4000).optional(),
  closesAt: z.coerce.date().nullable().optional(),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'campaign:read');
  const params = request.nextUrl.searchParams;
  const [campaigns, channels, effectiveness] = await Promise.all([
    listCampaigns(prisma, {
      status: (params.get('status') as SourcingCampaignStatus) ?? undefined,
      projectId: params.get('projectId') ?? undefined,
    }),
    listSourceChannels(prisma),
    sourceChannelEffectiveness(prisma),
  ]);
  return ok({ campaigns, channels, effectiveness });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'campaign:write');
  const body = await parseJson(request, createSchema);
  return created({ campaign: await createCampaign(prisma, actor, body) });
});
