import { test, expect, FIXTURE } from './fixtures.mjs';

test('secondary split panes are marked and can be hidden across views', async ({ app, page }) => {
  const fixture = structuredClone(FIXTURE);
  const primary = fixture.sessions[0];
  const secondary = {
    ...primary, uid: 'test-secondary-pane', session_index: 2,
    name: 'secondary shell', display_name: 'secondary shell', label: '',
  };
  fixture.sessions.push(secondary);
  fixture.screens[secondary.uid] = 'secondary pane screen';
  await app.open({ fixture });

  const splitPane = page.locator(`.split .row[data-uid="${secondary.uid}"]`);
  const listPane = page.locator(`.listview .row[data-uid="${secondary.uid}"]`);
  const gridPane = page.locator(`.gridview .tile[data-uid="${secondary.uid}"]`);
  const toggle = page.locator('.split .pane-head .pane-toggle');
  await expect(page.locator('.toolbar .pane-toggle')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const titleRight = await page.locator('.split .pane-head .pane-title').evaluate((el) => el.getBoundingClientRect().right);
  const toggleLeft = await toggle.evaluate((el) => el.getBoundingClientRect().left);
  expect(toggleLeft).toBeGreaterThan(titleRight);
  await expect(splitPane.locator('.pane-marker')).toHaveText('Pane 2');
  await expect(splitPane).toHaveAttribute('aria-label', /secondary split pane 2/);
  await expect(page.locator(`.split .row[data-uid="${primary.uid}"] .pane-marker`)).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(splitPane).toHaveCount(0);
  await expect(page.locator('.split .pane-count')).toHaveText('9 of 10');
  await expect.poll(() => app.backend.state.prefs.show_secondary_panes).toBe(false);
  await app.press('h');
  await expect(splitPane.locator('.pane-marker')).toHaveText('Pane 2');

  await app.press('Meta+2');
  await expect(page.locator('.listview .pane-head .pane-toggle')).toBeVisible();
  await expect(listPane.locator('.pane-marker')).toHaveText('Pane 2');
  await app.press('Meta+3');
  const gridToggle = page.locator('.gridview .pane-head .pane-toggle');
  await expect(gridToggle).toBeVisible();
  await expect(gridPane.locator('.pane-marker')).toHaveText('Pane 2');
  await gridToggle.click();
  await expect(gridPane).toHaveCount(0);
});

test('compact panel marks secondary panes and respects the saved visibility', async ({ app, page }) => {
  const fixture = structuredClone(FIXTURE);
  const secondary = {
    ...fixture.sessions[0], uid: 'test-compact-pane', session_index: 2,
    name: 'compact pane', display_name: 'compact pane', label: '',
  };
  fixture.sessions.push(secondary);
  await app.open({ fixture, query: '?mode=compact' });
  const pane = page.locator(`.compact-row[data-uid="${secondary.uid}"]`);
  await expect(pane.locator('.pane-marker')).toHaveText('P2');
  app.backend.setState({ prefs: { ...app.backend.state.prefs, show_secondary_panes: false } });
  await expect(pane).toHaveCount(0);
});
