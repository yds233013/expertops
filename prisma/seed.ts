/**
 * Repeatable synthetic seed.
 *
 * Everything below is generated from a fixed pseudo-random seed, so running
 * `npm run db:seed` twice produces byte-identical data. No real person, client
 * or email address is represented: names are assembled from neutral word pools
 * and every address is on the reserved `@example.test` domain, which cannot
 * receive mail.
 *
 * No protected personal attributes are generated anywhere. Experts carry only
 * professional data: skills, seniority, rate, timezone and weekly capacity.
 */
import 'dotenv/config';
import { PrismaClient, type Prisma } from '@prisma/client';
import { hashPassword } from '../src/lib/crypto';
import { createLogger } from '../src/lib/logger';
import { ONBOARDING_CHECKLIST } from '../src/server/services/onboarding';
import { DEFAULT_SCHEDULES } from '../src/server/services/schedules';

const prisma = new PrismaClient();
const log = createLogger('seed');

const SEED_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'demo-password-123';

// --- deterministic pseudo-random ------------------------------------------
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(20260911);

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

function pickMany<T>(items: readonly T[], count: number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i += 1) {
    chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!);
  }
  return chosen;
}

function intBetween(min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 86_400_000);
}

// --- synthetic vocabulary --------------------------------------------------
const GIVEN_NAMES = [
  'Avery',
  'Rowan',
  'Quinn',
  'Sasha',
  'Noor',
  'Kai',
  'Ellis',
  'Marlow',
  'Devin',
  'Remy',
  'Aria',
  'Toby',
  'Nikita',
  'Jules',
  'Soren',
  'Indira',
  'Casey',
  'Lior',
  'Mika',
  'Tamsin',
  'Ravi',
  'Iris',
  'Gale',
  'Hana',
  'Emre',
  'Lena',
  'Oren',
  'Bea',
  'Silas',
  'Wren',
  'Ines',
  'Kirby',
  'Arlo',
  'Nadia',
  'Corin',
  'Petra',
  'Emil',
  'Yuki',
  'Dara',
  'Finn',
];

const FAMILY_NAMES = [
  'Okafor',
  'Lindqvist',
  'Barros',
  'Mehta',
  'Nakamura',
  'Delaney',
  'Alvarez',
  'Bergstrom',
  'Haddad',
  'Novak',
  'Petrov',
  'Cortes',
  'Brennan',
  'Duarte',
  'Fontaine',
  'Iversen',
  'Kovacs',
  'Marchetti',
  'Nurse',
  'Oyelaran',
  'Pires',
  'Rahman',
  'Sandoval',
  'Tanaka',
  'Ulrich',
  'Vasquez',
  'Whitfield',
  'Xu',
  'Yilmaz',
  'Zografos',
];

const SKILLS = [
  { name: 'Payments Infrastructure', category: 'fintech' },
  { name: 'Card Network Operations', category: 'fintech' },
  { name: 'Risk Modelling', category: 'fintech' },
  { name: 'Regulatory Reporting', category: 'compliance' },
  { name: 'AML Programme Design', category: 'compliance' },
  { name: 'Clinical Trial Operations', category: 'life-sciences' },
  { name: 'Medical Device Regulation', category: 'life-sciences' },
  { name: 'Supply Chain Planning', category: 'industrial' },
  { name: 'Manufacturing Automation', category: 'industrial' },
  { name: 'Energy Grid Modelling', category: 'energy' },
  { name: 'Carbon Accounting', category: 'energy' },
  { name: 'Cloud Cost Engineering', category: 'technology' },
  { name: 'Data Platform Architecture', category: 'technology' },
  { name: 'Kubernetes Operations', category: 'technology' },
  { name: 'Postgres Performance', category: 'technology' },
  { name: 'Distributed Systems', category: 'technology' },
  { name: 'Pricing Strategy', category: 'commercial' },
  { name: 'Go-To-Market Strategy', category: 'commercial' },
  { name: 'Procurement Transformation', category: 'commercial' },
  { name: 'Post-Merger Integration', category: 'commercial' },
] as const;

const HEADLINE_ROLES = [
  'Principal Consultant',
  'Independent Advisor',
  'Fractional Head of Engineering',
  'Former Programme Director',
  'Specialist Practitioner',
  'Senior Operating Partner',
  'Interim Delivery Lead',
  'Domain Specialist',
];

const HEADLINE_DOMAINS = [
  'payments platforms',
  'regulated data programmes',
  'industrial operations',
  'clinical delivery',
  'grid modernisation',
  'cloud platform economics',
  'commercial transformation',
  'post-merger integration',
];

const TIMEZONES = [
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Warsaw',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Africa/Nairobi',
];

const CLIENTS = [
  'Northwind Logistics',
  'Meridian Health Group',
  'Harborline Payments',
  'Calder Energy Partners',
  'Vantage Industrial',
  'Bluecrest Retail Group',
];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function reference(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(4, '0')}`;
}

async function reset() {
  // Order matters only for readability: every relation cascades, but truncating
  // explicitly keeps the seed independent of cascade configuration.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ActivityEvent", "OutboxMessage", "Job", "Schedule", "AttentionItem",
      "OffboardingTask", "PaymentItem", "PaymentBatch",
      "SupportReply", "SupportRequest",
      "WorkReview", "WorkSubmission", "WorkItem",
      "OutreachBatchItem", "OutreachBatch",
      "Assignment", "AvailabilityWindow", "OnboardingItem", "OnboardingCase",
      "Invitation", "MatchCandidate", "MatchRun",
      "ProjectQualificationRequirement", "ProjectSkillRequirement", "Project",
      "Qualification", "ReviewConflict", "ScreeningReview", "ScreeningSubmission", "Screening",
      "RubricCriterion", "ScreeningRubricVersion", "ScreeningTemplate",
      "DuplicateFlag", "Application",
      "CandidatePortalSession", "CandidatePortalToken", "Candidate",
      "SourcingCampaign", "SourceChannel", "Domain",
      "ExpertSkill", "ExpertPortalSession", "ExpertPortalToken", "Expert",
      "Skill", "Session", "User"
    RESTART IDENTITY CASCADE
  `);
}

async function seedOperators() {
  const passwordHash = await hashPassword(SEED_PASSWORD);
  const definitions = [
    { email: 'admin@expertops.test', name: 'Dana Whitfield', role: 'ADMIN' as const },
    { email: 'operator@expertops.test', name: 'Sam Okafor', role: 'OPERATOR' as const },
    { email: 'viewer@expertops.test', name: 'Robin Iversen', role: 'VIEWER' as const },
  ];
  const users = [];
  for (const definition of definitions) {
    users.push(await prisma.user.create({ data: { ...definition, passwordHash } }));
  }
  log.info('operators seeded', { count: users.length });
  return users;
}

async function seedSkills() {
  const created = [];
  for (const skill of SKILLS) {
    created.push(
      await prisma.skill.create({
        data: { name: skill.name, slug: slugify(skill.name), category: skill.category },
      }),
    );
  }
  log.info('skills seeded', { count: created.length });
  return created;
}

const EXPERT_COUNT = 36;

async function seedExperts(skills: Awaited<ReturnType<typeof seedSkills>>) {
  const experts = [];
  const usedEmails = new Set<string>();

  for (let index = 1; index <= EXPERT_COUNT; index += 1) {
    const given = pick(GIVEN_NAMES);
    const family = pick(FAMILY_NAMES);
    const fullName = `${given} ${family}`;

    let email = `${given}.${family}`.toLowerCase() + '@example.test';
    let suffix = 2;
    while (usedEmails.has(email)) {
      email = `${given}.${family}${suffix}`.toLowerCase() + '@example.test';
      suffix += 1;
    }
    usedEmails.add(email);

    const yearsExperience = intBetween(3, 26);
    const chosenSkills = pickMany(skills, intBetween(2, 5));

    // A spread of lifecycle states so every operator screen has content on a
    // fresh seed. The demo walkthrough drives one expert through the full flow.
    const statusRoll = random();
    const status =
      statusRoll < 0.5
        ? 'PROSPECT'
        : statusRoll < 0.62
          ? 'ONBOARDING'
          : statusRoll < 0.74
            ? 'PENDING_VERIFICATION'
            : statusRoll < 0.94
              ? 'VERIFIED'
              : 'ARCHIVED';

    const expert = await prisma.expert.create({
      data: {
        reference: reference('EXP', index),
        fullName,
        email,
        headline: `${pick(HEADLINE_ROLES)} — ${pick(HEADLINE_DOMAINS)}`,
        bio: `Synthetic profile generated for local development. ${yearsExperience} years of hands-on delivery across ${chosenSkills.map((s) => s.name.toLowerCase()).join(', ')}.`,
        status,
        yearsExperience,
        timezone: pick(TIMEZONES),
        hourlyRateCents: intBetween(90, 420) * 100,
        currency: 'USD',
        weeklyCapacityHours: intBetween(5, 40),
        notes: '',
        skills: {
          create: chosenSkills.map((skill) => ({
            skillId: skill.id,
            proficiency: intBetween(2, 5),
            yearsUsed: intBetween(1, Math.max(1, yearsExperience - 1)),
          })),
        },
      },
    });

    // Experts past PROSPECT have an onboarding case in a matching state.
    if (status === 'ONBOARDING' || status === 'PENDING_VERIFICATION' || status === 'VERIFIED') {
      const caseStatus =
        status === 'ONBOARDING'
          ? 'IN_PROGRESS'
          : status === 'PENDING_VERIFICATION'
            ? 'SUBMITTED'
            : 'VERIFIED';

      const complete = caseStatus !== 'IN_PROGRESS';
      await prisma.onboardingCase.create({
        data: {
          expertId: expert.id,
          status: caseStatus,
          startedAt: daysFromNow(-intBetween(3, 20)),
          submittedAt: complete ? daysFromNow(-intBetween(1, 3)) : null,
          verifiedAt: caseStatus === 'VERIFIED' ? daysFromNow(-1) : null,
          items: {
            create: ONBOARDING_CHECKLIST.map((item, position) => {
              const answered = complete || position < 2;
              const value = !answered
                ? null
                : item.kind === 'ATTESTATION'
                  ? 'true'
                  : item.key === 'conflict_check'
                    ? 'None'
                    : item.key === 'billing_reference'
                      ? `SIM-BILL-${reference('EXP', index)}`
                      : 'Prefers afternoons in local time.';
              return {
                key: item.key,
                label: item.label,
                helpText: item.helpText,
                kind: item.kind,
                required: item.required,
                position,
                value,
                completedAt: answered ? daysFromNow(-intBetween(1, 10)) : null,
              };
            }),
          },
        },
      });

      // Verified experts have general availability on file.
      if (status === 'VERIFIED') {
        await prisma.availabilityWindow.create({
          data: {
            expertId: expert.id,
            startAt: daysFromNow(intBetween(1, 5)),
            endAt: daysFromNow(intBetween(60, 120)),
            hoursPerWeek: Math.max(5, Math.min(40, expert.weeklyCapacityHours)),
            note: 'General availability (synthetic seed data).',
          },
        });
      }
    }

    experts.push(expert);
  }

  log.info('experts seeded', { count: experts.length });
  return experts;
}

async function seedProjects(
  users: Awaited<ReturnType<typeof seedOperators>>,
  skills: Awaited<ReturnType<typeof seedSkills>>,
) {
  const admin = users[0]!;
  const operator = users[1]!;

  const definitions: Array<{
    title: string;
    status: 'DRAFT' | 'MATCHING' | 'INVITING' | 'STAFFING';
    seats: number;
    minYears: number;
    maxRate: number | null;
    timezone: string;
    requiredSkillCount: number;
  }> = [
    {
      title: 'Card settlement reconciliation review',
      status: 'MATCHING',
      seats: 2,
      minYears: 8,
      maxRate: 32_000,
      timezone: 'Europe/London',
      requiredSkillCount: 2,
    },
    {
      title: 'Regulatory reporting readiness assessment',
      status: 'INVITING',
      seats: 1,
      minYears: 10,
      maxRate: 38_000,
      timezone: 'America/New_York',
      requiredSkillCount: 1,
    },
    {
      title: 'Warehouse automation feasibility study',
      status: 'DRAFT',
      seats: 3,
      minYears: 6,
      maxRate: 28_000,
      timezone: 'Europe/Berlin',
      requiredSkillCount: 2,
    },
    {
      title: 'Grid interconnection modelling support',
      status: 'MATCHING',
      seats: 2,
      minYears: 7,
      maxRate: null,
      timezone: 'UTC',
      requiredSkillCount: 1,
    },
    {
      title: 'Cloud spend reduction programme',
      status: 'STAFFING',
      seats: 2,
      minYears: 5,
      maxRate: 30_000,
      timezone: 'America/Los_Angeles',
      requiredSkillCount: 2,
    },
  ];

  const projects = [];
  for (const [index, definition] of definitions.entries()) {
    const chosen = pickMany(skills, definition.requiredSkillCount + intBetween(1, 2));
    const project = await prisma.project.create({
      data: {
        code: reference('PRJ', index + 1),
        title: definition.title,
        clientName: CLIENTS[index % CLIENTS.length]!,
        description:
          'Synthetic engagement generated for local development. Scope, client and dates are fictional.',
        status: definition.status,
        seatsRequested: definition.seats,
        minYearsExperience: definition.minYears,
        maxHourlyRateCents: definition.maxRate,
        preferredTimezone: definition.timezone,
        startDate: daysFromNow(intBetween(7, 21)),
        endDate: daysFromNow(intBetween(90, 180)),
        createdById: index % 2 === 0 ? operator.id : admin.id,
        requirements: {
          create: chosen.map((skill, position) => ({
            skillId: skill.id,
            required: position < definition.requiredSkillCount,
            minProficiency: position < definition.requiredSkillCount ? 3 : 2,
            weight: position < definition.requiredSkillCount ? intBetween(3, 5) : intBetween(1, 3),
          })),
        },
      },
    });
    projects.push(project);
  }

  log.info('projects seeded', { count: projects.length });
  return projects;
}

async function seedActivity(
  users: Awaited<ReturnType<typeof seedOperators>>,
  projects: Awaited<ReturnType<typeof seedProjects>>,
  experts: Awaited<ReturnType<typeof seedExperts>>,
) {
  const operator = users[1]!;
  const events: Prisma.ActivityEventCreateManyInput[] = [];

  for (const project of projects) {
    events.push({
      actorType: 'OPERATOR',
      actorUserId: operator.id,
      actorLabel: `${operator.name} <${operator.email}>`,
      entityType: 'project',
      entityId: project.id,
      action: 'project.created',
      summary: `Project ${project.code} "${project.title}" created for ${project.clientName}`,
      projectId: project.id,
      metadata: { seeded: true },
      createdAt: daysFromNow(-intBetween(5, 30)),
    });
  }

  for (const expert of experts.slice(0, 12)) {
    events.push({
      actorType: 'OPERATOR',
      actorUserId: operator.id,
      actorLabel: `${operator.name} <${operator.email}>`,
      entityType: 'expert',
      entityId: expert.id,
      action: 'expert.created',
      summary: `Expert ${expert.reference} (${expert.fullName}) added to the network`,
      expertId: expert.id,
      metadata: { seeded: true },
      createdAt: daysFromNow(-intBetween(5, 60)),
    });
  }

  await prisma.activityEvent.createMany({ data: events });
  log.info('activity seeded', { count: events.length });
}

// --- extension: domains, source channels and screening rubrics -------------

const DOMAINS = [
  {
    slug: 'cybersecurity',
    name: 'Cybersecurity',
    description: 'Security operations, incident response and threat analysis.',
  },
  {
    slug: 'payments',
    name: 'Payments',
    description: 'Card schemes, settlement and payment infrastructure.',
  },
  {
    slug: 'life-sciences',
    name: 'Life Sciences',
    description: 'Clinical operations and medical device regulation.',
  },
] as const;

async function seedDomains() {
  const created = [];
  for (const domain of DOMAINS) {
    created.push(await prisma.domain.create({ data: { ...domain } }));
  }
  log.info('domains seeded', { count: created.length });
  return created;
}

const SOURCE_CHANNELS = [
  { name: 'Practitioner community', kind: 'COMMUNITY' as const },
  { name: 'Expert referral', kind: 'REFERRAL' as const },
  { name: 'Direct application', kind: 'DIRECT_APPLICATION' as const },
  { name: 'Conference contact', kind: 'EVENT' as const },
  { name: 'Bulk import', kind: 'IMPORT' as const },
];

async function seedSourceChannels() {
  for (const channel of SOURCE_CHANNELS) {
    await prisma.sourceChannel.create({
      data: { slug: slugify(channel.name), name: channel.name, kind: channel.kind },
    });
  }
  log.info('source channels seeded', { count: SOURCE_CHANNELS.length });
}

/**
 * Rubrics are seeded already published, because a published version is
 * immutable and that is the state the demo and the tests need to exercise.
 * Cybersecurity gets two versions so the "raising the bar" path has something
 * real to work with.
 */
const CYBER_CRITERIA_V1 = [
  {
    key: 'incident-response',
    label: 'Incident response depth',
    scoringGuidance: '5 = has led containment on a live intrusion; 1 = classroom familiarity only.',
    maxScore: 5,
    weight: 3,
    requiredEvidence: 'WRITTEN_ANSWER' as const,
    isGating: true,
  },
  {
    key: 'threat-analysis',
    label: 'Threat analysis and attribution',
    scoringGuidance:
      '5 = builds original analysis from raw telemetry; 1 = consumes vendor reports.',
    maxScore: 5,
    weight: 2,
    requiredEvidence: 'WORK_SAMPLE_LINK' as const,
    isGating: false,
  },
  {
    key: 'communication',
    label: 'Written communication under pressure',
    scoringGuidance: '5 = writes an exec-ready summary mid-incident; 1 = needs heavy editing.',
    maxScore: 5,
    weight: 2,
    requiredEvidence: 'WRITTEN_ANSWER' as const,
    isGating: false,
  },
];

async function seedRubrics(
  domains: Awaited<ReturnType<typeof seedDomains>>,
  users: Awaited<ReturnType<typeof seedOperators>>,
) {
  const admin = users[0]!;
  const cyber = domains.find((domain) => domain.slug === 'cybersecurity')!;
  const payments = domains.find((domain) => domain.slug === 'payments')!;

  const cyberTemplate = await prisma.screeningTemplate.create({
    data: {
      slug: 'cybersecurity-practitioner',
      name: 'Cybersecurity practitioner screening',
      domainId: cyber.id,
      description: 'Baseline assessment for hands-on security practitioners.',
    },
  });

  // v1: the original bar.
  await prisma.screeningRubricVersion.create({
    data: {
      templateId: cyberTemplate.id,
      version: 1,
      status: 'PUBLISHED',
      passThreshold: 18,
      guidance: 'Assess demonstrated practice, not credentials.',
      changeNote: 'Initial published rubric.',
      publishedAt: daysFromNow(-120),
      publishedById: admin.id,
      criteria: {
        create: CYBER_CRITERIA_V1.map((criterion, position) => ({ ...criterion, position })),
      },
    },
  });

  // v2: a raised bar, adding a gating criterion. Used to demonstrate that
  // existing qualifications are flagged for re-review rather than revoked.
  await prisma.screeningRubricVersion.create({
    data: {
      templateId: cyberTemplate.id,
      version: 2,
      status: 'PUBLISHED',
      passThreshold: 24,
      guidance: 'Assess demonstrated practice, not credentials. Cloud exposure is now required.',
      changeNote: 'Added a gating cloud-security criterion after three engagements needed it.',
      publishedAt: daysFromNow(-20),
      publishedById: admin.id,
      criteria: {
        create: [
          ...CYBER_CRITERIA_V1.map((criterion, position) => ({ ...criterion, position })),
          {
            key: 'cloud-security',
            label: 'Cloud control-plane security',
            scoringGuidance:
              '5 = has hardened a multi-account cloud estate; 1 = no direct exposure.',
            maxScore: 5,
            weight: 3,
            requiredEvidence: 'WRITTEN_ANSWER' as const,
            isGating: true,
            position: 3,
          },
        ],
      },
    },
  });

  const paymentsTemplate = await prisma.screeningTemplate.create({
    data: {
      slug: 'payments-specialist',
      name: 'Payments specialist screening',
      domainId: payments.id,
      description: 'Settlement, reconciliation and scheme rules.',
    },
  });
  await prisma.screeningRubricVersion.create({
    data: {
      templateId: paymentsTemplate.id,
      version: 1,
      status: 'PUBLISHED',
      passThreshold: 12,
      guidance: 'Focus on reconciliation practice and scheme rule fluency.',
      publishedAt: daysFromNow(-60),
      publishedById: admin.id,
      criteria: {
        create: [
          {
            key: 'settlement',
            label: 'Settlement and reconciliation',
            scoringGuidance: '5 = has owned a settlement break investigation end to end.',
            maxScore: 5,
            weight: 3,
            requiredEvidence: 'WRITTEN_ANSWER' as const,
            isGating: true,
            position: 0,
          },
          {
            key: 'scheme-rules',
            label: 'Scheme rule fluency',
            scoringGuidance: '5 = cites chapter and verse without looking it up.',
            maxScore: 5,
            weight: 2,
            requiredEvidence: 'NONE' as const,
            isGating: false,
            position: 1,
          },
        ],
      },
    },
  });

  log.info('rubrics seeded', { templates: 2, versions: 3 });
}

async function seedSchedules() {
  for (const definition of DEFAULT_SCHEDULES) {
    await prisma.schedule.create({
      data: {
        name: definition.name,
        jobType: definition.jobType,
        intervalSeconds: definition.intervalSeconds,
        payload: definition.payload ?? {},
        enabled: definition.enabled ?? true,
        nextRunAt: new Date(),
      },
    });
  }
  log.info('schedules seeded', { count: DEFAULT_SCHEDULES.length });
}

async function main() {
  log.info('seeding database', {
    url: (process.env.DATABASE_URL ?? '').replace(/:[^:@]+@/, ':***@'),
  });
  await reset();
  const users = await seedOperators();
  const skills = await seedSkills();
  const experts = await seedExperts(skills);
  const projects = await seedProjects(users, skills);
  const domains = await seedDomains();
  await seedSourceChannels();
  await seedRubrics(domains, users);
  await seedActivity(users, projects, experts);
  await seedSchedules();

  log.info('seed complete', {
    operators: users.length,
    skills: skills.length,
    experts: experts.length,
    projects: projects.length,
    domains: domains.length,
  });
  console.log('');
  console.log('Demo operator accounts (development only, password from SEED_DEMO_PASSWORD):');
  for (const user of users) {
    console.log(`  ${user.role.padEnd(8)} ${user.email}  password: ${SEED_PASSWORD}`);
  }
  console.log('');
  console.log('Experts have no password. They sign in through a single-use portal link');
  console.log('that appears in the simulated outbox at http://localhost:3000/outbox');
  console.log('');
}

main()
  .catch((error) => {
    log.error('seed failed', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
