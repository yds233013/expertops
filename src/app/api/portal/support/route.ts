import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { created, ok, parseJson, route } from '@/server/http/respond';
import { listSupportForExpert, raiseSupportRequest } from '@/server/services/support';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(8000),
  category: z
    .enum(['ACCESS', 'SCOPE_QUESTION', 'TOOLING', 'SCHEDULING', 'PAYMENT', 'OTHER'])
    .optional(),
  projectId: z.string().min(1).nullable().optional(),
});

/**
 * The expert's own support threads.
 *
 * Scoped by the session's expert id, never by a parameter, and the service
 * filters internal operator notes out of every reply list.
 */
export const GET = route(async (request: NextRequest) => {
  const { expert } = await requireExpertFromRequest(request);
  return ok({ requests: await listSupportForExpert(prisma, expert.id) });
});

export const POST = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);
  return created({
    request: await raiseSupportRequest(prisma, actor, {
      expertId: expert.id,
      subject: body.subject,
      message: body.message,
      category: body.category,
      projectId: body.projectId ?? null,
    }),
  });
});
