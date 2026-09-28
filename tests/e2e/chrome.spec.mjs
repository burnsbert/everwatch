import { test, expect, FIXTURE, U } from './fixtures.mjs';

const NOW = FIXTURE.now;
const emptyState = (iterm, extra = {}) => ({ iterm, sessions: [], counts: { tabs: 0, agents: 0, waiting: 0 }, waiting_order: [], ...extra });

// # parity: P-29
test('P-29 empty states: not running (Launch iTerm2), query failed (Retry), connecting, no sessions (New tab)', async ({ app, page }) => {
  await app.open();
  const card = page.locator('.empty-page .empty-card');

  app.backend.setState(emptyState({ status: 'not_running', error: '', snapshot_at: 0 }));
  await expect(card.locator('.empty-title')).toHaveText('iTerm2 isn’t running');
  await card.getByRole('button', { name: 'Launch iTerm2' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/iterm\/launch$/).length).toBe(1);
  await expect(app.toasts().last()).toHaveText('launching iTerm2…');
  await card.getByRole('button', { name: 'Diagnose…' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
  await page.getByRole('button', { name: 'Back to sessions' }).click();

  app.backend.setState(emptyState({ status: 'error', error: 'execution error: iTerm got an error (-1712)', snapshot_at: NOW - 1 }));
  await expect(card.locator('.empty-title')).toHaveText('iTerm2 query failed');
  await expect(card.locator('.empty-detail')).toHaveText('execution error: iTerm got an error (-1712)');
  await card.getByRole('button', { name: 'Retry now' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/refresh$/).length).toBe(1);

  app.backend.setState(emptyState({ status: 'connecting', error: '', snapshot_at: 0 }));
  await expect(card.locator('.empty-title')).toHaveText('Connecting to iTerm2…');

  app.backend.setState(emptyState({ status: 'ok', error: '', snapshot_at: NOW }));
  await expect(card.locator('.empty-title')).toHaveText('No sessions yet');
  await card.getByRole('button', { name: 'New iTerm2 tab' }).click();
  await expect.poll(() => app.callsTo('POST', /\/api\/tabs\/new$/).length).toBe(1);

  // sessions come back → the list returns
  app.backend.setState({ ...FIXTURE, screens: undefined });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(app.rows()).toHaveCount(9);
});

// # parity: P-29
test('P-29 permission denied: steps plus Open System Settings (shell bridge in the app, guidance in the browser)', async ({ app, page }) => {
  await app.open({ shell: true });
  app.backend.setState(emptyState({ status: 'permission_denied', error: '(-1743)', snapshot_at: 0 }));
  const card = page.locator('.empty-page .empty-card');
  await expect(card.locator('.empty-title')).toHaveText('Everwatch can’t talk to iTerm2');
  await expect(card.locator('.empty-steps li')).toHaveText([/Privacy & Security → Automation/, 'Find Everwatch in the list', 'Turn on iTerm2']);
  await card.getByRole('button', { name: 'Open System Settings' }).click();
  await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'openSystemSettings')).toEqual([{ type: 'openSystemSettings', pane: 'automation' }]);
  await expect(page.locator('#status-chip')).toHaveText('No permission');
});

// # parity: P-29
test('P-29 a page opened without a token explains how to get one', async ({ page, backend }) => {
  backend.reset();
  await page.goto(`${backend.url}/`);
  await expect(page.locator('.empty-page .empty-title')).toHaveText('Missing access token');
});

// # parity: P-30
test('P-30 ? opens a shortcut sheet generated from the keymap; any key closes it; ⌘/ too', async ({ app, page }) => {
  await app.open();
  await app.press('?');
  const sheet = page.locator('#help');
  await expect(sheet).toBeVisible();
  // D2: the footer's glyph legend moved here, as a new first "Status" row.
  await expect(sheet.locator('.help-section h3')).toHaveText(['Status', 'Navigate', 'Act', 'View', 'System']);
  await expect(sheet.locator('.help-section--status .legend-item')).toHaveText(['waiting', 'busy', 'idle', 'output']);
  const statusLayout = await sheet.locator('.help-legend').evaluate((legend) => ({
    items: [...legend.querySelectorAll('.legend-item')].map((item) => {
      const box = item.getBoundingClientRect();
      const glyph = item.querySelector('.glyph').getBoundingClientRect();
      return { x: box.x, y: box.y, glyphWidth: glyph.width };
    }),
  }));
  expect(statusLayout.items.every((item) => item.glyphWidth >= 10)).toBe(true);
  expect(statusLayout.items.every((item) => item.x === statusLayout.items[0].x)).toBe(true);
  expect(statusLayout.items.every((item, index) => index === 0 || item.y > statusLayout.items[index - 1].y)).toBe(true);
  const item = sheet.locator('.help-item[data-command="waiting.next"]');
  await expect(item.locator('dd')).toHaveText('Next waiting session');
  await expect(item.locator('kbd')).toHaveText(['a']);
  await expect(sheet.locator('.help-item[data-command="session.goto"] kbd')).toHaveText(['⏎', 'g', '⌘⏎']);
  await expect(sheet.locator('.help-item[data-command="palette.open"] kbd')).toHaveText(['⌘K', '⌃K']); // also Ctrl+K in browser mode (W-3)
  await app.press('x'); // any key closes, and doesn't act
  await expect(sheet).toBeHidden();
  expect(app.callsTo('POST', /close$/)).toEqual([]);
  await app.press('Meta+/');
  await expect(sheet).toBeVisible();
  await app.press('Escape');
  await expect(sheet).toBeHidden();
  await page.locator('#btn-help').click();
  await expect(sheet).toBeVisible();
  await app.press('q');
  await expect(sheet).toBeHidden();
});

// # parity: P-31
test('P-31 filter chip, stacked toasts in a live region that dismiss after 3.5 s (§4.13); the legend moved to the help sheet (D2)', async ({ app, page }) => {
  await app.open();
  // D2: no glyph legend in the status bar any more (it's the help sheet's
  // first "Status" row and the glyph tooltips)
  await expect(page.locator('#legend')).toHaveCount(0);
  await expect(page.locator('#statusbar')).not.toContainText(/waiting\s*busy\s*idle\s*output/);
  await expect(page.locator('#toasts')).toHaveAttribute('aria-live', 'polite');
  await expect(page.locator('#toasts')).toHaveAttribute('role', 'status');
  await app.press('r');
  await app.press('s');
  await expect(app.toasts()).toHaveText(['refreshing…', 'sort: agents']);
  await page.clock.runFor(3400);
  await expect(app.toasts()).toHaveCount(2); // not yet 3.5 s
  await page.clock.runFor(200);
  await expect(app.toasts()).toHaveCount(0); // past 3.5 s, both gone (old behavior: 5 s, still 2 here)
  // clicking a toast dismisses it early
  await app.press('q');
  await app.toasts().first().click();
  await expect(app.toasts()).toHaveCount(0);
  // filter chip
  await app.press('/');
  await page.keyboard.type('pay');
  await app.press('Enter');
  await expect(page.locator('#filter-chip')).toHaveText('filter: pay');
  // neutral, not amber (amber means a session is waiting)
  await expect(page.locator('#filter-chip')).not.toHaveCSS('color', 'rgb(255, 175, 0)');
  await page.locator('#filter-chip').click();
  await expect(page.locator('#filter-chip')).toBeHidden();
  await expect(app.rows()).toHaveCount(9);
});

// # parity: §4.13 (WCAG 2.2.1)
test('a toast\'s dismiss timer pauses while hovered or focused, and restarts (not resumes) on leave', async ({ app, page }) => {
  await app.open();
  await app.press('r'); // 'refreshing…' toast
  const toast = app.toasts().last();
  await expect(toast).toBeVisible();
  await toast.hover();
  await page.clock.runFor(5000); // well past 3.5 s, but paused: still there
  await expect(toast).toBeVisible();
  await page.mouse.move(0, 0); // leave: restarts the full 3.5 s, doesn't resume a near-zero remainder
  await page.clock.runFor(3400);
  await expect(toast).toBeVisible();
  await page.clock.runFor(200);
  await expect(app.toasts()).toHaveCount(0);
});

// # parity: P-32
test('P-32 context hint bar changes with context and can be hidden', async ({ app, page }) => {
  await app.open();
  await page.setViewportSize({ width: 1600, height: 800 }); // room for the hints beside the Tokens Used strip
  const hints = page.locator('#hints');
  // D2: a 4-hint subset; the full list is the help sheet
  await expect(hints.locator('.hint-label')).toHaveText(['go to', 'next ◉', 'filter', 'commands']);
  await expect(hints.locator('kbd')).toHaveText(['⏎', 'a', '/', '⌘K']);
  await app.press('/');
  await expect(hints).toHaveAttribute('data-context', 'filter');
  await expect(hints.locator('.hint-label')).toHaveText(['keep', 'clear', 'move']);
  await app.press('Escape');
  await app.press('Space');
  await expect(hints.locator('.hint-label')).toHaveText(['move', 'back']);
  await app.press('Escape');
  await app.press('Meta+3');
  await expect(hints).toHaveAttribute('data-context', 'grid');
  await expect(hints.locator('.hint-label')).toHaveText(['go to', 'next ◉', 'filter', 'commands']);
  await app.press('Meta+1');
  app.backend.setState((s) => ({ prefs: { ...s.prefs, show_hints: false } }));
  await expect(hints).toBeHidden();
});

// # parity: P-33, P-67
test('P-33 toast texts match ultrawatch', async ({ app, page }) => {
  await app.open();
  const last = () => app.toasts().last();
  app.backend.emit('transition', { uid: U['2.1'], from: 'busy', to: 'waiting', at: NOW, title: 'terraform-modules' });
  await expect(last()).toHaveText('◉ terraform-modules is waiting for your input');
  await app.press('g');
  await expect(last()).toHaveText('→ tab 1.1');
  await app.press('r');
  await expect(last()).toHaveText('refreshing…');
  await app.press('s');
  await expect(last()).toHaveText('sort: agents');
  await app.press('>');
  await expect(last()).toHaveText('list pane 47% of width');
  await app.press('n');
  await expect(last()).toHaveText('opening new tab…');
  await expect.poll(() => app.callsTo('POST', /\/api\/tabs\/new$/).length).toBe(1);
  // §4.13: show/hide/on-off toggles never toast — 'b' and '$' change prefs
  // silently; the last toast is still the one from 'n' above.
  await app.press('b');
  await expect.poll(() => app.backend.state.prefs.sound_on_attention).toBe(true);
  await expect(last()).toHaveText('opening new tab…');
  await app.press('$');
  await expect.poll(() => app.backend.state.prefs.show_dollars).toBe(true);
  await expect(last()).toHaveText('opening new tab…');
  app.backend.emit('action_result', { id: 'x', kind: 'new', ok: false, detail: 'no current window' });
  await expect(last()).toHaveText('new failed: no current window');
  app.backend.emit('toast', { message: 'projects cleared', level: 'info' });
  await expect(last()).toHaveText('projects cleared');
});

test('shell mode: token from everwatchNative, ready + appearance posts, queued messages drained, notification click selects', async ({ app, page }) => {
  // messages the shell dispatched before the page installed its handler
  await app.open({ shell: true, shellQueue: [{ type: 'focus', key: false }, { type: 'notificationClicked', uid: U['2.1'] }] });
  await expect(app.row('2.1')).toHaveClass(/is-selected/);
  expect(await page.evaluate(() => window.everwatchNative.queue.length)).toBe(0);
  const posted = await app.posted();
  expect(posted.map((m) => m.type)).toContain('ready');
  expect(posted).toContainEqual({ type: 'appearance', theme: 'system' });
  await expect(page.locator('html')).toHaveAttribute('data-shell', '1');
  expect(page.url()).not.toContain('#t=');
  await page.evaluate((uid) => window.everwatchNative.dispatch({ type: 'notificationClicked', uid }), U['2.2']);
  await expect(app.row('2.2')).toHaveClass(/is-selected/);
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'openSettings' }));
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'settings');
  await app.press('Escape');
  await app.press('Meta+\\');
  await expect.poll(async () => (await app.posted()).some((m) => m.type === 'openCompact')).toBe(true);
  // no bridge message can make sound
  expect((await app.posted()).every((m) => !/sound|beep|play/i.test(JSON.stringify(m)))).toBe(true);
});

test('browser mode: #t= token moves to sessionStorage and leaves the URL', async ({ app, page }) => {
  await app.open();
  expect(page.url()).not.toContain('#t=');
  expect(await page.evaluate(() => sessionStorage.getItem('everwatch.token'))).toBe('test');
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await app.press('Meta+\\');
  await expect(app.toasts().last()).toContainText('Compact mode needs the Everwatch app');
});

test('theme: follows the system, or a forced dark/light pref, and tells the shell', async ({ app, page }) => {
  await app.open({ shell: true, colorScheme: 'light' });
  const bgOf = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  expect(await bgOf()).toBe('rgb(168, 168, 184)');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(bgOf).toBe('rgb(21, 21, 23)');
  app.backend.setState((s) => ({ prefs: { ...s.prefs, theme: 'light' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(bgOf).toBe('rgb(168, 168, 184)');
  await expect.poll(async () => (await app.posted()).filter((m) => m.type === 'appearance').map((m) => m.theme)).toEqual(['system', 'light']);
  app.backend.setState((s) => ({ prefs: { ...s.prefs, theme: 'dark' } }));
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(bgOf).toBe('rgb(21, 21, 23)');
});

// T046: "there needs to be an obvious light mode / dark mode toggle" — a
// toolbar button switching between Light and Dark, persisted and synced
// with Settings' own Appearance control, no toast (its own icon is the
// feedback), reachable by `t` and from the command palette.
test('T046 toolbar theme toggle: icon shows destination, persists, synced with Settings and `t` key', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.open({ shell: true });
  const btn = page.locator('#btn-theme');
  const use = () => btn.locator('use').getAttribute('href');
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./); // starts at system
  await expect(use()).resolves.toBe('#i-theme-moon');
  await expect(btn).toHaveAttribute('data-tip', /^Switch to Dark mode/);
  await expect(page.locator('.toolbar-buttons > button').last()).toHaveAttribute('id', 'btn-settings');
  await expect(page.locator('.toolbar-buttons > button').nth(-2)).toHaveAttribute('id', 'btn-theme');

  await btn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(use()).resolves.toBe('#i-theme-sun');
  await expect(btn).toHaveAttribute('data-tip', /^Switch to Light mode/);
  await expect.poll(() => app.backend.state.prefs.theme).toBe('dark');
  // Settings' own segmented control agrees
  await app.press('Meta+,');
  await expect(page.locator('.settings-theme-seg button[aria-checked="true"]')).toHaveText('Dark');
  await app.press('Escape');

  await btn.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(use()).resolves.toBe('#i-theme-moon');
  await expect.poll(() => app.backend.state.prefs.theme).toBe('light');

  // `t` switches it too.
  await app.press('t');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(use()).resolves.toBe('#i-theme-sun');
  await expect.poll(() => app.backend.state.prefs.theme).toBe('dark');

  // no toast for any of it
  await expect(page.locator('.toast')).toHaveCount(0);
  // reachable from the command palette too
  await app.press('Meta+k');
  await page.locator('#palette-input').fill('theme');
  await expect(page.locator('.palette-item')).toContainText(/theme: switch light \/ dark mode/i);
});

// T046 "if cheap" fix: a focused custom button (the theme toggle, a quota
// chip, …) must handle its own Enter/Space, not have it stolen by a
// main-context binding on the same key (session.goto on Enter, zoom.open
// on Space) via preventDefault.
test('T046 Enter/Space on a focused custom button activates the button, not session.goto/zoom.open', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.open();
  await app.row('1.1').click(); // a session is selected, so session.goto would be observable
  const btn = page.locator('#btn-theme');
  await btn.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); // the button's own click fired
  await expect(page.locator('.toast')).toHaveCount(0); // session.goto's "→ tab …" toast did not

  // same for a quota chip: Enter opens Usage, not session.goto
  const item = page.locator('#tokens .tok-item').first();
  await item.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('XSS: hostile screen text and names render as text, never markup', async ({ app, page }) => {
  await app.open();
  const hostile = '<img src=x onerror="window.__xss=3"><script>window.__xss=4</script>';
  app.backend.patchSession(U['2.4'], { name: hostile, display_name: hostile, path: '~/<b>evil</b>' });
  await app.row('2.4').click();
  const pv = page.locator('.split .preview');
  await expect(pv.locator('pre.screen')).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(pv.locator('.preview-name')).toHaveText(hostile);
  await expect(app.row('2.4').locator('.row-name')).toHaveText(hostile);
  expect(await page.locator('.content img, .content script, .content b').count()).toBe(0);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test('real browser timers (no fake clock): SSE watchdog, debounced prefs, and toast expiry run without errors', async ({ app, page }) => {
  await app.open({ fakeClock: false });
  await app.press('r');
  await expect(app.toasts().last()).toHaveText('refreshing…');
  const splitter = page.locator('.splitter');
  await splitter.hover({ position: { x: 4, y: 100 } });
  const box = await splitter.boundingBox();
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 100, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => app.backend.state.prefs.split_ratio).toBeGreaterThan(0.42);
  await expect(app.toasts()).toHaveCount(0, { timeout: 7000 }); // real 3.5 s expiry
});

// # parity: P-20
test('P-20 status details still work on WebKit without the popover API (pre-Safari 17)', async ({ app, page }) => {
  await page.addInitScript(() => { delete HTMLElement.prototype.popover; });
  await app.open();
  expect(await page.evaluate(() => 'popover' in HTMLElement.prototype)).toBe(false);
  await expect(page.locator('#status-pop')).toBeHidden();
  await page.locator('#status-chip').click();
  await expect(page.locator('#status-pop')).toBeVisible();
  await expect(page.locator('#status-pop-body')).toContainText('Watching iTerm2');
  await page.locator('#status-diagnose').click();
  await expect(page.locator('#status-pop')).toBeHidden();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
});
