import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventStream, backoffDelay, BACKOFF_MS, EVENT_TYPES } from '../../everwatch/web/js/sse.mjs';
import { createApi, resolveToken, ApiError, TOKEN_HEADER, TOKEN_STORAGE_KEY } from '../../everwatch/web/js/api.mjs';
import { createBridge, OUTBOUND } from '../../everwatch/web/js/bridge.mjs';

// --- fakes ---------------------------------------------------------------------

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { seq += 1; pending.set(seq, { fn, at: now + ms }); return seq; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
    get count() { return pending.size; },
  };
}

function fakeEventSourceClass() {
  const instances = [];
  class FakeES {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      this.closed = false;
      instances.push(this);
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    close() { this.closed = true; this.readyState = 2; }
    open() { this.readyState = 1; this.onopen?.(); }
    fail(state = 2) { this.readyState = state; this.onerror?.(); }
    emit(type, data, lastEventId = '') {
      for (const fn of this.listeners[type] || []) fn({ data: typeof data === 'string' ? data : JSON.stringify(data), lastEventId });
    }
  }
  return { FakeES, instances };
}

function setup(extra = {}) {
  const timers = fakeTimers();
  const { FakeES, instances } = fakeEventSourceClass();
  const events = [];
  const statuses = [];
  const errors = [];
  const stream = createEventStream({
    url: '/api/events?token=t', EventSourceImpl: FakeES, timers,
    onEvent: (type, data, id) => events.push([type, data, id]),
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { timers, instances, events, statuses, errors, stream };
}

// --- sse -----------------------------------------------------------------------

test('backoff steps cap at the last value', () => {
  assert.equal(backoffDelay(0), 1000);
  assert.equal(backoffDelay(3), 8000);
  assert.equal(backoffDelay(99), BACKOFF_MS.at(-1));
  assert.equal(backoffDelay(-1), 1000);
  assert.ok(EVENT_TYPES.includes('action_result'));
});

test('sse: connect, open, dispatch JSON events with ids', () => {
  const { instances, events, statuses, stream } = setup();
  stream.start();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, '/api/events?token=t');
  assert.deepEqual(statuses, ['connecting']);
  instances[0].open();
  assert.equal(stream.status, 'open');
  instances[0].emit('state', { rev: 1 }, '1');
  instances[0].emit('ping', '');
  instances[0].emit('toast', { message: 'hi' });
  assert.deepEqual(events, [['state', { rev: 1 }, '1'], ['ping', null, null], ['toast', { message: 'hi' }, null]]);
});

test('sse: bad JSON reports an error and keeps going', () => {
  const { instances, events, errors, stream } = setup();
  stream.start();
  instances[0].open();
  instances[0].emit('state', '{nope');
  instances[0].emit('state', { ok: 1 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'state');
  assert.equal(events.length, 1);
});

test('sse: browser-managed retry (CONNECTING) only flips status', () => {
  const { instances, statuses, stream, timers } = setup();
  stream.start();
  instances[0].open();
  instances[0].fail(0);
  assert.equal(stream.status, 'reconnecting');
  assert.equal(instances.length, 1);
  instances[0].open();
  assert.deepEqual(statuses, ['connecting', 'open', 'reconnecting', 'open']);
  assert.equal(timers.count, 1, 'only the watchdog');
});

test('sse: CLOSED error reconnects with backoff, resets after open', () => {
  const { instances, stream, timers, errors } = setup();
  stream.start();
  instances[0].fail(2);
  assert.equal(stream.status, 'reconnecting');
  assert.equal(instances[0].closed, true);
  timers.advance(999);
  assert.equal(instances.length, 1);
  timers.advance(1);
  assert.equal(instances.length, 2);
  instances[1].fail(2);
  timers.advance(1999);
  assert.equal(instances.length, 2);
  timers.advance(1);
  assert.equal(instances.length, 3);
  assert.equal(stream.attempt, 2);
  instances[2].open();
  assert.equal(stream.attempt, 0);
  assert.equal(stream.status, 'open');
  instances[2].fail(2);
  timers.advance(1000);
  assert.equal(instances.length, 4);
  assert.ok(errors.every((e) => e.reason === 'closed'));
  // a stale instance's callbacks are ignored
  instances[0].onopen?.();
  instances[0].emit('state', { x: 1 });
});

test('sse: stale-instance handlers are detached', () => {
  const { instances, stream, events } = setup();
  stream.start();
  const first = instances[0];
  first.fail(2);
  assert.equal(first.onopen, null);
  assert.equal(first.onerror, null);
  first.emit('state', { x: 1 });
  assert.equal(events.length, 0);
  stream.stop();
});

test('sse: watchdog forces a reconnect when the stream goes silent', () => {
  const { instances, stream, timers, errors } = setup({ watchdogMs: 45000 });
  stream.start();
  instances[0].open();
  timers.advance(30000);
  instances[0].emit('ping', { now: 1 });
  timers.advance(30000);
  assert.equal(instances.length, 1, 'ping re-armed the watchdog');
  timers.advance(15000);
  assert.equal(stream.status, 'reconnecting');
  assert.equal(errors.at(-1).reason, 'watchdog');
  timers.advance(1000);
  assert.equal(instances.length, 2);
});

test('sse: watchdog disabled, manual reconnect, stop, double reconnect', () => {
  const { instances, stream, timers, statuses } = setup({ watchdogMs: 0 });
  stream.start();
  instances[0].open();
  timers.advance(10 ** 7);
  assert.equal(instances.length, 1);
  stream.reconnect();
  stream.reconnect();
  timers.advance(1000);
  assert.equal(instances.length, 2, 'second reconnect while pending is a no-op');
  stream.stop();
  assert.equal(stream.status, 'closed');
  assert.equal(statuses.at(-1), 'closed');
  stream.reconnect();
  timers.advance(100000);
  assert.equal(instances.length, 2, 'stopped streams stay stopped');
  stream.start();
  assert.equal(instances.length, 3);
  stream.stop();
});

test('sse: stop while a retry is pending cancels it; close() throwing is tolerated', () => {
  const { instances, stream, timers } = setup();
  stream.start();
  instances[0].close = () => { throw new Error('boom'); };
  instances[0].fail(2);
  stream.stop();
  timers.advance(60000);
  assert.equal(instances.length, 1);
});

/** Make global timers behave like the browser's: calling them with a
 * foreign `this` throws "Illegal invocation" (the bug the live smoke found). */
async function withStrictTimers(fn) {
  const { setTimeout: st, clearTimeout: ct } = globalThis;
  const strict = (real) => function strictTimer(...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return real(...args);
  };
  globalThis.setTimeout = strict(st);
  globalThis.clearTimeout = strict(ct);
  try { return await fn(); } finally {
    globalThis.setTimeout = st;
    globalThis.clearTimeout = ct;
  }
}

test('sse: default timers are called unbound (browser-safe)', () => withStrictTimers(() => {
  const { FakeES, instances } = fakeEventSourceClass();
  const stream = createEventStream({ url: 'u', EventSourceImpl: FakeES });
  stream.start(); // arms the watchdog with the default timers
  instances[0].fail(2); // schedules a reconnect
  stream.stop(); // clears both
}));

test('sse: defaults for callbacks and timers', () => {
  const { FakeES, instances } = fakeEventSourceClass();
  const stream = createEventStream({ url: 'u', EventSourceImpl: FakeES, watchdogMs: 0 });
  stream.start();
  instances[0].open();
  instances[0].emit('state', '{bad');
  instances[0].emit('state', {});
  stream.stop();
});

// --- api -----------------------------------------------------------------------

function fakeFetch(responder = () => ({ status: 200, body: '{"ok":true}' })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const r = responder(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? '' };
  };
  return { fn, calls };
}

test('api: every endpoint sends the token; mutations are JSON', async () => {
  const { fn, calls } = fakeFetch();
  const api = createApi({ token: 'tok', fetchImpl: fn, base: 'http://h' });
  const table = [
    [() => api.getState(), 'GET', '/api/state', undefined],
    [() => api.getScreen('a/b'), 'GET', '/api/sessions/a%2Fb/screen', undefined],
    [() => api.goto('U1'), 'POST', '/api/sessions/U1/goto', {}],
    [() => api.visit('U1'), 'POST', '/api/sessions/U1/visit', {}],
    [() => api.setLabel('U1', 'x'), 'PUT', '/api/sessions/U1/label', { label: 'x' }],
    [() => api.setColor('U1', 3), 'PUT', '/api/sessions/U1/color', { slot: 3 }],
    [() => api.setColor('U1', null), 'PUT', '/api/sessions/U1/color', { slot: null }],
    [() => api.setColor('U1'), 'PUT', '/api/sessions/U1/color', { slot: null }],
    [() => api.newTab(), 'POST', '/api/tabs/new', {}],
    [() => api.closeTab(4711, 3), 'POST', '/api/tabs/4711/3/close', { confirm: true }],
    [() => api.refresh(), 'POST', '/api/refresh', {}],
    [() => api.patchPrefs({ sort: 'path' }), 'PATCH', '/api/prefs', { sort: 'path' }],
    [() => api.setProject(2, 'Docs'), 'PUT', '/api/projects/2', { name: 'Docs' }],
    [() => api.clearProjects(), 'DELETE', '/api/projects', {}],
    [() => api.history({ uid: 'U1' }), 'GET', '/api/history?uid=U1&minutes=60', undefined],
    [() => api.history(), 'GET', '/api/history?minutes=60', undefined],
    [() => api.usageHistory({ since: 5 }), 'GET', '/api/usage/history?since=5', undefined],
    [() => api.usageHistory(), 'GET', '/api/usage/history', undefined],
    [() => api.diagnostics(), 'GET', '/api/diagnostics', undefined],
    [() => api.recheckDiagnostics(), 'POST', '/api/diagnostics/recheck', {}],
    [() => api.quotaDraft(), 'POST', '/api/quota/draft', {}],
    [() => api.quotaSkip(), 'POST', '/api/quota/skip', {}],
    [() => api.installColors(), 'POST', '/api/colors/install', {}],
    [() => api.importUltrawatch(), 'POST', '/api/import/ultrawatch', {}],
    [() => api.launchIterm(), 'POST', '/api/iterm/launch', {}],
  ];
  for (const [call, method, path, body] of table) {
    calls.length = 0;
    assert.deepEqual(await call(), { ok: true });
    const { url, init } = calls[0];
    assert.equal(url, `http://h${path}`);
    assert.equal(init.method, method);
    assert.equal(init.headers[TOKEN_HEADER], 'tok');
    if (method === 'GET') {
      assert.equal(init.body, undefined);
      assert.equal(init.headers['Content-Type'], undefined);
    } else {
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.deepEqual(JSON.parse(init.body), body);
    }
  }
  assert.equal(api.eventsUrl(), 'http://h/api/events?token=tok');
  assert.equal(createApi({ fetchImpl: fn }).eventsUrl(), '/api/events');
  assert.equal(api.token, 'tok');
});

test('api: errors carry status and server error text', async () => {
  const { fn } = fakeFetch((url) => {
    if (url.endsWith('/color')) return { status: 409, body: '{"error":"tab_colors_unavailable"}' };
    if (url.endsWith('/state')) return { status: 500, body: 'Internal <b>oops</b>' };
    if (url.endsWith('/refresh')) return { status: 403, body: '' };
    return { status: 204, body: '' };
  });
  const api = createApi({ token: 't', fetchImpl: fn });
  await assert.rejects(api.setColor('u', 1), (e) => e instanceof ApiError && e.status === 409
    && e.body.error === 'tab_colors_unavailable' && /tab_colors_unavailable/.test(e.message));
  await assert.rejects(api.getState(), (e) => e.status === 500 && /Internal/.test(e.body.error));
  await assert.rejects(api.refresh(), (e) => e.status === 403 && /HTTP 403/.test(e.message));
  assert.equal(await api.visit('u'), null);
  assert.equal(await api.request('POST', '/x'), null, 'undefined body becomes {}');
});

test('resolveToken: shell token, then #t= fragment (stored and stripped), then storage', () => {
  const store = new Map();
  const storage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null };
  const replaced = [];
  const history = { replaceState: (a, b, url) => replaced.push(url) };
  assert.equal(resolveToken({ native: { token: 'shell' }, location: { hash: '#t=frag' }, storage }), 'shell');
  assert.equal(resolveToken({ location: { hash: '#t=ab%2Bc', pathname: '/', search: '?mode=compact' }, storage, history }), 'ab+c');
  assert.equal(store.get(TOKEN_STORAGE_KEY), 'ab+c');
  assert.deepEqual(replaced, ['/?mode=compact']);
  assert.equal(resolveToken({ location: { hash: '#frame=mac&t=zz' }, storage }), 'zz');
  assert.equal(resolveToken({ location: { hash: '' }, storage }), 'zz');
  assert.equal(resolveToken({ native: { token: '' }, storage }), 'zz');
  assert.equal(resolveToken({}), '');
  assert.equal(resolveToken(), '');
  const broken = { setItem() { throw new Error('private'); }, getItem() { throw new Error('private'); } };
  assert.equal(resolveToken({ location: { hash: '#t=q' }, storage: broken }), 'q');
  assert.equal(resolveToken({ storage: broken }), '');
  assert.equal(resolveToken({ location: { hash: '#t=q' }, history }), 'q');
});

// --- bridge ----------------------------------------------------------------------

test('bridge: posts every outbound message through webkit.messageHandlers.everwatch', () => {
  const posted = [];
  const win = {
    everwatchNative: { shell: true, token: 't', shellVersion: '0.1.0', queue: [], dispatch(m) { this.queue.push(m); } },
    webkit: { messageHandlers: { everwatch: { postMessage: (m) => posted.push(m) } } },
  };
  const b = createBridge(win);
  assert.equal(b.shell, true);
  assert.equal(b.shellVersion, '0.1.0');
  assert.equal(b.available(), true);
  b.appearance('dark');
  b.openCompact();
  b.openSettings();
  b.requestNotifications();
  b.openSystemSettings('automation');
  b.setHotkeys('opt+cmd+e', '');
  b.ready();
  assert.deepEqual(posted, [
    { type: 'appearance', theme: 'dark' }, { type: 'openCompact' }, { type: 'openSettings' },
    { type: 'requestNotifications' }, { type: 'openSystemSettings', pane: 'automation' },
    { type: 'setHotkeys', show: 'opt+cmd+e', next: '' }, { type: 'ready' },
  ]);
  assert.deepEqual(OUTBOUND.slice().sort(), [...new Set(posted.map((m) => m.type))].sort());
  assert.throws(() => b.post({ type: 'playSound' }), /unknown bridge message/);
  assert.throws(() => b.post(null), /unknown/);
});

test('bridge: install drains the queue and replaces dispatch; filters unknown types', () => {
  const got = [];
  const native = { shell: true, queue: [{ type: 'focus', key: true }, { type: 'bogus' }, null], dispatch(m) { this.queue.push(m); } };
  const b = createBridge({ everwatchNative: native });
  assert.equal(b.install((m) => got.push(m)), 3);
  assert.equal(b.install(() => {}), 0, 'second install is a no-op');
  native.dispatch({ type: 'notificationClicked', uid: 'U' });
  native.dispatch({ type: 'nativeStatus', automation: 'denied' });
  native.dispatch({ type: 'openSettings' });
  native.dispatch('junk');
  assert.deepEqual(got.map((m) => m.type), ['focus', 'notificationClicked', 'nativeStatus', 'openSettings']);
  assert.equal(native.queue.length, 0);
  assert.equal(createBridge({ everwatchNative: { shell: true, queue: 'nope' } }).install(() => {}), 0);
});

test('bridge: browser mode has no shell and posts are no-ops', () => {
  const b = createBridge({});
  assert.equal(b.shell, false);
  assert.equal(b.available(), false);
  assert.equal(b.ready(), false);
  assert.equal(b.install(() => {}), 0);
  const throwing = createBridge({ webkit: { messageHandlers: { everwatch: { postMessage() { throw new Error('x'); } } } } });
  assert.equal(throwing.ready(), false);
  const notFn = createBridge({ webkit: { messageHandlers: { everwatch: {} } } });
  assert.equal(notFn.ready(), false);
  assert.equal(createBridge(null).shell, false);
  assert.equal(createBridge().shell, false);
});
