import { test, expect, FIXTURE, U } from './fixtures.mjs';

const NOW = FIXTURE.now;
const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const bg = (loc) => loc.evaluate((el) => getComputedStyle(el).backgroundColor);
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
};

// WCAG relative luminance / contrast ratio, straight off `rgb(r, g, b)`
// strings from getComputedStyle — mirrors js/lib/theme.mjs's math (its own
// unit test proves the token *values*; this proves the *rendered pixels*
// on top of whatever's actually behind them at runtime: selected, waiting,
// hovered, etc).
function contrastOf([fr, fg_, fb], [br, bg_, bb]) {
  const chan = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const [hi, lo] = [lum([fr, fg_, fb]), lum([br, bg_, bb])].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const rgbToArr = (s) => s.match(/\d+/g).map(Number).slice(0, 3);
/** contrast ratio between an element's own text color and its own
 * background — reads both with getComputedStyle in one round trip. Only
 * meaningful for an opaque background (e.g. `.badge`); a transparent one
 * (e.g. `.row-project`, which shows the row through it) needs
 * `contrastAgainstRow` below instead. */
async function ownContrast(loc) {
  const [fg_, bg_] = await loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.color, cs.backgroundColor];
  });
  return contrastOf(rgbToArr(fg_), rgbToArr(bg_));
}

/** contrast ratio between `textLoc`'s text color and `rowLoc`'s own
 * (opaque) background — for chips that are transparent themselves and
 * only show a border, so the row's fill is what's actually behind them. */
async function contrastAgainstRow(textLoc, rowLoc) {
  // let the row's own background-color transition (selection, hover)
  // settle first — mid-transition it can still read as transparent
  await rowLoc.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const fg_ = await textLoc.evaluate((el) => getComputedStyle(el).color);
  // the first opaque background at or above the row (an unselected row is
  // transparent over the pane)
  const bg_ = await rowLoc.evaluate((el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c;
    }
    return getComputedStyle(document.body).backgroundColor;
  });
  return contrastOf(rgbToArr(fg_), rgbToArr(bg_));
}

// # parity: P-35
test('P-35 rows show glyph, badge, tab label, left-ellipsized path, display name, and age', async ({ app, page }) => {
  await app.open();
  const r = app.row('1.1');
  await expect(r.locator('.glyph')).toHaveClass(/glyph--waiting/);
  // §4.17: glyph + word ("Claude"), never "CC" — the backend's `badge`
  // field is only the old shorthand
  await expect(r.locator('.badge .badge-text')).toHaveText('Claude');
  await expect(r.locator('.badge')).toHaveClass(/badge--claude/);
  await expect(r.locator('.badge .badge-glyph use')).toHaveAttribute('href', '#i-agent-claude');
  await expect(r.locator('.badge')).toHaveAttribute('data-tip', 'Claude Code session');
  await expect(r.locator('.row-tab')).toHaveText('1.1');
  await expect(r.locator('.row-path')).toHaveText('‎~/src/api-gateway‎');
  await expect(r.locator('.row-name')).toHaveText('deploy-fix'); // label beats session name
  await expect(r.locator('.row-age')).toHaveText('wait 3m');
  await expect(app.row('2.1').locator('.badge .badge-text')).toHaveText('Codex');
  await expect(app.row('2.1').locator('.badge .badge-glyph use')).toHaveAttribute('href', '#i-agent-codex');
  await expect(app.row('1.4').locator('.badge .badge-text')).toHaveText('Shell');
  await expect(app.row('1.4').locator('.badge .badge-glyph use')).toHaveAttribute('href', '#i-terminal');
  await expect(page.locator('.split .row .badge')).not.toContainText(['CC']);
  await expect(app.row('1.2').locator('.glyph')).toHaveClass(/glyph--busy/);
  await expect(app.row('2.2').locator('.glyph')).toHaveClass(/glyph--idle/);
  await expect(app.row('2.3').locator('.glyph')).toHaveClass(/glyph--active/);
  await expect(app.row('1.4').locator('.glyph')).toHaveClass(/glyph--quiet/);
  const longPath = app.row('2.2').locator('.row-path');
  const dir = await longPath.evaluate((el) => ({ d: getComputedStyle(el).direction, o: getComputedStyle(el).textOverflow }));
  expect(dir).toEqual({ d: 'rtl', o: 'ellipsis' });
  // uniform age column: every age cell is right-aligned in the same column
  const rights = await page.locator('.split .row .row-age').evaluateAll((els) => [...new Set(els.map((e) => Math.round(e.getBoundingClientRect().right)))]);
  expect(rights).toHaveLength(1);
  // screen-reader label summarises the row
  await expect(r).toHaveAttribute('aria-label', /deploy-fix, Claude Code, waiting for input, for 3 minutes, ~\/src\/api-gateway, tab 1\.1, blue tab/);
  await expect(app.row('1.4')).toHaveAttribute('aria-label', /^-zsh, plain shell, quiet/);
  // glyph and tab tooltips say it in words (§4.19)
  await expect(r.locator('.glyph')).toHaveAttribute('data-tip', 'Waiting for you · 3 minutes');
  await expect(r.locator('.row-tab')).toHaveAttribute('data-tip', 'iTerm2 window 1, tab 1');
  await expect(page.locator('#session-list')).toHaveAttribute('role', 'listbox');
  await expect(r).toHaveAttribute('role', 'option');
});

// # parity: P-37
test('P-37 ages: wait {age} while waiting; idle {age} after 60 s; ticking locally with skew correction', async ({ app, page }) => {
  await app.open();
  await expect(app.row('1.3').locator('.row-age')).toHaveText('wait 1m');
  await expect(app.row('1.4').locator('.row-age')).toHaveText('idle 2h');
  await expect(app.row('2.4').locator('.row-age')).toHaveText('idle 3d');
  await expect(app.row('2.2').locator('.row-age')).toHaveText('idle 25m');
  await expect(app.row('1.2').locator('.row-age')).toHaveText(''); // busy: no age
  // server clock moves on → ages follow
  app.backend.setState({ now: NOW + 125 });
  await expect(app.row('1.1').locator('.row-age')).toHaveText('wait 5m');
  // idle under 60 s shows nothing; at 60 s it appears
  app.backend.patchSession(U['1.5'], { last_change: NOW + 125 - 59 });
  await expect(app.row('1.5').locator('.row-age')).toHaveText('');
  // local ticks advance ages between snapshots (skew-corrected clock)
  await page.clock.runFor(2000);
  await expect(app.row('1.5').locator('.row-age')).toHaveText('idle 1m');
});

// # parity: P-38 (D1-A: `~`, see docs/DESIGN.md)
test('P-38 row colours (D1-A): one neutral tinted selection, waiting bar + amber age + 600, fresh green age, names in --fg', async ({ app, page }) => {
  await app.open();
  const selBg = hexToRgb(await cssVar(page, '--bg-selected'));
  const fg = hexToRgb(await cssVar(page, '--fg'));
  const sel = app.row('1.1');
  await expect(sel).toHaveClass(/is-selected/);
  await expect(sel).toHaveAttribute('aria-selected', 'true');
  // selected + waiting: the neutral selection, and the waiting bar stays
  await expect(sel).toHaveCSS('background-color', selBg);
  expect(await sel.evaluate((el) => getComputedStyle(el, '::before').width)).toBe('3px');
  await expect(sel.locator('.row-age')).toHaveCSS('color', hexToRgb(await cssVar(page, '--attention')));
  // every kind gets the same selection color (kind is the badge's job)
  for (const tab of ['1.2', '2.1', '1.4']) {
    await app.row(tab).click();
    await expect(app.row(tab)).toHaveCSS('background-color', selBg);
    await expect(app.row(tab).locator('.row-name')).toHaveCSS('color', fg);
  }
  // selected, idle age → --fg-dim (--idle isn't AA on the selection)
  await app.row('2.2').click();
  await expect(app.row('2.2').locator('.row-age')).toHaveCSS('color', hexToRgb(await cssVar(page, '--fg-dim')));

  const waiting = app.row('1.1');
  await expect(waiting).toHaveClass(/is-waiting/);
  await expect(waiting).toHaveCSS('background-color', hexToRgb(await cssVar(page, '--row-waiting-bg')));
  // T046: 1.1 has a project (blue) — dark theme tints its title, not --fg
  await expect(waiting.locator('.row-name')).toHaveCSS('color', hexToRgb(await cssVar(page, '--project-blue-text')));
  await expect(waiting.locator('.row-name')).toHaveCSS('font-weight', '600');
  await expect(waiting.locator('.row-age')).toHaveCSS('color', hexToRgb(await cssVar(page, '--attention')));
  const fresh = app.row('1.5');
  await expect(fresh).toHaveClass(/is-fresh/);
  await expect(fresh.locator('.row-age')).toHaveText('just finished');
  await expect(fresh.locator('.row-age')).toHaveCSS('color', hexToRgb(await cssVar(page, '--busy')));
  await expect(fresh.locator('.row-name')).toHaveCSS('color', fg);
  await expect(app.row('2.3')).toHaveClass(/is-fresh/); // active + recent → green, no note
  await expect(app.row('2.3').locator('.row-age')).toHaveText('');
  const labeled = app.row('2.2');
  await expect(labeled).toHaveClass(/has-label/);
  // T046: 2.2 has a project too (purple)
  await expect(labeled.locator('.row-name')).toHaveCSS('color', hexToRgb(await cssVar(page, '--project-purple-text')));
  // fresh expires after 30 s
  app.backend.setState({ now: NOW + 40 });
  await expect(fresh).not.toHaveClass(/is-fresh/);
});

// # parity: P-38 (D1-A)
test('P-38 hovering a selected waiting row keeps the selection color; an unfocused window shows the inactive selection', async ({ app, page }) => {
  await app.open({ shell: true });
  const row = app.row('1.1');
  await expect(row).toHaveClass(/is-selected/);
  await expect(row).toHaveClass(/is-waiting/);
  const selBg = hexToRgb(await cssVar(page, '--bg-selected'));
  await expect(row).toHaveCSS('background-color', selBg);
  await row.hover();
  await expect(row).toHaveCSS('background-color', selBg);
  // T046: 1.1 has a project (blue) — dark theme tints its title, not --fg
  await expect(row.locator('.row-name')).toHaveCSS('color', hexToRgb(await cssVar(page, '--project-blue-text')));
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'focus', key: false }));
  await expect(page.locator('html')).toHaveAttribute('data-key', '0');
  await expect(row).toHaveCSS('background-color', hexToRgb(await cssVar(page, '--bg-selected-inactive')));
  await page.evaluate(() => window.everwatchNative.dispatch({ type: 'focus', key: true }));
  await expect(row).toHaveCSS('background-color', selBg);
});

// # parity: P-38, P-66
test('P-38 a transition to waiting flashes the row (soft amber, D1-A) for 1.5 s and toasts', async ({ app, page }) => {
  await app.open();
  const row = app.row('1.2');
  app.backend.emit('transition', { uid: U['1.2'], from: 'busy', to: 'waiting', at: NOW, title: 'web-dashboard' });
  await expect(row).toHaveClass(/is-flash/);
  await expect(app.toasts().last()).toHaveText('◉ web-dashboard is waiting for your input');
  await expect(app.toasts().last()).toHaveAttribute('data-level', 'attention');
  await page.clock.runFor(1000);
  await expect(row).toHaveClass(/is-flash/);
  await page.clock.runFor(1000);
  await expect(row).not.toHaveClass(/is-flash/);
  // transitions elsewhere don't flash
  app.backend.emit('transition', { uid: U['2.1'], from: 'busy', to: 'idle', at: NOW, title: 'terraform' });
  await expect(app.row('2.1')).not.toHaveClass(/is-flash/);
});

// # parity: P-38, P-34
test('P-38 under reduced motion the flash is a static highlight', async ({ app, page }) => {
  await app.open({ reducedMotion: 'reduce' });
  app.backend.emit('transition', { uid: U['2.1'], from: 'busy', to: 'waiting', at: NOW, title: 'terraform' });
  const row = app.row('2.1');
  await expect(row).toHaveClass(/is-flash/);
  await expect(row).toHaveCSS('background-color', hexToRgb(await cssVar(page, '--attention-soft')));
  await expect(row).toHaveCSS('animation-name', 'none');
});

// # parity: P-39, P-61
test('P-39 the project chip: a solid dot (exact iTerm2 preset RGB) plus the project name, "No project" when unset', async ({ app }) => {
  await app.open();
  const chip = app.row('1.1').locator('.row-project');
  await expect(chip).toBeVisible();
  await expect(chip.locator('.tab-dot')).toHaveCSS('background-color', 'rgb(95, 163, 248)');
  await expect(chip.locator('.row-project-name')).toHaveText('1 · API');
  await expect(chip).toHaveAttribute('aria-label', /Tab color: blue — project 1 “API”/);
  // §4.19: the tooltip is the project name + the iTerm2 tab color
  await expect(chip).toHaveAttribute('data-tip', 'API · iTerm2 tab color: blue (project 1) — click to change');

  const chip22 = app.row('2.2').locator('.row-project');
  await expect(chip22.locator('.tab-dot')).toHaveCSS('background-color', 'rgb(193, 142, 217)');
  await expect(chip22.locator('.row-project-name')).toHaveText('2 · Docs');

  // a tab color with no project slot number still names the color itself
  const chip23 = app.row('2.3').locator('.row-project');
  await expect(chip23.locator('.tab-dot')).toHaveCSS('background-color', 'rgb(181, 215, 73)');
  await expect(chip23.locator('.row-project-name')).toHaveText('Green'); // tab color without an assigned project
  await expect(chip23).toHaveAttribute('data-tip', /^Green · iTerm2 tab color: green/);

  // no color at all: still a visible chip, not a vanished dot
  const chip12 = app.row('1.2').locator('.row-project');
  await expect(chip12).toBeVisible();
  await expect(chip12.locator('.tab-dot')).toHaveClass(/tab-dot--none/);
  await expect(chip12.locator('.row-project-name')).toHaveText('No project');
});

// # parity: P-61
test('P-61 clicking the project chip opens the "Project" context menu (a second, obvious way in besides right-click)', async ({ app, page }) => {
  await app.open();
  await app.row('1.2').locator('.row-project').click();
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-label')).toHaveText('Project');
  await expect(menu.getByText('API')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

// # parity: P-39
for (const scheme of ['dark', 'light']) {
  test(`P-39/P-61 agent kind (Claude vs Codex), shells, and the project chip stay legible (AA) selected+waiting, selected, and unselected — ${scheme}`, async ({ app, page }) => {
    await app.open({ colorScheme: scheme });
    // 1.1: claude, waiting, selected by default
    const row11 = app.row('1.1');
    await expect(row11).toHaveClass(/is-selected/);
    await expect(row11).toHaveClass(/is-waiting/);
    const badge11 = row11.locator('.badge');
    await expect(badge11.locator('.badge-text')).toHaveText('Claude');
    // fully opaque (alpha 1): a translucent wash over the selected/waiting
    // fill (the old design) can look fine by getComputedStyle's own alpha-
    // blind color-distance yet still visually fade into that fill — opacity
    // is the property that actually guarantees it never blends away.
    await expect(badge11).toHaveCSS('background-color', /rgb\(\d+, \d+, \d+\)$/);
    expect(await ownContrast(badge11)).toBeGreaterThanOrEqual(4.5);
    expect(await contrastAgainstRow(row11.locator('.row-project'), row11)).toBeGreaterThanOrEqual(4.5);

    // 2.1: codex, selected, not waiting
    await app.row('2.1').click();
    const row21 = app.row('2.1');
    await expect(row21).toHaveClass(/is-selected/);
    const badge21 = row21.locator('.badge');
    await expect(badge21.locator('.badge-text')).toHaveText('Codex');
    await expect(badge21).toHaveCSS('background-color', /rgb\(\d+, \d+, \d+\)$/);
    expect(await ownContrast(badge21)).toBeGreaterThanOrEqual(4.5);
    expect(await contrastAgainstRow(row21.locator('.row-project'), row21)).toBeGreaterThanOrEqual(4.5);

    // 1.2: claude, unselected
    const row12 = app.row('1.2');
    await expect(row12).not.toHaveClass(/is-selected/);
    const badge12 = row12.locator('.badge');
    await expect(badge12.locator('.badge-text')).toHaveText('Claude');
    expect(await ownContrast(badge12)).toBeGreaterThanOrEqual(4.5);
    expect(await contrastAgainstRow(row12.locator('.row-project'), row12)).toBeGreaterThanOrEqual(4.5);
    // and the two kinds are genuinely different colors, not just different text
    const claudeColor = await badge12.evaluate((el) => getComputedStyle(el).color);
    const codexColor = await badge21.evaluate((el) => getComputedStyle(el).color);
    expect(claudeColor).not.toEqual(codexColor);

    // plain shell, selected and not: the outlined "Shell" badge text stays AA
    // against whatever row is behind it (the badge itself is transparent)
    const row14 = app.row('1.4');
    expect(await contrastAgainstRow(row14.locator('.badge'), row14)).toBeGreaterThanOrEqual(4.5);
    await row14.click();
    expect(await contrastAgainstRow(row14.locator('.badge'), row14)).toBeGreaterThanOrEqual(4.5);
    // waiting, not selected (1.3 codex)
    const row13 = app.row('1.3');
    await expect(row13).toHaveClass(/is-waiting/);
    expect(await ownContrast(row13.locator('.badge'))).toBeGreaterThanOrEqual(4.5);
    expect(await contrastAgainstRow(row13.locator('.row-project'), row13)).toBeGreaterThanOrEqual(4.5);
    expect(await contrastAgainstRow(row13.locator('.row-age'), row13)).toBeGreaterThanOrEqual(4.5);
  });
}

// "it should be really obvious from our session list which ones are agents
// and which ones are root sessions" — in every state and every view.
test('plain shells are visibly distinct from AI sessions: outlined "Shell" badge vs a filled agent badge, in split, list, grid', async ({ app, page }) => {
  await app.open();
  const shell = app.row('1.4');
  const agent = app.row('1.2');
  await expect(shell).toHaveClass(/is-shell/);
  await expect(agent).not.toHaveClass(/is-shell/);
  const look = (loc) => loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, ring: cs.boxShadow, color: cs.color };
  });
  const shellBadge = await look(shell.locator('.badge'));
  const agentBadge = await look(agent.locator('.badge'));
  expect(shellBadge.bg).toBe('rgba(0, 0, 0, 0)'); // outlined, no fill
  expect(shellBadge.ring).not.toBe('none');
  expect(agentBadge.bg).not.toBe('rgba(0, 0, 0, 0)'); // tinted fill
  expect(shellBadge.color).not.toBe(agentBadge.color);
  await expect(shell.locator('.row-name')).toHaveCSS('font-weight', '500');
  await expect(agent.locator('.row-name')).toHaveCSS('font-weight', '550');
  // still distinct when selected
  await shell.click();
  expect((await look(shell.locator('.badge'))).bg).toBe('rgba(0, 0, 0, 0)');
  await expect(shell.locator('.badge')).toHaveText('Shell');
  // list view keeps the badge (word at ≥ 900px)
  await app.press('Meta+2');
  await expect(app.row('1.4').locator('.badge')).toHaveClass(/badge--plain/);
  await expect(app.row('1.4').locator('.badge-text')).toBeVisible();
  await expect(app.row('1.1').locator('.badge-text')).toHaveText('Claude');
  // below 900px the list shows the glyph-only compact form
  await page.setViewportSize({ width: 860, height: 700 });
  await expect(app.row('1.1').locator('.badge-text')).toBeHidden();
  await expect(app.row('1.1').locator('.badge-glyph')).toBeVisible();
});

// # parity: P-34
test('P-34 busy spinner animates only while busy, and stops under prefers-reduced-motion', async ({ app, page }) => {
  await app.open();
  await expect(app.row('1.2').locator('.glyph')).toHaveCSS('animation-name', 'spin');
  await expect(app.row('2.2').locator('.glyph')).toHaveCSS('animation-name', 'none');
  app.backend.patchSession(U['1.2'], { state: 'idle' });
  await expect(app.row('1.2').locator('.glyph')).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(app.row('2.1').locator('.glyph')).toHaveClass(/glyph--busy/);
  await expect(app.row('2.1').locator('.glyph')).toHaveCSS('animation-name', 'none');
});
