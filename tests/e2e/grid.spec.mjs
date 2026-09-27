import { test, expect, U } from './fixtures.mjs';

// # parity: P-25, P-50
test('P-25/P-50 grid view: agent tiles only, A toggles all, tail text, waiting border, arrow-key nav by row', async ({ app, page }) => {
  await app.open();
  await app.press('Meta+3');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'grid');
  const tiles = page.locator('.tile');
  // 6 agent sessions (1.1, 1.2, 1.3, 1.5, 2.1, 2.2); 3 plain shells excluded
  await expect(tiles).toHaveCount(6);
  await expect(page.locator('.tile[data-uid="' + U['1.4'] + '"]')).toHaveCount(0);
  const waiting = page.locator(`.tile[data-uid="${U['1.1']}"]`);
  await expect(waiting).toHaveClass(/is-waiting/);
  await expect(waiting.locator('.tile-tail')).toContainText('Do you want to proceed?');
  await expect(waiting.locator('.tile-name')).toContainText('api-gateway');
  await expect(waiting.locator('.badge .badge-text')).toHaveText('Claude');
  await expect(waiting.locator('.tile-tab')).toHaveText('1.1');
  await expect(page.locator('.grid-head .pane-title')).toHaveText('AI sessions');
  await expect(page.locator('.grid-head .pane-count')).toHaveText('6 of 9');
  const aiMode = page.getByRole('radio', { name: 'AI sessions' });
  const allMode = page.getByRole('radio', { name: 'All sessions' });
  await expect(aiMode).toHaveAttribute('data-tip', 'Show Claude Code and Codex sessions (shows all sessions if none are running)');
  await expect(allMode).toHaveAttribute('data-tip', 'Show every iTerm2 session, including plain shells');

  // A toggles agents/all, persisted as grid_all
  await app.press('A');
  await expect(tiles).toHaveCount(9);
  await expect(page.locator('.tile[data-uid="' + U['1.4'] + '"]')).toHaveCount(1);
  await expect(page.locator(`.tile[data-uid="${U['1.4']}"] .badge`)).toHaveClass(/badge--plain/);
  await expect(page.locator('.grid-head .pane-title')).toHaveText('All sessions');
  await expect.poll(() => app.backend.state.prefs.grid_all).toBe(true);
  await aiMode.click();
  await expect(tiles).toHaveCount(6);
  await allMode.click();
  await expect(tiles).toHaveCount(9);
  await app.press('A');
  await expect(tiles).toHaveCount(6);

  // arrow-key nav: → moves one, ↓ moves one row of columns. 1000px (not
  // 900px) keeps this comfortably clear of the boundary where grid.mjs's
  // own `cols` estimate (ResizeObserver + `clientWidth / MIN_TILE_W`, no
  // padding/gap subtracted) and the CSS grid's actual resolved column
  // count can disagree by one — the projects rail (§4.7) now always
  // reserves 30px, which nudged 900px right up against that edge.
  await page.setViewportSize({ width: 1000, height: 800 }); // narrow enough for a known column count
  const cols = await page.locator('.grid-tiles').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  expect(cols).toBeGreaterThan(0);
  await page.locator('.tile').first().click();
  const selUid = () => page.locator('.tile.is-selected').getAttribute('data-uid');
  const order = await tiles.evaluateAll((els) => els.map((e) => e.dataset.uid));
  await expect.poll(selUid).toBe(order[0]);
  await app.press('ArrowRight');
  await expect.poll(selUid).toBe(order[1]);
  await app.press('ArrowDown');
  await expect.poll(selUid).toBe(order[Math.min(1 + cols, order.length - 1)]);
  await app.press('ArrowLeft');
  await app.press('ArrowUp');
  await expect.poll(selUid).toBe(order[0]);

  // double-click goes to the session
  await tiles.first().dblclick();
  await expect.poll(() => app.callsTo('POST', /\/goto$/).length).toBe(1);
});
