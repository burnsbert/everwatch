// Status bar (P-31, P-32, VISUAL_SPEC §4.10): the always-visible Tokens
// Used strip on the left (views/tokens.mjs, which also drives the
// toolbar's token alert chip), then on the right the kept-filter chip
// (click clears; never drops), the `N tabs · N agents` counts (moved here
// from the brand, D3), and a short key-hint subset from keymap.mjs's
// `footer` flag (D2 — the full list is the help sheet; hidden when
// prefs.show_hints is off). The glyph legend moved to the help sheet.

import { h, setText, reconcile } from './dom.mjs';
import { footerHintsFor } from '../keymap.mjs';
import { plural } from '../lib/format.mjs';
import { createTokens } from './tokens.mjs';

export function createFooter({ run, doc = document }) {
  const chip = doc.getElementById('filter-chip');
  const chipText = doc.getElementById('filter-chip-text');
  const hints = doc.getElementById('hints');
  const counts = doc.getElementById('counts');
  const tokens = createTokens({ run, doc });
  chip.addEventListener('click', () => run('filter.clear'));
  chip.setAttribute('data-tip', 'Clear filter  esc');
  let lastCtx = null;

  return {
    update(m) {
      chip.hidden = !m.filter || m.filterEditing;
      setText(chipText, `filter: ${m.filter}`);
      chip.setAttribute('aria-label', `Filter: ${m.filter}. Click to clear.`);
      const c = m.server?.counts || { tabs: 0, agents: 0 };
      setText(counts, m.server ? `${plural(c.tabs, 'tab')} · ${plural(c.agents, 'agent')}` : 'Not connected');
      hints.hidden = !m.prefs.show_hints;
      if (m.context !== lastCtx) {
        lastCtx = m.context;
        const list = footerHintsFor(m.context);
        reconcile(hints, list, (x) => `${x.keys}|${x.label}`,
          (x) => h('span', { class: 'hint' }, h('kbd', { text: x.keys }), h('span', { class: 'hint-label', text: x.label })),
          () => {});
        hints.dataset.context = m.context;
      }
      tokens.update(m);
    },
  };
}
