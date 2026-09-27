// Command registry: keymap ids → behaviour. The key handler, toolbar
// buttons, the context menu, and the command palette (views/palette.mjs)
// all call `run(id, args)`. `LATER` lists ids not yet implemented by any
// package; they report `false` so keys fall through instead of being
// swallowed.

import { nextSort, nextView, nextWaiting, moveSelection, clampRatio, SORT_LABELS } from './lib/rows.mjs';
import { percent } from './lib/format.mjs';
import { nextTheme } from './lib/theme.mjs';
import { prefsOf, rowsOf, selectedUidOf, sessionsOf } from './store.mjs';

/** Commands whose UI lands in a later work package. */
export const LATER = Object.freeze([]);

/** iTerm2 tab-color presets, in project-slot order 1–5 (P-61). */
export const SLOT_COLORS = Object.freeze(['blue', 'purple', 'green', 'red', 'yellow']);

// Native timers must be called unbound (`timers.setTimeout(...)` with
// `this === timers` throws "Illegal invocation" in browsers).
const REAL_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

export function createCommands({
  store, api, bridge = null, ui = {}, clock = () => Date.now() / 1000,
  prefsDebounceMs = 250, timers = REAL_TIMERS,
}) {
  const dispatch = (a) => store.dispatch(a);
  const toast = (message, level = 'info', key = null, action = null) => dispatch({ type: 'toast', message, level, key, action });
  const failed = (kind) => (err) => toast(`${kind} failed: ${err?.body?.error || err?.message || err}`, 'danger');

  function model() {
    const state = store.getState();
    const rows = rowsOf(state);
    const uid = selectedUidOf(state, rows);
    const row = rows.find((r) => r.s.uid === uid) || null;
    return { state, rows, uid, session: row ? row.s : null };
  }

  // --- prefs (optimistic, PATCH /api/prefs) ---------------------------------
  let prefTimer = null;
  let prefBatch = {};
  function flushPrefs() {
    if (prefTimer !== null) timers.clearTimeout(prefTimer);
    prefTimer = null;
    const sent = prefBatch;
    prefBatch = {};
    if (!Object.keys(sent).length) return Promise.resolve(null);
    return api.patchPrefs(sent).then(
      (prefs) => { dispatch({ type: 'prefsConfirmed', prefs: prefs || {}, sent }); return prefs; },
      (err) => { dispatch({ type: 'prefsRejected', sent }); failed('prefs')(err); return null; },
    );
  }
  function setPrefs(patch, { debounce = false } = {}) {
    dispatch({ type: 'prefsPending', prefs: patch, localNow: clock() });
    Object.assign(prefBatch, patch);
    if (!debounce) return flushPrefs();
    if (prefTimer !== null) timers.clearTimeout(prefTimer);
    prefTimer = timers.setTimeout(flushPrefs, prefsDebounceMs);
    return Promise.resolve(null);
  }

  // --- selection (P-40): explicit selection changes count as a visit --------
  function select(uid, { visit = true } = {}) {
    const before = model().uid;
    dispatch({ type: 'select', uid });
    if (uid && visit && uid !== before) api.visit(uid).catch(() => {});
    return true;
  }

  function move(delta) {
    const { rows, uid } = model();
    if (!rows.length) return false;
    const target = store.getState().selection.none && !uid ? rows[delta < 0 ? rows.length - 1 : 0].s.uid
      : moveSelection(rows, uid, delta);
    return select(target);
  }

  function editLabel() {
    const { session } = model();
    if (!session) return false;
    dispatch({ type: 'editLabel', uid: session.uid });
    return true;
  }

  function saveLabel(uid, value) {
    const label = String(value ?? '').trim();
    dispatch({ type: 'editLabel', uid: null });
    const s = sessionsOf(store.getState()).find((x) => x.uid === uid);
    if (!s || (s.label || '') === label) return true;
    dispatch({ type: 'labelPending', uid, label, localNow: clock() });
    api.setLabel(uid, label).catch((err) => {
      dispatch({ type: 'labelRejected', uid });
      failed('label')(err);
    });
    return true;
  }

  function resizeSplit(delta) {
    const ratio = clampRatio(prefsOf(store.getState()).split_ratio + delta);
    setPrefs({ split_ratio: ratio });
    toast(`list pane ${percent(ratio)} of width`, 'info', 'split');
    return true;
  }

  // No toast: a show/hide/on-off toggle doesn't need a confirmation popup
  // (user preference — "we don't need a popup telling us when we just hid
  // or showed something"). The control's own state (a checked toggle in
  // Settings, dollars appearing in the footer, …) is the feedback.
  function togglePref(key) {
    const on = !prefsOf(store.getState())[key];
    setPrefs({ [key]: on });
    return true;
  }

  function projectLabel(slot) {
    const p = store.getState().server?.projects;
    const s = p?.slots?.find((x) => x.n === slot);
    return s?.name || `project ${slot}`;
  }

  // A 409 `tab_colors_unavailable` (P-60/P-62) gets an actionable toast
  // instead of the generic `{kind} failed: …`, routing to Diagnostics.
  function colorFailed(err) {
    if (err?.status === 409 && err?.body?.error === 'tab_colors_unavailable') {
      toast('tab colors unavailable', 'warn', 'color', { label: 'Set up…', command: 'diagnose.open' });
      return;
    }
    failed('color')(err);
  }

  // ↑ from the top session enters the projects panel (P-41). Zoom reuses
  // 'select.up' too (to switch sessions while zoomed), so only steal the key
  // outside zoom, where the projects panel doesn't apply.
  function selectUp() {
    const st = store.getState();
    if (st.overlay !== 'zoom') {
      const { rows, uid } = model();
      if (rows.length && uid === rows[0].s.uid) {
        setPrefs({ projects_open: true });
        dispatch({ type: 'projectsFocus' });
        return true;
      }
    }
    return move(-1);
  }

  const handlers = {
    'select.up': () => selectUp(),
    'select.down': () => move(1),
    'grid.left': () => move(-1),
    'grid.right': () => move(1),
    'grid.up': () => move(-(ui.gridColumns?.() || 1)),
    'grid.down': () => move(ui.gridColumns?.() || 1),
    'select.uid': ({ uid }) => select(uid),
    'session.goto': ({ uid } = {}) => {
      const target = uid ? sessionsOf(store.getState()).find((s) => s.uid === uid) : model().session;
      if (!target) return false;
      if (uid) select(uid);
      api.goto(target.uid).catch(failed('goto'));
      toast(`→ tab ${target.tab_label}`, 'info', 'goto');
      return true;
    },
    'waiting.next': () => {
      const { state, uid } = model();
      const target = nextWaiting(state.server?.waiting_order, uid);
      if (!target) {
        toast('no sessions waiting', 'info', 'waiting');
        return true;
      }
      // a filter that hides the target would snap the selection away
      if (state.filter.text && !rowsOf(state).some((r) => r.s.uid === target)) {
        dispatch({ type: 'filter', text: '' });
      }
      return select(target);
    },
    'filter.focus': () => {
      dispatch({ type: 'filterEditing', editing: true });
      ui.focusFilter?.();
      return true;
    },
    'filter.set': ({ text }) => {
      dispatch({ type: 'filter', text });
      return true;
    },
    'filter.keep': () => {
      dispatch({ type: 'filterEditing', editing: false });
      ui.blurFilter?.();
      return true;
    },
    'filter.clear': () => {
      dispatch({ type: 'filter', text: '' });
      dispatch({ type: 'filterEditing', editing: false });
      ui.blurFilter?.();
      return true;
    },
    'sort.cycle': () => {
      const sort = nextSort(prefsOf(store.getState()).sort);
      setPrefs({ sort });
      toast(`sort: ${sort}`, 'info', 'sort');
      return true;
    },
    'sort.set': ({ sort }) => {
      if (!SORT_LABELS[sort]) return false;
      setPrefs({ sort });
      toast(`sort: ${sort}`, 'info', 'sort');
      return true;
    },
    'escape.unwind': () => {
      const s = store.getState();
      if (s.overlay) dispatch({ type: 'overlay', overlay: null });
      else if (s.filter.text) dispatch({ type: 'filter', text: '' });
      else dispatch({ type: 'clearSelection' });
      return true;
    },
    'label.edit': ({ uid } = {}) => {
      if (uid) select(uid);
      return editLabel();
    },
    'label.save': ({ uid, value } = {}) => saveLabel(uid || store.getState().editingLabel, value),
    'label.cancel': () => {
      dispatch({ type: 'editLabel', uid: null });
      return true;
    },
    'tab.new': () => {
      api.newTab().catch(failed('new'));
      toast('opening new tab…', 'info', 'new');
      return true;
    },
    'session.refresh': () => {
      api.refresh().catch(failed('refresh'));
      toast('refreshing…', 'info', 'refresh');
      return true;
    },
    'view.cycle': () => {
      setPrefs({ view: nextView(prefsOf(store.getState()).view) });
      return true;
    },
    'view.split': () => { setPrefs({ view: 'split' }); return true; },
    'view.list': () => { setPrefs({ view: 'list' }); return true; },
    'view.grid': () => { setPrefs({ view: 'grid' }); return true; },
    'zoom.open': () => {
      if (!model().session) return false;
      dispatch({ type: 'overlay', overlay: 'zoom' });
      return true;
    },
    'zoom.exit': () => {
      dispatch({ type: 'overlay', overlay: null });
      return true;
    },
    'split.grow': () => resizeSplit(0.05),
    'split.shrink': () => resizeSplit(-0.05),
    'split.set': ({ ratio, commit = false }) => {
      setPrefs({ split_ratio: clampRatio(ratio) }, { debounce: !commit });
      return true;
    },
    'grid.toggleAll': () => {
      setPrefs({ grid_all: !prefsOf(store.getState()).grid_all });
      return true;
    },
    'tab.close': ({ uid } = {}) => {
      const target = uid ? sessionsOf(store.getState()).find((s) => s.uid === uid) : model().session;
      if (!target) return false;
      dispatch({
        type: 'dialog',
        dialog: {
          kind: 'closeTab', uid: target.uid, window_id: target.window_id, tab_index: target.tab_index,
          label: target.tab_label, name: target.display_name || target.name,
        },
      });
      return true;
    },
    'projects.toggle': () => {
      setPrefs({ projects_open: !prefsOf(store.getState()).projects_open });
      return true;
    },
    'projects.clear': () => {
      dispatch({ type: 'dialog', dialog: { kind: 'clearProjects' } });
      return true;
    },
    'project.rename': ({ n, name } = {}) => {
      if (!(n >= 1 && n <= 5)) return false;
      api.setProject(n, String(name ?? '').trim()).catch(failed('project'));
      return true;
    },
    // Per-slot clear (P-61 sidebar rework): the same PUT /api/projects/{n}
    // rename path with an empty name — there's no separate backend
    // endpoint, and none is needed. Undoable: the success toast's action
    // button re-runs `project.rename` with the name it just cleared.
    'project.clear': ({ n } = {}) => {
      if (!(n >= 1 && n <= 5)) return false;
      const slot = store.getState().server?.projects?.slots?.find((x) => x.n === n);
      const prevName = slot?.name || '';
      if (!prevName) return true;
      api.setProject(n, '').then(
        () => toast(`project ${n} cleared`, 'info', 'project', { label: 'Undo', command: 'project.rename', args: { n, name: prevName } }),
        failed('project'),
      );
      return true;
    },
    'color.assign': ({ slot, uid } = {}) => {
      const target = uid ? sessionsOf(store.getState()).find((s) => s.uid === uid) : model().session;
      if (!target || !(slot >= 1 && slot <= 5)) return false;
      const color = SLOT_COLORS[slot - 1];
      const name = projectLabel(slot);
      api.setColor(target.uid, slot).then(
        () => toast(`tab ${target.tab_label} → ${color} (${name})`),
        colorFailed,
      );
      return true;
    },
    'color.clear': ({ uid } = {}) => {
      const target = uid ? sessionsOf(store.getState()).find((s) => s.uid === uid) : model().session;
      if (!target) return false;
      api.setColor(target.uid, null).then(
        () => toast(`tab ${target.tab_label}: color cleared`),
        colorFailed,
      );
      return true;
    },
    'dialog.confirm': () => {
      const d = store.getState().dialog;
      if (!d) return false;
      dispatch({ type: 'dialog', dialog: null });
      if (d.kind === 'closeTab') {
        api.closeTab(d.window_id, d.tab_index).catch(failed('close'));
        toast(`closing tab ${d.label}…`, 'info', 'close');
      } else if (d.kind === 'clearProjects') {
        api.clearProjects().then(() => toast('projects cleared'), failed('clear'));
      }
      return true;
    },
    'dialog.cancel': () => {
      if (!store.getState().dialog) return false;
      dispatch({ type: 'dialog', dialog: null });
      return true;
    },
    'debug.toggle': () => togglePref('debug_state'),
    // A18 (§4.9): right-clicking (or opening via the project chip) selects
    // the row first, like every other native context menu. Not a `select()`
    // visit (no `api.visit` call): a right-click for the menu isn't the
    // explicit "go to" a real selection change is.
    'contextmenu.open': ({ uid, x, y } = {}) => {
      if (!uid) return false;
      dispatch({ type: 'select', uid });
      dispatch({ type: 'contextMenu', menu: { uid, x: x || 0, y: y || 0 } });
      return true;
    },
    'contextmenu.close': () => {
      if (!store.getState().contextMenu) return false;
      dispatch({ type: 'contextMenu', menu: null });
      return true;
    },
    'usage.open': () => { dispatch({ type: 'route', route: 'usage' }); return true; },
    'usage.close': () => { dispatch({ type: 'route', route: 'main' }); return true; },
    'route.back': () => { dispatch({ type: 'route', route: 'main' }); return true; },
    'settings.open': () => { dispatch({ type: 'route', route: 'settings' }); return true; },
    'help.open': () => { dispatch({ type: 'overlay', overlay: 'help' }); return true; },
    // Only ever closes the help sheet itself: the <dialog>'s 'close' event
    // is queued as a task (views/help.mjs), so it can land after the next
    // key already opened another overlay (e.g. Esc then ⌘K) — it must not
    // close that one.
    'help.close': () => {
      if (store.getState().overlay === 'help') dispatch({ type: 'overlay', overlay: null });
      return true;
    },
    'dollars.toggle': () => togglePref('show_dollars'),
    'agents.toggle': () => togglePref('agents_only'),
    'sound.toggle': () => togglePref('sound_on_attention'),
    'notify.toggle': () => togglePref('notify_on_waiting'),
    'dockBadge.toggle': () => togglePref('show_dock_badge'),
    'hints.toggle': () => togglePref('show_hints'),
    // Same reasoning as togglePref's other callers (no toast).
    'activity.toggle': () => {
      setPrefs({ show_row_activity: !prefsOf(store.getState()).show_row_activity });
      return true;
    },
    'theme.set': ({ theme }) => { setPrefs({ theme }); return true; },
    // The toolbar button switches to the opposite visible palette. Settings
    // also offers Match System as a persistent choice.
    'theme.cycle': () => {
      const pref = prefsOf(store.getState()).theme;
      setPrefs({ theme: nextTheme(pref, window.matchMedia('(prefers-color-scheme: dark)').matches) });
      return true;
    },
    'sessionFont.set': ({ font }) => { setPrefs({ session_font: font }); return true; },
    'sessionFontSize.set': ({ size }) => { setPrefs({ session_font_size: Number(size) }); return true; },
    'compact.toggle': () => {
      if (bridge?.shell && bridge.openCompact()) return true;
      toast('Compact mode needs the Everwatch app (not available in browser mode)', 'warn');
      return true;
    },
    'app.quitHint': () => {
      const s = store.getState();
      if (s.overlay) dispatch({ type: 'overlay', overlay: null });
      else toast('⌘Q to quit', 'info', 'quit');
      return true;
    },
    'iterm.launch': () => {
      api.launchIterm().catch(failed('launch'));
      toast('launching iTerm2…');
      return true;
    },
    'automation.settings': ({ pane = 'automation' } = {}) => {
      if (bridge?.shell && bridge.openSystemSettings(pane)) return true;
      const text = pane === 'notifications'
        ? 'Open System Settings → Notifications, then allow Everwatch'
        : 'Open System Settings → Privacy & Security → Automation, then allow iTerm2 for your terminal';
      toast(text, 'warn');
      return true;
    },
    'diagnose.open': () => { dispatch({ type: 'route', route: 'diagnostics' }); return true; },
    // --- WP7: diagnostics recheck/install/import, notifications, hotkeys, onboarding ---
    'diagnostics.recheck': () => {
      api.recheckDiagnostics().then((d) => dispatch({ type: 'diagnostics', payload: d })).catch(failed('diagnostics'));
      return true;
    },
    'colors.install': () => {
      api.installColors().catch(failed('colors install'));
      toast('Installing tab colors…', 'info', 'colors');
      return true;
    },
    'ultrawatch.import': () => {
      api.importUltrawatch().then((res) => {
        const n = res?.imported || {};
        toast(`Imported ${n.labels || 0} label(s), ${n.projects || 0} project(s)`, 'info');
      }, failed('import'));
      return true;
    },
    'notifications.request': () => {
      if (bridge?.shell) { bridge.requestNotifications(); return true; }
      toast('Notifications need the Everwatch app (not available in browser mode)', 'warn');
      return true;
    },
    'hotkeys.set': ({ show, next } = {}) => {
      setPrefs({ hotkey_show: show, hotkey_next: next });
      if (bridge?.shell) bridge.setHotkeys(show, next);
      return true;
    },
    'onboarding.open': () => { dispatch({ type: 'route', route: 'onboarding' }); return true; },
    'onboarding.finish': () => {
      setPrefs({ onboarding_done: true });
      dispatch({ type: 'route', route: 'main' });
      return true;
    },
    // Command palette (W-3) / screen search (W-8): views/palette.mjs owns
    // both modes of one overlay and wires these through `ui.paletteToggle`
    // / `ui.paletteClose` (same callback pattern as `ui.focusFilter`) so it
    // can call `dialog.showModal()`/`.close()` synchronously — see that
    // file's header comment for why that has to be imperative, not
    // store-dispatch-then-render.
    'palette.open': () => { ui.paletteToggle?.('command'); return true; },
    'search.screens': () => { ui.paletteToggle?.('search'); return true; },
    'palette.close': () => { ui.paletteClose?.(); return true; },
  };

  for (const id of LATER) if (!handlers[id]) handlers[id] = () => false;

  return {
    run(id, args = {}) {
      const fn = handlers[id];
      return fn ? fn(args) !== false : false;
    },
    has: (id) => id in handlers,
    implemented: (id) => id in handlers && !LATER.includes(id),
    ids: () => Object.keys(handlers),
    setPrefs,
    flushPrefs,
    select,
    /** Extension point for later packages: register or replace a handler. */
    register(id, fn) { handlers[id] = fn; },
  };
}
