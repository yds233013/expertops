import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireExpertFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { setContactPreference, SETTABLE_PREFERENCES } from '@/server/services/contact-preferences';

export const dynamic = 'force-dynamic';

/**
 * The expert sets their own contact preference.
 *
 * Scoped to the session's own expert, so the id is never taken from the body.
 * "Not asked yet" is not in the list: it is a statement about the record, not
 * a choice somebody can make about themselves.
 */
const bodySchema = z.object({
  preference: z.enum(SETTABLE_PREFERENCES as [string, ...string[]]),
});

export const POST = route(async (request: NextRequest) => {
  const { expert, actor } = await requireExpertFromRequest(request);
  const body = await parseJson(request, bodySchema);
  const updated = await setContactPreference(prisma, actor, {
    expertId: expert.id,
    preference: body.preference as (typeof SETTABLE_PREFERENCES)[number],
    setByExpert: true,
  });
  return ok({
    contactPreference: updated.contactPreference,
    contactPreferenceSetAt: updated.contactPreferenceSetAt,
  });
});
