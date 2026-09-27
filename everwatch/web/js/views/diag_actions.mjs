// Shared renderer for a diagnostics `Check.action` (build/wp7-handoff.md's
// action-kind table), used by Settings → Diagnostics and the onboarding
// wizard so the two present the exact same buttons for the exact same
// backend action shape.

import { h, icon } from './dom.mjs';
import { copyText } from '../lib/clipboard.mjs';
import { codeSpans } from '../lib/code_spans.mjs';

const ENDPOINT_COMMAND = {
  '/api/diagnostics/recheck': 'diagnostics.recheck',
  '/api/colors/install': 'colors.install',
  '/api/import/ultrawatch': 'ultrawatch.import',
  '/api/iterm/launch': 'iterm.launch',
  '/api/refresh': 'session.refresh',
};

/** Backend prose → text nodes with its backtick spans as `<code>` elements
 * (VISUAL_SPEC §4.15). Text only ever goes in via text nodes, never HTML. */
export function codeNodes(text) {
  return codeSpans(text).map((r) => (r.code ? h('code', { text: r.text }) : document.createTextNode(r.text)));
}

export function copyButton(text, label, cls = 'btn btn--small') {
  const btn = h('button', { type: 'button', class: cls, text: label });
  btn.addEventListener('click', () => {
    copyText(text);
    const was = btn.textContent;
    btn.textContent = 'Copied!';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = was; btn.disabled = false; }, 1400);
  });
  return btn;
}

/**
 * GET /api/diagnostics once per view mount — what "turns on" the backend's
 * `diagnostics` SSE event for the rest of the session (it's inert until the
 * first GET/recheck, build/wp7-handoff.md). Guarded so a slow response
 * can't clobber a *newer* `diagnostics` SSE event that already arrived
 * while the request was in flight (the SSE stream, once flowing, is
 * always the freshest source of truth — same precedence rule the rest of
 * the app already applies to `state`/`screens`, store.mjs's `applyServerState`).
 */
export function requestDiagnosticsOnce(api, store) {
  api?.diagnostics().then((d) => {
    if (!store.getState().diagnostics) store.dispatch({ type: 'diagnostics', payload: d });
  }).catch(() => {});
}

/** `action` → one button/link, or `null` for no action. `run` is `commands.run`. */
export function actionButton(action, run, cls = 'btn btn--small') {
  if (!action) return null;
  const label = action.label || 'Fix';
  switch (action.kind) {
    case 'link': // external: button styling plus a ↗ (§4.8 links, §4.15)
      return h('a', {
        class: cls, href: action.url, target: '_blank', rel: 'noreferrer noopener',
      }, label, icon('external', 'icon icon--xs'));
    case 'command':
      return copyButton(action.command, label, cls);
    case 'copy':
      return copyButton(action.text, label, cls);
    case 'endpoint':
      return h('button', {
        type: 'button', class: cls, text: label, onclick: () => run(ENDPOINT_COMMAND[action.path] || 'diagnostics.recheck'),
      });
    case 'open_system_settings':
      return h('button', { type: 'button', class: cls, text: label, onclick: () => run('automation.settings', { pane: action.pane }) });
    case 'request_notifications':
      return h('button', { type: 'button', class: cls, text: label, onclick: () => run('notifications.request') });
    default:
      return null;
  }
}
