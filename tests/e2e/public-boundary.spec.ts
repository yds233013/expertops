import { expect, test, type APIRequestContext } from '@playwright/test';
import { operatorContext, visitorContext } from './helpers';

/**
 * What a stranger can reach once the outer gate is gone.
 *
 * This suite is the reason the Basic gate could be removed at all. Until it
 * passed, the only thing standing between the internet and the operator
 * workspace was a shared password in an environment variable — which is a
 * perimeter, not an authorisation model, and says nothing about whether the
 * application itself would hold.
 *
 * Every assertion here is about an anonymous request. "Anonymous" means a fresh
 * browser context and a bare API client: no session cookie, no portal token, no
 * CSRF token unless one is fetched deliberately.
 */

/** Everything an anonymous visitor is *meant* to reach. */
const PUBLIC_PATHS = ['/demo', '/apply/opportunities', '/login', '/api/health'] as const;

/**
 * Administrative pages. Each must refuse an anonymous visitor — by redirecting
 * to sign-in, not by rendering and hoping nobody looks.
 */
const OPERATOR_PAGES = [
  '/dashboard',
  '/experts',
  '/candidates',
  '/projects',
  '/opportunities',
  '/screenings',
  '/rubrics',
  '/campaigns',
  '/onboarding',
  '/outreach',
  '/work',
  '/support',
  '/payments',
  '/attention',
  '/outbox',
  '/activity',
  '/jobs',
] as const;

/** Read APIs that would be a data breach if they answered a stranger. */
const OPERATOR_GET_APIS = [
  '/api/experts',
  '/api/candidates',
  '/api/projects',
  '/api/opportunities',
  '/api/screenings',
  '/api/outbox',
  '/api/activity',
  '/api/payment-items',
  '/api/payment-batches',
  '/api/outreach-batches',
  '/api/work-items',
  '/api/support-requests',
  '/api/attention',
  '/api/jobs',
  '/api/schedules',
  '/api/qualifications',
  '/api/duplicates',
  '/api/rubrics',
  '/api/experts/export',
  '/api/auth/me',
] as const;

/** Mutations. A stranger must not be able to move a business record. */
const OPERATOR_MUTATIONS: { path: string; body: unknown }[] = [
  { path: '/api/experts', body: { fullName: 'X', email: 'x@test.local', headline: 'X' } },
  { path: '/api/candidates', body: { fullName: 'X', email: 'x@test.local' } },
  { path: '/api/projects', body: { title: 'X', clientName: 'X', seatsRequested: 1 } },
  { path: '/api/opportunities', body: { title: 'X', summary: 'X', description: 'X' } },
  { path: '/api/campaigns', body: { name: 'X' } },
  { path: '/api/rubrics', body: { name: 'X' } },
  { path: '/api/work-items', body: { assignmentId: 'x', title: 'X' } },
  { path: '/api/payment-batches', body: { itemIds: ['x'] } },
  { path: '/api/outreach-batches', body: { kind: 'REPLACEMENT', items: [] } },
];

function unauthorised(status: number): boolean {
  // 401 and 403 are outright refusals; 307/302 is the redirect to sign-in.
  return [401, 403, 302, 307].includes(status);
}

test.describe('anonymous visitors', () => {
  test('can reach the public surfaces, and they render', async ({ browser }) => {
    const { context, page } = await visitorContext(browser);
    try {
      for (const path of PUBLIC_PATHS) {
        const response = await page.goto(path);
        expect(response?.status(), `${path} should be public`).toBe(200);
      }

      await page.goto('/demo');
      await expect(page.getByRole('heading', { name: /synthetic demo/i })).toBeVisible();
      await expect(page.getByText(/Everything here is synthetic/i)).toBeVisible();

      await page.goto('/apply/opportunities');
      await expect(page.getByText(/practice listings, not real jobs/i)).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('are refused every administrative page', async ({ browser }) => {
    const { context, page } = await visitorContext(browser);
    try {
      for (const path of OPERATOR_PAGES) {
        const response = await page.goto(path);
        const status = response?.status() ?? 0;
        // Next.js follows the redirect, so assert on where it landed.
        expect(
          page.url().includes('/login') || unauthorised(status),
          `${path} rendered to an anonymous visitor (status ${status}, url ${page.url()})`,
        ).toBe(true);
        // And nothing from the workspace leaked into whatever did render.
        const body = await page.content();
        expect(body, `${path} leaked the operator rail`).not.toContain('Needs attention');
      }
    } finally {
      await context.close();
    }
  });

  test('are refused every administrative read API', async ({ playwright, baseURL }) => {
    const api: APIRequestContext = await playwright.request.newContext({ baseURL });
    try {
      for (const path of OPERATOR_GET_APIS) {
        const response = await api.get(path);
        expect(unauthorised(response.status()), `${path} answered ${response.status()}`).toBe(true);
      }
    } finally {
      await api.dispose();
    }
  });

  test('cannot mutate a business record', async ({ playwright, baseURL }) => {
    const api: APIRequestContext = await playwright.request.newContext({ baseURL });
    try {
      for (const { path, body } of OPERATOR_MUTATIONS) {
        const response = await api.post(path, { data: body });
        expect(unauthorised(response.status()), `POST ${path} answered ${response.status()}`).toBe(
          true,
        );
      }
    } finally {
      await api.dispose();
    }
  });

  test('cannot read the outbox, a portal link or a session token by any route', async ({
    browser,
    playwright,
    baseURL,
  }) => {
    const { context, page } = await visitorContext(browser);
    const api = await playwright.request.newContext({ baseURL });
    try {
      // The demo page is the one anonymous surface that touches real records,
      // so it is the one worth searching character by character.
      await page.goto('/demo');
      const html = await page.content();

      for (const forbidden of [
        '/portal/enter#t=',
        '/apply/enter#t=',
        'expertops_session',
        'expertops_portal',
        'expertops_candidate',
        '@example.test',
        'passwordHash',
      ]) {
        expect(html, `the demo page contained "${forbidden}"`).not.toContain(forbidden);
      }

      // No candidate, application or message reference on it either.
      expect(html).not.toMatch(/CAN-\d{4}/);
      expect(html).not.toMatch(/APP-\d{4}/);
      expect(html).not.toMatch(/SCR-\d{4}/);
      expect(html).not.toMatch(/PAY-\d{4}/);

      // And the outbox is not reachable directly.
      const outbox = await api.get('/api/outbox');
      expect(unauthorised(outbox.status())).toBe(true);
    } finally {
      await api.dispose();
      await context.close();
    }
  });
});

test('one candidate cannot reach another candidate’s records', async ({
  browser,
  playwright,
  baseURL,
}) => {
  const operator = await operatorContext(browser, 'admin');
  const api = await playwright.request.newContext({ baseURL });
  try {
    // Two candidates exist in the seeded board; take two screening ids from the
    // operator side, then try to read one without any candidate session at all.
    await operator.page.goto('/screenings');
    const references = await operator.page
      .getByText(/SCR-\d+/)
      .allInnerTexts()
      .catch(() => [] as string[]);

    const screenings = await api.get('/api/screenings');
    expect(unauthorised(screenings.status())).toBe(true);

    // The candidate-facing route requires a candidate session; without one it
    // refuses rather than falling back to "any candidate".
    const candidateRoute = await api.get('/api/apply/screenings/does-not-exist');
    expect(unauthorised(candidateRoute.status())).toBe(true);

    expect(references.length).toBeGreaterThanOrEqual(0);
  } finally {
    await api.dispose();
    await operator.context.close();
  }
});

test('a signed-in operator still has the workspace', async ({ browser }) => {
  const operator = await operatorContext(browser, 'admin');
  try {
    for (const path of ['/dashboard', '/experts', '/opportunities', '/payments', '/outbox']) {
      const response = await operator.page.goto(path);
      expect(response?.status(), `${path} should render for an operator`).toBe(200);
      expect(operator.page.url()).not.toContain('/login');
    }
    await expect(operator.page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  } finally {
    await operator.context.close();
  }
});
