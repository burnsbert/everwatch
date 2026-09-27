// Settings (docs/DESIGN.md §4.2): Appearance, Notifications, Sound,
// Hotkeys, Display, Projects, Data, About.
import { test, expect } from './fixtures.mjs';

async function openSettings(app, page, opts) {
  await app.open(opts);
  await app.press('Meta+,');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'settings');
}

test('toolbar Settings button opens the page, and its visible back button returns to sessions', async ({ app, page }) => {
  await app.open();
  const settingsButton = page.getByRole('button', { name: 'Settings' });
  await expect(settingsButton).toHaveAttribute('data-tip', 'Settings  ⌘,');
  await settingsButton.click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'settings');
  const back = page.getByRole('button', { name: 'Back to sessions' });
  await expect(back).toHaveText('Back to Sessions');
  await back.click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

test('Settings: Appearance segmented control sets the theme instantly and posts appearance to the shell', async ({ app, page }) => {
  await openSettings(app, page, { shell: true });
  const seg = page.locator('.settings-theme-seg');
  await expect(seg.locator('button[aria-checked="true"]')).toHaveText('System');
  await seg.getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'appearance').map((m) => m.theme)).toContain('dark');
  await expect.poll(() => app.backend.state.prefs.theme).toBe('dark');
});

test('Settings: session font and size change session names and persist', async ({ app, page }) => {
  await openSettings(app, page);
  await page.getByRole('combobox', { name: 'Session font', exact: true }).selectOption('mono');
  await page.getByRole('combobox', { name: 'Session font size' }).selectOption('18');
  await expect.poll(() => app.backend.state.prefs.session_font).toBe('mono');
  await expect.poll(() => app.backend.state.prefs.session_font_size).toBe(18);
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-session-font', 'mono');
  await expect(page.locator('.row-name').first()).toHaveCSS('font-size', '18px');
  await expect(page.locator('.row-name').first()).toHaveCSS('font-family', /monospace/);
});

test('Settings: Notifications toggle PATCHes notify_on_waiting; no toast (show/hide toggle), and browser-mode status/action come from the diagnostics check', async ({ app, page }) => {
  await openSettings(app, page);
  const row = page.locator('.settings-row--toggle', { hasText: 'Notify when a session is waiting' });
  await expect(row.locator('.toggle-input')).not.toBeChecked();
  await row.click();
  await expect.poll(() => app.backend.state.prefs.notify_on_waiting).toBe(true);
  const dock = page.locator('.settings-row--toggle', { hasText: 'Show waiting count on Dock icon' });
  await expect(dock.locator('.toggle-input')).not.toBeChecked();
  await dock.click();
  await expect.poll(() => app.backend.state.prefs.show_dock_badge).toBe(true);
  await expect.poll(() => app.backend.state.prefs.notify_on_waiting).toBe(true);
  await row.click();
  await expect.poll(() => app.backend.state.prefs.notify_on_waiting).toBe(false);
  await expect(dock.locator('.toggle-input')).toBeChecked();
  await expect(page.locator('#toasts .toast')).toHaveCount(0);
});

test('Settings: Notifications — shell mode merges nativeStatus (denied → Open System Settings; not_determined → Allow)', async ({ app, page }) => {
  await openSettings(app, page, { shell: true });
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', notifications: 'denied' }));
  await expect(page.getByRole('button', { name: 'Open System Settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'openSystemSettings')).toEqual([{ type: 'openSystemSettings', pane: 'notifications' }]);

  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', notifications: 'not_determined' }));
  await page.getByRole('button', { name: 'Allow notifications' }).click();
  await expect.poll(async () => (await app.posted()).some((m) => m.type === 'requestNotifications')).toBe(true);
});

test('Settings: Sound toggle is labelled off-by-default and toggles sound_on_attention only', async ({ app, page }) => {
  await openSettings(app, page);
  const row = page.locator('.settings-row', { hasText: 'Sound on attention' });
  await expect(row).toContainText('Off by default');
  await expect(row.locator('.toggle-input')).not.toBeChecked();
  await row.click();
  await expect.poll(() => app.backend.state.prefs.sound_on_attention).toBe(true);
});

test('Settings: Hotkeys — browser mode explains they need the app; no recorder claims are made', async ({ app, page }) => {
  await openSettings(app, page); // browser mode (no shell)
  await expect(page.locator('text=Hotkeys need the Everwatch app')).toBeVisible();
});

test('Settings: Hotkeys — shell mode shows the current combo and conflicts from nativeStatus, and the recorder sets a new one', async ({ app, page }) => {
  await openSettings(app, page, { shell: true });
  const showRow = page.locator('.settings-row--hotkey', { hasText: 'Show Everwatch' });
  await expect(showRow.locator('.hotkey-value')).toHaveText('⌥⌘E');

  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', hotkeys: { show: 'conflict', next: 'ok' } }));
  await expect(showRow.locator('.hotkey-status')).toHaveText('Conflicts with another app');

  // §4.15: one recorder field (the old "Record…" / value / "Clear" trio)
  await showRow.getByRole('button', { name: /^Record shortcut for Show Everwatch, currently ⌥⌘E$/ }).click();
  await showRow.getByRole('button', { name: /Press keys/ }).press('Control+Shift+k');
  await expect.poll(() => app.backend.state.prefs.hotkey_show).toBe('ctrl+shift+k');
  await expect.poll(async () => (await app.posted()).some((m) => m.type === 'setHotkeys' && m.show === 'ctrl+shift+k')).toBe(true);

  await showRow.getByRole('button', { name: 'Clear shortcut for Show Everwatch' }).click();
  await expect.poll(() => app.backend.state.prefs.hotkey_show).toBe('');
  await expect(showRow.locator('.hotkey-value')).toHaveText('Record Shortcut');
  await expect(showRow.getByRole('button', { name: /^Clear shortcut/ })).toBeHidden();
});

test('Settings: Display toggles hints, dollars, and the debug rule chip', async ({ app, page }) => {
  await openSettings(app, page);
  await page.locator('.settings-row', { hasText: 'Show keyboard hints' }).click();
  await expect.poll(() => app.backend.state.prefs.show_hints).toBe(false);
  await page.locator('.settings-row', { hasText: 'Show dollar amounts' }).click();
  await expect.poll(() => app.backend.state.prefs.show_dollars).toBe(true);
  await page.locator('.settings-row', { hasText: 'Show matched rule' }).click();
  await expect.poll(() => app.backend.state.debug_state).toBe(true);
  await page.locator('.settings-row', { hasText: 'Show activity strip on sessions' }).click();
  await expect.poll(() => app.backend.state.prefs.show_row_activity).toBe(true);
});

test('Settings: Projects → Clear project names opens the same confirmation as "c"', async ({ app, page }) => {
  await openSettings(app, page);
  await page.getByRole('button', { name: 'Clear project names…' }).click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.locator('#confirm-ok').click();
  await expect.poll(() => app.callsTo('DELETE', /\/api\/projects$/).length).toBe(1);
});

test('Settings: Data — Import from ultrawatch mirrors the diagnostics check, and the log path has a copy button', async ({ app, page }) => {
  await openSettings(app, page);
  await expect(page.locator('text=No ultrawatch state.json was found.')).toBeVisible();
  app.backend.patchCheck('ultrawatch_import', { status: 'info', detail: 'Found one.', action: { kind: 'endpoint', label: 'Import labels & projects', method: 'POST', path: '/api/import/ultrawatch' } });
  await page.getByRole('button', { name: 'Import labels & projects' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/import\/ultrawatch$/).length).toBe(1);

  const copy = page.locator('.settings-row', { hasText: 'Logs' }).locator('button');
  await expect(copy).toHaveText('Copy Path');
  await copy.click();
  await expect(copy).toHaveText('Copied!');
});

test('Settings: About shows the running version, links to GitHub/license/releases, and Back returns to sessions', async ({ app, page }) => {
  await openSettings(app, page, { shell: true });
  await expect(page.locator('.about-version')).toHaveText(/\d/);
  await expect(page.locator('.about-shell-version')).toContainText('app 0.1.0');
  await expect(page.getByRole('link', { name: 'GitHub repo' })).toHaveAttribute('href', /github\.com\/burnsbert\/everwatch$/);
  await expect(page.getByRole('link', { name: 'License (MIT)' })).toHaveAttribute('href', /LICENSE$/);
  await expect(page.getByRole('link', { name: 'Check for updates' })).toHaveAttribute('href', /\/releases$/);
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});
