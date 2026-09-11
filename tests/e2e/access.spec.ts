import { expect, test, type Page } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { operatorContext, portalLinkFor, visitorContext, waitForOutboxMessage } from './helpers';

/**
 * Access that must fail, checked in the browser.
 *
 * These are the cases where a mistake is silent: a link that should have
 * stopped working still works, or a changed id in the address bar returns
 * someone else's application. Each is asserted on the rendered page rather than
 * on a status code, because the page is what a person would see.
 */
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_e2e?schema=public';

test.describe.configure({ mode: 'serial' });

/**
 * Two candidates, each with their own screening.
 *
 * Set up through the operator interface so the records are real, then driven
 * from two separate candidate contexts.
 */
async function inviteCandidate(page: Page, name: string, email: string) {
  await page.goto('/candidates');
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Headline').fill('Evaluation specialist');
  await page.getByRole('button', { name: 'Add candidate' }).click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();

  await page.getByRole('link', { name }).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  const candidateUrl = page.url();

  await page.getByRole('button', { name: 'Send screening' }).click();
  await expect(page.getByText(/SCR-\d+/).first()).toBeVisible({ timeout: 20_000 });

  await waitForOutboxMessage(page, 'Screening exercise', name);
  return { candidateUrl };
}

test('an expired screening link is refused, and says why', async ({ browser }) => {
  const operator = await operatorContext(browser, 'admin');
  const candidate = await visitorContext(browser);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });

  try {
    await inviteCandidate(operator.page, 'Tomas Lind', 'tomas.lind@e2e.test');
    const link = await portalLinkFor(operator.page, 'Screening exercise', 'Tomas Lind');

    // Age only this candidate's unused token. Other tests' fixtures are not
    // touched, and the candidate's browser is untouched either way.
    const tomas = await prisma.candidate.findFirstOrThrow({
      where: { email: 'tomas.lind@e2e.test' },
    });
    await prisma.candidatePortalToken.updateMany({
      where: { candidateId: tomas.id, usedAt: null, revokedAt: null },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await candidate.page.goto(link);
    await expect(
      candidate.page.getByRole('heading', { name: 'This link cannot be opened' }),
    ).toBeVisible();
    await expect(candidate.page.getByText(/expired/i)).toBeVisible();

    // And it did not quietly create a session anyway.
    await candidate.page.goto('/apply');
    await expect(
      candidate.page.getByRole('heading', { name: 'Your session has ended' }),
    ).toBeVisible();
  } finally {
    await prisma.$disconnect();
    await operator.context.close();
    await candidate.context.close();
  }
});

test('a revoked screening link is refused', async ({ browser }) => {
  const operator = await operatorContext(browser, 'admin');
  const candidate = await visitorContext(browser);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });

  try {
    await inviteCandidate(operator.page, 'Mira Osei', 'mira.osei@e2e.test');
    const link = await portalLinkFor(operator.page, 'Screening exercise', 'Mira Osei');

    const mira = await prisma.candidate.findFirstOrThrow({
      where: { email: 'mira.osei@e2e.test' },
    });
    await prisma.candidatePortalToken.updateMany({
      where: { candidateId: mira.id, usedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await candidate.page.goto(link);
    await expect(
      candidate.page.getByRole('heading', { name: 'This link cannot be opened' }),
    ).toBeVisible();
    await expect(candidate.page.getByText(/revoked/i)).toBeVisible();
  } finally {
    await prisma.$disconnect();
    await operator.context.close();
    await candidate.context.close();
  }
});

test('a used link cannot be opened a second time', async ({ browser }) => {
  const operator = await operatorContext(browser, 'admin');
  const first = await visitorContext(browser);
  const second = await visitorContext(browser);

  try {
    await inviteCandidate(operator.page, 'Jonah Pike', 'jonah.pike@e2e.test');
    const link = await portalLinkFor(operator.page, 'Screening exercise', 'Jonah Pike');

    await first.page.goto(link);
    await expect(first.page.getByRole('heading', { name: /Hello, Jonah/ })).toBeVisible();

    // The same link in a different browser is dead, which is the point of a
    // single-use link: a forwarded email does not hand over the application.
    await second.page.goto(link);
    await expect(
      second.page.getByRole('heading', { name: 'This link cannot be opened' }),
    ).toBeVisible();
    await expect(second.page.getByText(/already been used/i)).toBeVisible();
  } finally {
    await operator.context.close();
    await first.context.close();
    await second.context.close();
  }
});

test('one candidate cannot reach another candidate’s screening by changing the id', async ({
  browser,
}) => {
  const operator = await operatorContext(browser, 'admin');
  const mine = await visitorContext(browser);
  const theirs = await visitorContext(browser);
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } }, log: [] });

  try {
    await inviteCandidate(operator.page, 'Nadia Frost', 'nadia.frost@e2e.test');
    const firstLink = await portalLinkFor(operator.page, 'Screening exercise', 'Nadia Frost');
    await mine.page.goto(firstLink);
    await expect(mine.page.getByRole('heading', { name: /Hello, Nadia/ })).toBeVisible();

    await inviteCandidate(operator.page, 'Owen Trask', 'owen.trask@e2e.test');
    const secondLink = await portalLinkFor(operator.page, 'Screening exercise', 'Owen Trask');
    await theirs.page.goto(secondLink);
    await expect(theirs.page.getByRole('heading', { name: /Hello, Owen/ })).toBeVisible();

    // Owen's screening id, requested from Nadia's session.
    const owen = await prisma.candidate.findFirstOrThrow({
      where: { email: 'owen.trask@e2e.test' },
      include: { screenings: true },
    });
    const owenScreeningId = owen.screenings[0]!.id;

    // Asked from inside Nadia's own session, exactly as changing an id in the
    // address bar would.
    const attempt = await mine.page.evaluate(async (id) => {
      const response = await fetch(`/api/apply/screenings/${id}`, {
        credentials: 'same-origin',
      });
      return { status: response.status, body: await response.text() };
    }, owenScreeningId);

    expect(attempt.status).toBe(404);
    expect(attempt.body).not.toContain('Owen');

    // Nadia's own page still shows only her own screening.
    await mine.page.goto('/apply');
    await expect(mine.page.getByRole('heading', { name: /Hello, Nadia/ })).toBeVisible();
    await expect(mine.page.getByText('Owen Trask')).toHaveCount(0);
  } finally {
    await prisma.$disconnect();
    await operator.context.close();
    await mine.context.close();
    await theirs.context.close();
  }
});

test('an operator page is not reachable without signing in', async ({ browser }) => {
  const visitor = await visitorContext(browser);
  try {
    await visitor.page.goto('/screenings');
    await expect(visitor.page.getByRole('button', { name: 'Sign in' })).toBeVisible();

    await visitor.page.goto('/payments');
    await expect(visitor.page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  } finally {
    await visitor.context.close();
  }
});
