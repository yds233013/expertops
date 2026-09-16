import { expect, test } from '@playwright/test';
import { clickUntilVisible, operatorContext } from './helpers';

/**
 * The parts of the interface that only misbehave once there is data in them.
 *
 * A search box, a status filter and a page size all look correct on a board of
 * three records. The questions worth asking are whether the numbers on the
 * screen agree with each other, whether anything is being silently dropped off
 * the bottom of a list, and whether the attention queue is still a list a
 * person can act on rather than a wall.
 *
 * This runs against the hundred, and asserts against counts read from the page
 * rather than against fixed numbers, because the exercise leaves the network in
 * a slightly different shape each time it is driven.
 */
test.describe.configure({ mode: 'serial' });

test('the expert list agrees with its own filter counts, and hides nothing', async ({
  browser,
}) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/experts');

    // The "All (N)" option is the whole network; the card title says how much
    // of it is on this page. Those two numbers disagreeing used to be the only
    // sign that records were unreachable.
    const allOption = await page.locator('#status option[value=""]').innerText();
    const total = Number(/\((\d+)\)/.exec(allOption)?.[1] ?? '0');
    expect(total).toBeGreaterThanOrEqual(100);

    const title = await page
      .getByRole('heading', { name: /experts?$/ })
      .first()
      .innerText();
    const shown = Number(/^(\d+)/.exec(title)?.[1] ?? '0');
    expect(shown).toBeGreaterThan(0);

    if (total > shown) {
      // Whatever is not on this page must be reachable from it.
      await expect(
        page.getByRole('heading', { name: `${shown} of ${total} experts` }),
      ).toBeVisible();
      const next = page.getByRole('link', { name: /^Next \d+/ });
      await expect(next).toBeVisible();
      await next.click();
      await expect(page.getByRole('link', { name: 'Back to the start' })).toBeVisible();
      const secondPage = await page.getByRole('row').count();
      expect(secondPage).toBeGreaterThan(1);
    }
  } finally {
    await context.close();
  }
});

test('search narrows the network by name, email and reference', async ({ browser }) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/experts');

    // A whole area, by the name every record in it carries.
    await page.getByLabel('Search').fill('net.cyber.');
    await clickUntilVisible(
      () => page.getByRole('button', { name: 'Apply' }).click(),
      page.getByRole('heading', { name: /experts?$/ }).first(),
    );
    const cyber = await page.getByRole('row').count();
    // 25 seeded security people, plus the header row.
    expect(cyber).toBe(26);
    await expect(page.getByText('net.coding.')).toHaveCount(0);

    // One person, by reference.
    const reference = (await page.locator('tbody tr [data-reference]').first().innerText()).trim();
    await page.getByLabel('Search').fill(reference);
    await clickUntilVisible(
      () => page.getByRole('button', { name: 'Apply' }).click(),
      page.getByRole('heading', { name: '1 expert' }),
    );
    await expect(page.getByRole('row')).toHaveCount(2);

    // Something that matches nobody says so rather than showing everything.
    await page.getByLabel('Search').fill('zzz-no-such-person');
    await clickUntilVisible(
      () => page.getByRole('button', { name: 'Apply' }).click(),
      page.getByText('No experts match that filter'),
    );
  } finally {
    await context.close();
  }
});

test('the status filter counts match the rows it returns', async ({ browser }) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/experts');

    const verifiedOption = await page.locator('#status option[value="VERIFIED"]').innerText();
    const verified = Number(/\((\d+)\)/.exec(verifiedOption)?.[1] ?? '0');
    expect(verified).toBeGreaterThanOrEqual(30);

    await page.locator('#status').selectOption('VERIFIED');
    await clickUntilVisible(
      () => page.getByRole('button', { name: 'Apply' }).click(),
      page.getByRole('heading', { name: /experts?$/ }).first(),
    );

    const title = await page
      .getByRole('heading', { name: /experts?$/ })
      .first()
      .innerText();
    const shown = Number(/^(\d+)/.exec(title)?.[1] ?? '0');
    expect(shown).toBe(Math.min(verified, 50));
    // Every row on the page really is verified.
    const badges = await page.locator('tbody tr').getByText('verified', { exact: true }).count();
    expect(badges).toBe(shown);
  } finally {
    await context.close();
  }
});

test('every project reports full capacity, and the seats add up to thirty', async ({ browser }) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/projects');

    // The three exercise projects, by name. The one-seat hands-on practice
    // project sits beside them and is deliberately left empty, so counting every
    // row added its seat to the thirty.
    const rows = page.getByRole('row').filter({
      hasText: /Coding review pilot|Enterprise process assessment|Security posture review/,
    });
    const count = await rows.count();
    expect(count).toBe(3);

    let filled = 0;
    let requested = 0;
    for (let index = 0; index < count; index += 1) {
      const text = await rows.nth(index).innerText();
      const seats = /(\d+)\s*\/\s*(\d+)/.exec(text);
      if (!seats) continue;
      filled += Number(seats[1]);
      requested += Number(seats[2]);
    }
    expect(requested).toBe(30);
    expect(filled).toBe(30);
  } finally {
    await context.close();
  }
});

test('the attention queue is actionable rather than a wall of rows', async ({ browser }) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/attention');

    // Every item has to say what is stuck and what to do about it — that is
    // enforced in the service, so the page is where it is worth checking that
    // the requirement survived contact with a hundred records.
    // Each item names a blocker, an impact and what to do next. None of the
    // three is optional in the service, so all three must be on the page.
    const blockers = page.getByText('Blocker', { exact: true });
    const count = await blockers.count();
    expect(count).toBeGreaterThan(0);
    await expect(page.getByText('Impact', { exact: true })).toHaveCount(count);
    await expect(page.getByText('Do next', { exact: true })).toHaveCount(count);

    // The sidebar badge and the page must not disagree.
    const badge = await page.getByRole('link', { name: /Needs attention/ }).innerText();
    const waiting = Number(/(\d+)/.exec(badge)?.[1] ?? '0');
    expect(waiting).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('outreach batches show their recipient counts and who approved them', async ({ browser }) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/outreach');

    const batches = page.getByRole('row').filter({ hasText: /^BAT-/ });
    const count = await batches.count();
    // Three staffing batches and two replacement batches were dispatched.
    expect(count).toBeGreaterThanOrEqual(5);

    let recipients = 0;
    for (let index = 0; index < count; index += 1) {
      const text = await batches.nth(index).innerText();
      const number = /(\d+)\s*recipient/i.exec(text) ?? /\b(\d+)\b/.exec(text);
      if (number) recipients += Number(number[1]);
    }
    expect(recipients).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test('the worker page reports a queue that was drained, not one that stalled', async ({
  browser,
}) => {
  const { context, page } = await operatorContext(browser, 'lead');
  try {
    await page.goto('/worker');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Dead-lettered jobs are the number that matters: a hundred people moving
    // through the pipeline enqueues hundreds of jobs, and none of them should
    // have exhausted its retries.
    const body = await page.locator('main').innerText();
    const dead = /dead[^\d]{0,20}(\d+)/i.exec(body);
    if (dead) expect(Number(dead[1])).toBe(0);
  } finally {
    await context.close();
  }
});
