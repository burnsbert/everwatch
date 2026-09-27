// Session list (listbox) shared by split and list views: keyed rows,
// optional "Window N" headers (P-24), click / double-click (P-42), keeping
// the selection in view (P-45), and the no-match state for filters.

import { h, icon, reconcile, attr } from './dom.mjs';
import { createRow, updateRow } from './row.mjs';
import { groupItems } from '../lib/rows.mjs';

export function createSessionList({ run, mode = 'split' }) {
  const list = h('div', {
    class: `session-list session-list--${mode}`, role: 'listbox', tabindex: '0', 'aria-label': 'Sessions',
    id: mode === 'split' ? 'session-list' : 'session-list-full',
  });
  // Nothing listed although sessions exist: either the filter matches
  // nothing ("Clear Filter"), or "AI sessions only" is on and there are no
  // Claude Code / Codex sessions ("Show All Sessions").
  let emptyAction = 'filter.clear';
  const noMatchTitle = h('p', { class: 'empty-title', text: 'No matching sessions' });
  const noMatchBtn = h('button', { type: 'button', class: 'btn btn--small', text: 'Clear Filter', onclick: () => run(emptyAction) });
  const noMatch = h('div', { class: 'list-empty', hidden: true },
    icon('filter-empty', 'empty-icon empty-icon--small'),
    noMatchTitle,
    h('p', { class: 'empty-body list-empty-body' }),
    noMatchBtn);
  const root = h('div', { class: 'session-list-wrap' }, list, noMatch);

  const rowOpts = {
    onEditCommit: (uid, value) => run('label.save', { uid, value }),
    onEditCancel: () => run('label.cancel'),
  };

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const chip = e.target.closest('.row-project');
    if (chip) {
      e.stopPropagation();
      const r = chip.getBoundingClientRect();
      run('contextmenu.open', { uid: row.dataset.uid, x: r.left, y: r.bottom + 4 });
      return;
    }
    if (e.target.closest('.row-edit-icon')) {
      e.stopPropagation();
      run('label.edit', { uid: row.dataset.uid });
      return;
    }
    run('select.uid', { uid: row.dataset.uid });
  });
  list.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.row-name')) run('label.edit', { uid: row.dataset.uid });
    else run('session.goto', { uid: row.dataset.uid });
  });
  list.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    e.stopPropagation(); // don't let the document-level "close on outside contextmenu" handler undo this
    run('contextmenu.open', { uid: row.dataset.uid, x: e.clientX, y: e.clientY });
  });

  let lastSelected = null;
  let lastMode = null;

  function update(m) {
    const { rows, selectedUid, sort, grouped } = m;
    const items = grouped ? groupItems(rows, sort) : rows.map((row) => ({ type: 'row', row }));
    reconcile(list, items,
      (it) => (it.type === 'header' ? `w:${it.window_id}` : it.row.s.uid),
      (it) => (it.type === 'header'
        ? h('div', { class: 'group-header', role: 'presentation' }, h('span', { class: 'group-header-text' }))
        : createRow(rowOpts)),
      (el, it) => {
        if (it.type === 'header') {
          el.firstChild.textContent = `Window ${it.window_no}`;
          return;
        }
        updateRow(el, {
          row: it.row,
          selected: it.row.s.uid === selectedUid,
          now: m.now,
          started: m.started,
          freshSeconds: m.freshSeconds,
          flash: !!m.flashes[it.row.s.uid],
          editing: m.editingLabel === it.row.s.uid,
          projects: m.projects,
          activity: !!m.prefs.show_row_activity,
          idPrefix: `row-${mode}`,
        });
      });
    attr(list, 'aria-activedescendant', selectedUid ? `row-${mode}-${selectedUid}` : null);
    const filtered = !rows.length && m.total > 0;
    noMatch.hidden = !filtered;
    list.hidden = filtered;
    if (filtered) {
      const agentsEmpty = !m.filter && !!m.prefs.agents_only;
      emptyAction = agentsEmpty ? 'agents.toggle' : 'filter.clear';
      noMatchTitle.textContent = agentsEmpty ? 'No AI sessions' : 'No matching sessions';
      noMatchBtn.textContent = agentsEmpty ? 'Show All Sessions' : 'Clear Filter';
      noMatch.querySelector('.list-empty-body').textContent = agentsEmpty
        ? 'Only Claude Code and Codex sessions are shown.'
        : `Nothing matches “${m.filter}”.`;
    }

    if (selectedUid && (selectedUid !== lastSelected || mode !== lastMode)) {
      const el = list.querySelector(`[data-uid="${CSS.escape(selectedUid)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    }
    lastSelected = selectedUid;
    lastMode = mode;
  }

  return { el: root, list, update };
}
