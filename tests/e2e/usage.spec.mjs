import { test, expect, FIXTURE } from './fixtures.mjs';

const NOW = FIXTURE.now;

// # parity: P-54, P-55, P-58
test('P-54/P-55/P-58 usage view: meters with level/reset/projection, $ toggle shows dollars, u/r/Esc keys', async ({ app, page }) => {
  await app.open();
  await app.press('u');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  const session = page.locator('.usage-section', { hasText: 'Claude Code' }).locator('.meter').first();
  // VISUAL_SPEC §4.14: display names come from the row id, never "CC …
  // Limit"; the full name is the group's accessible name.
  await expect(session.locator('.meter-label')).toHaveText('Session');
  await expect(session).toHaveAttribute('aria-label', /^Claude Code — 5-hour session limit: 62 percent used/);
  await expect(page.locator('.usage-page')).not.toContainText(/\bC[CX]\b/);
  await expect(session.locator('.meter-pct')).toHaveText('62%');
  await expect(session).toHaveAttribute('data-level', 'yellow');
  await expect(session.locator('.meter-reset')).toHaveText(/^Resets in 2h 15m · /);
  // pace: the run-out time comes from projection.at (not the prose), plus
  // the hourglass mark
  await expect(session.locator('.meter-proj')).toHaveText(/^On pace to reach 100% (at|.* at) \d{1,2}:\d{2} [AP]M$/);
  await expect(session.locator('.meter-icon--pace')).toBeVisible();
  await expect(session.locator('.meter-icon--hit')).toBeHidden();
  await expect(session.locator('.meter-dollars')).toBeHidden(); // dollars is null on this row in the fixture

  await app.press('$');
  await expect.poll(() => app.backend.state.prefs.show_dollars).toBe(true);
  await app.press('u');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await app.press('u');
  await app.press('Escape');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await app.press('u');
  await page.getByRole('button', { name: 'Back to sessions' }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

test('usage view: the projects panel column collapses even when projects_open is true (no reserved left gutter)', async ({ app, page }) => {
  const withPanelOpen = structuredClone(FIXTURE);
  withPanelOpen.prefs = { ...withPanelOpen.prefs, projects_open: true };
  await app.open({ fixture: withPanelOpen });
  await app.press('u');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(page.locator('.proj-panel')).toBeHidden();
  await expect(page.locator('#app')).not.toHaveClass(/projects-open/);
  // `.content`'s margin-left transitions (--dur-med, 220ms) rather than
  // snapping, so poll past that instead of racing it.
  await expect.poll(async () => (await page.locator('.content').boundingBox()).width).toBe(page.viewportSize().width);
});

// # parity: P-56, P-58
test('P-56 stale/failing usage shows an error line with a retry button; $ shows the dollar amount', async ({ app, page }) => {
  const withDollars = structuredClone(FIXTURE);
  withDollars.prefs = { ...withDollars.prefs, show_dollars: true };
  withDollars.usage.claude.rows = withDollars.usage.claude.rows.map((r, i) => (i === 0 ? { ...r, dollars: 1234 } : r));
  await app.open({ fixture: withDollars });
  await app.press('u');
  const session = page.locator('.usage-section', { hasText: 'Claude Code' }).locator('.meter').first();
  await expect(session.locator('.meter-dollars')).toHaveText('$1,234');

  app.backend.setState((s) => ({
    usage: {
      ...s.usage,
      claude: { status: 'failing', at: NOW - 400, rows: s.usage.claude.rows },
      codex: { status: 'failing', at: 0, rows: [] },
    },
  }));
  const ccStatus = page.locator('.usage-section', { hasText: 'Claude Code' }).locator('.usage-status');
  await expect(ccStatus).toHaveText(/^Fetch failing — showing data from/);
  const cxStatus = page.locator('.usage-section', { hasText: 'Codex' }).locator('.usage-status');
  await expect(cxStatus).toHaveText('Codex usage fetch failed');
  await expect(page.locator('.usage-foot .btn', { hasText: 'Retry' })).toBeVisible();
  await page.locator('.usage-foot .btn', { hasText: 'Retry' }).click();
  await expect.poll(() => app.callsTo('POST', /\/refresh$/).length).toBeGreaterThan(0);
});

// # parity: P-57
test('P-57 usage view shows "no Claude Code or Codex sessions running" when both are inactive', async ({ app, page }) => {
  const empty = structuredClone(FIXTURE);
  empty.usage = { claude: { status: 'inactive', at: 0, rows: [] }, codex: { status: 'inactive', at: 0, rows: [] } };
  await app.open({ fixture: empty });
  await app.press('u');
  await expect(page.locator('.usage-empty')).toBeVisible();
  await expect(page.locator('.usage-empty')).toHaveText('No Claude Code or Codex sessions running');
});

// # parity: W-6
test('W-6 usage burn-down chart: an SVG line, gridlines/axis labels, area fill, a dashed pace projection, a reset marker, and a hover tooltip', async ({ app, page }) => {
  await app.open();
  // The x-domain is each limit's own window, [reset − 5h/7d, reset]
  // (lib/chart.mjs limitWindow); samples must sit inside it to be drawn.
  // cc.five_hour resets at NOW + 2h15m, so its window starts NOW − 2h45m.
  const base = NOW - 9000;
  const weekBase = NOW - 86400 * 3;
  const cxBase = NOW - 3600 * 2;
  app.backend.setState((s) => ({
    usage: {
      ...s.usage,
      codex: {
        ...s.usage.codex,
        rows: s.usage.codex.rows.map((r, i) => (i === 0
          ? { ...r, reset_at: new Date((NOW + 3600 * 2) * 1000).toISOString() } : r)),
      },
    },
    usageHistorySamples: [
      // one stale sample from the previous 5h window: dropped, not drawn
      { at: NOW - 3600 * 6, id: 'cc.five_hour', pct: 95 },
      ...Array.from({ length: 6 }, (_, i) => ({ at: base + i * 1200, id: 'cc.five_hour', pct: 20 + i * 7 })),
      // a second row with its own history also gets a chart, not just the first
      ...Array.from({ length: 4 }, (_, i) => ({ at: weekBase + i * 86400, id: 'cc.seven_day', pct: 10 + i * 5 })),
      ...Array.from({ length: 4 }, (_, i) => ({ at: cxBase + i * 1800, id: 'cx.five_hour', pct: 15 })),
    ],
  }));
  await app.press('u');
  const claude = page.locator('.usage-section', { hasText: 'Claude Code' });
  const session = claude.locator('.meter').first();
  const chart = session.locator('.meter-chart');
  await expect(chart).toBeVisible();
  await expect(chart.locator('.chart-line:not(.chart-line--proj)')).toHaveAttribute('d', /^M/);
  // 6 in-window samples + the live value at now; the stale one is dropped
  await expect(chart.locator('.chart-line:not(.chart-line--proj)')).toHaveAttribute('d', /^M[^M]*$/);
  expect((await chart.locator('.chart-line:not(.chart-line--proj)').getAttribute('d')).split('L').length).toBe(7);
  await expect(chart.locator('.chart-area')).toHaveAttribute('d', /^M.*Z$/);
  // 62% at 2h45m into a 5h window is on pace to hit 100% before reset: the
  // dashed projection ends at 100% with a hit dot and a "hits 100%" tag
  await expect(chart.locator('.chart-line--proj')).toHaveAttribute('d', /^M/);
  await expect(chart.locator('.chart-line--proj')).toHaveClass(/is-hit/);
  await expect(chart.locator('.chart-dot--hit')).toBeVisible();
  await expect(chart.locator('.chart-tag--hit')).toHaveText(/^\d{1,2}:\d{2} [AP]M$/);
  await expect(chart.locator('.chart-tag--hit svg')).toHaveCount(1); // the hourglass run-out mark
  // the right edge is the reset, and "now" is a labeled marker inside it
  await expect(chart.locator('.chart-reset')).toBeVisible();
  await expect(chart.locator('.chart-now')).toBeVisible();
  await expect(chart.locator('.chart-tag--now')).toHaveText('Now');
  // §4.14: gridlines and y-axis labels at 50% and 100% only
  await expect(chart.locator('.chart-grid')).toHaveCount(2);
  await expect(chart.locator('.chart-ytick')).toHaveCount(2);
  await expect(chart.locator('.chart-ytick').first()).toHaveText('50%');
  await expect(chart.locator('.chart-ytick').last()).toHaveText('100%');
  // x axis: the window start and the reset
  await expect(chart.locator('.chart-xtick--start')).toBeVisible();
  await expect(chart.locator('.chart-xtick--reset')).toHaveText(/^Resets /);

  const box = await chart.locator('.chart-hover-rect').boundingBox();
  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await expect(chart.locator('.chart-tip')).toBeVisible();
  await expect(chart.locator('.chart-tip')).toHaveText(/%/);

  const weekly = claude.locator('.meter').nth(1);
  await expect(weekly.locator('.meter-chart')).toBeVisible();
  await expect(weekly.locator('.chart-line:not(.chart-line--proj)')).toHaveAttribute('d', /^M/);
  await expect(weekly.locator('.chart-xtick--reset')).toHaveText(/^Resets /);

  // Codex: well under pace → the projection stops at the reset, no hit dot
  const codexChart = page.locator('.usage-section', { hasText: 'Codex' }).locator('.meter').first().locator('.meter-chart');
  await expect(codexChart.locator('.chart-line--proj')).toHaveAttribute('d', /^M/);
  await expect(codexChart.locator('.chart-line--proj')).not.toHaveClass(/is-hit/);
  await expect(codexChart.locator('.chart-dot--hit')).toBeHidden();
  await expect(codexChart.locator('.chart-tag--now')).toHaveText('Now');
  await expect(codexChart.locator('.chart-xtick--reset')).toHaveText(/^Resets /);

  // a limit with fewer than 2 points shows the graceful empty state
  // instead of a hidden/broken chart
  const sonnet = claude.locator('.meter').nth(2);
  await expect(sonnet.locator('.meter-chart')).toBeVisible();
  await expect(sonnet.locator('.chart-empty')).toHaveText(/Collecting data/);
  await expect(sonnet.locator('.chart-body')).toBeHidden();
});

// # parity: P-59
// User decision (VISUAL_SPEC §4.18.2, D4): the quota strip can't be hidden.
// Even a leftover `usage_collapsed: true` from an older version shows it.
test('P-59 the Tokens Used strip is always visible: no collapse control, and a stale usage_collapsed pref is ignored', async ({ app, page }) => {
  app.backend.setState((s) => ({ prefs: { ...s.prefs, usage_collapsed: true } }));
  await app.open();
  await expect(page.locator('#tokens')).toBeVisible();
  await expect(page.locator('#tokens .tok-item')).toHaveCount(4);
  await expect(page.locator('#usage-collapse')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /hide usage|hide tokens/i })).toHaveCount(0);
  // not offered in the palette either
  await app.press('Meta+k');
  await page.keyboard.type('hide usage');
  await expect(page.locator('#palette-list')).not.toContainText(/usage strip/i);
});
