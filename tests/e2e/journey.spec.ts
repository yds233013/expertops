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
 * One complete journey, performed in a browser.
 *
 * Every step below is a click or a keystroke on a real page. Nothing is set up
 * by calling an API directly, because the point of this suite is to prove the
 * application can be operated through its interfaces rather than through curl.
 *
 * Three contexts run side by side: an operator, a candidate and an expert. They
 * never share cookies.
 */
test.describe.configure({ mode: 'serial' });

const CANDIDATE = { name: 'Rosa Iqbal', email: 'rosa.iqbal@e2e.test' };
const RUBRIC = 'Evaluation Screening';
const CAMPAIGN = 'Q3 Evaluation Bench';
const PROJECT = 'Evaluation Pilot';

let operator: { context: BrowserContext; page: Page };
let candidate: { context: BrowserContext; page: Page };
let expert: { context: BrowserContext; page: Page };

let candidateUrl: string;
let projectUrl: string;

test.beforeAll(async ({ browser }) => {
  operator = await operatorContext(browser, 'admin');
  candidate = await visitorContext(browser);
  expert = await visitorContext(browser);
});

test.afterAll(async () => {
  await operator?.context.close();
  await candidate?.context.close();
  await expert?.context.close();
});

test('1. an operator authors and publishes a rubric', async () => {
  const page = operator.page;
  await page.goto('/rubrics');

  await page.getByLabel('Template name').fill(RUBRIC);
  await page.getByRole('button', { name: 'Create template' }).click();

  const card = page.locator('section').filter({ hasText: RUBRIC }).first();
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: /Start draft v1/ }).click();
  await expect(card.getByText('Version 1')).toBeVisible();

  await card
    .getByLabel('Instructions shown to the candidate')
    .fill('Describe work you have actually done. Concrete beats comprehensive.');
  await card.getByLabel('Why this version exists').fill('First published version.');

  await card.getByLabel('Label', { exact: true }).first().fill('Practical depth');
  await card.getByLabel('What a reviewer should look for').first().fill('Look for specifics.');
  await card.getByLabel('Required evidence').first().selectOption('WRITTEN_ANSWER');

  await card.getByRole('button', { name: 'Add criterion' }).click();
  await card.getByLabel('Label', { exact: true }).nth(1).fill('Evidence quality');
  await card.getByLabel('Required evidence').nth(1).selectOption('WORK_SAMPLE_LINK');

  await card.getByRole('button', { name: 'Save draft' }).click();
  await expect(card.getByText('Draft saved.')).toBeVisible();

  // Publishing is deliberate and irreversible, so it asks twice.
  await card.getByRole('button', { name: /^Publish v1$/ }).click();
  await card.getByRole('button', { name: /Confirm: publish v1/ }).click();

  // The editor is replaced by the read-only view: a published version can never
  // be edited again, and the page says so.
  await expect(card.getByText('This version is immutable')).toBeVisible();
  await expect(card.getByRole('button', { name: /Start draft v2/ })).toBeVisible();
});

test('2. the operator opens a campaign for the shortage', async () => {
  const page = operator.page;
  await page.goto('/campaigns');
  await page.getByLabel('Campaign name').fill(CAMPAIGN);
  await page.getByLabel('Qualified target').fill('1');
  await page.getByRole('button', { name: 'Open campaign' }).click();

  await expect(page.getByRole('heading', { name: CAMPAIGN })).toBeVisible();
  await expect(page.getByText('Still needed')).toBeVisible();
  await page.getByRole('button', { name: 'Move to active' }).click();
  // Only an active campaign offers "pause", so this is the state assertion.
  await expect(page.getByRole('button', { name: 'Move to paused' })).toBeVisible();
});

test('3. the operator adds a candidate and invites them to screen', async () => {
  const page = operator.page;
  await page.goto('/candidates');

  await page.getByLabel('Full name').fill(CANDIDATE.name);
  await page.getByLabel('Email').fill(CANDIDATE.email);
  await page.getByLabel('Headline').fill('Evaluation design lead');
  const campaignSelect = page.getByLabel('Campaign');
  const campaignValue = await campaignSelect
    .locator('option')
    .filter({ hasText: CAMPAIGN })
    .getAttribute('value');
  await campaignSelect.selectOption(campaignValue!);
  await page.getByRole('button', { name: 'Add candidate' }).click();
  await expect(page.getByText(`${CANDIDATE.name} added.`)).toBeVisible();

  await page.getByRole('link', { name: CANDIDATE.name }).first().click();
  await expect(page.getByRole('heading', { name: CANDIDATE.name })).toBeVisible();
  candidateUrl = page.url();

  // Two published rubrics exist, so the one just authored is chosen explicitly.
  const rubricSelect = page.getByLabel('Published rubric version');
  const rubricValue = await rubricSelect
    .locator('option')
    .filter({ hasText: RUBRIC })
    .getAttribute('value');
  await rubricSelect.selectOption(rubricValue!);
  await page.getByRole('button', { name: 'Send screening' }).click();
  await expect(page.getByText(/SCR-\d+/).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('screening invited').first()).toBeVisible();
});

test('4. the candidate opens the invitation and submits', async () => {
  await waitForOutboxMessage(operator.page, 'Screening exercise', CANDIDATE.name);
  const link = await portalLinkFor(operator.page, 'Screening exercise', CANDIDATE.name);

  const page = candidate.page;
  await page.goto(link);

  await expect(page.getByRole('heading', { name: /Hello, Rosa/ })).toBeVisible();
  // The instructions and the criteria are both readable before answering.
  await expect(page.getByText('Concrete beats comprehensive')).toBeVisible();
  await expect(page.getByText('Practical depth').first()).toBeVisible();
  await expect(page.getByText('Evidence quality').first()).toBeVisible();

  // Submitted without the required work sample link, on purpose.
  await page
    .getByLabel('Practical depth')
    .fill('I ran a 40-person annotation pilot and rewrote its scoring guide.');
  await page.getByRole('button', { name: 'Submit responses' }).click();

  // The submission is kept, and the page says exactly what is still missing.
  await expect(page.getByRole('heading', { name: 'Required evidence is missing' })).toBeVisible();
  await expect(page.getByText(/work sample link is required/i).first()).toBeVisible();
  await expect(page.getByText('evidence missing')).toBeVisible();
});

test('5. a reviewer scores it and asks for a revision', async () => {
  const page = operator.page;
  await page.goto('/screenings');

  const card = page.locator('section').filter({ hasText: CANDIDATE.name }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText('annotation pilot')).toBeVisible();

  // The worker assigns a reviewer on its own; this makes sure it is this
  // operator, so the review form is the one being driven.
  const assigned = await ensureReviewForm(page, CANDIDATE.name, 'Ada Ferris');
  await assigned.getByLabel('Practical depth').fill('3');
  await assigned.getByLabel('Evidence quality').fill('1');
  await assigned
    .getByLabel('Feedback the candidate will read')
    .fill('Please add one link to the pilot you described.');
  await assigned
    .getByLabel('Private notes, never shown to the candidate')
    .fill('Internal: verify the pilot headcount claim at reference stage.');
  await clickUntilVisible(
    () => assigned.getByRole('button', { name: 'Ask for a revision' }).click(),
    page.getByText('Ada Ferris: REQUEST_REVISION'),
  );

  const reviewed = page.locator('section').filter({ hasText: CANDIDATE.name }).first();
  await reviewed
    .getByLabel('Note explaining the decision')
    .fill('Add the link and resubmit; everything else reads well.');
  await clickUntilVisible(
    () => reviewed.getByRole('button', { name: 'Request a revision' }).click(),
    page.getByText('revision requested').first(),
  );
});

test('6. the candidate reads the feedback and resubmits, without seeing private notes', async () => {
  const page = candidate.page;
  await page.goto('/apply');

  await expect(page.getByRole('heading', { name: 'Requested changes' })).toBeVisible();
  await expect(page.getByText('Add the link and resubmit')).toBeVisible();
  await expect(page.getByText('Please add one link to the pilot')).toBeVisible();

  // The reviewer's private note must not be anywhere on this page.
  await expect(page.getByText('verify the pilot headcount claim')).toHaveCount(0);
  expect(await page.content()).not.toContain('Internal: verify the pilot headcount');

  // Their previous answer is still there to edit.
  await expect(page.getByLabel('Practical depth')).toHaveValue(/annotation pilot/);
  await page.getByLabel('Evidence quality').fill('Scoring guide and pilot report, linked below.');
  await page.getByLabel('Work sample links').fill('https://example.test/annotation-pilot');
  await page.getByRole('button', { name: 'Submit revised responses' }).click();

  // Assert the recorded state rather than the form's own confirmation: a
  // successful submission closes the window, which unmounts the form and takes
  // its message with it.
  await expect
    .poll(
      async () => {
        await page.goto('/apply');
        return page
          .getByText(/Revision 2/)
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await expect(page.getByRole('heading', { name: 'Required evidence is missing' })).toHaveCount(0);
  await expect(page.getByText(/Nothing is needed from you/)).toBeVisible();
});

test('7. an authorised operator qualifies the candidate', async () => {
  const page = operator.page;
  await page.goto('/screenings');

  const assigned = await ensureReviewForm(page, CANDIDATE.name, 'Ada Ferris');
  await assigned.getByLabel('Practical depth').fill('4');
  await assigned.getByLabel('Evidence quality').fill('4');
  await assigned.getByLabel('Feedback the candidate will read').fill('Clear evidence, thank you.');
  await clickUntilVisible(
    () => assigned.getByRole('button', { name: 'Recommend approve' }).click(),
    page.getByText('Ada Ferris: APPROVE'),
  );

  const decided = page.locator('section').filter({ hasText: CANDIDATE.name }).first();
  await decided.getByLabel('Note explaining the decision').fill('Meets the bar for the pilot.');
  await decided.getByRole('button', { name: 'Qualify', exact: true }).click();

  await expect
    .poll(
      async () => {
        await page.goto(candidateUrl);
        return page
          .getByText('qualified')
          .first()
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
});

test('8. the operator records the new expert’s skills', async () => {
  const page = operator.page;
  await page.goto('/experts');
  await page.getByRole('link', { name: CANDIDATE.name }).first().click();
  await expect(page.getByRole('heading', { name: CANDIDATE.name })).toBeVisible();

  // A qualification says someone meets a bar; it does not say what they can do.
  // Without a skill on file they are excluded from every match by a hard filter.
  await page.getByLabel('Skill', { exact: true }).first().fill('Evaluation Design');
  await page.getByLabel('Proficiency').first().selectOption('4');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Save skills' }).click(),
    page.getByText('Skills saved.'),
  );
});

test('9. the operator creates a project and invites the qualified expert', async () => {
  const page = operator.page;

  await page.goto('/projects/new');
  await page.getByLabel('Title').fill(PROJECT);
  await page.getByLabel('Client').fill('Internal Research');
  await page.getByLabel('Seats').fill('1');
  await page.getByLabel('Min. experience').fill('0');

  // Matching needs at least one skill requirement. It is optional rather than
  // required, so it weights the ranking instead of excluding people.
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
    page.getByRole('link', { name: CANDIDATE.name }).first(),
  );

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Invite', exact: true }).first().click(),
    page.getByRole('button', { name: 'Send invitation' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Send invitation' }).click(),
    page.getByText('sent').first(),
  );
});

test('10. the expert accepts, onboards, and a human verifies them', async () => {
  const page = operator.page;
  await waitForOutboxMessage(page, 'invitation|invited|' + PROJECT, CANDIDATE.name);
  const link = await portalLinkFor(page, 'invitation|invited|' + PROJECT, CANDIDATE.name);

  const portal = expert.page;
  await portal.goto(link);
  await expect(portal.getByRole('heading', { name: /Hello, Rosa/ })).toBeVisible();

  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Accept', exact: true }).click(),
    portal.getByRole('heading', { name: 'Onboarding checklist' }),
  );

  // Fill every checklist item: free-text answers and attestations alike.
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

  // Human verification. Nothing about this is automatic.
  await page.goto('/onboarding');
  await expect(page.getByText(CANDIDATE.name).first()).toBeVisible({ timeout: 30_000 });
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Verify expert' }).first().click(),
    // The queue holds submitted cases only, so a verified one leaves it.
    page.getByText('Nothing waiting for review'),
  );

  await portal.goto('/portal');
  await expect(portal.getByText('An operator verified your submission')).toBeVisible();
});

test('11. the expert declares availability and the operator staffs the seat', async () => {
  const portal = expert.page;
  await portal.goto('/portal');

  const from = new Date();
  const to = new Date(from.getTime() + 60 * 86_400_000);
  await portal.getByLabel('From').fill(from.toISOString().slice(0, 10));
  await portal.getByLabel('To').fill(to.toISOString().slice(0, 10));
  await portal.getByLabel('Hours/week').fill('20');
  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Add window' }).click(),
    portal.getByText('20 h/week').first(),
  );

  const page = operator.page;
  await page.goto(projectUrl);
  await clickUntilVisible(
    () => page.getByRole('button', { name: /^Propose Rosa/ }).click(),
    page.getByRole('button', { name: 'Confirm seat' }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Confirm seat' }).click(),
    page.getByRole('button', { name: 'Release seat' }),
  );
});

test('12. the expert raises a support request and an operator replies', async () => {
  const portal = expert.page;
  await portal.goto('/portal');

  await portal.getByLabel('Subject').fill('Cannot reach the annotation tool');
  await portal.getByLabel('What do you need?').fill('The sign-in page rejects my account.');
  await portal.getByLabel('Category').selectOption('ACCESS');
  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Send request' }).click(),
    portal.getByRole('heading', { name: 'Cannot reach the annotation tool' }),
  );

  const page = operator.page;
  await page.goto('/support');
  const thread = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Cannot reach the annotation tool' }) })
    .first();
  await expect(thread).toBeVisible();

  // An internal note first. The expert must never see this.
  await thread.getByLabel(/^Reply to SUP-/).fill('Internal: account disabled for inactivity.');
  await thread.getByLabel(/Internal note/).check();
  await clickUntilVisible(
    () => thread.getByRole('button', { name: 'Save internal note' }).click(),
    page.getByText('internal, not sent to the expert').first(),
  );

  const updated = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Cannot reach the annotation tool' }) })
    .first();
  await updated.getByLabel(/^Reply to SUP-/).fill('Your access is restored, please try again.');
  await clickUntilVisible(
    () => updated.getByRole('button', { name: 'Send reply' }).click(),
    page.getByText('Your access is restored').first(),
  );

  // The expert sees the reply and not the note. Re-read rather than trusting a
  // single render: the operator's reply and this page load are two requests,
  // and the portal can be rendered from the state just before the reply landed.
  await expect
    .poll(
      async () => {
        await portal.goto('/portal');
        return portal
          .getByText('Your access is restored, please try again.')
          .isVisible()
          .catch(() => false);
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);

  await expect(portal.getByText('account disabled for inactivity')).toHaveCount(0);
  expect(await portal.content()).not.toContain('disabled for inactivity');
});

test('13. work is assigned, submitted, reviewed and approved', async () => {
  const page = operator.page;
  await page.goto('/work');

  await page.getByLabel('Title').fill('Draft the pilot scoring guide');
  await page.getByLabel('Instructions').fill('Two pages, with worked examples.');
  await page.getByLabel('Basis').selectOption('HOURLY');
  // The due date is the part that used to be missing. `work.remind_overdue`
  // selects on `dueAt <= now`, so a form that cannot set one produces work that
  // can never be reported late — and the attention item for an unstaffed seat
  // tells the operator to set one, which they then could not do.
  await page.getByLabel('Due date').fill('2026-12-24');
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Assign work' }).click(),
    page.getByText('Work assigned'),
  );

  await expect(
    page.locator('section').filter({ hasText: 'Draft the pilot scoring guide' }).first(),
  ).toContainText('due');

  const portal = expert.page;
  await portal.goto('/portal');
  await expect(portal.getByText('Draft the pilot scoring guide')).toBeVisible();
  await portal.getByLabel('One-line summary').fill('Scoring guide drafted.');
  await portal.getByLabel('What you did').fill('Wrote the guide and two worked examples.');
  await portal.getByLabel('Hours worked').fill('6');
  await clickUntilVisible(
    () => portal.getByRole('button', { name: 'Submit work' }).click(),
    portal.getByText(/Revision 1 submitted/),
  );

  await page.goto('/work');
  const item = page.locator('section').filter({ hasText: 'Draft the pilot scoring guide' }).first();
  await expect(item).toBeVisible();

  await clickUntilVisible(
    () => item.getByRole('button', { name: /^Review WRK-/ }).click(),
    item.getByLabel('Summary'),
  );
  await item.getByLabel('Summary').fill('Accepted as delivered.');
  // Approving the hours as claimed: a shortfall would flag the payment item
  // for someone to explain before it could be batched.
  await item.getByLabel(/^Approved hours/).fill('6');
  await clickUntilVisible(
    () => item.getByRole('button', { name: 'Approve', exact: true }).click(),
    page.getByText('approved').first(),
  );
});

test('14. approved work appears once in payment preparation and can be exported', async () => {
  const page = operator.page;

  await expect
    .poll(
      async () => {
        await page.goto('/payments');
        return page.getByText(/Rosa Iqbal/).count();
      },
      { timeout: 60_000, intervals: [1000, 2000, 3000] },
    )
    .toBeGreaterThan(0);

  // Exactly one payment item for the approved work: approving twice, or a
  // worker retry, must not produce a second row.
  await expect(page.getByRole('cell', { name: 'Rosa Iqbal' })).toHaveCount(1);

  await clickUntilVisible(
    () => page.getByRole('button', { name: /Create batch of/ }).click(),
    page.getByRole('button', { name: /Submit for approval/ }),
  );
  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Submit for approval' }).click(),
    page.getByRole('button', { name: 'Approve', exact: true }),
  );

  // The operator who created the batch cannot approve it. That rule is
  // exercised here rather than avoided.
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: /someone other than the operator who created it/ }),
  ).toBeVisible();

  // A second admin approves, and only then can the file be produced.
  const second = await operatorContext(operator.page.context().browser()!, 'approver');
  try {
    await second.page.goto('/payments');
    await clickUntilVisible(
      () => second.page.getByRole('button', { name: 'Approve', exact: true }).click(),
      second.page.getByRole('button', { name: 'Export CSV' }),
    );

    const download = second.page.waitForEvent('download');
    await second.page.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);

    // Said in the interface, not only in the docs: exported is not paid.
    await expect(second.page.getByText('Exported. Not a record of payment.')).toBeVisible();
  } finally {
    await second.context.close();
  }
});

test('15. an operator issues a replacement portal link when the first one is spent', async () => {
  // Portal links work once. An expert whose link is spent and whose session has
  // lapsed is told by /portal/enter to ask their ExpertOps contact for a new
  // one — advice the contact had no way to act on, which left a staging
  // environment unusable after its first link was opened.
  const page = operator.page;
  await page.goto('/experts');
  await page.getByRole('link', { name: CANDIDATE.name }).click();

  await clickUntilVisible(
    () => page.getByRole('button', { name: 'Issue a new portal link' }).click(),
    page.getByText('A new portal link is in the outbox'),
  );

  // The link is not on the expert record. Operators read portal links from the
  // outbox, and that stays true for this one.
  await expect(page.getByText(/portal\/enter#t=/)).toHaveCount(0);

  await waitForOutboxMessage(page, 'Your new ExpertOps portal link', CANDIDATE.name);
  const link = await portalLinkFor(page, 'Your new ExpertOps portal link', CANDIDATE.name);

  // A fresh context, because the point is that somebody with no session can get
  // back in using only what the operator sent them.
  const returning = await visitorContext(page.context().browser()!);
  try {
    await returning.page.goto(link);
    await expect(returning.page.getByRole('heading', { name: /^Hello,/i })).toBeVisible();
  } finally {
    await returning.context.close();
  }
});
