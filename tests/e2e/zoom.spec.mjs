import { test, expect, U } from './fixtures.mjs';

// # parity: P-26
test('P-26 zoom: Space fills the content with the selection; ↑↓/j/k switch sessions; any other key exits', async ({ app, page }) => {
  await app.open();
  await app.row('1.2').click();
  await app.press('Space');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'zoom');
  const zoom = page.locator('.zoom .preview');
  await expect(zoom.locator('.preview-name')).toHaveText('✳ Refactor dashboard charts');
  await expect(page.locator('.split')).toBeHidden();

  await app.press('j');
  await expect(zoom.locator('.preview-name')).not.toHaveText('✳ Refactor dashboard charts');
  await app.press('k');
  await expect(zoom.locator('.preview-name')).toHaveText('✳ Refactor dashboard charts');

  // any other (unbound) key exits zoom
  await app.press('z');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(page.locator('.split')).toBeVisible();

  // Esc and Space both exit, and so does Enter (P-26: "any other key exits")
  await app.press('Space');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'zoom');
  await app.press('Escape');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await app.press('Space');
  await app.press('Enter');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  expect(U['1.1']).toBeTruthy();
});
