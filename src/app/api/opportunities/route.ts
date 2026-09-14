import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { createOpportunity, listOpportunities } from '@/server/services/opportunities';

export const dynamic = 'force-dynamic';

const questionSchema = z.object({
  key: z.string().max(64).optional().default(''),
  label: z.string().min(1).max(300),
  helpText: z.string().max(500).optional(),
  required: z.boolean().optional().default(false),
});

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  kind: z.enum(['PROJECT_ENGAGEMENT', 'NETWORK_MEMBERSHIP']).optional(),
  domainId: z.string().min(1),
  projectId: z.string().nullable().optional(),
  campaignId: z.string().nullable().optional(),
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
});

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'campaign:read');
  return ok({ opportunities: await listOpportunities(prisma) });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'campaign:write');
  const body = await parseJson(request, bodySchema);
  const opportunity = await createOpportunity(prisma, actor, {
    ...body,
    questions: body.questions?.map((question) => ({
      key: question.key || question.label,
      label: question.label,
      helpText: question.helpText,
      required: question.required,
    })),
  });
  return created({ opportunity });
});
