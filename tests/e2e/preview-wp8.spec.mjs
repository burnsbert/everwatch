// Design-review screenshots (headless, offscreen) for WP8's wow features:
// command palette, screen search results, sparklines (split + list + grid),
// and the usage burn-down chart. Not the README screenshots (WP10).
import { test, expect, U, FIXTURE } from './fixtures.mjs';

const OUT = 'build/preview';
const NOW = FIXTURE.now;

for (const scheme of ['dark', 'light']) {
  test(`preview screenshots wp8 — ${scheme}`, async ({ app, page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await app.open({ colorScheme: scheme, reducedMotion: 'reduce' });

    app.backend.setState((s) => ({
      historyStats: { ...s.historyStats, [U['1.1']]: { count: 3, seconds: 660 } },
      // Samples sit inside each limit's own window (reset − 5h / 7d) and
      // end near the meter's live value — the chart appends that at "now".
      usageHistorySamples: [
        // CC Session Limit (62%, resets in 2h 15m): on pace to hit 100% first
        ...[2, 6, 11, 15, 22, 30, 36, 41, 48, 55, 60].map((pct, i) => ({
          at: NOW - 9900 + 300 + i * 900, id: 'cc.five_hour', pct,
        })),
        // CC Weekly Limit (34%, resets Thu 5:00am): busy days, quiet nights
        ...[1, 4, 5, 5, 9, 13, 14, 14, 18, 21, 22, 22, 26, 29, 30, 30, 33].map((pct, i) => ({
          at: NOW - 364400 + 3600 + i * 21600, id: 'cc.seven_day', pct,
        })),
        // CC Sonnet Limit (12%)
        ...[0, 1, 2, 2, 3, 5, 5, 5, 7, 8, 8, 8, 10, 11, 11, 11, 12].map((pct, i) => ({
          at: NOW - 364400 + 3600 + i * 21600, id: 'cc.seven_day_sonnet', pct,
        })),
        // CX 5h Limit (18%, resets in 2h 46m): comfortably under pace
        ...[1, 2, 4, 5, 5, 7, 9, 10, 12, 13, 15, 16, 17].map((pct, i) => ({
          at: NOW - 8000 + 400 + i * 600, id: 'cx.five_hour', pct,
        })),
      ],
    }));

    // sparklines in split view (row strip + preview detail); the historyStats
    // fetch is per-selection, so force a fresh one by selecting elsewhere first
    await app.row('1.2').click();
    await app.row('1.1').click();
    await expect(page.locator('.preview-detail-text')).toHaveText('waited 3× · 11m total today');
    await page.screenshot({ path: `${OUT}/sparkline-split-${scheme}.png` });

    // sparklines in list view
    await app.press('Meta+2');
    await page.screenshot({ path: `${OUT}/sparkline-list-${scheme}.png` });
    await app.press('Meta+1');

    // command palette
    await app.press('Meta+k');
    await expect(page.locator('#palette')).toBeVisible();
    await page.keyboard.type('sort');
    await page.screenshot({ path: `${OUT}/palette-${scheme}.png` });
    await page.keyboard.press('Escape');

    // screen search
    app.backend.setScreens({ [U['2.3']]: 'tail -f logs/access.log\nERROR: disk quota exceeded\nretrying in 5s' });
    await app.press('Meta+Shift+f');
    await page.keyboard.type('disk quota');
    await expect(page.locator('.palette-item[data-type="hit"]').first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/search-${scheme}.png` });
    await page.keyboard.press('Escape');

    // usage burn-down chart
    await app.press('u');
    await expect(page.locator('.meter-chart').first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/usage-chart-${scheme}.png` });
    await app.press('Escape');

    // grid, after the polish fix (tiles fill the available height)
    await app.press('Meta+3');
    await expect(page.locator('.gridview')).toBeVisible();
    await page.screenshot({ path: `${OUT}/grid-${scheme}.png` });
  });
}
