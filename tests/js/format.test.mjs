import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ageStr, ageSpoken, rowAge, isFresh, freshnessText, previewTitle, statusChip,
  isChrome, stripChrome, tailLines, screenBody, percent, plural, DEFAULTS, emptyStateKind, formatDollars,
} from '../../everwatch/web/js/lib/format.mjs';

const golden = (name) => JSON.parse(readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf8'));

// # parity: P-37
test('ageStr matches ultrawatch draw.age_str golden cases', () => {
  const { cases } = golden('age_str_cases.json');
  assert.ok(cases.length >= 10);
  for (const c of cases) assert.equal(ageStr(c.seconds), c.expected, `seconds=${c.seconds}`);
  assert.equal(ageStr(undefined), '0s');
  assert.equal(ageStr('nope'), '0s');
});

test('ageSpoken gives screen-reader friendly units', () => {
  assert.equal(ageSpoken(1), '1 second');
  assert.equal(ageSpoken(59), '59 seconds');
  assert.equal(ageSpoken(60), '1 minute');
  assert.equal(ageSpoken(7200), '2 hours');
  assert.equal(ageSpoken(86400), '1 day');
  assert.equal(ageSpoken(-3), '0 seconds');
  assert.equal(ageSpoken(null), '0 seconds');
});

// # parity: P-37
test('rowAge: wait {age} while waiting, idle {age} only after 60 s', () => {
  const now = 1000;
  assert.equal(rowAge({ state: 'waiting', state_since: 808 }, now), 'wait 3m');
  assert.equal(rowAge({ state: 'waiting', state_since: 0 }, now), '');
  assert.equal(rowAge({ state: 'idle', last_change: 941 }, now), '');
  assert.equal(rowAge({ state: 'idle', last_change: 940 }, now), 'idle 1m');
  assert.equal(rowAge({ state: 'quiet', last_change: 1000 - 7300 }, now), 'idle 2h');
  assert.equal(rowAge({ state: 'quiet', last_change: 0 }, now), '');
  assert.equal(rowAge({ state: 'busy', last_change: 1, state_since: 1 }, now), '');
  assert.equal(rowAge({ state: 'active', last_change: 1 }, now), '');
});

// # parity: P-38
test('isFresh: green only for recent changes after the startup grace', () => {
  const started = 1000;
  const now = 1100;
  assert.equal(isFresh({ state: 'idle', last_change: 1090 }, now, started), true);
  assert.equal(isFresh({ state: 'quiet', last_change: 1071 }, now, started), true);
  assert.equal(isFresh({ state: 'idle', last_change: 1070 }, now, started), false, '30 s boundary');
  assert.equal(isFresh({ state: 'idle', last_change: 1005 }, 1010, started), false, 'startup grace');
  assert.equal(isFresh({ state: 'idle', last_change: 1006 }, 1010, started), true);
  assert.equal(isFresh({ state: 'busy', last_change: 1099 }, now, started), false);
  assert.equal(isFresh({ state: 'waiting', last_change: 1099 }, now, started), false);
  assert.equal(isFresh({ state: 'idle' }, now, started), false);
  assert.equal(isFresh({ state: 'idle', last_change: 1099 }, now, undefined), true);
  assert.equal(isFresh({ state: 'idle', last_change: 1050 }, now, started, 60), true, 'custom window');
});

// # parity: P-27
test('freshnessText: live under 3 s, then updated Xs ago', () => {
  assert.equal(freshnessText(100, 98), 'live · updated just now');
  assert.equal(freshnessText(100, 97), 'updated 3s ago');
  assert.equal(freshnessText(1000, 100), 'updated 15m ago');
  assert.equal(freshnessText(100, 0), 'waiting for first snapshot');
});

// # parity: P-27
test('previewTitle: path · label · kind · STATE age (no age for busy)', () => {
  const s = { uid: 'abcdefghij', path: '~/src/api', label: 'fix', kind: 'claude', state: 'waiting', state_since: 800 };
  assert.deepEqual(previewTitle(s, 1000), { parts: ['~/src/api', 'fix', 'Claude Code'], state: 'waiting', age: '3m' });
  assert.deepEqual(previewTitle({ ...s, state: 'busy' }, 1000).age, '');
  assert.equal(previewTitle({ ...s, state: 'busy' }, 1000).state, 'busy');
  assert.deepEqual(previewTitle({ ...s, state: 'idle', kind: 'codex', label: '' }, 1000),
    { parts: ['~/src/api', 'Codex'], state: 'idle', age: '3m' });
  assert.deepEqual(previewTitle({ uid: 'abcdefghij', name: 'zsh', state: 'quiet' }, 1000),
    { parts: ['zsh'], state: null, age: '' });
  assert.deepEqual(previewTitle({ uid: 'abcdefghij', state: 'active' }, 1000).parts, ['abcdefgh']);
  assert.deepEqual(previewTitle({ uid: 'x', path: 'p', state: 'idle' }, 1000).age, '');
  assert.deepEqual(previewTitle(null, 1), { parts: ['no session'], state: null, age: '' });
});

// # parity: P-20
test('statusChip: not running, STALE on error, STALE {age} after 4× interval', () => {
  assert.equal(statusChip({ status: 'not_running' }, 10).text, 'iTerm2 not running');
  assert.equal(statusChip({ status: 'not_running' }, 10).level, 'danger');
  assert.equal(statusChip({ status: 'error', error: 'boom' }, 10).text, 'STALE');
  assert.match(statusChip({ status: 'error', error: 'boom' }, 10).tip, /boom/);
  assert.doesNotMatch(statusChip({ status: 'timeout', error: '' }, 10).tip, /: \./);
  assert.equal(statusChip({ status: 'timeout' }, 10).text, 'STALE');
  assert.equal(statusChip({ status: 'ok', snapshot_at: 100 }, 108).text, 'Live');
  assert.equal(statusChip({ status: 'ok', snapshot_at: 100 }, 108.5).text, 'STALE 8s');
  assert.equal(statusChip({ status: 'ok', snapshot_at: 100 }, 112, 3).text, 'Live');
  assert.equal(statusChip({ status: 'ok', snapshot_at: 0 }, 112).text, 'Live');
  assert.equal(statusChip({ status: 'permission_denied' }, 1).level, 'danger');
  assert.equal(statusChip({ status: 'connecting' }, 1).text, 'Connecting…');
  assert.equal(statusChip(null, 1).text, 'Connecting…');
  assert.equal(statusChip({ status: 'ok' }, 1, 2, 'connecting').text, 'Connecting…');
  assert.equal(statusChip({ status: 'ok' }, 1, 2, 'reconnecting').text, 'Reconnecting…');
});

// # parity: P-44
test('tailLines / stripChrome match ultrawatch draw.tail_lines golden cases', () => {
  const { cases } = golden('tail_lines_cases.json');
  assert.ok(cases.length >= 50);
  for (const c of cases) {
    assert.deepEqual(tailLines(c.text, c.n, c.width, c.strip_chrome), c.expected,
      `${c.name} n=${c.n} w=${c.width} strip=${c.strip_chrome}`);
  }
});

// # parity: P-44
test('isChrome recognises agent CLI furniture', () => {
  for (const l of ['', '   ', '❯', ' ❯ ', '────', '━━━', '─━─', '  ⏵⏵ accept edits on', 'ctx [12% remaining]']) {
    assert.equal(isChrome(l), true, JSON.stringify(l));
  }
  for (const l of ['real output', '❯ 1. Yes', '── title ──', '%remaining']) {
    assert.equal(isChrome(l), false, JSON.stringify(l));
  }
  assert.deepEqual(stripChrome(['a', '', '❯', '───']), ['a']);
  assert.deepEqual(stripChrome(Array(12).fill('───')), Array(4).fill('───'), 'at most 8 lines');
});

test('tailLines defaults and screenBody', () => {
  assert.deepEqual(tailLines('a\nb\nc', 2), ['b', 'c']);
  assert.deepEqual(tailLines(null, 2), []);
  assert.deepEqual(tailLines('abc', 1, -3), ['']);
  assert.equal(screenBody('a  \nb\n\n\n'), 'a\nb');
  assert.equal(screenBody(undefined), '');
});

// # parity: P-22
test('percent rounds like Python {:.0%} (half-even)', () => {
  assert.equal(percent(0.42), '42%');
  assert.equal(percent(0.47), '47%');
  assert.equal(percent(0.2), '20%');
  assert.equal(percent(0.8), '80%');
  assert.equal(percent(0.125), '12%');
  assert.equal(percent(0.135), '14%');
  assert.equal(percent(0.4449), '44%');
});

test('plural and defaults', () => {
  assert.equal(plural(1, 'tab'), '1 tab');
  assert.equal(plural(9, 'tab'), '9 tabs');
  assert.equal(plural(0, 'match', 'matches'), '0 matches');
  assert.equal(DEFAULTS.flashSeconds, 1.5);
  assert.equal(DEFAULTS.freshSeconds, 30);
  // §4.13: every toast auto-dismisses at ~3.5 s (errors included; "whatever
  // popups we do need should disappear by themselves after 3-4 seconds").
  assert.equal(DEFAULTS.toastSeconds, 3.5);
});

// # parity: P-29
test('emptyStateKind picks the full-page empty state', () => {
  const ok = (sessions = [], status = 'ok', error = '') => ({ iterm: { status, error }, sessions });
  assert.equal(emptyStateKind({ token: '', server: null, conn: 'open' }), 'no_token');
  assert.equal(emptyStateKind({ token: 't', server: null, conn: 'connecting' }), 'connecting');
  assert.equal(emptyStateKind({ token: 't', server: null, conn: 'open' }), 'connecting');
  assert.equal(emptyStateKind({ token: 't', server: null, conn: 'reconnecting' }), 'no_backend');
  assert.equal(emptyStateKind({ token: 't', server: ok([{}], 'not_running') }), 'not_running');
  assert.equal(emptyStateKind({ token: 't', server: ok([{}], 'permission_denied') }), 'permission_denied');
  assert.equal(emptyStateKind({ token: 't', server: ok([{}], 'error') }), null, 'stale rows still render');
  assert.equal(emptyStateKind({ token: 't', server: ok([], 'error') }), 'error');
  assert.equal(emptyStateKind({ token: 't', server: ok([], 'timeout') }), 'error');
  assert.equal(emptyStateKind({ token: 't', server: ok([], 'connecting') }), 'connecting');
  assert.equal(emptyStateKind({ token: 't', server: {} }), 'connecting');
  assert.equal(emptyStateKind({ token: 't', server: ok([]) }), 'no_sessions');
  assert.equal(emptyStateKind({ token: 't', server: { iterm: { status: 'ok' } } }), 'no_sessions');
});

// # parity: P-58
test('formatDollars: $1,234 at $100+, $12.50 below, blank for junk', () => {
  assert.equal(formatDollars(1234), '$1,234');
  assert.equal(formatDollars(100), '$100');
  assert.equal(formatDollars(12.5), '$12.50');
  assert.equal(formatDollars(0), '$0.00');
  assert.equal(formatDollars(-150), '$-150');
  assert.equal(formatDollars(null), '');
  assert.equal(formatDollars('nope'), '');
});
