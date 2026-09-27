// Projects panel (P-41, P-61–P-65): 5 numbered, colored slots, pinned to
// the far left of the main view, now a vertical accordion (user feedback,
// v0.2.2) rather than a toggle button in the toolbar. `p` (or the ⌘K
// palette command) toggles between the two states (persisted
// `projects_open`; true = expanded):
//   - Expanded: the original panel (header with "Projects" + "Clear" +
//     a collapse handle, then the 5 slot rows).
//   - Collapsed: a slim rail pinned to the left edge — a rotated
//     "Projects" label and the 5 project dots, the whole rail a single
//     button that expands the panel. `.content`'s margin-left always
//     equals whichever width is showing (sessions.css), so the rail
//     never disappears the way the old hidden panel did.
// ↑ from the session list's top row focuses slot 1 (commands.mjs bumps
// `projectsFocusNonce` and always expands first). Click, Enter, or the
// pencil icon renames a slot inline; the per-slot × clears just that name
// (`project.clear`, undoable via the toast's action button); `c` (or the
// header's "Clear") opens the clear-all confirmation; `1`–`5`/`0` (global
// keys, work whether the panel is expanded or collapsed) assign/clear the
// *selected session's* tab color — this view only renders slot/rail state
// and handles renaming, collapsing, and drag-to-assign.

import { h, reconcile, setText, attr, classes, icon } from './dom.mjs';
import { colorName } from './row.mjs';
import { shortcutFor } from '../keymap.mjs';

function slotRow({ onCommit, onClear, onDrop }) {
  const dot = h('span', { class: 'proj-dot', 'aria-hidden': 'true' });
  const num = h('span', { class: 'proj-num', 'aria-hidden': 'true' });
  const name = h('span', { class: 'proj-name' });
  const input = h('input', {
    class: 'proj-input', type: 'text', maxlength: '60', 'aria-label': 'Project name', placeholder: 'Name this project…', spellcheck: 'false', autocomplete: 'off',
  });
  const editIcon = h('span', { class: 'proj-edit-icon', 'aria-hidden': 'true' }, icon('edit', 'icon icon--tiny'));
  const clearBtn = h('button', { type: 'button', class: 'proj-clear' }, icon('close', 'icon icon--tiny'));
  const el = h('div', { class: 'proj-slot', tabindex: '0', role: 'button' }, dot, num, name, editIcon, clearBtn);
  el.__parts = {
    dot, num, name, input, clearBtn,
  };

  function commit(save) {
    if (!el.__editing) return;
    el.__editing = false;
    input.replaceWith(name);
    if (save) onCommit(Number(el.dataset.slot), input.value);
  }
  function edit() {
    if (el.__editing) return;
    el.__editing = true;
    input.value = el.classList.contains('is-named') ? el.__parts.name.textContent : '';
    name.replaceWith(input);
    queueMicrotask(() => { input.focus(); input.select(); });
  }
  el.__edit = edit;
  el.addEventListener('click', (e) => {
    if (!e.target.closest('.proj-input') && !e.target.closest('.proj-clear')) edit();
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !el.__editing) { e.preventDefault(); edit(); }
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commit(true); }
    else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
  });
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  clearBtn.addEventListener('click', (e) => { e.stopPropagation(); onClear(Number(el.dataset.slot)); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-dragover'); });
  el.addEventListener('dragleave', () => el.classList.remove('is-dragover'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('is-dragover');
    const uid = e.dataTransfer.getData('text/x-everwatch-uid');
    if (uid) onDrop(Number(el.dataset.slot), uid);
  });
  return el;
}

function updateSlot(el, slot) {
  const p = el.__parts;
  el.dataset.slot = String(slot.n);
  p.dot.className = `proj-dot tab-dot--${slot.color}`;
  setText(p.num, String(slot.n));
  // Unnamed: the color name ("Red") — the slot *is* a color (§3.5).
  setText(p.name, slot.name || colorName(slot.color));
  classes(el, { 'is-named': !!slot.name });
  attr(p.clearBtn, 'hidden', slot.name ? null : '');
  attr(p.clearBtn, 'aria-label', `Clear project ${slot.n} name`);
  attr(p.clearBtn, 'data-tip', 'Clear name');
  attr(el, 'aria-label', `Project ${slot.n}${slot.name ? `, ${slot.name}` : `, unnamed (${colorName(slot.color)})`}. Click or Enter to rename.`);
}

// Collapsed-rail dot: same drop-to-assign as a full slot row (P-61 keeps
// drag-onto-project working even folded), plus a tooltip naming the
// project so a mouse user can tell the dots apart without expanding.
function railDot({ onDrop }) {
  const el = h('span', { class: 'proj-rail-dot', 'aria-hidden': 'true' });
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.add('is-dragover'); });
  el.addEventListener('dragleave', (e) => { e.stopPropagation(); el.classList.remove('is-dragover'); });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('is-dragover');
    const uid = e.dataTransfer.getData('text/x-everwatch-uid');
    if (uid) onDrop(Number(el.dataset.slot), uid);
  });
  return el;
}

function updateRailDot(el, slot) {
  el.dataset.slot = String(slot.n);
  const dragover = el.classList.contains('is-dragover');
  el.className = `proj-rail-dot tab-dot--${slot.color}${dragover ? ' is-dragover' : ''}`;
  setText(el, String(slot.n));
  attr(el, 'data-tip', `Project ${slot.n}: ${slot.name || colorName(slot.color)}`);
}

export function createProjectsPanel({ run, store }) {
  const list = h('div', { class: 'proj-list', id: 'proj-list' });
  // §4.7: a visible "Clear" text button in the header replaces the old
  // full-width bottom "Clear all…" (same confirm dialog).
  const clearBtn = h('button', {
    type: 'button', class: 'proj-clear-all', text: 'Clear', 'aria-label': 'Clear all projects…', 'data-tip': 'Clear all project names…  c', onclick: () => run('projects.clear'),
  });
  // Both `Enter` and `Space` are already bound to global main-context
  // commands (`session.goto`, `zoom.open` — keymap.mjs), and main.mjs's
  // document-level keydown listener only backs off when the event already
  // arrived `defaultPrevented`. So — same as proj-slot's own rename-on-
  // Enter above — a focused control that wants its *own* meaning for
  // these keys has to call `preventDefault()` itself, at the target,
  // before the event bubbles up to `document`. Native buttons fire their
  // click on `Enter`'s keydown but `Space`'s keyup, so this matches that
  // split rather than double-firing.
  function toggleOnKey(el) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); run('projects.toggle'); }
      else if (e.key === ' ') e.preventDefault();
    });
    el.addEventListener('keyup', (e) => {
      if (e.key === ' ') { e.preventDefault(); run('projects.toggle'); }
    });
  }

  const collapseBtn = h('button', {
    type: 'button', class: 'icon-btn proj-collapse', 'aria-controls': 'proj-list',
    onclick: () => run('projects.toggle'),
  }, icon('chevron-left', 'icon icon--sm'));
  toggleOnKey(collapseBtn);
  const actions = h('div', { class: 'proj-head-actions' }, clearBtn, collapseBtn);
  const head = h('header', { class: 'proj-head' }, h('h3', { text: 'Projects' }), actions);
  const body = h('div', { class: 'proj-body' }, head, list);

  // Collapsed rail: a rotated "Projects" label plus the 5 dots, the whole
  // thing one focusable button that expands the panel back out.
  const railLabel = h('span', { class: 'proj-rail-label', 'aria-hidden': 'true', text: 'Projects' });
  const railDots = h('span', { class: 'proj-rail-dots', 'aria-hidden': 'true' });
  let dragExpandArmed = false;
  const rail = h('button', {
    type: 'button', class: 'proj-rail', 'aria-controls': 'proj-list',
    onclick: () => run('projects.toggle'),
  }, railLabel, railDots);
  toggleOnKey(rail);
  // Dragging over the rail itself (not one of its dots — those assign
  // directly) expands the panel so the user can drop on the right slot;
  // guarded so it fires once per drag, not on every dragover tick.
  rail.addEventListener('dragover', (e) => {
    if (e.target.closest('.proj-rail-dot')) return;
    e.preventDefault();
    if (!dragExpandArmed) { dragExpandArmed = true; run('projects.toggle'); }
  });
  rail.addEventListener('dragleave', (e) => { if (e.target === rail) dragExpandArmed = false; });

  const root = h('aside', { class: 'proj-panel', 'aria-label': 'Projects', hidden: true }, body, rail);

  let lastNonce = null;

  return {
    el: root,
    update(m) {
      const visible = !m.compact && m.state.route === 'main';
      root.hidden = !visible;
      const expanded = !!m.prefs.projects_open;
      classes(root, { 'is-collapsed': !expanded });
      dragExpandArmed = expanded ? false : dragExpandArmed;
      attr(collapseBtn, 'aria-expanded', 'true');
      attr(collapseBtn, 'aria-label', 'Collapse projects');
      attr(collapseBtn, 'data-tip', `Collapse projects  ${shortcutFor('projects.toggle')}`);
      attr(rail, 'aria-expanded', 'false');
      attr(rail, 'aria-label', 'Expand projects');
      attr(rail, 'data-tip', `Expand projects  ${shortcutFor('projects.toggle')}`);

      const slots = m.projects?.slots || [];
      reconcile(list, slots, (s) => s.n,
        () => slotRow({
          onCommit: (n, name) => run('project.rename', { n, name }),
          onClear: (n) => run('project.clear', { n }),
          onDrop: (n, uid) => run('color.assign', { slot: n, uid }),
        }),
        updateSlot);
      reconcile(railDots, slots, (s) => s.n,
        () => railDot({ onDrop: (n, uid) => run('color.assign', { slot: n, uid }) }),
        updateRailDot);
      if (visible && expanded && m.projectsFocusNonce !== lastNonce && lastNonce !== null) {
        list.firstElementChild?.focus();
      }
      lastNonce = m.projectsFocusNonce;
    },
  };
}
