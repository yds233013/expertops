import { type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { notFound, invalidState } from '@/lib/errors';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';
import { renderPortalLinkEmail } from '@/server/email/templates';
import { issuePortalToken } from '@/server/services/portal-access';
import { queueMessage } from '@/server/services/outbox';
import { recordActivity } from '@/server/services/activity';

type Params = { params: Promise<{ expertId: string }> };

/**
 * Issue a replacement portal link for one expert.
 *
 * Portal links are single-use by design, which leaves an expert whose link is
 * spent and whose session has lapsed with no way back in. `/portal/enter` tells
 * them to ask their ExpertOps contact; this is what lets the contact answer.
 *
 * The link is never returned to the caller. It goes into the simulated outbox
 * exactly like every other portal link, so the rule that an operator reads
 * links out of the outbox rather than off an expert's record still holds, and
 * the act of issuing one is on the activity log either way.
 */
export const POST = route(async (request: NextRequest, { params }: Params) => {
  const { actor } = await requireCapabilityFromRequest(request, 'expert:write');
  const { expertId } = await params;

  const expert = await prisma.expert.findUnique({ where: { id: expertId } });
  if (!expert) throw notFound('Expert not found.');
  if (expert.status === 'ARCHIVED') {
    throw invalidState(`${expert.fullName} is archived, so the portal is closed to them.`);
  }

  const portal = await issuePortalToken(prisma, { expertId, purpose: 'GENERAL' });
  const rendered = renderPortalLinkEmail({
    expertName: expert.fullName,
    portalUrl: portal.url,
  });
  await queueMessage(prisma, {
    toEmail: expert.email,
    toName: expert.fullName,
    subject: rendered.subject,
    bodyText: rendered.bodyText,
    template: 'portal.link',
    relatedType: 'expert',
    relatedId: expert.id,
    expertId: expert.id,
  });

  await recordActivity(prisma, {
    actor,
    entityType: 'expert',
    entityId: expert.id,
    action: 'portal.link_issued',
    summary: `${actor.label} issued a new portal link for ${expert.fullName}`,
    expertId: expert.id,
  });

  return ok({ queued: true, expiresAt: portal.expiresAt.toISOString() });
});
