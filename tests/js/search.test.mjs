import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchScreens, globalMatchSpan } from '../../everwatch/web/js/lib/search.mjs';

const sessions = [
  { uid: 'a', tab_label: '1.1' },
  { uid: 'b', tab_label: '1.2' },
  { uid: 'c', tab_label: '2.1' },
];

const screens = {
  a: 'line one\nTraceback (most recent call last):\nValueError: boom\nline four',
  b: 'nothing to see here\njust output',
  // c has no screen text
};

// # parity: W-8
test('searchScreens greps every live session, case-insensitively, with context', () => {
  const hits = searchScreens(screens, sessions, 'traceback');
  assert.equal(hits.length, 1);
  const h = hits[0];
  assert.equal(h.uid, 'a');
  assert.equal(h.lineIndex, 1);
  assert.deepEqual(h.before, ['line one']);
  assert.equal(h.line, 'Traceback (most recent call last):');
  assert.equal(h.matchStart, 0);
  assert.equal(h.matchEnd, 'traceback'.length);
  assert.deepEqual(h.after, ['ValueError: boom']);
});

test('no query, no screens, or no match all return no hits', () => {
  assert.deepEqual(searchScreens(screens, sessions, ''), []);
  assert.deepEqual(searchScreens(screens, sessions, '   '), []);
  assert.deepEqual(searchScreens(screens, sessions, undefined), []);
  assert.deepEqual(searchScreens(screens, sessions, null), []);
  assert.deepEqual(searchScreens({}, sessions, 'traceback'), []);
  assert.deepEqual(searchScreens(screens, sessions, 'zzzzznotfound'), []);
  assert.deepEqual(searchScreens(undefined, sessions, 'x'), []);
  assert.deepEqual(searchScreens(screens, undefined, 'x'), []);
});

// # parity: W-8
test('hits are capped per session and sessions are visited in order', () => {
  const repeated = { a: Array(10).fill('needle here').join('\n') };
  const hits = searchScreens(repeated, [sessions[0]], 'needle', { maxPerSession: 3 });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits.map((h) => h.lineIndex), [0, 1, 2]);
});

test('contextLines controls how much surrounding text comes back', () => {
  const hits = searchScreens(screens, sessions, 'boom', { contextLines: 2 });
  assert.deepEqual(hits[0].before, ['line one', 'Traceback (most recent call last):']);
  assert.deepEqual(hits[0].after, ['line four']);
  const zero = searchScreens(screens, sessions, 'boom', { contextLines: 0 });
  assert.deepEqual(zero[0].before, []);
  assert.deepEqual(zero[0].after, []);
});

// # parity: W-8
test('globalMatchSpan converts a per-line match into a full-text character offset', () => {
  const text = 'abc\ndefg\nhi';
  assert.deepEqual(globalMatchSpan(text, 0, 1, 2), { start: 1, end: 2 });
  assert.deepEqual(globalMatchSpan(text, 1, 0, 2), { start: 4, end: 6 });
  assert.deepEqual(globalMatchSpan(text, 2, 0, 2), { start: 9, end: 11 });
  assert.deepEqual(globalMatchSpan('', 0, 0, 0), { start: 0, end: 0 });
  assert.deepEqual(globalMatchSpan(undefined, 0, 0, 0), { start: 0, end: 0 });
});
