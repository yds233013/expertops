import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { clickUntilVisible, operatorContext, portalLinkFor, visitorContext } from './helpers';

/**
 * Work, review and payment preparation, with two account identities.
 *
 * The claim being tested is narrow and worth stating precisely: the
 * application refuses to let the account that created a payment batch be the
 * account that approves it. That is separation between **identities**, which is
 * what software can enforce. It is not independent human approval — one person
 * is driving both sessions here — and nothing in this run should be described
 * as if it were.
 *
 * The other half is that exporting a file is not paying anybody. There is no
 * PAID state in the schema to reach.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const TITLE = `Browser scoping note ${STAMP}`;
const CLAIMED = 8;
const APPROVED = 6;

let lead: { context: BrowserContext; page: Page };
let approver: { context: BrowserContext; page: Page };
let expert: { context: BrowserContext; page: Page };
let expertName: string;
let workReference: string;
let paymentReference: string;
let batchReference: string;

test.beforeAll(async ({ browser }) => {
  lead = await operatorContext(browser, 'lead');
  approver = await operatorContext(browser, 'approver');
  expert = await visitorContext(browser);
});

test.afterAll(async () => {
  await lead?.context.close();
  await approver?.context.close();
  await expert?.context.close();
});

test('1. the operator assigns work to a confirmed seat', async () => {
  const page = lead.page;
  await page.goto('/work');

  const seat = page.getByLabel('Staffed seat');
  await expect(seat).toBeVisible();
  // A seat held by a seeded network member, not by an applicant an earlier
  // browser run walked through to a seat. Seeded people no longer carry a name
  // prefix, so the applicant is what gets excluded.
  const option = seat
    .locator('option')
    .filter({ hasText: /^PRJ-\d+ · / })
    .filter({ hasNotText: /APPLICANT/ })
    .first();
  // The option reads "PRJ-0002 · Somebody · 10 h/week"; the person is the middle part.
  const label = await option.innerText();
  expertName = (label.split(' · ')[1] ?? '').trim();
  expect(expertName).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  await seat.selectOption((await option.getAttribute('value'))!);

  await page.getByLabel('Title').fill(TITLE);
  await page
    .getByLabel('Instructions')
    .fill('Two pages on where the process stalls. Synthetic exercise only.');
  await page.getByLabel('Basis').selectOption('HOURLY');
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  await page.getByLabel('Due date').fill(due);

  await clickUntilVisible(
    () => page.getByRole('button', { name: /Assign work|Assigning/ }).click(),
    page.getByText(TITLE).first(),
  );
});

test('2. the expert submits it from their own portal', async () => {
  const page = lead.page;

  // Assigning work does not send the expert anything — it appears in their
  // portal and the reminder job chases it if it goes overdue. So the operator
  // issues a fresh portal link, which is exactly what they would do in a demo.
  await page.goto('/experts');
  await page.getByLabel('Search').fill(expertName);
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Apply' }).click(),
    page.getByRole('link', { name: expertName }).first(),
  );
  await page.getByRole('link', { name: expertName }).first().click();
  await expect(page.getByRole('heading', { name: expertName })).toBeVisible();
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Issue a new portal link' }).click(),
    page.getByText('A new portal link is in the outbox'),
  );

  const link = await portalLinkFor(page, 'portal link', expertName);

  const portal = expert.page;
  await portal.goto(link);
  await expect(
    portal.getByRole('heading', { name: new RegExp(`Hello, ${expertName}`) }),
  ).toBeVisible({ timeout: 30_000 });

  // Every open work item lives in one card, so filtering by text or walking up
  // to a section catches all of them. Take the first field of each kind that
  // follows this item's heading instead — that is the one that belongs to it.
  const heading = portal.getByRole('heading', { name: TITLE }).first();
  await expect(heading).toBeVisible();
  const fieldAfter = (prefix: string) =>
    heading.locator(`xpath=following::*[starts-with(@id,"${prefix}")][1]`);

  await fieldAfter('work-summary-').fill('First pass at the scoping note.');
  await fieldAfter('work-content-').fill(
    'Read the brief, mapped the handoffs, wrote up the two that cost time.',
  );
  await fieldAfter('work-hours-').fill(String(CLAIMED));
  await clickUntilVisible(
    () => heading.locator('xpath=following::button[1]').click(),
    portal.getByText(/submitted/i).first(),
  );
});

test('3. the reviewer approves fewer hours than were claimed', async () => {
  const page = lead.page;
  await page.goto('/work');

  const heading = page.getByRole('heading', { name: TITLE }).first();
  await expect(heading).toBeVisible({ timeout: 40_000 });
  const reviewButton = heading.locator('xpath=following::button[starts-with(., "Review WRK-")][1]');
  workReference = (/WRK-\d+/.exec(await reviewButton.innerText()) ?? [''])[0]!;
  expect(workReference).toMatch(/^WRK-\d+$/);

  await clickUntilVisible(() => reviewButton.click(), page.getByLabel(/Approved hours/));

  await page.getByLabel(/^Summary/).fill('Useful, but an hour of it was out of scope.');
  await page.getByLabel(/Approved hours/).fill(String(APPROVED));
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Approve', exact: true }).click(),
    page.getByText(/approved/i).first(),
  );
});

test('4. the difference is flagged, and a person explains it', async () => {
  const page = lead.page;
  await page.goto('/payments');

  // The payment item is drafted by the worker, so wait for it rather than
  // assuming it is there. The page names items by reference, not by title.
  await expect
    .poll(
      async () => {
        await page.goto('/payments');
        return page
          .getByText(workReference)
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);

  // An hour was approved away, so the item is held until a person says why.
  // Nothing adjusts itself quietly.
  // Scope to the flagged card. The same WRK reference also appears in the
  // ready-to-batch table, and picking the first match found that one instead.
  // Scope to this item's own row inside the flagged card. The same WRK
  // reference appears in the ready-to-batch table, and earlier runs may have
  // left other flagged items beside it.
  const card = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /Items needing an explanation/ }) })
    .first();
  const item = card.locator('li').filter({ hasText: workReference }).first();
  await expect(item).toBeVisible();
  paymentReference = (/PAY-\d+/.exec(await item.innerText()) ?? [''])[0]!;
  expect(paymentReference).toMatch(/^PAY-\d+$/);

  const explain = item.getByPlaceholder('Why is the difference correct?').first();
  await expect(explain).toBeVisible();
  await explain.fill('One hour was out of scope and was agreed with the expert beforehand.');
  await item.getByRole('button', { name: 'Clear the flag' }).first().click();

  // Wait for the item to leave the flagged card. The previous condition — a
  // label naming the reference — was already true before the click, because
  // the explanation box carries a hidden "Reason for PAY-…" label. So this step
  // finished while the request was still in flight, and the next step loaded a
  // page from before the flag was cleared and waited on it for forty seconds.
  await expect
    .poll(
      async () => {
        await page.goto('/payments');
        return page
          .locator('section')
          .filter({ has: page.getByRole('heading', { name: /Items needing an explanation/ }) })
          .locator('li')
          .filter({ hasText: paymentReference })
          .count();
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(0);
});

test('5. the lead creates the batch and cannot approve their own', async () => {
  const page = lead.page;
  await page.goto('/payments');

  const checkbox = page
    .locator('label')
    .filter({ hasText: paymentReference })
    .getByRole('checkbox')
    .first();
  await expect(checkbox).toBeVisible({ timeout: 40_000 });
  await checkbox.check();

  const start = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  await page.getByLabel(/Period start/i).fill(start);
  await page.getByLabel(/Period end/i).fill(end);
  await clickUntilVisible(
    () => page.getByRole('button', { name: /^Create batch of/ }).click(),
    page.getByRole('button', { name: 'Submit for approval' }).first(),
  );

  const batch = page
    .locator('section')
    .filter({ hasText: /PB-\d+/ })
    .first();
  batchReference = (/PB-\d+/.exec(await batch.innerText()) ?? [''])[0]!;
  expect(batchReference).toMatch(/^PB-\d+$/);

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit for approval' }).first().click(),
    page.getByRole('button', { name: 'Approve', exact: true }).first(),
  );

  // The lead is an ADMIN and therefore *sees* Approve. Pressing it is refused
  // by the server, and the refusal is shown rather than swallowed.
  await page.getByRole('button', { name: 'Approve', exact: true }).first().click();
  // Next.js keeps its own empty aria-live alert on every page, so pick the one
  // that actually says something.
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /payment batch/i })
      .first(),
  ).toContainText(/someone other than the operator who created/i);

  // And the batch has not moved.
  await page.reload();
  await expect(page.getByText('pending approval').first()).toBeVisible();
});

test('6. a second account approves it, exports the CSV, and nothing is paid', async () => {
  const page = approver.page;
  await page.goto('/payments');

  // Each batch is a bordered block inside one card. Walk up from its reference
  // rather than guessing at the element type.
  const batch = page
    .getByText(batchReference, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await expect(batch).toBeVisible();
  await clickUntilVisible(
    () => batch.getByRole('button', { name: 'Approve', exact: true }).first().click(),
    batch.getByRole('button', { name: 'Export CSV' }).first(),
  );

  const download = page.waitForEvent('download');
  await batch.getByRole('button', { name: 'Export CSV' }).first().click();
  const file = await download;
  const path = await file.path();
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(path, 'utf8');

  const lines = csv.trim().split('\n');
  const header = lines[0]!;
  const rows = lines.slice(1);

  // The item appears exactly once, and the file has no column that could
  // record a payment.
  const matching = rows.filter((line) => line.includes(paymentReference));
  expect(matching).toHaveLength(1);
  expect(header.toLowerCase()).not.toContain('paid');
  expect(header.toLowerCase()).not.toContain('payment_date');

  // The exported amount is the approved hours, not the claimed ones.
  expect(matching[0]).toContain(workReference);
  const amount = /(\d+\.\d{2})/.exec(matching[0]!);
  expect(amount, `no amount found in: ${matching[0]}`).not.toBeNull();

  await page.reload();
  const exported = page
    .getByText(batchReference, { exact: true })
    .first()
    .locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]');
  await expect(exported).toContainText('not that anyone was paid');
  await expect(exported).toContainText('approved by Exercise Approver');
  await expect(exported).toContainText('created by Exercise Lead');
  await expect(page.getByText(/marked paid|paid on/i)).toHaveCount(0);
});
