import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { listSupportForExpert, replyToSupport } from '@/server/services/support';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ requestId: string }> };

const bodySchema = z.object({ body: z.string().min(1).max(8000) });

/**
 * An expert replies to their own thread.
 *
 * `replyToSupport` re-checks the expert against the request and refuses
 * `internalOnly` for an EXPERT actor, so this route cannot be used to post a
 * note that looks internal or to reach someone else's conversation.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const { requestId } = await params;
  const reply = await replyToSupport(prisma, actor, {
    requestId,
    body: (await parseJson(request, bodySchema)).body,
  });
  const threads = await listSupportForExpert(prisma, expert.id);
  return ok({ replyId: reply.id, requests: threads });
});
