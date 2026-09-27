// Right-click context menu on session rows (P-48): rename, go to, a
// clearly-titled "Project" section (5 slots + clear, with a checkmark on
// the session's current project and a shortcut column, §4.9), close tab.
// Also opened from each row's own `.row-project` chip (sessions.mjs), so
// there's a second, obvious, keyboard-reachable way in besides right-click.
// Mouse-only complement to the keyboard paths (l, ⏎/g, 1–5/0, x) — this
// view just renders the menu and dispatches the same commands. Selecting
// the row first (A18) is commands.mjs's job (`contextmenu.open`), so this
// view doesn't need to know about selection at all.

import { h, icon } from './dom.mjs';
import { shortcutFor } from '../keymap.mjs';
import { colorName } from './row.mjs';

const SLOT_COLORS = ['blue', 'purple', 'green', 'red', 'yellow'];

function item(label, shortcut, onclick, { extraClass = '', lead = null } = {}) {
  return h('button', { type: 'button', role: 'menuitem', class: `ctx-item ${extraClass}`, onclick },
    h('span', { class: 'ctx-item-lead', 'aria-hidden': 'true' }, lead),
    h('span', { class: 'ctx-item-label', text: label }),
    shortcut ? h('span', { class: 'ctx-item-key', text: shortcut }) : null);
}

export function createContextMenu({ run, store, doc = document }) {
  const menu = h('div', { class: 'ctx-menu', role: 'menu', hidden: true, tabindex: '-1' });
  doc.body.append(menu);

  function close() { run('contextmenu.close'); }

  // 'pointerdown' (not 'click'): it fires before the row's own 'contextmenu'
  // handler for the *same* right-click gesture, so re-opening on a new row
  // never races its own close-on-outside-interaction logic.
  doc.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  doc.addEventListener('keydown', (e) => { if (!menu.hidden && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }, true);

  let lastUid = null;
  return {
    update(m) {
      const cm = m.contextMenu;
      if (!cm) {
        menu.hidden = true;
        lastUid = null;
        return;
      }
      const projects = m.projects;
      const session = m.server?.sessions?.find((s) => s.uid === cm.uid);
      const currentSlot = session?.tab_color ? session.project : null;
      const items = [
        item('Rename…', shortcutFor('label.edit'), () => { run('label.edit', { uid: cm.uid }); close(); }),
        item('Go to Session', shortcutFor('session.goto'), () => { run('session.goto', { uid: cm.uid }); close(); }),
        h('div', { class: 'ctx-sep', role: 'separator' }),
        h('div', { class: 'ctx-label', text: 'Project' }),
        ...SLOT_COLORS.map((color, i) => {
          const n = i + 1;
          const proj = projects?.slots?.find((s) => s.n === n);
          const checked = n === currentSlot;
          return item(
            `${n} · ${proj?.name || colorName(color)}`,
            String(n),
            () => { run('color.assign', { slot: n, uid: cm.uid }); close(); },
            {
              extraClass: checked ? 'ctx-item--checked' : '',
              lead: checked ? icon('check', 'icon icon--tiny') : h('span', { class: `ctx-dot ctx-dot--${color}`, 'aria-hidden': 'true' }),
            },
          );
        }),
        item('Clear Color', shortcutFor('color.clear'), () => { run('color.clear', { uid: cm.uid }); close(); }),
        h('div', { class: 'ctx-sep', role: 'separator' }),
        item('Close Tab…', shortcutFor('tab.close'), () => { run('tab.close', { uid: cm.uid }); close(); }, { extraClass: 'ctx-danger' }),
      ];
      if (cm.uid !== lastUid || menu.hidden) {
        menu.replaceChildren(...items);
        lastUid = cm.uid;
      }
      menu.hidden = false;
      // Measure synchronously (no rAF/setTimeout: those can be paused by a
      // fake test clock, e.g. Playwright's page.clock, leaving the menu
      // positioned off-screen forever). getBoundingClientRect() forces the
      // one layout pass it needs without waiting for a frame.
      const vw = doc.documentElement.clientWidth;
      const vh = doc.documentElement.clientHeight;
      menu.style.left = `${Math.max(4, cm.x)}px`;
      menu.style.top = `${Math.max(4, cm.y)}px`;
      const r = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(4, Math.min(cm.x, vw - r.width - 4))}px`;
      menu.style.top = `${Math.max(4, Math.min(cm.y, vh - r.height - 4))}px`;
    },
  };
}
