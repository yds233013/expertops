import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * Test database lifecycle.
 *
 * Migrations are applied once per test process; tables are truncated before
 * each test so cases stay independent without paying for a full reset.
 */
let migrated = false;

/**
 * Refuse to run destructive test helpers against anything but a test database.
 *
 * The suite truncates every table between cases. Pointing it at a development
 * or production database would silently destroy real work, so the guard checks
 * the connection string before the first truncate and again on every call.
 */
const TEST_DATABASE_MARKERS = ['expertops_test', '_test', 'test_'];

export function assertTestDatabase(url = process.env.DATABASE_URL ?? ''): void {
  if (!url) {
    throw new Error('DATABASE_URL is not set. Refusing to run destructive test helpers.');
  }

  let databaseName: string;
  try {
    databaseName = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL. Refusing to truncate: ${url}`);
  }

  const looksLikeTest = TEST_DATABASE_MARKERS.some((marker) => databaseName.includes(marker));
  if (!looksLikeTest) {
    throw new Error(
      `Refusing to truncate "${databaseName}": the database name does not look like a test database. ` +
        'Set TEST_DATABASE_URL to a dedicated database (its name must contain "test").',
    );
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run destructive test helpers with NODE_ENV=production.');
  }
}

export function applyMigrations(): void {
  assertTestDatabase();
  if (migrated) return;
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
  migrated = true;
}

const TABLES = [
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
  'ProjectQualificationRequirement',
  'Domain',
  'ActivityEvent',
  'OutboxMessage',
  'Job',
  'Schedule',
  'Assignment',
  'AvailabilityWindow',
  'OnboardingItem',
  'OnboardingCase',
  'Invitation',
  'MatchCandidate',
  'MatchRun',
  'ProjectSkillRequirement',
  'Project',
  'ExpertSkill',
  'ExpertPortalSession',
  'ExpertPortalToken',
  'Expert',
  'Skill',
  'Session',
  'User',
];

export async function truncateAll(client: PrismaClient = prisma as PrismaClient): Promise<void> {
  assertTestDatabase();
  const list = TABLES.map((table) => `"${table}"`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** A second, independent client - used to prove cross-connection concurrency. */
export function newClient(): PrismaClient {
  return new PrismaClient({ log: ['warn', 'error'] });
}

export { prisma };
