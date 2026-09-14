import { expect, test, type Page } from '@playwright/test';
import { operatorContext, portalLinkFor, visitorContext, waitForOutboxMessage } from './helpers';

/**
 * Usability at two viewport sizes.
 *
 * These are mechanical checks, not an accessibility audit. Each one is
 * something a person would notice immediately and a screenshot would not:
 * a page that scrolls sideways, a control with no name a screen reader can
 * announce, a form field with no label, or a keyboard focus ring that cannot
 * be seen.
 */
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 375, height: 667 };

const OPERATOR_PAGES = [
  '/dashboard',
  '/candidates',
  '/campaigns',
  '/screenings',
  '/rubrics',
  '/experts',
  '/onboarding',
  '/work',
  '/support',
  '/payments',
  '/outbox',
];

/** Nothing on the page may push the document wider than the viewport. */
async function expectNoHorizontalOverflow(page: Page, where: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const box = element.getBoundingClientRect();
      // Allow a pixel of rounding, and ignore anything deliberately scrollable.
      if (box.right > doc.clientWidth + 1) {
        let node: HTMLElement | null = element;
        let scrollable = false;
        while (node) {
          const style = getComputedStyle(node);
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') scrollable = true;
          node = node.parentElement;
        }
        if (!scrollable) {
          offenders.push(`${element.tagName.toLowerCase()}.${element.className}`.slice(0, 120));
        }
      }
    }
    return { documentScroll: doc.scrollWidth - doc.clientWidth, offenders: offenders.slice(0, 5) };
  });

  expect(
    overflow.documentScroll,
    `${where} scrolls sideways; widest offenders: ${overflow.offenders.join(' | ')}`,
  ).toBeLessThanOrEqual(1);
}

/** Every interactive control must have something a screen reader can announce. */
async function expectNamedControls(page: Page, where: string) {
  const unnamed = await page.evaluate(() => {
    const problems: string[] = [];
    const controls = document.querySelectorAll<HTMLElement>(
      'input:not([type=hidden]), select, textarea, button, a[href]',
    );
    for (const control of Array.from(controls)) {
      if (control.hasAttribute('aria-hidden')) continue;
      const id = control.getAttribute('id');
      const labelled =
        control.getAttribute('aria-label') ||
        control.getAttribute('aria-labelledby') ||
        (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
        control.closest('label') ||
        control.textContent?.trim() ||
        control.getAttribute('title') ||
        control.getAttribute('placeholder');
      if (!labelled) {
        problems.push(
          `${control.tagName.toLowerCase()}${id ? `#${id}` : ''}.${control.className}`.slice(
            0,
            120,
          ),
        );
      }
    }
    return problems.slice(0, 8);
  });

  expect(unnamed, `${where} has controls with no accessible name`).toEqual([]);
}

/** A keyboard user must be able to see where they are. */
async function expectVisibleFocus(page: Page, where: string) {
  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return null;
    const style = getComputedStyle(active);
    return {
      tag: active.tagName.toLowerCase(),
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
      boxShadow: style.boxShadow,
    };
  });

  expect(focus, `${where}: nothing receives keyboard focus`).not.toBeNull();
  const visible =
    (focus!.outlineStyle !== 'none' && parseFloat(focus!.outlineWidth) > 0) ||
    (focus!.boxShadow !== 'none' && focus!.boxShadow !== '');
  expect(visible, `${where}: focused ${focus!.tag} has no visible focus indicator`).toBe(true);
}

test.describe('operator pages', () => {
  for (const viewport of [DESKTOP, MOBILE]) {
    test(`are usable at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
      const operator = await operatorContext(browser, 'admin');
      try {
        await operator.page.setViewportSize(viewport);
        for (const path of OPERATOR_PAGES) {
          await operator.page.goto(path);
          const where = `${path} at ${viewport.width}px`;

          // Navigation has to still be reachable, not pushed off-screen. On a
          // wide viewport that is the rail; on a narrow one the sections live
          // behind a menu button, and reachable means the button opens them.
          if (viewport.width >= 1024) {
            await expect(operator.page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
          } else {
            const menu = operator.page.getByRole('button', { name: /Menu/ });
            await expect(menu).toBeVisible();
            await expect(menu).toHaveAttribute('aria-expanded', 'false');
            await menu.click();
            await expect(menu).toHaveAttribute('aria-expanded', 'true');
            await expect(operator.page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
            // Escape closes it, so a keyboard user is never trapped behind it.
            await operator.page.keyboard.press('Escape');
            await expect(menu).toHaveAttribute('aria-expanded', 'false');
          }
          await expectNoHorizontalOverflow(operator.page, where);
          await expectNamedControls(operator.page, where);
        }
      } finally {
        await operator.context.close();
      }
    });
  }
});

test.describe('the candidate screening page', () => {
  for (const viewport of [DESKTOP, MOBILE]) {
    test(`is usable at ${viewport.width}x${viewport.height}`, async ({ browser }) => {
      const operator = await operatorContext(browser, 'admin');
      const candidate = await visitorContext(browser);
      const name = `Viewport Tester ${viewport.width}`;
      const email = `viewport.${viewport.width}@e2e.test`;

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

        await candidate.page.setViewportSize(viewport);
        await candidate.page.goto(link);
        await expect(
          candidate.page.getByRole('heading', { name: /Hello, Viewport/ }),
        ).toBeVisible();

        const where = `/apply at ${viewport.width}px`;
        await expectNoHorizontalOverflow(candidate.page, where);
        await expectNamedControls(candidate.page, where);
        await expectVisibleFocus(candidate.page, where);

        // The answer field and the submit button must both be usable, not just
        // present: a control that cannot be reached is not a working form.
        const answer = candidate.page.getByLabel('Practical depth');
        await expect(answer).toBeVisible();
        await answer.scrollIntoViewIfNeeded();
        await answer.fill('Typed on a narrow screen.');
        await expect(answer).toHaveValue('Typed on a narrow screen.');

        const submit = candidate.page.getByRole('button', { name: /Submit responses/ });
        await submit.scrollIntoViewIfNeeded();
        await expect(submit).toBeVisible();
        await expect(submit).toBeEnabled();

        // Keyboard submission, not just a mouse click.
        await submit.focus();
        await candidate.page.keyboard.press('Enter');
        await expect(
          candidate.page.getByRole('heading', { name: 'Your submissions' }),
        ).toBeVisible();
        await expect(candidate.page.getByText(/Revision 1/)).toBeVisible();
      } finally {
        await operator.context.close();
        await candidate.context.close();
      }
    });
  }
});

test('the sign-in page is usable on a narrow screen and by keyboard alone', async ({ browser }) => {
  const visitor = await visitorContext(browser);
  try {
    await visitor.page.setViewportSize(MOBILE);
    await visitor.page.goto('/login');

    await expectNoHorizontalOverflow(visitor.page, '/login at 375px');
    await expectNamedControls(visitor.page, '/login at 375px');
    await expectVisibleFocus(visitor.page, '/login at 375px');

    // Tab order reaches both fields and the button, in that order.
    await visitor.page.getByLabel('Work email').focus();
    await visitor.page.keyboard.type('admin@e2e.test');
    await visitor.page.keyboard.press('Tab');
    await visitor.page.keyboard.type('e2e-password-123');
    await visitor.page.keyboard.press('Enter');

    // Signed in, on a phone: the workspace heading is the proof, because the
    // sections are behind the menu at this width.
    await expect(visitor.page.getByRole('heading', { name: 'Operator dashboard' })).toBeVisible();
    await expect(visitor.page.getByRole('button', { name: /Menu/ })).toBeVisible();
  } finally {
    await visitor.context.close();
  }
});
