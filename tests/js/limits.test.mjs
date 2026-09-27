import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMITS, providerName, limitName, limitTitle, quotaState, clock12, dayTime, whenPhrase,
  resetLine, projectionLine, sentenceCase, isoEpoch, clockLabel,
} from '../../everwatch/web/js/lib/limits.mjs';

// Local-time epoch seconds, so these tests don't depend on the machine's zone.
const at = (y, mo, d, h, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime() / 1000;
const NOW = at(2026, 9, 21, 12, 0); // a Monday

test('every §4.18.1 id has a full name, a short name, and a tooltip name without CC/CX', () => {
  for (const id of ['cc.five_hour', 'cc.seven_day', 'cc.seven_day_sonnet', 'cc.monthly', 'cc.extra', 'cx.five_hour', 'cx.seven_day']) {
    const l = LIMITS[id];
    assert.ok(l.full && l.short && l.title, id);
    for (const s of [l.full, l.short, l.title, l.page || '']) assert.doesNotMatch(s, /\b(CC|CX)\b/, `${id}: ${s}`);
  }
});

test('providerName maps ids to the full product name', () => {
  assert.equal(providerName('cc.five_hour'), 'Claude Code');
  assert.equal(providerName('cx.window3'), 'Codex');
  assert.equal(providerName(''), '');
  assert.equal(providerName(undefined), '');
});

test('limitName: known ids map from id, page form falls back to full, unknown ids strip the backend prefix/suffix', () => {
  assert.equal(limitName({ id: 'cc.five_hour', label: 'CC Session Limit' }), 'Session');
  assert.equal(limitName({ id: 'cc.five_hour', label: 'CC Session Limit' }, 'short'), '5h');
  assert.equal(limitName({ id: 'cx.five_hour', label: 'CX 5h Limit' }, 'page'), '5-hour');
  assert.equal(limitName({ id: 'cc.seven_day', label: 'CC Weekly Limit' }, 'page'), 'Weekly');
  assert.equal(limitName({ id: 'cx.window3', label: 'CX 1d Limit' }), '1d');
  assert.equal(limitName({ id: 'cx.window3', label: 'CX 1d Limit' }, 'short'), '1d');
  assert.equal(limitName({ id: 'cc.new', label: 'CC Extra Usage ' }), 'Extra Usage');
  assert.equal(limitName({}), '');
  assert.equal(limitName(null), '');
});

test('limitTitle: the never-abbreviated tooltip name', () => {
  assert.equal(limitTitle({ id: 'cc.five_hour', label: 'CC Session Limit' }), 'Claude Code — 5-hour session limit');
  assert.equal(limitTitle({ id: 'cx.seven_day', label: 'CX 7d Limit' }), 'Codex — weekly limit');
  assert.equal(limitTitle({ id: 'cx.window3', label: 'CX 1d Limit' }), 'Codex — 1d limit');
  assert.equal(limitTitle({ label: 'Mystery' }), 'Mystery limit');
});

test('quotaState: level from the backend, pace = projection && !hit, hit from either flag, run-out time from projection.at', () => {
  assert.deepEqual(quotaState({ level: 'green', pct: 10, projection: null }), {
    level: 'ok', hit: false, pace: false, runOutAt: null,
  });
  assert.deepEqual(quotaState({ level: 'yellow', projection: { text: 'x', hit: false, at: '2026-09-21T15:54:00+00:00' } }), {
    level: 'yellow', hit: false, pace: true, runOutAt: Date.parse('2026-09-21T15:54:00Z') / 1000,
  });
  // an older backend without `at`: still a pace warning, time unknown
  assert.deepEqual(quotaState({ level: 'green', projection: { text: 'x', hit: false } }), {
    level: 'ok', hit: false, pace: true, runOutAt: null,
  });
  assert.deepEqual(quotaState({ level: 'red', hit: false, projection: { text: 'x', hit: true, at: null } }), {
    level: 'red', hit: true, pace: false, runOutAt: null,
  });
  assert.deepEqual(quotaState({ level: 'red', hit: true, projection: null }), {
    level: 'red', hit: true, pace: false, runOutAt: null,
  });
  assert.deepEqual(quotaState(undefined), {
    level: 'ok', hit: false, pace: false, runOutAt: null,
  });
});

test('isoEpoch parses ISO to epoch seconds, null for missing or garbage', () => {
  assert.equal(isoEpoch('2026-09-21T15:54:00+00:00'), Date.parse('2026-09-21T15:54:00Z') / 1000);
  assert.equal(isoEpoch(''), null);
  assert.equal(isoEpoch(null), null);
  assert.equal(isoEpoch('nope'), null);
});

test('clock12 renders h:mm AM/PM', () => {
  assert.equal(clock12(at(2026, 9, 21, 16, 41)), '4:41 PM');
  assert.equal(clock12(at(2026, 9, 21, 0, 5)), '12:05 AM');
  assert.equal(clock12(at(2026, 9, 21, 12, 0)), '12:00 PM');
});

test('dayTime / whenPhrase: today, tomorrow, weekday within the week, then a date', () => {
  assert.deepEqual(dayTime(at(2026, 9, 21, 16, 41), NOW), { day: 'Today', time: '4:41 PM' });
  assert.deepEqual(dayTime(at(2026, 9, 22, 9, 0), NOW), { day: 'Tomorrow', time: '9:00 AM' });
  assert.deepEqual(dayTime(at(2026, 9, 24, 5, 0), NOW), { day: 'Thu', time: '5:00 AM' });
  assert.deepEqual(dayTime(at(2026, 10, 1, 0, 0), NOW), { day: 'Oct 1', time: '12:00 AM' });
  assert.deepEqual(dayTime(at(2026, 9, 20, 8, 0), NOW), { day: 'Sep 20', time: '8:00 AM' }, 'the past reads as a date');
  assert.equal(whenPhrase(at(2026, 9, 21, 16, 41), NOW), 'today at 4:41 PM');
  assert.equal(whenPhrase(at(2026, 9, 22, 9, 0), NOW), 'tomorrow at 9:00 AM');
  assert.equal(whenPhrase(at(2026, 9, 24, 5, 0), NOW), 'Thu at 5:00 AM');
  assert.equal(whenPhrase(at(2026, 10, 1, 0, 0), NOW), 'Oct 1 at 12:00 AM');
});

test('resetLine: "Resets in <delta> · <Day> <time>", tolerating a missing reset_at or reset_text', () => {
  const resetAt = new Date(at(2026, 9, 21, 17, 15) * 1000).toISOString();
  assert.equal(resetLine({ reset_text: '5h 15m (Today at 5:15pm)', reset_at: resetAt }, NOW), 'Resets in 5h 15m · Today 5:15 PM');
  assert.equal(resetLine({ reset_text: '2d 18h (Thu at 5:00am)', reset_at: null }, NOW), 'Resets in 2d 18h');
  assert.equal(resetLine({ reset_text: '', reset_at: resetAt }, NOW), 'Resets Today 5:15 PM');
  assert.equal(resetLine({ reset_text: '', reset_at: null }, NOW), '');
});

test('projectionLine: pace with a time, pace without one (backend text, sentence case), hit, none', () => {
  const soon = new Date(at(2026, 9, 21, 16, 41) * 1000).toISOString();
  const thu = new Date(at(2026, 9, 24, 7, 30) * 1000).toISOString();
  assert.equal(projectionLine({ projection: { text: 'on pace to hit session limit Today at 4:41pm', hit: false, at: soon } }, NOW),
    'On pace to reach 100% at 4:41 PM');
  assert.equal(projectionLine({ projection: { text: 'x', hit: false, at: thu } }, NOW), 'On pace to reach 100% Thu at 7:30 AM');
  assert.equal(projectionLine({ projection: { text: 'on pace to hit session limit Today at 4:41pm', hit: false } }, NOW),
    'On pace to hit session limit Today at 4:41pm');
  assert.equal(projectionLine({ hit: true, projection: { text: 'sonnet limit hit', hit: true, at: null } }, NOW), 'Limit reached');
  assert.equal(projectionLine({ hit: true, projection: null }, NOW), 'Limit reached');
  assert.equal(projectionLine({ projection: null }, NOW), '');
});

test('sentenceCase capitalizes the first letter only', () => {
  assert.equal(sentenceCase('on pace to hit'), 'On pace to hit');
  assert.equal(sentenceCase(''), '');
  assert.equal(sentenceCase(undefined), '');
});

test('clockLabel: chart tick styles (time / weekday + time / date)', () => {
  assert.equal(clockLabel(at(2026, 9, 21, 16, 41), 'time'), '4:41 PM');
  assert.equal(clockLabel(at(2026, 9, 24, 5, 0), 'day'), 'Thu 5:00 AM');
  assert.equal(clockLabel(at(2026, 9, 17, 5, 0), 'date'), 'Sep 17');
  assert.equal(clockLabel(at(2026, 9, 21, 16, 41)), '4:41 PM');
});
