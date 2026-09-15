import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  clickUntilVisible,
  operatorContext,
  portalLinkFor,
  visitorContext,
  waitForOutboxMessage,
} from './helpers';

/**
 * An expert leaves a project, and a replacement is staffed in their place.
 *
 * The gap this closes: withdrawal existed as a service with no interface, so an
 * expert could only leave a project by an operator calling an API on their
 * behalf. Every step below is a click on a real page, and the two experts and
 * the two operators each have their own browser context, because a shared
 * context would let one person's cookies make another person's page look like
 * it worked.
 */
test.describe.configure({ mode: 'serial' });

const PROJECT = 'Withdrawal Pilot';
const ORIGINAL = { name: 'Mina Haddad', email: 'mina.haddad@e2e.test' };
const REPLACEMENT = { name: 'Teo Lindqvist', email: 'teo.lindqvist@e2e.test' };
const WORK_TITLE = 'Draft the withdrawal runbook';

let admin: { context: BrowserContext; page: Page };
let approver: { context: BrowserContext; page: Page };
let original: { context: BrowserContext; page: Page };
let replacement: { context: BrowserContext; page: Page };

let projectUrl = '';
let batchUrl = '';

test.beforeAll(async ({ browser }) => {
  admin = await operatorContext(browser, 'admin');
  approver = await operatorContext(browser, 'approver');
  original = await visitorContext(browser);
  replacement = await visitorContext(browser);
});

test.afterAll(async () => {
  await admin?.context.close();
  await approver?.context.close();
  await original?.context.close();
  await replacement?.context.close();
});

/** Add an expert through the operator form. */
async function addExpert(page: Page, who: { name: string; email: string }) {
  await page.goto('/experts/new');
  await page.getByLabel('Full name').fill(who.name);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Headline').fill('Evaluation specialist');
  await page.getByPlaceholder('Skill name').first().fill('Evaluation Design');
  await page.getByRole('button', { name: 'Create expert' }).click();
  await expect(page.getByRole('heading', { name: who.name })).toBeVisible();
}

/** Fill and submit the whole onboarding checklist in the expert's portal. */
async function completeOnboarding(portal: Page) {
  const checklist = portal
    .locator('section')
    .filter({ has: portal.getByRole('heading', { name: 'Onboarding checklist' }) });
  const answers = checklist.locator('input[type="text"], input:not([type])');
  for (let index = 0; index < (await answers.count()); index += 1) {
    await answers.nth(index).fill('Confirmed for the pilot.');
  }
  const attestations = checklist.locator('input[type="checkbox"]');
  for (let index = 0; index < (await attestations.count()); index += 1) {
    await attestations.nth(index).check();
  }
  await clickUntilVisible(
    () => checklist.getByRole('button', { name: 'Submit for review' }).click(),
    portal.getByText('Submitted and waiting on a human operator'),
  );
}

/** Declare a general availability window in the expert's portal. */
async function declareAvailability(portal: Page) {
  const from = new Date();
  const to = new Date(from.getTime() + 60 * 86_400_000);
  await portal.getByLabel('From', { exact: true }).fill(from.toISOString().slice(0, 10));
  await portal.getByLabel('To', { exact: true }).fill(to.toISOString().slice(0, 10));
  await portal.getByLabel('Hours/week').fill('20');
  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Add window' }).click(),
    portal.getByText('20 h/week').first(),
  );
}

/**
 * Operator verification. Nothing about this step is automatic.
 *
 * The queue holds submitted cases only, so the decision panel for this expert
 * disappearing is what says the decision landed. Other suites leave their own
 * cases in the queue, so emptiness is not the signal.
 */
async function verifyExpert(page: Page, name: string) {
  await page.goto('/onboarding');
  const decision = () => page.getByText(`Operator decision required for ${name}`);
  await expect(decision()).toBeVisible({ timeout: 30_000 });

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await page
      .locator('section')
      .filter({ hasText: name })
      .first()
      .getByRole('button', { name: 'Verify expert' })
      .click();
    try {
      await expect(decision()).toHaveCount(0, { timeout: 5_000 });
      return;
    } catch {
      if (attempt === 4) throw new Error(`${name} was never verified.`);
      await page.reload();
    }
  }
}

/** Propose the seat, then confirm it: two deliberate operator steps. */
async function staffSeat(page: Page, firstName: string) {
  await page.goto(projectUrl);
  await clickUntilVisible(
    () => page.getByRole('button', { name: new RegExp(`^Propose ${firstName}`) }).click(),
    page.getByRole('button', { name: 'Confirm seat' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Confirm seat' }).click(),
    page.getByRole('button', { name: 'Release seat' }),
  );
}

test('1. an operator records two experts and a one-seat project', async () => {
  const page = admin.page;
  await addExpert(page, ORIGINAL);
  await addExpert(page, REPLACEMENT);

  await page.goto('/projects/new');
  await page.getByLabel('Title').fill(PROJECT);
  await page.getByLabel('Client').fill('Internal Research');
  await page.getByLabel('Seats').fill('1');
  await page.getByLabel('Min. experience').fill('0');
  await page.getByPlaceholder('Skill name').first().fill('Evaluation Design');
  await page.getByLabel('Requirement type').first().selectOption('optional');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByRole('heading', { name: PROJECT })).toBeVisible();
  projectUrl = page.url();

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Open for matching' }).click(),
    page.getByRole('button', { name: /Run matching/ }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: /Run matching/ }).click(),
    page.getByRole('link', { name: ORIGINAL.name }).first(),
  );
  // Both are ranked, which is what lets the replacement be found later.
  await expect(page.getByRole('link', { name: REPLACEMENT.name }).first()).toBeVisible();
});

test('2. the first expert is invited, onboards, and is confirmed onto the seat', async () => {
  const page = admin.page;

  const row = page.locator('tr').filter({ hasText: ORIGINAL.name }).first();
  await clickUntilVisible(
    () => row.getByRole('button', { name: 'Invite', exact: true }).click(),
    page.getByRole('button', { name: 'Send invitation' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Send invitation' }).click(),
    page.getByText('sent').first(),
  );

  await waitForOutboxMessage(page, `invitation|invited|${PROJECT}`, ORIGINAL.name);
  const link = await portalLinkFor(page, `invitation|invited|${PROJECT}`, ORIGINAL.name);

  const portal = original.page;
  await portal.goto(link);
  await expect(portal.getByRole('heading', { name: /Hello, Mina/ })).toBeVisible();

  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Accept', exact: true }).click(),
    portal.getByRole('heading', { name: 'Onboarding checklist' }),
  );
  await completeOnboarding(portal);
  await verifyExpert(page, ORIGINAL.name);

  await portal.goto('/portal');
  await declareAvailability(portal);

  await staffSeat(page, 'Mina');
});

test('3. the operator assigns work to the confirmed expert', async () => {
  const page = admin.page;
  await page.goto('/work');

  const seat = page.getByLabel('Staffed seat');
  const value = await seat
    .locator('option')
    .filter({ hasText: ORIGINAL.name })
    .first()
    .getAttribute('value');
  await seat.selectOption(value!);

  await page.getByLabel('Title').fill(WORK_TITLE);
  await page.getByLabel('Instructions').fill('One page, with the steps in order.');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Assign work' }).click(),
    page.getByText('Work assigned'),
  );

  const portal = original.page;
  await portal.goto('/portal');
  await expect(portal.getByText(WORK_TITLE)).toBeVisible();
});

test('4. the expert withdraws from the project in their own portal', async () => {
  const portal = original.page;
  await portal.goto('/portal');

  // The action names the project it affects, rather than leaving the expert to
  // work out which commitment they are ending.
  const card = portal
    .locator('section')
    .filter({ has: portal.getByRole('heading', { name: 'Leaving a project' }) });
  await expect(card).toBeVisible();
  await expect(card.getByText(PROJECT)).toBeVisible();

  // Nothing happens on the first click except an explanation.
  await clickUntilVisible(
    () => card.getByRole('button', { name: 'Withdraw from this project' }).click(),
    card.getByRole('button', { name: 'Confirm withdrawal' }),
  );
  await expect(card.getByText(new RegExp(`Withdraw from .*${PROJECT}\\?`))).toBeVisible();
  await expect(
    card.getByText('Your seat is released and given back to the project.'),
  ).toBeVisible();
  await expect(card.getByText(/1 work item\(s\) still waiting on you are cancelled/)).toBeVisible();
  await expect(card.getByText(/cannot undo this yourself/)).toBeVisible();

  // The reason is optional; this expert chooses to give one.
  await card.getByLabel('Reason (optional)').fill('A client deadline moved onto the same weeks.');
  await clickUntilVisible(
    () => card.getByRole('button', { name: 'Confirm withdrawal' }).click(),
    portal.getByText('Projects you have withdrawn from'),
  );

  // Re-read the page rather than trusting one render: the withdrawal and this
  // page load are two requests.
  await expect
    .poll(
      async () => {
        await portal.goto('/portal');
        return portal
          .getByText('Projects you have withdrawn from')
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);

  const withdrawn = portal
    .locator('section')
    .filter({ has: portal.getByRole('heading', { name: 'Leaving a project' }) });
  await expect(withdrawn.getByText('Withdrawn', { exact: true })).toBeVisible();
  // The commitment is gone from the list of things that can be withdrawn from.
  await expect(withdrawn.getByRole('button', { name: 'Withdraw from this project' })).toHaveCount(
    0,
  );

  // The work that was waiting on them is cancelled, not left as a reminder.
  const work = portal.locator('li').filter({ hasText: WORK_TITLE }).first();
  await expect(work.getByText('cancelled')).toBeVisible();
});

test('5. the operator sees the vacated seat and the withdrawal in the attention queue', async () => {
  const page = admin.page;

  await page.goto('/attention');
  await expect(page.getByText(new RegExp(`${ORIGINAL.name} withdrew from`))).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText('A client deadline moved onto the same weeks.')).toBeVisible();

  await page.goto(projectUrl);
  // The seat is free again, and the project is open for staffing rather than
  // stuck ACTIVE with nobody on it.
  const seats = page.locator('div.card').filter({ hasText: 'Seats' }).first();
  await expect(seats.getByText('0/1')).toBeVisible();
  await expect(seats.getByText('1 open')).toBeVisible();
  // The status badge, which is lower-cased; the "Staffing" section heading is
  // not what this is asserting.
  await expect(page.getByText('staffing', { exact: true }).first()).toBeVisible();
});

test('6. the worker proposes a replacement batch and contacts nobody', async () => {
  const page = admin.page;

  await expect
    .poll(
      async () => {
        await page.goto('/outreach');
        return page
          .getByRole('row')
          .filter({ hasText: 'replacement' })
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBe(true);

  const row = page.getByRole('row').filter({ hasText: 'replacement' }).first();
  // Assembled by the worker, not by an operator.
  await expect(row.getByText('the worker')).toBeVisible();
  await row.getByRole('link').first().click();

  await expect(page.getByRole('heading', { name: /^BAT-/ })).toBeVisible();
  batchUrl = page.url();
  await expect(page.getByText(REPLACEMENT.name).first()).toBeVisible();
  // Nothing has been sent, and there is no way to send it from this state.
  await expect(page.getByText('not attempted yet').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Dispatch to/ })).toHaveCount(0);
});

test('7. approval is required before the replacement is contacted', async () => {
  await clickUntilVisible(
    () => admin.page.getByRole('button', { name: 'Submit for approval' }).click(),
    admin.page.getByText('pending approval').first(),
  );

  // A second operator approves. Dispatch is a separate act after that.
  await approver.page.goto(batchUrl);
  await clickUntilVisible(
    () => approver.page.getByRole('button', { name: 'Approve', exact: true }).click(),
    approver.page.getByRole('button', { name: /Dispatch to/ }),
  );
  await clickUntilVisible(
    () => approver.page.getByRole('button', { name: /Dispatch to/ }).click(),
    approver.page.getByText('invitation created').first(),
  );
});

test('8. the replacement accepts, onboards, is verified and confirmed onto the seat', async () => {
  const page = admin.page;
  await waitForOutboxMessage(page, `invitation|invited|${PROJECT}`, REPLACEMENT.name);
  const link = await portalLinkFor(page, `invitation|invited|${PROJECT}`, REPLACEMENT.name);

  const portal = replacement.page;
  await portal.goto(link);
  await expect(portal.getByRole('heading', { name: /Hello, Teo/ })).toBeVisible();

  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Accept', exact: true }).click(),
    portal.getByRole('heading', { name: 'Onboarding checklist' }),
  );
  await declareAvailability(portal);
  await completeOnboarding(portal);
  await verifyExpert(page, REPLACEMENT.name);

  await staffSeat(page, 'Teo');

  // The seat the first expert vacated is filled by the replacement.
  await page.goto(projectUrl);
  const seats = page.locator('div.card').filter({ hasText: 'Seats' }).first();
  await expect(seats.getByText('1/1')).toBeVisible();
  await expect(seats.getByText('full')).toBeVisible();

  // And the replacement now has the commitment the first expert gave up,
  // including the same withdrawal action of their own.
  await portal.goto('/portal');
  const seated = portal
    .locator('section')
    .filter({ has: portal.getByRole('heading', { name: 'Leaving a project' }) });
  await expect(seated.getByText(PROJECT)).toBeVisible();
  await expect(seated.getByRole('button', { name: 'Withdraw from this project' })).toBeVisible();
});
