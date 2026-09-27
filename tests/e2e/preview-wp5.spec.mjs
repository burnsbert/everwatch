// Design-review screenshots (headless, offscreen) for WP5's new surfaces:
// grid, usage strip, projects panel, dialogs, quota modal, compact. Not the
// README screenshots — those are WP10's `make screenshots`.
import { test, expect } from './fixtures.mjs';

const OUT = 'build/preview';

for (const scheme of ['dark', 'light']) {
  test(`preview screenshots wp5 — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce' });

    await app.press('Meta+3');
    await expect(page.locator('.gridview')).toBeVisible();
    await page.screenshot({ path: `${OUT}/grid-${scheme}.png` });

    await app.press('Meta+1');
    await app.press('p');
    await expect(page.locator('.proj-panel')).toBeVisible();
    await page.screenshot({ path: `${OUT}/projects-${scheme}.png` });
    await app.press('p');

    await app.row('1.1').click();
    await app.press('x');
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.screenshot({ path: `${OUT}/dialog-close-tab-${scheme}.png` });
    await page.keyboard.press('Escape');

    app.backend.emit('quota_prompt', { pct: 93, to: 'Sep 30', month: '2026-09' });
    await expect(page.locator('#quota-dialog')).toBeVisible();
    await page.screenshot({ path: `${OUT}/quota-${scheme}.png` });
    await page.locator('#quota-skip').click();

    await app.row('1.3').click({ button: 'right' });
    await expect(page.locator('.ctx-menu')).toBeVisible();
    await page.screenshot({ path: `${OUT}/contextmenu-${scheme}.png` });
    await page.keyboard.press('Escape');
  });

  test(`preview screenshots wp5 compact — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce', query: '?mode=compact' });
    await expect(page.locator('.compactview')).toBeVisible();
    await page.screenshot({ path: `${OUT}/compact-${scheme}.png` });
  });
}
