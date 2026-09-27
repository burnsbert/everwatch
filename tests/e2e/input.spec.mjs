import { test, expect, FIXTURE, U } from './fixtures.mjs';

const selected = (page) => page.locator('.content > :not([hidden]) .row.is-selected');
const visits = (app) => app.callsTo('POST', /\/visit$/).map((c) => decodeURIComponent(c.path.split('/')[3]));

// # parity: P-40
test('P-40 selection is kept by uid, a stale selection snaps to the first row, selecting visits', async ({ app, page }) => {
  await app.open();
  await expect(selected(page)).toHaveAttribute('data-uid', U['1.1']);
  expect(visits(app)).toEqual([]); // the initial snap isn't a visit
  await app.row('2.2').click();
  await expect(selected(page)).toHaveAttribute('data-uid', U['2.2']);
  await expect.poll(() => visits(app)).toEqual([U['2.2']]);
  await app.press('s'); // re-sort: selection follows the uid, not the index
  await expect(selected(page)).toHaveAttribute('data-uid', U['2.2']);
  // the selected session vanishes → first row
  app.backend.setState((s) => ({ sessions: s.sessions.filter((x) => x.uid !== U['2.2']) }));
  await expect(selected(page)).toHaveCount(1);
  const first = await page.locator('#session-list .row').first().getAttribute('data-uid');
  await expect(selected(page)).toHaveAttribute('data-uid', first);
  // visiting clears the attention latch server-side
  await app.row('1.3').click();
  await expect.poll(() => app.backend.state.sessions.find((x) => x.uid === U['1.3']).attention).toBe(false);
});

// # parity: P-41
test('P-41 keys: ↑↓/j/k move, ⏎/g/⌘⏎ go to the session, a cycles waiting longest-first', async ({ app, page }) => {
  await app.open();
  const order = await page.locator('#session-list .row').evaluateAll((els) => els.map((e) => e.dataset.uid));
  await app.press('ArrowDown');
  await expect(selected(page)).toHaveAttribute('data-uid', order[1]);
  await app.press('j');
  await expect(selected(page)).toHaveAttribute('data-uid', order[2]);
  await app.press('k');
  await app.press('ArrowUp');
  await expect(selected(page)).toHaveAttribute('data-uid', order[0]);
  await app.press('Enter');
  await expect(app.toasts().last()).toHaveText('→ tab 1.1');
  await expect.poll(() => app.callsTo('POST', /\/goto$/).length).toBe(1);
  await app.press('j');
  await app.press('g');
  await expect(app.toasts().last()).toHaveText(`→ tab ${FIXTURE.sessions.find((s) => s.uid === order[1]).tab_label}`);
  await app.press('Meta+Enter');
  await expect.poll(() => app.callsTo('POST', /\/goto$/).length).toBe(3);
  expect(app.callsTo('POST', /\/goto$/).map((c) => c.path)).toEqual([
    `/api/sessions/${order[0]}/goto`, `/api/sessions/${order[1]}/goto`, `/api/sessions/${order[1]}/goto`]);

  await app.row('2.4').click();
  await app.press('a');
  await expect(selected(page)).toHaveAttribute('data-uid', FIXTURE.waiting_order[0]);
  await app.press('a');
  await expect(selected(page)).toHaveAttribute('data-uid', FIXTURE.waiting_order[1]);
  await app.press('a');
  await expect(selected(page)).toHaveAttribute('data-uid', FIXTURE.waiting_order[0]);
  app.backend.setState((st) => ({ waiting_order: [], counts: { ...st.counts, waiting: 0 } }));
  await expect(page.locator('#waiting-pill')).toBeHidden(); // the state landed
  await app.press('a');
  await expect(app.toasts().last()).toHaveText('no sessions waiting');
});

// # parity: P-42, P-09
test('P-42 mouse: click selects, double-click goes to the session, the wheel scrolls without moving the selection', async ({ app, page }) => {
  const many = structuredClone(FIXTURE);
  const base = many.sessions[3];
  many.sessions = Array.from({ length: 40 }, (_, i) => ({
    ...base, uid: `UID-${i}`, tab_index: i + 1, tab_label: `1.${i + 1}`, window_no: 1, window_id: 1,
    path: `~/src/p${i}`, name: `sh ${i}`, display_name: `sh ${i}`,
  }));
  many.waiting_order = [];
  await app.open({ fixture: many });
  const list = page.locator('#session-list');
  await list.locator('[data-uid="UID-3"]').click();
  await expect(selected(page)).toHaveAttribute('data-uid', 'UID-3');
  await list.locator('[data-uid="UID-5"] .row-path').dblclick();
  await expect.poll(() => app.callsTo('POST', /\/goto$/).at(-1)?.path).toBe('/api/sessions/UID-5/goto');
  await expect(app.toasts().last()).toHaveText('→ tab 1.6');
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await expect(selected(page)).toHaveAttribute('data-uid', 'UID-5');
  // an action_result failure toasts "{kind} failed: {detail}"
  app.backend.emit('action_result', { id: 'a9', kind: 'goto', ok: false, detail: 'session not found' });
  await expect(app.toasts().last()).toHaveText('goto failed: session not found');
  await expect(app.toasts().last()).toHaveAttribute('data-level', 'danger');
});

// # parity: P-43
test('P-43 q shows "⌘Q to quit" or closes an overlay; Esc unwinds overlay → filter → selection', async ({ app, page }) => {
  await app.open();
  await app.press('q');
  await expect(app.toasts().last()).toHaveText('⌘Q to quit');
  await app.press('Space');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'zoom');
  await app.press('Escape');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await app.press('/');
  await page.keyboard.type('api');
  await app.press('Enter');
  await expect(page.locator('#filter-chip')).toBeVisible();
  await app.press('Escape'); // clears the kept filter
  await expect(page.locator('#filter-chip')).toBeHidden();
  await expect(page.locator('#session-list .row')).toHaveCount(9);
  await app.press('Escape'); // then the selection
  await expect(selected(page)).toHaveCount(0);
  await expect(page.locator('.split .preview-empty')).toBeVisible();
  await expect(page.locator('.split .preview-empty')).toContainText('Select a session'); // §4.6 wording
  await app.press('j');
  await expect(selected(page)).toHaveCount(1);
});

// # parity: P-46
test('P-46 / filter: live fuzzy match with count and highlights; ⏎ keeps, Esc clears; ⌘F focuses', async ({ app, page }) => {
  await app.open();
  await app.press('/');
  const field = page.locator('#filter');
  await expect(field).toBeFocused();
  await page.keyboard.type('agw');
  await expect(page.locator('#session-list .row')).toHaveCount(2);
  await expect(page.locator('#filter-count')).toHaveText('2 of 9');
  await expect(page.locator('.split .pane-count')).toHaveText('2 of 9');
  const marks = await app.row('1.1').locator('.row-path mark').allTextContents();
  expect(marks.join('')).toBe('agw');
  // j/k type into the field instead of moving; arrows still move the selection
  await page.keyboard.type('j');
  await expect(page.locator('#session-list .row')).toHaveCount(0);
  await expect(page.locator('.split .list-empty')).toContainText('Nothing matches “agwj”.');
  await page.keyboard.press('Backspace');
  await app.press('ArrowDown');
  await expect(selected(page)).toHaveAttribute('data-uid', U['1.4']);
  await app.press('Enter');
  await expect(field).not.toBeFocused();
  await expect(page.locator('#filter-chip')).toHaveText('filter: agw');
  await expect(page.locator('#session-list .row')).toHaveCount(2);
  await app.press('Meta+f');
  await expect(field).toBeFocused();
  await app.press('Escape');
  await expect(field).toHaveValue('');
  await expect(page.locator('#session-list .row')).toHaveCount(9);
  await expect(page.locator('#filter-chip')).toBeHidden();
  // case-insensitive, over path + name + label
  await app.press('/');
  await page.keyboard.type('NORTHWIND');
  await expect(page.locator('#session-list .row')).toHaveCount(1);
  await expect(app.row('2.2')).toBeVisible();
  // the filter is not persisted
  expect(app.callsTo('PATCH', /\/api\/prefs$/)).toEqual([]);
});

// # parity: P-47
test('P-47 s cycles natural → attention → agents → activity → path with a toast, persisted; the dropdown too', async ({ app, page }) => {
  await app.open();
  const order = () => page.locator('#session-list .row').evaluateAll((els) => els.map((e) => e.querySelector('.row-tab').textContent));
  expect((await order()).slice(0, 2)).toEqual(['1.1', '1.3']); // attention: waiting first, longest first
  await app.press('s');
  await expect(app.toasts().last()).toHaveText('sort: agents');
  await expect(page.locator('#sort-select')).toHaveValue('agents');
  expect(await order()).toEqual(['1.1', '1.2', '1.3', '1.5', '2.1', '2.2', '1.4', '2.3', '2.4']);
  await app.press('s');
  await expect(app.toasts().last()).toHaveText('sort: activity');
  expect((await order())[0]).toBe('1.2'); // most recent change first
  await app.press('s');
  await expect(app.toasts().last()).toHaveText('sort: path');
  expect(await order()).toEqual(['2.4', '2.3', '1.1', '1.4', '2.1', '1.5', '1.3', '1.2', '2.2']);
  await app.press('s');
  await expect(app.toasts().last()).toHaveText('sort: natural');
  expect(await order()).toEqual(['1.1', '1.2', '1.3', '1.4', '1.5', '2.1', '2.2', '2.3', '2.4']);
  await expect.poll(() => app.backend.state.prefs.sort).toBe('natural');
  await page.locator('#sort-select').selectOption('attention');
  await expect.poll(() => app.backend.state.prefs.sort).toBe('attention');
  await expect(app.toasts().last()).toHaveText('sort: attention');
});

// # parity: P-48
test('P-48 l edits the label inline; ⏎ saves via PUT; empty removes it; double-click the name; Esc cancels', async ({ app, page }) => {
  await app.open();
  await app.row('1.2').click();
  await app.press('l');
  const editor = app.row('1.2').locator('.row-editor');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('');
  await page.keyboard.type('charts');
  await page.keyboard.press('Enter');
  await expect(app.row('1.2').locator('.row-name')).toHaveText('charts');
  await expect(app.row('1.2')).toHaveClass(/has-label/);
  expect(app.callsTo('PUT', /\/label$/).at(-1)).toEqual({ method: 'PUT', path: `/api/sessions/${U['1.2']}/label`, body: { label: 'charts' } });
  // j/k inside the editor type text rather than moving
  await app.press('l');
  await expect(editor).toHaveValue('charts');
  await page.keyboard.press('Meta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  await expect(app.row('1.2').locator('.row-name')).toHaveText('✳ Refactor dashboard charts');
  expect(app.callsTo('PUT', /\/label$/).at(-1).body).toEqual({ label: '' });
  // double-click the name to rename; Esc cancels without a request
  const n = app.callsTo('PUT', /\/label$/).length;
  await app.row('2.2').locator('.row-name').dblclick();
  const ed2 = app.row('2.2').locator('.row-editor');
  await expect(ed2).toBeFocused();
  await expect(ed2).toHaveValue('docs');
  await page.keyboard.type('jk');
  await page.keyboard.press('Escape');
  await expect(app.row('2.2').locator('.row-name')).toHaveText('docs');
  expect(app.callsTo('PUT', /\/label$/)).toHaveLength(n);
  expect(app.callsTo('POST', /\/goto$/)).toHaveLength(0);
  // hostile label text is rendered as text
  await app.press('l');
  await page.keyboard.type('<b>x</b>');
  await page.keyboard.press('Enter');
  await expect(app.row('2.2').locator('.row-name')).toHaveText('<b>x</b>');
  await expect(app.row('2.2').locator('.row-name b')).toHaveCount(0);
});

// # parity: P-48
test('P-48 a pencil icon next to the name is an obvious, hover-revealed rename affordance (a click enters edit, no double-click needed)', async ({ app, page }) => {
  await app.open();
  const row = app.row('1.3');
  const icon = row.locator('.row-edit-icon');
  await expect(icon).toHaveCSS('opacity', '0'); // not hovered yet
  await row.hover();
  await expect(icon).toHaveCSS('opacity', '1');
  await icon.click();
  await expect(row.locator('.row-editor')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row.locator('.row-editor')).toHaveCount(0);
  // it disappears entirely while already editing, rather than sitting
  // beside the input doing nothing
  await icon.click();
  await expect(row.locator('.row-edit-icon')).toBeHidden();
  await page.keyboard.press('Escape');
});

// # parity: P-49
test('P-49 v cycles split → list → grid, ⌘1/⌘2/⌘3 and the segmented control switch views, persisted', async ({ app, page }) => {
  await app.open();
  const view = page.locator('#app');
  await app.press('v');
  await expect(view).toHaveAttribute('data-view', 'list');
  await app.press('v');
  await expect(view).toHaveAttribute('data-view', 'grid');
  await expect(page.locator('.gridview')).toBeVisible();
  await app.press('v');
  await expect(view).toHaveAttribute('data-view', 'split');
  await app.press('Meta+2');
  await expect(view).toHaveAttribute('data-view', 'list');
  await app.press('Meta+3');
  await expect(view).toHaveAttribute('data-view', 'grid');
  await app.press('Meta+1');
  await expect(view).toHaveAttribute('data-view', 'split');
  await page.getByRole('radio', { name: 'List view' }).click();
  await expect(view).toHaveAttribute('data-view', 'list');
  await expect(page.getByRole('radio', { name: 'List view' })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => app.backend.state.prefs.view).toBe('list');
  // persisted: a reload comes back in list view
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(view).toHaveAttribute('data-view', 'list');
});
