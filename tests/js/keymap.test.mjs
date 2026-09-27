import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BINDINGS, CONTEXTS, keyOf, resolve, resolveEvent, conflicts, displayKey, displayKeys,
  helpSections, hintsFor, footerHintsFor, shortcutFor, paletteCommands,
} from '../../everwatch/web/js/keymap.mjs';

const ev = (key, mods = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('keyOf normalises KeyboardEvents', () => {
  assert.equal(keyOf(ev('j')), 'j');
  assert.equal(keyOf(ev('A', { shiftKey: true })), 'A');
  assert.equal(keyOf(ev('?', { shiftKey: true })), '?');
  assert.equal(keyOf(ev(' ')), 'Space');
  assert.equal(keyOf(ev('K', { metaKey: true, shiftKey: true })), 'Meta+Shift+k');
  assert.equal(keyOf(ev('k', { metaKey: true })), 'Meta+k');
  assert.equal(keyOf(ev('F', { metaKey: true, shiftKey: true })), 'Meta+Shift+f');
  assert.equal(keyOf(ev('ArrowUp', { shiftKey: true })), 'Shift+ArrowUp');
  assert.equal(keyOf(ev('Enter', { metaKey: true })), 'Meta+Enter');
  assert.equal(keyOf(ev('x', { ctrlKey: true, altKey: true })), 'Ctrl+Alt+x');
  for (const k of ['Shift', 'Meta', 'Control', 'Alt', 'Dead', 'Unidentified', '']) assert.equal(keyOf(ev(k)), null, k);
});

test('no key is bound twice in one context', () => {
  assert.deepEqual(conflicts(), []);
  assert.deepEqual(conflicts([{ id: 'a', keys: ['x'], contexts: ['main'] }, { id: 'b', keys: ['x'], contexts: ['main'] }]),
    ['main x']);
});

test('every binding resolves to its command in every context it lists', () => {
  let n = 0;
  for (const b of BINDINGS) {
    assert.ok(b.contexts.every((c) => CONTEXTS.includes(c)), b.id);
    for (const c of b.contexts) {
      for (const k of b.keys) {
        assert.deepEqual(resolve(k, c), { id: b.id, args: b.args || {} }, `${c} ${k}`);
        n += 1;
      }
    }
  }
  assert.ok(n > 100);
});

// Every key from the §1 parity matrix, as (context, key, command).
const PARITY_KEYS = [
  // P-22 split resize
  ['main', '>', 'split.grow'], ['main', '.', 'split.grow'], ['main', '<', 'split.shrink'], ['main', ',', 'split.shrink'],
  // P-26 zoom
  ['main', 'Space', 'zoom.open'], ['zoom', 'ArrowUp', 'select.up'], ['zoom', 'k', 'select.up'],
  ['zoom', 'j', 'select.down'], ['zoom', 'Escape', 'zoom.exit'], ['zoom', 'Space', 'zoom.exit'], ['zoom', 'x', 'zoom.exit'],
  // P-25 / P-50 grid
  ['grid', 'ArrowLeft', 'grid.left'], ['grid', 'ArrowRight', 'grid.right'], ['grid', 'ArrowUp', 'grid.up'],
  ['grid', 'j', 'grid.down'], ['grid', 'A', 'grid.toggleAll'], ['main', 'A', null],
  // P-30 help
  ['main', '?', 'help.open'], ['main', 'Meta+/', 'help.open'], ['help', 'x', 'help.close'], ['help', 'Escape', 'help.close'],
  // P-41 navigation
  ['main', 'ArrowUp', 'select.up'], ['main', 'k', 'select.up'], ['main', 'ArrowDown', 'select.down'], ['main', 'j', 'select.down'],
  ['main', 'Enter', 'session.goto'], ['main', 'g', 'session.goto'], ['main', 'Meta+Enter', 'session.goto'], ['main', 'a', 'waiting.next'],
  // P-43 quit / unwind
  ['main', 'q', 'app.quitHint'], ['main', 'Q', 'app.quitHint'], ['main', 'Escape', 'escape.unwind'],
  // P-46 filter
  ['main', '/', 'filter.focus'], ['main', 'Meta+f', 'filter.focus'], ['filter', 'Enter', 'filter.keep'],
  ['filter', 'Escape', 'filter.clear'], ['filter', 'j', null],
  // P-47 sort, P-48 label, P-49 view
  ['main', 's', 'sort.cycle'], ['main', 'l', 'label.edit'], ['label', 'Enter', 'label.save'], ['label', 'Escape', 'label.cancel'],
  ['main', 'v', 'view.cycle'], ['main', 'Meta+1', 'view.split'], ['main', 'Meta+2', 'view.list'], ['main', 'Meta+3', 'view.grid'],
  // P-10 refresh, P-57 usage, P-58 dollars
  ['main', 'r', 'session.refresh'], ['main', 'Meta+r', 'session.refresh'], ['main', 'u', 'usage.open'],
  ['usage', 'u', 'usage.close'], ['usage', 'Escape', 'usage.close'], ['usage', '$', 'dollars.toggle'], ['usage', 'r', 'session.refresh'],
  ['main', '$', 'dollars.toggle'],
  // P-61..P-65 projects, colors, tabs
  ['main', 'p', 'projects.toggle'], ['main', '0', 'color.clear'], ['main', 'c', 'projects.clear'],
  ['main', 'n', 'tab.new'], ['main', 'x', 'tab.close'], ['dialog', 'y', 'dialog.confirm'], ['dialog', 'Escape', 'dialog.cancel'],
  // P-67 sound; W-3 palette; W-7 compact; W-8 search
  ['main', 'b', 'sound.toggle'], ['main', 'Meta+k', 'palette.open'], ['main', 'Ctrl+k', 'palette.open'],
  ['main', 'Meta+\\', 'compact.toggle'],
  ['main', 'Meta+Shift+f', 'search.screens'], ['main', 'Meta+,', 'settings.open'],
  // stub pages go back with esc
  ['page', 'Escape', 'route.back'],
];

// # parity: P-22, P-30, P-41, P-43, P-46, P-47, P-48, P-49
test('parity-matrix keys resolve to the right commands', () => {
  for (const [ctx, key, id] of PARITY_KEYS) {
    const r = resolve(key, ctx);
    assert.equal(r ? r.id : null, id, `${ctx} ${key}`);
  }
  for (let d = 1; d <= 5; d += 1) assert.deepEqual(resolve(String(d), 'main'), { id: 'color.assign', args: { slot: d } });
  assert.equal(resolve(null, 'main'), null);
  assert.equal(resolve('Meta+z', 'zoom'), null, 'modifier chords do not exit zoom');
  assert.equal(resolveEvent(ev('j'), 'main').id, 'select.down');
});

test('displayKey renders mac glyphs', () => {
  assert.equal(displayKey('Meta+k'), '⌘K');
  assert.equal(displayKey('Meta+Shift+f'), '⌘⇧F');
  assert.equal(displayKey('ArrowUp'), '↑');
  assert.equal(displayKey('Escape'), 'esc');
  assert.equal(displayKey('Space'), 'space');
  assert.equal(displayKey('Meta+Enter'), '⌘⏎');
  assert.equal(displayKey('Meta+/'), '⌘/');
  assert.equal(displayKey('?'), '?');
  assert.equal(displayKey('+'), '+');
  assert.deepEqual(displayKeys(['g', 'G', 'Enter']), ['g', '⏎']);
  assert.deepEqual(displayKeys(['A']), ['A']);
});

// # parity: P-30
test('help sheet sections are generated from the table', () => {
  const sections = helpSections();
  assert.deepEqual(sections.map((s) => s.group), ['Navigate', 'Act', 'View', 'System']);
  const all = sections.flatMap((s) => s.items);
  assert.ok(all.find((i) => i.id === 'waiting.next' && i.keys.includes('a')));
  const act = sections[1].items.map((i) => i.id);
  assert.equal(act[act.indexOf('tab.close') + 1], 'color.assign');
  assert.equal(all.filter((i) => i.id === 'color.assign').length, 1);
  assert.ok(!all.find((i) => i.id === 'filter.keep'), 'field-only bindings hidden');
  const ids = new Set(all.map((i) => `${i.id}|${i.label}`));
  assert.equal(ids.size, all.length, 'no duplicates');
  const custom = helpSections([{ id: 'x', keys: ['x'], contexts: ['main'], group: 'Other', label: 'X' },
    { id: 'tab.close', keys: ['x'], contexts: ['main'], group: 'Act', label: 'Close' },
    { id: 'tab.close', keys: ['x'], contexts: ['grid'], group: 'Act', label: 'Close' }]);
  assert.deepEqual(custom[1].items.map((i) => i.id), ['tab.close', 'color.assign']);
});

// # parity: P-32
test('hint bar is per context', () => {
  const main = hintsFor('main');
  assert.deepEqual(main.slice(0, 3), [{ keys: '↑↓', label: 'move' }, { keys: '⏎', label: 'go to' }, { keys: 'a', label: 'next ◉' }]);
  assert.ok(main.find((h) => h.label === 'help' && h.keys === '?'));
  assert.equal(new Set(main.map((h) => h.label)).size, main.length);
  assert.deepEqual(hintsFor('grid')[0], { keys: '↑↓←→', label: 'move' });
  assert.deepEqual(hintsFor('filter').map((h) => h.label), ['keep', 'clear', 'move']);
  assert.deepEqual(hintsFor('zoom').map((h) => h.label), ['move', 'back']);
  assert.deepEqual(hintsFor('nope'), []);
});

test('shortcutFor finds the first display key', () => {
  assert.equal(shortcutFor('session.refresh'), 'r');
  assert.equal(shortcutFor('palette.open'), '⌘K');
  assert.equal(shortcutFor('grid.toggleAll', 'grid'), 'A');
  assert.equal(shortcutFor('nope'), '');
});

// # parity: W-3
test('paletteCommands: every visible command once, with its display keys', () => {
  const cmds = paletteCommands();
  assert.ok(cmds.find((c) => c.id === 'session.goto' && c.label === 'Go to session in iTerm2'));
  const palette = cmds.find((c) => c.id === 'palette.open');
  assert.deepEqual(palette.keys, ['⌘K', '⌃K']);
  assert.ok(!cmds.find((c) => c.id === 'filter.keep'), 'field-only bindings hidden, same as the help sheet');
  const ids = new Set(cmds.map((c) => `${c.id}|${c.label}`));
  assert.equal(ids.size, cmds.length, 'no duplicates');
  assert.deepEqual(cmds.find((c) => c.id === 'color.assign' && c.label.endsWith('1')).args, { slot: 1 });
});

// VISUAL_SPEC §4.10 / D2: the status bar shows a short subset; the full
// list is the help sheet.
test('footer hints: a 4-hint subset in main/grid, context hints elsewhere', () => {
  assert.deepEqual(footerHintsFor('main'), [
    { keys: '⏎', label: 'go to' }, { keys: 'a', label: 'next ◉' }, { keys: '/', label: 'filter' }, { keys: '⌘K', label: 'commands' },
  ]);
  assert.deepEqual(footerHintsFor('grid').map((h) => h.label), ['go to', 'next ◉', 'filter', 'commands']);
  assert.deepEqual(footerHintsFor('filter').map((h) => h.label), ['keep', 'clear', 'move']);
  assert.deepEqual(footerHintsFor('zoom').map((h) => h.label), ['move', 'back']);
  assert.ok(footerHintsFor('main', undefined, 2).length === 2);
  assert.deepEqual(footerHintsFor('nope'), []);
});
