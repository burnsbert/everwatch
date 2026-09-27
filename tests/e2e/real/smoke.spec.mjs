// Real-backend smoke/golden suite (docs/DESIGN.md §7 WP9 row): exercises
// the actual `python3 -m everwatch serve --demo` process end to end —
// spawn handshake, real HTTP API, SSE-driven render, and on-disk prefs
// persistence — as a check that the JS-fixture suite (tests/e2e/*.spec.mjs)
// can't give: everything there talks to a JS stand-in server, never the
// real Python one.
import { test, expect, U, NOW } from './fixtures.mjs';
import { apiClient } from './backend.mjs';

// # parity: P-01
test('real backend: EVERWATCH_READY handshake, /api/state matches the golden demo fixture, rows render from it', async ({ app, page }) => {
  const server = await app.open({ onboardingDone: true });
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const client = apiClient(server);
  const { status, data } = await client.getState();
  expect(status).toBe(200);
  expect(data.now).toBe(NOW);
  expect(data.sessions).toHaveLength(9);
  expect(data.counts).toEqual({ tabs: 9, agents: 6, waiting: 2 });

  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(app.rows()).toHaveCount(9);
  const r = app.row('1.1');
  await expect(r.locator('.glyph')).toHaveClass(/glyph--waiting/);
  await expect(r.locator('.badge .badge-text')).toHaveText('Claude');
  await expect(r.locator('.row-tab')).toHaveText('1.1');
  await expect(r.locator('.row-name')).toHaveText('deploy-fix');
  await expect(app.row('2.1').locator('.badge .badge-text')).toHaveText('Codex');
});

// # parity: W-9
test('real backend: onboarding auto-opens (persisted onboarding_done: false), Next/Continue/Skip through every step, Get started persists via a real PATCH and survives reload', async ({ app, page }) => {
  const server = await app.open(); // no onboardingDone: true -> real seeded default
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'onboarding');
  await expect(page.locator('.ob-title').first()).toHaveText('Welcome to Everwatch');

  await page.getByRole('button', { name: 'Next', exact: true }).click(); // welcome has no pass/fail state of its own
  // The demo backend's default diagnostics preset is all-ok, so iTerm2 and
  // Automation are already "done" -> the nav button reads "Continue".
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // Extras reads "Continue" when every shown extra is already ok, "Skip"
  // otherwise -- and whether an ultrawatch import is offered depends on the
  // host's ~/.config/ultrawatch/state.json, so accept either here (the exact
  // rule is covered by tests/e2e/onboarding.spec.mjs against the fixture).
  const extrasNext = page.locator('.ob-nav').getByRole('button', { name: /^(Skip for Now|Continue)$/ });
  await expect(extrasNext).toBeVisible();
  await extrasNext.click();
  await expect(page.locator('[data-step="done"]')).toBeVisible();
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');

  const client = apiClient(server);
  const { data } = await client.getState();
  expect(data.prefs.onboarding_done).toBe(true);

  // reload the same real server (on-disk persistence, not an in-memory
  // JS mock) and confirm the wizard does not come back.
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1', { timeout: 10000 });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

// # parity: P-25
test('real backend: view navigation (grid, usage) renders real demo data', async ({ app, page }) => {
  await app.open({ onboardingDone: true });
  await app.press('Meta+3');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'grid');
  await expect(page.locator('.tile')).toHaveCount(6); // 6 agent sessions in the golden fixture

  await app.press('Meta+1');
  await app.press('u');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(page.locator('.usage-section', { hasText: 'Claude Code' })).toBeVisible();
});

// # parity: P-29
test('real backend: a page opened with no token gets the missing-token empty state, and a wrong token is rejected by the real API', async ({ app, page }) => {
  const server = await app.start();
  await page.goto(`${server.url}/`);
  await expect(page.locator('.empty-page .empty-title')).toHaveText('Missing access token');

  const wrong = apiClient(server, { token: 'not-the-token' });
  const { status } = await wrong.getState();
  expect(status).toBe(403);
});

// # parity: P-05
test('real backend: --demo-diagnostics permission_denied is reflected by the real /api/diagnostics endpoint', async ({ app, page }) => {
  const server = await app.start({ demoDiagnostics: 'permission_denied' });
  const client = apiClient(server);
  const { status, data } = await client.diagnostics();
  expect(status).toBe(200);
  const automation = data.checks.find((c) => c.id === 'automation');
  expect(automation.status).toBe('error');
});
