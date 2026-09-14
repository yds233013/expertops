import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';

loadEnv();

const PORT = Number(process.env.EXERCISE_PORT ?? 3200);
export const EXERCISE_BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The hundred-contributor exercise, driven through a browser.
 *
 * Separate from the browser suite in one decisive way: **nothing is reset**.
 * `tests/e2e` truncates its database in global setup, which is right for a
 * suite that must start from a known board. This one runs against a network of
 * a hundred people built by `scripts/network-exercise.ts` and has to leave it
 * standing afterwards, because the point is to inspect it.
 *
 * That means these specs must be written to survive a database that already has
 * history in it, and to be re-runnable. Where a spec needs a fresh record it
 * makes one with a timestamped name rather than assuming an empty table.
 */
const EXERCISE_DATABASE_URL =
  process.env.EXERCISE_DATABASE_URL ??
  'postgresql://expertops:expertops@localhost:5433/expertops_exercise?schema=public';

const serverEnv = {
  ...process.env,
  NODE_ENV: 'production',
  EXPERTOPS_ENV: 'test',
  DATABASE_URL: EXERCISE_DATABASE_URL,
  NEXT_DIST_DIR: '.next-exercise',
  APP_BASE_URL: EXERCISE_BASE_URL,
  EXPOSE_PORTAL_LINKS_IN_UI: 'true',
  PORT: String(PORT),
} as Record<string, string>;

export default defineConfig({
  testDir: './tests/exercise',
  testMatch: /.*\.spec\.ts/,
  globalSetup: './tests/exercise/global-setup.ts',
  globalTeardown: './tests/exercise/global-teardown.ts',
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: EXERCISE_BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `NEXT_DIST_DIR=.next-exercise next build && NEXT_DIST_DIR=.next-exercise next start --port ${PORT}`,
    url: `${EXERCISE_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: serverEnv,
  },
});
