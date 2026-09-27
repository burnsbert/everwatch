// Command palette (W-3) + screen search (W-8). One `<dialog>` (index.html
// `#palette`), two modes sharing the same overlay (`store.paletteMode`):
//
//  - 'command': fuzzy "go to session…" plus every keymap command
//    (lib/palette.mjs), recently used entries first.
//  - 'search': grep every live session's screen text (lib/search.mjs),
//    context lines with the match highlighted; activating a hit selects
//    that session and highlights the match in the preview
//    (store `searchHighlight`, consumed by views/preview.mjs).
//
// Opening/closing is driven imperatively (`open(mode)` / `close()`, wired
// to `ui.paletteToggle` / `ui.paletteClose` in main.mjs — the same
// callback pattern `ui.focusFilter` uses), calling `dialog.showModal()` /
// `.close()` directly and syncing the store's `overlay`/`paletteMode` in
// the very same call, synchronously. `update(m)` only keeps the list
// *contents* fresh while open (new sessions/screens arriving over SSE)
// and is a defensive fallback for closing — it never calls
// `showModal()`/`close()` on the happy path.
//
// Two things that look "more correct" don't work and are deliberately
// avoided:
//  1. Driving open/close from the reactive store→render cycle (dispatch
//     now, let a later `update()` call `.close()`) is flaky: rapid
//     reopens (⌘K, Escape, ⌘⇧F in quick succession, as the palette
//     e2e/screenshot specs do) raced the dialog's own async bookkeeping
//     and occasionally left focus on the (now hidden) input, silently
//     swallowing the next keystroke.
//  2. Syncing `overlay` from the dialog's native 'close' *event* has the
//     same problem one level up: per the HTML spec, `close()` queues a
//     **task** to fire 'close' — it is not synchronous and not even a
//     microtask — while `dialog.open` and the CSS-visible hidden state
//     change immediately. A test (or a fast typist) that closes the
//     palette and immediately presses another shortcut can run before
//     that queued 'close' event ever fires, so `overlay` is still stale
//     'palette' when the next keydown is resolved. `closeNow()` below
//     syncs the store immediately instead of waiting for 'close'.

import { h, setText, attr, classes } from './dom.mjs';
import {
  sessionEntries, commandEntries, filterPalette, entryKey,
} from '../lib/palette.mjs';
import { searchScreens } from '../lib/search.mjs';
import { highlightRuns } from '../lib/fuzzy.mjs';
import { screenBody } from '../lib/format.mjs';
import { paletteCommands } from '../keymap.mjs';

const RECENT_MAX = 20;

const rangeIndexes = (start, end) => Array.from({ length: Math.max(0, end - start) }, (_, i) => i + start);

const runsChildren = (doc, text, positions) => highlightRuns(text, positions)
  .map((r) => (r.hit ? h('mark', { text: r.text }) : doc.createTextNode(r.text)));

export function createPalette({ run, store, doc = document }) {
  const dialog = doc.getElementById('palette');
  const input = doc.getElementById('palette-input');
  const list = doc.getElementById('palette-list');
  const emptyEl = doc.getElementById('palette-empty');
  const modeBtn = doc.getElementById('palette-mode-btn');

  let mode = 'command';
  let query = '';
  let active = 0;
  let items = [];
  let sessions = [];
  let screens = {};
  const recent = []; // entryKey(), most-recent-first (session picks + commands only)

  function remember(entry) {
    const k = entryKey(entry);
    const i = recent.indexOf(k);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(k);
    recent.length = Math.min(recent.length, RECENT_MAX);
  }

  function computeItems() {
    const q = query.trim();
    if (mode === 'search') {
      if (!q) {
        items = [];
        setText(emptyEl, 'Type to search every session’s screen text.');
      } else {
        const trimmed = {};
        for (const s of sessions) if (screens[s.uid]) trimmed[s.uid] = screenBody(screens[s.uid]);
        items = searchScreens(trimmed, sessions, q).map((hit) => ({
          type: 'hit', id: `${hit.uid}:${hit.lineIndex}:${hit.matchStart}`, uid: hit.uid, session: hit.session, hit,
        }));
        setText(emptyEl, `No matches for “${q}”.`);
      }
    } else {
      const entries = [...sessionEntries(sessions), ...commandEntries(paletteCommands())];
      items = filterPalette(entries, q, recent);
      setText(emptyEl, q ? `No matching sessions or commands for “${q}”.` : 'Nothing to show yet.');
    }
    active = items.length ? Math.min(active, items.length - 1) : 0;
    emptyEl.hidden = items.length > 0;
    list.hidden = items.length === 0;
  }

  function buildItemEl(item, index) {
    let body;
    if (item.type === 'hit') {
      const ctx = h('pre', { class: 'palette-item-context' },
        ...item.hit.before.map((l) => doc.createTextNode(`${l}\n`)),
        ...runsChildren(doc, item.hit.line, rangeIndexes(item.hit.matchStart, item.hit.matchEnd)),
        doc.createTextNode('\n'),
        ...item.hit.after.map((l) => doc.createTextNode(`${l}\n`)));
      body = [
        h('span', { class: 'palette-item-sub' }, `${item.session.tab_label} · ${item.session.display_name || item.session.name}`),
        ctx,
      ];
    } else {
      // §4.11: "the group word ('Navigate') is removed from items" — a
      // command's sublabel is its keymap group, which reads as clutter
      // next to the key caps; a session's sublabel is its path, which
      // still shows.
      const sub = item.type === 'session' && item.sublabel;
      // "Sessions show a leading glyph + chip; commands have no leading
      // icon." Reuses the same `.glyph glyph--<state>` class the row/tile
      // views use (sessions.css) and a small tab-color dot — not a full
      // `views/row.mjs` import, to stay out of that file's ownership.
      const lead = item.type === 'session'
        ? h('span', { class: 'palette-item-lead' },
          h('span', { class: `glyph glyph--${item.session.state || 'none'}`, 'aria-hidden': 'true' }),
          item.session.tab_color ? h('span', { class: `palette-item-dot tab-dot--${item.session.tab_color}`, 'aria-hidden': 'true' }) : null)
        : null;
      body = [
        lead,
        h('span', { class: 'palette-item-label' }, ...runsChildren(doc, item.label, item.positions || [])),
        sub ? h('span', { class: 'palette-item-sub', text: item.sublabel }) : null,
        item.keys?.length ? h('span', { class: 'palette-item-keys' }, ...item.keys.map((k) => h('kbd', { text: k }))) : null,
      ];
    }
    const el = h('div', {
      class: 'palette-item', role: 'option', id: `palette-opt-${index}`,
      'aria-selected': index === active ? 'true' : 'false',
    }, ...body);
    el.dataset.index = String(index);
    el.dataset.type = item.type;
    classes(el, { 'is-active': index === active });
    el.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    el.addEventListener('mouseenter', () => setActive(index));
    el.addEventListener('click', () => activate(item));
    return el;
  }

  function renderList() {
    list.replaceChildren(...items.map((item, i) => buildItemEl(item, i)));
    attr(input, 'aria-activedescendant', items.length ? `palette-opt-${active}` : null);
  }

  function setActive(i) {
    if (i === active) return;
    active = i;
    for (const el of list.children) classes(el, { 'is-active': Number(el.dataset.index) === active });
    attr(input, 'aria-activedescendant', items.length ? `palette-opt-${active}` : null);
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function moveActive(delta) {
    if (!items.length) return;
    setActive((active + delta + items.length) % items.length);
  }

  /** Synchronous close + immediate store sync (see the file header — this
   * intentionally does not wait for the dialog's native 'close' event). */
  function closeNow() {
    if (!dialog.open) return;
    dialog.close();
    if (doc.activeElement === input) input.blur();
    if (store.getState().overlay === 'palette') store.dispatch({ type: 'overlay', overlay: null });
  }

  function activate(item) {
    if (!item) return;
    if (item.type === 'session') {
      remember(item);
      run('select.uid', { uid: item.uid });
    } else if (item.type === 'command') {
      remember(item);
      run(item.id, item.args || {});
    } else if (item.type === 'hit') {
      run('select.uid', { uid: item.uid });
      store.dispatch({
        type: 'searchHighlight',
        payload: {
          uid: item.uid, lineIndex: item.hit.lineIndex, matchStart: item.hit.matchStart, matchEnd: item.hit.matchEnd,
        },
      });
    }
    closeNow();
  }

  /** `ui.paletteToggle` (W-3 ⌘K / W-8 ⌘⇧F): open in `newMode`, switch to it
   * if already open in the other mode, or close if already in `newMode`. */
  function open(newMode) {
    if (dialog.open) {
      if (mode === newMode) { closeNow(); return; }
      dialog.close(); // settle any pending native close before reopening fresh (see header comment)
    }
    mode = newMode;
    query = '';
    active = 0;
    input.value = '';
    attr(input, 'placeholder', mode === 'search' ? 'Search screen text…' : 'Go to a session, or run a command…');
    // §4.11: a text hint for the *other* mode ("⌘K Commands" / "⌘⇧F
    // Screens"), not a pill-bordered label of the current one.
    modeBtn.replaceChildren(
      h('kbd', { text: mode === 'search' ? '⌘K' : '⌘⇧F' }),
      doc.createTextNode(mode === 'search' ? 'Commands' : 'Screens'));
    const st = store.getState();
    sessions = st.server?.sessions || [];
    screens = st.screens || {};
    computeItems();
    renderList();
    dialog.showModal();
    if (st.overlay !== 'palette' || st.paletteMode !== mode) store.dispatch({ type: 'overlay', overlay: 'palette', mode });
    queueMicrotask(() => input.focus());
  }

  input.addEventListener('input', () => {
    query = input.value;
    active = 0;
    computeItems();
    renderList();
  });
  // Escape closes through `closeNow()` directly (preventDefault so the
  // dialog's own native default action never also fires) rather than the
  // native 'cancel'/'close' events — see the file header for why.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); } else if (e.key === 'Enter') { e.preventDefault(); activate(items[active]); } else if (e.key === 'Escape') { e.preventDefault(); closeNow(); } else { return; }
    e.stopPropagation();
  });
  modeBtn.addEventListener('click', () => open(mode === 'search' ? 'command' : 'search'));
  dialog.addEventListener('click', (e) => { if (e.target === dialog) closeNow(); });

  return {
    open,
    close: closeNow,
    /** Keeps the list fresh while open (new sessions/screens over SSE);
     * a defensive fallback closes the dialog if something else (e.g. a
     * future feature) sets `overlay` away from 'palette' directly. */
    update(m) {
      if (m.overlay !== 'palette') {
        closeNow();
        return;
      }
      if (!dialog.open) return; // opening only ever happens via open()
      sessions = m.state?.server?.sessions || [];
      screens = m.state?.screens || {};
      computeItems();
      renderList();
    },
  };
}
