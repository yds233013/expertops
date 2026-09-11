import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { requireCapabilityFromRequest } from '@/server/http/context';
import { ok, parseJson, route } from '@/server/http/respond';
import { commitExpertImport, previewExpertImport } from '@/server/services/expert-import';

const bodySchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  /** Preview by default. Nothing is written until this is explicitly true. */
  commit: z.boolean().optional(),
});

export const POST = route(async (request: NextRequest) => {
  const { actor } = await requireCapabilityFromRequest(request, 'import:run');
  const body = await parseJson(request, bodySchema);

  if (!body.commit) {
    const preview = await previewExpertImport(prisma, body.csv);
    return ok({
      mode: 'preview',
      preview,
      note: 'Nothing was written. Send the same file with commit: true to import the valid rows.',
    });
  }

  const result = await commitExpertImport(prisma, actor, body.csv);
  return ok({
    mode: 'commit',
    created: result.created,
    skipped: result.skipped,
    failed: result.failed,
    preview: result.preview,
    note: 'Qualification hints in the file were recorded as notes only. A qualification requires a human review decision.',
  });
});
