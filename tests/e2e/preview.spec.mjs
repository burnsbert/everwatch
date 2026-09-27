// Design-review screenshots (headless, offscreen) into build/preview/.
// Not the README screenshots — those are WP10's `make screenshots`.
import { test, expect } from './fixtures.mjs';

const OUT = 'build/preview';

for (const scheme of ['dark', 'light']) {
  test(`preview screenshots — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce' });
    await expect(app.row('1.1')).toHaveClass(/is-selected/);
    await page.screenshot({ path: `${OUT}/split-${scheme}.png` });

    await app.press('v');
    await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
    await app.press('s');
    await app.press('s');
    await app.press('s');
    await app.press('s'); // attention → agents → activity → path → natural (grouped)
    await expect(page.locator('.group-header').first()).toBeVisible();
    await app.row('2.2').click();
    await page.screenshot({ path: `${OUT}/list-${scheme}.png` });

    await app.press('/');
    await page.keyboard.type('src');
    await app.press('Enter');
    await page.screenshot({ path: `${OUT}/list-filter-${scheme}.png` });
    await app.press('Escape');
    await app.press('Meta+1');
    await app.press('u');
    await page.screenshot({ path: `${OUT}/usage-${scheme}.png` });
    await app.press('Escape');

    await app.press('?');
    await expect(page.locator('#help')).toBeVisible();
    await page.screenshot({ path: `${OUT}/help-${scheme}.png` });
    await app.press('x');

    app.backend.setState({ iterm: { status: 'not_running', error: '', snapshot_at: 0 }, sessions: [], counts: { tabs: 0, agents: 0, waiting: 0 }, waiting_order: [] });
    await expect(page.locator('.empty-page')).toBeVisible();
    await page.screenshot({ path: `${OUT}/empty-${scheme}.png` });
  });
}
