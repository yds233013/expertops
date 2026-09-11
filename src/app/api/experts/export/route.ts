import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { route } from '@/server/http/respond';
import { exportExpertsCsv, exportImportTemplate } from '@/server/services/expert-import';

export const dynamic = 'force-dynamic';

export const GET = route(async (request: NextRequest) => {
  await requireCapabilityFromRequest(request, 'expert:read');

  const wantsTemplate = request.nextUrl.searchParams.get('template') === 'true';
  const csv = wantsTemplate ? exportImportTemplate() : await exportExpertsCsv(prisma);
  const filename = wantsTemplate ? 'expertops-import-template.csv' : 'expertops-experts.csv';

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
});
