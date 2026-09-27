// Generic confirmation dialog (P-63 clear projects, P-64 close tab): a
// native <dialog> so Esc and focus-trapping come for free. Cancel is the
// default-focused button (mirrors ultrawatch's `y/n` where `n` is safer).
// Keymap context 'dialog' binds y/Y → dialog.confirm, n/N/Escape → cancel;
// this view only needs to supply the mouse path and initial focus.

import { setText } from './dom.mjs';

const COPY = {
  closeTab: (d) => ({
    title: `Close tab ${d.label}?`,
    detail: d.name ? `“${d.name}” will close in iTerm2.` : 'This will close the tab in iTerm2.',
    ok: 'Close tab',
  }),
  clearProjects: () => ({
    title: 'Clear all projects?',
    detail: 'Every project name and its tab-color assignments will be removed. This can’t be undone.',
    ok: 'Clear projects',
  }),
};

export function createConfirm({ run, doc = document }) {
  const dialog = doc.getElementById('confirm-dialog');
  const title = doc.getElementById('confirm-title');
  const detail = doc.getElementById('confirm-detail');
  const okBtn = doc.getElementById('confirm-ok');
  const cancelBtn = doc.getElementById('confirm-cancel');

  cancelBtn.addEventListener('click', () => run('dialog.cancel'));
  okBtn.addEventListener('click', () => run('dialog.confirm'));
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); run('dialog.cancel'); }); // native Esc
  dialog.addEventListener('click', (e) => { if (e.target === dialog) run('dialog.cancel'); });

  let lastKind = null;
  return {
    update(m) {
      const d = m.dialog;
      if (!d) {
        lastKind = null;
        if (dialog.open) dialog.close();
        return;
      }
      const copy = COPY[d.kind]?.(d) || { title: 'Are you sure?', detail: '', ok: 'OK' };
      setText(title, copy.title);
      setText(detail, copy.detail);
      setText(okBtn, copy.ok);
      okBtn.classList.toggle('btn--danger', d.kind === 'closeTab' || d.kind === 'clearProjects');
      if (!dialog.open) {
        dialog.showModal();
        cancelBtn.focus();
      }
      lastKind = d.kind;
    },
  };
}
