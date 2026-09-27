// Everwatch web UI entry point: token → API + SSE → store → views.
// No build step, no dependencies, no sound (the shell owns the optional
// attention sound; §1 P-66). All session text is rendered via textContent.

import { createApi, resolveToken } from './api.mjs';
import { createEventStream } from './sse.mjs';
import { createStore, initialState, prefsOf, rowsOf, selectedUidOf, effectiveViewOf, contextOf } from './store.mjs';
import { createCommands } from './commands.mjs';
import { createBridge } from './bridge.mjs';
import { resolveEvent } from './keymap.mjs';
import { applyTheme } from './lib/theme.mjs';
import { emptyStateKind } from './lib/format.mjs';
import { registry } from './views/registry.mjs';
import { createHeader } from './views/header.mjs';
import { createFooter } from './views/footer.mjs';
import { createToasts } from './views/toasts.mjs';
import { createHelp } from './views/help.mjs';
import { createEmptyView } from './views/empty.mjs';
import { createConfirm } from './views/confirm.mjs';
import { createQuota } from './views/quota.mjs';
import { createProjectsPanel } from './views/projects.mjs';
import { createContextMenu } from './views/contextmenu.mjs';
import { createPalette } from './views/palette.mjs';
import { createLiveLease, liveTargetOf } from './lib/live.mjs';

const nowSec = () => Date.now() / 1000;
const params = new URLSearchParams(location.search);
const root = document.documentElement;
const compact = params.get('mode') === 'compact';
if (compact) root.dataset.mode = 'compact';

const bridge = createBridge(window);
const token = resolveToken({ native: window.everwatchNative, location, storage: window.sessionStorage, history });
const api = createApi({ token });
const store = createStore(initialState({ native: { shell: bridge.shell, shellVersion: bridge.shellVersion }, compact }));
root.dataset.shell = bridge.shell ? '1' : '0';

let header;
let gridView = null;
const ui = {
  focusFilter: () => header?.focusFilter(),
  blurFilter: () => header?.blurFilter(),
  gridColumns: () => gridView?.columns?.() || 1,
  paletteToggle: null, // assigned below once the palette view exists
  paletteClose: null,
};
const commands = createCommands({ store, api, bridge, ui, clock: nowSec });
const run = (id, args) => commands.run(id, args);

header = createHeader({ run });
const footer = createFooter({ run });
const toasts = createToasts({ store, run });
const help = createHelp({ run });
const confirmDialog = createConfirm({ run });
const quota = createQuota({ api, store });
const projectsPanel = createProjectsPanel({ run, store });
const contextMenu = createContextMenu({ run, store });
const palette = createPalette({ run, store });
ui.paletteToggle = (mode) => palette.open(mode);
ui.paletteClose = () => palette.close();
document.getElementById('app').append(projectsPanel.el);

// --- content area: one registered view at a time, instances cached ----------
const content = document.getElementById('content');
const appEl = document.getElementById('app');
const empty = createEmptyView({ run, shell: bridge.shell });
content.append(empty.el);
const instances = new Map();
let current = null;

function viewFor(name) {
  if (!instances.has(name)) {
    const factory = registry[name] || registry.split;
    const v = factory({ run, store, api });
    v.el.dataset.viewName = name;
    v.el.hidden = true;
    content.append(v.el);
    instances.set(name, v);
    if (name === 'grid') gridView = v;
  }
  return instances.get(name);
}

// --- theme (§3.6) --------------------------------------------------------------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
let appliedTheme = null;
function syncTheme(pref) {
  const key = `${pref}|${darkQuery.matches}`;
  if (key === appliedTheme) return;
  const prefChanged = !appliedTheme || appliedTheme.split('|')[0] !== pref;
  appliedTheme = key;
  applyTheme(root, pref, darkQuery.matches);
  if (prefChanged && bridge.shell) bridge.appearance(pref);
}
darkQuery.addEventListener('change', () => syncTheme(prefsOf(store.getState()).theme));

// --- responsive split fallback (P-23) ------------------------------------------
const narrowQuery = matchMedia('(max-width: 899px)');
store.dispatch({ type: 'narrow', narrow: narrowQuery.matches });
narrowQuery.addEventListener('change', (e) => store.dispatch({ type: 'narrow', narrow: e.matches }));

// --- render ------------------------------------------------------------------------
function buildModel(state) {
  const prefs = prefsOf(state);
  const rows = rowsOf(state);
  const selectedUid = selectedUidOf(state, rows);
  const selected = rows.find((r) => r.s.uid === selectedUid)?.s || null;
  const server = state.server;
  return {
    state, prefs, rows, selectedUid, selected, server,
    total: server?.sessions?.length || 0,
    now: state.now,
    started: server?.started || 0,
    freshSeconds: state.config.freshSeconds,
    config: state.config,
    flashes: state.flashes,
    editingLabel: state.editingLabel,
    projects: server?.projects,
    usage: server?.usage,
    filter: state.filter.text,
    filterEditing: state.filter.editing,
    sort: prefs.sort,
    splitRatio: prefs.split_ratio,
    screen: selectedUid ? state.screens[selectedUid] : '',
    snapshotAt: server?.iterm?.snapshot_at || 0,
    debugState: !!server?.debug_state,
    toasts: state.toasts,
    overlay: state.overlay,
    conn: state.conn,
    view: effectiveViewOf(state),
    context: contextOf(state),
    dialog: state.dialog,
    contextMenu: state.contextMenu,
    quotaPrompt: state.quotaPrompt,
    projectsFocusNonce: state.projectsFocusNonce,
    compact: state.compact,
    paletteMode: state.paletteMode,
    historyStats: state.historyStats,
    usageHistorySamples: state.usageHistory,
    searchHighlight: state.searchHighlight,
  };
}

let lastTitle = '';
function render() {
  const state = store.getState();
  const m = buildModel(state);
  syncTheme(m.prefs.theme);
  const font = ['system', 'sans', 'mono'].includes(m.prefs.session_font) ? m.prefs.session_font : 'system';
  const size = [12, 13, 14, 15, 16, 18].includes(m.prefs.session_font_size) ? m.prefs.session_font_size : 15;
  root.dataset.sessionFont = font;
  root.dataset.sessionFontSize = String(size);
  header.update(m);
  footer.update(m);
  toasts.update(m);
  help.update(m);
  confirmDialog.update(m);
  quota.update(m);
  projectsPanel.update(m);
  contextMenu.update(m);
  palette.update(m);

  const kind = state.route === 'main' ? emptyStateKind({ server: m.server, conn: m.conn, token }) : null;
  empty.el.hidden = !kind;
  empty.update({ kind, server: m.server });
  const name = kind ? null : m.view;
  const next = name ? viewFor(name) : null;
  if (next !== current) {
    if (current) current.el.hidden = true;
    if (next) next.el.hidden = false;
    current = next;
  }
  if (current) current.update(m);
  appEl.dataset.view = name || 'empty';
  appEl.dataset.context = m.context;
  // §4.3: the selected row goes gray (--bg-selected-inactive) while the
  // app window isn't key (the shell's `focus` message → state.windowKey).
  const key = state.windowKey === false ? '0' : '1';
  if (root.dataset.key !== key) root.dataset.key = key;
  // §4.7: the projects column is a vertical accordion, always occupying
  // at least the collapsed rail's width on the main route (never fully
  // gone the way the old toggle-button-hidden panel was).
  appEl.classList.toggle('projects-visible', !m.compact && m.state.route === 'main');
  appEl.classList.toggle('projects-open', !!m.prefs.projects_open && !m.compact && m.state.route === 'main');

  const waiting = m.server?.counts?.waiting || 0;
  const title = waiting ? `Everwatch — ${waiting} waiting` : 'Everwatch';
  if (title !== lastTitle) document.title = lastTitle = title;
  if (m.server && document.body.dataset.ready !== '1') document.body.dataset.ready = '1';
}

// Coalesce every dispatch in a task into one render (a microtask, not rAF,
// so rendering doesn't stall while a test clock or hidden window pauses rAF).
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    render();
  });
}
store.subscribe(schedule);

// --- keyboard (keymap.mjs is the single source of bindings) --------------------
document.addEventListener('keydown', (e) => {
  if (e.isComposing || e.defaultPrevented) return;
  // The quota-email modal (P-69) has no keymap context of its own: leave its
  // Escape key alone so the native <dialog> "cancel" event (→ quota.mjs,
  // which skips-and-dismisses) fires, instead of an unrelated command (e.g.
  // escape.unwind) calling preventDefault and swallowing it first.
  if (store.getState().quotaPrompt) return;
  const t = e.target;
  let ctx = contextOf(store.getState());
  if (t instanceof Element && t.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]')) {
    // The palette's own input (views/palette.mjs) handles ArrowUp/Down,
    // Enter and Escape itself (same pattern as the row label editor), but
    // still needs ⌘K / ⌘⇧F to reach their 'palette' bindings so they can
    // switch modes without the input ever losing focus.
    if (t.id === 'palette-input') ctx = 'palette';
    else if (t.id !== 'filter') return; // row editor & other form controls handle their own keys
    else ctx = 'filter';
  } else if (t instanceof Element && t.matches('button, [role="button"]') && (e.key === 'Enter' || e.key === ' ')) {
    // A focused custom button — a quota chip, a project chip, the theme
    // toggle, … — activates on its own Enter/Space (the native <button>
    // behavior). Without this, a main-context binding on the same key
    // (session.goto on Enter, zoom.open on Space) would resolve first and
    // call preventDefault, swallowing the button's own click.
    return;
  } else if (ctx === 'filter') {
    ctx = 'main';
  }
  const r = resolveEvent(e, ctx);
  if (!r) return;
  if (commands.run(r.id, r.args)) e.preventDefault();
});

// --- server connection ---------------------------------------------------------
async function loadFullState() {
  try {
    const st = await api.getState();
    store.dispatch({ type: 'state', state: st, localNow: nowSec() });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403) store.dispatch({ type: 'toast', message: 'Not authorised — reopen Everwatch', level: 'danger' });
  }
}

const EVENTS = {
  hello(data) {
    store.dispatch({ type: 'hello', payload: data, localNow: nowSec() });
    if (!data?.state?.screens) loadFullState();
  },
  state: (data) => store.dispatch({ type: 'state', state: data, localNow: nowSec() }),
  screens: (data) => store.dispatch({ type: 'screens', screens: data?.screens }),
  transition: (data) => store.dispatch({ type: 'transition', transition: data, localNow: nowSec() }),
  toast: (data) => data?.message && store.dispatch({ type: 'toast', message: data.message, level: data.level || 'info' }),
  action_result(data) {
    if (data && data.ok === false) {
      store.dispatch({ type: 'toast', message: `${data.kind || 'action'} failed: ${data.detail || 'unknown error'}`, level: 'danger' });
    }
  },
  quota_prompt: (data) => store.dispatch({ type: 'quotaPrompt', payload: data }),
  diagnostics: (data) => store.dispatch({ type: 'diagnostics', payload: data }),
};

if (token) {
  const stream = createEventStream({
    url: api.eventsUrl(),
    EventSourceImpl: window.EventSource,
    onEvent: (type, data) => EVENTS[type]?.(data),
    onStatus: (s) => store.dispatch({ type: 'conn', status: s === 'closed' ? 'reconnecting' : s }),
  });
  loadFullState();
  stream.start();
  window.addEventListener('pagehide', () => stream.stop());
}

setInterval(() => store.dispatch({ type: 'tick', localNow: nowSec() }), 1000);

// --- W-5: "waited N× · Mm total today" preview/zoom detail ---------------------
// A per-uid GET /api/history?minutes=120 (the tracker's whole 2 h ring
// buffer, §3.5), refetched on selection change and every 30 s otherwise.
let historyUid = null;
let historyAt = 0;
function maybeRefreshHistory() {
  const state = store.getState();
  const uid = selectedUidOf(state, rowsOf(state));
  if (!uid) { historyUid = null; return; }
  const now = nowSec();
  if (uid === historyUid && now - historyAt < 30) return;
  historyUid = uid;
  historyAt = now;
  api.history({ uid, minutes: 120 }).then((res) => {
    const stats = res?.stats || { count: 0, seconds: 0 };
    store.dispatch({ type: 'historyStats', uid, count: stats.count, seconds: stats.seconds });
  }).catch(() => {});
}
store.subscribe(maybeRefreshHistory);

// --- W-10: live preview lease for the selected session ------------------------
// While its preview is on screen and the page is visible, the backend re-reads
// just that session's screen about once a second (lib/live.mjs).
const liveLease = createLiveLease({ api });
function syncLiveLease() {
  const state = store.getState();
  const rows = rowsOf(state);
  const uid = selectedUidOf(state, rows);
  const session = rows.find((r) => r.s.uid === uid)?.s || null;
  liveLease.set(token ? liveTargetOf({
    route: state.route, view: effectiveViewOf(state), compact: state.compact,
    visible: document.visibilityState !== 'hidden', session,
  }) : null);
}
store.subscribe(syncLiveLease);
document.addEventListener('visibilitychange', syncLiveLease);

// --- W-6: usage burn-down chart samples -----------------------------------------
// Fetched only while the Usage view is open, refreshed every 30 s.
let usageHistoryAt = 0;
function maybeRefreshUsageHistory() {
  const state = store.getState();
  if (state.route !== 'usage') return;
  const now = nowSec();
  if (now - usageHistoryAt < 30 && state.usageHistory.length) return;
  usageHistoryAt = now;
  api.usageHistory({}).then((res) => {
    store.dispatch({ type: 'usageHistory', samples: res?.samples || [] });
  }).catch(() => {});
}
store.subscribe(maybeRefreshUsageHistory);

// --- WP7: first-run onboarding wizard --------------------------------------------
// Shown until `prefs.onboarding_done`. Checked once per page load, straight off
// the server's own prefs (not `prefsOf`'s client-side defaults), so a fixture or
// test backend that simply omits the key never gets routed here unasked —
// only an explicit `onboarding_done: false` from a real/demo backend does.
let onboardingChecked = false;
function maybeShowOnboarding() {
  const state = store.getState();
  if (onboardingChecked || !state.server || state.compact) return;
  onboardingChecked = true;
  if (state.server.prefs?.onboarding_done === false && state.route === 'main') {
    store.dispatch({ type: 'route', route: 'onboarding' });
  }
}
store.subscribe(maybeShowOnboarding);

// --- native shell bridge --------------------------------------------------------
bridge.install((msg) => {
  switch (msg.type) {
    case 'notificationClicked':
      if (msg.uid) commands.select(msg.uid);
      break;
    case 'focus':
      store.dispatch({ type: 'windowKey', key: !!msg.key });
      break;
    case 'openSettings':
      run('settings.open');
      break;
    case 'nativeStatus':
      store.dispatch({ type: 'native', patch: { automation: msg.automation, notifications: msg.notifications, hotkeys: msg.hotkeys } });
      break;
    default:
  }
});
bridge.ready();
render();
