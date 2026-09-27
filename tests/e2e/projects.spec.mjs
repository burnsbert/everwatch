import { test, expect, U } from './fixtures.mjs';

const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

// # parity: P-41, P-61
test('P-41/P-61 ↑ from the top row opens the projects panel; p toggles it; slots show colour, number and name; click/⏎ renames', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  // Collapsed by default (§4.7 vertical accordion): the panel itself stays
  // visible (it's the rail), only the slot list is folded away.
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/is-collapsed/);
  await app.press('p');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect.poll(() => app.backend.state.prefs.projects_open).toBe(true);
  const slot1 = panel.locator('.proj-slot[data-slot="1"]');
  await expect(slot1.locator('.proj-name')).toHaveText('API');
  await expect(slot1.locator('.proj-count')).toHaveCount(0);
  await expect(slot1).toHaveAttribute('aria-label', /Project 1, API\./);
  // The number stays beside the project color.
  await expect(slot1.locator('.proj-num')).toHaveText('1');
  await expect(slot1.locator('.proj-num')).toBeVisible();
  await slot1.hover();
  // the header's "Clear" text button opens the same clear-all confirmation
  await panel.getByRole('button', { name: 'Clear all projects…' }).click();
  await expect(page.locator('#confirm-title')).toHaveText('Clear all projects?');
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirm-dialog')).toBeHidden();
  await expect(slot1.locator('.proj-dot')).toHaveClass(/tab-dot--blue/);
  await app.press('p');
  await expect(panel).toHaveClass(/is-collapsed/);

  // ↑ from the top row also opens it (and focuses slot 1)
  await app.press('ArrowUp'); // already at the top row by default
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect(panel.locator('.proj-slot').first()).toBeFocused();

  // click (or Enter) a slot to rename it inline
  const slot3 = panel.locator('.proj-slot[data-slot="3"]');
  await slot3.click();
  await slot3.locator('.proj-input').fill('Infra');
  await slot3.locator('.proj-input').press('Enter');
  await expect.poll(() => app.callsTo('PUT', /\/api\/projects\/3$/).at(-1)?.body).toEqual({ name: 'Infra' });
  await expect(slot3.locator('.proj-name')).toHaveText('Infra');
  // Escape cancels an edit without saving
  await slot3.click();
  await slot3.locator('.proj-input').fill('discarded');
  await slot3.locator('.proj-input').press('Escape');
  await expect(slot3.locator('.proj-name')).toHaveText('Infra');
});

// # parity: P-61
test('P-61 the panel sits at the far left of the main view, left of the session list, and pushes content over — collapsed and expanded', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  const content = page.locator('.content');
  await expect(page.locator('#app')).toHaveClass(/projects-visible/);
  await expect(page.locator('#app')).not.toHaveClass(/projects-open/);
  // Collapsed: the rail still hugs the left edge and still reserves its
  // own width — `.content` is never flush against the window edge.
  const railW = Math.round(parseFloat(await cssVar(page, '--rail-w')));
  const railBox = await panel.boundingBox();
  expect(railBox.x).toBe(0);
  expect(Math.round(railBox.width)).toBe(railW);
  await expect.poll(async () => Math.round((await content.boundingBox()).x)).toBe(railW);

  await app.press('p');
  await expect(page.locator('#app')).toHaveClass(/projects-open/);
  const sidebarW = Math.round(parseFloat(await cssVar(page, '--sidebar-w')));
  // both the panel's own width and `.content`'s margin-left transition
  // (--dur-3), so poll past that instead of racing either one before
  // reading the session list's (now pushed-over) box.
  await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(sidebarW);
  const panelBox = await panel.boundingBox();
  // the panel hugs the left edge of the window…
  expect(panelBox.x).toBe(0);
  await expect.poll(async () => Math.round((await content.boundingBox()).x)).toBe(sidebarW);
  const list = page.locator('#session-list');
  const listBox = await list.boundingBox();
  // …and sits entirely to the left of the session list, which is pushed
  // over to make room (not overlaid — the content area's margin-left grew
  // by the panel's width).
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(listBox.x);
});

// # parity: P-61
test('P-61 no toolbar projects button — the projects column is its own vertical accordion, not a toolbar toggle', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#btn-projects')).toHaveCount(0);
});

// # parity: P-61
test('P-61 collapsed: a slim rail with the "Projects" label and the 5 project dots, occupying exactly --rail-w', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  await expect(panel).toHaveClass(/is-collapsed/);
  const rail = panel.locator('.proj-rail');
  await expect(rail).toBeVisible();
  await expect(panel.locator('.proj-body')).toBeHidden();
  await expect(rail.locator('.proj-rail-label')).toHaveText('Projects');
  const dots = rail.locator('.proj-rail-dot');
  await expect(dots).toHaveCount(5);
  // matches the slot list's own colors/names (fixture: slot 1 "API"/blue,
  // slot 3 unnamed/green → shows the color name as its tooltip)
  await expect(dots.nth(0)).toHaveClass(/tab-dot--blue/);
  await expect(dots.nth(0)).toHaveAttribute('data-tip', 'Project 1: API');
  await expect(dots.nth(2)).toHaveClass(/tab-dot--green/);
  await expect(dots.nth(2)).toHaveAttribute('data-tip', 'Project 3: Green');
  await expect(dots.nth(2)).toHaveText('3');

  const railW = Math.round(parseFloat(await cssVar(page, '--rail-w')));
  await expect.poll(async () => Math.round((await panel.boundingBox()).width)).toBe(railW);
  await expect.poll(async () => Math.round((await page.locator('.content').boundingBox()).x)).toBe(railW);
});

// # parity: P-61
test('P-61 clicking the rail expands the panel (aria-expanded true, persisted); the header handle collapses it back', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  const rail = panel.locator('.proj-rail');
  await expect(rail).toHaveAttribute('aria-expanded', 'false');
  await expect(rail).toHaveAttribute('aria-label', 'Expand projects');
  await expect(rail).toHaveAttribute('data-tip', 'Expand projects  p');

  await rail.click();
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect.poll(() => app.backend.state.prefs.projects_open).toBe(true);
  const collapseBtn = panel.locator('.proj-collapse');
  await expect(collapseBtn).toBeVisible();
  await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(collapseBtn).toHaveAttribute('aria-label', 'Collapse projects');
  await expect(collapseBtn).toHaveAttribute('data-tip', 'Collapse projects  p');

  await collapseBtn.click();
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect.poll(() => app.backend.state.prefs.projects_open).toBe(false);

  // `p` drives the same pref either way
  await app.press('p');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect.poll(() => app.backend.state.prefs.projects_open).toBe(true);
});

// # parity: P-61
test('P-61 the rail is keyboard-operable: Enter or Space expands it', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  const rail = panel.locator('.proj-rail');
  await rail.focus();
  await page.keyboard.press('Enter');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect.poll(() => app.backend.state.prefs.projects_open).toBe(true);

  await app.press('p'); // back to collapsed to check Space too
  await expect(panel).toHaveClass(/is-collapsed/);
  await rail.focus();
  await page.keyboard.press('Space');
  await expect(panel).not.toHaveClass(/is-collapsed/);
});

// # parity: P-61, P-34
test('P-61 the width change respects prefers-reduced-motion (no transition)', async ({ app, page }) => {
  await app.open({ reducedMotion: 'reduce' });
  const panel = page.locator('.proj-panel');
  await expect(panel).toHaveClass(/is-collapsed/);
  // the global reduced-motion kill switch (base.css) forces 0.001ms,
  // which getComputedStyle reports back as seconds: "1e-06s"
  await expect(panel).toHaveCSS('transition-duration', '1e-06s');
  await app.press('p');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect(panel).toHaveCSS('transition-duration', '1e-06s');
});

// # parity: P-61
// Simulates the drop DataTransfer in-page (Playwright can't construct a
// real DataTransfer across the Node/browser boundary) — same technique
// would apply to a full slot row's drop handler, which has no e2e drag
// coverage of its own either; this at least proves the collapsed rail's
// dot assigns directly, without requiring the panel to expand first.
test('P-61 dropping a session onto a collapsed rail dot assigns that project directly, without expanding', async ({ app, page }) => {
  await app.open();
  const panel = page.locator('.proj-panel');
  await expect(panel).toHaveClass(/is-collapsed/);
  const dot = panel.locator('.proj-rail-dot').nth(1); // slot 2, "Docs"/purple
  await dot.evaluate((el, uid) => {
    const dt = new DataTransfer();
    dt.setData('text/x-everwatch-uid', uid);
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, U['1.2']);
  await expect.poll(() => app.backend.state.sessions.find((s) => s.uid === U['1.2']).tab_color).toBe('purple');
  // the panel never had to expand for the drop to land
  await expect(panel).toHaveClass(/is-collapsed/);
});

// # parity: P-61
test('P-61 empty slots show their color name (not italic) and an always-visible pencil; named slots reveal pencil/× on hover', async ({ app, page }) => {
  await app.open();
  await app.press('p');
  const panel = page.locator('.proj-panel');
  const namedSlot = panel.locator('.proj-slot[data-slot="1"]'); // "API" in the fixture
  const emptySlot = panel.locator('.proj-slot[data-slot="3"]'); // unnamed in the fixture

  // §3.5/§4.7: an unnamed slot *is* a color, so it shows the color name
  await expect(emptySlot.locator('.proj-name')).toHaveText('Green');
  await expect(emptySlot.locator('.proj-name')).toHaveCSS('font-style', 'normal');
  await expect(emptySlot).not.toHaveClass(/is-named/);
  await expect(emptySlot.locator('.proj-edit-icon')).toHaveCSS('opacity', '1'); // always visible, unhovered
  await expect(emptySlot.locator('.proj-clear')).toBeHidden(); // nothing to clear

  await expect(namedSlot.locator('.proj-edit-icon')).toHaveCSS('opacity', '0'); // hidden until hover/focus
  await namedSlot.hover();
  await expect(namedSlot.locator('.proj-edit-icon')).toHaveCSS('opacity', '1');
  await expect(namedSlot.locator('.proj-clear')).toBeVisible();
});

// # parity: P-61
test('P-61 the per-slot × clears just that project\'s name and offers an Undo toast action', async ({ app, page }) => {
  await app.open();
  await app.press('p');
  const panel = page.locator('.proj-panel');
  const slot1 = panel.locator('.proj-slot[data-slot="1"]'); // "API"
  const slot2 = panel.locator('.proj-slot[data-slot="2"]'); // "Docs"

  await slot1.hover();
  await slot1.locator('.proj-clear').click();
  await expect.poll(() => app.callsTo('PUT', /\/api\/projects\/1$/).at(-1)?.body).toEqual({ name: '' });
  await expect(slot1.locator('.proj-name')).toHaveText('Blue');
  // clearing slot 1 doesn't touch slot 2
  await expect(slot2.locator('.proj-name')).toHaveText('Docs');
  await expect(app.callsTo('PUT', /\/api\/projects\/2$/)).toHaveLength(0);

  const toast = app.toasts().last();
  await expect(toast.locator('.toast-text')).toHaveText('project 1 cleared');
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => app.callsTo('PUT', /\/api\/projects\/1$/).at(-1)?.body).toEqual({ name: 'API' });
  await expect(slot1.locator('.proj-name')).toHaveText('API');
});

// # parity: P-62
test('P-62 1–5 assign the selected session\'s tab color to a project, 0 clears it, with toasts', async ({ app, page }) => {
  await app.open();
  await app.row('1.2').click();
  await app.press('2');
  await expect(app.toasts().last()).toHaveText('tab 1.2 → purple (Docs)');
  await expect.poll(() => app.backend.state.sessions.find((s) => s.uid === U['1.2']).tab_color).toBe('purple');
  await app.press('0');
  await expect(app.toasts().last()).toHaveText('tab 1.2: color cleared');
  await expect.poll(() => app.backend.state.sessions.find((s) => s.uid === U['1.2']).tab_color).toBeFalsy();

  // a 409 gets an actionable toast routing to Diagnostics
  app.allowErrors(/409/);
  app.backend.opts.failNext[`/api/sessions/${U['1.2']}/color`] = { status: 409, body: { error: 'tab_colors_unavailable' } };
  await app.press('1');
  const toast = app.toasts().last();
  await expect(toast.locator('.toast-text')).toHaveText('tab colors unavailable');
  await toast.getByRole('button', { name: 'Set up…' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'diagnostics');
});

// # parity: P-63
test('P-63 c opens a clear-all confirmation; confirming DELETEs /api/projects and toasts', async ({ app, page }) => {
  await app.open();
  await app.press('c');
  const dialog = page.locator('#confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#confirm-title')).toHaveText('Clear all projects?');
  await expect(page.locator('#confirm-cancel')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(app.callsTo('DELETE', /\/api\/projects$/)).toHaveLength(0);
  await app.press('c');
  await page.locator('#confirm-ok').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.callsTo('DELETE', /\/api\/projects$/).length).toBe(1);
  await expect(app.toasts().last()).toHaveText('projects cleared');
});

// # parity: P-64, P-65
test('P-64 x opens "Close tab N?" with Cancel focused by default; y confirms; n cancels. P-65 n opens a new tab', async ({ app, page }) => {
  await app.open();
  await app.row('1.1').click();
  await app.press('x');
  const dialog = page.locator('#confirm-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#confirm-title')).toHaveText('Close tab 1.1?');
  await expect(page.locator('#confirm-cancel')).toBeFocused();
  await page.keyboard.press('n');
  await expect(dialog).toBeHidden();
  await app.press('x');
  await page.keyboard.press('y');
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.callsTo('POST', /\/close$/).length).toBe(1);
  await expect(app.toasts().last()).toHaveText('closing tab 1.1…');

  await app.press('n');
  await expect(app.toasts().last()).toHaveText('opening new tab…');
  await expect.poll(() => app.callsTo('POST', /\/tabs\/new$/).length).toBe(1);
});

// # parity: P-48
test('P-48 right-click a row opens a context menu: rename, go to, color → project, close tab', async ({ app, page }) => {
  await app.open();
  const row = app.row('1.3');
  await row.click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Rename…')).toBeVisible();
  await expect(menu.getByText('Go to session')).toBeVisible();
  await expect(menu.getByText('API')).toBeVisible(); // project 1's name, as the color option label
  await expect(menu.getByText('Close tab…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  await row.click({ button: 'right' });
  await menu.getByText('Go to session').click();
  await expect.poll(() => app.callsTo('POST', /\/goto$/).at(-1)?.path).toBe(`/api/sessions/${U['1.3']}/goto`);
  await expect(menu).toBeHidden();

  await row.click({ button: 'right' });
  await menu.getByText('Close tab…').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
});
