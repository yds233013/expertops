import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations, truncateAll } from '../helpers/db';
import {
  makeCandidate,
  makeDomain,
  makeExpert,
  makeOperator,
  makeProject,
} from '../helpers/factories';
import {
  DOMAIN_RENAMES,
  FAMILY,
  GIVEN,
  OPPORTUNITY_RENAMES,
  PERSON_RENAMES,
  PROJECT_RENAMES,
  RUBRIC_RENAMES,
  networkMemberName,
} from '../../scripts/fixture-names';

/**
 * Renaming seeded fixtures, and nothing else.
 *
 * The migration runs against hosted data that has no backup, so what it leaves
 * alone matters as much as what it renames. Everything that merely *looks* like
 * a fixture — the right prefix, the wrong address; the right address, an
 * application attached — has to come through untouched.
 */
const MIGRATION = readFileSync(
  'prisma/migrations/20260916100000_fixture_display_names/migration.sql',
  'utf8',
);

/** Run the migration's statements on one connection, as `migrate deploy` would. */
async function runMigration() {
  const statements = MIGRATION.replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
  await prisma.$transaction(
    async (tx) => {
      for (const statement of statements) await tx.$executeRawUnsafe(statement);
    },
    { timeout: 30_000 },
  );
}

describe('fixture display names', () => {
  beforeAll(() => {
    applyMigrations();
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('the migration and the seed scripts agree', () => {
    it('on every title, name and headline', () => {
      for (const rename of [
        ...Object.values(PROJECT_RENAMES),
        ...Object.values(OPPORTUNITY_RENAMES),
        ...Object.values(RUBRIC_RENAMES),
      ]) {
        expect(MIGRATION).toContain(`('${rename.legacy}', '${rename.current}')`);
      }
      for (const [slug, rename] of Object.entries(DOMAIN_RENAMES)) {
        expect(MIGRATION).toContain(`('${slug}', '${rename.legacy}', '${rename.current}')`);
      }
      for (const [email, person] of Object.entries(PERSON_RENAMES)) {
        expect(MIGRATION).toContain(`('${email}', '${person.legacy}', '${person.current}',`);
        expect(MIGRATION).toContain(`'${person.headline.legacy}', '${person.headline.current}')`);
      }
    });

    it('on the name pools', () => {
      // Both pools are wrapped across lines in the SQL; compare without whitespace.
      const flat = MIGRATION.replace(/\s+/g, '');
      expect(flat).toContain(GIVEN.map((name) => `'${name}'`).join(','));
      expect(flat).toContain(FAMILY.map((name) => `'${name}'`).join(','));
    });

    it('on the name each serial gets, computed in SQL and in TypeScript', async () => {
      const rows = await prisma.$queryRawUnsafe<{ serial: number; name: string }[]>(`
        SELECT s AS serial,
          (ARRAY[${GIVEN.map((n) => `'${n}'`).join(',')}])[((s * 179) % 676) % 26 + 1] || ' ' ||
          (ARRAY[${FAMILY.map((n) => `'${n}'`).join(',')}])[((s * 179) % 676) / 26 + 1] AS name
        FROM generate_series(1, 120) s`);
      for (const row of rows) expect(row.name).toBe(networkMemberName(row.serial));
      // And a hundred people get a hundred names.
      expect(new Set(rows.slice(0, 100).map((row) => row.name)).size).toBe(100);
    });
  });

  it('renames seeded people, projects, listings, areas and rubrics', async () => {
    const operator = await makeOperator({ email: 'fixture.names@test.local', role: 'ADMIN' });

    const seeded = await makeExpert({
      fullName: 'NET Jian Xu 001',
      email: 'net.coding.001@example.test',
    });
    await prisma.expert.update({
      where: { id: seeded.id },
      data: { headline: 'NET network member — PRACTICE Coding' },
    });
    const seededCandidate = await makeCandidate({
      fullName: 'NET Jian Xu 001',
      email: 'net.coding.001@example.test',
    });
    await prisma.candidate.update({
      where: { id: seededCandidate.id },
      data: { expertId: seeded.id, headline: 'NET network member — PRACTICE Coding' },
    });
    const staging = await makeExpert({
      fullName: 'SYNTHETIC Bo Okonkwo',
      email: 'synthetic.bo.okonkwo@example.test',
    });
    await prisma.expert.update({
      where: { id: staging.id },
      data: { headline: 'SYNTHETIC staging record — clinical operations' },
    });

    const project = await makeProject(operator.id, {
      title: 'PRACTICE coding review pilot',
      clientName: 'PRACTICE Client (practice only)',
    });
    const domain = await prisma.domain.create({
      data: { slug: 'practice-coding', name: 'PRACTICE Coding' },
    });
    const opportunity = await prisma.opportunity.create({
      data: {
        reference: 'OPP-9001',
        slug: 'practice-code-review-specialist',
        title: 'PRACTICE code review specialist',
        summary: 'Practice listing for PRACTICE Coding.',
        kind: 'PROJECT_ENGAGEMENT',
        domainId: domain.id,
        projectId: project.id,
      },
    });
    const template = await prisma.screeningTemplate.create({
      data: {
        slug: 'practice-coding-screening',
        name: 'PRACTICE coding screening',
        domainId: domain.id,
      },
    });
    const assignment = await prisma.assignment.create({
      data: { projectId: project.id, expertId: seeded.id, status: 'CONFIRMED' },
    });
    const work = await prisma.workItem.create({
      data: {
        reference: 'WRK-9001',
        projectId: project.id,
        assignmentId: assignment.id,
        expertId: seeded.id,
        title: 'NET scoping note 1',
      },
    });
    const window = await prisma.availabilityWindow.create({
      data: {
        expertId: seeded.id,
        projectId: project.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        hoursPerWeek: 10,
        note: 'NET capacity already committed on PRACTICE coding review pilot',
      },
    });
    const queued = await prisma.attentionItem.create({
      data: {
        dedupeKey: `delivery:no_work:${assignment.id}`,
        category: 'delivery.no_work_assigned',
        severity: 'LOW',
        title: 'NET Jian Xu 001 is staffed on PRJ-0001 with no work assigned',
        blocker: 'The seat is confirmed but no work item exists yet.',
        impact: 'The expert is allocated but has nothing to do.',
        nextAction: 'Create a work item with instructions and a due date.',
        expertId: seeded.id,
        projectId: project.id,
      },
    });
    const history = await prisma.activityEvent.create({
      data: {
        actorType: 'SYSTEM',
        actorLabel: 'seed',
        entityType: 'expert',
        entityId: seeded.id,
        expertId: seeded.id,
        action: 'expert.created',
        summary: 'Created NET Jian Xu 001',
      },
    });

    await runMigration();

    const expert = await prisma.expert.findUniqueOrThrow({ where: { id: seeded.id } });
    expect(expert.fullName).toBe(networkMemberName(1));
    expect(expert.fullName).not.toMatch(/NET|001/);
    expect(expert.headline).toBe('Network member — Coding');
    // Identity is untouched.
    expect(expert.email).toBe('net.coding.001@example.test');
    expect(expert.reference).toBe(seeded.reference);

    const candidate = await prisma.candidate.findUniqueOrThrow({
      where: { id: seededCandidate.id },
    });
    expect(candidate.fullName).toBe(networkMemberName(1));
    expect(candidate.expertId).toBe(seeded.id);

    expect((await prisma.expert.findUniqueOrThrow({ where: { id: staging.id } })).fullName).toBe(
      'Bo Okonkwo',
    );

    const renamedProject = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(renamedProject.title).toBe('Coding review pilot');
    expect(renamedProject.clientName).toBe('Sample client');
    expect(renamedProject.code).toBe(project.code);

    const listing = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } });
    expect(listing.title).toBe('Code review specialist');
    expect(listing.summary).toBe('Practice listing for Coding.');
    expect(listing.slug).toBe('practice-code-review-specialist'); // links keep working

    expect((await prisma.domain.findUniqueOrThrow({ where: { id: domain.id } })).name).toBe(
      'Coding',
    );
    expect(
      (await prisma.screeningTemplate.findUniqueOrThrow({ where: { id: template.id } })).name,
    ).toBe('Coding screening');
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: work.id } })).title).toBe(
      'Scoping note 1',
    );
    expect(
      (await prisma.availabilityWindow.findUniqueOrThrow({ where: { id: window.id } })).note,
    ).toBe('Capacity already committed on Coding review pilot');

    // The live queue follows the record it points at.
    expect((await prisma.attentionItem.findUniqueOrThrow({ where: { id: queued.id } })).title).toBe(
      `${networkMemberName(1)} is staffed on PRJ-0001 with no work assigned`,
    );

    // History is appended to, never rewritten.
    expect(
      (await prisma.activityEvent.findUniqueOrThrow({ where: { id: history.id } })).summary,
    ).toBe('Created NET Jian Xu 001');
    const events = await prisma.activityEvent.findMany({
      where: { action: 'fixture.renamed', entityId: seeded.id, entityType: 'expert' },
    });
    expect(events.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        { field: 'fullName', from: 'NET Jian Xu 001', to: networkMemberName(1) },
      ]),
    );
  });

  it('leaves look-alikes alone', async () => {
    const operator = await makeOperator({ email: 'fixture.lookalike@test.local', role: 'ADMIN' });

    // The right prefix on somebody else's address.
    const impostor = await makeExpert({
      fullName: 'NET Jian Xu 001',
      email: 'jian.xu@real-person.test',
    });
    // The right address, but the serial in the name disagrees with it.
    const mismatched = await makeExpert({
      fullName: 'NET Jian Xu 002',
      email: 'net.coding.001@example.test',
    });
    // A fixture-shaped address that came in through the public form.
    const applicant = await makeExpert({
      fullName: 'NET Bo Haddad 003',
      email: 'net.coding.003@example.test',
    });
    const applicantCandidate = await makeCandidate({
      fullName: 'NET Bo Haddad 003',
      email: 'net.coding.003@example.test',
    });
    const domain = await makeDomain('Coding area');
    await prisma.application.create({
      data: {
        reference: 'APP-9001',
        candidateId: applicantCandidate.id,
        domainId: domain.id,
      },
    });
    // A named person whose name was edited since seeding.
    const edited = await makeExpert({
      fullName: 'Bo Okonkwo-Smith',
      email: 'synthetic.bo.okonkwo@example.test',
    });
    // An operator's own project that happens to reuse a fixture title.
    const ownProject = await makeProject(operator.id, {
      title: 'PRACTICE coding review pilot',
      clientName: 'Actual client',
    });
    // A browser-test work item with a NET-shaped title on a non-fixture person.
    const ownAssignment = await prisma.assignment.create({
      data: { projectId: ownProject.id, expertId: impostor.id },
    });
    const ownWork = await prisma.workItem.create({
      data: {
        reference: 'WRK-9002',
        projectId: ownProject.id,
        assignmentId: ownAssignment.id,
        expertId: impostor.id,
        title: 'NET scoping note 1',
      },
    });

    await runMigration();

    const after = async (id: string) =>
      (await prisma.expert.findUniqueOrThrow({ where: { id } })).fullName;
    expect(await after(impostor.id)).toBe('NET Jian Xu 001');
    expect(await after(mismatched.id)).toBe('NET Jian Xu 002');
    expect(await after(applicant.id)).toBe('NET Bo Haddad 003');
    expect(
      (await prisma.candidate.findUniqueOrThrow({ where: { id: applicantCandidate.id } })).fullName,
    ).toBe('NET Bo Haddad 003');
    expect(await after(edited.id)).toBe('Bo Okonkwo-Smith');

    const project = await prisma.project.findUniqueOrThrow({ where: { id: ownProject.id } });
    expect(project.title).toBe('PRACTICE coding review pilot');
    expect(project.clientName).toBe('Actual client');
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: ownWork.id } })).title).toBe(
      'NET scoping note 1',
    );

    expect(await prisma.activityEvent.count({ where: { action: 'fixture.renamed' } })).toBe(0);
  });

  it('does not give an area a name another area already uses', async () => {
    await prisma.domain.create({ data: { slug: 'coding', name: 'Coding' } });
    const legacy = await prisma.domain.create({
      data: { slug: 'practice-coding', name: 'PRACTICE Coding' },
    });

    await runMigration();

    expect((await prisma.domain.findUniqueOrThrow({ where: { id: legacy.id } })).name).toBe(
      'PRACTICE Coding',
    );
  });
});
