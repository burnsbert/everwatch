// Zoom / focus mode (P-26): the selected session's preview fills the
// content area. ↑↓/j/k switch sessions; Esc, Space, or any other key exits
// (resolved in keymap.mjs). WP5 owns its e2e coverage.

import { h } from './dom.mjs';
import { createPreview } from './preview.mjs';
import { createReplyBar } from './reply.mjs';

export function createZoomView({ run, store, api }) {
  const preview = createPreview({ zoom: true, onGoto: (uid) => run('session.goto', { uid }), reply: api ? createReplyBar({ api, store }) : null });
  const root = h('div', { class: 'zoom' }, preview.el);
  return {
    el: root,
    update(m) {
      preview.update({
        session: m.selected, screen: m.screen, now: m.now, snapshotAt: m.snapshotAt, debugState: m.debugState,
        historyStats: m.selected && m.historyStats?.[m.selected.uid], searchHighlight: m.searchHighlight, projects: m.projects,
      });
    },
  };
}
