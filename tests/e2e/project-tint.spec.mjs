// T046 (user request): "when we set a session to a project, the main title
// of the session should be in a text color that matches" the project — dark
// theme tints the title text itself (AA on plain/selected/waiting row
// backgrounds); light theme tints the row/tile background instead (title
// stays --fg), distinct from the selected and waiting backgrounds. Fixture
// (state_sample.json): 1.1 is claude/waiting, project 1 (blue); 2.2 is
// project 2 (purple), unselected, plain; 2.3 has a tab_color but no project
// (no tint either way); 1.2 has neither.
import { test, expect, FIXTURE, U } from './fixtures.mjs';

const NOW = FIXTURE.now;
const cssVar = (page, name) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const hexToRgb = (hex) => {
  const h = hex.replace('#', '');
  return `rgb(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)})`;
};
function contrastOf([fr, fg_, fb], [br, bg_, bb]) {
  const chan = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  const [hi, lo] = [lum([fr, fg_, fb]), lum([br, bg_, bb])].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}
const rgbToArr = (s) => s.match(/\d+/g).map(Number).slice(0, 3);
async function ownContrast(loc) {
  const [fg_, bg_] = await loc.evaluate((el) => {
    const cs = getComputedStyle(el);
    return [cs.color, cs.backgroundColor];
  });
  return contrastOf(rgbToArr(fg_), rgbToArr(bg_));
}

test('T046 dark theme: a project session\'s title is tinted in the project color, AA on plain, selected, and waiting rows; no project → unchanged', async ({ app, page }) => {
  await app.open({ colorScheme: 'dark' });
  const blueText = hexToRgb(await cssVar(page, '--project-blue-text'));
  const purpleText = hexToRgb(await cssVar(page, '--project-purple-text'));
  const fg = hexToRgb(await cssVar(page, '--fg'));

  // 1.1: project 1 (blue), selected + waiting by default
  const row11 = app.row('1.1');
  await expect(row11).toHaveClass(/is-selected/);
  await expect(row11).toHaveClass(/is-waiting/);
  await expect(row11.locator('.row-name')).toHaveCSS('color', blueText);
  expect(await ownContrast(row11.locator('.row-name'))).toBeGreaterThanOrEqual(4.5);

  // 2.2: project 2 (purple), plain (unselected, not waiting)
  const row22 = app.row('2.2');
  await expect(row22).not.toHaveClass(/is-selected/);
  await expect(row22).not.toHaveClass(/is-waiting/);
  await expect(row22.locator('.row-name')).toHaveCSS('color', purpleText);
  expect(await ownContrast(row22.locator('.row-name'))).toBeGreaterThanOrEqual(4.5);
  // selected too: still tinted, still AA
  await row22.click();
  await expect(row22).toHaveClass(/is-selected/);
  await expect(row22.locator('.row-name')).toHaveCSS('color', purpleText);
  expect(await ownContrast(row22.locator('.row-name'))).toBeGreaterThanOrEqual(4.5);

  // 2.3: a tab color but no project — unchanged (plain --fg)
  await expect(app.row('2.3').locator('.row-name')).toHaveCSS('color', fg);
  // 1.2: no project, no tab color at all — unchanged
  await expect(app.row('1.2').locator('.row-name')).toHaveCSS('color', fg);
});

test('T046 light theme: a project session\'s title stays --fg; the row gets a subtle project-tinted background, distinct from selected/waiting', async ({ app, page }) => {
  await app.open({ colorScheme: 'light' });
  const fg = hexToRgb(await cssVar(page, '--fg'));
  const blueTint = hexToRgb(await cssVar(page, '--project-blue-tint'));
  const purpleTint = hexToRgb(await cssVar(page, '--project-purple-tint'));
  const selBg = hexToRgb(await cssVar(page, '--bg-selected'));
  const waitingBg = hexToRgb(await cssVar(page, '--row-waiting-bg'));

  // 2.2: project 2 (purple), plain — tinted background, title stays --fg
  const row22 = app.row('2.2');
  await expect(row22).not.toHaveClass(/is-selected/);
  await expect(row22.locator('.row-name')).toHaveCSS('color', fg);
  await expect(row22).toHaveCSS('background-color', purpleTint);
  expect(purpleTint).not.toBe(selBg);
  expect(purpleTint).not.toBe(waitingBg);

  // selecting it swaps to the ordinary selection color, not the tint —
  // selected rows are never confusable with a merely-tinted one
  await row22.click();
  await expect(row22).toHaveClass(/is-selected/);
  await expect(row22).toHaveCSS('background-color', selBg);

  // 1.1: project 1 (blue), waiting by default — the waiting bar color wins
  // over the tint too
  const row11 = app.row('1.1');
  await expect(row11).toHaveClass(/is-waiting/);
  const bg11 = await row11.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg11).not.toBe(blueTint);

  // no project (1.2): background is untinted (transparent, shows the pane)
  await expect(app.row('1.2')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
});

test('T046 project tint applies to grid tiles too: dark title tint, light background tint', async ({ app, page }) => {
  await app.open({ colorScheme: 'dark' });
  await app.press('Meta+3');
  const tile = page.locator(`.tile[data-uid="${U['1.1']}"]`);
  await expect(tile).toBeVisible();
  await expect(tile.locator('.tile-name')).toHaveCSS('color', hexToRgb(await cssVar(page, '--project-blue-text')));

  await page.emulateMedia({ colorScheme: 'light' });
  app.backend.setState((s) => ({ prefs: { ...s.prefs, theme: 'light' } }));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(tile).toHaveCSS('background-color', hexToRgb(await cssVar(page, '--project-blue-tint')));
  await expect(tile.locator('.tile-name')).toHaveCSS('color', hexToRgb(await cssVar(page, '--fg')));
});

// Light mode: the selected-row highlight is a neutral gray (not blue), so it
// can't be confused with the blue project tint.
// # parity: P-38
test('P-38 light-mode selection highlight is neutral gray, distinct from the blue project tint', async ({ app, page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await app.open();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg-selected').trim());
  const hex = bg.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(6); // neutral: no hue
  const blueTint = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--project-blue-tint').trim());
  expect(bg.toLowerCase()).not.toBe(blueTint.toLowerCase());
});
