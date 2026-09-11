import { type NextRequest } from 'next/server';
import { capabilitiesFor } from '@/server/auth/permissions';
import { requireOperatorFromRequest } from '@/server/http/context';
import { ok, route } from '@/server/http/respond';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  const operator = await requireOperatorFromRequest(request);
  return ok({ user: operator, capabilities: capabilitiesFor(operator.role) });
});
