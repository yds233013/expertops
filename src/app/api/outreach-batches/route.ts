import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type OutreachBatchStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createBatch, listBatches } from '@/server/services/outreach';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  kind: z.enum(['PROJECT_INVITATION', 'REPLACEMENT', 'SCREENING_INVITATION']),
  projectId: z.string().nullable().optional(),
  reason: z.string().max(2000).optional(),
  note: z.string().max(2000).optional(),
  items: z
    .array(
      z.object({
        expertId: z.string().min(1),
        rationale: z.string().max(500).optional(),
        matchScore: z.number().int().min(0).max(100).nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'outreach:read');
  const params = request.nextUrl.searchParams;
  return ok({
    batches: await listBatches(prisma, {
      status: (params.get('status') as OutreachBatchStatus) ?? undefined,
      projectId: params.get('projectId') ?? undefined,
    }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'outreach:write');
  const body = await parseJson(request, createSchema);
  const batch = await createBatch(prisma, actor, body);
  return created({
    batch,
    // A batch does nothing until a human approves it.
    awaitingApproval: true,
  });
});
