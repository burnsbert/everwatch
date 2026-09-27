import { test, expect, FIXTURE, U } from './fixtures.mjs';

const NOW = FIXTURE.now;
const listWidth = (page) => page.locator('.list-pane').evaluate((el) => el.getBoundingClientRect().width);
const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
// The projects column's collapsed rail (§4.7) always reserves its own
// width on the main route now, so `.content` (the split view's parent) is
// `--rail-w` narrower than the raw viewport — every split-ratio pixel math
// below has to account for that the same way it already accounts for the
// 9px splitter.
const railW = (page) => cssVar(page, '--rail-w').then(parseFloat);

// # parity: P-22
test('P-22 split: < > step 0.05 with a toast, clamp 0.2–0.8, persisted via PATCH /api/prefs', async ({ app, page }) => {
  await app.open();
  const rail = await railW(page);
  // The projects column animates its width on load; wait for the layout to settle.
  await expect.poll(async () => Math.abs((await listWidth(page)) - 0.42 * (1280 - rail - 9))).toBeLessThan(2);
  const w0 = await listWidth(page);
  await app.press('>');
  await expect(app.toasts().last()).toHaveText('list pane 47% of width');
  await expect.poll(() => listWidth(page)).toBeGreaterThan(w0 + 50);
  expect(app.callsTo('PATCH', /\/api\/prefs$/).at(-1).body).toEqual({ split_ratio: 0.47 });
  await app.press('.');
  await expect(app.toasts().last()).toHaveText('list pane 52% of width');
  for (let i = 0; i < 8; i += 1) await app.press('<');
  await expect(app.toasts().last()).toHaveText('list pane 20% of width');
  await app.press(',');
  await expect(app.toasts().last()).toHaveText('list pane 20% of width');
  // 20% of (1280 - rail - 9) px is well below the 280 px list minimum
  await expect.poll(() => listWidth(page)).toBe(280);
  expect(app.backend.state.prefs.split_ratio).toBe(0.2);
  await expect(app.toasts()).toHaveCount(1); // one updating toast, not a stack
});

// # parity: P-22
test('P-22 split: the splitter drags, respects the preview minimum, and persists on release', async ({ app, page }) => {
  await app.open();
  const splitter = page.locator('.splitter');
  await expect(splitter).toHaveAttribute('role', 'separator');
  await expect(splitter).toHaveAttribute('aria-valuenow', '42');
  const box = await splitter.boundingBox();
  await page.mouse.move(box.x + 4, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => app.backend.state.prefs.split_ratio).toBeGreaterThan(0.5);
  const r = app.backend.state.prefs.split_ratio;
  await expect(splitter).toHaveAttribute('aria-valuenow', String(Math.round(r * 100)));
  // drag far right: ratio clamps at 0.8 and the preview keeps ≥ 320 px
  const b2 = await splitter.boundingBox();
  await page.mouse.move(b2.x + 4, b2.y + 200);
  await page.mouse.down();
  await page.mouse.move(1275, b2.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => app.backend.state.prefs.split_ratio).toBe(0.8);
  const listW = await listWidth(page);
  const rail = await railW(page);
  expect(1280 - rail - 9 - listW).toBeGreaterThanOrEqual(320 - 1);
  // keyboard on the focused splitter
  await splitter.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(app.toasts().last()).toHaveText('list pane 75% of width');
});

// # parity: P-23
test('P-23 below 900 px the split view renders as the list view', async ({ app, page }) => {
  await app.open();
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
  await page.setViewportSize({ width: 860, height: 700 });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
  await expect(page.locator('.listview')).toBeVisible();
  expect(app.backend.state.prefs.view).toBe('split'); // the pref itself is unchanged
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'split');
});

// # parity: P-24
test('P-24 list view: Window headers only in natural sort with >1 window, and a 3-line strip', async ({ app, page }) => {
  await app.open();
  await app.press('v');
  await expect(page.locator('#app')).toHaveAttribute('data-view', 'list');
  await expect(page.locator('.listview .group-header')).toHaveCount(0); // attention sort
  await page.locator('#sort-select').selectOption('natural');
  await expect(page.locator('.listview .group-header')).toHaveText(['Window 1', 'Window 2']);
  const strip = page.locator('.mini-strip');
  await expect(strip).toBeVisible();
  await expect(strip.locator('.strip-head')).toHaveText('❯ ~/src/api-gateway ─ last 3 lines');
  const lines = (await strip.locator('.strip-lines').textContent()).split('\n');
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain('3. No, and tell Claude what to do differently (esc)');
  await app.row('2.3').click();
  await expect(strip.locator('.strip-head')).toHaveText('❯ ~/logs ─ last 3 lines');
  await expect(strip.locator('.strip-lines')).toContainText('POST /v1/charges 502 upstream timeout');
  // only one window left → no headers
  app.backend.setState((s) => ({ sessions: s.sessions.filter((x) => x.window_no === 1) }));
  await expect(page.locator('.listview .group-header')).toHaveCount(0);
  // a short window hides the strip
  await page.setViewportSize({ width: 1280, height: 480 });
  await expect(strip).toBeHidden();
});

// # parity: P-27
test('P-27 preview: title parts, state chip, accent border, selectable monospace screen, freshness footer', async ({ app, page }) => {
  await app.open();
  const pv = page.locator('.split .preview');
  await expect(pv).toHaveAttribute('data-accent', 'waiting');
  await expect(pv.locator('.preview-name')).toHaveText('deploy-fix');
  // §4.6 meta line ends with the project name; the pill is sentence case
  await expect(pv.locator('.preview-meta')).toHaveText('~/src/api-gateway · deploy-fix · Claude Code · tab 1.1 · API');
  await expect(pv.locator('.state-pill')).toHaveText('Waiting 3m');
  await expect(pv.locator('.preview-title .badge')).toHaveText('Claude');
  await expect(pv.locator('.preview-chip')).toHaveClass(/tab-dot--blue/);
  await expect(pv.locator('.freshness')).toHaveText('live · updated just now');
  const screen = pv.locator('pre.screen');
  await expect(screen).toContainText('Do you want to proceed?');
  const css = await screen.evaluate((el) => ({ font: getComputedStyle(el).fontFamily, sel: getComputedStyle(el).userSelect }));
  expect(css.font).toMatch(/ui-monospace|SF Mono|Menlo/);
  expect(css.sel).toBe('text');

  await app.row('1.2').click(); // busy claude: no age on the chip
  await expect(pv).toHaveAttribute('data-accent', 'claude');
  await expect(pv.locator('.state-pill')).toHaveText('Busy');
  await app.row('2.1').click();
  await expect(pv).toHaveAttribute('data-accent', 'codex');
  await expect(pv.locator('.preview-meta')).toHaveText('~/src/infra/terraform-modules/aws · Codex · tab 2.1');
  await app.row('1.4').click(); // quiet shell: no state pill, a "Shell" badge
  await expect(pv).toHaveAttribute('data-accent', 'plain');
  await expect(pv.locator('.state-pill')).toBeHidden();
  await expect(pv.locator('.preview-title .badge')).toHaveClass(/badge--plain/);
  await expect(pv.locator('.preview-meta')).toContainText('Plain shell');
  await app.row('2.2').click(); // idle with a label
  await expect(pv.locator('.state-pill')).toHaveText('Idle 25m');

  app.backend.setState({ iterm: { status: 'ok', error: '', snapshot_at: NOW - 5 } });
  await expect(pv.locator('.freshness')).toHaveText('updated 5s ago');

  // sticks to the bottom as text grows
  const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
  app.backend.setScreens({ [U['2.2']]: long });
  await expect(screen).toContainText('line 199');
  const gap = await screen.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  expect(gap).toBeLessThan(2);
  // the go button goes to the session
  await pv.getByRole('button', { name: 'Go to Session' }).click(); // D5 title case
  await expect.poll(() => app.callsTo('POST', /\/goto$/).at(-1)?.path).toBe(`/api/sessions/${U['2.2']}/goto`);
});

// # parity: P-45
test('P-45 the selection is kept in view while moving through a long list', async ({ app, page }) => {
  const many = structuredClone(FIXTURE);
  const base = many.sessions[3];
  many.sessions = Array.from({ length: 40 }, (_, i) => ({
    ...base, uid: `UID-${String(i).padStart(3, '0')}`, tab_index: i + 1, tab_label: `1.${i + 1}`, window_no: 1, window_id: 1,
    path: `~/src/project-${i}`, name: `-zsh ${i}`, display_name: `-zsh ${i}`,
  }));
  many.screens = {};
  many.waiting_order = [];
  many.counts = { tabs: 40, agents: 0, waiting: 0 };
  await app.open({ fixture: many });
  for (let i = 0; i < 30; i += 1) await app.press('j');
  const sel = page.locator('.split .row.is-selected');
  await expect(sel).toHaveAttribute('data-uid', 'UID-030');
  const inView = await sel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const p = el.closest('.session-list').getBoundingClientRect();
    return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
  });
  expect(inView).toBe(true);
  const scrolled = await page.locator('#session-list').evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
});
