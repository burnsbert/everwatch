import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fuzzyMatch, fuzzyPositions, fuzzyScore, sessionHaystack, fieldHighlights, highlightRuns,
} from '../../everwatch/web/js/lib/fuzzy.mjs';
import {
  SORTS, VIEWS, SORT_LABELS, nextSort, nextView, sortSessions, visibleRows, groupItems,
  selectedIndex, moveSelection, nextWaiting, gridRows, clampRatio, splitWidths,
} from '../../everwatch/web/js/lib/rows.mjs';

const golden = (name) => JSON.parse(readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/state_sample.json', import.meta.url), 'utf8'));

// # parity: P-46
test('fuzzyMatch matches ultrawatch draw.fuzzy_match golden cases', () => {
  const { cases } = golden('fuzzy_cases.json');
  assert.ok(cases.length >= 10);
  for (const c of cases) assert.equal(fuzzyMatch(c.needle, c.haystack), c.expected, `${c.needle} in ${c.haystack}`);
});

// # parity: P-46
test('fuzzyPositions returns greedy leftmost indexes', () => {
  assert.deepEqual(fuzzyPositions('agw', '~/src/api-gateway'), [6, 10, 14]);
  assert.deepEqual(fuzzyPositions('', 'x'), []);
  assert.equal(fuzzyPositions('q', 'abc'), null);
  assert.deepEqual(fuzzyPositions('日', 'x日'), [1]);
  assert.equal(fuzzyPositions('a', undefined), null);
});

// # parity: P-46
test('haystack is "path name label" and highlights map back to fields', () => {
  const s = { path: '~/api', name: 'claude', label: 'fix' };
  const hay = sessionHaystack(s);
  assert.equal(hay, '~/api claude fix');
  const pos = fuzzyPositions('acf', hay);
  assert.deepEqual(fieldHighlights(s, pos), { path: [2], name: [0], label: [0] });
  assert.equal(sessionHaystack({}), '  ');
  assert.deepEqual(fieldHighlights(s, []), { path: [], name: [], label: [] });
  assert.deepEqual(fieldHighlights(s, null), { path: [], name: [], label: [] });
  assert.deepEqual(fieldHighlights({ path: 'ab' }, [2]), { path: [], name: [], label: [] }, 'space is no field');
});

test('highlightRuns groups consecutive hits', () => {
  assert.deepEqual(highlightRuns('abcd', [1, 2]), [
    { text: 'a', hit: false }, { text: 'bc', hit: true }, { text: 'd', hit: false }]);
  assert.deepEqual(highlightRuns('', [0]), []);
  assert.deepEqual(highlightRuns(null), []);
  assert.deepEqual(highlightRuns('ab'), [{ text: 'ab', hit: false }]);
});

// # parity: W-3
test('fuzzyScore ranks earlier, more contiguous matches higher; null on no match', () => {
  assert.equal(fuzzyScore('q', 'abc'), null);
  assert.equal(fuzzyScore('', 'anything'), 0);
  assert.ok(fuzzyScore('gw', 'gateway') > fuzzyScore('gw', 'g_r_a_n_d_w_izard'), 'contiguous beats scattered');
  assert.ok(fuzzyScore('cmd', 'cmd palette') > fuzzyScore('cmd', 'a command'), 'earlier start scores higher');
  assert.equal(fuzzyScore('abc', 'abc'), fuzzyScore('abc', 'abc'), 'deterministic');
  assert.ok(fuzzyScore('abc', 'xabc') < fuzzyScore('abc', 'abcx'), 'a later start scores lower');
});

const mk = (uid, o = {}) => ({
  uid, window_id: 1, window_no: 1, tab_index: 1, session_index: 1, state: 'idle', kind: null,
  last_change: 0, state_since: 0, path: '', name: '', label: '', ...o,
});

// # parity: P-47
test('sort cycle: natural → attention → agents → activity → path', () => {
  assert.deepEqual(SORTS, ['natural', 'attention', 'agents', 'activity', 'path']);
  assert.equal(nextSort('natural'), 'attention');
  assert.equal(nextSort('path'), 'natural');
  assert.equal(nextSort('bogus'), 'natural');
  assert.equal(SORT_LABELS.attention, 'Attention');
});

// # parity: P-47
test('attention sort ranks waiting < busy < active < idle < quiet < none; waiting by since', () => {
  const ss = [
    mk('q', { state: 'quiet', tab_index: 1 }), mk('n', { state: null, tab_index: 2 }),
    mk('w2', { state: 'waiting', state_since: 50, tab_index: 3 }), mk('i', { state: 'idle', tab_index: 4 }),
    mk('b', { state: 'busy', tab_index: 5 }), mk('w1', { state: 'waiting', state_since: 10, tab_index: 6 }),
    mk('a', { state: 'active', tab_index: 7 }), mk('b0', { state: 'busy', tab_index: 0 }),
  ];
  assert.deepEqual(sortSessions(ss, 'attention').map((s) => s.uid), ['w1', 'w2', 'b0', 'b', 'a', 'i', 'q', 'n']);
});

// # parity: P-47
test('natural, agents, activity, path sorts', () => {
  const ss = [
    mk('c', { window_id: 2, tab_index: 1, kind: 'codex', last_change: 5, path: '~/b' }),
    mk('a', { window_id: 1, tab_index: 2, last_change: 9, path: '' }),
    mk('b', { window_id: 1, tab_index: 1, kind: 'claude', last_change: 1, path: '~/a' }),
    mk('d', { window_id: 1, tab_index: 1, session_index: 2, last_change: 9, path: '~/a' }),
  ];
  assert.deepEqual(sortSessions(ss, 'natural').map((s) => s.uid), ['b', 'd', 'a', 'c']);
  assert.deepEqual(sortSessions(ss, 'agents').map((s) => s.uid), ['b', 'c', 'd', 'a']);
  assert.deepEqual(sortSessions(ss, 'activity').map((s) => s.uid), ['d', 'a', 'c', 'b']);
  assert.deepEqual(sortSessions(ss, 'path').map((s) => s.uid), ['a', 'b', 'd', 'c'], "'' sorts as '~'");
  assert.deepEqual(sortSessions(ss, 'nope').map((s) => s.uid), ['b', 'd', 'a', 'c']);
  assert.deepEqual(sortSessions([mk('x', { last_change: undefined }), mk('y', { last_change: 3 })], 'activity')
    .map((s) => s.uid), ['y', 'x']);
});

// # parity: P-46, P-47
test('visibleRows filters then sorts, carrying match positions', () => {
  const rows = visibleRows(fixture.sessions, { sort: 'natural', filter: 'api' });
  assert.deepEqual(rows.map((r) => r.s.tab_label), ['1.1', '1.4', '1.5'], 'mobile-app … offline matches too');
  assert.ok(rows.every((r) => r.positions.length === 3));
  assert.equal(visibleRows(fixture.sessions).length, 9);
  assert.equal(visibleRows(fixture.sessions, { filter: 'zzzzqq' }).length, 0);
  assert.deepEqual(visibleRows(null), []);
  const att = visibleRows(fixture.sessions, { sort: 'attention' });
  assert.deepEqual(att.slice(0, 2).map((r) => r.s.uid), fixture.waiting_order);
  assert.equal(visibleRows(fixture.sessions, { sort: 'bogus' })[0].s.tab_label, '1.1');
});

// # parity: P-24
test('window headers only in natural sort with more than one window', () => {
  const rows = visibleRows(fixture.sessions, { sort: 'natural' });
  const items = groupItems(rows, 'natural');
  const headers = items.filter((i) => i.type === 'header');
  assert.deepEqual(headers.map((h) => h.window_no), [1, 2]);
  assert.equal(items.length, 11);
  assert.equal(groupItems(rows, 'attention').filter((i) => i.type === 'header').length, 0);
  const one = rows.filter((r) => r.s.window_no === 1);
  assert.equal(groupItems(one, 'natural').filter((i) => i.type === 'header').length, 0);
});

// # parity: P-40
test('selection by uid; stale selection snaps to first row', () => {
  const rows = visibleRows(fixture.sessions, { sort: 'natural' });
  const uid3 = rows[3].s.uid;
  assert.equal(selectedIndex(rows, uid3), 3);
  assert.equal(selectedIndex(rows, 'gone'), 0);
  assert.equal(selectedIndex([], 'x'), -1);
  assert.equal(moveSelection(rows, uid3, 1), rows[4].s.uid);
  assert.equal(moveSelection(rows, uid3, -1), rows[2].s.uid);
  assert.equal(moveSelection(rows, rows[0].s.uid, -1), rows[0].s.uid, 'clamped at top');
  assert.equal(moveSelection(rows, rows[8].s.uid, 5), rows[8].s.uid, 'clamped at bottom');
  assert.equal(moveSelection(rows, 'gone', 1), rows[0].s.uid);
  assert.equal(moveSelection([], 'x', 1), null);
});

// # parity: P-41
test('next waiting starts longest-waiting and cycles', () => {
  const w = ['a', 'b', 'c'];
  assert.equal(nextWaiting(w, null), 'a');
  assert.equal(nextWaiting(w, 'x'), 'a');
  assert.equal(nextWaiting(w, 'a'), 'b');
  assert.equal(nextWaiting(w, 'c'), 'a');
  assert.equal(nextWaiting([], 'a'), null);
  assert.equal(nextWaiting(undefined, 'a'), null);
});

// # parity: P-49
test('view cycle: split → list → grid → split', () => {
  assert.deepEqual(VIEWS, ['split', 'list', 'grid']);
  assert.equal(nextView('split'), 'list');
  assert.equal(nextView('list'), 'grid');
  assert.equal(nextView('grid'), 'split');
  assert.equal(nextView('zoom'), 'split');
});

test('grid rows: agents only, falling back to all', () => {
  const rows = visibleRows(fixture.sessions);
  assert.equal(gridRows(rows, false).length, 6);
  assert.equal(gridRows(rows, true).length, 9);
  const shells = rows.filter((r) => !r.s.kind);
  assert.equal(gridRows(shells, false).length, 3);
});

// # parity: P-22
test('split ratio clamp and pixel minimums (list 280, preview 320)', () => {
  assert.equal(clampRatio(0.1), 0.2);
  assert.equal(clampRatio(0.95), 0.8);
  assert.equal(clampRatio(0.42 + 0.05), 0.47);
  assert.equal(clampRatio(NaN), 0.42);
  assert.equal(clampRatio(undefined), 0.42);
  assert.deepEqual(splitWidths(1400, 0.42), { list: 588, preview: 812 });
  assert.deepEqual(splitWidths(1000, 0.2), { list: 280, preview: 720 });
  assert.deepEqual(splitWidths(1000, 0.8), { list: 680, preview: 320 });
  assert.deepEqual(splitWidths(500, 0.5), { list: 280, preview: 220 }, 'list minimum wins');
  assert.deepEqual(splitWidths(200, 0.5), { list: 200, preview: 0 });
  assert.deepEqual(splitWidths(1006, 0.5, { splitter: 6 }), { list: 500, preview: 500 });
});
