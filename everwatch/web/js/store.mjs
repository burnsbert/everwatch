// Reducer-style client state. `reduce(state, action)` is pure: every action
// that depends on time carries `localNow` (seconds), and the reducer turns it
// into server time with the clock-skew estimate from the last state (P-37).
// Side effects (API calls, timers) live in commands.mjs and main.mjs.

import { DEFAULTS } from './lib/format.mjs';
import { visibleRows, clampRatio, SORTS, VIEWS, secondaryPaneNumber } from './lib/rows.mjs';

export const DEFAULT_PREFS = Object.freeze({
  view: 'split', sort: 'attention', split_ratio: 0.42, show_dollars: false,
  sound_on_attention: false, dock_bounce: false, show_dock_badge: false, notify_on_waiting: false,
  theme: 'system', session_font: 'system', session_font_size: 15, grid_all: false,
  hotkey_show: 'opt+cmd+e', hotkey_next: 'opt+cmd+j', show_hints: true,
  show_row_activity: false, // Settings "Show activity strip on sessions" — off by default (row/tile noise reduction)
  agents_only: false, // toolbar "AI sessions only" toggle: list only Claude Code / Codex sessions
  show_secondary_panes: true, // show all iTerm2 split panes unless hidden from the Sessions header
});

// §4.13: "At most 3 are stacked; the oldest leaves first."
export const MAX_TOASTS = 3;

export function initialState(overrides = {}) {
  return {
    server: null,          // last State (without screens)
    screens: {},           // uid → full visible text
    conn: 'connecting',    // connecting | open | reconnecting
    skew: 0,               // server clock − local clock, seconds
    now: 0,                // skew-corrected "server now", updated by tick
    version: '',
    config: { ...DEFAULTS },
    selection: { uid: null, none: false },
    filter: { text: '', editing: false },
    overlay: null,         // null | 'help' | 'zoom' | 'palette'
    paletteMode: 'command', // 'command' | 'search' — which palette.mjs mode (W-3, W-8)
    route: 'main',         // main | usage | settings | projects | …
    pendingPrefs: {},
    pendingPrefsAt: {},    // key → localNow when the edit was made
    pendingLabels: {},     // uid → {label, until}
    editingLabel: null,    // uid being renamed inline
    toasts: [],            // [{id, message, level}]
    toastSeq: 0,
    flashes: {},           // uid → until (server seconds)
    narrow: false,         // viewport below the split breakpoint (P-23)
    native: { shell: false },
    windowKey: true,
    diagnostics: null,
    quotaPrompt: null,
    dialog: null,          // {kind, ...} | null — close-tab / clear-projects confirm (P-63, P-64)
    contextMenu: null,     // {uid, x, y} | null — row right-click menu (P-48)
    projectsFocusNonce: 0, // bumped on ↑-from-top-row so the panel can steal focus (P-41)
    compact: false,        // ?mode=compact (W-7): forces the compact view regardless of prefs.view
    historyStats: {},      // uid → {count, seconds} from GET /api/history (W-5 preview/zoom detail)
    usageHistory: [],      // [{at,id,pct}] from GET /api/usage/history (W-6 burn-down charts)
    searchHighlight: null, // {uid, lineIndex, matchStart, matchEnd} | null — a W-8 screen-search jump
    ...overrides,
  };
}

/** hello.config → our timing names; accepts snake_case or UPPER_CASE keys. */
export function normalizeConfig(cfg) {
  const out = { ...DEFAULTS };
  if (!cfg || typeof cfg !== 'object') return out;
  const pick = (...names) => {
    for (const n of names) {
      const v = cfg[n] ?? cfg.intervals?.[n];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
    return undefined;
  };
  const map = {
    snapshotInterval: ['snapshot_interval', 'SNAPSHOT_INTERVAL', 'snapshot'],
    freshSeconds: ['fresh_seconds', 'FRESH_SECONDS', 'fresh'],
    flashSeconds: ['flash_seconds', 'FLASH_SECONDS', 'flash'],
    toastSeconds: ['toast_seconds', 'TOAST_SECONDS', 'toast'],
  };
  for (const [k, names] of Object.entries(map)) {
    const v = pick(...names);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function withoutScreens(st) {
  if (!st || typeof st !== 'object') return null;
  const { screens, ...rest } = st;
  return rest;
}

function pruneScreens(screens, sessions) {
  const live = new Set((sessions || []).map((s) => s.uid));
  const out = {};
  for (const [uid, text] of Object.entries(screens)) if (live.has(uid)) out[uid] = text;
  return out;
}

/**
 * Optimistic prefs stay until a server *state* echoes them (a PATCH response
 * alone isn't enough: an older state event can still be in flight on the
 * SSE connection and would otherwise revert the value). Entries older than
 * PENDING_PREF_SECONDS are dropped so a lost echo can't pin a value forever.
 */
export const PENDING_PREF_SECONDS = 10;

function convergePrefs(pending, pendingAt, serverPrefs, now) {
  const out = {};
  const at = {};
  for (const [k, v] of Object.entries(pending)) {
    if (serverPrefs && serverPrefs[k] === v) continue;
    if (typeof now === 'number' && pendingAt[k] !== undefined && now - pendingAt[k] > PENDING_PREF_SECONDS) continue;
    out[k] = v;
    if (pendingAt[k] !== undefined) at[k] = pendingAt[k];
  }
  return { pendingPrefs: out, pendingPrefsAt: at };
}

function convergeLabels(pending, sessions, now) {
  const byUid = new Map((sessions || []).map((s) => [s.uid, s]));
  const out = {};
  for (const [uid, p] of Object.entries(pending)) {
    const s = byUid.get(uid);
    if (!s) continue;
    if ((s.label || '') === p.label) continue;
    if (p.until && now > p.until) continue;
    out[uid] = p;
  }
  return out;
}

function applyServerState(state, incoming, localNow, { replaceScreens = null } = {}) {
  const server = withoutScreens(incoming);
  if (!server) return state;
  const skew = typeof server.now === 'number' && typeof localNow === 'number'
    ? server.now - localNow : state.skew;
  const now = typeof localNow === 'number' ? localNow + skew : server.now || state.now;
  let screens = replaceScreens ? { ...replaceScreens } : state.screens;
  screens = pruneScreens(screens, server.sessions);
  const sel = state.selection;
  const live = new Set((server.sessions || []).map((s) => s.uid));
  const selection = sel.uid && !live.has(sel.uid) ? { uid: null, none: false } : sel;
  return {
    ...state,
    server,
    screens,
    skew,
    now,
    selection,
    editingLabel: state.editingLabel && live.has(state.editingLabel) ? state.editingLabel : null,
    ...convergePrefs(state.pendingPrefs, state.pendingPrefsAt, server.prefs, typeof localNow === 'number' ? localNow : undefined),
    pendingLabels: convergeLabels(state.pendingLabels, server.sessions, now),
    quotaPrompt: server.quota_prompt !== undefined ? server.quota_prompt : state.quotaPrompt,
  };
}

/** Push a toast. A toast with the same `key` replaces the older one in place
 * (so cycling sorts shows one updating toast, not a stack). */
function addToast(state, message, level = 'info', key = null, action = null) {
  const id = state.toastSeq + 1;
  const toast = { id, message: String(message), level: level || 'info', key: key || null, action: action || null };
  const at = key ? state.toasts.findIndex((t) => t.key === key) : -1;
  let toasts;
  if (at >= 0) {
    toasts = state.toasts.slice();
    toasts[at] = toast;
  } else {
    toasts = [...state.toasts, toast].slice(-MAX_TOASTS);
  }
  return { ...state, toasts, toastSeq: id };
}

export function reduce(state, action) {
  switch (action.type) {
    case 'hello': {
      const p = action.payload || {};
      let next = { ...state, config: normalizeConfig(p.config), version: p.version || state.version };
      if (p.state) {
        next = applyServerState(next, p.state, action.localNow,
          { replaceScreens: p.state.screens || null });
      }
      return next;
    }
    case 'state': {
      // Out-of-order delivery (a slow GET /api/state landing after newer SSE
      // states) must not roll the UI back: ignore older revs, but still fill
      // in screens we don't have yet. `hello` always resets (new backend).
      const inc = action.state;
      const cur = state.server?.rev;
      if (inc && typeof inc.rev === 'number' && typeof cur === 'number' && inc.rev < cur) {
        const extra = {};
        for (const [uid, text] of Object.entries(inc.screens || {})) if (!(uid in state.screens)) extra[uid] = text;
        return Object.keys(extra).length ? { ...state, screens: pruneScreens({ ...state.screens, ...extra }, state.server.sessions) } : state;
      }
      return applyServerState(state, inc, action.localNow, { replaceScreens: inc?.screens || null });
    }
    case 'screens': {
      const incoming = action.screens || {};
      return { ...state, screens: { ...state.screens, ...incoming } };
    }
    case 'transition': {
      const t = action.transition || {};
      if (t.to !== 'waiting' || !t.uid) return state;
      const now = action.localNow + state.skew;
      const flashes = { ...state.flashes, [t.uid]: now + state.config.flashSeconds };
      const name = t.title || t.uid.slice(0, 8);
      return addToast({ ...state, flashes }, `◉ ${name} is waiting for your input`, 'attention', `wait:${t.uid}`);
    }
    case 'toast':
      return addToast(state, action.message, action.level, action.key, action.action);
    case 'toastExpire':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
    case 'tick': {
      const now = action.localNow + state.skew;
      const flashes = {};
      let changed = false;
      for (const [uid, until] of Object.entries(state.flashes)) {
        if (until > now) flashes[uid] = until;
        else changed = true;
      }
      return { ...state, now, flashes: changed ? flashes : state.flashes };
    }
    case 'conn':
      return state.conn === action.status ? state : { ...state, conn: action.status };
    case 'select':
      // A search-screens jump (views/palette.mjs) sets `searchHighlight`
      // right after selecting its target uid; selecting anything else
      // (including the same uid again, from elsewhere) drops it.
      return {
        ...state,
        selection: { uid: action.uid, none: !action.uid },
        searchHighlight: state.searchHighlight?.uid === action.uid ? state.searchHighlight : null,
      };
    case 'clearSelection':
      return { ...state, selection: { uid: null, none: true }, searchHighlight: null };
    case 'searchHighlight':
      return { ...state, searchHighlight: action.payload || null };
    case 'filter':
      return { ...state, filter: { ...state.filter, text: String(action.text ?? '') } };
    case 'filterEditing':
      return state.filter.editing === !!action.editing
        ? state : { ...state, filter: { ...state.filter, editing: !!action.editing } };
    case 'overlay': {
      // `mode` is only meaningful for the palette overlay (W-3 command
      // mode vs W-8 search-screens mode); other overlays leave it as-is.
      const overlay = action.overlay || null;
      const paletteMode = action.mode || state.paletteMode;
      if (state.overlay === overlay && state.paletteMode === paletteMode) return state;
      return { ...state, overlay, paletteMode };
    }
    case 'route':
      return state.route === (action.route || 'main') && !state.overlay
        ? state : { ...state, route: action.route || 'main', overlay: null };
    case 'prefsPending': {
      const pendingPrefsAt = { ...state.pendingPrefsAt };
      for (const k of Object.keys(action.prefs || {})) pendingPrefsAt[k] = action.localNow ?? 0;
      return { ...state, pendingPrefs: { ...state.pendingPrefs, ...action.prefs }, pendingPrefsAt };
    }
    case 'prefsConfirmed': {
      // Adopt the server's normalised value (e.g. a clamped ratio) so the
      // coming state echo matches. Never write server.prefs from a PATCH
      // response: responses can arrive out of order relative to the SSE
      // stream, which is the only source of truth for server state.
      const confirmed = action.prefs || {};
      const sent = action.sent || {};
      let changed = false;
      const pending = { ...state.pendingPrefs };
      for (const k of Object.keys(sent)) {
        if (pending[k] === sent[k] && k in confirmed && confirmed[k] !== sent[k]) {
          pending[k] = confirmed[k];
          changed = true;
        }
      }
      return changed ? { ...state, pendingPrefs: pending } : state;
    }
    case 'prefsRejected': {
      const pending = { ...state.pendingPrefs };
      for (const k of Object.keys(action.sent || {})) if (pending[k] === action.sent[k]) delete pending[k];
      return { ...state, pendingPrefs: pending };
    }
    case 'labelPending': {
      const now = action.localNow + state.skew;
      return {
        ...state,
        pendingLabels: { ...state.pendingLabels, [action.uid]: { label: action.label, until: now + 10 } },
      };
    }
    case 'labelRejected': {
      const pendingLabels = { ...state.pendingLabels };
      delete pendingLabels[action.uid];
      return { ...state, pendingLabels };
    }
    case 'editLabel':
      return { ...state, editingLabel: action.uid || null };
    case 'narrow':
      return state.narrow === !!action.narrow ? state : { ...state, narrow: !!action.narrow };
    case 'native':
      return { ...state, native: { ...state.native, ...action.patch } };
    case 'windowKey':
      return { ...state, windowKey: !!action.key };
    case 'diagnostics':
      return { ...state, diagnostics: action.payload ?? null };
    case 'quotaPrompt':
      return { ...state, quotaPrompt: action.payload ?? null };
    case 'dialog':
      return state.dialog === (action.dialog || null) ? state : { ...state, dialog: action.dialog || null };
    case 'contextMenu':
      return { ...state, contextMenu: action.menu || null };
    case 'projectsFocus':
      return { ...state, projectsFocusNonce: state.projectsFocusNonce + 1 };
    case 'historyStats':
      return { ...state, historyStats: { ...state.historyStats, [action.uid]: { count: action.count || 0, seconds: action.seconds || 0 } } };
    case 'usageHistory':
      return { ...state, usageHistory: action.samples || [] };
    default:
      return state;
  }
}

// --- selectors ----------------------------------------------------------------

/** Server prefs overlaid with optimistic edits, normalised. */
export function prefsOf(state) {
  const p = { ...DEFAULT_PREFS, ...(state.server?.prefs || {}), ...state.pendingPrefs };
  if (!VIEWS.includes(p.view)) p.view = 'split';
  if (!SORTS.includes(p.sort)) p.sort = 'natural';
  p.split_ratio = clampRatio(p.split_ratio);
  // `projects_open` and `debug_state` are PATCHed like any other pref (P-41,
  // P-18), but the §3.5 State shape surfaces their confirmed value outside
  // `prefs` (`state.projects.open`, top-level `state.debug_state`) rather
  // than always echoing them back under `prefs`. Once the optimistic pending
  // value converges/expires, fall back to wherever the server actually put
  // the confirmed value, so a toggle can never get stuck reverted.
  if (p.projects_open === undefined) p.projects_open = !!state.server?.projects?.open;
  if (p.debug_state === undefined) p.debug_state = !!state.server?.debug_state;
  return p;
}

/** Sessions with optimistic labels applied (P-48). */
export function sessionsOf(state) {
  const list = state.server?.sessions || [];
  const pending = state.pendingLabels;
  if (!Object.keys(pending).length) return list;
  return list.map((s) => {
    const p = pending[s.uid];
    if (!p) return s;
    const label = p.label;
    const fallback = s.label && s.display_name === s.label ? s.name : s.display_name;
    return { ...s, label, display_name: label || fallback || s.name };
  });
}

/** Visible sessions in every view. The AI-only switch does not apply to the
 * compact panel, but the split-pane switch applies to every session list. */
export function listedSessionsOf(state) {
  const prefs = prefsOf(state);
  let list = sessionsOf(state);
  if (!prefs.show_secondary_panes) list = list.filter((s) => !secondaryPaneNumber(s));
  if (!state.compact && prefs.agents_only) list = list.filter((s) => !!s.kind);
  return list;
}

export function rowsOf(state) {
  const prefs = prefsOf(state);
  return visibleRows(listedSessionsOf(state), { sort: prefs.sort, filter: state.filter.text });
}

/** Selected uid after the stale-snap rule (P-40). */
export function selectedUidOf(state, rows) {
  const { uid, none } = state.selection;
  if (uid && rows.some((r) => r.s.uid === uid)) return uid;
  if (none) return null;
  return rows.length ? rows[0].s.uid : null;
}

/** The view actually rendered in the content area. */
export function effectiveViewOf(state) {
  if (state.compact) return 'compact';
  if (state.route !== 'main') return state.route;
  if (state.overlay === 'zoom') return 'zoom';
  const { view } = prefsOf(state);
  return view === 'split' && state.narrow ? 'list' : view;
}

/** Keymap context for the current UI state. */
export function contextOf(state) {
  if (state.dialog) return 'dialog';
  if (state.editingLabel) return 'label';
  if (state.filter.editing) return 'filter';
  if (state.overlay === 'help') return 'help';
  if (state.overlay === 'zoom') return 'zoom';
  if (state.overlay === 'palette') return 'palette';
  if (state.route === 'usage') return 'usage';
  if (state.route !== 'main') return 'page';
  return prefsOf(state).view === 'grid' ? 'grid' : 'main';
}

/** Tiny observable store around `reduce`. */
export function createStore(initial = initialState(), reducer = reduce) {
  let state = initial;
  const subs = new Set();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reducer(state, action);
      if (next === state) return state;
      const prev = state;
      state = next;
      for (const fn of subs) fn(state, prev, action);
      return state;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}
