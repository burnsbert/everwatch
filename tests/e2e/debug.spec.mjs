import { test, expect, U } from './fixtures.mjs';

// # parity: P-18
test('P-18 debug rule chip shows session.rule in the preview header when debug_state is on', async ({ app, page }) => {
  await app.open();
  const rule = page.locator('.split .preview .rule-chip');
  await app.row('1.1').click();
  await expect(rule).toBeHidden(); // debug_state is off in the fixture
  app.backend.setState((s) => ({
    debug_state: true,
    sessions: s.sessions.map((x) => (x.uid === U['1.1'] ? { ...x, rule: 'menu-option' } : x)),
  }));
  await expect(rule).toBeVisible();
  await expect(rule).toHaveText('rule: menu-option');
  app.backend.setState({ debug_state: false });
  await expect(rule).toBeHidden();
});
