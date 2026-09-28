// Grid view / "camera wall" (P-25, P-50): a responsive CSS grid of tiles,
// one per agent session (falling back to every session when there are no
// agents — `gridRows` in lib/rows.mjs). `A` (and a segmented control)
// toggles agents/all, persisted as `grid_all`. Arrow keys move by column
// count (wired through `ui.gridColumns()` in main.mjs, reported by this
// view via `columns()`).

import { h, icon, reconcile, setText, attr, classes } from './dom.mjs';
import { gridRows, secondaryPaneNumber } from '../lib/rows.mjs';
import { tailLines, rowAge, ageSpoken, KIND_NAMES } from '../lib/format.mjs';
import {
  badgeEl, updateBadge, badgeKind, tabColorTip, chipTip, chipText, tabTip, glyphTip,
} from './row.mjs';
import { spark, updateSpark } from './spark.mjs';
import { createPaneToggle } from './pane_toggle.mjs';

// Keep in sync with the `minmax(…)` floor in `.grid-tiles` (app.css): ~3
// columns at 1440px, 2 at ~1000px, 1 below ~700px (W-8 polish).
const MIN_TILE_W = 420;
const TAIL_LINES = 16;

function basename(path) {
  if (!path) return '';
  const parts = String(path).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || path;
}

function tile({ onEditCommit, onEditCancel } = {}) {
  const glyph = h('span', { class: 'glyph', 'aria-hidden': 'true' });
  const name = h('span', { class: 'tile-name' });
  const tab = h('span', { class: 'tile-tab' });
  const pane = h('span', { class: 'pane-marker', hidden: true });
  const dot = h('span', { class: 'tab-dot', 'aria-hidden': 'true' });
  const projName = h('span', { class: 'row-project-name' });
  const projectChip = h('button', { type: 'button', class: 'row-project tile-project' }, dot, projName);
  const badge = badgeEl();
  const age = h('span', { class: 'tile-age' });
  const tail = h('pre', { class: 'tile-tail' });
  const tileSpark = spark('tile-spark');
  const head = h('div', { class: 'tile-head' }, glyph, projectChip, tab, name, pane, h('span', { class: 'tile-spacer' }), badge, age);
  const el = h('div', { class: 'tile', role: 'option', 'aria-selected': 'false', tabindex: '-1' }, head, tileSpark, tail);
  el.__parts = {
    glyph, name, tab, pane, dot, projName, projectChip, badge, age, tail, tileSpark,
  };
  return el;
}

function updateTile(el, m) {
  const { s } = m.row;
  const p = el.__parts;
  const waiting = s.state === 'waiting';
  el.dataset.uid = s.uid;
  el.dataset.state = s.state || 'none';
  el.dataset.kind = badgeKind(s);
  attr(el, 'aria-selected', m.selected ? 'true' : 'false');
  classes(el, {
    'is-selected': m.selected, 'is-waiting': waiting, 'is-flash': m.flash, 'is-shell': !s.kind && !s.is_self && !s.is_dashboard,
  });
  p.glyph.className = `glyph glyph--${s.state || 'none'}`;
  attr(p.glyph, 'data-tip', glyphTip(s, m.now));
  setText(p.tab, s.tab_label || '');
  attr(p.tab, 'data-tip', tabTip(s.tab_label));
  const paneNumber = secondaryPaneNumber(s);
  p.pane.hidden = !paneNumber;
  if (paneNumber) {
    setText(p.pane, `Pane ${paneNumber}`);
    attr(p.pane, 'data-tip', `Secondary split pane ${paneNumber} in iTerm2 tab ${s.tab_label}`);
  }
  setText(p.name, basename(s.path) || s.display_name || s.name);
  attr(p.name, 'title', s.display_name || s.name || '');
  updateBadge(p.badge, s);
  const color = s.tab_color || 'none';
  const dc = `tab-dot tab-dot--${color}`;
  if (p.dot.className !== dc) p.dot.className = dc;
  setText(p.projName, chipText(s, m.projects));
  const tip = tabColorTip(s, m.projects);
  attr(p.projectChip, 'data-tip', chipTip(s, m.projects));
  attr(p.projectChip, 'aria-label', `${tip}. Click to change.`);
  // §4.3 project-tinted tiles (T046), same attribute as row.mjs's rows.
  attr(el, 'data-project-color', s.project ? s.tab_color || null : null);
  const ageText = rowAge(s, m.now);
  setText(p.age, ageText);
  // 60-minute activity strip (W-5): opt-in, off by default (Settings "Show
  // activity strip on sessions") — see row.mjs's updateRow for the same gate.
  p.tileSpark.hidden = !m.activity;
  if (m.activity) {
    updateSpark(p.tileSpark, s.spark);
    attr(p.tileSpark, 'data-tip', s.spark ? 'Activity over the last 60 minutes' : null);
  }
  setText(p.tail, tailLines(m.screen || '', TAIL_LINES, 160, true).join('\n') || '(no output yet)');
  attr(el, 'aria-label', `${s.display_name || s.name}, ${KIND_NAMES[s.kind] || 'plain shell'}${paneNumber ? `, secondary split pane ${paneNumber}` : ''}, ${s.state || 'idle'}${waiting && s.state_since ? `, waiting ${ageSpoken(m.now - s.state_since)}` : ''}`);
}

export function createGridView({ run }) {
  let agentsOnly = false;
  const empty = h('div', { class: 'grid-empty', hidden: true },
    icon('grid', 'empty-icon empty-icon--small'),
    h('p', { class: 'empty-title', text: 'No AI sessions' }),
    h('p', { class: 'empty-body', text: 'Only Claude Code and Codex sessions are shown.' }),
    h('button', {
      type: 'button', class: 'btn btn--small', text: 'Show All Sessions', onclick: () => run(agentsOnly ? 'agents.toggle' : 'grid.toggleAll'),
    }));
  const list = h('div', { class: 'grid-tiles', role: 'listbox', 'aria-label': 'Sessions' });
  // P-50: the grid's own Agents/All (`grid_all`, `A`). While the toolbar's
  // "AI sessions only" is on it has nothing to choose between, so it hides.
  const agentsBtn = h('button', {
    type: 'button', role: 'radio', text: 'AI sessions',
    'data-tip': 'Show Claude Code and Codex sessions (shows all sessions if none are running)',
    onclick: () => run('grid.toggleAll', {}),
  });
  const allBtn = h('button', {
    type: 'button', role: 'radio', text: 'All sessions',
    'data-tip': 'Show every iTerm2 session, including plain shells',
    onclick: () => run('grid.toggleAll', {}),
  });
  const seg = h('div', { class: 'segmented segmented--text grid-seg', role: 'radiogroup', 'aria-label': 'Grid sessions shown' }, agentsBtn, allBtn);
  const title = h('span', { class: 'pane-title', text: 'Sessions' });
  const count = h('span', { class: 'pane-count' });
  const paneToggle = createPaneToggle({ run });
  const head = h('header', { class: 'pane-head grid-head' }, title, count, h('span', { class: 'toolbar-spacer' }), seg, paneToggle.el);
  const root = h('div', { class: 'gridview' }, head, list, empty);

  list.addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    const chip = e.target.closest('.row-project');
    if (chip) {
      e.stopPropagation();
      const r = chip.getBoundingClientRect();
      run('contextmenu.open', { uid: t.dataset.uid, x: r.left, y: r.bottom + 4 });
      return;
    }
    run('select.uid', { uid: t.dataset.uid });
  });
  list.addEventListener('dblclick', (e) => {
    const t = e.target.closest('.tile');
    if (t) run('session.goto', { uid: t.dataset.uid });
  });

  let cols = 1;
  new ResizeObserver(() => {
    const w = list.clientWidth || 0;
    cols = Math.max(1, Math.floor(w / MIN_TILE_W));
  }).observe(list);

  let lastSelected = null;

  function update(m) {
    agentsOnly = !!m.prefs.agents_only;
    const rows = gridRows(m.rows, m.prefs.grid_all);
    agentsBtn.setAttribute('aria-checked', m.prefs.grid_all ? 'false' : 'true');
    allBtn.setAttribute('aria-checked', m.prefs.grid_all ? 'true' : 'false');
    seg.hidden = agentsOnly;
    const onlyAgents = rows.length > 0 && rows.every((r) => r.s.kind);
    setText(title, agentsOnly || onlyAgents ? 'AI sessions' : 'All sessions');
    setText(count, m.filter || rows.length !== m.total ? `${rows.length} of ${m.total}` : String(rows.length));
    paneToggle.update(m.prefs.show_secondary_panes);
    empty.hidden = rows.length > 0 || m.total === 0;
    list.hidden = !rows.length;
    reconcile(list, rows, (r) => r.s.uid, () => tile({ run }), (el, r) => {
      updateTile(el, {
        row: r,
        selected: r.s.uid === m.selectedUid,
        now: m.now,
        flash: !!m.flashes[r.s.uid],
        screen: m.state.screens[r.s.uid] || '',
        projects: m.projects,
        activity: !!m.prefs.show_row_activity,
      });
    });
    if (m.selectedUid && m.selectedUid !== lastSelected) {
      list.querySelector(`[data-uid="${CSS.escape(m.selectedUid)}"]`)?.scrollIntoView({ block: 'nearest' });
    }
    lastSelected = m.selectedUid;
  }

  return { el: root, update, columns: () => cols };
}
