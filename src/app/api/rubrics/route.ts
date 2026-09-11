import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import {
  createDraftVersion,
  createTemplate,
  listTemplates,
  publishVersion,
  updateDraftVersion,
} from '@/server/services/screening';
import { listDomains } from '@/server/services/qualifications';

export const dynamic = 'force-dynamic';

const criterionSchema = z.object({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  scoringGuidance: z.string().max(2000).optional(),
  maxScore: z.number().int().min(1).max(10).optional(),
  weight: z.number().int().min(1).max(10).optional(),
  requiredEvidence: z
    .enum(['NONE', 'WORK_SAMPLE_LINK', 'WRITTEN_ANSWER', 'REFERENCE_STATEMENT'])
    .optional(),
  isGating: z.boolean().optional(),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_template'),
    name: z.string().min(1).max(160),
    domainId: z.string().min(1),
    description: z.string().max(2000).optional(),
  }),
  z.object({
    action: z.literal('draft_version'),
    templateId: z.string().min(1),
    criteria: z.array(criterionSchema).min(1).max(20).optional(),
    passThreshold: z.number().int().min(0).max(200).optional(),
    guidance: z.string().max(4000).optional(),
    changeNote: z.string().max(1000).optional(),
  }),
  z.object({
    action: z.literal('update_draft'),
    versionId: z.string().min(1),
    criteria: z.array(criterionSchema).min(1).max(20).optional(),
    passThreshold: z.number().int().min(0).max(200).optional(),
    guidance: z.string().max(4000).optional(),
    changeNote: z.string().max(1000).optional(),
  }),
  z.object({ action: z.literal('publish'), versionId: z.string().min(1) }),
]);

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'rubric:read');
  const domainId = request.nextUrl.searchParams.get('domainId') ?? undefined;
  const [templates, domains] = await Promise.all([
    listTemplates(prisma, domainId),
    listDomains(prisma),
  ]);
  return ok({ templates, domains });
});

export const POST = route(async (request: NextRequest) => {
  const body = await parseJson(request, bodySchema);

  // Publishing makes a rubric permanent, so it needs the stronger capability.
  if (body.action === 'publish') {
    const { actor } = await requireCapabilityFromRequest(request, 'rubric:publish');
    return ok({ version: await publishVersion(prisma, actor, body.versionId) });
  }

  const { actor } = await requireCapabilityFromRequest(request, 'rubric:write');

  if (body.action === 'create_template') {
    return created({ template: await createTemplate(prisma, actor, body) });
  }
  if (body.action === 'draft_version') {
    return created({ version: await createDraftVersion(prisma, actor, body) });
  }
  return ok({ version: await updateDraftVersion(prisma, actor, body.versionId, body) });
});
