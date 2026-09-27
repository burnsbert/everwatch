// Design-review screenshots (headless, offscreen) for WP7's new surfaces:
// every onboarding wizard step, Settings, and Settings → Diagnostics. Not
// the README screenshots — those are WP10's `make screenshots`.
import { test, expect, FIXTURE } from './fixtures.mjs';

const OUT = 'build/preview';
const notDone = (extra = {}) => ({ ...FIXTURE, prefs: { ...FIXTURE.prefs, onboarding_done: false }, ...extra });

for (const scheme of ['dark', 'light']) {
  test(`preview screenshots wp7 onboarding — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce', shell: true, fixture: notDone() });

    await expect(page.locator('[data-step="welcome"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-welcome-${scheme}.png` });

    await page.getByRole('button', { name: 'Next', exact: true }).click(); // welcome has no pass/fail state of its own
    await expect(page.locator('[data-step="iterm"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-iterm-${scheme}.png` });

    // Default fixture's iTerm2 checks are already ok -> iterm is "done".
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('[data-step="automation"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-automation-${scheme}.png` });

    app.backend.patchCheck('automation', {
      status: 'error',
      detail: 'Everwatch needs permission to control iTerm2.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
    });
    await expect(page.locator('[data-step="automation"] .ob-guide')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-automation-denied-${scheme}.png` });

    app.backend.patchCheck('automation', { status: 'ok', detail: 'Everwatch can already control iTerm2.', action: null });
    app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed.', action: { kind: 'endpoint', label: 'Enable tab colors', method: 'POST', path: '/api/colors/install' } });
    app.backend.patchCheck('notifications', { status: 'info', detail: 'Allow notifications to hear about a waiting session.', action: { kind: 'request_notifications', label: 'Allow notifications' } });
    // Automation is "ok" again (patched above) -> automation is "done".
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.locator('[data-step="extras"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-extras-${scheme}.png` });

    await page.getByRole('button', { name: 'Skip' }).click(); // extras are optional, never "done"
    await expect(page.locator('[data-step="done"]')).toBeVisible();
    await page.screenshot({ path: `${OUT}/onboarding-done-${scheme}.png` });
  });

  test(`preview screenshots wp7 settings + diagnostics — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce', shell: true });

    await app.press('Meta+,');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'settings');
    await page.screenshot({ path: `${OUT}/settings-${scheme}.png` });

    // permission_denied (not not_running): the diagnostics screenshot below
    // shows the automation check denied, which only happens once Everwatch
    // has actually queried a *running* iTerm2 and been refused -- so the
    // status chip needs to agree ("No permission", not "iTerm2 not
    // running") rather than claiming iTerm2 isn't running at all.
    app.backend.setState({ iterm: { status: 'permission_denied', error: '', snapshot_at: 0 } });
    await page.getByRole('button', { name: 'Back to sessions' }).click();
    // The status chip must agree with the automation check the diagnostics
    // screenshot below shows denied -- not claim iTerm2 isn't running.
    await expect(page.locator('#status-text')).toHaveText('No permission');
    await page.locator('#status-chip').click();
    await page.locator('#status-diagnose').click();
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
    app.backend.patchCheck('automation', { status: 'error', detail: 'Everwatch needs permission to control iTerm2.', action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' } });
    app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed.', action: { kind: 'endpoint', label: 'Enable tab colors', method: 'POST', path: '/api/colors/install' } });
    await page.screenshot({ path: `${OUT}/diagnostics-${scheme}.png` });
  });
}
