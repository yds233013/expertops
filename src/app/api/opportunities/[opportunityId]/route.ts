import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  closeOpportunity,
  getOpportunity,
  publishOpportunity,
  updateOpportunity,
} from '@/server/services/opportunities';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ opportunityId: string }> };

const questionSchema = z.object({
  key: z.string().max(64).optional().default(''),
  label: z.string().min(1).max(300),
  helpText: z.string().max(500).optional(),
  required: z.boolean().optional().default(false),
});

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('update'),
    title: z.string().min(1).max(200).optional(),
    kind: z.enum(['PROJECT_ENGAGEMENT', 'NETWORK_MEMBERSHIP']).optional(),
    projectId: z.string().nullable().optional(),
    summary: z.string().max(500).optional(),
    description: z.string().max(10_000).optional(),
    responsibilities: z.string().max(10_000).optional(),
    requiredSkills: z.array(z.string().max(80)).max(20).optional(),
    questions: z.array(questionSchema).max(10).optional(),
    weeklyHoursMin: z.number().int().nullable().optional(),
    weeklyHoursMax: z.number().int().nullable().optional(),
    startDate: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
    applicationDeadline: z.coerce.date().nullable().optional(),
    compensationNote: z.string().max(500).optional(),
    internalNotes: z.string().max(10_000).optional(),
  }),
  z.object({ action: z.literal('publish') }),
  z.object({ action: z.literal('close'), reason: z.string().min(1).max(500) }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'campaign:read');
  const { opportunityId } = await params;
  return ok({ opportunity: await getOpportunity(prisma, opportunityId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'campaign:write');
  const { opportunityId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'publish') {
    return ok({ opportunity: await publishOpportunity(prisma, actor, opportunityId) });
  }
  if (body.action === 'close') {
    return ok({ opportunity: await closeOpportunity(prisma, actor, opportunityId, body.reason) });
  }

  const { action: _action, questions, ...rest } = body;
  return ok({
    opportunity: await updateOpportunity(prisma, actor, opportunityId, {
      ...rest,
      questions: questions?.map((question) => ({
        key: question.key || question.label,
        label: question.label,
        helpText: question.helpText,
        required: question.required,
      })),
    }),
  });
});
