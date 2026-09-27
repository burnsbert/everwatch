// Settings → Diagnostics (docs/DESIGN.md §4.2, build/wp7-handoff.md): all
// 13 checks as a list with status pills, action buttons per action kind,
// "Check again", and nativeStatus merging for notifications/hotkeys/
// automation. Reached the same way existing tests already reach it (the
// status-chip popover's "Diagnose…" button), since that's the one
// established entry point besides the empty-page actions (chrome.spec.mjs,
// header.spec.mjs already cover those).
import { test, expect } from './fixtures.mjs';

async function openDiagnostics(app, page, opts) {
  await app.open(opts);
  await page.locator('#status-chip').click();
  await page.locator('#status-diagnose').click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
}

test('Diagnostics: GET /api/diagnostics fires on mount, all 13 checks render in order with a status pill each', async ({ app, page }) => {
  await openDiagnostics(app, page);
  await expect.poll(() => app.callsTo('GET', /\/api\/diagnostics$/).length).toBe(1);
  const rows = page.locator('.check-row');
  await expect(rows).toHaveCount(13);
  await expect(rows.nth(0)).toHaveAttribute('data-id', 'python_version');
  await expect(rows.nth(3)).toHaveAttribute('data-id', 'automation');
  await expect(rows.nth(12)).toHaveAttribute('data-id', 'ultrawatch_import');
  await expect(page.locator('.diag-summary')).toHaveText('All 13 checks look good');
});

test('Diagnostics: a warn/error check is reflected in the summary and the row\'s data-status/action button', async ({ app, page }) => {
  await openDiagnostics(app, page);
  app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed.', action: { kind: 'endpoint', label: 'Enable tab colors', method: 'POST', path: '/api/colors/install' } });
  app.backend.patchCheck('automation', { status: 'error', detail: 'denied', action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' } });
  await expect(page.locator('.diag-summary')).toHaveText('2 of 13 need attention');
  const tabColors = page.locator('.check-row[data-id="tab_colors"]');
  await expect(tabColors).toHaveAttribute('data-status', 'warn');
  await tabColors.getByRole('button', { name: 'Enable tab colors' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/colors\/install$/).length).toBe(1);
});

test('Diagnostics: every action kind renders the right control (link/command/endpoint/copy)', async ({ app, page }) => {
  await openDiagnostics(app, page);
  app.backend.patchCheck('iterm_installed', { status: 'error', detail: 'not found', action: { kind: 'link', label: 'Get iTerm2', url: 'https://iterm2.com/downloads.html' } });
  app.backend.patchCheck('python_version', { status: 'error', detail: 'too old', action: { kind: 'command', label: 'Copy install command', command: 'brew install python' } });
  app.backend.patchCheck('quota_email', { status: 'info', detail: 'not configured', action: { kind: 'copy', label: 'Copy example config', text: '{"enabled": true}' } });

  const link = page.locator('.check-row[data-id="iterm_installed"] a');
  await expect(link).toHaveText('Get iTerm2');
  await expect(link).toHaveAttribute('href', 'https://iterm2.com/downloads.html');

  const cmdBtn = page.locator('.check-row[data-id="python_version"] button');
  await expect(cmdBtn).toHaveText('Copy install command');
  await cmdBtn.click();
  await expect(cmdBtn).toHaveText('Copied!');

  const copyBtn = page.locator('.check-row[data-id="quota_email"] button');
  await expect(copyBtn).toHaveText('Copy example config');
  await copyBtn.click();
  await expect(copyBtn).toHaveText('Copied!');
});

test('Diagnostics: backtick spans in a detail render as <code> elements, never literal backticks or HTML', async ({ app, page }) => {
  await openDiagnostics(app, page);
  app.backend.patchCheck('tab_colors', { status: 'warn', detail: 'The optional `iterm2` Python package is not installed. Run `<b>pip</b>`.', action: null });
  const detail = page.locator('.check-row[data-id="tab_colors"] .check-detail');
  await expect(detail).toHaveText('The optional iterm2 Python package is not installed. Run <b>pip</b>.');
  await expect(detail.locator('code')).toHaveText(['iterm2', '<b>pip</b>']);
  await expect(detail.locator('b')).toHaveCount(0);
});

test('Diagnostics: one grouped list with a status icon per row and the status word kept for screen readers', async ({ app, page }) => {
  await openDiagnostics(app, page);
  app.backend.patchCheck('automation', { status: 'error', detail: 'denied', action: null });
  await expect(page.locator('.check-list.settings-group')).toHaveCount(1);
  const row = page.locator('.check-row[data-id="automation"]');
  await expect(row.locator('.check-icon use')).toHaveAttribute('href', '#i-x-circle');
  await expect(row.locator('.check-status-text')).toHaveText('Problem');
  await expect(page.locator('.check-row[data-id="python_version"] .check-icon use')).toHaveAttribute('href', '#i-check-circle');
});

test('Diagnostics: "Check again" calls POST /api/diagnostics/recheck', async ({ app, page }) => {
  await openDiagnostics(app, page);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/diagnostics\/recheck$/).length).toBe(1);
});

test('Diagnostics: shell mode merges nativeStatus into automation/notifications/hotkeys; the backend\'s own text wins in browser mode', async ({ app, page }) => {
  await openDiagnostics(app, page); // browser mode
  await expect(page.locator('.check-row[data-id="notifications"] .check-detail')).toHaveText("Notifications aren't available in browser mode.");
});

test('Diagnostics: shell mode — nativeStatus.automation "granted" overrides the backend and clears the action', async ({ app, page }) => {
  await openDiagnostics(app, page, { shell: true });
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', automation: 'granted', notifications: 'authorized', hotkeys: { show: 'ok', next: 'ok' } }));
  const row = page.locator('.check-row[data-id="automation"]');
  await expect(row).toHaveAttribute('data-status', 'ok');
  await expect(row.locator('.check-detail')).toHaveText('Everwatch can already control iTerm2.');
  await expect(row.locator('button, a')).toHaveCount(0);
  await expect(page.locator('.check-row[data-id="notifications"]')).toHaveAttribute('data-status', 'ok');
  await expect(page.locator('.check-row[data-id="hotkeys"]')).toHaveAttribute('data-status', 'ok');
});

test('Diagnostics: shell mode — a backend ok is never downgraded by a stale nativeStatus.automation "not_determined"', async ({ app, page }) => {
  await openDiagnostics(app, page, { shell: true }); // fixture backend automation: ok
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'nativeStatus', automation: 'not_determined', notifications: 'authorized', hotkeys: { show: 'ok', next: 'ok' } }));
  await expect(page.locator('.check-row[data-id="notifications"]')).toHaveAttribute('data-status', 'ok'); // nativeStatus applied
  const row = page.locator('.check-row[data-id="automation"]');
  await expect(row).toHaveAttribute('data-status', 'ok');
  await expect(row.locator('.check-detail')).toHaveText('Everwatch can already control iTerm2.');
  await expect(row.getByRole('button', { name: 'Connect to iTerm2' })).toHaveCount(0);
});

test('Back to sessions returns to the main route', async ({ app, page }) => {
  await openDiagnostics(app, page);
  app.backend.setState({ iterm: { status: 'not_running', error: '', snapshot_at: 0 } }); // so main renders the empty state
  // Diagnostics agrees with the header: the live iTerm2 status drives its checks
  await expect(page.locator('.check-row[data-id="iterm_running"]')).toHaveAttribute('data-status', 'warn');
  await expect(page.locator('.diag-summary')).toHaveText('1 of 13 needs attention');
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'empty');
  app.backend.setState({ ...app.backend.state, iterm: { status: 'ok', error: '', snapshot_at: app.backend.state.now } });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});
