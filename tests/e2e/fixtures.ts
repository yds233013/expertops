import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../../src/lib/crypto';
import { assertDestructiveAllowed } from '../../src/lib/database-safety';

/**
 * The browser suite's starting world.
 *
 * Deliberately small: operators, domains and skills only. Everything the
 * journey asserts — rubric, campaign, candidate, screening, project, work,
 * payment — is created through the browser during the test, because a fixture
 * that pre-builds those would prove nothing about the interface.
 */
export const E2E_PASSWORD = 'e2e-password-123';

/** A published rubric available from the first page load. */
export const SEEDED_RUBRIC_NAME = 'Bench Screening';
export const SEEDED_RUBRIC_SLUG = 'bench-screening';

export const E2E_OPERATORS = {
  admin: { email: 'admin@e2e.test', name: 'Ada Ferris', role: 'ADMIN' as const },
  operator: { email: 'operator@e2e.test', name: 'Nils Berg', role: 'OPERATOR' as const },
  // A second admin exists because a payment batch cannot be approved by the
  // operator who created it. Separation of duties needs two real people.
  approver: { email: 'approver@e2e.test', name: 'Iris Cole', role: 'ADMIN' as const },
};

const SKILLS = [
  { name: 'Evaluation Design', category: 'Research' },
  { name: 'Clinical Operations', category: 'Life Sciences' },
];

const TABLES = [
  'ActivityEvent',
  'OutboxMessage',
  'Job',
  'Schedule',
  'AttentionItem',
  'OffboardingTask',
  'PaymentItem',
  'PaymentBatch',
  'SupportReply',
  'SupportRequest',
  'WorkReview',
  'WorkSubmission',
  'WorkItem',
  'OutreachBatchItem',
  'OutreachBatch',
  'Assignment',
  'AvailabilityWindow',
  'OnboardingItem',
  'OnboardingCase',
  'Invitation',
  'MatchCandidate',
  'MatchRun',
  'ProjectQualificationRequirement',
  'ProjectSkillRequirement',
  'Project',
  'Qualification',
  'ReviewConflict',
  'ScreeningReview',
  'ScreeningSubmission',
  'Screening',
  'RubricCriterion',
  'ScreeningRubricVersion',
  'ScreeningTemplate',
  'DuplicateFlag',
  'Application',
  'CandidatePortalSession',
  'CandidatePortalToken',
  'Candidate',
  'SourcingCampaign',
  'SourceChannel',
  'Domain',
  'ExpertSkill',
  'ExpertPortalSession',
  'ExpertPortalToken',
  'Expert',
  'Skill',
  'Session',
  'User',
];

export async function resetAndSeedE2E(databaseUrl: string): Promise<void> {
  // The same fail-closed guard the seed and the vitest suite use. Only a
  // database this project recognises as an end-to-end database is acceptable.
  assertDestructiveAllowed({
    operation: 'reset the browser-test database',
    allow: ['e2e'],
    url: databaseUrl,
  });

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
  try {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${TABLES.map((table) => `"${table}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );

    const passwordHash = await hashPassword(E2E_PASSWORD);
    for (const definition of Object.values(E2E_OPERATORS)) {
      await prisma.user.create({ data: { ...definition, passwordHash } });
    }

    const domain = await prisma.domain.create({
      data: {
        slug: 'evaluation-design',
        name: 'Evaluation Design',
        description: 'Designing and running model evaluations.',
      },
    });

    for (const skill of SKILLS) {
      await prisma.skill.create({
        data: {
          name: skill.name,
          slug: skill.name.toLowerCase().replace(/\s+/g, '-'),
          category: skill.category,
        },
      });
    }

    await prisma.sourceChannel.create({
      data: { slug: 'expert-referral', name: 'Expert referral', kind: 'REFERRAL' },
    });

    // A published rubric the access tests can screen against without first
    // walking the authoring flow. The journey spec still authors and publishes
    // its own, which is what proves the authoring screens work.
    await prisma.screeningTemplate.create({
      data: {
        slug: SEEDED_RUBRIC_SLUG,
        name: SEEDED_RUBRIC_NAME,
        domainId: domain.id,
        description: 'Seeded for access tests.',
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            publishedAt: new Date(),
            passThreshold: 6,
            guidance: 'Describe work you have actually done.',
            criteria: {
              create: [
                {
                  key: 'depth',
                  label: 'Practical depth',
                  scoringGuidance: 'Look for specifics.',
                  maxScore: 5,
                  weight: 2,
                  requiredEvidence: 'WRITTEN_ANSWER',
                  position: 0,
                },
              ],
            },
          },
        },
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
