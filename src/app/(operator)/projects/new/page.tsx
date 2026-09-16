import { prisma } from '@/lib/db';
import { COMMON_TIMEZONES } from '@/lib/timezone';
import { requireCapability } from '@/server/http/context';
import { listSkills } from '@/server/services/experts';
import { ProjectForm } from './project-form';

import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewProjectPage() {
  await requireCapability('project:write');
  const skills = await listSkills(prisma);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        back={{ href: '/projects', label: 'Projects' }}
        title="New project"
        description="A project needs at least one skill requirement before it can be opened for matching."
      />
      <ProjectForm skillNames={skills.map((s) => s.name)} timezones={[...COMMON_TIMEZONES]} />
    </div>
  );
}
