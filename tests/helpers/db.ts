import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import { assertDestructiveAllowed } from '@/lib/database-safety';

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
 * or production database would silently destroy real work, so this delegates to
 * the shared fail-closed guard rather than keeping a second, drifting copy of
 * the rules.
 */
export function assertTestDatabase(url = process.env.DATABASE_URL ?? ''): void {
  assertDestructiveAllowed({
    operation: 'truncate every table',
    allow: ['test', 'e2e'],
    url,
  });
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
  'LoginAttempt',
  'WorkerHeartbeat',
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
