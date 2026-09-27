// Activity sparklines + attention timeline (W-5): a 60-minute state strip
// on rows and grid tiles, and a "waited N× · Mm total today" detail in the
// preview/zoom header from GET /api/history.
import { test, expect, U } from './fixtures.mjs';

// # parity: W-5
test('W-5 the row/tile activity strip is opt-in (off by default; a Settings toggle shows it), then behaves as before', async ({ app, page }) => {
  await app.open();
  // off by default (validator finding: an unlabelled strip read as noise)
  await expect(app.row('1.1').locator('.row-spark')).toBeHidden();

  app.backend.setState((s) => ({ prefs: { ...s.prefs, show_row_activity: true } }));
  const strip = app.row('1.1').locator('.row-spark');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.spark-seg')).not.toHaveCount(0);
  // the fixture's 1.1 spark is "bbbbbbwwwwww": 6 busy then 6 waiting → 2 runs
  await expect(strip.locator('.spark-seg')).toHaveCount(2);
  await expect(strip.locator('.spark-seg').first()).toHaveClass(/spark-seg--busy/);
  await expect(strip.locator('.spark-seg').last()).toHaveClass(/spark-seg--waiting/);
  await expect(strip.locator('.spark-seg').first()).toHaveAttribute('title', /busy/);
  // a session with no history yet (empty spark) hides its strip
  await expect(app.row('1.4').locator('.row-spark')).toBeHidden();
});

// # parity: W-5
test('W-5 grid tiles show the same sparkline strip, also opt-in', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+3');
  const tile = page.locator('.tile[data-uid="' + U['1.1'] + '"]');
  await expect(tile.locator('.tile-spark')).toBeHidden();
  app.backend.setState((s) => ({ prefs: { ...s.prefs, show_row_activity: true } }));
  await expect(tile.locator('.tile-spark .spark-seg')).toHaveCount(2);
});

// # parity: W-5
test('W-5 the Settings activity-strip toggle is off by default and never pops a toast (user preference: no show/hide popups)', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+,');
  const row = page.locator('.settings-row', { hasText: 'Show activity strip on sessions' });
  await expect(row.locator('.toggle-input')).not.toBeChecked();
  await row.click();
  await expect.poll(() => app.backend.state.prefs.show_row_activity).toBe(true);
  await expect(page.locator('#toasts .toast')).toHaveCount(0);
});

// # parity: W-5
test('W-5 preview/zoom header shows "waited N× · Mm total today" from GET /api/history', async ({ app, page }) => {
  await app.open();
  await app.row('1.1').click();
  app.backend.setState((s) => ({ historyStats: { ...s.historyStats, [U['1.1']]: { count: 3, seconds: 660 } } }));
  // force a refetch: select elsewhere, then back — the client caches per uid
  await app.row('1.2').click();
  await app.row('1.1').click();
  await expect(page.locator('.preview-detail-text')).toHaveText('waited 3× · 11m total today');
  await expect(page.locator('.preview-spark')).toBeVisible();
  // self-explanatory: a label and a busy/waiting legend, always shown with
  // the strip — a validator finding called the un-labelled strip "noise"
  await expect(page.locator('.preview-detail-label')).toHaveText('Activity · last 60 min');
  await expect(page.locator('.preview-legend')).toContainText('Busy');
  await expect(page.locator('.preview-legend')).toContainText('Waiting');

  // no waits in the window → the detail line is empty but the sparkline stays
  app.backend.setState((s) => ({ historyStats: { ...s.historyStats, [U['1.2']]: { count: 0, seconds: 0 } } }));
  await app.row('1.2').click(); // uid changes → forces the per-selection refetch
  await expect(page.locator('.preview-detail-text')).toHaveText('');
  await expect(page.locator('.preview-detail')).toBeVisible(); // the sparkline alone keeps it shown

  // zoom shows the same detail
  await app.row('1.1').click();
  await app.press('Space');
  await expect(page.locator('.zoom .preview-detail-text')).toHaveText('waited 3× · 11m total today');
});

// # parity: W-5
test('W-5 the sparkline and detail hide gracefully in a narrow layout', async ({ app, page }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await app.open();
  await expect(app.row('1.1').locator('.row-spark')).toBeHidden();
});
