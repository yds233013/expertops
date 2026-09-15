import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest, requireOperatorFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import {
  assignReviewer,
  getScreening,
  requestRevision,
  resolveConflict,
} from '@/server/services/screening';
import { grantQualification, rejectScreening } from '@/server/services/qualifications';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ screeningId: string }> };

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('assign_reviewer'),
    reviewerId: z.string().min(1),
    dueInHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  }),
  z.object({
    action: z.literal('request_revision'),
    feedback: z.string().min(1).max(4000),
    extraHours: z
      .number()
      .int()
      .min(1)
      .max(24 * 30)
      .optional(),
  }),
  z.object({
    action: z.literal('resolve_conflict'),
    resolution: z.enum(['APPROVE', 'REJECT', 'REQUEST_REVISION']),
    note: z.string().min(1).max(2000),
  }),
  z.object({ action: z.literal('qualify'), note: z.string().max(2000).optional() }),
  z.object({ action: z.literal('reject'), note: z.string().min(1).max(2000) }),
]);

export const GET = route(async (request: NextRequest, { params }: Params) => {
  await requireCapabilityFromRequest(request, 'screening:read');
  const { screeningId } = await params;
  return ok({ screening: await getScreening(prisma, screeningId) });
});

export const POST = route(async (request: NextRequest, { params }: Params) => {
  // Same reasoning as the rubric route: the capability depends on the action,
  // but being signed in does not. Refuse a stranger before parsing.
  await requireOperatorFromRequest(request);
  const { screeningId } = await params;
  const body = await parseJson(request, bodySchema);

  if (body.action === 'resolve_conflict') {
    // Breaking a reviewer tie is reserved for an admin.
    const { actor } = await requireCapabilityFromRequest(request, 'screening:resolve_conflict');
    return ok({
      conflict: await resolveConflict(prisma, actor, {
        screeningId,
        resolution: body.resolution,
        note: body.note,
      }),
    });
  }

  if (body.action === 'qualify' || body.action === 'reject') {
    const { actor } = await requireCapabilityFromRequest(request, 'screening:decide');
    if (body.action === 'qualify') {
      const result = await grantQualification(prisma, actor, { screeningId, note: body.note });
      return ok({
        qualification: result.qualification,
        expertId: result.expertId,
        createdExpert: result.createdExpert,
        // Stated plainly: being qualified is not being staffed.
        note: 'A qualification makes the expert eligible. Staffing still requires onboarding verification, an accepted invitation and declared availability.',
      });
    }
    return ok({
      screening: await rejectScreening(prisma, actor, { screeningId, note: body.note }),
    });
  }

  const { actor } = await requireCapabilityFromRequest(request, 'screening:write');
  if (body.action === 'assign_reviewer') {
    return ok({
      review: await assignReviewer(prisma, actor, {
        screeningId,
        reviewerId: body.reviewerId,
        dueInHours: body.dueInHours,
      }),
    });
  }
  return ok({
    screening: await requestRevision(prisma, actor, {
      screeningId,
      feedback: body.feedback,
      extraHours: body.extraHours,
    }),
  });
});
