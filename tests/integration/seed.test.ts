import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { applyMigrations } from '../helpers/db';
import { verifyPassword } from '@/lib/crypto';
import { ONBOARDING_CHECKLIST } from '@/server/services/onboarding';

/**
 * The seed must be repeatable: running it twice produces identical data, so a
 * demo, a screenshot, or a bug report always describes the same database.
 */
function runSeed(): void {
  execFileSync('npx', ['tsx', 'prisma/seed.ts'], {
    stdio: 'pipe',
    env: { ...process.env, LOG_LEVEL: 'silent' },
  });
}

async function fingerprint(): Promise<string> {
  const experts = await prisma.expert.findMany({
    orderBy: { reference: 'asc' },
    select: {
      reference: true,
      fullName: true,
      email: true,
      status: true,
      yearsExperience: true,
      hourlyRateCents: true,
      timezone: true,
      weeklyCapacityHours: true,
    },
  });
  const projects = await prisma.project.findMany({
    orderBy: { code: 'asc' },
    select: {
      code: true,
      title: true,
      clientName: true,
      status: true,
      seatsRequested: true,
      minYearsExperience: true,
      maxHourlyRateCents: true,
      preferredTimezone: true,
    },
  });
  return JSON.stringify({ experts, projects });
}

describe('synthetic seed data', () => {
  beforeAll(() => {
    applyMigrations();
    runSeed();
  });

  it('produces identical data on a second run', async () => {
    const first = await fingerprint();
    runSeed();
    const second = await fingerprint();
    expect(second).toBe(first);
  });

  it('creates the three demo operator roles with the documented password', async () => {
    const users = await prisma.user.findMany({ orderBy: { email: 'asc' } });
    expect(users.map((user) => user.role).sort()).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);

    const admin = users.find((user) => user.role === 'ADMIN')!;
    expect(admin.email).toBe('admin@expertops.test');
    expect(
      await verifyPassword(
        process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123',
        admin.passwordHash,
      ),
    ).toBe(true);
  });

  it('never stores a plaintext password', async () => {
    const users = await prisma.user.findMany();
    for (const user of users) {
      expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(user.passwordHash).not.toContain('demo-password');
    }
  });

  it('uses only unroutable example.test addresses for experts', async () => {
    const experts = await prisma.expert.findMany({ select: { email: true } });
    expect(experts.length).toBeGreaterThan(0);
    for (const expert of experts) {
      expect(expert.email).toMatch(/@example\.test$/);
    }
  });

  it('uses .test operator addresses so nothing can be mailed', async () => {
    const users = await prisma.user.findMany({ select: { email: true } });
    for (const user of users) {
      expect(user.email).toMatch(/@expertops\.test$/);
    }
  });

  it('spreads experts across the lifecycle so every screen has content', async () => {
    const grouped = await prisma.expert.groupBy({ by: ['status'], _count: { _all: true } });
    const byStatus = Object.fromEntries(grouped.map((row) => [row.status, row._count._all]));
    expect(byStatus.PROSPECT ?? 0).toBeGreaterThan(0);
    expect(byStatus.VERIFIED ?? 0).toBeGreaterThan(0);
    expect(byStatus.PENDING_VERIFICATION ?? 0).toBeGreaterThan(0);
  });

  it('gives every submitted case a full checklist', async () => {
    const submitted = await prisma.onboardingCase.findMany({
      where: { status: 'SUBMITTED' },
      include: { items: true },
    });
    expect(submitted.length).toBeGreaterThan(0);
    for (const onboardingCase of submitted) {
      expect(onboardingCase.items).toHaveLength(ONBOARDING_CHECKLIST.length);
      const required = onboardingCase.items.filter((item) => item.required);
      expect(required.every((item) => item.completedAt !== null)).toBe(true);
    }
  });

  it('creates projects that are ready for matching', async () => {
    const projects = await prisma.project.findMany({ include: { requirements: true } });
    expect(projects.length).toBeGreaterThan(0);
    for (const project of projects) {
      expect(project.requirements.length).toBeGreaterThan(0);
      expect(project.requirements.some((requirement) => requirement.required)).toBe(true);
    }
  });

  it('registers the scheduled jobs', async () => {
    const schedules = await prisma.schedule.findMany();
    expect(schedules.length).toBeGreaterThan(0);
    expect(schedules.map((schedule) => schedule.name)).toContain('outbox-dispatch');
  });

  it('starts with an empty outbox and job queue', async () => {
    expect(await prisma.outboxMessage.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it('records no protected personal attribute anywhere in an expert row', async () => {
    const experts = await prisma.expert.findMany({ take: 5 });
    for (const expert of experts) {
      const columns = Object.keys(expert).map((key) => key.toLowerCase());
      for (const forbidden of [
        'age',
        'dateofbirth',
        'gender',
        'ethnicity',
        'nationality',
        'citizenship',
        'religion',
        'disability',
        'maritalstatus',
      ]) {
        expect(columns).not.toContain(forbidden);
      }
    }
  });
});
