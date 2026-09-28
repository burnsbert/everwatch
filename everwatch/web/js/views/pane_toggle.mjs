// Session-panel control shared by split, list, and grid views.
import { h, icon, attr } from './dom.mjs';
import { shortcutFor } from '../keymap.mjs';

export function createPaneToggle({ run }) {
  const el = h('button', {
    type: 'button', class: 'pane-toggle', 'aria-pressed': 'true',
    'aria-label': 'Hide secondary split panes',
    onclick: () => run('panes.toggle'),
  }, icon('split'), h('span', { text: 'Panes' }));

  return {
    el,
    update(show) {
      attr(el, 'aria-pressed', show ? 'true' : 'false');
      attr(el, 'aria-label', show ? 'Hide secondary split panes' : 'Show secondary split panes');
      attr(el, 'data-tip', `${show ? 'Showing' : 'Hiding'} secondary split panes — click to ${show ? 'hide' : 'show'} them  ${shortcutFor('panes.toggle')}`);
    },
  };
}
