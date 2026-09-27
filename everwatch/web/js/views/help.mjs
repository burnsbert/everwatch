// Keyboard shortcut sheet (P-30), generated from keymap.helpSections() so it
// can't drift from the real bindings. `?` or ⌘/ opens; any key closes (the
// global key handler resolves every key in the 'help' context to help.close).

import { h } from './dom.mjs';
import { helpSections } from '../keymap.mjs';

// D2 (§4.9, §4.11): the footer's glyph legend is removed and moves here,
// as the sheet's first section, plus into glyph tooltips (§4.19) wherever
// this view's own file ownership reaches a glyph. `.legend`/`.legend-item`/
// `.glyph` are chrome.css/sessions.css classes already used by the footer
// legend and row/tile glyphs — reused as-is rather than duplicated.
const STATUS_ITEMS = Object.freeze([
  { cls: 'glyph--waiting', word: 'waiting' },
  { cls: 'glyph--busy is-static', word: 'busy' },
  { cls: 'glyph--idle', word: 'idle' },
  { cls: 'glyph--active', word: 'output' },
]);

function statusSection() {
  return h('section', { class: 'help-section help-section--status' },
    h('h3', { text: 'Status' }),
    h('div', { class: 'legend help-legend' }, ...STATUS_ITEMS.map((it) => h('span', { class: 'legend-item' },
      h('span', { class: `glyph ${it.cls}`, 'aria-hidden': 'true' }),
      it.word))));
}

export function createHelp({ run, doc = document }) {
  const dialog = doc.getElementById('help');
  const body = doc.getElementById('help-body');
  body.replaceChildren(statusSection(), ...helpSections().map((sec) => h('section', { class: 'help-section' },
    h('h3', { text: sec.group }),
    h('dl', {}, ...sec.items.map((i) => h('div', { class: 'help-item', dataset: { command: i.id } },
      h('dt', {}, ...i.keys.map((k) => h('kbd', { text: k }))),
      h('dd', { text: i.label })))))));

  // `.close()` (native or our own, from `update()` below) queues the
  // 'close' event as a task rather than firing it synchronously (HTML
  // spec), so a rapid close→reopen (as in the P-30 e2e test: '?', 'x',
  // '⌘/' back to back) can see this fire *after* a subsequent reopen has
  // already happened. Guard on the dialog's current (live) state so a
  // stale event from an earlier close never closes a session it doesn't
  // belong to.
  dialog.addEventListener('close', () => { if (!dialog.open) run('help.close'); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) run('help.close'); });

  return {
    update(m) {
      const open = m.overlay === 'help';
      if (open && !dialog.open) dialog.showModal();
      else if (!open && dialog.open) dialog.close();
    },
  };
}
