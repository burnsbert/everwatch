// Tokens Used strip (status bar) + pace/hit alert chips, T046 (reworks
// T040 / docs/design/VISUAL_SPEC.md §4.18 per user feedback). User
// requirements: every quota shown with yellow/red warnings and severity
// meters unchanged; every on-pace-to-run-out warning and every hit limit
// gets its own small chip, side by side, in the bottom strip only — no
// toolbar chip at all; full names on hover.
import { test, expect, FIXTURE } from './fixtures.mjs';
import { clock12 } from '../../everwatch/web/js/lib/limits.mjs';

const NOW = FIXTURE.now;
const iso = (t) => new Date(t * 1000).toISOString();
const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
};

const row = (over) => ({
  label: 'X', pct: 10, level: 'green', hit: false, projection: null, reset_at: iso(NOW + 3 * 3600), reset_text: '3h 0m', dollars: null, ...over,
});

/** Every quota the backend can report, both providers. */
const ALL = {
  claude: {
    status: 'ok',
    at: NOW,
    rows: [
      row({ id: 'cc.five_hour', label: 'CC Session Limit', pct: 62, level: 'yellow', projection: { hit: false, at: iso(NOW + 5400), text: 'on pace…' } }),
      row({ id: 'cc.seven_day', label: 'CC Weekly Limit', pct: 34 }),
      row({ id: 'cc.seven_day_sonnet', label: 'CC Sonnet Limit', pct: 100, level: 'red', hit: true, projection: { hit: true, at: null, text: 'sonnet limit hit' } }),
      row({ id: 'cc.monthly', label: 'CC Monthly Limit', pct: 84, level: 'red' }),
    ],
  },
  codex: {
    status: 'ok',
    at: NOW,
    rows: [row({ id: 'cx.five_hour', label: 'CX 5h Limit', pct: 18 }), row({ id: 'cx.seven_day', label: 'CX 7d Limit', pct: 58, level: 'yellow' })],
  },
};

const item = (page, id) => page.locator(`#tokens .tok-item[data-id="${id}"]`);
const alertChip = (page, id) => page.locator(`#tokens-alerts .tok-alert[data-id="${id}"]`);

test('T040 the "Tokens Used" strip is always visible in the status bar and lists every quota of both providers', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  const strip = page.locator('#tokens');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.tokens-label-full')).toHaveText('Tokens Used');
  await expect(strip.locator('.tok-provider-name')).toHaveText(['Claude Code', 'Codex']);
  await expect(strip.locator('.tok-group[data-provider="claude"] .tok-full')).toHaveText(['Session', 'Weekly', 'Sonnet', 'Monthly']);
  await expect(strip.locator('.tok-group[data-provider="codex"] .tok-full')).toHaveText(['5h', 'Weekly']);
  await expect(strip.locator('.tok-pct')).toHaveText(['62%', '34%', '100%', '84%', '18%', '58%']);
  // never "CC"/"CX" in the UI
  await expect(strip).not.toContainText(/\b(CC|CX)\b/);
  // it stays on the Usage/Settings pages too (only onboarding hides the bar)
  await app.press('u');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(strip).toBeVisible();
  await app.press('Escape');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await expect(strip).toBeVisible();
});

test('T040 severity: 49% calm, 50% and 79% yellow, 80% red, 100% hit (from the backend level) — meters/pct unchanged by T046', async ({ app, page }) => {
  const rows = [
    row({ id: 'cc.five_hour', pct: 49, level: 'green' }),
    row({ id: 'cc.seven_day', pct: 50, level: 'yellow' }),
    row({ id: 'cc.seven_day_sonnet', pct: 79, level: 'yellow' }),
    row({ id: 'cc.monthly', pct: 80, level: 'red' }),
    row({ id: 'cc.extra', pct: 100, level: 'red', hit: true }),
  ];
  app.backend.setState({ usage: { claude: { status: 'ok', at: NOW, rows }, codex: { status: 'inactive', rows: [] } } });
  await app.open();
  const fill = (id) => item(page, id).locator('.tok-fill');
  const pct = (id) => item(page, id).locator('.tok-pct');
  const fgDim = hexToRgb(await cssVar(page, '--fg-dim'));
  const warnFill = hexToRgb(await cssVar(page, '--warn-fill'));
  const warn = hexToRgb(await cssVar(page, '--warn'));
  const danger = hexToRgb(await cssVar(page, '--danger'));

  await expect(item(page, 'cc.five_hour')).toHaveAttribute('data-state', 'ok');
  await expect(fill('cc.five_hour')).toHaveCSS('background-color', fgDim);
  await expect(pct('cc.five_hour')).toHaveCSS('color', fgDim);
  for (const id of ['cc.seven_day', 'cc.seven_day_sonnet']) {
    await expect(item(page, id)).toHaveAttribute('data-state', 'yellow');
    await expect(fill(id)).toHaveCSS('background-color', warnFill);
    await expect(pct(id)).toHaveCSS('color', warn);
  }
  await expect(item(page, 'cc.monthly')).toHaveAttribute('data-state', 'red');
  await expect(fill('cc.monthly')).toHaveCSS('background-color', danger);
  await expect(pct('cc.monthly')).toHaveCSS('color', danger);
  await expect(item(page, 'cc.extra')).toHaveAttribute('data-state', 'hit');
  await expect(fill('cc.extra')).toHaveCSS('background-color', danger);
  // T046: the hit mark itself moved out of the meter item, into its own chip
  await expect(item(page, 'cc.extra').locator('.tok-icon--hit')).toHaveCount(0);
  await expect(alertChip(page, 'cc.extra')).toHaveAttribute('data-kind', 'hit');
  // the inactive provider collapses to its name + "Not running"
  await expect(page.locator('#tokens .tok-group[data-provider="codex"] .tok-note')).toHaveText('Not running');
});

test('T046 the toolbar has no quota chip: every on-pace/hit warning is its own small chip in the bottom strip, side by side', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  await expect(page.locator('#token-chip')).toHaveCount(0);
  const alerts = page.locator('#tokens-alerts .tok-alert');
  // hit (Sonnet) then pace, earliest run-out first (5h session before the
  // weekly quota, which has no projection.at in this fixture)
  await expect(alerts).toHaveCount(2);
  await expect(alerts.nth(0)).toHaveAttribute('data-kind', 'hit');
  await expect(alerts.nth(0).locator('.tok-alert-full')).toHaveText('Claude Sonnet');
  await expect(alerts.nth(1)).toHaveAttribute('data-kind', 'pace');
  await expect(alerts.nth(1).locator('.tok-alert-full')).toHaveText(`Claude 5h · ${clock12(NOW + 5400)}`);
  // the two chips sit side by side (same row, not stacked)
  const [t0, t1] = [await alerts.nth(0).boundingBox(), await alerts.nth(1).boundingBox()];
  expect(Math.abs(t0.y - t1.y)).toBeLessThan(2);
  expect(t1.x).toBeGreaterThan(t0.x);
  // neither reads "CC"/"CX", and they live in the bottom strip, not the toolbar
  await expect(page.locator('#tokens-alerts')).not.toContainText(/\b(CC|CX)\b/);
  await expect(page.locator('.toolbar')).not.toContainText(/Sonnet|runs out/);
});

test('T046 the pace chip carries the full-detail tooltip: full limit name, % used, reset time and run-out time', async ({ app, page }) => {
  const at = NOW + 5400;
  app.backend.setState({
    usage: {
      claude: { status: 'ok', at: NOW, rows: [row({ id: 'cc.seven_day', pct: 34, level: 'green', projection: { hit: false, at: iso(at), text: 'on pace' } })] },
      codex: { status: 'inactive', rows: [] },
    },
  });
  await app.open();
  const chip = alertChip(page, 'cc.seven_day');
  await expect(chip).toHaveAttribute('data-kind', 'pace');
  await expect(chip.locator('.tok-alert-full')).toHaveText(`Claude 7d · ${clock12(at)}`);
  const tooltip = page.locator('#tooltip');
  await chip.hover();
  await page.clock.runFor(550);
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip.locator('.tip-title')).toHaveText('Claude Code — weekly limit');
  await expect(tooltip.locator('.tip-body')).toHaveText(`34% used · resets today at ${clock12(NOW + 3 * 3600)}`);
  await expect(tooltip.locator('.tip-line--warn')).toHaveText(`On pace to run out at ${clock12(at)}, before it resets`);
});

test('T046 the hit chip carries the full-detail tooltip and opens Usage on click', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  const chip = alertChip(page, 'cc.seven_day_sonnet');
  await expect(chip).toHaveAttribute('data-kind', 'hit');
  const tooltip = page.locator('#tooltip');
  await chip.focus();
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip.locator('.tip-title')).toHaveText('Claude Code — weekly Sonnet limit');
  await expect(tooltip.locator('.tip-line--danger')).toHaveText(/^Limit reached · resets /);
  await chip.click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(page.locator('.usage-page .meter[data-limit-id="cc.seven_day_sonnet"]')).toBeVisible();
});

test('T040 hover or keyboard focus on a quota meter shows its full name, usage and reset (the pace/hit line is only on the alert chip now)', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  const tooltip = page.locator('#tooltip');
  await item(page, 'cc.monthly').hover();
  await page.clock.runFor(550);
  await expect(tooltip).toHaveClass(/is-visible/);
  await expect(tooltip.locator('.tip-title')).toHaveText('Claude Code — monthly limit');
  await expect(tooltip.locator('.tip-body')).toHaveText(`84% used · resets today at ${clock12(NOW + 3 * 3600)}`);
  await page.mouse.move(0, 0);
  await page.clock.runFor(150);
  await expect(tooltip).not.toHaveClass(/is-visible/);
});

test('T040 clicking a quota opens Usage', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  await item(page, 'cx.seven_day').click();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'usage');
  await expect(page.locator('.usage-page .meter[data-limit-id="cx.seven_day"]')).toBeVisible();
});

test('T040/T046 narrow widths step the strip down (§4.18.4) instead of hiding it; alert chips drop their label before the meter items reduce; the tooltip still has every quota', async ({ app, page }) => {
  app.backend.setState({ usage: ALL });
  await app.open();
  const bar = page.locator('#statusbar');
  const noOverflow = () => bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  await page.setViewportSize({ width: 2200, height: 800 });
  await expect(bar).toHaveAttribute('data-fit', '0');
  await expect(page.locator('#hints')).toBeVisible();
  await expect(alertChip(page, 'cc.seven_day_sonnet').locator('.tok-alert-full')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 800 });
  await expect.poll(async () => Number(await bar.getAttribute('data-fit'))).toBeGreaterThanOrEqual(2);
  expect(await noOverflow()).toBe(true);
  // alert chips drop to icon + time (or icon-only for a hit) at fit ≥ 2
  await expect(alertChip(page, 'cc.seven_day_sonnet').locator('.tok-alert-full')).toBeHidden();
  await expect(alertChip(page, 'cc.five_hour').locator('.tok-alert-short')).toHaveText(new RegExp(`\\d{1,2}:\\d{2} [AP]M`));
  await page.setViewportSize({ width: 800, height: 800 });
  await expect.poll(async () => Number(await bar.getAttribute('data-fit'))).toBeGreaterThanOrEqual(4);
  expect(await noOverflow()).toBe(true);
  await expect(page.locator('#hints')).toBeHidden();
  await page.setViewportSize({ width: 480, height: 700 });
  await expect.poll(async () => Number(await bar.getAttribute('data-fit'))).toBeGreaterThanOrEqual(5);
  expect(await noOverflow()).toBe(true);
  // worst per provider: the hit Sonnet quota for Claude, weekly for Codex
  await expect(page.locator('#tokens .tok-item:visible')).toHaveCount(2);
  await expect(item(page, 'cc.seven_day_sonnet')).toBeVisible();
  await expect(item(page, 'cx.seven_day')).toBeVisible();
  await expect(page.locator('#tokens .tok-provider-word:visible')).toHaveText(['Claude', 'Codex']);
  // worst alert chip only: hit beats pace, so only the Sonnet hit chip stays
  await expect(page.locator('#tokens-alerts .tok-alert:visible')).toHaveCount(1);
  await expect(alertChip(page, 'cc.seven_day_sonnet')).toBeVisible();
  await item(page, 'cc.seven_day_sonnet').hover();
  await page.clock.runFor(550);
  await expect(page.locator('#tooltip .tip-title')).toHaveText('Claude Code — tokens used');
  await expect(page.locator('#tooltip .tip-line')).toHaveCount(4);
});

test('T040 a failing fetch keeps the last data and flags it; a missing token says "Not connected"', async ({ app, page }) => {
  app.backend.setState({
    usage: {
      claude: { ...ALL.claude, status: 'stale', at: NOW - 720 },
      codex: { status: 'no_token', rows: [] },
    },
  });
  await app.open();
  const warn = page.locator('#tokens .tok-group[data-provider="claude"] .tok-warn');
  await expect(warn).toBeVisible();
  await expect(warn).toHaveAttribute('data-tip', 'Usage fetch failing — showing data from 12m ago');
  await expect(page.locator('#tokens .tok-group[data-provider="codex"] .tok-note')).toHaveText('Not connected');
});
