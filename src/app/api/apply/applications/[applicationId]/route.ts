import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCandidateFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { withdrawApplication } from '@/server/services/applications';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ applicationId: string }> };

const bodySchema = z.object({
  action: z.literal('withdraw'),
  reason: z.string().max(500).optional(),
});

/**
 * An applicant withdraws their own application.
 *
 * The candidate id comes from the session, never from the request, and the
 * service checks the application belongs to it — so a valid session cannot
 * withdraw somebody else's application by guessing an id.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const candidate = await requireCandidateFromRequest(request);
  const { applicationId } = await params;
  const body = await parseJson(request, bodySchema);
  const application = await withdrawApplication(prisma, candidate.id, applicationId, body.reason);
  return ok({
    application: {
      reference: application.reference,
      status: application.status,
      withdrawnAt: application.withdrawnAt,
    },
  });
});
