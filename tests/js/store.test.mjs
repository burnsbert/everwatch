import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  initialState, reduce, createStore, normalizeConfig, prefsOf, sessionsOf, rowsOf, listedSessionsOf, selectedUidOf,
  effectiveViewOf, contextOf, DEFAULT_PREFS, MAX_TOASTS, PENDING_PREF_SECONDS,
} from '../../everwatch/web/js/store.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/state_sample.json', import.meta.url), 'utf8'));
const NOW = fixture.now;
const loaded = (extra = {}) => reduce(initialState(extra), { type: 'state', state: fixture, localNow: NOW - 100 });

test('state action stores server state, splits screens off, and estimates skew', () => {
  const s = loaded();
  assert.equal(s.server.rev, 412);
  assert.equal('screens' in s.server, false);
  assert.equal(Object.keys(s.screens).length, 9);
  assert.equal(s.skew, 100);
  assert.equal(s.now, NOW);
  const noTime = reduce(s, { type: 'state', state: { ...fixture, now: undefined, screens: undefined } });
  assert.equal(noTime.skew, 100, 'keeps previous skew');
  assert.equal(Object.keys(noTime.screens).length, 9, 'keeps screens when the event has none');
  assert.equal(reduce(s, { type: 'state', state: null }), s);
});

test('older revs are ignored (except for missing screens); hello always resets', () => {
  let s = loaded();
  s = reduce(s, { type: 'state', state: { ...fixture, rev: 500, prefs: { ...fixture.prefs, sort: 'path' }, screens: undefined }, localNow: NOW });
  assert.equal(s.server.rev, 500);
  const uid = fixture.sessions[0].uid;
  s = reduce(s, { type: 'screens', screens: { [uid]: 'newer' } });
  // a late full GET with rev 450 carrying old prefs and screens
  const late = { ...fixture, rev: 450, prefs: { ...fixture.prefs, sort: 'agents' } };
  const after = reduce(s, { type: 'state', state: late, localNow: NOW });
  assert.equal(after, s, 'nothing new → same state');
  assert.equal(prefsOf(after).sort, 'path');
  // …but screens we lack are filled in
  const gap = { ...s, screens: {} };
  const filled = reduce(gap, { type: 'state', state: late, localNow: NOW });
  assert.equal(filled.server.rev, 500);
  assert.equal(Object.keys(filled.screens).length, 9);
  assert.equal(reduce(gap, { type: 'state', state: { ...late, screens: undefined } }), gap);
  // a restarted backend starts over at a low rev: hello accepts it
  const hello = reduce(s, { type: 'hello', payload: { state: { ...fixture, rev: 3 } }, localNow: NOW });
  assert.equal(hello.server.rev, 3);
  // states without a rev are always applied
  const norev = { ...fixture };
  delete norev.rev;
  assert.equal(reduce(s, { type: 'state', state: norev, localNow: NOW }).server.rev, undefined);
});

test('screens merge and prune to live sessions', () => {
  let s = loaded();
  const uid = fixture.sessions[0].uid;
  s = reduce(s, { type: 'screens', screens: { [uid]: 'new text' } });
  assert.equal(s.screens[uid], 'new text');
  assert.equal(reduce(s, { type: 'screens' }).screens[uid], 'new text');
  const fewer = { ...fixture, sessions: fixture.sessions.slice(1), screens: undefined };
  s = reduce(s, { type: 'state', state: fewer, localNow: NOW });
  assert.equal(uid in s.screens, false);
  assert.equal(Object.keys(s.screens).length, 8);
});

test('hello applies config and state (with or without screens)', () => {
  const s = reduce(initialState(), {
    type: 'hello', localNow: NOW,
    payload: { version: '0.1.0', config: { snapshot_interval: 3, FRESH_SECONDS: 20 }, state: { ...fixture, screens: undefined } },
  });
  assert.equal(s.version, '0.1.0');
  assert.equal(s.config.snapshotInterval, 3);
  assert.equal(s.config.freshSeconds, 20);
  assert.equal(s.server.rev, 412);
  assert.deepEqual(s.screens, {});
  const bare = reduce(initialState({ version: 'x' }), { type: 'hello' });
  assert.equal(bare.version, 'x');
  assert.equal(bare.server, null);
});

test('normalizeConfig accepts snake, UPPER, and nested intervals; ignores junk', () => {
  assert.equal(normalizeConfig({ intervals: { snapshot: 5 } }).snapshotInterval, 5);
  assert.equal(normalizeConfig({ flash_seconds: 2, toast_seconds: 4 }).flashSeconds, 2);
  assert.equal(normalizeConfig({ toast_seconds: 4 }).toastSeconds, 4);
  assert.equal(normalizeConfig({ snapshot_interval: -1 }).snapshotInterval, 2);
  assert.equal(normalizeConfig({ snapshot_interval: 'x' }).snapshotInterval, 2);
  assert.equal(normalizeConfig(null).freshSeconds, 30);
  assert.equal(normalizeConfig(7).freshSeconds, 30);
});

// # parity: P-38, P-66
test('transition to waiting flashes for 1.5 s and toasts ◉ name is waiting', () => {
  let s = loaded();
  const uid = fixture.sessions[1].uid;
  s = reduce(s, { type: 'transition', localNow: NOW - 100, transition: { uid, from: 'busy', to: 'waiting', title: 'web-dashboard' } });
  assert.equal(s.flashes[uid], NOW + 1.5);
  assert.deepEqual(s.toasts.at(-1), { id: 1, message: '◉ web-dashboard is waiting for your input', level: 'attention', key: `wait:${uid}`, action: null });
  const untitled = reduce(s, { type: 'transition', localNow: NOW - 100, transition: { uid: 'ABCDEFGHIJK', to: 'waiting' } });
  assert.equal(untitled.toasts.at(-1).message, '◉ ABCDEFGH is waiting for your input');
  assert.equal(reduce(s, { type: 'transition', localNow: 0, transition: { uid, to: 'idle' } }), s);
  assert.equal(reduce(s, { type: 'transition', localNow: 0 }), s);
  // tick expires the flash
  const still = reduce(s, { type: 'tick', localNow: NOW - 99 });
  assert.ok(still.flashes[uid]);
  assert.equal(still.flashes, s.flashes, 'unchanged flashes keep identity');
  const after = reduce(s, { type: 'tick', localNow: NOW - 98.4 });
  assert.equal(uid in after.flashes, false);
  assert.equal(after.now, NOW + 1.6);
});

// # parity: P-31
// §4.13: "At most 3 are stacked; the oldest leaves first."
test('toasts stack (max 3) and expire by id', () => {
  let s = initialState();
  for (let i = 0; i < 6; i += 1) s = reduce(s, { type: 'toast', message: `m${i}` });
  assert.equal(s.toasts.length, MAX_TOASTS);
  assert.deepEqual(s.toasts.map((t) => t.message), ['m3', 'm4', 'm5']);
  assert.equal(s.toasts[0].level, 'info');
  s = reduce(s, { type: 'toastExpire', id: s.toasts[0].id });
  assert.deepEqual(s.toasts.map((t) => t.message), ['m4', 'm5']);
  // same key replaces in place with a fresh id (its timer restarts)
  s = reduce(s, { type: 'toast', message: 'sort: agents', key: 'sort' });
  s = reduce(s, { type: 'toast', message: 'x' });
  const before = s.toasts.find((t) => t.key === 'sort').id;
  s = reduce(s, { type: 'toast', message: 'sort: path', key: 'sort' });
  assert.deepEqual(s.toasts.map((t) => t.message), ['m5', 'sort: path', 'x']);
  assert.ok(s.toasts.find((t) => t.key === 'sort').id > before);
});

// # parity: P-40
test('selection: explicit uid, stale snap to first row, explicit none', () => {
  let s = loaded();
  let rows = rowsOf(s);
  assert.equal(selectedUidOf(s, rows), rows[0].s.uid, 'nothing chosen → first row');
  const pick = rows[3].s.uid;
  s = reduce(s, { type: 'select', uid: pick });
  assert.equal(selectedUidOf(s, rows), pick);
  s = reduce(s, { type: 'filter', text: 'zzzqqq' });
  rows = rowsOf(s);
  assert.equal(selectedUidOf(s, rows), null);
  s = reduce(s, { type: 'filter', text: '' });
  s = reduce(s, { type: 'clearSelection' });
  assert.equal(selectedUidOf(s, rowsOf(s)), null, 'Esc cleared it');
  s = reduce(s, { type: 'select', uid: pick });
  // the selected session vanishes → selection resets and snaps
  const gone = { ...fixture, sessions: fixture.sessions.filter((x) => x.uid !== pick), screens: undefined };
  s = reduce(s, { type: 'state', state: gone, localNow: NOW });
  assert.equal(s.selection.uid, null);
  assert.equal(selectedUidOf(s, rowsOf(s)), rowsOf(s)[0].s.uid);
  s = reduce(s, { type: 'select', uid: null });
  assert.equal(s.selection.none, true);
});

test('prefs: optimistic pending overlay converges only on a server state echo', () => {
  let s = loaded();
  assert.equal(prefsOf(s).sort, 'attention');
  s = reduce(s, { type: 'prefsPending', prefs: { sort: 'agents', split_ratio: 0.5 }, localNow: NOW });
  assert.equal(prefsOf(s).sort, 'agents');
  // a stale state event must not undo the optimistic edit
  s = reduce(s, { type: 'state', state: fixture, localNow: NOW });
  assert.equal(prefsOf(s).sort, 'agents');
  // the server echoes sort → pending sort drops, split_ratio still pending
  s = reduce(s, { type: 'state', state: { ...fixture, prefs: { ...fixture.prefs, sort: 'agents' } }, localNow: NOW });
  assert.deepEqual(s.pendingPrefs, { split_ratio: 0.5 });
  // the PATCH response adopts the server-normalised value but keeps it pending…
  s = reduce(s, { type: 'prefsConfirmed', prefs: { split_ratio: 0.55 }, sent: { split_ratio: 0.5 } });
  assert.deepEqual(s.pendingPrefs, { split_ratio: 0.55 });
  assert.equal(prefsOf(s).split_ratio, 0.55);
  // …so an older in-flight state (0.42) can't revert it
  s = reduce(s, { type: 'state', state: fixture, localNow: NOW + 1 });
  assert.equal(prefsOf(s).split_ratio, 0.55);
  s = reduce(s, { type: 'state', state: { ...fixture, prefs: { ...fixture.prefs, split_ratio: 0.55 } }, localNow: NOW + 1 });
  assert.deepEqual(s.pendingPrefs, {});
  // a newer pending edit survives an older confirm
  s = reduce(s, { type: 'prefsPending', prefs: { view: 'list' }, localNow: NOW });
  s = reduce(s, { type: 'prefsConfirmed', prefs: { view: 'grid' }, sent: { view: 'grid' } });
  assert.equal(prefsOf(s).view, 'list');
  s = reduce(s, { type: 'prefsRejected', sent: { view: 'list' } });
  assert.equal(prefsOf(s).view, 'split', 'rejected → back to the server value');
  s = reduce(s, { type: 'prefsRejected' });
  assert.equal(reduce(s, { type: 'prefsConfirmed' }), s);
  // a late response to an older PATCH never touches server prefs
  const settled = reduce(s, { type: 'state', state: { ...fixture, prefs: { ...fixture.prefs, sort: 'path' } }, localNow: NOW });
  const late = reduce(settled, { type: 'prefsConfirmed', prefs: { sort: 'agents' }, sent: { sort: 'agents' } });
  assert.equal(late, settled);
  assert.equal(prefsOf(late).sort, 'path');
  // a lost echo expires after PENDING_PREF_SECONDS
  s = reduce(s, { type: 'prefsPending', prefs: { theme: 'light' } });
  assert.equal(s.pendingPrefsAt.theme, 0);
  s = reduce(s, { type: 'prefsPending', prefs: { theme: 'dark' }, localNow: NOW });
  s = reduce(s, { type: 'state', state: fixture, localNow: NOW + PENDING_PREF_SECONDS - 1 });
  assert.equal(prefsOf(s).theme, 'dark');
  s = reduce(s, { type: 'state', state: fixture, localNow: NOW + PENDING_PREF_SECONDS + 1 });
  assert.equal(prefsOf(s).theme, 'system');
  // no timestamp → never expires by age
  s = reduce(initialState({ pendingPrefs: { sort: 'path' } }), { type: 'state', state: fixture, localNow: NOW + 999 });
  assert.equal(prefsOf(s).sort, 'path');
  s = reduce(s, { type: 'state', state: fixture });
  assert.equal(prefsOf(s).sort, 'path');
});

test('prefsOf normalises junk and defaults', () => {
  const s = initialState({ server: { prefs: { view: 'weird', sort: 'nope', split_ratio: 3 } } });
  const p = prefsOf(s);
  assert.equal(p.view, 'split');
  assert.equal(p.sort, 'natural');
  assert.equal(p.split_ratio, 0.8);
  assert.equal(prefsOf(initialState()).sort, DEFAULT_PREFS.sort);
});

// # parity: P-48
test('labels: optimistic rename shows immediately and converges', () => {
  let s = loaded();
  const target = fixture.sessions[1]; // unlabeled claude
  s = reduce(s, { type: 'labelPending', uid: target.uid, label: 'charts', localNow: NOW - 100 });
  let row = sessionsOf(s).find((x) => x.uid === target.uid);
  assert.equal(row.label, 'charts');
  assert.equal(row.display_name, 'charts');
  // removing an existing label falls back to the session name
  const labeled = fixture.sessions[0];
  s = reduce(s, { type: 'labelPending', uid: labeled.uid, label: '', localNow: NOW - 100 });
  row = sessionsOf(s).find((x) => x.uid === labeled.uid);
  assert.equal(row.display_name, labeled.name);
  // server echo clears pending
  const echoed = {
    ...fixture,
    screens: undefined,
    sessions: fixture.sessions.map((x) => (x.uid === target.uid ? { ...x, label: 'charts', display_name: 'charts' } : x)),
  };
  s = reduce(s, { type: 'state', state: echoed, localNow: NOW - 100 });
  assert.equal(target.uid in s.pendingLabels, false);
  assert.equal(labeled.uid in s.pendingLabels, true);
  // pending expires after 10 s without an echo
  s = reduce(s, { type: 'state', state: { ...echoed, now: NOW + 11 }, localNow: NOW - 89 });
  assert.equal(labeled.uid in s.pendingLabels, false);
  s = reduce(s, { type: 'labelPending', uid: target.uid, label: 'x', localNow: NOW - 89 });
  s = reduce(s, { type: 'labelRejected', uid: target.uid });
  assert.deepEqual(s.pendingLabels, {});
  assert.equal(sessionsOf(s), s.server.sessions, 'no pending → same array');
  // pending for a vanished session is dropped
  s = reduce(s, { type: 'labelPending', uid: 'ghost', label: 'x', localNow: NOW - 89 });
  s = reduce(s, { type: 'state', state: echoed, localNow: NOW - 89 });
  assert.equal('ghost' in s.pendingLabels, false);
  // a label on a session whose display_name isn't the label keeps it
  const odd = initialState({ server: { sessions: [{ uid: 'u', name: 'n', label: 'L', display_name: 'D' }] },
    pendingLabels: { u: { label: '', until: 0 } } });
  assert.equal(sessionsOf(odd)[0].display_name, 'D');
  const bare = initialState({ server: { sessions: [{ uid: 'u', name: 'n' }] }, pendingLabels: { u: { label: '', until: 0 } } });
  assert.equal(sessionsOf(bare)[0].display_name, 'n');
});

test('editing label clears when that session disappears', () => {
  let s = loaded();
  const uid = fixture.sessions[2].uid;
  s = reduce(s, { type: 'editLabel', uid });
  assert.equal(contextOf(s), 'label');
  s = reduce(s, { type: 'state', state: { ...fixture, sessions: fixture.sessions.filter((x) => x.uid !== uid) }, localNow: NOW });
  assert.equal(s.editingLabel, null);
  s = reduce(s, { type: 'editLabel', uid: fixture.sessions[0].uid });
  s = reduce(s, { type: 'state', state: fixture, localNow: NOW });
  assert.equal(s.editingLabel, fixture.sessions[0].uid);
  assert.equal(reduce(s, { type: 'editLabel' }).editingLabel, null);
});

// # parity: P-23, P-49
test('effective view: split falls back to list when narrow; routes and zoom win', () => {
  let s = loaded();
  assert.equal(effectiveViewOf(s), 'split');
  s = reduce(s, { type: 'narrow', narrow: true });
  assert.equal(effectiveViewOf(s), 'list');
  assert.equal(reduce(s, { type: 'narrow', narrow: true }), s);
  s = reduce(s, { type: 'prefsPending', prefs: { view: 'grid' } });
  assert.equal(effectiveViewOf(s), 'grid');
  assert.equal(reduce(s, { type: 'overlay', overlay: 'zoom' }) && effectiveViewOf(reduce(s, { type: 'overlay', overlay: 'zoom' })), 'zoom');
  s = reduce(s, { type: 'route', route: 'usage' });
  assert.equal(effectiveViewOf(s), 'usage');
  assert.equal(reduce(s, { type: 'route' }).route, 'main');
});

test('keymap context follows UI state', () => {
  let s = loaded();
  assert.equal(contextOf(s), 'main');
  assert.equal(contextOf(reduce(s, { type: 'filterEditing', editing: true })), 'filter');
  assert.equal(contextOf(reduce(s, { type: 'overlay', overlay: 'help' })), 'help');
  assert.equal(contextOf(reduce(s, { type: 'overlay', overlay: 'zoom' })), 'zoom');
  assert.equal(contextOf(reduce(s, { type: 'route', route: 'usage' })), 'usage');
  assert.equal(contextOf(reduce(s, { type: 'route', route: 'settings' })), 'page');
  assert.equal(contextOf(reduce(s, { type: 'prefsPending', prefs: { view: 'grid' } })), 'grid');
  s = reduce(s, { type: 'overlay' });
  assert.equal(s.overlay, null);
});

test('misc actions: conn, native, windowKey, diagnostics, quota, unknown', () => {
  let s = initialState();
  s = reduce(s, { type: 'conn', status: 'open' });
  assert.equal(s.conn, 'open');
  assert.equal(reduce(s, { type: 'conn', status: 'open' }), s);
  s = reduce(s, { type: 'native', patch: { automation: 'granted' } });
  assert.equal(s.native.automation, 'granted');
  s = reduce(s, { type: 'windowKey', key: false });
  assert.equal(s.windowKey, false);
  s = reduce(s, { type: 'diagnostics', payload: { checks: [] } });
  assert.deepEqual(s.diagnostics, { checks: [] });
  assert.equal(reduce(s, { type: 'diagnostics' }).diagnostics, null);
  s = reduce(s, { type: 'quotaPrompt', payload: { pct: 91 } });
  assert.equal(s.quotaPrompt.pct, 91);
  assert.equal(reduce(s, { type: 'quotaPrompt' }).quotaPrompt, null);
  assert.equal(reduce(s, { type: 'nope' }), s);
  s = reduce(s, { type: 'state', state: { ...fixture, quota_prompt: { pct: 95 } }, localNow: NOW });
  assert.equal(s.quotaPrompt.pct, 95);
  const noQuota = { ...fixture };
  delete noQuota.quota_prompt;
  assert.equal(reduce(s, { type: 'state', state: noQuota, localNow: NOW }).quotaPrompt.pct, 95);
  assert.equal(reduce(s, { type: 'filter' }).filter.text, '');
});

// # parity: W-3, W-8
test('overlay carries an optional palette mode; other overlays leave it as-is', () => {
  let s = initialState();
  assert.equal(s.paletteMode, 'command');
  s = reduce(s, { type: 'overlay', overlay: 'palette', mode: 'search' });
  assert.equal(s.overlay, 'palette');
  assert.equal(s.paletteMode, 'search');
  assert.equal(contextOf(s), 'palette');
  const same = reduce(s, { type: 'overlay', overlay: 'palette', mode: 'search' });
  assert.equal(same, s, 'no-op when nothing changed');
  s = reduce(s, { type: 'overlay', overlay: 'palette', mode: 'command' });
  assert.equal(s.paletteMode, 'command');
  s = reduce(s, { type: 'overlay', overlay: 'help' });
  assert.equal(s.overlay, 'help');
  assert.equal(s.paletteMode, 'command', 'unrelated overlay does not touch the palette mode');
  s = reduce(s, { type: 'overlay' });
  assert.equal(s.overlay, null);
});

// # parity: W-5
test('historyStats caches per-uid wait stats from GET /api/history', () => {
  let s = initialState();
  s = reduce(s, { type: 'historyStats', uid: 'u1', count: 3, seconds: 660 });
  assert.deepEqual(s.historyStats.u1, { count: 3, seconds: 660 });
  s = reduce(s, { type: 'historyStats', uid: 'u2' });
  assert.deepEqual(s.historyStats.u2, { count: 0, seconds: 0 });
  assert.deepEqual(s.historyStats.u1, { count: 3, seconds: 660 }, 'other uids are kept');
});

// # parity: W-8
test('searchHighlight survives while the same uid stays selected, clears on any other selection change', () => {
  let s = initialState();
  s = reduce(s, { type: 'select', uid: 'a' });
  s = reduce(s, { type: 'searchHighlight', payload: { uid: 'a', lineIndex: 2, matchStart: 3, matchEnd: 7 } });
  assert.deepEqual(s.searchHighlight, { uid: 'a', lineIndex: 2, matchStart: 3, matchEnd: 7 });
  s = reduce(s, { type: 'select', uid: 'a' });
  assert.ok(s.searchHighlight, 'reselecting the same uid keeps it');
  s = reduce(s, { type: 'select', uid: 'b' });
  assert.equal(s.searchHighlight, null, 'selecting a different uid clears it');
  s = reduce(s, { type: 'searchHighlight', payload: { uid: 'b', lineIndex: 0, matchStart: 0, matchEnd: 1 } });
  s = reduce(s, { type: 'clearSelection' });
  assert.equal(s.searchHighlight, null);
});

// # parity: W-6
test('usageHistory holds the last GET /api/usage/history samples', () => {
  let s = initialState();
  assert.deepEqual(s.usageHistory, []);
  s = reduce(s, { type: 'usageHistory', samples: [{ at: 1, id: 'cc.five_hour', pct: 10 }] });
  assert.deepEqual(s.usageHistory, [{ at: 1, id: 'cc.five_hour', pct: 10 }]);
  s = reduce(s, { type: 'usageHistory' });
  assert.deepEqual(s.usageHistory, []);
});

test('createStore notifies subscribers only on change', () => {
  const store = createStore();
  const seen = [];
  const off = store.subscribe((st, prev, action) => seen.push(action.type));
  store.dispatch({ type: 'conn', status: 'open' });
  store.dispatch({ type: 'conn', status: 'open' });
  store.dispatch({ type: 'nope' });
  assert.deepEqual(seen, ['conn']);
  off();
  store.dispatch({ type: 'conn', status: 'reconnecting' });
  assert.deepEqual(seen, ['conn']);
  assert.equal(store.getState().conn, 'reconnecting');
  assert.equal(createStore(undefined).getState().conn, 'connecting');
});

test('agents_only ("AI sessions only") lists only Claude Code / Codex sessions; the compact panel ignores it', () => {
  const s = loaded();
  assert.equal(DEFAULT_PREFS.agents_only, false);
  assert.equal(rowsOf(s).length, 9, 'off by default: every session');
  const on = reduce(s, { type: 'prefsPending', prefs: { agents_only: true }, localNow: NOW });
  const kinds = rowsOf(on).map((r) => r.s.kind);
  assert.equal(kinds.length, 6);
  assert.ok(kinds.every(Boolean), 'no plain shells');
  assert.equal(listedSessionsOf(on).length, 6);
  // the compact panel keeps its own list
  const compact = reduce(loaded({ compact: true }), { type: 'prefsPending', prefs: { agents_only: true }, localNow: NOW });
  assert.equal(rowsOf(compact).length, 9);
});
