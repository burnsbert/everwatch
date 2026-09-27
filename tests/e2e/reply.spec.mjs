// W-10 live preview + reply bar against the JS fixture backend: typing
// into the selected session, quick replies for a numbered prompt, key
// buttons, errors, focus isolation from the global keymap, and the live
// lease following the selection (docs/DESIGN.md W-10).
import { test, expect } from './fixtures.mjs';
import { U } from './fixtures.mjs';

const bar = (page) => page.locator('.content > :not([hidden]) .reply');
const input = (page) => bar(page).locator('.reply-input');
const sends = (app) => app.callsTo('POST', /\/api\/sessions\/[^/]+\/send$/);
const sendPath = (tab) => `/api/sessions/${encodeURIComponent(U[tab])}/send`;

// # parity: W-10
test('W-10 typing in the reply bar sends text + Return to the selected session; ⇧↩ sends without Return', async ({ app, page }) => {
  await app.open();
  await app.row('1.5').click();
  await expect(bar(page)).toBeVisible();
  await expect(input(page)).toHaveAttribute('placeholder', /^Type to .+…$/);
  await input(page).click();
  await page.keyboard.type('run the tests');
  await page.keyboard.press('Enter');
  await expect.poll(() => sends(app).length).toBe(1);
  expect(sends(app)[0]).toMatchObject({ path: sendPath('1.5'), body: { text: 'run the tests', enter: true } });
  await expect(input(page)).toHaveValue('');
  await expect(app.toasts().last()).toContainText('Sent “run the tests” + Return to');

  await page.keyboard.type('draft only');
  await page.keyboard.press('Shift+Enter');
  await expect.poll(() => sends(app).length).toBe(2);
  expect(sends(app)[1].body).toEqual({ text: 'draft only', enter: false });
  await expect(input(page)).toHaveValue('');

  // ↩ in an empty box never sends a bare Return (use the ↩ button for that)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(sends(app).length).toBe(2);
});

// # parity: W-10
test('W-10 keys typed in the reply bar never trigger global shortcuts; Esc leaves the box', async ({ app, page }) => {
  await app.open();
  await app.row('1.5').click();
  await input(page).click();
  await page.keyboard.type('jk?vx1s');
  await expect(input(page)).toHaveValue('jk?vx1s');
  await expect(app.row('1.5')).toHaveClass(/is-selected/);
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(page.locator('#help')).toBeHidden();
  expect(app.callsTo('PUT', /\/color$/)).toHaveLength(0);
  await page.keyboard.press('Escape');
  await expect(input(page)).not.toBeFocused();
  await expect(page.locator('.content > :not([hidden]) .preview .screen')).toBeFocused();
  await expect(app.row('1.5')).toHaveClass(/is-selected/); // Esc didn't also unwind the selection
  expect(sends(app)).toHaveLength(0);
});

// # parity: W-10
test('W-10 quick-reply buttons appear for a numbered Claude prompt; clicking one sends its digit', async ({ app, page, backend }) => {
  await app.open();
  await app.row('1.1').click();
  const quick = bar(page).locator('.reply-option');
  // "2. Yes, and don't ask again …" gets no button (docs/DESIGN.md §2)
  await expect(quick).toHaveText(['1. Yes', '3. No, and tell Claude what to do differently']);
  await expect(quick.nth(0)).toHaveClass(/is-selected/);
  await quick.nth(0).click();
  await expect.poll(() => sends(app).length).toBe(1);
  const hash = backend.state.sessions.find((s) => s.uid === U['1.1']).screen_hash;
  // the screen_hash it was read from rides along, so a changed screen is refused
  expect(sends(app)[0]).toMatchObject({ path: sendPath('1.1'), body: { text: '1', expect_hash: hash } });
  await expect(app.toasts().last()).toContainText('Sent “1. Yes” to');

  // the screen moves on -> the buttons go away
  backend.setScreens({ [U['1.1']]: '⏺ Restarting the pods…\n\n✻ Working… (esc to interrupt)\n' });
  await expect(bar(page).locator('.reply-quick')).toBeHidden();
  // a non-prompt session has none
  await app.row('1.4').click();
  await expect(bar(page).locator('.reply-quick')).toBeHidden();
});

test('W-10 one-line Codex approval gets letter quick replies', async ({ app, page }) => {
  await app.open();
  await app.row('1.3').click();
  const quick = bar(page).locator('.reply-option');
  await expect(quick).toHaveText(['Yes (y)', 'No (n)']);
  await quick.nth(1).click();
  await expect.poll(() => sends(app).length).toBe(1);
  expect(sends(app)[0].body).toMatchObject({ text: 'n' });
});

// # parity: W-10
test('W-10 Esc / ⌃C / ↩ buttons send named keys', async ({ app, page }) => {
  await app.open();
  await app.row('2.1').click();
  await bar(page).getByRole('button', { name: 'Send Esc' }).click();
  await bar(page).getByRole('button', { name: 'Send Ctrl-C' }).click();
  await bar(page).getByRole('button', { name: 'Send Return' }).click();
  await expect.poll(() => sends(app).length).toBe(3);
  expect(sends(app).map((c) => c.body)).toEqual([{ key: 'esc' }, { key: 'ctrl-c' }, { key: 'enter' }]);
  await expect(app.toasts().last()).toContainText('Sent Return to');
});

test('W-10 a rejected send shows a danger toast and keeps the draft', async ({ app, page, backend }) => {
  await app.open();
  app.allowErrors(/status of 400/); // Chromium logs the refused request itself
  await app.row('1.5').click();
  backend.opts.failNext[sendPath('1.5')] = { status: 400, body: { error: 'text_too_long', detail: '2001 > 2000 characters' } };
  await input(page).fill('too long');
  await bar(page).getByRole('button', { name: 'Send', exact: true }).click();
  await expect(app.toasts().last()).toHaveAttribute('data-level', 'danger');
  await expect(app.toasts().last()).toContainText("Couldn't send to");
  await expect(app.toasts().last()).toContainText('2001 > 2000 characters');
  await expect(input(page)).toHaveValue('too long');
  // an action_result failure from the backend (e.g. the screen moved on) toasts too
  backend.emit('action_result', { id: 'a99', kind: 'send', ok: false, detail: 'the screen changed since you looked; not sent' });
  await expect(app.toasts().last()).toContainText('send failed: the screen changed since you looked; not sent');
});

// # parity: W-10
test('W-10 live lease follows the selected session and is dropped outside split/zoom', async ({ app, page }) => {
  const live = (method) => app.callsTo(method, /\/live$/).map((c) => decodeURIComponent(c.path.split('/')[3]));
  await app.open();
  await app.row('1.4').click();
  await expect.poll(() => live('POST').at(-1)).toBe(U['1.4']);
  await app.row('2.2').click();
  await expect.poll(() => live('POST').at(-1)).toBe(U['2.2']);
  expect(live('DELETE')).toContain(U['1.4']);
  await app.press('Space'); // zoom keeps the same lease
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'zoom');
  await expect(bar(page)).toBeVisible();
  const posts = live('POST').length;
  await app.press('Escape');
  await app.press('Meta+2'); // list view has no preview
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
  await expect.poll(() => live('DELETE').at(-1)).toBe(U['2.2']);
  expect(live('POST').length).toBe(posts);
});

test('W-10 no reply bar in compact mode or for Everwatch\'s own tab', async ({ app, page, backend }) => {
  await app.open({ query: '?mode=compact' });
  await expect(page.locator('.compactview')).toBeVisible();
  await expect(page.locator('.reply:visible')).toHaveCount(0);
  expect(app.callsTo('POST', /\/live$/)).toHaveLength(0);

  await app.open();
  await app.row('1.4').click();
  await expect(bar(page)).toBeVisible();
  backend.patchSession(U['1.4'], { is_self: true });
  await expect(bar(page)).toBeHidden();
});
