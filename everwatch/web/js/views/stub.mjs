// Placeholder pages for views owned by later work packages (grid, settings,
// diagnostics, projects, onboarding). Each registers in views/registry.mjs so
// routes, the `v` cycle, and keys already work; WP5/WP7 replace the entry.

import { h, icon } from './dom.mjs';

export function createStubView({ run, title, body, iconName = 'sparkle', backLabel = 'Back to sessions', actions = [] }) {
  const root = h('div', { class: 'stub-page' },
    h('div', { class: 'empty-card' },
      icon(iconName, 'empty-icon'),
      h('h2', { class: 'empty-title', text: title }),
      h('p', { class: 'empty-body', text: body }),
      h('div', { class: 'empty-actions' },
        ...actions.map((a) => h('button', { type: 'button', class: `btn ${a.primary ? 'btn--primary' : ''}`, text: a.label, onclick: () => run(a.command, a.args) })),
        h('button', { type: 'button', class: 'btn', text: backLabel, onclick: () => run(backLabel === 'Split view' ? 'view.split' : 'route.back') }))));
  return { el: root, update() {} };
}
