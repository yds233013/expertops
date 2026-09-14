import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  clickUntilVisible,
  operatorContext,
  portalLinkFor,
  visitorContext,
  waitForOutboxMessage,
} from './helpers';

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
/** A second applicant, who exists only to be invisible to the first. */
const OTHER = {
  name: 'Bo Bystander',
  email: `bo.bystander.${Date.now()}@e2e.test`,
};

let operator: { context: BrowserContext; page: Page };
let visitor: { context: BrowserContext; page: Page };
let other: { context: BrowserContext; page: Page };
let slug: string;
/** The applicant-facing address, captured while it is still published. */
let applicantSlug: string;

test.beforeAll(async ({ browser }) => {
  operator = await operatorContext(browser, 'admin');
  visitor = await visitorContext(browser);
  other = await visitorContext(browser);
});

test.afterAll(async () => {
  await operator?.context.close();
  await visitor?.context.close();
  await other?.context.close();
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

  // And an address that names no published listing says so, to the audience
  // that is actually standing there: an applicant, who has no account to sign
  // into. (A draft answers the same way, which is checked at the service level
  // where the unpublished slug is in hand.)
  await visitor.page.goto('/apply/opportunities/no-such-listing');
  await expect(visitor.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(visitor.page.getByRole('link', { name: 'Open opportunities' })).toBeVisible();
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

test('6. a second applicant applies, and the two cannot see each other', async () => {
  const page = other.page;
  await page.goto(`/apply/opportunities/${applicantSlug}`);
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible();
  await page.getByLabel('Your name').fill(OTHER.name);
  await page.getByLabel('Email').fill(OTHER.email);
  await page.getByLabel('Relevant experience').fill('A different person entirely.');
  await page.getByLabel('Why do you want this?').fill('Curiosity.');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit application' }).click(),
    page.getByText(/Application received/),
  );

  // The confirmation names only this applicant's own reference, never the
  // other's, and the applicant-facing page lists no applicants at all.
  const confirmation = await page.content();
  expect(confirmation).not.toContain(APPLICANT.name);
  expect(confirmation).not.toContain(APPLICANT.email);

  await operator.page.goto(`/opportunities/${slug}`);
  await expect(operator.page.getByRole('heading', { name: /Applicants \(2\)/ })).toBeVisible();
});

test('7. the operator sends a screening, and only that applicant receives it', async () => {
  const page = operator.page;
  // The row is chosen by email, so the rest of the test knows whose it is.
  await page
    .getByRole('row')
    .filter({ hasText: APPLICANT.email })
    .getByRole('link', { name: /APP-\d+/ })
    .click();
  await expect(page.getByRole('heading', { name: APPLICANT.name, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Send screening' }).click();
  await expect(page.getByText(/SCR-\d+/).first()).toBeVisible({ timeout: 20_000 });

  await waitForOutboxMessage(page, 'Screening exercise', APPLICANT.name);
  const link = await portalLinkFor(page, 'Screening exercise', APPLICANT.name);

  // The link opens Ada's own session, showing her application and nobody else's.
  await visitor.page.goto(link);
  await expect(visitor.page.getByRole('heading', { name: `Hello, ${APPLICANT.name}` })).toBeVisible(
    { timeout: 20_000 },
  );
  await expect(visitor.page.getByRole('heading', { name: 'Your applications' })).toBeVisible();

  const statusPage = await visitor.page.content();
  expect(statusPage).not.toContain(OTHER.name);
  expect(statusPage).not.toContain(OTHER.email);
  // Nothing the operator wrote for themselves reaches this page.
  expect(statusPage).not.toContain('SECRET-CLIENT-NAME');
});

test('8. the applicant withdraws their own application, and it stays withdrawn', async () => {
  const page = visitor.page;
  await page.goto('/apply');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Withdraw this application' }).first().click(),
    page.getByRole('button', { name: 'Confirm withdrawal' }),
  );
  await page.getByLabel('Reason (optional)').fill('Practising the withdrawal path');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Confirm withdrawal' }).click(),
    page.getByText(/withdrawn/i).first(),
  );

  // Still their record, not a deletion: the reference survives a reload, and the
  // control is gone because there is nothing left to withdraw.
  await page.reload();
  await expect(page.getByText(/APP-\d+/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw this application' })).toHaveCount(0);

  // The operator sees a withdrawal, not an applicant who vanished.
  await operator.page.goto(`/opportunities/${slug}`);
  const row = operator.page.getByRole('row').filter({ hasText: APPLICANT.email });
  await expect(row.getByText('withdrawn', { exact: true })).toBeVisible();
  await expect(row.getByText('Withdrawn by the applicant')).toBeVisible();
});

test('9. closing the opportunity refuses new applications', async () => {
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
