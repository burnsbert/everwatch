// W-10 live-preview lease (everwatch/web/js/lib/live.mjs) and the api.mjs
// send/live endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveLease, liveTargetOf, RENEW_MS } from '../../everwatch/web/js/lib/live.mjs';
import { createApi } from '../../everwatch/web/js/api.mjs';

function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return {
    timers,
    setInterval: (fn, ms) => { seq += 1; timers.set(seq, { fn, ms }); return seq; },
    clearInterval: (id) => timers.delete(id),
    tick() { for (const t of [...timers.values()]) t.fn(); },
  };
}

function fakeApi({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    live: (uid, on) => {
      calls.push([uid, on]);
      return fail ? Promise.reject(new Error('404')) : Promise.resolve({ ok: true });
    },
  };
}

// # parity: W-10
test('liveTargetOf: only the selected session of a visible split/zoom preview', () => {
  const s = { uid: 'A' };
  const base = { route: 'main', view: 'split', compact: false, visible: true, session: s };
  assert.equal(liveTargetOf(base), 'A');
  assert.equal(liveTargetOf({ ...base, view: 'zoom' }), 'A');
  assert.equal(liveTargetOf({ ...base, view: 'list' }), null);
  assert.equal(liveTargetOf({ ...base, view: 'grid' }), null);
  assert.equal(liveTargetOf({ ...base, visible: false }), null, 'hidden page');
  assert.equal(liveTargetOf({ ...base, compact: true }), null);
  assert.equal(liveTargetOf({ ...base, route: 'usage' }), null);
  assert.equal(liveTargetOf({ ...base, session: null }), null);
  assert.equal(liveTargetOf({ ...base, session: { uid: 'A', is_self: true } }), null);
  assert.equal(liveTargetOf({ ...base, session: { uid: 'A', is_dashboard: true } }), null);
  assert.equal(liveTargetOf({ ...base, session: {} }), null);
});

// # parity: W-10
test('lease: take on select, renew on an interval, release on switch / stop', () => {
  const t = fakeTimers();
  const api = fakeApi();
  const lease = createLiveLease({ api, timers: t });
  lease.set('A');
  assert.deepEqual(api.calls, [['A', true]]);
  assert.equal([...t.timers.values()][0].ms, RENEW_MS);
  lease.set('A'); // same uid: nothing new
  t.tick();
  assert.deepEqual(api.calls, [['A', true], ['A', true]]);
  lease.set('B');
  assert.deepEqual(api.calls.slice(2), [['A', false], ['B', true]]);
  assert.equal(t.timers.size, 1, 'one renew timer at a time');
  assert.equal(lease.current, 'B');
  lease.stop();
  assert.deepEqual(api.calls.slice(4), [['B', false]]);
  assert.equal(t.timers.size, 0);
  assert.equal(lease.current, null);
  lease.set(null);
  assert.equal(api.calls.length, 5);
});

test('lease failures are swallowed', async () => {
  const t = fakeTimers();
  const api = fakeApi({ fail: true });
  const lease = createLiveLease({ api, timers: t });
  lease.set('A');
  t.tick();
  lease.set(null);
  await new Promise((r) => setTimeout(r, 0)); // no unhandled rejection
  assert.equal(api.calls.length, 3);
});

test('default timers work', () => {
  const lease = createLiveLease({ api: fakeApi() });
  lease.set('A');
  lease.stop();
});

// # parity: W-10
test('api.send / api.live hit the W-10 endpoints with JSON bodies', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([init.method, url, init.body, init.headers['Content-Type']]);
    return { ok: true, status: 200, text: async () => '{"id":"a1"}' };
  };
  const api = createApi({ token: 't', fetchImpl });
  assert.deepEqual(await api.send('U/1', { text: 'y', enter: true }), { id: 'a1' });
  await api.live('U/1');
  await api.live('U/1', false);
  assert.deepEqual(seen, [
    ['POST', '/api/sessions/U%2F1/send', '{"text":"y","enter":true}', 'application/json'],
    ['POST', '/api/sessions/U%2F1/live', '{}', 'application/json'],
    ['DELETE', '/api/sessions/U%2F1/live', '{}', 'application/json'],
  ]);
});
