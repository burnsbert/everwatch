// Empty states (P-29): iTerm2 not running, Automation permission denied,
// connecting, query failed, no sessions, and "can't reach the backend".
// Each has an illustration and one or two actions. Presentation:
// docs/design/VISUAL_SPEC.md §4.15 (a quiet icon circle, status-tinted
// icon for error kinds, a small spinner for the connecting kinds).

import { h, icon, setText } from './dom.mjs';
import { codeNodes } from './diag_actions.mjs';

export { emptyStateKind as emptyKind } from '../lib/format.mjs';

export function createEmptyView({ run, shell }) {
  const ico = h('span', { class: 'empty-art' });
  const title = h('h2', { class: 'empty-title' });
  const spinner = h('span', { class: 'empty-spinner', role: 'presentation', hidden: true });
  const body = h('p', { class: 'empty-body' });
  const detail = h('pre', { class: 'empty-detail', hidden: true });
  const steps = h('ol', { class: 'empty-steps', hidden: true });
  const actions = h('div', { class: 'empty-actions' });
  const card = h('div', { class: 'empty-card', role: 'region', 'aria-live': 'polite' }, ico, title, spinner, body, steps, detail, actions);
  const root = h('div', { class: 'empty-page' }, card);
  let last = null;

  const btn = (label, command, primary = false) => h('button', {
    type: 'button', class: `btn${primary ? ' btn--primary' : ''}`, text: label, onclick: () => run(command),
  });

  const KINDS = {
    not_running: () => ({
      icon: 'terminal', title: 'iTerm2 isn’t running',
      body: 'Everwatch watches your iTerm2 sessions. Start iTerm2 and your tabs will appear here automatically.',
      actions: [btn('Launch iTerm2', 'iterm.launch', true), btn('Diagnose…', 'diagnose.open')],
    }),
    permission_denied: () => ({
      icon: 'lock', title: 'Everwatch can’t talk to iTerm2',
      body: 'macOS is blocking Automation access. Allow it once and Everwatch reconnects by itself.',
      steps: shell
        ? ['Open System Settings → Privacy & Security → Automation', 'Find Everwatch in the list', 'Turn on iTerm2']
        : ['Open System Settings → Privacy & Security → Automation', 'Find the terminal app that launched Everwatch', 'Turn on iTerm2'],
      actions: [btn('Open System Settings', 'automation.settings', true), btn('Diagnose…', 'diagnose.open')],
    }),
    connecting: () => ({
      icon: 'plug', title: 'Connecting to iTerm2…', body: 'Reading your sessions. This takes a second or two.', spinner: true, actions: [],
    }),
    error: (server) => ({
      icon: 'terminal', title: 'iTerm2 query failed',
      body: 'The last snapshot request failed. Everwatch retries automatically.',
      detail: server?.iterm?.error || '',
      actions: [btn('Retry Now', 'session.refresh', true), btn('Diagnose…', 'diagnose.open')],
    }),
    no_sessions: () => ({
      icon: 'sparkle', title: 'No sessions yet',
      body: 'Open a tab in iTerm2 and start Claude Code or Codex — it shows up here within a couple of seconds.',
      actions: [btn('New iTerm2 Tab', 'tab.new', true)],
    }),
    no_backend: () => ({
      icon: 'plug', title: 'Can’t reach the Everwatch backend', spinner: true,
      body: 'Reconnecting automatically. If this persists, restart Everwatch or run `everwatch doctor`.',
      actions: [],
    }),
    no_token: () => ({
      icon: 'lock', title: 'Missing access token',
      body: 'Open Everwatch from the app, or run `everwatch open` to get a link that includes the token.',
      actions: [],
    }),
  };

  return {
    el: root,
    update({ kind, server }) {
      root.dataset.kind = kind || '';
      const key = `${kind}|${server?.iterm?.error || ''}`;
      if (!kind || key === last) return;
      last = key;
      const k = KINDS[kind](server);
      ico.replaceChildren(icon(k.icon, 'empty-icon'));
      spinner.hidden = !k.spinner;
      setText(title, k.title);
      body.replaceChildren(...codeNodes(k.body));
      steps.hidden = !k.steps;
      steps.replaceChildren(...(k.steps || []).map((t) => h('li', { text: t })));
      detail.hidden = !k.detail;
      setText(detail, k.detail || '');
      actions.replaceChildren(...k.actions);
    },
  };
}
