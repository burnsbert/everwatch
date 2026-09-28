// Compact always-on-top mode (W-7, `?mode=compact`): a narrow list of agent
// sessions with state, age, and a waiting highlight; click goes straight to
// the session (no header chrome — the floating NSPanel supplies its own
// title bar). Forced on by `store.getState().compact` regardless of the
// `view` pref (see `effectiveViewOf` in store.mjs).

import { h, reconcile, setText, attr, classes } from './dom.mjs';
import { rowAge } from '../lib/format.mjs';
import { secondaryPaneNumber } from '../lib/rows.mjs';
import {
  badgeEl, updateBadge, badgeKind, projectName, tabColorTip,
} from './row.mjs';

function compactRow() {
  const glyph = h('span', { class: 'glyph', 'aria-hidden': 'true' });
  const name = h('span', { class: 'compact-name' });
  const pane = h('span', { class: 'pane-marker pane-marker--compact', hidden: true });
  // Space is tight (320px floating panel): a dot only, no project-name
  // text — the color and its meaning are still in the tooltip. The agent
  // badge is glyph-only here (§4.17 compact form), but always present.
  const dot = h('span', { class: 'tab-dot compact-dot', 'aria-hidden': 'true' });
  const badge = badgeEl();
  const age = h('span', { class: 'compact-age' });
  const el = h('div', { class: 'compact-row', role: 'option', 'aria-selected': 'false' }, glyph, dot, name, pane, badge, age);
  el.__parts = {
    name, pane, dot, badge, age, glyph,
  };
  return el;
}

function updateRow(el, { s, now, projects }) {
  const p = el.__parts;
  el.dataset.uid = s.uid;
  el.dataset.state = s.state || 'none';
  el.dataset.kind = badgeKind(s);
  classes(el, { 'is-waiting': s.state === 'waiting', 'is-shell': !s.kind && !s.is_self && !s.is_dashboard });
  p.glyph.className = `glyph glyph--${s.state || 'none'}`;
  setText(p.name, s.display_name || s.name || s.uid.slice(0, 8));
  attr(p.name, 'title', s.display_name || s.name || '');
  const paneNumber = secondaryPaneNumber(s);
  p.pane.hidden = !paneNumber;
  if (paneNumber) {
    setText(p.pane, `P${paneNumber}`);
    attr(p.pane, 'data-tip', `Secondary split pane ${paneNumber} in iTerm2 tab ${s.tab_label}`);
  }
  attr(el, 'aria-label', `${s.display_name || s.name}${paneNumber ? `, secondary split pane ${paneNumber}` : ''}`);
  const color = s.tab_color || 'none';
  const dc = `tab-dot compact-dot tab-dot--${color}`;
  if (p.dot.className !== dc) p.dot.className = dc;
  const pname = s.tab_color && s.project ? projectName(projects, s.project) : '';
  attr(p.dot, 'data-tip', pname ? `Project: ${pname}` : tabColorTip(s, projects));
  updateBadge(p.badge, s);
  setText(p.age, rowAge(s, now));
}

export function createCompactView({ run }) {
  const list = h('div', { class: 'compact-list', role: 'listbox', 'aria-label': 'Sessions' });
  const empty = h('p', { class: 'compact-empty', text: 'No sessions', hidden: true });
  const root = h('div', { class: 'compactview' }, list, empty);

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.compact-row');
    if (row) run('session.goto', { uid: row.dataset.uid });
  });

  return {
    el: root,
    update(m) {
      empty.hidden = !!m.rows.length;
      reconcile(list, m.rows, (r) => r.s.uid, compactRow, (el, r) => updateRow(el, { s: r.s, now: m.now, projects: m.projects }));
    },
  };
}
