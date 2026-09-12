import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { clickUntilVisible, operatorContext } from './helpers';

/**
 * Bulk outreach, through the browser.
 *
 * The finding this closes: outreach existed as a service with an approval gate
 * and no interface at all, so assembling, approving and dispatching a batch
 * were API-only operations. These steps walk the flow an operator now has:
 * preview, submit, approve, dispatch, and read the per-recipient result —
 * including a recipient who stops being eligible between approval and dispatch.
 *
 * One project and one set of experts are built once and reused, because
 * matching is the slow part and repeating it proves nothing extra.
 */
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_e2e?schema=public';

test.describe.configure({ mode: 'serial' });

const PROJECT = 'Outreach Pilot';
const RECIPIENTS = ['Ines Roche', 'Karl Mensah', 'Dara Volkov'];

let admin: { context: BrowserContext; page: Page };
let approver: { context: BrowserContext; page: Page };
let batchUrl = '';
/** Scopes the invitation assertions: other suites share this database. */
let projectId = '';

function db() {
  return new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });
}

test.beforeAll(async ({ browser }) => {
  admin = await operatorContext(browser, 'admin');
  approver = await operatorContext(browser, 'approver');
});

test.afterAll(async () => {
  await admin?.context.close();
  await approver?.context.close();
});

test('1. a project with ranked candidates', async () => {
  // Fixture setup: three experts who hold the seeded skill.
  const prisma = db();
  try {
    for (const name of RECIPIENTS) {
      const slug = name.toLowerCase().replace(/\s+/g, '-');
      await prisma.expert.upsert({
        where: { email: `${slug}@e2e.test` },
        update: { status: 'VERIFIED' },
        create: {
          reference: `EXP-OUT-${slug.slice(0, 6).toUpperCase()}`,
          fullName: name,
          email: `${slug}@e2e.test`,
          headline: 'Evaluation specialist',
          yearsExperience: 8,
          hourlyRateCents: 15000,
          status: 'VERIFIED',
          skills: {
            create: {
              skill: { connect: { slug: 'evaluation-design' } },
              proficiency: 4,
              yearsUsed: 5,
            },
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }

  const page = admin.page;
  await page.goto('/projects/new');
  await page.getByLabel('Title').fill(PROJECT);
  await page.getByLabel('Client').fill('Internal Research');
  await page.getByLabel('Seats').fill('3');
  await page.getByLabel('Min. experience').fill('0');
  await page.getByPlaceholder('Skill name').first().fill('Evaluation Design');
  await page.getByLabel('Requirement type').first().selectOption('optional');
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible();

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Open for matching' }).click(),
    page.getByRole('button', { name: /Run matching/ }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: /Run matching/ }).click(),
    page.getByRole('link', { name: RECIPIENTS[0]! }).first(),
  );
  projectId = page.url().split('/').pop()!;
});

test('2. preview a batch without sending anything', async () => {
  const page = admin.page;
  await page.goto('/outreach');

  const select = page.getByLabel('Project');
  const value = await select.locator('option').filter({ hasText: PROJECT }).getAttribute('value');
  await select.selectOption(value!);
  await page.getByRole('button', { name: 'Load candidates' }).click();

  for (const name of RECIPIENTS) {
    await expect(page.getByText(name).first()).toBeVisible();
  }

  // Other suites leave their own experts ranked for this domain, so the three
  // this test cares about are selected explicitly rather than assumed.
  const boxes = page.locator('fieldset input[type="checkbox"]');
  const total = await boxes.count();
  for (let index = 0; index < total; index += 1) {
    await boxes.nth(index).uncheck();
  }
  for (const name of RECIPIENTS) {
    await page.locator('label').filter({ hasText: name }).locator('input').check();
  }

  await page
    .getByLabel('Why these people, and what to say')
    .fill('Pilot needs three reviewers this month.');
  await page.getByRole('button', { name: /Preview a batch of 3$/ }).click();

  await expect(page.getByRole('heading', { name: /^BAT-/ })).toBeVisible();
  batchUrl = page.url();

  // Assembling a list contacts nobody.
  await expect(page.getByText('not attempted yet').first()).toBeVisible();
  const prisma = db();
  try {
    expect(await prisma.invitation.count({ where: { projectId } })).toBe(0);
  } finally {
    await prisma.$disconnect();
  }
});

test('3. submit for approval, which an unauthorised operator cannot give', async ({ browser }) => {
  await clickUntilVisible(
    () => admin.page.getByRole('button', { name: 'Submit for approval' }).click(),
    admin.page.getByText('pending approval').first(),
  );

  const plain = await operatorContext(browser, 'operator');
  try {
    await plain.page.goto(batchUrl);
    await expect(plain.page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    await expect(
      plain.page.getByText(/Waiting on an operator who holds the approval/),
    ).toBeVisible();
  } finally {
    await plain.context.close();
  }
});

test('4. an approver approves, and one recipient becomes ineligible first', async () => {
  await approver.page.goto(batchUrl);
  await clickUntilVisible(
    () => approver.page.getByRole('button', { name: 'Approve', exact: true }).click(),
    approver.page.getByRole('button', { name: /Dispatch to 3 recipients/ }),
  );

  // Between approval and dispatch, one recipient is archived.
  const prisma = db();
  try {
    await prisma.expert.update({
      where: { email: 'ines-roche@e2e.test' },
      data: { status: 'ARCHIVED' },
    });
  } finally {
    await prisma.$disconnect();
  }
});

test('5. dispatch reports each recipient, and skips the ineligible one', async () => {
  const page = approver.page;
  await clickUntilVisible(
    () => page.getByRole('button', { name: /Dispatch to 3 recipients/ }).click(),
    page.getByText(/permanently\s+skipped/),
  );

  await page.reload();
  // Two invitations, one permanent skip with its reason on the row.
  expect(await page.getByText('invitation created').count()).toBe(2);
  await expect(page.getByText(/archived/i).first()).toBeVisible();
  await expect(page.getByText('dispatched').first()).toBeVisible();

  const prisma = db();
  try {
    expect(await prisma.invitation.count({ where: { projectId } })).toBe(2);
  } finally {
    await prisma.$disconnect();
  }
});

test('6. dispatching again invites nobody twice', async () => {
  const page = approver.page;
  await page.goto(batchUrl);

  // A finished batch offers no dispatch button: nothing is outstanding.
  await expect(page.getByRole('button', { name: /Dispatch to/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Retry/ })).toHaveCount(0);

  // And asking again another way changes nothing.
  const batchId = batchUrl.split('/').pop()!;
  const response = await page.evaluate(async (id) => {
    const token = document.cookie
      .split(';')
      .map((part) => part.trim().split('='))
      .find(([key]) => key === 'expertops_csrf')?.[1];
    const res = await fetch(`/api/outreach-batches/${id}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-csrf-token': decodeURIComponent(token) } : {}),
      },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'dispatch' }),
    });
    return { status: res.status, body: await res.json() };
  }, batchId);

  expect(response.status).toBe(200);
  expect(response.body.dispatched).toBe(0);
  expect(response.body.alreadySent).toBe(2);

  const prisma = db();
  try {
    expect(await prisma.invitation.count({ where: { projectId } })).toBe(2);
  } finally {
    await prisma.$disconnect();
  }
});
