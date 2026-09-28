// Row derivation: filter (P-46), sort cycle (P-47), window grouping (P-24),
// selection by uid with stale snap (P-40), next-waiting cycling (P-41).
// Pure functions over the §3.5 `State.sessions` objects.

import { fuzzyPositions, sessionHaystack } from './fuzzy.mjs';

export const SORTS = Object.freeze(['natural', 'attention', 'agents', 'activity', 'path']);
export const SORT_LABELS = Object.freeze({
  natural: 'Natural', attention: 'Attention', agents: 'Agents', activity: 'Activity', path: 'Path',
});
export const VIEWS = Object.freeze(['split', 'list', 'grid']);

/** iTerm2 numbers sessions within each tab starting at 1. */
export function secondaryPaneNumber(s) {
  return Number.isInteger(s?.session_index) && s.session_index > 1 ? s.session_index : null;
}

const STATE_RANK = { waiting: 0, busy: 1, active: 2, idle: 3, quiet: 4 };

function cmp(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function natural(a, b) {
  return cmp(a.window_id, b.window_id) || cmp(a.tab_index, b.tab_index)
    || cmp(a.session_index, b.session_index);
}

function rank(s) {
  return s.state in STATE_RANK ? STATE_RANK[s.state] : 5;
}

const COMPARATORS = {
  natural,
  attention: (a, b) => cmp(rank(a), rank(b))
    || cmp(a.state === 'waiting' ? a.state_since || 0 : 0, b.state === 'waiting' ? b.state_since || 0 : 0)
    || natural(a, b),
  agents: (a, b) => cmp(a.kind ? 0 : 1, b.kind ? 0 : 1) || natural(a, b),
  activity: (a, b) => cmp(-(a.last_change || 0), -(b.last_change || 0)) || natural(a, b),
  path: (a, b) => cmp(a.path || '~', b.path || '~') || natural(a, b),
};

/** Next sort in the `s` cycle; unknown sorts restart at natural. */
export function nextSort(sort) {
  const i = SORTS.indexOf(sort);
  return SORTS[(i + 1) % SORTS.length];
}

/** Next view in the `v` cycle: split → list → grid → split. */
export function nextView(view) {
  const i = VIEWS.indexOf(view);
  return VIEWS[(i + 1) % VIEWS.length];
}

/** Stable sort of a copy by one of `SORTS` (unknown → natural). */
export function sortSessions(sessions, sort) {
  const c = COMPARATORS[sort] || natural;
  return sessions.slice().sort(c);
}

/**
 * Filtered + sorted rows. Each row is `{s, positions}` where `positions` are
 * the matched haystack indexes (empty when there's no filter).
 */
export function visibleRows(sessions, { sort = 'natural', filter = '' } = {}) {
  const rows = [];
  for (const s of sessions || []) {
    const positions = fuzzyPositions(filter, sessionHaystack(s));
    if (positions === null) continue;
    rows.push({ s, positions });
  }
  const c = COMPARATORS[sort] || natural;
  rows.sort((a, b) => c(a.s, b.s));
  return rows;
}

/**
 * List-view items with "Window N" headers — only in natural sort and only
 * when the rows span more than one window (P-24).
 */
export function groupItems(rows, sort) {
  const windows = new Set(rows.map((r) => r.s.window_id));
  const grouped = sort === 'natural' && windows.size > 1;
  const items = [];
  let last = null;
  for (const r of rows) {
    if (grouped && r.s.window_id !== last) {
      items.push({ type: 'header', window_id: r.s.window_id, window_no: r.s.window_no });
      last = r.s.window_id;
    }
    items.push({ type: 'row', row: r });
  }
  return items;
}

/** Index of the selected uid, snapping a stale/absent selection to 0. */
export function selectedIndex(rows, uid) {
  const i = rows.findIndex((r) => r.s.uid === uid);
  if (i >= 0) return i;
  return rows.length ? 0 : -1;
}

/** The uid `delta` rows away from the current selection, clamped. */
export function moveSelection(rows, uid, delta) {
  if (!rows.length) return null;
  const present = rows.some((r) => r.s.uid === uid);
  if (!present) return rows[0].s.uid;
  const i = selectedIndex(rows, uid);
  const j = Math.max(0, Math.min(rows.length - 1, i + delta));
  return rows[j].s.uid;
}

/**
 * `a` (P-41): the longest-waiting session, or the next one after the
 * currently selected waiting session. null when nothing is waiting.
 */
export function nextWaiting(waitingOrder, selectedUid) {
  const w = waitingOrder || [];
  if (!w.length) return null;
  const i = w.indexOf(selectedUid);
  return i >= 0 ? w[(i + 1) % w.length] : w[0];
}

/** Grid rows: agents only unless `all`, falling back to all (P-25). */
export function gridRows(rows, all) {
  if (all) return rows;
  const agents = rows.filter((r) => r.s.kind);
  return agents.length ? agents : rows;
}

/** Clamp a split ratio to 0.2–0.8, rounded to 2 places (P-22). */
export function clampRatio(r) {
  const x = Number.isFinite(r) ? r : 0.42;
  return Math.max(0.2, Math.min(0.8, Math.round(x * 100) / 100));
}

/**
 * List pane pixel width for a content width, honouring the 280 px list and
 * 320 px preview minimums. When both can't fit, the list minimum wins.
 */
export function splitWidths(total, ratio, { minList = 280, minPreview = 320, splitter = 0 } = {}) {
  const usable = Math.max(0, total - splitter);
  let list = Math.round(usable * clampRatio(ratio));
  list = Math.min(list, usable - minPreview);
  list = Math.max(list, Math.min(minList, usable));
  return { list, preview: Math.max(0, usable - list) };
}
