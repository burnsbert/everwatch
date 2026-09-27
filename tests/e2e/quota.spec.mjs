import { test, expect } from './fixtures.mjs';

// # parity: P-69
test('P-69 quota_prompt shows an in-app modal; Draft posts /quota/draft, Skip posts /quota/skip, both dismiss it', async ({ app, page }) => {
  await app.open();
  const dialog = page.locator('#quota-dialog');
  await expect(dialog).toBeHidden();
  app.backend.emit('quota_prompt', { pct: 92, to: 'Sep 30', month: '2026-09' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#quota-body')).toContainText('92%');
  await expect(page.locator('#quota-skip')).toBeFocused();
  await page.locator('#quota-draft').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.callsTo('POST', /\/quota\/draft$/).length).toBe(1);

  app.backend.emit('quota_prompt', { pct: 95, to: 'Sep 30', month: '2026-09' });
  await expect(dialog).toBeVisible();
  await page.locator('#quota-skip').click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.callsTo('POST', /\/quota\/skip$/).length).toBe(1);

  // Esc also skips and dismisses
  app.backend.emit('quota_prompt', { pct: 97, to: 'Sep 30', month: '2026-09' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => app.callsTo('POST', /\/quota\/skip$/).length).toBe(2);
});
