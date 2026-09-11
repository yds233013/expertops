import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { type QualificationStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  checkQualificationEligibility,
  listQualifications,
  resolveRereview,
  revokeQualification,
  setProjectQualificationRequirement,
} from '@/server/services/qualifications';

export const dynamic = 'force-dynamic';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_project_requirement'),
    projectId: z.string().min(1),
    domainId: z.string().min(1),
    minRubricVersionId: z.string().min(1),
    isMandatory: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('resolve_rereview'),
    qualificationId: z.string().min(1),
    stillValid: z.boolean(),
    note: z.string().min(1).max(2000),
  }),
  z.object({
    action: z.literal('revoke'),
    qualificationId: z.string().min(1),
    reason: z.string().min(1).max(2000),
  }),
]);

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'qualification:read');
  const params = request.nextUrl.searchParams;

  // Eligibility probe used by the staffing screen.
  const projectId = params.get('eligibilityProjectId');
  const expertId = params.get('eligibilityExpertId');
  if (projectId && expertId) {
    return ok({ eligibility: await checkQualificationEligibility(prisma, projectId, expertId) });
  }

  return ok({
    qualifications: await listQualifications(prisma, {
      expertId: params.get('expertId') ?? undefined,
      domainId: params.get('domainId') ?? undefined,
      status: (params.get('status') as QualificationStatus) ?? undefined,
    }),
  });
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'qualification:write');
  const body = await parseJson(request, bodySchema);

  if (body.action === 'set_project_requirement') {
    const result = await setProjectQualificationRequirement(prisma, actor, body);
    return ok({
      requirement: result.requirement,
      flaggedForRereview: result.flaggedForRereview,
      // Said explicitly: raising the bar surfaces work, it never revokes.
      revoked: 0,
      autoApproved: 0,
    });
  }
  if (body.action === 'resolve_rereview') {
    return ok({ qualification: await resolveRereview(prisma, actor, body) });
  }
  return ok({ qualification: await revokeQualification(prisma, actor, body) });
});
