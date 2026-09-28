// Session row (P-35, P-37, P-38, P-39, VISUAL_SPEC §4.3): state glyph;
// line 1 the display name (label wins) + rename pencil; line 2 the project
// chip-button (dot + project name, "No project" when unset) and the
// left-ellipsized path; meta column the age, then the agent badge and the
// tab label. Classes .is-selected/.is-flash/.is-waiting/.is-fresh/
// .has-label/.is-shell drive the D1-A styling (neutral tinted selection;
// kind shown by the explicit badge, never by the row color).

import { h, setText, classes, attr, setRuns, icon } from './dom.mjs';
import { rowAge, isFresh, ageSpoken, KIND_NAMES } from '../lib/format.mjs';
import { fieldHighlights, highlightRuns } from '../lib/fuzzy.mjs';
import { spark, updateSpark } from './spark.mjs';
import { secondaryPaneNumber } from '../lib/rows.mjs';

const STATE_WORDS = { waiting: 'waiting for input', busy: 'busy', idle: 'idle', active: 'producing output', quiet: 'quiet' };

const GLYPH_WORDS = {
  waiting: 'Waiting for you', busy: 'Busy', idle: 'Idle', active: 'Producing output',
};

/** §4.19 glyph tooltip: the state in words ("Waiting for you · 4 min"). */
export function glyphTip(s, now) {
  const w = GLYPH_WORDS[s.state];
  if (!w) return null;
  const since = s.state_since && (s.state === 'waiting' || s.state === 'idle') ? ageSpoken(now - s.state_since) : '';
  return since ? `${w} · ${since}` : w;
}

export function badgeKind(s) {
  if (s.is_self) return 'self';
  if (s.is_dashboard) return 'dashboard';
  return s.kind || 'plain';
}

/** §4.17 agent badge content per kind: the word, the sprite glyph, and the
 * never-abbreviated name for the tooltip / accessible name. Mapped from
 * `kind` (the backend's `badge` field is the old "CC"/"CX" shorthand,
 * which never appears in the UI). Plain shells get a quiet outlined
 * "Shell" badge with a terminal glyph, so an AI session and a plain shell
 * are told apart at a glance in every row state. */
const BADGES = {
  claude: { word: 'Claude', glyph: 'agent-claude', tip: 'Claude Code session' },
  codex: { word: 'Codex', glyph: 'agent-codex', tip: 'Codex session' },
  plain: { word: 'Shell', glyph: 'terminal', tip: 'Plain shell — not an AI session' },
  self: { word: 'Everwatch', glyph: 'logo', tip: 'This Everwatch' },
  dashboard: { word: 'ultrawatch', glyph: 'terminal', tip: 'ultrawatch dashboard' },
};

export function badgeInfo(s) {
  return BADGES[badgeKind(s)] || BADGES.plain;
}

/** The badge word ("Claude" / "Codex" / "Shell"). */
export function badgeFull(s) {
  return badgeInfo(s).word;
}

/** A `.badge` element: glyph + word. The compact form (compact panel,
 * list view below 900px) hides the word in CSS, leaving the glyph on the
 * same tinted surface; the tooltip and `aria-label` always carry the full
 * name. Shared by row.mjs, grid.mjs, compact.mjs and preview.mjs so the
 * four views can't drift apart. */
export function badgeEl() {
  return h('span', { class: 'badge', role: 'img' },
    icon('agent-claude', 'icon badge-glyph'),
    h('span', { class: 'badge-text' }));
}

/** Refresh a `badgeEl()` element in place. */
export function updateBadge(el, s) {
  const bk = badgeKind(s);
  const info = badgeInfo(s);
  const bc = `badge badge--${bk}`;
  if (el.className !== bc) el.className = bc;
  const use = el.firstElementChild.firstElementChild;
  const href = `#i-${info.glyph}`;
  if (use.getAttribute('href') !== href) use.setAttribute('href', href);
  setText(el.children[1], info.word);
  attr(el, 'aria-label', info.tip);
  attr(el, 'data-tip', info.tip);
}

export function projectName(projects, n) {
  const slot = projects?.slots?.find((x) => x.n === n);
  return slot?.name || '';
}

export function tabColorTip(s, projects) {
  if (!s.tab_color) return 'No project';
  const pname = s.project ? projectName(projects, s.project) : '';
  const proj = s.project ? ` — project ${s.project}${pname ? ` “${pname}”` : ''}` : '';
  return `Tab color: ${s.tab_color}${proj}`;
}

/** "Blue" from "blue". */
export function colorName(c) {
  return c ? `${c[0].toUpperCase()}${c.slice(1)}` : '';
}

/** §4.19 chip tooltip: the project name + "iTerm2 tab color: blue". */
export function chipTip(s, projects) {
  if (!s.tab_color) return 'No project — click to set one';
  const pname = s.project ? projectName(projects, s.project) : '';
  return `${pname || colorName(s.tab_color)} · iTerm2 tab color: ${s.tab_color}${s.project ? ` (project ${s.project})` : ''} — click to change`;
}

/** Chip text: project name, else the color name, else "No project". */
export function chipText(s, projects) {
  const pname = s.tab_color && s.project ? projectName(projects, s.project) : '';
  if (s.tab_color && s.project) return `${s.project} · ${pname || colorName(s.tab_color)}`;
  return s.tab_color ? colorName(s.tab_color) : 'No project';
}

/** "iTerm2 window 1, tab 2" from a "1.2" tab label. */
export function tabTip(label) {
  const [w, t] = String(label || '').split('.');
  return t ? `iTerm2 window ${w}, tab ${t}` : `iTerm2 tab ${label || ''}`.trim();
}

export function createRow({ onEditCommit, onEditCancel } = {}) {
  const glyph = h('span', { class: 'glyph', 'aria-hidden': 'true' });
  const name = h('span', { class: 'row-name' });
  const pane = h('span', { class: 'pane-marker', hidden: true });
  const editIcon = h('button', {
    type: 'button', class: 'row-edit-icon', 'data-tip': 'Rename  l', 'aria-label': 'Rename session',
  }, icon('edit', 'icon icon--tiny'));
  const editor = h('input', {
    class: 'row-editor', type: 'text', 'aria-label': 'Session label', spellcheck: 'false', autocomplete: 'off',
    placeholder: 'Label (empty removes it)', maxlength: '80',
  });
  const path = h('span', { class: 'row-path' });
  const age = h('span', { class: 'row-age' });
  const dot = h('span', { class: 'tab-dot', 'aria-hidden': 'true' });
  const projName = h('span', { class: 'row-project-name' });
  const projectChip = h('button', { type: 'button', class: 'row-project' }, dot, projName);
  const badge = badgeEl();
  const tab = h('span', { class: 'row-tab' });
  const rowSpark = spark('row-spark');
  const el = h('div', { class: 'row', role: 'option', 'aria-selected': 'false', draggable: 'true' },
    glyph,
    h('div', { class: 'row-main' }, h('div', { class: 'row-line1' }, name, pane, editIcon), h('div', { class: 'row-line2' }, projectChip, path)),
    h('div', { class: 'row-meta' }, age, h('span', { class: 'row-tags' }, rowSpark, badge, tab)));
  el.__parts = {
    glyph, name, pane, editIcon, editor, path, age, dot, projName, projectChip, badge, tab, rowSpark,
  };
  // Drag onto a projects-panel slot to color-assign (P-62 "if cheap").
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/x-everwatch-uid', el.dataset.uid || '');
    e.dataTransfer.effectAllowed = 'copy';
  });

  let committed = false;
  editor.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      committed = true;
      onEditCommit?.(el.dataset.uid, editor.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committed = true;
      onEditCancel?.(el.dataset.uid);
    }
  });
  editor.addEventListener('blur', () => {
    if (!committed && el.__editing) onEditCommit?.(el.dataset.uid, editor.value);
  });
  editor.addEventListener('click', (e) => e.stopPropagation());
  editor.addEventListener('dblclick', (e) => e.stopPropagation());
  el.__resetEditor = () => { committed = false; };
  return el;
}

/**
 * m: {row:{s, positions}, selected, now, started, freshSeconds, flash,
 *     editing, projects, ageWidth}
 */
export function updateRow(el, m) {
  const { s, positions } = m.row;
  const p = el.__parts;
  const waiting = s.state === 'waiting';
  const fresh = !waiting && isFresh(s, m.now, m.started, m.freshSeconds);
  const ageText = rowAge(s, m.now);

  el.dataset.uid = s.uid;
  attr(el, 'id', `${m.idPrefix || 'row'}-${s.uid}`);
  attr(el, 'aria-selected', m.selected ? 'true' : 'false');
  el.dataset.state = s.state || 'none';
  el.dataset.kind = badgeKind(s);
  classes(el, {
    'is-shell': !s.kind && !s.is_self && !s.is_dashboard,
    'is-selected': m.selected,
    'is-flash': m.flash,
    'is-waiting': waiting,
    'is-fresh': fresh,
    'has-label': !!s.label,
    'is-attention': !!s.attention,
    'is-editing': m.editing,
  });

  // glyph
  const g = `glyph glyph--${s.state || 'none'}`;
  if (p.glyph.className !== g) p.glyph.className = g;
  attr(p.glyph, 'data-tip', glyphTip(s, m.now));

  // name (label wins) with filter highlights
  const hl = fieldHighlights(s, positions);
  const nameText = s.display_name || s.name || s.uid.slice(0, 8);
  const nameHits = s.label && nameText === s.label ? hl.label : nameText === s.name ? hl.name : [];
  setRuns(p.name, highlightRuns(nameText, nameHits), `${nameText}|${nameHits.join(',')}`);
  attr(p.name, 'title', s.label && s.name && s.name !== s.label ? `${s.label} — ${s.name}` : nameText);
  const paneNumber = secondaryPaneNumber(s);
  p.pane.hidden = !paneNumber;
  if (paneNumber) {
    setText(p.pane, `Pane ${paneNumber}`);
    attr(p.pane, 'data-tip', `Secondary split pane ${paneNumber} in iTerm2 tab ${s.tab_label}`);
  }

  // path, left-ellipsized via direction:rtl; LRM keeps `~` and `/` in place
  const pathText = s.path || '';
  setRuns(p.path, [{ text: '‎', hit: false }, ...highlightRuns(pathText, hl.path), { text: '‎', hit: false }],
    `${pathText}|${hl.path.join(',')}`);
  attr(p.path, 'title', pathText || null);

  // age column: wait/idle text, or "just finished" for fresh idle rows
  // (a fresh *active* row is still producing output, so it only turns green)
  const note = !ageText && fresh && s.state !== 'active' ? 'just finished' : '';
  setText(p.age, ageText || note);
  p.age.classList.toggle('is-fresh-note', !!note);

  // agent badge (§4.17): glyph + word + hue; the glyph-only compact form
  // is a CSS toggle, not a DOM change
  updateBadge(p.badge, s);

  // project / tab-color chip (P-61 rework): always visible, solid dot +
  // name — "No project" rather than a dot that disappears when unset, so
  // it never reads as empty by omission. A button (not just a hover
  // reveal) so it's an obvious, keyboard-reachable way to change it
  // (sessions.mjs opens the same context menu the right-click path uses).
  const color = s.tab_color || 'none';
  const dc = `tab-dot tab-dot--${color}`;
  if (p.dot.className !== dc) p.dot.className = dc;
  setText(p.projName, chipText(s, m.projects));
  const tip = tabColorTip(s, m.projects);
  attr(p.projectChip, 'data-tip', chipTip(s, m.projects));
  attr(p.projectChip, 'aria-label', `${tip}. Click to change.`);
  classes(el, { 'has-project': !!s.tab_color });
  // §4.3 project-tinted rows (T046): dark theme tints the title text in the
  // project's color; light theme tints the row background instead (see
  // sessions.css) — both keyed off the same attribute, only set when a
  // *project* (not just a manually-set tab color) is assigned.
  attr(el, 'data-project-color', s.project ? s.tab_color || null : null);

  setText(p.tab, s.tab_label || '');
  attr(p.tab, 'data-tip', tabTip(s.tab_label));

  // 60-minute activity sparkline (W-5) — opt-in (Settings "Show activity
  // strip on sessions", default off, `show_row_activity`); off by default
  // to cut per-row noise (P-39 vs the reworked P-61/agent-kind chips).
  p.rowSpark.hidden = !m.activity;
  if (m.activity) {
    updateSpark(p.rowSpark, s.spark);
    attr(p.rowSpark, 'data-tip', s.spark ? 'Activity over the last 60 minutes' : null);
  }

  // inline label editor (P-48)
  if (m.editing && !el.__editing) {
    el.__editing = true;
    el.__resetEditor();
    p.editor.value = s.label || '';
    p.name.replaceWith(p.editor);
    queueMicrotask(() => { p.editor.focus(); p.editor.select(); });
  } else if (!m.editing && el.__editing) {
    el.__editing = false;
    p.editor.replaceWith(p.name);
  }

  // screen-reader label
  const words = [nameText, KIND_NAMES[s.kind] || 'plain shell', STATE_WORDS[s.state] || ''];
  if (paneNumber) words.push(`secondary split pane ${paneNumber}`);
  if (waiting && s.state_since) words.push(`for ${ageSpoken(m.now - s.state_since)}`);
  if (note) words.push(note);
  if (s.path) words.push(s.path);
  words.push(`tab ${s.tab_label}`);
  if (s.tab_color) words.push(`${s.tab_color} tab`);
  attr(el, 'aria-label', words.filter(Boolean).join(', '));
}
