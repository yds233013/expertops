import {
  type Expert,
  type ExpertStatus,
  type PrismaClient,
  type Project,
  type ProjectStatus,
  type User,
  type UserRole,
} from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/lib/crypto';
import { slugify } from '@/lib/ids';
import { operatorActor, expertActor, type Actor } from '@/server/services/activity';
import { ONBOARDING_CHECKLIST } from '@/server/services/onboarding';

/**
 * Factories build the smallest valid row for a test, with every field
 * overridable. They talk to the database directly rather than through services,
 * so a test can set up an awkward state the UI could never reach.
 */
let counter = 0;
function unique(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export async function makeOperator(
  overrides: Partial<{
    email: string;
    name: string;
    role: UserRole;
    password: string;
    isActive: boolean;
  }> = {},
  client: PrismaClient = prisma as PrismaClient,
): Promise<User & { plainPassword: string }> {
  const password = overrides.password ?? 'test-password-123';
  const user = await client.user.create({
    data: {
      email: overrides.email ?? `${unique('operator')}@expertops.test`,
      name: overrides.name ?? 'Test Operator',
      role: overrides.role ?? 'OPERATOR',
      isActive: overrides.isActive ?? true,
      passwordHash: await hashPassword(password),
    },
  });
  return Object.assign(user, { plainPassword: password });
}

export function actorFor(user: User): Actor {
  return operatorActor(user);
}

export function actorForExpert(expert: Expert): Actor {
  return expertActor(expert);
}

export async function makeSkill(name: string, client: PrismaClient = prisma as PrismaClient) {
  return client.skill.upsert({
    where: { slug: slugify(name) },
    update: {},
    create: { name, slug: slugify(name) },
  });
}

export interface ExpertOverrides {
  fullName?: string;
  email?: string;
  status?: ExpertStatus;
  yearsExperience?: number;
  hourlyRateCents?: number;
  timezone?: string;
  weeklyCapacityHours?: number;
  skills?: Array<{ name: string; proficiency?: number; yearsUsed?: number }>;
}

export async function makeExpert(
  overrides: ExpertOverrides = {},
  client: PrismaClient = prisma as PrismaClient,
): Promise<Expert> {
  const skills = overrides.skills ?? [];
  const records = await Promise.all(skills.map((skill) => makeSkill(skill.name, client)));

  return client.expert.create({
    data: {
      reference: unique('EXP').toUpperCase().slice(0, 20),
      fullName: overrides.fullName ?? 'Test Expert',
      email: overrides.email ?? `${unique('expert')}@example.test`,
      headline: 'Test headline',
      status: overrides.status ?? 'PROSPECT',
      yearsExperience: overrides.yearsExperience ?? 10,
      hourlyRateCents: overrides.hourlyRateCents ?? 20_000,
      timezone: overrides.timezone ?? 'UTC',
      weeklyCapacityHours: overrides.weeklyCapacityHours ?? 20,
      skills: {
        create: skills.map((skill, index) => ({
          skillId: records[index]!.id,
          proficiency: skill.proficiency ?? 4,
          yearsUsed: skill.yearsUsed ?? 5,
        })),
      },
    },
  });
}

export interface ProjectOverrides {
  title?: string;
  clientName?: string;
  status?: ProjectStatus;
  seatsRequested?: number;
  minYearsExperience?: number;
  maxHourlyRateCents?: number | null;
  preferredTimezone?: string;
  requirements?: Array<{
    name: string;
    required?: boolean;
    minProficiency?: number;
    weight?: number;
  }>;
}

export async function makeProject(
  createdById: string,
  overrides: ProjectOverrides = {},
  client: PrismaClient = prisma as PrismaClient,
): Promise<Project> {
  const requirements = overrides.requirements ?? [{ name: 'Distributed Systems', required: true }];
  const records = await Promise.all(requirements.map((r) => makeSkill(r.name, client)));

  return client.project.create({
    data: {
      code: unique('PRJ').toUpperCase().slice(0, 20),
      title: overrides.title ?? 'Test project',
      clientName: overrides.clientName ?? 'Test Client',
      status: overrides.status ?? 'MATCHING',
      seatsRequested: overrides.seatsRequested ?? 1,
      minYearsExperience: overrides.minYearsExperience ?? 0,
      maxHourlyRateCents:
        overrides.maxHourlyRateCents === undefined ? 40_000 : overrides.maxHourlyRateCents,
      preferredTimezone: overrides.preferredTimezone ?? 'UTC',
      createdById,
      requirements: {
        create: requirements.map((requirement, index) => ({
          skillId: records[index]!.id,
          required: requirement.required ?? false,
          minProficiency: requirement.minProficiency ?? 3,
          weight: requirement.weight ?? 3,
        })),
      },
    },
  });
}

/** Build an expert who is fully ready to be staffed on `projectId`. */
export async function makeStaffableExpert(
  projectId: string,
  overrides: ExpertOverrides = {},
  client: PrismaClient = prisma as PrismaClient,
): Promise<Expert> {
  const expert = await makeExpert({ ...overrides, status: 'VERIFIED' }, client);

  await client.onboardingCase.create({
    data: {
      expertId: expert.id,
      status: 'VERIFIED',
      submittedAt: new Date(),
      verifiedAt: new Date(),
      items: {
        create: ONBOARDING_CHECKLIST.map((item, position) => ({
          key: item.key,
          label: item.label,
          helpText: item.helpText,
          kind: item.kind,
          required: item.required,
          position,
          value: item.kind === 'ATTESTATION' ? 'true' : 'Provided',
          completedAt: new Date(),
        })),
      },
    },
  });

  await client.invitation.create({
    data: {
      projectId,
      expertId: expert.id,
      status: 'ACCEPTED',
      expiresAt: new Date(Date.now() + 86_400_000),
      sentAt: new Date(),
      respondedAt: new Date(),
    },
  });

  await client.availabilityWindow.create({
    data: {
      expertId: expert.id,
      projectId,
      startAt: new Date(Date.now() - 86_400_000),
      endAt: new Date(Date.now() + 60 * 86_400_000),
      hoursPerWeek: overrides.weeklyCapacityHours ?? 20,
    },
  });

  return expert;
}
