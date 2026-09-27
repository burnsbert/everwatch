// Toolbar "AI sessions only" ↔ "All sessions" toggle (persisted
// `agents_only`). User requirement: show/hide agents right on the toolbar.
import { test, expect } from './fixtures.mjs';

test('the toolbar toggle lists only AI sessions, says so in the list header, and persists across reloads', async ({ app, page }) => {
  await app.open();
  const btn = page.locator('#btn-agents');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('aria-label', 'Show Claude Code and Codex sessions only');
  await btn.hover();
  await page.clock.runFor(500);
  await expect(page.locator('#tooltip')).toHaveText('Showing all iTerm2 sessions, including plain shells — click for Claude Code and Codex sessions  i');
  await expect(app.rows()).toHaveCount(9);
  await expect(page.locator('.split .row.is-shell')).toHaveCount(3);

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveAttribute('aria-label', 'Show all sessions');
  await expect(btn).toHaveAttribute('data-tip', 'Showing Claude Code and Codex sessions — click for all iTerm2 sessions, including plain shells  i');
  await expect(app.rows()).toHaveCount(6);
  await expect(page.locator('.split .row.is-shell')).toHaveCount(0);
  await expect(page.locator('.split .row .badge--plain')).toHaveCount(0);
  await expect(page.locator('.list-pane .pane-title')).toHaveText('AI sessions');
  await expect(page.locator('.list-pane .pane-count')).toHaveText('6 of 9');
  await expect.poll(() => app.backend.state.prefs.agents_only).toBe(true);
  await expect(app.toasts()).toHaveCount(0); // a show/hide toggle never toasts (§4.13)

  // persisted: a reload keeps the filter
  await page.reload();
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('#btn-agents')).toHaveAttribute('aria-pressed', 'true');
  await expect(app.rows()).toHaveCount(6);

  // `i` toggles it back
  await app.press('i');
  await expect(app.rows()).toHaveCount(9);
  await expect.poll(() => app.backend.state.prefs.agents_only).toBe(false);
  await expect(page.locator('.list-pane .pane-title')).toHaveText('Sessions');
});

test('with AI sessions only on and no agents running, the list says so and offers Show All Sessions', async ({ app, page }) => {
  app.backend.setState((s) => ({ prefs: { ...s.prefs, agents_only: true }, sessions: s.sessions.filter((x) => !x.kind) }));
  await app.open();
  const empty = page.locator('.split .list-empty');
  await expect(empty).toBeVisible();
  await expect(empty.locator('.empty-title')).toHaveText('No AI sessions');
  await empty.getByRole('button', { name: 'Show All Sessions' }).click();
  await expect.poll(() => app.backend.state.prefs.agents_only).toBe(false);
  await expect(app.rows()).toHaveCount(3);
});

test('the grid follows the toggle; its own Agents/All control hides while the toolbar filter is on', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+3');
  await app.press('A'); // grid: All
  await expect(page.locator('.tile')).toHaveCount(9);
  await expect(page.locator('.grid-seg')).toBeVisible();
  await page.locator('#btn-agents').click();
  await expect(page.locator('.tile')).toHaveCount(6);
  await expect(page.locator('.grid-seg')).toBeHidden();
  await expect(page.locator('.grid-head .pane-title')).toHaveText('AI sessions');
});
