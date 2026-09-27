// Command palette (W-3) and screen search (W-8): one dialog, two modes.
import { test, expect, U } from './fixtures.mjs';

// # parity: W-3
test('W-3 ⌘K opens the palette: fuzzy "go to session" plus every keymap command with its shortcut; arrow/enter select', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+k');
  const dialog = page.locator('#palette');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#palette-input')).toBeFocused();
  await expect(page.locator('#palette-input')).toHaveAttribute('aria-expanded', 'true');

  // every command in the keymap, with its shortcut, is listed
  const sortItem = page.locator('.palette-item', { hasText: 'Cycle sort order' });
  await expect(sortItem).toBeVisible();
  await expect(sortItem.locator('.palette-item-keys kbd').first()).toHaveText('s');

  // fuzzy "go to session" — a query specific enough to match only one session
  await page.keyboard.type('payments-service');
  await expect(page.locator('.palette-item')).toHaveCount(1);
  await expect(page.locator('.palette-item').first()).toContainText('payments-service');
  await page.keyboard.press('ArrowDown'); // one item: wraps back to itself
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(app.row('1.3')).toHaveClass(/is-selected/);

  // reopening puts the just-picked session first (recent-first, W-3)
  await app.press('Meta+k');
  await expect(page.locator('.palette-item').first()).toContainText('payments-service');

  // Escape closes without acting
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(app.row('1.3')).toHaveClass(/is-selected/);
});

// # parity: W-3
test('W-3 running a command from the palette (e.g. sort) invokes it and closes the palette', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+k');
  await page.keyboard.type('cycle sort');
  await expect(page.locator('.palette-item').first()).toContainText('Cycle sort order');
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette')).toBeHidden();
  await expect.poll(() => app.backend.state.prefs.sort).toBe('agents'); // fixture default is 'attention'; cycles to 'agents'
});

// # parity: W-3
test('W-3 clicking the mode pill switches to screen search; ⌘K switches back to commands', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+k');
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', /Go to a session/);
  await page.locator('#palette-mode-btn').click();
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', /Search screen text/);
  await app.press('Meta+k');
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', /Go to a session/);
  await app.press('Meta+k'); // same mode again → closes
  await expect(page.locator('#palette')).toBeHidden();
});

// # parity: W-8
test('W-8 ⌘⇧F greps every session\'s screen text, highlights the match; Enter selects the session and highlights it in the preview', async ({ app, page }) => {
  await app.open();
  app.backend.setScreens({ [U['2.3']]: 'tail -f logs/access.log\nERROR: disk quota exceeded\nretrying in 5s' });
  await app.press('Meta+Shift+f');
  const dialog = page.locator('#palette');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#palette-input')).toHaveAttribute('placeholder', /Search screen text/);

  await page.keyboard.type('disk quota');
  const hit = page.locator('.palette-item[data-type="hit"]').first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('.palette-item-context mark')).toHaveText('disk quota');
  await expect(hit.locator('.palette-item-sub')).toContainText('2.3');

  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(app.row('2.3')).toHaveClass(/is-selected/);
  await expect(page.locator('.screen mark')).toHaveText('disk quota');
});

// # parity: W-8
test('W-8 an empty search query prompts to type; a query with no hits says so', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+Shift+f');
  await expect(page.locator('#palette-empty')).toBeVisible();
  await expect(page.locator('#palette-empty')).toHaveText(/Type to search/);
  await page.keyboard.type('zzzznotfound');
  await expect(page.locator('#palette-empty')).toHaveText(/No matches/);
});

// # parity: W-3, W-8
test('clicking the backdrop (outside the panel) closes the palette', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+k');
  await expect(page.locator('#palette')).toBeVisible();
  await page.mouse.click(4, 4); // far corner of the viewport, outside the centered panel
  await expect(page.locator('#palette')).toBeHidden();
});
