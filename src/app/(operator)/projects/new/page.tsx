import Link from 'next/link';
import { prisma } from '@/lib/db';
import { COMMON_TIMEZONES } from '@/lib/timezone';
import { requireCapability } from '@/server/http/context';
import { listSkills } from '@/server/services/experts';
import { ProjectForm } from './project-form';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  await requireCapability('project:write');
  const skills = await listSkills(prisma);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h1 className="page-title">New project</h1>
          <p className="mt-1 text-sm text-ink-600">
            A project needs at least one skill requirement before it can be opened for matching.
          </p>
        </div>
        <Link className="btn btn-secondary" href="/projects">
          Cancel
        </Link>
      </header>
      <ProjectForm skillNames={skills.map((s) => s.name)} timezones={[...COMMON_TIMEZONES]} />
    </div>
  );
}
