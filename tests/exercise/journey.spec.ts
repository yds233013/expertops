import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  clickUntilVisible,
  ensureReviewForm,
  operatorContext,
  portalLinkFor,
  visitorContext,
  waitForOutboxMessage,
} from './helpers';

/**
 * One person, all the way through, in a browser.
 *
 * Opportunity listing → application → operator review → screening → revision
 * request → resubmission → human qualification → project invitation →
 * acceptance → onboarding → verification → confirmed seat.
 *
 * Three browser contexts, because these are three different people: an
 * applicant with no account at all, an operator, and the same applicant again
 * once they hold an expert portal session. Nothing is short-circuited through
 * the database, and every decision that the product calls a human decision is
 * made by clicking the control that makes it.
 *
 * This runs against the network of a hundred built by
 * `scripts/network-exercise.ts`, so the pages it touches are full rather than
 * empty. That is the point: a filter that works on three rows proves nothing.
 */
test.describe.configure({ mode: 'serial' });

const STAMP = Date.now();
const APPLICANT = {
  name: `APPLICANT Marta Oyelaran ${STAMP}`,
  email: `applicant.marta.${STAMP}@example.test`,
};
const PROJECT_TITLE = 'PRACTICE enterprise process assessment';
const SKILL = 'Process Analysis';

let operator: { context: BrowserContext; page: Page };
let applicant: { context: BrowserContext; page: Page };
let expert: { context: BrowserContext; page: Page };
let projectUrl: string;

test.beforeAll(async ({ browser }) => {
  operator = await operatorContext(browser, 'lead');
  applicant = await visitorContext(browser);
  expert = await visitorContext(browser);
});

test.afterAll(async () => {
  await operator?.context.close();
  await applicant?.context.close();
  await expert?.context.close();
});

test('1. a stranger browses the published opportunities and applies', async () => {
  const page = applicant.page;
  await page.goto('/apply/opportunities');
  await expect(page.getByRole('heading', { name: 'Open opportunities' })).toBeVisible();

  // All three practice listings are live, and nothing internal is on the page.
  await expect(page.getByRole('heading', { level: 2 })).toHaveCount(3);
  expect(await page.content()).not.toContain('Client identity would live here');

  const listing = page
    .locator('section')
    .filter({ hasText: 'PRACTICE enterprise process analyst' })
    .first();
  await listing.getByRole('link', { name: 'View and apply' }).first().click();
  await expect(
    page.getByRole('heading', { name: 'PRACTICE enterprise process analyst', level: 1 }),
  ).toBeVisible();

  await page.getByLabel('Your name').fill(APPLICANT.name);
  await page.getByLabel('Email').fill(APPLICANT.email);
  await page
    .getByLabel('Relevant experience')
    .fill('Mapped three back-office processes end to end and wrote the findings up myself.');
  await page.getByLabel('Skills').fill(`${SKILL}, Stakeholder Interviewing`);
  await page.getByLabel('Hours per week you are available').fill('16');
  await page
    .getByLabel('Describe the closest work you have done.')
    .fill('A claims intake process where the delay was in a handoff nobody owned.');

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit application' }).click(),
    page.getByText(/Application received/),
  );
  await expect(page.getByText(/APP-\d+/)).toBeVisible();
});

test('2. the operator finds the applicant among the others and reads what they sent', async () => {
  const page = operator.page;
  await page.goto('/opportunities');

  // The reference is the link; the title sits beside it in the row.
  await page
    .getByRole('row')
    .filter({ hasText: 'PRACTICE enterprise process analyst' })
    .getByRole('link')
    .first()
    .click();
  await expect(
    page.getByRole('heading', { name: 'PRACTICE enterprise process analyst', level: 1 }),
  ).toBeVisible();

  // Search, on a list that has other applicants in it.
  await page.getByLabel('Search').fill(APPLICANT.email);
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Apply' }).click(),
    page.getByText(APPLICANT.name).first(),
  );

  await page
    .getByRole('link', { name: /APP-\d+/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: APPLICANT.name, level: 1 })).toBeVisible();
  await expect(page.getByText('Mapped three back-office processes')).toBeVisible();
  await expect(page.getByText('16 h/week')).toBeVisible();
  await expect(page.getByText('A claims intake process')).toBeVisible();
});

test('3. the operator sends a screening against a published rubric', async () => {
  const page = operator.page;
  const rubric = page.getByLabel('Published rubric version');
  const option = await rubric
    .locator('option')
    .filter({ hasText: /enterprise/i })
    .first()
    .getAttribute('value');
  await rubric.selectOption(option!);
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Send screening' }).click(),
    page.getByText(/SCR-\d+/).first(),
  );
});

test('4. the applicant completes the screening from the link they were sent', async () => {
  const page = operator.page;
  await waitForOutboxMessage(page, 'Screening exercise', APPLICANT.name);
  const link = await portalLinkFor(page, 'Screening exercise', APPLICANT.name);

  const candidate = applicant.page;
  await candidate.goto(link);
  await expect(candidate.getByRole('heading', { name: /Hello, APPLICANT Marta/ })).toBeVisible({
    timeout: 30_000,
  });

  await candidate
    .getByLabel('Practical depth')
    .fill('I ran the claims intake mapping myself over four weeks, interviewing eleven people.');
  await candidate
    .getByLabel('Judgement under constraint')
    .fill('I dropped the reporting rewrite because it would not have moved the delay.');
  await clickUntilVisible(
    () => candidate.getByRole('button', { name: /Submit responses/ }).click(),
    candidate.getByRole('listitem').filter({ hasText: /Revision 1/ }),
  );
});

test('5. a reviewer scores it and asks for a revision', async () => {
  const page = operator.page;
  await page.goto('/screenings');

  const card = await ensureReviewForm(page, APPLICANT.name, 'Exercise Lead');
  await card.getByLabel('Practical depth').fill('4');
  await card.getByLabel('Judgement under constraint').fill('2');
  await card
    .getByLabel('Feedback the candidate will read')
    .fill('Say what you would have done differently on the reporting call.');
  await card
    .getByLabel('Private notes, never shown to the candidate')
    .fill('Internal: check the eleven-interview claim at reference stage.');
  // The verdict renders as two nodes ("Exercise Lead:" then a bold verb), so
  // match the list item rather than a single string.
  await clickUntilVisible(
    () => card.getByRole('button', { name: 'Ask for a revision' }).click(),
    page
      .getByRole('listitem')
      .filter({ hasText: 'Exercise Lead' })
      .filter({ hasText: 'REQUEST_REVISION' })
      .first(),
  );

  const decided = page.locator('section').filter({ hasText: APPLICANT.name }).first();
  await decided
    .getByLabel('Note explaining the decision')
    .fill('One more paragraph and this is a yes.');
  await clickUntilVisible(
    () => decided.getByRole('button', { name: 'Request a revision' }).click(),
    page.getByText('revision requested').first(),
  );
});

test('6. the applicant reads the feedback, sees no private note, and resubmits', async () => {
  const page = applicant.page;
  await page.goto('/apply');

  await expect(page.getByRole('heading', { name: 'Requested changes' })).toBeVisible();
  await expect(page.getByText('One more paragraph and this is a yes.')).toBeVisible();
  await expect(page.getByText('Say what you would have done differently')).toBeVisible();

  // The reviewer's private note is operator-only and must be nowhere on it.
  expect(await page.content()).not.toContain('check the eleven-interview claim');

  await page
    .getByLabel('Judgement under constraint')
    .fill(
      'I dropped the reporting rewrite. Given the time again I would have said so on the ' +
        'first call rather than the third, because two weeks went into a document nobody needed.',
    );
  await clickUntilVisible(
    () => page.getByRole('button', { name: /Submit revised responses/ }).click(),
    page.getByRole('listitem').filter({ hasText: /Revision 2/ }),
  );
  await expect(page.getByText('evidence missing')).toHaveCount(0);
});

test('7. a person — not the system — qualifies them, and they become an expert', async () => {
  const page = operator.page;
  await page.goto('/screenings');

  const card = await ensureReviewForm(page, APPLICANT.name, 'Exercise Lead');
  await card.getByLabel('Practical depth').fill('4');
  await card.getByLabel('Judgement under constraint').fill('4');
  await card
    .getByLabel('Feedback the candidate will read')
    .fill('That is the answer I was looking for. Thank you.');
  await clickUntilVisible(
    () => card.getByRole('button', { name: 'Recommend approve' }).click(),
    page
      .getByRole('listitem')
      .filter({ hasText: 'Exercise Lead' })
      .filter({ hasText: 'APPROVE' })
      .first(),
  );

  const decided = page.locator('section').filter({ hasText: APPLICANT.name }).first();
  await decided
    .getByLabel('Note explaining the decision')
    .fill('Meets the bar for the enterprise pilot. Qualified by a person, on the record.');
  await clickUntilVisible(
    () => decided.getByRole('button', { name: 'Qualify', exact: true }).click(),
    page.getByText('qualified').first(),
  );

  // The conversion is what makes them an expert. Nothing else does.
  await expect
    .poll(
      async () => {
        await page.goto('/experts');
        await page.getByLabel('Search').fill(APPLICANT.name);
        await page.getByRole('button', { name: 'Apply' }).click();
        return page
          .getByRole('link', { name: APPLICANT.name })
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 40_000, intervals: [1000, 2000] },
    )
    .toBe(true);
});

test('8. the operator fills in what a qualification does not carry', async () => {
  const page = operator.page;
  await page.getByRole('link', { name: APPLICANT.name }).first().click();
  await expect(page.getByRole('heading', { name: APPLICANT.name })).toBeVisible();

  // A qualification says somebody met a bar. It does not say what they can do,
  // and the conversion carries no seniority or rate at all — both are needed
  // before matching will rank them rather than exclude them.
  await page.getByLabel('Years of experience').fill('7');
  await page.getByLabel('Hourly rate').fill('180.00');
  await page.getByLabel('Weekly capacity').fill('16');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Save profile' }).click(),
    page.getByText('Profile saved.'),
  );

  await page.getByLabel('Skill', { exact: true }).first().fill(SKILL);
  await page.getByLabel('Proficiency').first().selectOption('4');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Save skills' }).click(),
    page.getByText('Skills saved.'),
  );

  await page.reload();
  await expect(page.getByText('7 years')).toBeVisible();
});

test('9. a seat is released, which reopens the project, and they are invited to it', async () => {
  const page = operator.page;
  await page.goto('/projects');
  await page.getByRole('link', { name: PROJECT_TITLE }).first().click();
  await expect(page.getByRole('heading', { name: PROJECT_TITLE })).toBeVisible();
  projectUrl = page.url();

  // The project is full, so it is ACTIVE. Releasing one seat frees it and
  // returns the project to staffing — which is what makes it possible to
  // invite anybody new. (That reopening is the fix in tests/integration/
  // seat-release.test.ts; before it, this step had nowhere to go.)
  const releaseRow = page
    .locator('tr')
    .filter({ has: page.getByRole('button', { name: 'Release seat' }) })
    .first();
  const releasedName = (await releaseRow.locator('td').first().innerText()).trim();
  // Destructive actions ask twice: the button relabels itself to "Confirm: …"
  // rather than throwing a browser dialog at you.
  await releaseRow.getByRole('button', { name: 'Release seat', exact: true }).click();
  await clickUntilVisible(
    () => releaseRow.getByRole('button', { name: /^Confirm: Release seat/ }).click(),
    page.getByRole('button', { name: /Run matching|Re-run matching/ }),
  );
  expect(releasedName.length).toBeGreaterThan(0);

  await clickUntilVisible(
    () => page.getByRole('button', { name: /Run matching|Re-run matching/ }).click(),
    page.getByRole('link', { name: APPLICANT.name }).first(),
  );

  const row = page
    .locator('tr')
    .filter({ hasText: APPLICANT.name })
    .filter({ has: page.getByRole('button', { name: 'Invite', exact: true }) })
    .first();
  await clickUntilVisible(
    () => row.getByRole('button', { name: 'Invite', exact: true }).click(),
    page.getByRole('button', { name: 'Send invitation' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Send invitation' }).click(),
    page.getByText('sent').first(),
  );
});

test('10. they accept, complete onboarding, and a human verifies them', async () => {
  const page = operator.page;
  await waitForOutboxMessage(page, 'invitation|invited|' + PROJECT_TITLE, APPLICANT.name);
  const link = await portalLinkFor(page, 'invitation|invited|' + PROJECT_TITLE, APPLICANT.name);

  const portal = expert.page;
  await portal.goto(link);
  await expect(portal.getByRole('heading', { name: /Hello, APPLICANT Marta/ })).toBeVisible({
    timeout: 30_000,
  });

  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Accept', exact: true }).click(),
    portal.getByRole('heading', { name: 'Onboarding checklist' }),
  );

  const checklist = portal
    .locator('section')
    .filter({ has: portal.getByRole('heading', { name: 'Onboarding checklist' }) });
  const answers = checklist.locator('input[type="text"], input:not([type])');
  for (let index = 0; index < (await answers.count()); index += 1) {
    await answers.nth(index).fill('Confirmed for the enterprise pilot.');
  }
  const attestations = checklist.locator('input[type="checkbox"]');
  for (let index = 0; index < (await attestations.count()); index += 1) {
    await attestations.nth(index).check();
  }
  await clickUntilVisible(
    () => checklist.getByRole('button', { name: 'Submit for review' }).click(),
    portal.getByText('Submitted and waiting on a human operator'),
  );

  // Verification is a person's decision, made on the verification queue.
  await page.goto('/onboarding');
  await expect(page.getByText(APPLICANT.name).first()).toBeVisible({ timeout: 40_000 });
  const queued = page.locator('section').filter({ hasText: APPLICANT.name }).first();
  await clickUntilVisible(
    () => queued.getByRole('button', { name: 'Verify expert' }).click(),
    page.getByText(/verified|Nothing waiting for review/).first(),
  );

  await portal.goto('/portal');
  await expect(portal.getByText('An operator verified your submission')).toBeVisible();
});

test('11. they declare availability and the operator confirms the seat', async () => {
  const portal = expert.page;
  await portal.goto('/portal');

  const from = new Date();
  const to = new Date(from.getTime() + 90 * 86_400_000);
  await portal.getByLabel('From').fill(from.toISOString().slice(0, 10));
  await portal.getByLabel('To').fill(to.toISOString().slice(0, 10));
  await portal.getByLabel('Hours/week').fill('16');
  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Add window' }).click(),
    portal.getByText('16 h/week').first(),
  );

  const page = operator.page;
  await page.goto(projectUrl);
  // Her name is in three tables on this page — the ranking, the invitations and
  // the staffing list. Only one of them offers a seat, so pick the row by the
  // control rather than by position.
  const row = page
    .locator('tr')
    .filter({ hasText: APPLICANT.name })
    .filter({ has: page.getByRole('button', { name: /^Propose/ }) })
    .first();
  await clickUntilVisible(
    () => row.getByRole('button', { name: /^Propose/ }).click(),
    page.getByRole('button', { name: 'Confirm seat' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Confirm seat' }).click(),
    page.getByRole('button', { name: 'Release seat' }).first(),
  );

  // The seat is theirs, and the project is full again.
  await page.goto(projectUrl);
  await expect(page.getByText('10/10').first()).toBeVisible();
  const confirmed = page
    .locator('tr')
    .filter({ hasText: APPLICANT.name })
    .filter({ has: page.getByRole('button', { name: 'Release seat' }) })
    .first();
  await expect(confirmed.getByRole('button', { name: 'Release seat' })).toBeVisible();
});
