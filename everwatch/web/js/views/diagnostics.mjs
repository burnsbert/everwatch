// Settings → Diagnostics (docs/DESIGN.md §4.2, build/wp7-handoff.md): the
// 13 backend checks as a clean list, each with a status icon, detail text,
// and one action button. `nativeStatus` (shell → web) is merged in for
// notifications/hotkeys/automation (lib/diagnostics_ui.mjs) since the
// backend can't see those itself. Calling GET /api/diagnostics on mount is
// what turns on the `diagnostics` SSE event for the rest of the session
// (it's inert until the first GET/recheck — build/wp7-handoff.md).
// Presentation (docs/design/VISUAL_SPEC.md §4.15): one grouped list with
// the Settings row anatomy, in CHECK_ORDER; backtick spans render as <code>.

import { h, icon, reconcile, setText } from './dom.mjs';
import { createPage } from './page.mjs';
import { mergeNativeStatus, summarize, STATUS_LABEL } from '../lib/diagnostics_ui.mjs';
import { actionButton, codeNodes, requestDiagnosticsOnce } from './diag_actions.mjs';

/** §4.15 status icons (sprite ids). */
export const STATUS_ICON = {
  ok: 'check-circle', warn: 'warn', error: 'x-circle', info: 'info', unknown: 'minus-circle',
};

function checkRow() {
  const statusIcon = h('span', { class: 'check-icon' });
  // the status word stays in the row for screen readers (visually hidden)
  const status = h('span', { class: 'check-status visually-hidden' }, h('span', { class: 'check-status-text' }));
  const title = h('h3', { class: 'check-title' });
  const detail = h('p', { class: 'check-detail' });
  const actions = h('div', { class: 'check-actions' });
  const el = h('div', { class: 'check-row', role: 'listitem' },
    statusIcon,
    h('div', { class: 'check-text' }, h('div', { class: 'check-head' }, title, status), detail),
    actions);
  el.__p = {
    statusIcon, status, title, detail, actions, detailText: null, iconName: null,
  };
  return el;
}

function updateCheckRow(el, check, run) {
  const p = el.__p;
  el.dataset.status = check.status;
  el.dataset.id = check.id;
  const iconName = STATUS_ICON[check.status] || STATUS_ICON.unknown;
  if (p.iconName !== iconName) {
    p.iconName = iconName;
    p.statusIcon.replaceChildren(icon(iconName));
  }
  setText(p.title, check.title);
  setText(p.status.querySelector('.check-status-text'), STATUS_LABEL[check.status] || check.status);
  if (p.detailText !== check.detail) {
    p.detailText = check.detail;
    p.detail.replaceChildren(...codeNodes(check.detail));
  }
  const btn = actionButton(check.action, run);
  p.actions.replaceChildren(...(btn ? [btn] : []));
}

export function createDiagnosticsView({ run, store, api }) {
  const list = h('div', { class: 'settings-group check-list', role: 'list' });
  const summaryIcon = h('span', { class: 'diag-summary-icon' });
  const summaryText = h('span', { class: 'diag-summary-text' });
  const summary = h('p', { class: 'diag-summary' }, summaryIcon, summaryText);
  const recheck = h('button', {
    type: 'button', class: 'btn', text: 'Check Again', onclick: () => run('diagnostics.recheck'),
  });
  const page = createPage({
    title: 'Diagnostics', width: 'diagnostics', extraClass: 'diagnostics-page', run, backCommand: 'route.back', actions: [recheck], sub: summary,
  });
  page.col.append(list);

  let requested = false;
  let summaryIconName = null;

  return {
    el: page.el,
    update(m) {
      if (!requested) {
        requested = true;
        requestDiagnosticsOnce(api, store);
      }
      const checks = mergeNativeStatus(m.state.diagnostics?.checks, m.state.native, m.state.native?.shell);
      const counts = summarize(checks);
      const bad = counts.error + counts.warn;
      // "1 of 13 needs attention" / "2 of 13 need attention"
      setText(summaryText, checks.length
        ? (bad ? `${bad} of ${checks.length} ${bad === 1 ? 'needs' : 'need'} attention` : `All ${checks.length} checks look good`)
        : 'Waiting for the first check…');
      const worst = !checks.length ? null : counts.error ? 'error' : counts.warn ? 'warn' : 'ok';
      summary.dataset.status = worst || '';
      if (summaryIconName !== worst) {
        summaryIconName = worst;
        summaryIcon.replaceChildren(...(worst ? [icon(STATUS_ICON[worst])] : []));
      }
      reconcile(list, checks, (c) => c.id, checkRow, (el, c) => updateCheckRow(el, c, run));
    },
  };
}
