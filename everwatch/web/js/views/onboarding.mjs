// First-run onboarding wizard (docs/DESIGN.md §4.2). Shown until
// `prefs.onboarding_done` (main.mjs routes here once per page load); also
// reachable any time from Settings → "Run setup again". One required
// permission (Automation → iTerm2); everything else is skippable, and
// "Try demo mode" is always available so people can explore first.
//
// Steps: welcome → iTerm2 check → Automation permission → optional extras
// (notifications, tab colors, ultrawatch import) → done. Each step reads
// its state from the same merged `Diagnostics` checks Settings →
// Diagnostics uses (lib/diagnostics_ui.mjs), so the two can never disagree.
//
// Presentation (docs/design/VISUAL_SPEC.md §4.15): the main toolbar and
// status bar are hidden (pages.css keys off #app[data-view="onboarding"]);
// one centred card with a header (step count + progress segments), a
// scrolling body, and a footer that never covers the body. CTA rule: a
// satisfied step gets a primary Continue; an unsatisfied one keeps its own
// action as the primary button and offers a plain "Skip for Now" — never a
// primary Skip.

import { h, icon, setText } from './dom.mjs';
import { mergeNativeStatus, findCheck } from '../lib/diagnostics_ui.mjs';
import {
  actionButton, codeNodes, copyButton, requestDiagnosticsOnce,
} from './diag_actions.mjs';
import { automationIllustration } from './automation_illo.mjs';
import { STATUS_ICON } from './diagnostics.mjs';

const STEPS = [
  { id: 'welcome', title: 'Welcome' },
  { id: 'iterm', title: 'iTerm2' },
  { id: 'automation', title: 'Permission' },
  { id: 'extras', title: 'Extras' },
  { id: 'done', title: 'Done' },
];

const RECHECK_MS = 4000;
const TCCUTIL_CMD = 'tccutil reset AppleEvents io.github.burnsbert.everwatch';

function statusIcon(status) {
  return h('span', { class: 'ob-status-icon' }, icon(STATUS_ICON[status] || STATUS_ICON.unknown));
}

/** A status block (iTerm2 checks, automation connected / turned off): a
 * status icon, a title, a body, and optionally the check's action. */
function statusCard(kind, title, body) {
  return h('div', { class: 'ob-card', 'data-kind': kind },
    statusIcon(kind),
    h('div', { class: 'ob-card-text' },
      h('p', { class: 'ob-card-title', text: title }),
      h('p', { class: 'ob-card-body' }, ...codeNodes(body))));
}

/** One Extras row (Settings row anatomy) with a status icon. */
function extraCard(name) {
  const iconSlot = h('span', { class: 'ob-status-icon' });
  const title = h('h4', { class: 'ob-card-title' });
  const body = h('p', { class: 'ob-card-body' });
  const actions = h('div', { class: 'settings-row-action' });
  const el = h('div', { class: 'settings-row ob-extra', 'data-kind': name },
    iconSlot, h('div', { class: 'settings-row-text' }, title, body), actions);
  el.__p = {
    iconSlot, title, body, actions, status: null, detail: null,
  };
  return el;
}

function fillExtra(card, check, run) {
  const p = card.__p;
  if (p.status !== check.status) {
    p.status = check.status;
    card.dataset.status = check.status;
    p.iconSlot.replaceChildren(icon(STATUS_ICON[check.status] || STATUS_ICON.unknown));
  }
  setText(p.title, check.title);
  if (p.detail !== check.detail) {
    p.detail = check.detail;
    p.body.replaceChildren(...codeNodes(check.detail));
  }
  p.actions.replaceChildren(...(check.action ? [actionButton(check.action, run)] : []));
}

export function createOnboardingView({ run, store, api }) {
  let step = 0;
  let pollTimer = null;
  let requested = false;
  // Whether each step's own check(s) already pass -- welcome has no
  // pass/fail state of its own (it always advances via "Next"). Extras are
  // optional: "done" once the user has acted on any extra (clicked one of
  // its action buttons) or every extra shown is already ok; "Skip" otherwise.
  const stepDone = [false, false, false, false, false];
  let extrasActed = false;

  // --- welcome -----------------------------------------------------------
  const demoNote = h('p', { class: 'ob-body' });
  const demoBox = h('div', { class: 'ob-demo-box' });
  const welcome = h('div', { class: 'ob-step', 'data-step': 'welcome' },
    icon('logo', 'ob-logo'),
    h('h2', { class: 'ob-title', text: 'Welcome to Everwatch' }),
    h('p', { class: 'ob-body', text: 'Everwatch watches your iTerm2 sessions and tells you the moment Claude Code or Codex needs you — no more tabbing through a dozen windows to find out.' }),
    demoNote, demoBox);

  // --- iterm ---------------------------------------------------------------
  const itermCards = h('div', { class: 'ob-cards' });
  const itermStep = h('div', { class: 'ob-step', 'data-step': 'iterm' },
    h('h2', { class: 'ob-title', text: 'Is iTerm2 ready?' }),
    h('p', { class: 'ob-body', text: 'Everwatch reads and controls iTerm2 sessions — it needs iTerm2 installed and running.' }),
    itermCards);

  // --- automation ----------------------------------------------------------
  // One step, four states, each with its own plain-language copy rather than
  // the backend's diagnostic wording (which Settings → Diagnostics shows):
  //   unknown  → why it's needed + what macOS is about to ask
  //   error    → it's turned off: what happened, how to fix, a picture of
  //              the exact switch, Open System Settings + Check again
  //   warn     → iTerm2 isn't running, so macOS can't ask yet
  //   ok       → connected
  const autoBody = h('p', { class: 'ob-body' });
  const autoExplain = h('div', { class: 'ob-callout' },
    h('p', { class: 'ob-callout-title', text: 'macOS will ask' }),
    h('p', { class: 'ob-callout-body' }, h('span', { text: '“Everwatch” wants to control “iTerm2” — click ' }), h('strong', { text: 'OK' }), h('span', { text: '.' })));
  const autoOkCard = statusCard('ok', 'Connected', 'Everwatch can see your iTerm2 sessions and switch to them for you.');
  const autoOffCard = statusCard('warn', 'Everwatch can’t see iTerm2 yet',
    'macOS is keeping them apart — usually because “Don’t Allow” was clicked when it asked. Nothing is broken, and it only takes a moment to fix.');
  const autoAction = h('div', { class: 'ob-actions' });
  const recheckBtn = h('button', {
    type: 'button', class: 'btn', text: 'Check Again', onclick: () => run('diagnostics.recheck'),
  });
  const autoGuide = h('div', { class: 'ob-guide', hidden: true },
    h('p', { class: 'ob-guide-title', text: 'How to turn it on' }),
    h('ol', { class: 'empty-steps' },
      h('li', { text: 'Open System Settings → Privacy & Security → Automation' }),
      h('li', { text: 'Find Everwatch in the list' }),
      h('li', { text: 'Turn on iTerm2' })),
    automationIllustration());
  const autoNote = h('p', { class: 'ob-note', text: 'Everwatch checks again every few seconds and moves on by itself once it’s on.' });
  const stuckCmd = h('code', { class: 'settings-code', text: TCCUTIL_CMD });
  const stuckDetails = h('details', { class: 'ob-stuck' },
    h('summary', { text: 'Still stuck?' }),
    h('p', { class: 'ob-stuck-body', text: 'If Everwatch isn’t in the Automation list at all, paste this into Terminal to reset its permission. macOS will ask again the next time Everwatch connects.' }),
    h('div', { class: 'ob-stuck-cmd' }, stuckCmd, copyButton(TCCUTIL_CMD, 'Copy')));
  // The step's own action sits right under the status, above the guide, so
  // it's in view without scrolling even when the guide is tall.
  const automationStep = h('div', { class: 'ob-step', 'data-step': 'automation' },
    h('h2', { class: 'ob-title', text: 'Connect to iTerm2' }),
    autoBody, autoExplain, autoOkCard, autoOffCard, autoAction, autoGuide, autoNote, stuckDetails);

  // --- extras ----------------------------------------------------------------
  const notifCard = extraCard('notifications');
  const colorsCard = extraCard('tab_colors');
  const importCard = extraCard('ultrawatch_import');
  const extrasStep = h('div', { class: 'ob-step', 'data-step': 'extras' },
    h('h2', { class: 'ob-title', text: 'A few optional extras' }),
    h('p', { class: 'ob-body', text: 'None of these are required — skip anything you don’t want yet. Everything here is also in Settings later.' }),
    h('div', { class: 'settings-group ob-extras' }, notifCard, colorsCard, importCard));
  // Capture phase: an action's own click handler can re-render the card
  // (replacing the button) before a bubbling listener would see it.
  extrasStep.addEventListener('click', (e) => {
    if (!e.target.closest?.('.settings-row-action button, .settings-row-action a')) return;
    extrasActed = true;
    stepDone[3] = true;
    render();
  }, true);

  // --- done --------------------------------------------------------------
  const doneStep = h('div', { class: 'ob-step', 'data-step': 'done' },
    h('span', { class: 'ob-hero' }, icon('sparkle', 'icon icon--xl')),
    h('h2', { class: 'ob-title', text: 'You’re all set' }),
    h('ul', { class: 'ob-tips' },
      h('li', {}, h('kbd', { text: '⌥⌘J' }), h('span', { text: ' jumps to the next waiting session' })),
      h('li', {}, h('kbd', { text: '⌘K' }), h('span', { text: ' opens the command palette' })),
      h('li', {}, h('kbd', { text: 'Space' }), h('span', { text: ' zooms the selected preview' }))));

  const stepEls = [welcome, itermStep, automationStep, extrasStep, doneStep];

  // --- chrome: header (step count + progress segments), footer --------------
  const segs = STEPS.map(() => h('span', { class: 'ob-seg' }));
  const progress = h('div', { class: 'ob-progress', 'aria-hidden': 'true' }, ...segs);
  const progressText = h('p', { class: 'ob-progress-text' });
  const backBtn = h('button', { type: 'button', class: 'btn btn--plain', text: 'Back', onclick: () => go(step - 1) });
  const skipBtn = h('button', { type: 'button', class: 'btn btn--plain', text: 'Skip for Now', onclick: () => onSkip() });
  const nextBtn = h('button', { type: 'button', class: 'btn btn--primary', text: 'Next', onclick: () => onSkip() });
  const body = h('div', { class: 'ob-body-wrap' }, ...stepEls);
  const root = h('div', { class: 'onboarding-page' },
    h('div', { class: 'ob-wrap', role: 'group', 'aria-roledescription': 'wizard', 'aria-label': 'Everwatch setup' },
      h('div', { class: 'ob-head' }, progressText, progress),
      body,
      h('div', { class: 'ob-nav' }, backBtn, h('div', { class: 'ob-nav-spacer' }), skipBtn, nextBtn)));

  function focusStep() {
    const el = stepEls[step];
    const h2 = el.querySelector('h2');
    h2?.setAttribute('tabindex', '-1');
    h2?.focus();
  }

  function go(n) {
    step = Math.max(0, Math.min(STEPS.length - 1, n));
    render();
    focusStep();
  }

  function onSkip() {
    if (step === STEPS.length - 1) run('onboarding.finish');
    else go(step + 1);
  }

  function render() {
    for (const [i, el] of stepEls.entries()) el.hidden = i !== step;
    for (const [i, d] of segs.entries()) {
      d.classList.toggle('is-active', i === step);
      d.classList.toggle('is-done', i < step);
    }
    setText(progressText, `Step ${step + 1} of ${STEPS.length} — ${STEPS[step].title}`);
    backBtn.hidden = step === 0;
    const last = step === STEPS.length - 1;
    // welcome and done always move on; a middle step moves on with a
    // primary Continue once it passes, else only via the plain Skip for Now
    const advance = step === 0 || last || stepDone[step];
    nextBtn.hidden = !advance;
    skipBtn.hidden = advance;
    setText(nextBtn, last ? 'Get Started' : step === 0 ? 'Next' : 'Continue');
  }
  render();

  return {
    el: root,
    update(m) {
      if (!requested) {
        requested = true;
        requestDiagnosticsOnce(api, store);
      }
      const shell = m.state.native?.shell;
      const rawChecks = m.state.diagnostics?.checks;
      const checks = mergeNativeStatus(rawChecks, m.state.native, shell);

      // welcome / demo mode
      const inDemo = m.server?.mode === 'demo';
      setText(demoNote, inDemo
        ? 'You’re already exploring in demo mode — nothing here needs a real permission yet.'
        : 'Curious first? Try demo mode — a scripted fleet of sessions with no permissions needed:');
      demoBox.hidden = inDemo;
      demoBox.replaceChildren(h('code', { class: 'settings-code', text: 'everwatch demo' }), copyButton('everwatch demo', 'Copy'));

      // iTerm2 installed/running
      const installed = findCheck(checks, 'iterm_installed');
      const running = findCheck(checks, 'iterm_running');
      stepDone[1] = installed?.status === 'ok' && running?.status === 'ok';
      itermCards.replaceChildren();
      for (const check of [installed, running]) {
        if (!check) continue;
        const card = statusCard(check.status, check.title, check.detail);
        if (check.action) card.append(h('div', { class: 'ob-card-action' }, actionButton(check.action, run)));
        itermCards.append(card);
      }

      // Automation
      const automation = findCheck(checks, 'automation');
      const autoStatus = automation?.status;
      const autoOk = autoStatus === 'ok';
      stepDone[2] = autoOk;
      const denied = autoStatus === 'error';
      const notRunning = autoStatus === 'warn';
      const asking = !autoOk && !denied && !notRunning;
      setText(autoBody, notRunning
        ? 'iTerm2 isn’t open, so macOS can’t ask for permission yet. Open iTerm2 and this step carries on by itself.'
        : 'To show your sessions and jump between them, Everwatch needs your OK to control iTerm2. macOS asks just once.');
      autoBody.hidden = autoOk || denied;
      autoExplain.hidden = !asking;
      autoOkCard.hidden = !autoOk;
      autoOffCard.hidden = !denied;
      autoGuide.hidden = !denied;
      stuckDetails.hidden = !denied;
      autoNote.hidden = !denied;
      // unsatisfied: the step's own action is the primary button (§4.15)
      const fix = automation?.action ? actionButton(automation.action, run, 'btn btn--primary') : null;
      autoAction.replaceChildren(...[fix, denied ? recheckBtn : null].filter(Boolean));
      autoAction.hidden = !autoAction.childElementCount;
      const onAutomationStep = step === 2;
      if (onAutomationStep && !autoOk && rawChecks) {
        if (!pollTimer) pollTimer = setInterval(() => run('diagnostics.recheck'), RECHECK_MS);
      } else if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      // extras
      const notif = findCheck(checks, 'notifications');
      notifCard.hidden = !shell || !notif; // browser mode has no notifications bridge at all
      if (notif) fillExtra(notifCard, notif, run);
      const colors = findCheck(checks, 'tab_colors');
      colorsCard.hidden = !colors;
      if (colors) fillExtra(colorsCard, colors, run);
      const imported = findCheck(checks, 'ultrawatch_import');
      importCard.hidden = !imported?.action;
      if (imported?.action) fillExtra(importCard, imported, run);
      const shownExtras = [
        [notifCard, notif], [colorsCard, colors], [importCard, imported],
      ].filter(([card, check]) => !card.hidden && check);
      const extrasAllOk = shownExtras.length > 0 && shownExtras.every(([, check]) => check.status === 'ok');
      stepDone[3] = extrasActed || extrasAllOk;

      render();
    },
  };
}
