import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  THEMES, normalizeTheme, resolveTheme, applyTheme, parseColor, luminance, contrastRatio,
  CONTRAST_PAIRS, NONTEXT_PAIRS, AA, AA_NONTEXT, nextTheme, THEME_LABELS,
} from '../../everwatch/web/js/lib/theme.mjs';

const css = readFileSync(new URL('../../everwatch/web/css/tokens.css', import.meta.url), 'utf8');

/** Custom properties of the first rule after a `/* @palette NAME *\/` marker. */
function palette(marker) {
  const at = css.indexOf(`/* @palette ${marker}`);
  assert.ok(at >= 0, `missing palette marker ${marker}`);
  const open = css.indexOf('{', css.indexOf('*/', at));
  let body = css.slice(open + 1);
  // @media wraps one more block
  if (/^\s*html:not/.test(body)) body = body.slice(body.indexOf('{') + 1);
  body = body.slice(0, body.indexOf('}'));
  const vars = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

/** Retired-name aliases (VISUAL_SPEC.md §3.7): `--old: var(--new);` pairs. */
function aliases() {
  const at = css.indexOf('/* @aliases');
  assert.ok(at >= 0, 'missing @aliases marker');
  const open = css.indexOf('{', css.indexOf('*/', at));
  const body = css.slice(open + 1, css.indexOf('}', open));
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    const ref = /^var\((--[\w-]+)\)$/.exec(m[2].trim());
    assert.ok(ref, `alias ${m[1]} must be exactly var(--token), got ${m[2]}`);
    out[m[1]] = ref[1];
  }
  return out;
}

const dark = palette('dark');
const light = palette('light */');
const lightSystem = palette('light (system)');
const ALIASES = aliases();

/** A palette with every alias resolved to its target's value in that palette. */
function withAliases(pal) {
  const out = { ...pal };
  for (const [name, target] of Object.entries(ALIASES)) if (target in pal) out[name] = pal[target];
  return out;
}
const darkAll = withAliases(dark);
const lightAll = withAliases(light);

test('palettes parse and the system light copy equals the forced light palette', () => {
  assert.ok(Object.keys(dark).length > 30);
  assert.deepEqual(lightSystem, light);
  assert.deepEqual(Object.keys(light).sort(), Object.keys(dark).sort(), 'same token names in both');
});

test('§3.6 semantic tokens exist', () => {
  for (const t of ['--bg', '--bg-elev', '--fg', '--fg-dim', '--chrome', '--accent-claude', '--accent-codex',
    '--attention', '--busy', '--idle', '--danger', '--warn', '--label', '--flash-bg']) {
    assert.ok(darkAll[t] && lightAll[t], t);
  }
  assert.equal(dark['--attention'], '#ffaf00', 'dark amber is #FFAF00');
});

test('VISUAL_SPEC §3.3/§3.4 tokens exist in both palettes', () => {
  for (const t of ['--bg-chrome', '--bg-selected', '--bg-selected-inactive', '--accent-hover', '--accent-fg',
    '--danger-fill', '--warn-fill', '--meter-track', '--meter-track-ring', '--badge-bg', '--chip-ring',
    '--agent-claude', '--agent-claude-bg', '--agent-codex', '--agent-codex-bg',
    '--shadow-1', '--shadow-2', '--shadow-3', '--backdrop']) {
    assert.ok(dark[t] && light[t], t);
  }
  // quota "yellow" is a true yellow, distinct from waiting amber (§3.4 --warn)
  assert.equal(dark['--warn'], '#ffd60a');
  assert.notEqual(dark['--warn'], dark['--attention']);
  assert.equal(dark['--danger-fill'], '#c62828');
  assert.equal(light['--danger-fill'], '#c62828');
});

test('§3.7 aliases point at real tokens and are not redefined by a palette', () => {
  const baseVars = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const [name, target] of Object.entries(ALIASES)) {
    assert.ok(target in dark || baseVars.has(target), `${name} → ${target} is defined`);
    assert.ok(!(name in dark) && !(name in light), `${name} is an alias, not a palette token`);
  }
  for (const retired of ['--sel-claude-bg', '--sel-codex-bg', '--sel-plain-bg', '--sel-plain-fg', '--badge-plain-bg',
    '--accent-claude', '--accent-codex', '--badge-claude-bg', '--badge-codex-bg', '--label', '--row-fresh-bg']) {
    assert.ok(retired in ALIASES, `${retired} is aliased`);
  }
  assert.equal(ALIASES['--sel-claude-bg'], '--bg-selected');
  assert.equal(ALIASES['--label'], '--fg');
});

test('tab-color tokens are the exact iTerm2 preset RGB values', () => {
  const presets = {
    red: [251, 107, 98], orange: [246, 172, 71], yellow: [240, 220, 79], green: [181, 215, 73],
    blue: [95, 163, 248], purple: [193, 142, 217], gray: [120, 120, 120],
  };
  for (const [name, rgb] of Object.entries(presets)) {
    const m = new RegExp(`--tab-${name}:\\s*([^;]+);`).exec(css);
    assert.ok(m, name);
    assert.deepEqual(parseColor(m[1]), rgb, name);
  }
});

for (const [name, pal] of [['dark', darkAll], ['light', lightAll]]) {
  test(`WCAG AA (4.5:1) for every text/background pair — ${name}`, () => {
    const failures = [];
    for (const [fg, bg] of CONTRAST_PAIRS) {
      assert.ok(pal[fg], `${name} missing ${fg}`);
      assert.ok(pal[bg], `${name} missing ${bg}`);
      const r = contrastRatio(pal[fg], pal[bg]);
      if (r < AA) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
    assert.ok(CONTRAST_PAIRS.length >= 70);
  });

  test(`WCAG 1.4.11 (3:1) for every non-text pair — ${name}`, () => {
    const failures = [];
    for (const [fg, bg] of NONTEXT_PAIRS) {
      assert.ok(pal[fg], `${name} missing ${fg}`);
      assert.ok(pal[bg], `${name} missing ${bg}`);
      const r = contrastRatio(pal[fg], pal[bg]);
      if (r < AA_NONTEXT) failures.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('the spec-mandated pairs are in CONTRAST_PAIRS (§3.7) and the retired ones are gone', () => {
  const has = (a, b) => CONTRAST_PAIRS.some(([x, y]) => x === a && y === b);
  for (const [a, b] of [['--on-accent', '--danger-fill'], ['--fg', '--bg-selected'], ['--fg-dim', '--bg-selected'],
    ['--attention', '--bg-selected'], ['--busy', '--bg-selected'], ['--warn', '--bg-chrome'], ['--warn', '--bg-popover'],
    ['--fg', '--bg-chrome'], ['--fg-dim', '--bg-chrome'], ['--idle', '--bg-chrome'], ['--accent-fg', '--bg-pane'],
    ['--accent-fg', '--bg-popover'], ['--fg-dim', '--row-waiting-bg'], ['--fg-dim', '--bg-selected-inactive']]) {
    assert.ok(has(a, b), `${a} on ${b}`);
  }
  for (const [a, b] of CONTRAST_PAIRS) assert.ok(!/^--sel-/.test(b), `retired selection pair ${a} on ${b}`);
});

test('contrast math matches known WCAG values', () => {
  assert.equal(contrastRatio('#000', '#fff').toFixed(1), '21.0');
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.equal(contrastRatio([0, 0, 0], 'rgb(255, 255, 255)').toFixed(1), '21.0');
  assert.equal(contrastRatio('#777777', '#ffffff').toFixed(2), '4.48');
  assert.equal(luminance([255, 255, 255]), 1);
  assert.equal(parseColor('nope'), null);
  assert.equal(parseColor(undefined), null);
  assert.throws(() => contrastRatio('red', '#fff'), /unparseable/);
});

test('theme resolution: system follows the OS, explicit wins', () => {
  assert.deepEqual(THEMES, ['system', 'dark', 'light']);
  assert.equal(normalizeTheme('weird'), 'system');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme(undefined, true), 'dark');
});

// Toolbar icon and action point to the opposite visible palette.
test('nextTheme switches the visible palette, including system appearance', () => {
  assert.equal(nextTheme('light'), 'dark');
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('system', false), 'dark');
  assert.equal(nextTheme('system', true), 'light');
  assert.equal(nextTheme(undefined), 'dark', 'unset/unknown normalises to system first');
  assert.equal(nextTheme('weird'), 'dark');
  assert.deepEqual(Object.keys(THEME_LABELS).sort(), ['dark', 'light', 'system']);
});

test('applyTheme sets or removes html[data-theme]', () => {
  const attrs = {};
  const root = {
    dataset: {},
    setAttribute: (k, v) => { attrs[k] = v; },
    removeAttribute: (k) => { delete attrs[k]; },
  };
  assert.equal(applyTheme(root, 'light', true), 'light');
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(root.dataset.resolvedTheme, 'light');
  assert.equal(applyTheme(root, 'system', true), 'dark');
  assert.equal('data-theme' in attrs, false);
  assert.equal(applyTheme(root, 'dark', false), 'dark');
  assert.equal(attrs['data-theme'], 'dark');
});
