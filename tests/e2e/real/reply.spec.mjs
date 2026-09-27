// W-10 live preview + reply against the real `python3 -m everwatch serve
// --demo` backend: the reply bar's POSTs go through the real server,
// engine, and terminput validation into DemoSource.send_input, whose reply
// screens come back over the real SSE stream (docs/DESIGN.md W-10).
import { test, expect, U } from './fixtures.mjs';

const bar = (page) => page.locator('.content > :not([hidden]) .reply');
const screen = (page) => page.locator('.content > :not([hidden]) .preview .screen');
const pill = (page) => page.locator('.content > :not([hidden]) .preview .state-pill');

// # parity: W-10
test('real backend: typing into an idle demo Claude session submits it and the screen + state update', async ({ app, page }) => {
  await app.open({ onboardingDone: true });
  await app.row('1.5').click();
  await expect(pill(page)).toContainText('Idle');
  await bar(page).locator('.reply-input').fill('run the tests');
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText('> run the tests');
  await expect(screen(page)).toContainText('Working on it…');
  await expect(app.toasts().last()).toContainText('Sent “run the tests” + Return to');
  // the fixed demo clock only re-polls when asked; two polls debounce the state
  await app.api().request('POST', '/refresh', {});
  await app.api().request('POST', '/refresh', {});
  await expect(pill(page)).toContainText('Busy');
});

// # parity: W-10
test('real backend: quick replies for the numbered permission prompt; clicking "1. Yes" answers it', async ({ app, page }) => {
  await app.open({ onboardingDone: true });
  await app.row('1.1').click();
  const quick = bar(page).locator('.reply-option');
  await expect(quick).toHaveText(['1. Yes', '3. No, and tell Claude what to do differently']);
  await quick.first().click();
  await expect(screen(page)).toContainText('You chose: 1. Yes');
  await expect(bar(page).locator('.reply-quick')).toBeHidden();
});

// # parity: W-10
test('real backend: the Esc button interrupts a busy demo agent; Codex approval takes its letter shortcut', async ({ app, page }) => {
  await app.open({ onboardingDone: true });
  await app.row('1.2').click();
  await expect(pill(page)).toContainText('Busy');
  await bar(page).getByRole('button', { name: 'Send Esc' }).click();
  await expect(screen(page)).toContainText('Interrupted');

  await app.row('1.3').click();
  await bar(page).locator('.reply-option', { hasText: 'Yes, proceed' }).click();
  await expect(screen(page)).toContainText('You chose: 1. Yes, proceed');
});

// # parity: W-10
test('real backend: send validation and live lease endpoints', async ({ app }) => {
  await app.open({ onboardingDone: true });
  const api = app.api();
  const path = `/sessions/${encodeURIComponent(U['1.5'])}`;
  let r = await api.request('POST', `${path}/send`, { text: 'rm -rf ~\u001b[2J' });
  expect(r.status).toBe(400);
  expect(r.data.error).toBe('invalid_text');
  r = await api.request('POST', `${path}/send`, { key: 'ctrl-d' });
  expect(r.data.error).toBe('invalid_key');
  r = await api.request('POST', `${path}/send`, { text: 'x'.repeat(2001) });
  expect(r.data.error).toBe('text_too_long');
  // a quick reply read from a screen that has since changed is refused
  const prompt = `/sessions/${encodeURIComponent(U['1.1'])}`;
  r = await api.request('POST', `${prompt}/send`, { text: '1', expect_hash: 1 });
  expect(r.status).toBe(200); // queued; the worker's re-check refuses it
  r = await api.request('GET', `${prompt}/screen`);
  expect(r.data.text).toContain('❯ 1. Yes');
  expect(r.data.text).not.toContain('You chose');
  r = await api.request('POST', `${path}/live`, {});
  expect(r.status).toBe(200);
  expect(r.data).toMatchObject({ ok: true, live: true, lease: 6 });
  r = await api.request('DELETE', `${path}/live`, {});
  expect(r.data.live).toBe(false);
});
