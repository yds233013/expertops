import { COMMON_TIMEZONES } from '@/lib/timezone';
import { prisma } from '@/lib/db';
import { requireCapability } from '@/server/http/context';
import { listSkills } from '@/server/services/experts';
import { ExpertForm } from './expert-form';

import { PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function NewExpertPage() {
  await requireCapability('expert:write');
  const skills = await listSkills(prisma);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        back={{ href: '/experts', label: 'Expert network' }}
        title="Add an expert"
        description="Record professional details only. Do not enter personal characteristics."
      />
      <ExpertForm
        skillNames={skills.map((skill) => skill.name)}
        timezones={[...COMMON_TIMEZONES]}
      />
    </div>
  );
}
