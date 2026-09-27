// Split view (P-22, P-27): resizable session list + live preview. The
// splitter drags (pointer), steps with ←/→ when focused, and persists
// split_ratio through the prefs PATCH. Pixel minimums: list 280, preview 320.

import { h, setText, attr } from './dom.mjs';
import { createSessionList } from './sessions.mjs';
import { createPreview } from './preview.mjs';
import { createReplyBar } from './reply.mjs';
import { splitWidths, clampRatio } from '../lib/rows.mjs';
import { percent } from '../lib/format.mjs';

const SPLITTER = 9;

export function createSplitView({ run, store, api }) {
  const sessions = createSessionList({ run, mode: 'split' });
  const title = h('span', { class: 'pane-title', text: 'Sessions' });
  const count = h('span', { class: 'pane-count' });
  const listPane = h('section', { class: 'list-pane', 'aria-label': 'Session list' },
    h('header', { class: 'pane-head' }, title, count), sessions.el);
  const splitter = h('div', {
    class: 'splitter', role: 'separator', tabindex: '0', 'aria-orientation': 'vertical',
    'aria-label': 'Resize list pane', 'aria-valuemin': '20', 'aria-valuemax': '80', 'data-tip': 'Drag to resize  < >',
  });
  const preview = createPreview({ onGoto: (uid) => run('session.goto', { uid }), reply: api ? createReplyBar({ api, store }) : null });
  const root = h('div', { class: 'split' }, listPane, splitter, preview.el);

  let ratio = 0.42;
  let dragging = null;

  function layout(r = ratio) {
    const total = root.clientWidth;
    if (!total) return;
    const { list } = splitWidths(total, r, { splitter: SPLITTER });
    root.style.setProperty('--list-w', `${list}px`);
    attr(splitter, 'aria-valuenow', Math.round(clampRatio(r) * 100));
    attr(splitter, 'aria-valuetext', `list pane ${percent(clampRatio(r))} of width`);
  }

  new ResizeObserver(() => layout(dragging ? dragging.ratio : ratio)).observe(root);

  splitter.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    dragging = { rect, ratio };
    root.classList.add('is-resizing');
  });
  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const { rect } = dragging;
    dragging.ratio = clampRatio((e.clientX - rect.left - SPLITTER / 2) / Math.max(1, rect.width - SPLITTER));
    layout(dragging.ratio);
  });
  const endDrag = () => {
    if (!dragging) return;
    const r = dragging.ratio;
    dragging = null;
    root.classList.remove('is-resizing');
    if (r !== ratio) run('split.set', { ratio: r, commit: true });
  };
  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  splitter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      run(e.key === 'ArrowLeft' ? 'split.shrink' : 'split.grow');
    }
  });
  splitter.addEventListener('dblclick', () => run('split.set', { ratio: 0.42, commit: true }));

  function update(m) {
    if (!dragging && m.splitRatio !== ratio) {
      ratio = m.splitRatio;
      layout();
    } else if (!root.style.getPropertyValue('--list-w')) {
      layout();
    }
    // "AI sessions · 6 of 9" while the toolbar's AI-only toggle is on, so
    // a shortened list never looks like missing sessions.
    const agentsOnly = !!m.prefs.agents_only;
    setText(title, agentsOnly ? 'AI sessions' : 'Sessions');
    setText(count, m.filter || agentsOnly ? `${m.rows.length} of ${m.total}` : String(m.total));
    sessions.update({ ...m, grouped: false });
    preview.update({
      session: m.selected, screen: m.screen, now: m.now, snapshotAt: m.snapshotAt, debugState: m.debugState,
      historyStats: m.selected && m.historyStats?.[m.selected.uid], searchHighlight: m.searchHighlight, projects: m.projects,
    });
  }

  return { el: root, update, preview, sessions };
}
