import { test, expect, U } from './fixtures.mjs';

// # parity: W-7
test('W-7 ?mode=compact: no header/footer chrome, a narrow list with state/age, waiting highlighted, click goes to the session', async ({ app, page }) => {
  await app.open({ query: '?mode=compact' });
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('.statusbar')).toBeHidden();
  await expect(page.locator('.compactview')).toBeVisible();
  const row = page.locator(`.compact-row[data-uid="${U['1.1']}"]`);
  await expect(row).toHaveClass(/is-waiting/);
  await expect(row.locator('.compact-age')).toHaveText('wait 3m');
  // §4.17 compact form: the floating panel is always narrow, so the badge
  // is glyph-only on its tinted square — never "CC" — and the full name is
  // in the tooltip/accessible name
  const badge = row.locator('.badge');
  await expect(badge).toHaveClass(/badge--claude/);
  await expect(badge.locator('.badge-glyph')).toBeVisible();
  await expect(badge.locator('.badge-text')).toBeHidden();
  await expect(badge).toHaveAttribute('aria-label', 'Claude Code session');
  await expect(badge).not.toContainText('CC');
  // plain shells stay distinguishable here too: an outlined terminal glyph
  const shell = page.locator(`.compact-row[data-uid="${U['1.4']}"]`);
  await expect(shell).toHaveClass(/is-shell/);
  await expect(shell.locator('.badge')).toHaveClass(/badge--plain/);
  await expect(shell.locator('.badge')).toHaveAttribute('aria-label', /Plain shell/);
  await row.click();
  await expect.poll(() => app.callsTo('POST', /\/goto$/).at(-1)?.path).toBe(`/api/sessions/${U['1.1']}/goto`);
});

// # parity: W-7
test('W-7 ?mode=compact: the projects panel stays hidden even when projects_open is true', async ({ app, page }) => {
  app.backend.setState({ prefs: { ...app.backend.state.prefs, projects_open: true } });
  await app.open({ query: '?mode=compact' });
  await expect(page.locator('.compactview')).toBeVisible();
  await expect(page.locator('.proj-panel')).toBeHidden();
});
