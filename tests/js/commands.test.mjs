import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCommands, LATER } from '../../everwatch/web/js/commands.mjs';
import { createStore, initialState, reduce, prefsOf, rowsOf, selectedUidOf } from '../../everwatch/web/js/store.mjs';
import { BINDINGS } from '../../everwatch/web/js/keymap.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/state_sample.json', import.meta.url), 'utf8'));
const NOW = fixture.now;
const byTab = Object.fromEntries(fixture.sessions.map((s) => [s.tab_label, s.uid]));

function fakeApi({ fail = {} } = {}) {
  const calls = [];
  const handler = {
    get(_, name) {
      return (...args) => {
        calls.push([name, ...args]);
        if (fail[name]) return Promise.reject(fail[name]);
        if (name === 'patchPrefs') return Promise.resolve({ ...args[0] });
        return Promise.resolve({ ok: true });
      };
    },
  };
  return { api: new Proxy({}, handler), calls };
}

function fakeTimers() {
  const pending = [];
  return {
    setTimeout: (fn) => { pending.push(fn); return pending.length; },
    clearTimeout: (id) => { pending[id - 1] = null; },
    flush: () => { const fns = pending.splice(0); fns.forEach((f) => f && f()); },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

function setup({ state = fixture, bridge = null, fail, ui = {} } = {}) {
  const store = createStore(reduce(initialState(), { type: 'state', state, localNow: NOW }));
  const { api, calls } = fakeApi({ fail });
  const timers = fakeTimers();
  const cmds = createCommands({ store, api, bridge, ui, clock: () => NOW, timers });
  const sel = () => selectedUidOf(store.getState(), rowsOf(store.getState()));
  const toasts = () => store.getState().toasts.map((t) => t.message);
  return { store, api, calls, cmds, sel, toasts, timers };
}

test('every keymap command id is registered', () => {
  const { cmds } = setup();
  const missing = [...new Set(BINDINGS.map((b) => b.id))].filter((id) => !cmds.has(id) && id !== 'help.close');
  assert.deepEqual(missing, []);
  assert.equal(cmds.has('help.close'), true);
  for (const id of LATER) {
    assert.equal(cmds.implemented(id), false, id);
    assert.equal(cmds.run(id), false, `${id} falls through for now`);
  }
  assert.equal(cmds.implemented('select.up'), true);
  assert.equal(cmds.run('does.not.exist'), false);
  assert.ok(cmds.ids().includes('session.goto'));
  cmds.register('grid.left', () => 'custom');
  assert.equal(cmds.run('grid.left'), true);
});

// # parity: P-40, P-41
test('moving selection visits the newly selected session', async () => {
  const { cmds, sel, calls } = setup();
  const rows = rowsOf(setup().store.getState());
  assert.equal(sel(), rows[0].s.uid);
  cmds.run('select.down');
  assert.equal(sel(), rows[1].s.uid);
  cmds.run('select.up');
  cmds.run('select.up');
  assert.equal(sel(), rows[0].s.uid, 'clamped');
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'visit').map((c) => c[1]), [rows[1].s.uid, rows[0].s.uid]);
  cmds.run('select.uid', { uid: rows[0].s.uid });
  assert.equal(calls.filter((c) => c[0] === 'visit').length, 2, 're-selecting is not a visit');
});

test('from an explicitly cleared selection, ↓ picks the first and ↑ the last row', () => {
  const { cmds, sel, store } = setup();
  const rows = rowsOf(store.getState());
  cmds.run('escape.unwind');
  assert.equal(sel(), null);
  cmds.run('select.up');
  assert.equal(sel(), rows.at(-1).s.uid);
  cmds.run('escape.unwind');
  cmds.run('select.down');
  assert.equal(sel(), rows[0].s.uid);
});

test('grid movement uses the ui column count', () => {
  const { cmds, sel, store } = setup({ ui: { gridColumns: () => 3 } });
  const rows = rowsOf(store.getState());
  cmds.run('grid.down');
  assert.equal(sel(), rows[3].s.uid);
  cmds.run('grid.right');
  assert.equal(sel(), rows[4].s.uid);
  cmds.run('grid.left');
  cmds.run('grid.up');
  assert.equal(sel(), rows[0].s.uid);
  const plain = setup();
  plain.cmds.run('grid.down');
  plain.cmds.run('grid.up');
  assert.equal(plain.sel(), rows[0].s.uid);
});

test('movement with no rows does nothing', () => {
  const { cmds } = setup({ state: { ...fixture, sessions: [] } });
  assert.equal(cmds.run('select.down'), false);
  assert.equal(cmds.run('session.goto'), false);
  assert.equal(cmds.run('zoom.open'), false);
  assert.equal(cmds.run('label.edit'), false);
});

// # parity: P-09, P-33
test('goto posts and toasts → tab N; a failure toasts {kind} failed', async () => {
  const { cmds, calls, toasts } = setup();
  cmds.run('session.goto');
  assert.deepEqual(calls.at(-1), ['goto', fixture.waiting_order[0]]);
  assert.equal(toasts().at(-1), '→ tab 1.1');
  cmds.run('session.goto', { uid: byTab['2.2'] });
  assert.deepEqual(calls.filter((c) => c[0] === 'goto').at(-1), ['goto', byTab['2.2']]);
  assert.equal(toasts().at(-1), '→ tab 2.2');
  assert.equal(cmds.run('session.goto', { uid: 'nope' }), false);
  const bad = setup({ fail: { goto: { body: { error: 'iTerm2 said no' } } } });
  bad.cmds.run('session.goto');
  await tick();
  assert.equal(bad.toasts().at(-1), 'goto failed: iTerm2 said no');
  const bad2 = setup({ fail: { newTab: new Error('offline') } });
  bad2.cmds.run('tab.new');
  await tick();
  assert.equal(bad2.toasts().at(-1), 'new failed: offline');
  const bad3 = setup({ fail: { refresh: 'plain' } });
  bad3.cmds.run('session.refresh');
  await tick();
  assert.equal(bad3.toasts().at(-1), 'refresh failed: plain');
});

// # parity: P-41, P-33
test('a cycles waiting sessions longest-first; none → toast', () => {
  const { cmds, sel, toasts, store } = setup();
  const [w1, w2] = fixture.waiting_order;
  cmds.run('select.uid', { uid: byTab['2.1'] });
  cmds.run('waiting.next');
  assert.equal(sel(), w1);
  cmds.run('waiting.next');
  assert.equal(sel(), w2);
  cmds.run('waiting.next');
  assert.equal(sel(), w1);
  // a filter hiding the target is cleared first
  store.dispatch({ type: 'filter', text: 'terraform' });
  cmds.run('waiting.next');
  assert.equal(store.getState().filter.text, '');
  store.dispatch({ type: 'filter', text: 'src' });
  cmds.run('waiting.next');
  assert.equal(store.getState().filter.text, 'src', 'visible target keeps the filter');
  const none = setup({ state: { ...fixture, waiting_order: [] } });
  none.cmds.run('waiting.next');
  assert.equal(none.toasts().at(-1), 'no sessions waiting');
  assert.ok(toasts().length === 0);
});

// # parity: P-46
test('filter focus / set / keep / clear', () => {
  const focused = [];
  const { cmds, store } = setup({ ui: { focusFilter: () => focused.push('f'), blurFilter: () => focused.push('b') } });
  cmds.run('filter.focus');
  assert.equal(store.getState().filter.editing, true);
  cmds.run('filter.set', { text: 'api' });
  assert.equal(rowsOf(store.getState()).length, 3);
  cmds.run('filter.keep');
  assert.equal(store.getState().filter.editing, false);
  assert.equal(store.getState().filter.text, 'api');
  cmds.run('filter.clear');
  assert.equal(store.getState().filter.text, '');
  assert.deepEqual(focused, ['f', 'b', 'b']);
  const noUi = setup();
  noUi.cmds.run('filter.focus');
  noUi.cmds.run('filter.keep');
  noUi.cmds.run('filter.clear');
});

// # parity: P-47, P-33
test('s cycles sort with a toast and PATCHes prefs', async () => {
  const { cmds, store, calls, toasts } = setup();
  cmds.run('sort.cycle');
  assert.equal(prefsOf(store.getState()).sort, 'agents');
  assert.equal(toasts().at(-1), 'sort: agents');
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'patchPrefs'), ['patchPrefs', { sort: 'agents' }]);
  assert.deepEqual(store.getState().pendingPrefs, { sort: 'agents' }, 'held until the state echo');
  store.dispatch({ type: 'state', state: { ...fixture, prefs: { ...fixture.prefs, sort: 'agents' } }, localNow: NOW });
  assert.deepEqual(store.getState().pendingPrefs, {});
  cmds.run('sort.cycle');
  assert.equal(toasts().filter((t) => t.startsWith('sort:')).length, 1, 'one updating sort toast');
  assert.equal(cmds.run('sort.set', { sort: 'path' }), true);
  assert.equal(prefsOf(store.getState()).sort, 'path');
  assert.equal(cmds.run('sort.set', { sort: 'bogus' }), false);
});

test('prefs PATCH failure rolls back the optimistic value', async () => {
  const { cmds, store, toasts } = setup({ fail: { patchPrefs: { body: { error: 'nope' } } } });
  cmds.run('view.list');
  assert.equal(prefsOf(store.getState()).view, 'list');
  await tick();
  assert.equal(prefsOf(store.getState()).view, 'split');
  assert.equal(toasts().at(-1), 'prefs failed: nope');
});

// # parity: P-43
test('Esc unwinds overlay → filter → selection; q closes overlay or hints ⌘Q', () => {
  const { cmds, store, sel, toasts } = setup();
  store.dispatch({ type: 'filter', text: 'api' });
  cmds.run('help.open');
  cmds.run('escape.unwind');
  assert.equal(store.getState().overlay, null);
  assert.equal(store.getState().filter.text, 'api');
  cmds.run('escape.unwind');
  assert.equal(store.getState().filter.text, '');
  assert.ok(sel());
  cmds.run('escape.unwind');
  assert.equal(sel(), null);
  cmds.run('help.open');
  cmds.run('app.quitHint');
  assert.equal(store.getState().overlay, null);
  cmds.run('app.quitHint');
  assert.equal(toasts().at(-1), '⌘Q to quit');
});

// # parity: P-48
test('label edit / save / cancel with optimistic update', async () => {
  const { cmds, store, calls } = setup();
  const uid = byTab['1.2'];
  cmds.run('label.edit', { uid });
  assert.equal(store.getState().editingLabel, uid);
  cmds.run('label.save', { value: '  charts  ' });
  assert.equal(store.getState().editingLabel, null);
  assert.equal(store.getState().pendingLabels[uid].label, 'charts');
  assert.deepEqual(calls.filter((c) => c[0] === 'setLabel').at(-1), ['setLabel', uid, 'charts']);
  // unchanged label → no request
  const n = calls.length;
  cmds.run('label.save', { uid: byTab['1.1'], value: 'deploy-fix' });
  assert.equal(calls.length, n);
  cmds.run('label.save', { uid: 'ghost', value: 'x' });
  assert.equal(calls.length, n);
  cmds.run('label.edit');
  cmds.run('label.cancel');
  assert.equal(store.getState().editingLabel, null);
  const bad = setup({ fail: { setLabel: { body: { error: 'too long' } } } });
  bad.cmds.run('label.save', { uid, value: 'x' });
  await tick();
  assert.deepEqual(bad.store.getState().pendingLabels, {});
  assert.equal(bad.toasts().at(-1), 'label failed: too long');
  bad.cmds.run('label.save', { uid: byTab['1.1'] });
  assert.equal(bad.store.getState().pendingLabels[byTab['1.1']].label, '', 'undefined value removes the label');
});

// # parity: P-22, P-33
test('< > resize the split in 0.05 steps, clamped, with a toast', async () => {
  const { cmds, store, toasts, timers, calls } = setup();
  cmds.run('split.grow');
  assert.equal(prefsOf(store.getState()).split_ratio, 0.47);
  assert.equal(toasts().at(-1), 'list pane 47% of width');
  for (let i = 0; i < 10; i += 1) cmds.run('split.grow');
  assert.equal(prefsOf(store.getState()).split_ratio, 0.8);
  for (let i = 0; i < 20; i += 1) cmds.run('split.shrink');
  assert.equal(prefsOf(store.getState()).split_ratio, 0.2);
  assert.equal(toasts().at(-1), 'list pane 20% of width');
  // drags debounce, commits flush
  const before = calls.filter((c) => c[0] === 'patchPrefs').length;
  cmds.run('split.set', { ratio: 0.33 });
  cmds.run('split.set', { ratio: 0.34 });
  assert.equal(calls.filter((c) => c[0] === 'patchPrefs').length, before);
  timers.flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'patchPrefs').at(-1), ['patchPrefs', { split_ratio: 0.34 }]);
  cmds.run('split.set', { ratio: 0.9, commit: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'patchPrefs').at(-1), ['patchPrefs', { split_ratio: 0.8 }]);
  assert.equal(await cmds.flushPrefs(), null, 'empty flush');
});

// # parity: P-49
test('v cycles views; ⌘1/2/3 pick one; zoom needs a selection', () => {
  const { cmds, store } = setup();
  cmds.run('view.cycle');
  assert.equal(prefsOf(store.getState()).view, 'list');
  cmds.run('view.cycle');
  assert.equal(prefsOf(store.getState()).view, 'grid');
  cmds.run('view.cycle');
  assert.equal(prefsOf(store.getState()).view, 'split');
  cmds.run('view.grid');
  assert.equal(prefsOf(store.getState()).view, 'grid');
  cmds.run('view.list');
  cmds.run('view.split');
  assert.equal(prefsOf(store.getState()).view, 'split');
  cmds.run('zoom.open');
  assert.equal(store.getState().overlay, 'zoom');
  cmds.run('zoom.exit');
  assert.equal(store.getState().overlay, null);
  cmds.run('grid.toggleAll');
  assert.equal(prefsOf(store.getState()).grid_all, true);
});

test('routes: usage, settings, diagnostics, back', () => {
  const { cmds, store } = setup();
  cmds.run('usage.open');
  assert.equal(store.getState().route, 'usage');
  cmds.run('usage.close');
  assert.equal(store.getState().route, 'main');
  cmds.run('settings.open');
  assert.equal(store.getState().route, 'settings');
  cmds.run('route.back');
  cmds.run('diagnose.open');
  assert.equal(store.getState().route, 'diagnostics');
  cmds.run('help.open');
  cmds.run('help.close');
  assert.equal(store.getState().overlay, null);
});

// # parity: P-30
test('help.close only closes the help sheet — a late dialog "close" event never closes the palette opened after it', () => {
  const { cmds, store } = setup();
  cmds.run('help.open');
  cmds.run('help.close');
  store.dispatch({ type: 'overlay', overlay: 'palette' }); // e.g. Esc, then ⌘K straight away
  cmds.run('help.close'); // the help <dialog>'s queued 'close' event arrives now
  assert.equal(store.getState().overlay, 'palette');
});

// # parity: P-33
// User requirement: "we don't need a popup telling us when we just hid or
// showed something" — a show/hide/on-off toggle is never a toast (the
// control's own state, e.g. a checked Settings toggle or the dollars
// appearing in the footer, is the feedback). Real actions/failures still
// toast (see other tests in this file).
test('toggles: dollars, sound on attention, hints, theme never toast', () => {
  const { cmds, store, toasts } = setup();
  cmds.run('dollars.toggle');
  assert.equal(prefsOf(store.getState()).show_dollars, true);
  assert.deepEqual(toasts(), []);
  cmds.run('dollars.toggle');
  assert.deepEqual(toasts(), []);
  cmds.run('sound.toggle');
  assert.equal(prefsOf(store.getState()).sound_on_attention, true);
  assert.deepEqual(toasts(), []);
  cmds.run('sound.toggle');
  assert.deepEqual(toasts(), []);
  cmds.run('hints.toggle');
  assert.equal(prefsOf(store.getState()).show_hints, false);
  assert.deepEqual(toasts(), []);
  cmds.run('hints.toggle');
  assert.deepEqual(toasts(), []);
  cmds.run('theme.set', { theme: 'light' });
  assert.equal(prefsOf(store.getState()).theme, 'light');
});

// # parity: P-10, P-33
test('refresh, new tab, launch iTerm2', () => {
  const { cmds, calls, toasts } = setup();
  cmds.run('session.refresh');
  assert.equal(toasts().at(-1), 'refreshing…');
  cmds.run('tab.new');
  assert.equal(toasts().at(-1), 'opening new tab…');
  cmds.run('iterm.launch');
  assert.equal(toasts().at(-1), 'launching iTerm2…');
  assert.deepEqual(calls.map((c) => c[0]), ['refresh', 'newTab', 'launchIterm']);
});

test('shell-only commands use the bridge, or explain in browser mode', () => {
  const posted = [];
  const bridge = {
    shell: true,
    openCompact: () => { posted.push('compact'); return true; },
    openSystemSettings: (pane) => { posted.push(pane); return true; },
  };
  const { cmds, toasts } = setup({ bridge });
  cmds.run('compact.toggle');
  cmds.run('automation.settings');
  assert.deepEqual(posted, ['compact', 'automation']);
  assert.deepEqual(toasts(), []);
  const browser = setup();
  browser.cmds.run('compact.toggle');
  browser.cmds.run('automation.settings');
  assert.match(browser.toasts()[0], /Compact mode needs the Everwatch app/);
  assert.match(browser.toasts()[1], /Automation/);
  const deadBridge = setup({ bridge: { shell: true, openCompact: () => false, openSystemSettings: () => false } });
  deadBridge.cmds.run('compact.toggle');
  assert.equal(deadBridge.toasts().length, 1);
});

test('select() helper used by notificationClicked', async () => {
  const { cmds, sel, calls } = setup();
  cmds.select(byTab['2.3']);
  assert.equal(sel(), byTab['2.3']);
  cmds.select(byTab['2.4'], { visit: false });
  await tick();
  assert.deepEqual(calls.filter((c) => c[0] === 'visit').map((c) => c[1]), [byTab['2.3']]);
  cmds.select(null);
  assert.equal(sel(), null);
});

test('defaults: prefs debounce uses unbound (browser-safe) timers', async () => {
  const { setTimeout: st, clearTimeout: ct } = globalThis;
  const strict = (real) => function strictTimer(...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return real(...args);
  };
  globalThis.setTimeout = strict(st);
  globalThis.clearTimeout = strict(ct);
  try {
    const store = createStore(reduce(initialState(), { type: 'state', state: fixture, localNow: NOW }));
    const cmds = createCommands({ store, api: fakeApi().api, prefsDebounceMs: 1 });
    cmds.run('split.set', { ratio: 0.3 });
    cmds.run('split.set', { ratio: 0.31 }); // clearTimeout on the pending one
    await new Promise((r) => st(r, 10));
  } finally {
    globalThis.setTimeout = st;
    globalThis.clearTimeout = ct;
  }
});

test('defaults: real timers and clock work', async () => {
  const store = createStore(reduce(initialState(), { type: 'state', state: fixture, localNow: NOW }));
  const { api } = fakeApi();
  const cmds = createCommands({ store, api, prefsDebounceMs: 1 });
  cmds.run('split.set', { ratio: 0.5 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(store.getState().pendingPrefs, { split_ratio: 0.5 }, 'debounced PATCH went out; awaiting echo');
  cmds.run('label.save', { uid: byTab['1.2'], value: 'x' });
  assert.ok(store.getState().pendingLabels[byTab['1.2']].until > 0);
});

// # parity: P-64
test('tab.close opens a confirm dialog; dialog.confirm closes the tab, dialog.cancel dismisses', async () => {
  const { cmds, store, calls, toasts } = setup();
  assert.equal(cmds.run('dialog.confirm'), false, 'no dialog open');
  assert.equal(cmds.run('dialog.cancel'), false, 'no dialog open');
  cmds.run('select.uid', { uid: byTab['1.1'] });
  cmds.run('tab.close');
  const d = store.getState().dialog;
  assert.equal(d.kind, 'closeTab');
  assert.equal(d.label, '1.1');
  cmds.run('dialog.cancel');
  assert.equal(store.getState().dialog, null);
  assert.equal(calls.filter((c) => c[0] === 'closeTab').length, 0);
  cmds.run('tab.close');
  cmds.run('dialog.confirm');
  assert.equal(store.getState().dialog, null);
  assert.deepEqual(calls.at(-1), ['closeTab', d.window_id, d.tab_index]);
  await tick();
  assert.equal(toasts().at(-1), 'closing tab 1.1…');
  assert.equal(cmds.run('tab.close', { uid: 'ghost' }), false);
});

// # parity: P-63
test('projects.clear opens a confirm dialog; confirm clears, toasts "projects cleared"', async () => {
  const { cmds, store, calls, toasts } = setup();
  cmds.run('projects.clear');
  assert.equal(store.getState().dialog.kind, 'clearProjects');
  cmds.run('dialog.confirm');
  assert.equal(store.getState().dialog, null);
  await tick();
  assert.deepEqual(calls.at(-1), ['clearProjects']);
  assert.equal(toasts().at(-1), 'projects cleared');
});

// # parity: P-61
test('projects.toggle PATCHes projects_open; project.rename PATCHes a slot name', async () => {
  const { cmds, store, calls } = setup();
  assert.equal(prefsOf(store.getState()).projects_open, false);
  cmds.run('projects.toggle');
  assert.equal(prefsOf(store.getState()).projects_open, true);
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'patchPrefs'), ['patchPrefs', { projects_open: true }]);
  cmds.run('projects.toggle');
  assert.equal(prefsOf(store.getState()).projects_open, false);
  cmds.run('project.rename', { n: 2, name: '  Docs site  ' });
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'setProject'), ['setProject', 2, 'Docs site']);
  assert.equal(cmds.run('project.rename', { n: 9, name: 'x' }), false);
});

// # parity: P-61
test('project.clear PUTs an empty name for a named slot, toasts with an Undo action; a no-op for an unnamed slot', async () => {
  const { cmds, calls, toasts, store } = setup();
  assert.equal(cmds.run('project.clear', { n: 9 }), false, 'out of range');
  // slot 3 starts unnamed in the fixture: nothing to clear, no API call
  cmds.run('project.clear', { n: 3 });
  await tick();
  assert.equal(calls.find((c) => c[0] === 'setProject'), undefined);
  // slot 1 ("API") is named: clears it and offers Undo
  cmds.run('project.clear', { n: 1 });
  await tick();
  assert.deepEqual(calls.find((c) => c[0] === 'setProject'), ['setProject', 1, '']);
  const t = store.getState().toasts.at(-1);
  assert.equal(t.message, 'project 1 cleared');
  assert.deepEqual(t.action, { label: 'Undo', command: 'project.rename', args: { n: 1, name: 'API' } });
  assert.equal(toasts().at(-1), 'project 1 cleared');
  // running the Undo action restores the name
  cmds.run(t.action.command, t.action.args);
  await tick();
  assert.deepEqual(calls.at(-1), ['setProject', 1, 'API']);
  // a failed clear reports the generic "project failed: …" toast
  const failing = setup({ fail: { setProject: { body: { error: 'boom' } } } });
  failing.cmds.run('project.clear', { n: 1 });
  await tick();
  assert.equal(failing.toasts().at(-1), 'project failed: boom');
});

// `projects_open`/`debug_state` fall back to the server's confirmed value
// (`projects.open` / top-level `debug_state`) once the optimistic edit
// expires without an echo under `prefs` — see store.mjs prefsOf().
test('projects_open / debug_state read from server.projects.open / server.debug_state once pending expires', () => {
  const withOpen = { ...fixture, projects: { ...fixture.projects, open: true }, debug_state: true };
  const store = createStore(reduce(initialState(), { type: 'state', state: withOpen, localNow: NOW }));
  assert.equal(prefsOf(store.getState()).projects_open, true);
  assert.equal(prefsOf(store.getState()).debug_state, true);
});

// # parity: P-18
test('debug.toggle PATCHes debug_state; no toast (show/hide toggle)', () => {
  const { cmds, store, toasts } = setup();
  cmds.run('debug.toggle');
  assert.equal(prefsOf(store.getState()).debug_state, true);
  assert.deepEqual(toasts(), []);
  cmds.run('debug.toggle');
  assert.equal(prefsOf(store.getState()).debug_state, false);
  assert.deepEqual(toasts(), []);
});

// # parity: P-62
test('color.assign PATCHes the tab color and toasts; a 409 toasts an actionable "Set up…"; color.clear', async () => {
  const { cmds, calls, toasts, store } = setup();
  cmds.run('select.uid', { uid: byTab['1.1'] });
  assert.equal(cmds.run('color.assign', { slot: 9 }), false);
  cmds.run('color.assign', { slot: 1 });
  assert.deepEqual(calls.at(-1), ['setColor', byTab['1.1'], 1]);
  await tick();
  assert.equal(toasts().at(-1), 'tab 1.1 → blue (API)');
  cmds.run('color.clear');
  await tick();
  assert.equal(toasts().at(-1), 'tab 1.1: color cleared');
  const unavailable = setup({ fail: { setColor: { status: 409, body: { error: 'tab_colors_unavailable' } } } });
  unavailable.cmds.run('color.assign', { slot: 2 });
  await tick();
  const t = unavailable.store.getState().toasts.at(-1);
  assert.equal(t.message, 'tab colors unavailable');
  assert.deepEqual(t.action, { label: 'Set up…', command: 'diagnose.open' });
  const noSessions = setup({ state: { ...fixture, sessions: [] } });
  assert.equal(noSessions.cmds.run('color.assign', { slot: 1 }), false, 'no selection');
  assert.equal(noSessions.cmds.run('color.clear'), false, 'no selection');
  const other = setup({ fail: { setColor: { body: { error: 'boom' } } } });
  other.cmds.run('select.uid', { uid: byTab['1.1'] });
  other.cmds.run('color.assign', { slot: 1 });
  await tick();
  assert.equal(other.toasts().at(-1), 'color failed: boom');
  assert.equal(store.getState().dialog, null);
});

// # parity: P-41
test('↑ from the top row opens the projects panel and bumps the focus nonce; zoom is unaffected', () => {
  const { cmds, store, sel } = setup();
  const before = store.getState().projectsFocusNonce;
  cmds.run('select.up'); // already at the top row
  assert.equal(prefsOf(store.getState()).projects_open, true);
  assert.equal(store.getState().projectsFocusNonce, before + 1);
  assert.equal(sel(), rowsOf(store.getState())[0].s.uid, 'selection unchanged');
  cmds.run('zoom.open');
  const nonce = store.getState().projectsFocusNonce;
  cmds.run('select.up'); // in zoom, ↑ only switches sessions
  assert.equal(store.getState().projectsFocusNonce, nonce, 'zoom does not steal ↑');
});

// A18 (§4.9): opening the context menu on a row selects it first, like a
// native right-click menu.
test('contextmenu.open / contextmenu.close; A18 selects the row first', () => {
  const { cmds, store, sel } = setup();
  assert.equal(cmds.run('contextmenu.close'), false);
  assert.equal(cmds.run('contextmenu.open'), false);
  cmds.run('contextmenu.open', { uid: byTab['1.1'], x: 10, y: 20 });
  assert.deepEqual(store.getState().contextMenu, { uid: byTab['1.1'], x: 10, y: 20 });
  assert.equal(sel(), byTab['1.1']);
  cmds.run('contextmenu.close');
  assert.equal(store.getState().contextMenu, null);
});

// # parity: W-3, W-8
test('palette.open / search.screens / palette.close delegate to ui.paletteToggle / ui.paletteClose', () => {
  // views/palette.mjs owns the actual dialog open/close mechanics (must be
  // synchronous with the DOM — see that file's header comment) and wires
  // itself in through these `ui` callbacks, the same pattern as
  // `ui.focusFilter`. commands.mjs only forwards to them.
  const toggles = [];
  const { cmds } = setup({ ui: { paletteToggle: (mode) => toggles.push(['toggle', mode]), paletteClose: () => toggles.push(['close']) } });
  assert.equal(cmds.run('palette.open'), true);
  assert.equal(cmds.run('search.screens'), true);
  assert.equal(cmds.run('palette.close'), true);
  assert.deepEqual(toggles, [['toggle', 'command'], ['toggle', 'search'], ['close']]);
  // missing ui callbacks (no palette view mounted) still return true (the
  // key was handled) without throwing
  const bare = setup();
  assert.equal(bare.cmds.run('palette.open'), true);
  assert.equal(bare.cmds.run('search.screens'), true);
  assert.equal(bare.cmds.run('palette.close'), true);
});

// VISUAL_SPEC §4.18 / D4: the Tokens Used strip can't be hidden, so the
// old collapse toggle is gone.
test('usage.collapse.toggle no longer exists (the Tokens Used strip is always visible)', () => {
  const { cmds } = setup();
  assert.equal(cmds.run('usage.collapse.toggle'), false);
});

test('agents.toggle PATCHes agents_only (AI sessions only ↔ all sessions); no toast', () => {
  const { cmds, store, toasts } = setup();
  assert.equal(cmds.run('agents.toggle'), true);
  assert.equal(prefsOf(store.getState()).agents_only, true);
  assert.deepEqual(toasts(), []);
  cmds.run('agents.toggle');
  assert.equal(prefsOf(store.getState()).agents_only, false);
  assert.deepEqual(toasts(), []);
});

test('panes.toggle changes the persisted split-pane preference', () => {
  const { cmds, store } = setup();
  assert.equal(prefsOf(store.getState()).show_secondary_panes, true);
  assert.equal(cmds.run('panes.toggle'), true);
  assert.equal(prefsOf(store.getState()).show_secondary_panes, false);
  cmds.run('panes.toggle');
  assert.equal(prefsOf(store.getState()).show_secondary_panes, true);
});
