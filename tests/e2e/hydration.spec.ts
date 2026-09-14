import { expect, test } from '@playwright/test';
import {
  clickUntilVisible,
  operatorContext,
  portalLinkFor,
  visitorContext,
  waitForOutboxMessage,
} from './helpers';

/**
 * Typing before the page has hydrated.
 *
 * A Next.js page serves HTML first and attaches React afterwards. A person who
 * starts typing in that gap is doing nothing unusual — the form is on screen
 * and accepts keystrokes — but a controlled React input reads its value from
 * component state, and state is built from props when the component mounts.
 * Whatever was typed into the DOM before that moment is overwritten.
 *
 * It is intermittent in the wild, which is the worst kind of data loss: the
 * candidate sees their answer vanish, resubmits, and nobody can reproduce it.
 * Here the gap is made deterministic by holding the JavaScript back, so the
 * race always resolves the same way.
 */
const HYDRATION_DELAY_MS = 4000;

test('a candidate who types before the page finishes loading keeps their answer', async ({
  browser,
}) => {
  const operator = await operatorContext(browser, 'admin');
  const candidate = await visitorContext(browser);
  const name = `Hydration Tester ${Date.now()}`;
  const email = `hydration.${Date.now()}@e2e.test`;
  const answer = 'Typed while the page was still loading, and it must survive.';

  try {
    await operator.page.goto('/candidates');
    await operator.page.getByLabel('Full name').fill(name);
    await operator.page.getByLabel('Email').fill(email);
    await operator.page.getByRole('button', { name: 'Add candidate' }).click();
    await expect(operator.page.getByText(`${name} added.`)).toBeVisible();

    await operator.page.getByRole('link', { name }).first().click();
    await operator.page.getByRole('button', { name: 'Send screening' }).click();
    await expect(operator.page.getByText(/SCR-\d+/).first()).toBeVisible({ timeout: 20_000 });

    await waitForOutboxMessage(operator.page, 'Screening exercise', name);
    const link = await portalLinkFor(operator.page, 'Screening exercise', name);

    // Redeem the link first: the landing page posts the token and redirects, so
    // delaying its scripts would only stall the handover, not the form.
    await candidate.page.goto(link);
    await expect(candidate.page.getByRole('heading', { name: /Hello, Hydration/ })).toBeVisible({
      timeout: 20_000,
    });

    // Now hold the client bundle back so the form is on screen, and typeable,
    // for four seconds before React attaches to it.
    await candidate.page.route('**/_next/static/chunks/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
      await route.continue();
    });

    await candidate.page.goto('/apply', { waitUntil: 'commit' });
    const field = candidate.page.getByLabel('Practical depth');
    await field.waitFor({ state: 'visible' });
    await field.fill(answer);
    expect(await field.inputValue()).toBe(answer);

    // Let the delay expire and hydration happen, then look again. This is the
    // moment the answer used to disappear.
    await expect
      .poll(
        async () =>
          candidate.page.evaluate(() => {
            const form = document.querySelector('form');
            // A hydrated form has React's event handlers attached; before that
            // it is inert markup. The submit button's disabled state is driven
            // by state, so its presence alone proves nothing — wait for React
            // to have claimed the container instead.
            return Boolean(
              form &&
              Object.keys(form).some(
                (key) => key.startsWith('__react') || key.startsWith('_react'),
              ),
            );
          }),
        { timeout: 30_000, intervals: [250, 500, 1000] },
      )
      .toBe(true);

    expect(
      await field.inputValue(),
      'the answer typed before hydration was overwritten when React attached',
    ).toBe(answer);

    // And it is what actually gets submitted, not merely what is on screen.
    // The old failure recorded a revision containing nothing while the words
    // were still visible in the textarea, so "a revision exists" is not enough:
    // it has to be a complete one, and the operator has to be able to read it.
    await candidate.page.getByRole('button', { name: /Submit responses/ }).click();
    await expect
      .poll(
        async () => {
          await candidate.page.goto('/apply');
          return candidate.page
            .getByText(/Revision 1/)
            .isVisible()
            .catch(() => false);
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const revision = candidate.page.getByRole('listitem').filter({ hasText: /Revision 1/ });
    await expect(revision).toContainText('complete');
    await expect(candidate.page.getByText('evidence missing')).toHaveCount(0);

    await operator.page.goto('/screenings');
    const card = operator.page.locator('section').filter({ hasText: name }).first();
    await expect(card).toBeVisible();
    await expect(card.getByText(answer)).toBeVisible();
  } finally {
    await operator.context.close();
    await candidate.context.close();
  }
});

test('an applicant who types before the page finishes loading keeps their application', async ({
  browser,
}) => {
  const operator = await operatorContext(browser, 'admin');
  const applicant = await visitorContext(browser);
  const title = `Hydration listing ${Date.now()}`;
  const name = `Early Typist ${Date.now()}`;
  const email = `early.typist.${Date.now()}@e2e.test`;
  const experience = 'Written before the JavaScript arrived, and it must reach the operator.';

  try {
    await operator.page.goto('/opportunities/new');
    await operator.page.getByLabel('Title').fill(title);
    await operator.page.getByLabel('Summary').fill('A listing used to check the loading gap.');
    await operator.page.getByLabel('Description').fill('Read things, write notes.');
    await operator.page.getByRole('button', { name: 'Add question' }).click();
    await operator.page.getByLabel('Question 1 label').fill('Why this one?');
    await operator.page.getByRole('button', { name: 'Create draft' }).click();
    await expect(operator.page.getByRole('heading', { name: title, level: 1 })).toBeVisible({
      timeout: 20_000,
    });
    const opportunityPath = new URL(operator.page.url()).pathname;
    await clickUntilVisible(
      () => operator.page.getByRole('button', { name: 'Publish' }).click(),
      operator.page.getByText('Live at'),
    );
    const slug = (
      await operator.page
        .getByText(/\/apply\/opportunities\//)
        .first()
        .innerText()
    )
      .trim()
      .split('/')
      .pop()!;

    await applicant.page.route('**/_next/static/chunks/**', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, HYDRATION_DELAY_MS));
      await route.continue();
    });
    await applicant.page.goto(`/apply/opportunities/${slug}`, { waitUntil: 'commit' });

    const nameField = applicant.page.getByLabel('Your name');
    await nameField.waitFor({ state: 'visible' });
    await nameField.fill(name);
    await applicant.page.getByLabel('Email').fill(email);
    await applicant.page.getByLabel('Relevant experience').fill(experience);
    await applicant.page.getByLabel('Hours per week you are available').fill('12');
    await applicant.page.getByLabel('Why this one?').fill('Because I typed early.');

    await clickUntilVisible(
      () => applicant.page.getByRole('button', { name: 'Submit application' }).click(),
      applicant.page.getByText(/Application received/),
    );

    // What the operator receives is the test. An application recorded with a
    // blank name and no experience is the failure this guards against.
    await operator.page.goto(opportunityPath);
    await expect(operator.page.getByRole('heading', { name: /Applicants \(1\)/ })).toBeVisible();
    await operator.page
      .getByRole('link', { name: /APP-\d+/ })
      .first()
      .click();
    await expect(operator.page.getByRole('heading', { name, level: 1 })).toBeVisible();
    await expect(operator.page.getByText(experience)).toBeVisible();
    await expect(operator.page.getByText('Because I typed early.')).toBeVisible();
    await expect(operator.page.getByText('12 h/week')).toBeVisible();
  } finally {
    await operator.context.close();
    await applicant.context.close();
  }
});
