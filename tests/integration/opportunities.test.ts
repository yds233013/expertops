import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { applyMigrations, truncateAll } from '../helpers/db';
import { actorFor, makeOperator } from '../helpers/factories';
import {
  closeOpportunity,
  createOpportunity,
  findPublishedBySlug,
  listPublishedOpportunities,
  publishOpportunity,
  toPublicOpportunity,
  updateOpportunity,
} from '@/server/services/opportunities';
import {
  applyToOpportunity,
  listApplicationsForCandidate,
  withdrawApplication,
} from '@/server/services/applications';

/**
 * The opportunity and application boundaries.
 *
 * Everything here is a rule that has to hold in the service rather than in a
 * page, because a page can be bypassed by anything that knows a URL. Each test
 * is one way somebody could get at something they should not.
 */
async function fixture() {
  const operator = await makeOperator({ role: 'ADMIN' });
  const domain = await prisma.domain.create({
    data: { slug: `d-${Date.now()}`, name: 'Test Domain' },
  });
  return { operator, domain };
}

async function draft(overrides: Record<string, unknown> = {}) {
  const { operator, domain } = await fixture();
  const opportunity = await createOpportunity(prisma, actorFor(operator), {
    title: 'Evaluation reviewer',
    domainId: domain.id,
    summary: 'Review evaluation designs.',
    description: 'Read designs and write short notes.',
    requiredSkills: ['Evaluation Design'],
    questions: [
      { key: 'why', label: 'Why this work?', required: true },
      { key: 'extra', label: 'Anything else?', required: false },
    ],
    internalNotes: 'Client is Northwind. Rate ceiling 250.',
    ...overrides,
  });
  return { operator, domain, opportunity };
}

const APPLICANT = {
  fullName: 'Rosa Imani',
  email: 'rosa.imani@applicant.test',
  experience: 'Six years of programme evaluation.',
  skills: ['Evaluation Design'],
  weeklyHours: 20,
  answers: { why: 'It is the work I already do.' },
};

describe('opportunity visibility', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('never lists a draft to applicants', async () => {
    await draft();
    expect(await listPublishedOpportunities(prisma)).toEqual([]);
  });

  it('refuses an application to a draft, without confirming it exists', async () => {
    const { opportunity } = await draft();
    // Not "closed" — not found. Saying "closed" would confirm the slug of
    // something unpublished to anybody who guessed it.
    const error = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
    }).catch((caught: unknown) => caught as AppError);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('NOT_FOUND');
    expect(await prisma.application.count()).toBe(0);
  });

  it('refuses to publish without anything to read', async () => {
    const { operator, domain } = await fixture();
    const bare = await createOpportunity(prisma, actorFor(operator), {
      title: 'Mystery role',
      domainId: domain.id,
    });
    await expect(publishOpportunity(prisma, actorFor(operator), bare.id)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('keeps internal notes out of everything an applicant can reach', async () => {
    const { operator, opportunity } = await draft();
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);

    const listed = await listPublishedOpportunities(prisma);
    const detail = await findPublishedBySlug(prisma, opportunity.slug);

    const serialised = JSON.stringify({ listed, detail });
    expect(serialised).not.toContain('Northwind');
    expect(serialised).not.toContain('Rate ceiling');
    expect(Object.keys(detail!)).not.toContain('internalNotes');
  });
});

describe('applying', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  async function published(overrides: Record<string, unknown> = {}) {
    const made = await draft(overrides);
    const opportunity = await publishOpportunity(
      prisma,
      actorFor(made.operator),
      made.opportunity.id,
    );
    return { ...made, opportunity };
  }

  it('creates the candidate as well as the application', async () => {
    const { opportunity } = await published();
    const result = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
    });

    expect(result.created).toBe(true);
    const candidate = await prisma.candidate.findFirstOrThrow({
      where: { email: APPLICANT.email },
    });
    expect(candidate.stage).toBe('NEW');
    expect(result.application.experience).toContain('programme evaluation');
    expect(result.application.weeklyHours).toBe(20);
  });

  it('does not create a second application when the same person submits twice', async () => {
    const { opportunity } = await published();
    const first = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
    });
    const second = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      // A different spelling of the same address is the same person.
      email: APPLICANT.email.toUpperCase(),
    });

    expect(second.created).toBe(false);
    expect(second.application.id).toBe(first.application.id);
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.candidate.count()).toBe(1);
  });

  it('lets one person apply to two opportunities without duplicating their identity', async () => {
    const { operator, domain } = await fixture();
    const one = await createOpportunity(prisma, actorFor(operator), {
      title: 'First role',
      domainId: domain.id,
      summary: 'One.',
    });
    const two = await createOpportunity(prisma, actorFor(operator), {
      title: 'Second role',
      domainId: domain.id,
      summary: 'Two.',
    });
    await publishOpportunity(prisma, actorFor(operator), one.id);
    await publishOpportunity(prisma, actorFor(operator), two.id);

    await applyToOpportunity(prisma, { opportunitySlug: one.slug, ...APPLICANT, answers: {} });
    await applyToOpportunity(prisma, { opportunitySlug: two.slug, ...APPLICANT, answers: {} });

    expect(await prisma.candidate.count()).toBe(1);
    expect(await prisma.application.count()).toBe(2);
  });

  it('refuses an application after the deadline', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Closing soon',
      domainId: domain.id,
      summary: 'Nearly over.',
      applicationDeadline: new Date(Date.now() + 60_000),
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);

    // Move the deadline into the past the way an hour passing would.
    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: { applicationDeadline: new Date(Date.now() - 60_000) },
    });

    const error = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    }).catch((caught: unknown) => caught as AppError);
    expect((error as AppError).code).toBe('INVALID_STATE');
    expect((error as AppError).message).toMatch(/deadline/i);
    expect(await prisma.application.count()).toBe(0);
  });

  it('refuses an application once the opportunity is closed', async () => {
    const { operator, opportunity } = await published();
    await closeOpportunity(prisma, actorFor(operator), opportunity.id, 'Seats filled');

    await expect(
      applyToOpportunity(prisma, { opportunitySlug: opportunity.slug, ...APPLICANT }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('requires an answer to a required question', async () => {
    const { opportunity } = await published();
    await expect(
      applyToOpportunity(prisma, { opportunitySlug: opportunity.slug, ...APPLICANT, answers: {} }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('keeps the opportunity as it read when it was submitted', async () => {
    const { operator, opportunity } = await published();
    const result = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
    });

    // The operator rewrites the questions and the title afterwards.
    await updateOpportunity(prisma, actorFor(operator), opportunity.id, {
      title: 'Completely different role',
      questions: [{ key: 'other', label: 'Something else entirely', required: true }],
    });

    const stored = await prisma.application.findUniqueOrThrow({
      where: { id: result.application.id },
    });
    const snapshot = stored.opportunitySnapshot as {
      title: string;
      questions: Array<{ label: string }>;
    };
    expect(snapshot.title).toBe('Evaluation reviewer');
    expect(snapshot.questions.map((question) => question.label)).toContain('Why this work?');
    // And the answer is still filed under the question that was actually asked.
    expect((stored.answers as Record<string, string>).why).toContain('already do');
  });
});

describe('an applicant reaching other people', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('cannot withdraw somebody else', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Shared role',
      domainId: domain.id,
      summary: 'Two applicants.',
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);

    const mine = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    });
    const theirs = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
      fullName: 'Someone Else',
      email: 'someone.else@applicant.test',
    });

    const myCandidateId = mine.application.candidateId;
    // A valid session, a guessed id, and nothing happens.
    await expect(
      withdrawApplication(prisma, myCandidateId, theirs.application.id),
    ).rejects.toBeInstanceOf(AppError);

    const untouched = await prisma.application.findUniqueOrThrow({
      where: { id: theirs.application.id },
    });
    expect(untouched.withdrawnAt).toBeNull();
  });

  it('only ever lists their own applications', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Shared role',
      domainId: domain.id,
      summary: 'Two applicants.',
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);
    const mine = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    });
    await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
      fullName: 'Someone Else',
      email: 'someone.else@applicant.test',
    });

    const listed = await listApplicationsForCandidate(prisma, mine.application.candidateId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).toBe(mine.application.id);
  });
});

describe('withdrawal', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('withdraws, keeps the record, and allows applying again', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Reopenable',
      domainId: domain.id,
      summary: 'Changing your mind is allowed.',
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);

    const first = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    });
    const withdrawn = await withdrawApplication(
      prisma,
      first.application.candidateId,
      first.application.id,
      'Taken something else on',
    );
    expect(withdrawn.status).toBe('CLOSED_WITHDRAWN');
    expect(withdrawn.withdrawnAt).not.toBeNull();

    // Withdrawing does not delete what was submitted.
    expect(withdrawn.experience).toContain('programme evaluation');

    const again = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    });
    expect(again.application.id).toBe(first.application.id);
    expect(again.application.withdrawnAt).toBeNull();
    expect(await prisma.application.count()).toBe(1);
  });

  it('is idempotent', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Twice',
      domainId: domain.id,
      summary: 'Two clicks.',
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);
    const applied = await applyToOpportunity(prisma, {
      opportunitySlug: opportunity.slug,
      ...APPLICANT,
      answers: {},
    });

    const once = await withdrawApplication(
      prisma,
      applied.application.candidateId,
      applied.application.id,
    );
    const twice = await withdrawApplication(
      prisma,
      applied.application.candidateId,
      applied.application.id,
    );
    expect(twice.withdrawnAt?.toISOString()).toBe(once.withdrawnAt?.toISOString());
  });
});

describe('the public projection', () => {
  beforeAll(() => applyMigrations());
  beforeEach(() => truncateAll());

  it('reports a closed opportunity as closed rather than hiding it', async () => {
    const { operator, opportunity } = await draft();
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);
    await closeOpportunity(prisma, actorFor(operator), opportunity.id, 'Filled');

    // A bookmarked link should explain itself, not 404.
    const detail = await findPublishedBySlug(prisma, opportunity.slug);
    expect(detail).not.toBeNull();
    expect(detail!.open).toBe(false);
    expect(detail!.closedReason).toMatch(/closed/i);

    // But it is off the listing.
    expect(await listPublishedOpportunities(prisma)).toEqual([]);
  });

  it('marks an expired opportunity closed to applications', async () => {
    const { operator, domain } = await fixture();
    const opportunity = await createOpportunity(prisma, actorFor(operator), {
      title: 'Expired',
      domainId: domain.id,
      summary: 'Past it.',
    });
    await publishOpportunity(prisma, actorFor(operator), opportunity.id);
    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: { applicationDeadline: new Date(Date.now() - 1000) },
    });

    const row = await prisma.opportunity.findUniqueOrThrow({
      where: { id: opportunity.id },
      include: { domain: { select: { name: true } } },
    });
    expect(toPublicOpportunity(row).open).toBe(false);
  });
});
