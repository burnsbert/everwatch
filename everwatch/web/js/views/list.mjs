// List view (P-24): full-width rows with "Window N" headers (natural sort,
// more than one window) and a bottom strip with the last 3 lines of the
// selected session (`❯ {path} ─ last 3 lines`), hidden on short windows.

import { h, setText } from './dom.mjs';
import { createSessionList } from './sessions.mjs';
import { createPaneToggle } from './pane_toggle.mjs';
import { tailLines } from '../lib/format.mjs';

export function createListView({ run }) {
  const sessions = createSessionList({ run, mode: 'list' });
  const title = h('span', { class: 'pane-title', text: 'Sessions' });
  const count = h('span', { class: 'pane-count' });
  const paneToggle = createPaneToggle({ run });
  const head = h('header', { class: 'pane-head' }, title, count, h('span', { class: 'toolbar-spacer' }), paneToggle.el);
  const stripTitle = h('span', { class: 'strip-title' });
  const stripLines = h('pre', { class: 'strip-lines' });
  const strip = h('section', { class: 'mini-strip', 'aria-label': 'Selected session, last 3 lines' },
    h('header', { class: 'strip-head' }, stripTitle), stripLines);
  const root = h('div', { class: 'listview' }, head, h('div', { class: 'listview-scroll' }, sessions.el), strip);

  function update(m) {
    const agentsOnly = !!m.prefs.agents_only;
    setText(title, agentsOnly ? 'AI sessions' : 'Sessions');
    setText(count, m.filter || agentsOnly || m.rows.length !== m.total ? `${m.rows.length} of ${m.total}` : String(m.total));
    paneToggle.update(m.prefs.show_secondary_panes);
    sessions.update({ ...m, grouped: true });
    const s = m.selected;
    strip.hidden = !s;
    if (!s) return;
    setText(stripTitle, `❯ ${s.path || s.display_name} ─ last 3 lines`);
    const lines = s.is_self || s.is_dashboard
      ? [s.is_self ? '▶▶▶ Everwatch' : 'ultrawatch dashboard', '', '']
      : tailLines(m.screen || '', 3);
    setText(stripLines, lines.join('\n'));
  }

  return { el: root, update, sessions };
}
