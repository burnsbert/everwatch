import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpark, sparkSegments, waitSummary, SPARK_STATES, SPARK_SLOTS, SPARK_SLOT_SECONDS,
} from '../../everwatch/web/js/lib/sparkline.mjs';

// # parity: W-5
test('parseSpark maps history.py SPARK_CHARS to state names, `-` to null', () => {
  assert.deepEqual(parseSpark('bwiaq-'), [
    { index: 0, state: 'busy' }, { index: 1, state: 'waiting' }, { index: 2, state: 'idle' },
    { index: 3, state: 'active' }, { index: 4, state: 'quiet' }, { index: 5, state: null },
  ]);
  assert.deepEqual(parseSpark(''), []);
  assert.deepEqual(parseSpark(undefined), []);
  assert.deepEqual(SPARK_STATES, { b: 'busy', w: 'waiting', i: 'idle', a: 'active', q: 'quiet' });
  assert.equal(SPARK_SLOTS, 12);
  assert.equal(SPARK_SLOT_SECONDS, 300);
});

// # parity: W-5
test('sparkSegments compresses consecutive equal-state slots into runs', () => {
  assert.deepEqual(sparkSegments('bbbwwiii'), [
    { state: 'busy', count: 3 }, { state: 'waiting', count: 2 }, { state: 'idle', count: 3 },
  ]);
  assert.deepEqual(sparkSegments('---'), [{ state: null, count: 3 }]);
  assert.deepEqual(sparkSegments(''), []);
  assert.deepEqual(sparkSegments('b'), [{ state: 'busy', count: 1 }]);
  assert.deepEqual(sparkSegments('bwbw'), [
    { state: 'busy', count: 1 }, { state: 'waiting', count: 1 }, { state: 'busy', count: 1 }, { state: 'waiting', count: 1 },
  ]);
});

// # parity: W-5
test('waitSummary formats "waited N× · Mm total today", blank when never waited', () => {
  assert.equal(waitSummary({ count: 3, seconds: 660 }), 'waited 3× · 11m total today');
  assert.equal(waitSummary({ count: 1, seconds: 45 }), 'waited 1× · 45s total today');
  assert.equal(waitSummary({ count: 0, seconds: 0 }), '');
  assert.equal(waitSummary(null), '');
  assert.equal(waitSummary(undefined), '');
});
