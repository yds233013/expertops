import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeExpert, makeOperator, makeProject } from '../helpers/factories';
import { demoOverview } from '@/server/services/demo';
import { createOpportunity, publishOpportunity } from '@/server/services/opportunities';
import { applyToOpportunity } from '@/server/services/applications';

/**
 * What the anonymous demo may and may not see.
 *
 * The boundary used to be a name prefix: a record was public if it was called
 * "NET …", "PRACTICE …" or "SYNTHETIC …". A name is public input. Anybody
 * filling in the open application form could choose one of those prefixes and
 * put their own address and answers on a page with no login — which is the
 * whole of the bug these tests exist to prevent coming back.
 *
 * Eligibility is now a column that only a seeding script sets.
 */
describe('the public demo boundary', () => {
  beforeAll(() => {
    applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seededNetwork() {
    const operator = await makeOperator({ email: 'demo.boundary@test.local', role: 'ADMIN' });
    const actor = actorFor(operator);

    const project = await makeProject(operator.id, {
      title: 'Coding review pilot',
      status: 'MATCHING',
      seatsRequested: 2,
      minYearsExperience: 0,
    });
    await prisma.project.update({ where: { id: project.id }, data: { demoEligible: true } });

    const seeded = await makeExpert({
      fullName: 'Ines Yamada',
      email: 'net.coding.002@example.test',
      skills: [{ name: 'Distributed Systems', proficiency: 4 }],
    });
    await prisma.expert.update({ where: { id: seeded.id }, data: { demoEligible: true } });

    return { operator, actor, project, seeded };
  }

  it('shows records a seeding script vouched for', async () => {
    const { seeded, project } = await seededNetwork();

    const overview = await demoOverview(prisma);
    expect(overview.network.totalExperts).toBe(1);
    expect(overview.projects.map((row) => row.code)).toEqual([project.code]);
    expect(seeded.demoEligible).toBe(false); // the factory does not set it…
    const stored = await prisma.expert.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(stored.demoEligible).toBe(true); // …the explicit update above does.
  });

  it('hides an expert nobody vouched for, whatever they are called', async () => {
    await seededNetwork();

    // Exactly the attack the old prefix filter allowed.
    for (const fullName of ['NET Sneaky Person', 'PRACTICE Impostor', 'SYNTHETIC Interloper']) {
      const intruder = await makeExpert({
        fullName,
        email: `${fullName.replace(/\s+/g, '.').toLowerCase()}@real-person.test`,
      });
      expect(intruder.demoEligible).toBe(false);
    }

    const overview = await demoOverview(prisma);
    // Still only the one seeded record.
    expect(overview.network.totalExperts).toBe(1);
  });

  it('never marks a record eligible because somebody applied under a seeded-looking name', async () => {
    const { actor, project } = await seededNetwork();

    const domain = await prisma.domain.create({
      data: { slug: 'demo-boundary-area', name: 'Coding', description: 'Test area.' },
    });
    const opportunity = await createOpportunity(prisma, actor, {
      title: 'Code review specialist',
      kind: 'PROJECT_ENGAGEMENT',
      domainId: domain.id,
      projectId: project.id,
      summary: 'A listing.',
      description: 'A listing.',
      requiredSkills: ['Distributed Systems'],
      questions: [],
    });
    await publishOpportunity(prisma, actor, opportunity.id);

    // A member of the public applies, choosing a name that would have passed
    // the old filter, and an address that would have passed the backfill.
    const result = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      fullName: 'NET Real Person',
      email: 'net.coding.999@example.test',
      experience: 'Private information that must not become public.',
      skills: ['Distributed Systems'],
      answers: {},
    });
    expect(result.application.reference).toMatch(/^APP-/);

    const candidate = await prisma.candidate.findFirstOrThrow({
      where: { email: 'net.coding.999@example.test' },
    });
    expect(candidate.expertId).toBeNull();

    // Nothing the applicant supplied appears anywhere in the projection.
    const overview = await demoOverview(prisma);
    expect(overview.network.totalExperts).toBe(1);

    const serialised = JSON.stringify(overview);
    expect(serialised).not.toContain('NET Real Person');
    expect(serialised).not.toContain('net.coding.999@example.test');
    expect(serialised).not.toContain('Private information');
  });

  it('keeps addresses, notes and answers out of the projection entirely', async () => {
    const { seeded } = await seededNetwork();
    await prisma.expert.update({
      where: { id: seeded.id },
      data: { notes: 'An internal note nobody outside should read.' },
    });

    const serialised = JSON.stringify(await demoOverview(prisma));
    expect(serialised).not.toContain('@example.test');
    expect(serialised).not.toContain('An internal note');
    expect(serialised).not.toContain('Ines Yamada'); // names are not projected
    expect(serialised).not.toMatch(/CAN-\d+/);
    expect(serialised).not.toMatch(/APP-\d+/);
  });

  it('re-checks every ranked candidate rather than trusting the project', async () => {
    const { operator, actor, project, seeded } = await seededNetwork();

    // Somebody ineligible is in the same pool and gets ranked.
    const outsider = await makeExpert({
      fullName: 'NET Looks Seeded',
      email: 'outsider@real-person.test',
      skills: [{ name: 'Distributed Systems', proficiency: 5 }],
    });

    const { runMatching } = await import('@/server/services/matching');
    await runMatching(prisma, actor, project.id, { limit: 50, includeExcluded: true });

    const overview = await demoOverview(prisma);
    const references = overview.ranking?.top.map((row) => row.reference) ?? [];
    const outsiderRecord = await prisma.expert.findUniqueOrThrow({ where: { id: outsider.id } });
    const seededRecord = await prisma.expert.findUniqueOrThrow({ where: { id: seeded.id } });

    expect(references).not.toContain(outsiderRecord.reference);
    expect(operator.id).toBeTruthy();
    // And the eligible one is the only thing that can appear.
    if (references.length > 0) expect(references).toContain(seededRecord.reference);
  });
});
