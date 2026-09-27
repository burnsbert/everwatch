// §4.19 tooltip component: one shared tooltip for every abbreviated
// toolbar control. Delay + "warm" reopen, hoverable, keyboard focus, Esc.
import { test, expect } from './fixtures.mjs';

async function tabTo(page, id, max = 25) {
  for (let i = 0; i < max; i += 1) {
    if ((await page.evaluate(() => document.activeElement?.id)) === id) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`could not reach #${id} by Tab`);
}

test('hovering an icon-only toolbar button shows the tooltip after 500 ms, with its full name and shortcut', async ({ app, page }) => {
  await app.open();
  const tooltip = page.locator('#tooltip');
  const btn = page.locator('#btn-refresh');
  await expect(tooltip).not.toHaveClass(/is-visible/);
  await btn.hover();
  await page.clock.runFor(400);
  await expect(tooltip).not.toHaveClass(/is-visible/); // not yet — under the 500 ms delay
  await page.clock.runFor(150);
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip).toHaveText('Refresh now  r');
  await expect(btn).toHaveAttribute('aria-describedby', 'tooltip');
  // moving away hides it (after its own short hide delay)
  await page.mouse.move(0, 0);
  await page.clock.runFor(150);
  await expect(tooltip).not.toHaveClass(/is-visible/);
  await expect(btn).not.toHaveAttribute('aria-describedby', /.+/);
});

test('a "warm" reopen (another tooltip closed within 300 ms) shows immediately, no 500 ms wait', async ({ app, page }) => {
  await app.open();
  const tooltip = page.locator('#tooltip');
  await page.locator('#btn-refresh').hover();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveClass(/is-visible/);
  await page.mouse.move(0, 0);
  await page.clock.runFor(100); // closes
  await expect(tooltip).not.toHaveClass(/is-visible/);
  await page.locator('#btn-new').hover(); // within the 300 ms "warm" window
  await expect(tooltip).toHaveClass(/is-visible/); // immediate, no clock advance needed
  await expect(tooltip).toHaveText('New iTerm2 tab  n');
});

test('keyboard focus shows the tooltip immediately (no delay), and Esc hides it without changing anything else', async ({ app, page }) => {
  await app.open();
  const tooltip = page.locator('#tooltip');
  await page.locator('#filter').click();
  await tabTo(page, 'btn-help');
  await expect(page.locator('#btn-help')).toBeFocused();
  await expect(tooltip).toHaveClass(/is-visible/); // immediate — no page.clock.runFor at all
  await expect(tooltip).toHaveText('Keyboard shortcuts  ?');
  await page.keyboard.press('Escape');
  await expect(tooltip).not.toHaveClass(/is-visible/);
  await expect(page.locator('#btn-help')).toBeFocused(); // Esc only closed the tooltip
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split'); // nothing else reacted to that Esc
});

test('the tooltip is hoverable (WCAG 1.4.13): moving the pointer onto it keeps it open', async ({ app, page }) => {
  await app.open();
  const tooltip = page.locator('#tooltip');
  await page.locator('#btn-help').hover();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveClass(/is-visible/);
  const box = await tooltip.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.runFor(300); // well past the 100 ms hide delay
  await expect(tooltip).toHaveClass(/is-visible/); // still open — the pointer is on the tooltip itself
});

// A18/§4.19: the toolbar's dynamic controls (waiting pill) and the
// projects accordion's rail also carry a `data-tip` (not a static one,
// since their name changes).
test('dynamic toolbar controls (waiting pill, projects rail) get a tooltip too', async ({ app, page }) => {
  await app.open();
  const tooltip = page.locator('#tooltip');
  await page.locator('.proj-rail').hover();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('Expand projects  p');
  await page.mouse.move(0, 0);
  await page.clock.runFor(100);

  await page.locator('#waiting-pill').hover();
  await page.clock.runFor(500);
  await expect(tooltip).toHaveText('2 waiting — jump to next waiting session  a');
});

test('a stale tooltip never swallows Esc meant for a text field (cancelling a project rename)', async ({ app, page }) => {
  await app.open();
  await app.press('p');
  const panel = page.locator('.proj-panel');
  // closing the confirm dialog with Esc restores keyboard focus to the
  // header's "Clear", which shows its tooltip…
  await panel.getByRole('button', { name: 'Clear all projects…' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('#confirm-dialog')).toBeHidden();
  await expect(page.locator('#tooltip')).toHaveClass(/is-visible/);
  // …collapsing and re-expanding the panel leaves that tooltip up with no
  // focusout (its target was display:none, not blurred)
  await app.press('p');
  await app.press('ArrowUp');
  await expect(panel).not.toHaveClass(/is-collapsed/);
  const slot = panel.locator('.proj-slot[data-slot="3"]');
  for (let i = 0; i < 20; i += 1) {
    await slot.click();
    await expect(slot.locator('.proj-input')).toBeFocused();
    await slot.locator('.proj-input').fill('discarded');
    await page.keyboard.press('Escape');
    // the edit was cancelled, every time
    await expect(slot.locator('.proj-input')).toHaveCount(0);
    await expect(slot.locator('.proj-name')).toHaveText('Green');
  }
  expect(app.callsTo('PUT', /\/api\/projects\/3$/)).toHaveLength(0);
});
