import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { operatorContext, portalLinkFor, visitorContext, waitForOutboxMessage } from './helpers';

/**
 * Screenshots for the walkthrough, written into the repository.
 *
 * Two rules are deliberate. Nothing token-bearing is captured: the simulated
 * outbox is skipped entirely because it prints single-use portal links, and the
 * candidate portal is photographed only after the address bar has been replaced
 * with `/apply`. And every name, email and figure in these images is synthetic
 * fixture data, not a real person.
 */
const OUT = 'docs/screenshots';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 375, height: 812 },
];

async function shoot(page: Page, name: string, viewport: string) {
  // Belt and braces. Tokens now arrive in the fragment and are stripped before
  // anything renders, but a screenshot is committed to the repository, so the
  // URL is checked rather than trusted.
  expect(page.url()).not.toContain('#t=');
  expect(page.url()).not.toContain('/enter/');
  await page.screenshot({ path: `${OUT}/${name}-${viewport}.png`, fullPage: true });
}

test('capture the walkthrough screenshots', async ({ browser }) => {
  await mkdir(OUT, { recursive: true });

  const operator = await operatorContext(browser, 'admin');
  const candidate = await visitorContext(browser);
  const name = 'Screenshot Subject';
  const email = 'screenshot.subject@e2e.test';

  try {
    // A candidate with an open screening, so the portal has something to show.
    await operator.page.goto('/candidates');
    await operator.page.getByLabel('Full name').fill(name);
    await operator.page.getByLabel('Email').fill(email);
    await operator.page.getByLabel('Headline').fill('Evaluation specialist');
    await operator.page.getByRole('button', { name: 'Add candidate' }).click();
    await expect(operator.page.getByText(`${name} added.`)).toBeVisible();
    await operator.page.getByRole('link', { name }).first().click();
    await operator.page.getByRole('button', { name: 'Send screening' }).click();
    await expect(operator.page.getByText(/SCR-\d+/).first()).toBeVisible({ timeout: 20_000 });

    await waitForOutboxMessage(operator.page, 'Screening exercise', name);
    const link = await portalLinkFor(operator.page, 'Screening exercise', name);
    await candidate.page.goto(link);
    await expect(candidate.page.getByRole('heading', { name: /Hello, Screenshot/ })).toBeVisible();

    for (const viewport of VIEWPORTS) {
      await operator.page.setViewportSize({ width: viewport.width, height: viewport.height });
      await candidate.page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const [file, path] of [
        ['operator-dashboard', '/dashboard'],
        ['operator-attention', '/attention'],
        ['operator-candidates', '/candidates'],
        ['operator-campaigns', '/campaigns'],
        ['operator-screenings', '/screenings'],
        ['operator-rubrics', '/rubrics'],
        ['operator-support', '/support'],
        ['operator-delivery', '/work'],
        ['operator-payments', '/payments'],
      ] as const) {
        await operator.page.goto(path);
        await expect(operator.page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
        await shoot(operator.page, file, viewport.name);
      }

      await candidate.page.goto('/apply');
      await expect(
        candidate.page.getByRole('heading', { name: /Hello, Screenshot/ }),
      ).toBeVisible();
      await shoot(candidate.page, 'candidate-screening', viewport.name);
    }
  } finally {
    await operator.context.close();
    await candidate.context.close();
  }
});
