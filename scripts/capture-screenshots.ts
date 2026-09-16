/**
 * Photograph every main surface, on a local copy of a seeded network.
 *
 *   DATABASE_URL=postgresql://…@localhost:5433/expertops_showcase \
 *   SCREENSHOT_BASE_URL=http://127.0.0.1:3201 SCREENSHOT_OUT=test-results/screenshots \
 *   npx tsx scripts/capture-screenshots.ts
 *
 * Used to produce the before-and-after pictures for the redesign, so the two
 * sets show the same records on the same pages.
 *
 * It writes to the database it is pointed at — a screenshot operator account
 * and single-use portal tokens — so it refuses anything that is not a local
 * database outside the development, test and browser-suite allow list. Tokens
 * never appear in a captured URL: they travel in the fragment and are checked
 * for before every capture.
 */
import 'dotenv/config';
import { mkdir } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import { prisma } from '@/lib/db';
import { parseDatabaseUrl } from '@/lib/database-safety';
import { generateToken, hashPassword, hashToken } from '@/lib/crypto';

const BASE = (process.env.SCREENSHOT_BASE_URL ?? 'http://127.0.0.1:3201').replace(/\/$/, '');
const OUT = process.env.SCREENSHOT_OUT ?? 'test-results/screenshots';
const OPERATOR_EMAIL = 'screenshots.operator@example.test';
/** Optional pattern, e.g. `SCREENSHOT_ONLY=expert|candidate`, to retake a few. */
const ONLY = process.env.SCREENSHOT_ONLY ? new RegExp(process.env.SCREENSHOT_ONLY) : null;
const wanted = (name: string) => !ONLY || ONLY.test(name);

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

async function shoot(page: Page, name: string, viewport: string) {
  if (!wanted(name)) return;
  const url = page.url();
  if (url.includes('#t=') || url.includes('/enter'))
    fail(`Refusing to capture a token URL (${name}).`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: `${OUT}/${name}-${viewport}.png`, fullPage: true });
  console.log(`    ${name}-${viewport}`);
}

/**
 * Follow a portal link without letting the token reach a log.
 *
 * Playwright's timeout error quotes every URL it navigated through, and the
 * first of those carries the token in its fragment.
 */
async function enter(page: Page, link: string, landing: string) {
  await page.goto(link);
  try {
    await page.waitForURL((u) => !u.pathname.startsWith(landing), { timeout: 30_000 });
  } catch {
    const text = (
      await page
        .locator('body')
        .innerText()
        .catch(() => '')
    ).slice(0, 400);
    fail(`The ${landing} link did not sign in. The page said: ${text}`);
  }
}

async function main() {
  const url = process.env.DATABASE_URL ?? fail('DATABASE_URL is not set.');
  const target = parseDatabaseUrl(url);
  const host = new URL(url).hostname;
  if (target.kind !== 'unknown' || !['localhost', '127.0.0.1'].includes(host)) {
    fail(`Refusing: this writes an account and tokens, so it only runs on a local scratch copy.`);
  }

  // --- subjects: the same records every run ---------------------------------
  const project = await prisma.project.findFirst({
    where: { assignments: { some: { status: 'CONFIRMED' } } },
    orderBy: { code: 'asc' },
    // Selected explicitly so this also runs against a copy that predates a
    // migration, which is exactly what a "before" picture is taken from.
    select: { id: true },
  });
  const opportunity = await prisma.opportunity.findFirst({
    where: { status: 'PUBLISHED' },
    orderBy: { reference: 'asc' },
    select: { id: true, slug: true },
  });
  const expert = await prisma.expert.findFirst({
    where: { assignments: { some: { status: 'CONFIRMED' } }, workItems: { some: {} } },
    orderBy: { reference: 'asc' },
    select: { id: true },
  });
  const candidate = await prisma.candidate.findFirst({
    where: { screenings: { some: {} }, applications: { some: {} } },
    orderBy: { reference: 'asc' },
    select: { id: true },
  });
  const application = candidate
    ? await prisma.application.findFirst({
        where: { candidateId: candidate.id },
        select: { id: true, opportunityId: true },
      })
    : null;
  const batch = await prisma.outreachBatch.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const campaign = await prisma.sourcingCampaign.findFirst({
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!project || !opportunity || !expert || !candidate) {
    fail('The database has no seeded network to photograph.');
  }

  // --- an account to sign in with, with a password nobody else knows --------
  const password = generateToken(18);
  await prisma.user.upsert({
    select: { id: true },
    where: { email: OPERATOR_EMAIL },
    create: {
      email: OPERATOR_EMAIL,
      name: 'Jordan Ellis',
      role: 'ADMIN',
      passwordHash: await hashPassword(password),
    },
    update: { passwordHash: await hashPassword(password) },
  });

  async function expertLink() {
    const token = generateToken();
    await prisma.expertPortalToken.create({
      data: {
        expertId: expert!.id,
        tokenHash: hashToken(token),
        purpose: 'GENERAL',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return `${BASE}/portal/enter#t=${encodeURIComponent(token)}`;
  }

  async function candidateLink() {
    const token = generateToken();
    await prisma.candidatePortalToken.create({
      data: {
        candidateId: candidate!.id,
        tokenHash: hashToken(token),
        purpose: 'SCREENING',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    return `${BASE}/apply/enter#t=${encodeURIComponent(token)}`;
  }

  await mkdir(OUT, { recursive: true });
  const browser: Browser = await chromium.launch();
  console.log(`\n  Capturing ${BASE} into ${OUT}`);

  try {
    for (const viewport of VIEWPORTS) {
      const size = { width: viewport.width, height: viewport.height };

      // Signed out.
      const anon = await browser.newContext({ viewport: size, baseURL: BASE });
      const page = await anon.newPage();
      for (const [name, path] of [
        ['public-demo', '/demo'],
        ['public-opportunities', '/apply/opportunities'],
        ['public-opportunity-detail', `/apply/opportunities/${opportunity.slug}`],
        ['sign-in', '/login'],
      ] as const) {
        if (!wanted(name)) continue;
        await page.goto(path);
        await shoot(page, name, viewport.name);
      }
      await anon.close();

      // The operator.
      const ops = await browser.newContext({ viewport: size, baseURL: BASE });
      const op = await ops.newPage();
      await op.goto('/login');
      await op.getByLabel('Work email').fill(OPERATOR_EMAIL);
      await op.getByLabel('Password').fill(password);
      await op.getByRole('button', { name: 'Sign in' }).click();
      await op.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30_000 });

      const operatorPages: [string, string][] = [
        ['operator-attention', '/attention'],
        ['operator-dashboard', '/dashboard'],
        ['operator-opportunities', '/opportunities'],
        ['operator-opportunity-detail', `/opportunities/${opportunity.id}`],
        ['operator-candidates', '/candidates'],
        ['operator-candidate-detail', `/candidates/${candidate.id}`],
        ['operator-campaigns', '/campaigns'],
        ['operator-screenings', '/screenings'],
        ['operator-rubrics', '/rubrics'],
        ['operator-experts', '/experts'],
        ['operator-expert-detail', `/experts/${expert.id}`],
        ['operator-projects', '/projects'],
        ['operator-project-detail', `/projects/${project.id}`],
        ['operator-outreach', '/outreach'],
        ['operator-verification', '/onboarding'],
        ['operator-delivery', '/work'],
        ['operator-support', '/support'],
        ['operator-payments', '/payments'],
        ['operator-activity', '/activity'],
        ['operator-worker', '/jobs'],
        ['operator-new-project', '/projects/new'],
      ];
      if (application) {
        operatorPages.push([
          'operator-applicant-detail',
          `/opportunities/${application.opportunityId}/applicants/${application.id}`,
        ]);
      }
      if (batch) operatorPages.push(['operator-outreach-detail', `/outreach/${batch.id}`]);
      if (campaign) operatorPages.push(['operator-campaign-detail', `/campaigns/${campaign.id}`]);

      for (const [name, path] of operatorPages) {
        if (!wanted(name)) continue;
        await op.goto(path);
        await shoot(op, name, viewport.name);
      }
      if (viewport.name === 'mobile' && wanted('operator-menu')) {
        await op.goto('/dashboard');
        const menu = op.getByRole('button', { name: /Menu/ });
        if (await menu.isVisible().catch(() => false)) {
          await menu.click();
          await op.waitForTimeout(300);
          await op.screenshot({ path: `${OUT}/operator-menu-${viewport.name}.png` });
          console.log(`    operator-menu-${viewport.name}`);
        }
      }
      await ops.close();

      // The candidate, through their own single-use link.
      if (wanted('candidate-status')) {
        const cand = await browser.newContext({ viewport: size, baseURL: BASE });
        const cp = await cand.newPage();
        await enter(cp, await candidateLink(), '/apply/enter');
        await shoot(cp, 'candidate-status', viewport.name);
        await cand.close();
      }

      // The expert, the same way.
      if (wanted('expert-portal')) {
        const exp = await browser.newContext({ viewport: size, baseURL: BASE });
        const ep = await exp.newPage();
        await enter(ep, await expertLink(), '/portal/enter');
        await shoot(ep, 'expert-portal', viewport.name);
        await exp.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log('\n  Done.\n');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
