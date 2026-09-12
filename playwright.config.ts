import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv();

const PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The browser suite runs against a real Next.js production build, a real
 * PostgreSQL database and a real worker process.
 *
 * Three things are deliberately isolated from development:
 *
 *  * a separate database (`expertops_e2e`), enforced by the same fail-closed
 *    guard the seed uses, so a browser run can never truncate development data;
 *  * a separate port, so a running `npm run dev` is untouched;
 *  * a separate build directory, so the e2e build does not overwrite `.next`
 *    underneath a development server serving from it.
 */
const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_e2e?schema=public';

const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  // A production *build*, not a production *deployment*: this runs locally
  // against a throwaway database with development settings on purpose.
  EXPERTOPS_ENV: 'test',
  DATABASE_URL: E2E_DATABASE_URL,
  NEXT_DIST_DIR: '.next-e2e',
  APP_BASE_URL: E2E_BASE_URL,
  EXPOSE_PORTAL_LINKS_IN_UI: 'true',
  PORT: String(PORT),
} as Record<string, string>;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './tests/e2e/global-setup.ts',
  globalTeardown: './tests/e2e/global-teardown.ts',
  // One worker: the suite drives one shared database through a single journey.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: E2E_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run e2e:server',
    url: `${E2E_BASE_URL}/api/health`,
    // Reuse a server started by hand while iterating; always fresh in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: serverEnv,
  },
});
