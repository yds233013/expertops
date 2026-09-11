import {
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { E2E_OPERATORS, E2E_PASSWORD } from './fixtures';

/**
 * Each audience gets its own browser context.
 *
 * Operators, candidates and experts authenticate with different cookies, and
 * sharing one context would let a stale operator session make a candidate page
 * look like it worked. Separate contexts also mirror reality: these are
 * different people on different machines.
 */
export async function operatorContext(
  browser: Browser,
  who: keyof typeof E2E_OPERATORS = 'admin',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, E2E_OPERATORS[who].email);
  return { context, page };
}

export async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
}

/** A fresh, unauthenticated context for a candidate or an expert. */
export async function visitorContext(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

/**
 * Find the single-use portal link the worker put in the simulated outbox.
 *
 * This is how an operator would hand a link over in a local demo, and it is the
 * only place a token is read. The token is never printed to the test log.
 */
export async function portalLinkFor(
  page: Page,
  subjectFragment: string,
  /** Recipient name, so one outbox with several invitations is unambiguous. */
  recipient?: string,
): Promise<string> {
  await page.goto('/outbox');
  let cards = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: new RegExp(subjectFragment, 'i') }) });
  if (recipient) cards = cards.filter({ hasText: `to ${recipient}` });
  const card = cards.first();
  await expect(card).toBeVisible({ timeout: 30_000 });

  // Read the address out of the message body, exactly as a person reading the
  // simulated email would. The token is never written to the test log.
  const body = (await card.locator('pre').first().innerText()) ?? '';
  const match = /https?:\/\/\S+\/(?:apply|portal)\/enter\/\S+/.exec(body);
  if (!match) {
    throw new Error(`No portal link in the outbox message matching "${subjectFragment}"`);
  }
  return match[0];
}

/**
 * Wait for the worker to produce an outbox message.
 *
 * The worker is a separate process on its own poll interval, so the operator
 * page is reloaded until the message appears rather than slept on.
 */
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
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);
}

/**
 * Click, then wait for the thing the click was supposed to produce.
 *
 * A production Next.js page serves HTML before React has hydrated, so a click
 * that lands in that window is silently discarded. Rather than sleeping, this
 * retries the click until its effect is visible, which is also what a person
 * would do.
 */
export async function clickUntilVisible(
  click: () => Promise<void>,
  expected: Locator,
  attempts = 4,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await click();
    try {
      await expected.waitFor({ state: 'visible', timeout: 5_000 });
      return;
    } catch {
      if (attempt === attempts) throw new Error('The click never produced its expected result.');
    }
  }
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

  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
      await page.waitForTimeout(500);
    }
    await page.reload();
  }
  throw new Error(`No open review for ${reviewerName} on ${candidateName}'s screening.`);
}
