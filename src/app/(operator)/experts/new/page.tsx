import Link from 'next/link';
import { COMMON_TIMEZONES } from '@/lib/timezone';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/server/http/context';
import { listSkills } from '@/server/services/experts';
import { ExpertForm } from './expert-form';

export const dynamic = 'force-dynamic';

export default async function NewExpertPage() {
  await requireCapability('expert:write');
  const skills = await listSkills(prisma);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink-900">Add an expert</h1>
          <p className="mt-1 text-sm text-ink-600">
            Record professional details only. Do not enter personal characteristics.
          </p>
        </div>
        <Link className="btn btn-secondary" href="/experts">
          Cancel
        </Link>
      </header>
      <ExpertForm
        skillNames={skills.map((skill) => skill.name)}
        timezones={[...COMMON_TIMEZONES]}
      />
    </div>
  );
}
