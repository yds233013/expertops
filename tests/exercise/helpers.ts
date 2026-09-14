import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * The three account identities this exercise uses.
 *
 * They are separate accounts, not separate people. Everything here is one
 * person at one keyboard testing that the application enforces separation of
 * duties between identities — which is what it can enforce. It is not, and is
 * not presented as, independent human approval.
 */
export const EXERCISE_OPERATORS = {
  lead: { email: 'exercise.lead@example.test', role: 'ADMIN' },
  approver: { email: 'exercise.approver@example.test', role: 'ADMIN' },
  coordinator: { email: 'exercise.coordinator@example.test', role: 'OPERATOR' },
} as const;

/**
 * Local-only passwords for a throwaway database on this machine.
 *
 * They are fixed rather than generated so the exercise can be re-run and so a
 * person can sign in and look around afterwards. Nothing here is a credential
 * for anything that exists outside this laptop.
 */
const PASSWORDS: Record<keyof typeof EXERCISE_OPERATORS, string> = {
  lead: process.env.EXERCISE_LEAD_PASSWORD ?? 'Ex3rcise-Lead-Local-2026',
  approver: process.env.EXERCISE_APPROVER_PASSWORD ?? 'Ex3rcise-Approver-Local-2026',
  coordinator: process.env.EXERCISE_COORDINATOR_PASSWORD ?? 'Ex3rcise-Coord-Local-2026',
};

export async function operatorContext(
  browser: Browser,
  who: keyof typeof EXERCISE_OPERATORS,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Work email').fill(EXERCISE_OPERATORS[who].email);
  await page.getByLabel('Password').fill(PASSWORDS[who]);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  return { context, page };
}

/** A fresh context with no session at all: an applicant or an expert. */
export async function visitorContext(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/**
 * Click, then wait for what the click was supposed to produce.
 *
 * Production HTML arrives before React attaches. A click in that window is
 * discarded — which is a defect on a form (fixed separately, see
 * `tests/e2e/hydration.spec.ts`) but is simply how a link or a server-rendered
 * button behaves. Retrying is what a person does.
 */
export async function clickUntilVisible(
  click: () => Promise<void>,
  expected: Locator,
  attempts = 5,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await click();
    try {
      await expected.waitFor({ state: 'visible', timeout: 6_000 });
      return;
    } catch {
      if (attempt === attempts) throw new Error('The click never produced its expected result.');
    }
  }
}

/** Wait for the worker to put a message in the simulated outbox. */
export async function waitForOutboxMessage(
  page: Page,
  subjectFragment: string,
  recipient?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.goto('/outbox');
        let cards = page
          .locator('section')
          .filter({ has: page.getByRole('heading', { name: new RegExp(subjectFragment, 'i') }) });
        if (recipient) cards = cards.filter({ hasText: `to ${recipient}` });
        return cards
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 90_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
}

/**
 * Read a single-use link out of the simulated outbox, the way an operator
 * handing one over in a demo would. The token is never printed to the log.
 */
export async function portalLinkFor(
  page: Page,
  subjectFragment: string,
  recipient?: string,
): Promise<string> {
  await page.goto('/outbox');
  let cards = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: new RegExp(subjectFragment, 'i') }) });
  if (recipient) cards = cards.filter({ hasText: `to ${recipient}` });
  const card = cards.first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  const body = (await card.locator('pre').first().innerText()) ?? '';
  const match = /https?:\/\/\S+\/(?:apply|portal)\/enter#t=\S+/.exec(body);
  if (!match) {
    throw new Error(`No portal link in the outbox message matching "${subjectFragment}"`);
  }
  return match[0];
}

/**
 * Make sure this operator holds an open review on the screening card.
 *
 * The worker assigns a reviewer of its own accord shortly after a submission,
 * so the page may already show the review form, may need an explicit
 * assignment, or may simply be a render behind. All three are normal.
 */
export async function ensureReviewForm(page: Page, candidateName: string, reviewerName: string) {
  const card = () => page.locator('section').filter({ hasText: candidateName }).first();
  const form = () => card().getByRole('heading', { name: /Your review of SCR-/ });

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    if (
      await form()
        .isVisible()
        .catch(() => false)
    )
      return card();

    const selector = card().getByLabel('Assign a reviewer');
    if (await selector.isVisible().catch(() => false)) {
      await selector.selectOption({ label: reviewerName });
      await card().getByRole('button', { name: 'Assign', exact: true }).click();
      await page.waitForTimeout(750);
    }
    await page.reload();
  }
  throw new Error(`No open review for ${reviewerName} on ${candidateName}'s screening.`);
}
