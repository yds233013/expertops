import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { clickUntilVisible, operatorContext, visitorContext } from './helpers';

/**
 * The opportunity and application journey, in a browser.
 *
 * Two audiences in separate contexts: an operator who publishes, and a visitor
 * who arrives with no session at all. The visitor's context never authenticates
 * — the whole point of this feature is that somebody can apply before anybody
 * has entered them.
 */
test.describe.configure({ mode: 'serial' });

const TITLE = `Browser test opportunity ${Date.now()}`;
const APPLICANT = {
  name: 'Ada Applicant',
  email: `ada.applicant.${Date.now()}@e2e.test`,
};

let operator: { context: BrowserContext; page: Page };
let visitor: { context: BrowserContext; page: Page };
let slug: string;
/** The applicant-facing address, captured while it is still published. */
let applicantSlug: string;

test.beforeAll(async ({ browser }) => {
  operator = await operatorContext(browser, 'admin');
  visitor = await visitorContext(browser);
});

test.afterAll(async () => {
  await operator?.context.close();
  await visitor?.context.close();
});

test('1. an operator drafts an opportunity, and it is not listed', async () => {
  const page = operator.page;
  await page.goto('/opportunities/new');
  await page.getByLabel('Title').fill(TITLE);
  await page.getByLabel('Summary').fill('A synthetic listing created by the browser suite.');
  await page.getByLabel('Description').fill('Read things and write notes about them.');
  await page.getByLabel('Required skills').fill('Evaluation Design');
  await page
    .getByLabel('Internal notes — never shown to applicants')
    .fill('SECRET-CLIENT-NAME and a rate ceiling nobody outside should read.');
  await page.getByRole('button', { name: 'Add question' }).click();
  await page.getByLabel('Question 1 label').fill('Why do you want this?');
  await page.getByRole('button', { name: 'Create draft' }).click();

  // Level 1 specifically: the title also appears in the applicant preview below.
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  slug = new URL(page.url()).pathname.split('/').pop()!;

  // A draft is not on the applicant listing.
  await visitor.page.goto('/apply/opportunities');
  await expect(visitor.page.getByText(TITLE)).toHaveCount(0);
});

test('2. publishing puts it on the listing, without the internal notes', async () => {
  const page = operator.page;
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Publish' }).click(),
    page.getByText('Live at'),
  );

  await visitor.page.goto('/apply/opportunities');
  await expect(visitor.page.getByRole('heading', { name: TITLE, level: 2 })).toBeVisible();

  // Nothing internal reaches the applicant-facing pages. Scoped to this
  // listing: an earlier run may have left other published ones behind.
  await visitor.page
    .locator('section')
    .filter({ hasText: TITLE })
    .getByRole('link', { name: 'View and apply' })
    .first()
    .click();
  await expect(visitor.page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
  // Read the address only once the page it belongs to has rendered.
  applicantSlug = new URL(visitor.page.url()).pathname.split('/').pop()!;
  expect(await visitor.page.content()).not.toContain('SECRET-CLIENT-NAME');
});

test('3. a visitor applies with no account and no operator involvement', async () => {
  const page = visitor.page;
  await page.getByLabel('Your name').fill(APPLICANT.name);
  await page.getByLabel('Email').fill(APPLICANT.email);
  await page
    .getByLabel('Relevant experience')
    .fill('Several years reviewing synthetic evaluation designs.');
  await page.getByLabel('Skills').fill('Evaluation Design');
  await page.getByLabel('Hours per week you are available').fill('15');
  await page.getByLabel('Why do you want this?').fill('It is the work I already do.');

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit application' }).click(),
    page.getByText(/Application received/),
  );
  await expect(page.getByText(/APP-\d+/)).toBeVisible();
  await expect(page.getByText('What happens next')).toBeVisible();
});

test('4. submitting the same application again does not make a second one', async () => {
  const page = visitor.page;
  await page.goto(`/apply/opportunities/${applicantSlug}`);
  // Wait for the page itself before reaching for a field on it.
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
  await page.getByLabel('Your name').fill(APPLICANT.name);
  await page.getByLabel('Email').fill(APPLICANT.email);
  await page.getByLabel('Relevant experience').fill('The same person, applying twice.');
  await page.getByLabel('Why do you want this?').fill('Again.');

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit application' }).click(),
    page.getByText(/already applied/i),
  );

  // The operator side shows exactly one.
  await operator.page.reload();
  await expect(operator.page.getByRole('heading', { name: /Applicants \(1\)/ })).toBeVisible();
});

test('5. the operator reads the application and sees what was actually submitted', async () => {
  const page = operator.page;
  await page
    .getByRole('link', { name: /APP-\d+/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: APPLICANT.name })).toBeVisible();
  await expect(page.getByText('Why do you want this?')).toBeVisible();
  await expect(page.getByText('It is the work I already do.')).toBeVisible();
  await expect(page.getByText('15 h/week')).toBeVisible();
});

test('6. closing the opportunity refuses new applications', async () => {
  const page = operator.page;
  await page.goto(`/opportunities/${slug}`);
  await page.getByRole('button', { name: 'Close to new applications' }).click();
  await page.getByLabel('Why is this closing?').fill('Browser test finished with it');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Confirm close' }).click(),
    page.getByText(/Closed\./),
  );

  // A bookmarked link explains itself instead of 404ing, and offers no form.
  await visitor.page.goto(`/apply/opportunities/${applicantSlug}`);
  // Both the banner and the card say it; either is proof enough.
  await expect(visitor.page.getByText(/no longer accepting applications/i).first()).toBeVisible();
  await expect(visitor.page.getByRole('button', { name: 'Submit application' })).toHaveCount(0);

  // And it is off the listing entirely.
  await visitor.page.goto('/apply/opportunities');
  await expect(visitor.page.getByText(TITLE)).toHaveCount(0);
});
