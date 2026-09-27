// Page shell for Usage, Settings, and Diagnostics (docs/design/VISUAL_SPEC.md
// §4.16): a --bg canvas with one centred content column, and a title row
// that sits inside that column: a plain "‹ Sessions" back button above the
// page title, page actions right-aligned on the title row. The back button
// keeps "Back to sessions" as its accessible name (D5).

import { h, icon } from './dom.mjs';

/**
 * `{ el, col, head }`: `el` is the scrolling page, `col` the centred column
 * (append content to it), `head` the title row. `width` picks --page-w
 * ('settings' 640 | 'diagnostics' 720 | 'usage' 960); `extraClass` keeps a
 * view's own hook class (e.g. `usage-page`) on the root.
 */
export function createPage({
  title, width, extraClass = '', run, backCommand, backLabel = 'Sessions', actions = [], sub = null,
}) {
  const back = h('button', {
    type: 'button',
    class: 'btn btn--plain page-back',
    'aria-label': 'Back to sessions',
    'data-tip': 'Back to sessions  esc',
    onclick: () => run(backCommand),
  }, icon('chevron-left', 'icon icon--sm'), h('span', { text: backLabel }));
  const head = h('header', { class: 'page-head' },
    h('div', { class: 'page-titles' }, h('h2', { class: 'page-title', text: title }), sub),
    actions.length ? h('div', { class: 'page-actions' }, ...actions) : null);
  const col = h('div', { class: 'page-col' }, back, head);
  const el = h('div', { class: `page page--${width}${extraClass ? ` ${extraClass}` : ''}` }, col);
  return { el, col, head };
}
