// Playwright fixtures for the "real" project (tests/e2e/real/*.spec.mjs):
// every test drives an actual `python3 -m everwatch serve --demo` process
// (tests/e2e/real/backend.mjs) instead of the JS stand-in
// (tests/e2e/fixture-server.mjs) the rest of tests/e2e/ uses.
//
// A server is spawned per test (not per worker) via `app.start(opts)` /
// `app.open(opts)`, since some scenarios need a fixed CLI flag at launch
// time (`--demo-diagnostics <preset>`, a moving clock) that the JS fixture
// server can change on the fly but a real process can't. Every spawned
// server is stopped in fixture teardown, even on failure.
//
// Same console-error/CSP-violation contract as tests/e2e/fixtures.mjs:
// any unexpected console error fails the test.
import { test as base, expect } from '@playwright/test';
import { spawnBackend, apiClient, TOKEN, FIXED_CLOCK } from './backend.mjs';
import { U, NOW } from './golden.mjs';

export { U, NOW, FIXED_CLOCK };

export const test = base.extend({
  app: async ({ page }, use) => {
    const servers = [];
    const errors = [];
    const allowed = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !allowed.some((re) => re.test(msg.text()))) errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    let current = null;
    const app = {
      page,
      errors,
      allowErrors: (re) => allowed.push(re),
      /** Spawn a real backend without navigating to it. */
      async start(opts = {}) {
        const server = await spawnBackend(opts);
        servers.push(server);
        current = server;
        return server;
      },
      /** Spawn (unless `server` is passed) and navigate the page to it.
       * `onboardingDone`: the real demo scenario always seeds
       * `prefs.onboarding_done === false` (unlike the JS fixture, which
       * simply omits the key), so most tests that want the ordinary split
       * view rather than the onboarding wizard should pass `true` here;
       * it PATCHes /api/prefs before navigating. */
      async open({
        server = null, query = '', colorScheme, reducedMotion,
        waitReady = true, token = undefined, onboardingDone = false, ...spawnOpts
      } = {}) {
        const s = server || await this.start(spawnOpts);
        if (onboardingDone) await apiClient(s).patchPrefs({ onboarding_done: true });
        if (colorScheme || reducedMotion) {
          await page.emulateMedia({ ...(colorScheme ? { colorScheme } : {}), ...(reducedMotion ? { reducedMotion } : {}) });
        }
        const tok = token === undefined ? s.token : token;
        const frag = tok === null ? '' : `#t=${encodeURIComponent(tok)}`;
        await page.goto(`${s.url}/${query}${frag}`);
        if (waitReady) await expect(page.locator('body')).toHaveAttribute('data-ready', '1', { timeout: 10000 });
        return s;
      },
      get server() { return current; },
      api: (server = current, opts) => apiClient(server, opts),
      row: (tabLabel) => page.locator(`.content > :not([hidden]) .row[data-uid="${U[tabLabel]}"]`),
      rows: () => page.locator('.content > :not([hidden]) .row'),
      toasts: () => page.locator('#toasts .toast'),
      async press(key) { await page.keyboard.press(key); },
    };
    await use(app);
    for (const s of servers) await s.stop(); // always stop, even on failure
    expect(errors, 'no console errors / CSP violations').toEqual([]);
  },
});

export { expect, TOKEN };
