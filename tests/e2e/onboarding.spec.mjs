// First-run onboarding wizard (docs/DESIGN.md §4.2). Routed to automatically
// once per page load when `prefs.onboarding_done === false` (main.mjs).
import { test, expect, FIXTURE } from './fixtures.mjs';

const notDone = (extra = {}) => ({ ...FIXTURE, prefs: { ...FIXTURE.prefs, onboarding_done: false }, ...extra });

// # parity: W-9
test('onboarding: auto-opens when onboarding_done is false, and never opens when the key is simply absent', async ({ app, page }) => {
  await app.open({ fixture: notDone() });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'onboarding');
  await expect(page.locator('.ob-title').first()).toHaveText('Welcome to Everwatch');
  await expect(page.locator('.ob-progress-text')).toHaveText('Step 1 of 5 — Welcome');
});

// VISUAL_SPEC §4.15: first run hides the main toolbar and status bar (like
// compact mode) and the card fills the window.
test('onboarding: the toolbar and status bar are hidden while the wizard is up, and come back after', async ({ app, page }) => {
  await app.open({ fixture: notDone() });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'onboarding');
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('.statusbar')).toBeHidden();
  const contentBox = await page.locator('.content').boundingBox();
  expect(contentBox.height).toBe(page.viewportSize().height);
  await expect(page.locator('.ob-progress .ob-seg')).toHaveCount(5);
  await expect(page.locator('.ob-progress .ob-seg.is-active')).toHaveCount(1);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Get started' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('.statusbar')).toBeVisible();
});

test('onboarding: the projects panel stays hidden even when projects_open is true, and its layout column collapses', async ({ app, page }) => {
  await app.open({ fixture: notDone({ prefs: { ...FIXTURE.prefs, onboarding_done: false, projects_open: true } }) });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'onboarding');
  await expect(page.locator('.proj-panel')).toBeHidden();
  // The panel is hidden, but on a non-main route its 240px reserved column
  // must collapse too -- otherwise content centres off-window (validator
  // finding: usage/onboarding content stuck in the left ~1040px instead of
  // spanning the full width).
  await expect(page.locator('#app')).not.toHaveClass(/projects-open/);
  const contentBox = await page.locator('.content').boundingBox();
  expect(contentBox.width).toBe(page.viewportSize().width);
});

test('onboarding: does not auto-open for existing fixtures that simply omit onboarding_done (no regression)', async ({ app, page }) => {
  await app.open(); // default FIXTURE has no onboarding_done key at all
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

test('onboarding: "Try demo mode" note reflects server.mode; Next/Continue/Skip walks every step; Get started finishes and returns to sessions', async ({ app, page }) => {
  await app.open({ fixture: notDone({ mode: 'real' }) });
  await expect(page.locator('.ob-demo-box')).toBeVisible();
  await expect(page.locator('.ob-demo-box code')).toHaveText('everwatch demo');

  await expect(page.locator('[data-step="welcome"]')).toBeVisible();
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // welcome advances, it has no pass/fail state
  await expect(page.locator('[data-step="iterm"]')).toBeVisible();
  await expect(page.locator('.ob-progress-text')).toHaveText('Step 2 of 5 — iTerm2');
  // The default fixture's diagnostics are all-ok, so iTerm2/Automation are
  // already done -- the button reads "Continue", not "Skip".
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-step="automation"]')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-step="extras"]')).toBeVisible();
  // Browser mode + all-ok fixture: every shown extra (just tab colors) is
  // already ok, so extras reads "Continue" too.
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-step="done"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Get started' })).toBeVisible();
  await expect(page.locator('.ob-tips li')).toHaveText([/next waiting/, /command palette/, /zooms/]);

  await page.getByRole('button', { name: 'Get started' }).click();
  await expect.poll(() => app.backend.state.prefs.onboarding_done).toBe(true);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

test('onboarding: Back returns to the previous step and is hidden on the first step', async ({ app, page }) => {
  await app.open({ fixture: notDone() });
  await expect(page.getByRole('button', { name: 'Back' })).toBeHidden();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const back = page.getByRole('button', { name: 'Back' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page.locator('[data-step="welcome"]')).toBeVisible();
});

test('onboarding: iTerm2 step surfaces the not-installed/not-running checks with their own action buttons', async ({ app, page }) => {
  await app.open({ fixture: notDone() });
  app.backend.patchCheck('iterm_installed', { status: 'error', detail: "iTerm2 wasn't found on this Mac.", action: { kind: 'link', label: 'Get iTerm2', url: 'https://iterm2.com/downloads.html' } });
  app.backend.patchCheck('iterm_running', { status: 'warn', detail: "iTerm2 isn't running. Everwatch keeps polling and recovers on its own once it starts.", action: { kind: 'endpoint', label: 'Launch iTerm2', method: 'POST', path: '/api/iterm/launch' } });
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const step = page.locator('[data-step="iterm"]');
  await expect(step.getByRole('link', { name: 'Get iTerm2' })).toHaveAttribute('href', 'https://iterm2.com/downloads.html');
  await step.getByRole('button', { name: 'Launch iTerm2' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/iterm\/launch$/).length).toBe(1);
});

// # parity: W-9
test('onboarding: Automation step — not-yet-known explanation, denied guide + Still stuck + tccutil copy, auto re-check stops once granted', async ({ app, page }) => {
  await app.open({ shell: true, fixture: notDone(), fakeClock: true });
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
  await page.getByRole('button', { name: 'Continue' }).click(); // default fixture's iTerm2 checks are already ok -> iterm is "done" -> automation
  const step = page.locator('[data-step="automation"]');
  await expect(step).toBeVisible();
  await expect(step.locator('.ob-callout')).toContainText('wants to control');

  app.backend.patchCheck('automation', {
    status: 'error',
    detail: 'Everwatch needs permission to control iTerm2.',
    action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
  });
  await expect(step.locator('.ob-guide')).toBeVisible();
  await expect(step.locator('.ob-guide li')).toHaveText([/Privacy & Security.*Automation/, 'Find Everwatch in the list', 'Turn on iTerm2']);
  await step.locator('.ob-stuck summary').click();
  await expect(step.locator('.ob-stuck-cmd code')).toHaveText('tccutil reset AppleEvents io.github.burnsbert.everwatch');
  await step.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'openSystemSettings')).toEqual([{ type: 'openSystemSettings', pane: 'automation' }]);

  // Auto re-check: while unresolved, the wizard polls /api/diagnostics/recheck.
  await page.clock.runFor(4100);
  const callsWhileDenied = app.callsTo('POST', /\/api\/diagnostics\/recheck$/).length;
  expect(callsWhileDenied).toBeGreaterThan(0);

  // Once granted, the guide disappears and polling stops (no further calls).
  app.backend.patchCheck('automation', { status: 'ok', detail: 'Everwatch can already control iTerm2.', action: null });
  await expect(step.locator('.ob-guide')).toBeHidden();
  await page.clock.runFor(8200);
  expect(app.callsTo('POST', /\/api\/diagnostics\/recheck$/).length).toBe(callsWhileDenied);
});

// Live report (v0.1.3): the backend's osascript already had working access
// (automation ok) but the shell's one-shot AEDeterminePermission probe had
// run before the user clicked OK and still said not_determined -- the step
// stuck on "Connect to iTerm2" and re-checked every few seconds forever.
test('onboarding: Automation step — backend ok + stale shell not_determined shows Connected and "Continue", and never polls', async ({ app, page }) => {
  await app.open({ shell: true, fixture: notDone(), fakeClock: true }); // fixture backend automation: ok
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', automation: 'not_determined', notifications: 'authorized', hotkeys: { show: 'ok', next: 'ok' } }));
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
  await page.getByRole('button', { name: 'Continue' }).click(); // -> automation
  const step = page.locator('[data-step="automation"]');
  await expect(step).toBeVisible();
  await expect(step.locator('.ob-card[data-kind="ok"]')).toBeVisible();
  await expect(step.locator('.ob-card[data-kind="ok"] .ob-card-title')).toHaveText('Connected');
  await expect(step.getByRole('button', { name: 'Connect to iTerm2' })).toHaveCount(0);
  await expect(step.locator('.ob-callout')).toBeHidden();
  await expect(page.locator('.ob-nav .btn--primary')).toHaveText('Continue');
  await page.clock.runFor(8200);
  expect(app.callsTo('POST', /\/api\/diagnostics\/recheck$/).length).toBe(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('[data-step="extras"]')).toBeVisible();
});

// Validator finding: the permission step's guide + illustration can be
// taller than the window, and the nav (Back/Skip/Continue) must stay
// reachable and fully visible instead of scrolling out and sitting partly
// under the status bar footer -- at the shell's window-minimum width too
// (shell/Sources/App/WebWindows.swift:129).
for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }, { width: 480, height: 700 }]) {
  test(`onboarding: nav stays fully visible above the footer on the (denied) permission step at ${viewport.width}x${viewport.height}`, async ({ app, page }) => {
    await page.setViewportSize(viewport);
    await app.open({ fixture: notDone() });
    await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
    await page.getByRole('button', { name: 'Continue' }).click(); // -> automation
    app.backend.patchCheck('automation', {
      status: 'error',
      detail: 'Everwatch needs permission to control iTerm2.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
    });
    await expect(page.locator('.ob-guide')).toBeVisible(); // the tall guide + illustration

    const nav = page.locator('.ob-nav');
    const navBox = await nav.boundingBox();
    // §4.15: the status bar is hidden during onboarding; the nav is the
    // card's own footer and must sit fully inside the window.
    await expect(page.locator('.statusbar')).toBeHidden();
    expect(navBox.y).toBeGreaterThanOrEqual(0);
    expect(navBox.y + navBox.height).toBeLessThanOrEqual(viewport.height);

    await page.getByRole('button', { name: 'Back' }).click(); // no force: fails if obscured
    await expect(page.locator('[data-step="iterm"]')).toBeVisible();
  });
}

// Validator finding: the nav's own bounding box stayed within the viewport
// (caught by the loop above), but the sticky nav still visually and
// functionally covered the denied step's primary "Open System Settings"
// button underneath it until the page was scrolled. Regression test: the
// button's box must not intersect .ob-nav, must sit inside the viewport,
// and must be clickable without {force: true} (which fails if .ob-nav
// intercepts the click).
for (const viewport of [{ width: 1024, height: 700 }, { width: 1280, height: 800 }]) {
  test(`onboarding: the denied step's "Open System Settings" button isn't covered by the sticky nav at ${viewport.width}x${viewport.height}`, async ({ app, page }) => {
    await page.setViewportSize(viewport);
    await app.open({ shell: true, fixture: notDone() });
    await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
    await page.getByRole('button', { name: 'Continue' }).click(); // -> automation
    app.backend.patchCheck('automation', {
      status: 'error',
      detail: 'Everwatch needs permission to control iTerm2.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
    });
    await expect(page.locator('.ob-guide')).toBeVisible();

    const settingsBtn = page.getByRole('button', { name: 'Open System Settings' });
    // Measure at the page's natural, un-scrolled rest position -- clicking
    // first would let Playwright's own actionability auto-scroll silently
    // work around the bug (it retries at different scroll offsets until the
    // click isn't intercepted), which is exactly the "scroll and it's fine"
    // behavior this regression test must not tolerate.
    const navBox = await page.locator('.ob-nav').boundingBox();
    const btnBox = await settingsBtn.boundingBox();
    expect(btnBox.y).toBeGreaterThanOrEqual(0);
    expect(btnBox.y + btnBox.height).toBeLessThanOrEqual(viewport.height);
    // >1px of overlap on both axes, not just touching/adjacent -- sub-pixel
    // layout rounding can put boxes a fraction of a pixel apart even when
    // they're genuinely not covering each other.
    const overlapY = Math.min(btnBox.y + btnBox.height, navBox.y + navBox.height) - Math.max(btnBox.y, navBox.y);
    const overlapX = Math.min(btnBox.x + btnBox.width, navBox.x + navBox.width) - Math.max(btnBox.x, navBox.x);
    expect(overlapY > 1 && overlapX > 1).toBe(false);

    await settingsBtn.click(); // no force: fails if the sticky nav intercepts the click
    await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'openSystemSettings'))
      .toEqual([{ type: 'openSystemSettings', pane: 'automation' }]);
  });
}

test('onboarding: extras step shows notifications/tab-colors cards and only shows ultrawatch import when there is something to import', async ({ app, page }) => {
  await app.open({ shell: true, fixture: notDone() });
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // welcome -> iterm
  await page.getByRole('button', { name: 'Continue' }).click(); // iterm (already ok) -> automation
  await page.getByRole('button', { name: 'Continue' }).click(); // automation (already ok) -> extras
  const step = page.locator('[data-step="extras"]');
  await expect(step).toBeVisible();
  await expect(page.locator('[data-kind="ultrawatch_import"]')).toBeHidden();

  app.backend.patchCheck('notifications', { status: 'info', detail: 'Allow notifications to hear about a waiting session.', action: { kind: 'request_notifications', label: 'Allow notifications' } });
  await step.getByRole('button', { name: 'Allow notifications' }).click();
  await expect.poll(async () => (await app.posted()).some((m) => m.type === 'requestNotifications')).toBe(true);

  app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed.', action: { kind: 'endpoint', label: 'Enable tab colors', method: 'POST', path: '/api/colors/install' } });
  await step.getByRole('button', { name: 'Enable tab colors' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/colors\/install$/).length).toBe(1);

  app.backend.patchCheck('ultrawatch_import', { status: 'info', detail: 'Found an ultrawatch state at ~/.config/ultrawatch/state.json.', action: { kind: 'endpoint', label: 'Import labels & projects', method: 'POST', path: '/api/import/ultrawatch' } });
  await expect(page.locator('[data-kind="ultrawatch_import"]')).toBeVisible();
  await page.locator('[data-kind="ultrawatch_import"]').getByRole('button', { name: 'Import labels & projects' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/import\/ultrawatch$/).length).toBe(1);
  await expect(app.toasts().last()).toContainText('Imported');
});

test('onboarding: extras reads "Skip" until an extra is acted on, then "Continue"', async ({ app, page }) => {
  await app.open({ shell: true, fixture: notDone() });
  app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed.', action: { kind: 'endpoint', label: 'Enable tab colors', method: 'POST', path: '/api/colors/install' } });
  app.backend.patchCheck('notifications', { status: 'info', detail: 'Allow notifications to hear about a waiting session.', action: { kind: 'request_notifications', label: 'Allow notifications' } });
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
  await page.getByRole('button', { name: 'Continue' }).click(); // -> automation
  await page.getByRole('button', { name: 'Continue' }).click(); // -> extras
  const step = page.locator('[data-step="extras"]');
  await expect(step).toBeVisible();
  const primary = page.locator('.ob-nav .btn--primary');
  const skip = page.locator('.ob-nav').getByRole('button', { name: 'Skip for Now' });
  // nothing ok, nothing done yet: a plain "Skip for Now", never a primary Skip
  await expect(skip).toBeVisible();
  await expect(skip).not.toHaveClass(/btn--primary/);
  await expect(primary).toBeHidden();

  await step.getByRole('button', { name: 'Enable tab colors' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/colors\/install$/).length).toBe(1);
  await expect(primary).toHaveText('Continue');
  await expect(skip).toBeHidden();
  await primary.click();
  await expect(page.locator('[data-step="done"]')).toBeVisible();

  // Going back keeps "Continue" (the user already acted on an extra).
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(primary).toHaveText('Continue');
});

test('onboarding: extras reads "Continue" when every shown extra is already ok, "Skip" when one is not', async ({ app, page }) => {
  await app.open({ shell: true, fixture: notDone() });
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', automation: 'granted', notifications: 'authorized', hotkeys: { show: 'ok', next: 'ok' } }));
  await page.getByRole('button', { name: 'Next', exact: true }).click(); // -> iterm
  await page.getByRole('button', { name: 'Continue' }).click(); // -> automation
  await page.getByRole('button', { name: 'Continue' }).click(); // -> extras
  await expect(page.locator('[data-step="extras"]')).toBeVisible();
  const primary = page.locator('.ob-nav .btn--primary');
  await expect(primary).toHaveText('Continue'); // notifications authorized + tab colors ok; no import offered

  app.backend.patchCheck('ultrawatch_import', { status: 'info', detail: 'Found an ultrawatch state at ~/.config/ultrawatch/state.json.', action: { kind: 'endpoint', label: 'Import labels & projects', method: 'POST', path: '/api/import/ultrawatch' } });
  await expect(page.locator('[data-kind="ultrawatch_import"]')).toBeVisible();
  // an offered import isn't "ok" until it's done
  await expect(page.locator('.ob-nav').getByRole('button', { name: 'Skip for Now' })).toBeVisible();
  await expect(primary).toBeHidden();
});

test('onboarding: nav button reads "Continue" on a step that already passes, "Skip" on one that does not', async ({ app, page }) => {
  await app.open({ fixture: notDone() }); // default fixture's diagnostics are all-ok
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeVisible(); // welcome: never "done"
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('[data-step="iterm"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible(); // iTerm2 checks already pass

  app.backend.patchCheck('iterm_running', { status: 'warn', detail: "iTerm2 isn't running.", action: null });
  await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible(); // no longer done
});

test('onboarding: reachable any time from Settings via "Run setup again", even after onboarding_done is already true', async ({ app, page }) => {
  await app.open(); // default fixture: onboarding_done absent -> treated as already done
  await app.press('Meta+,');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'settings');
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'onboarding');
});
