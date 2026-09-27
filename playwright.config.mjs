// Playwright config (docs/DESIGN.md §5.2). Headless Chromium only — never a
// visible browser, never the real display. `page.screenshot()` renders
// offscreen.
//
// Two projects:
// - "chromium" (`make test-e2e`): tests/e2e/*.spec.mjs against
//   tests/e2e/fixture-server.mjs, started per worker by the `backend`
//   fixture in tests/e2e/fixtures.mjs.
// - "real" (`make test-e2e-real`): tests/e2e/real/*.spec.mjs against the
//   actual `python3 -m everwatch serve --demo` process, spawned per test by
//   tests/e2e/real/backend.mjs (see its header comment for why per-test
//   rather than one shared webServer: some scenarios need a fixed CLI flag,
//   like --demo-diagnostics, at launch time).
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.mjs$/,
  outputDir: 'test-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 2,
  reporter: [['list']],
  timeout: 20000,
  expect: { timeout: 4000 },
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /real\//,
      use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'real',
      testDir: 'tests/e2e/real',
      // Spawning a real Python process per test is slower than the JS
      // fixture server; give it more headroom than the default 20 s.
      timeout: 40000,
      use: { ...devices['Desktop Chrome'], headless: true, viewport: { width: 1280, height: 800 } },
    },
  ],
});
