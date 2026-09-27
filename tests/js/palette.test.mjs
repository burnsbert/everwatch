import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sessionEntries, commandEntries, entryKey, filterPalette, paletteScore,
} from '../../everwatch/web/js/lib/palette.mjs';
import { paletteCommands } from '../../everwatch/web/js/keymap.mjs';

const sessions = [
  { uid: 'a', display_name: 'api-gateway', name: 'claude', path: '~/src/api-gateway', label: '' },
  { uid: 'b', display_name: 'billing', name: 'codex', path: '~/src/billing', label: '' },
  { uid: 'c', display_name: '', name: 'zsh', path: '~/', label: '' },
];

// # parity: W-3
test('sessionEntries and commandEntries build a stable haystack', () => {
  const se = sessionEntries(sessions);
  assert.equal(se.length, 3);
  assert.equal(se[0].type, 'session');
  assert.equal(se[0].label, 'api-gateway');
  assert.match(se[0].haystack, /api-gateway/);
  assert.equal(se[2].label, 'zsh', 'falls back to name when no display_name');
  assert.deepEqual(sessionEntries(), []);

  const cmds = paletteCommands();
  const ce = commandEntries(cmds);
  assert.ok(ce.length > 10);
  assert.ok(ce.every((e) => e.type === 'command'));
  assert.ok(ce.every((e) => Array.isArray(e.keys)));
  assert.deepEqual(commandEntries(), []);
});

// # parity: W-3
test('entryKey is stable per type+id', () => {
  assert.equal(entryKey({ type: 'session', id: 'a' }), 'session:a');
  assert.equal(entryKey({ type: 'command', id: 'session.goto' }), 'command:session.goto');
});

// # parity: W-3
test('filterPalette: empty query shows recent first, then the rest, unmatched', () => {
  const entries = sessionEntries(sessions);
  const out = filterPalette(entries, '', ['session:c', 'session:a', 'session:bogus']);
  assert.deepEqual(out.map((e) => e.uid), ['c', 'a', 'b']);
  assert.ok(out.every((e) => e.positions.length === 0));
});

test('filterPalette: no recency still returns every entry in input order', () => {
  const entries = sessionEntries(sessions);
  const out = filterPalette(entries, '');
  assert.deepEqual(out.map((e) => e.uid), ['a', 'b', 'c']);
});

// # parity: W-3
test('filterPalette: query scores and filters, best match first, non-matches dropped', () => {
  const entries = sessionEntries(sessions);
  const out = filterPalette(entries, 'bill');
  assert.deepEqual(out.map((e) => e.uid), ['b']);
  assert.ok(out[0].positions.length > 0);
  const none = filterPalette(entries, 'zzzzzzz');
  assert.deepEqual(none, []);
});

// # parity: W-3
test('filterPalette ranks commands and sessions together by score', () => {
  const entries = [
    ...sessionEntries(sessions),
    ...commandEntries([{ id: 'sort.cycle', label: 'Cycle sort order', group: 'Navigate', keys: ['s'] }]),
  ];
  const out = filterPalette(entries, 'sort');
  assert.equal(out[0].id, 'sort.cycle');
});

test('recent entries dedupe by key, keeping the first (most recent) occurrence', () => {
  const entries = sessionEntries(sessions);
  const out = filterPalette(entries, '', ['session:a', 'session:a', 'session:b']);
  assert.deepEqual(out.map((e) => e.uid), ['a', 'b', 'c']);
});

test('sessionEntries falls back to the uid when there is no name either', () => {
  const [e] = sessionEntries([{ uid: 'deadbeef1234' }]);
  assert.equal(e.label, 'deadbeef');
  assert.equal(e.sublabel, '');
});

test('commandEntries fills in defaults for a bare {id,label} command', () => {
  const [e] = commandEntries([{ id: 'x', label: 'X' }]);
  assert.equal(e.sublabel, '');
  assert.deepEqual(e.keys, []);
  assert.deepEqual(e.args, {});
});

test('filterPalette tolerates missing entries/recentKeys arguments', () => {
  assert.deepEqual(filterPalette(undefined, 'x'), []);
  assert.deepEqual(filterPalette(sessionEntries(sessions), '', null).map((e) => e.uid), ['a', 'b', 'c']);
});

// # parity: W-8 (palette ranking noise fix)
test('paletteScore: a contiguous word-start run beats scattered single characters', () => {
  const strong = paletteScore('sort', 'Cycle sort order');
  const weak = paletteScore('sort', 'Show/hide dollar amounts');
  assert.ok(strong.score > weak.score * 5, `${strong.score} should crush ${weak.score}`);
  // the whole 4-char run is highlight-worthy
  assert.deepEqual(strong.strongPositions, [6, 7, 8, 9]);
  // the scattered match still matched (for filtering purposes)…
  assert.ok(weak.positions.length > 0);
  // …but only its lone word-start hit (index 0) is worth marking; the
  // three other scattered mid-word letters are not
  assert.deepEqual(weak.strongPositions, [0]);
  assert.equal(paletteScore('q', 'abc'), null);
});

// # parity: W-8
test('filterPalette drops scattered-only matches that score far below the best match', () => {
  const entries = [
    ...commandEntries([
      { id: 'sort.cycle', label: 'Cycle sort order', group: 'Navigate', keys: ['s'] },
      { id: 'dollars.toggle', label: 'Show/hide dollar amounts', group: 'System', keys: ['$'] },
      { id: 'projects.toggle', label: 'Show/hide projects', group: 'Act', keys: ['p'] },
    ]),
  ];
  const out = filterPalette(entries, 'sort');
  assert.deepEqual(out.map((e) => e.id), ['sort.cycle'], 'the scattered s…o…r…t matches are noise, not results');
  assert.deepEqual(out[0].positions, [6, 7, 8, 9]);
});
