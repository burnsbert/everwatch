// Shared Playwright fixtures: a per-worker fixture backend and an `app`
// helper that opens the UI in browser mode (#t= token) or simulated shell
// mode (window.everwatchNative + a webkit.messageHandlers stub that records
// every bridge post). Console errors (including CSP violations) fail tests.

import { test as base, expect } from '@playwright/test';
import { startFixtureServer, loadFixture, TOKEN } from './fixture-server.mjs';

export const FIXTURE = loadFixture();
export const NOW_MS = FIXTURE.now * 1000;
export const U = FIXTURE.sessions.reduce((acc, s) => ({ ...acc, [s.tab_label]: s.uid }), {});

export const test = base.extend({
  backend: [async ({}, use) => { // eslint-disable-line no-empty-pattern
    const b = await startFixtureServer();
    await use(b);
    await b.close();
  }, { scope: 'worker' }],

  app: async ({ page, backend }, use) => {
    backend.reset();
    const errors = [];
    const allowed = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !allowed.some((re) => re.test(msg.text()))) errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(String(err)));

    const app = {
      page,
      backend,
      errors,
      /** Expected console noise for one test (e.g. a deliberately refused SSE connect). */
      allowErrors: (re) => allowed.push(re),
      async open({ fakeClock = true, shell = false, shellQueue = [], query = '', fixture = null, colorScheme, reducedMotion, pause = true, waitReady = true } = {}) {
        if (fixture) backend.reset(fixture);
        if (colorScheme || reducedMotion) await page.emulateMedia({ ...(colorScheme ? { colorScheme } : {}), ...(reducedMotion ? { reducedMotion } : {}) });
        if (shell) {
          await page.addInitScript(({ token, queue }) => {
            window.__posted = [];
            window.webkit = { messageHandlers: { everwatch: { postMessage: (m) => window.__posted.push(JSON.parse(JSON.stringify(m))) } } };
            window.everwatchNative = {
              shell: true, token, shellVersion: '0.1.0', queue: [...queue],
              dispatch(m) { this.queue.push(m); },
            };
          }, { token: TOKEN, queue: shellQueue });
        }
        const nowMs = (fixture?.now ?? backend.state.now) * 1000;
        if (fakeClock) await page.clock.install({ time: nowMs - 2000 });
        await page.goto(`${backend.url}/${query}${shell ? '' : `#t=${TOKEN}`}`);
        if (fakeClock && pause) await page.clock.pauseAt(nowMs);
        if (waitReady) await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
        return page;
      },
      row: (tabLabel) => page.locator(`.content > :not([hidden]) .row[data-uid="${U[tabLabel]}"]`),
      rows: () => page.locator('.content > :not([hidden]) .row'),
      toasts: () => page.locator('#toasts .toast'),
      async press(key) { await page.keyboard.press(key); },
      posted: () => page.evaluate(() => window.__posted),
      callsTo: (method, pathRe) => backend.calls.filter((c) => c.method === method && pathRe.test(c.path)),
    };
    await use(app);
    expect(errors, 'no console errors / CSP violations').toEqual([]);
  },
});

export { expect };
