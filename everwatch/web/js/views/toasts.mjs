// Toast stack (P-31, P-33): bottom-centre cards in an aria-live region,
// auto-dismissed after `m.config.toastSeconds` (§4.13: ~3.5 s, errors
// included — the user asked that "whatever popups we do need should
// disappear by themselves after 3-4 seconds"). Clicking a toast dismisses
// it early; clicking its action button (Undo, Set up…, Retry) runs the
// action instead and doesn't also dismiss (stopPropagation). The Undo
// toast isn't sticky — it just runs out its normal timer like any other.
//
// WCAG 2.2.1 (timing adjustable): the per-toast dismiss timer pauses while
// the pointer is over that toast or focus is inside it (e.g. its action
// button), and restarts at the full `toastSeconds` when the pointer/focus
// leaves both — not a resume-from-remainder, a fresh countdown.

import {
  h, reconcile, setText, attr, icon,
} from './dom.mjs';

const REAL_TIMERS = Object.freeze({
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id),
});

// §4.13 leading status glyph. `attention` reuses the app's own waiting
// glyph (the amber pulsing ring used on rows/tiles), not a sprite icon;
// the rest map to sprite symbols.
const ICON = Object.freeze({ info: 'info', warn: 'warn', danger: 'x-circle' });

export function createToasts({ store, run = null, doc = document, timers = REAL_TIMERS }) {
  const root = doc.getElementById('toasts');
  const timerOf = new Map(); // toast id -> live timeout handle
  // Ids paused by hover/focus: `update()` re-renders on every unrelated
  // store change (a tick, an SSE state, …), so it must not re-arm a timer
  // for a toast that's intentionally not counting down right now.
  const paused = new Set();
  let toastSeconds = 3.5;

  function clearTimer(id) {
    const handle = timerOf.get(id);
    if (handle !== undefined) {
      timers.clearTimeout(handle);
      timerOf.delete(id);
    }
  }

  function schedule(id) {
    clearTimer(id);
    const handle = timers.setTimeout(() => {
      timerOf.delete(id);
      store.dispatch({ type: 'toastExpire', id });
    }, toastSeconds * 1000);
    timerOf.set(id, handle);
  }

  function pause(id) {
    paused.add(id);
    clearTimer(id);
  }

  function resume(id) {
    paused.delete(id);
    schedule(id);
  }

  function toastOf(node) { return node?.closest?.('.toast') || null; }

  root.addEventListener('click', (e) => {
    if (e.target.closest('.toast-action')) return;
    const t = toastOf(e.target);
    if (t) store.dispatch({ type: 'toastExpire', id: Number(t.dataset.id) });
  });

  // A move that stays inside the same toast (e.g. onto its action button)
  // isn't a "leave" — no restart, no flicker.
  root.addEventListener('pointerover', (e) => {
    const t = toastOf(e.target);
    if (t) pause(Number(t.dataset.id));
  });
  root.addEventListener('pointerout', (e) => {
    const t = toastOf(e.target);
    if (t && toastOf(e.relatedTarget) !== t) resume(Number(t.dataset.id));
  });
  root.addEventListener('focusin', (e) => {
    const t = toastOf(e.target);
    if (t) pause(Number(t.dataset.id));
  });
  root.addEventListener('focusout', (e) => {
    const t = toastOf(e.target);
    if (t && toastOf(e.relatedTarget) !== t) resume(Number(t.dataset.id));
  });

  function buildToast(t) {
    return h('div', { class: 'toast', dataset: { id: String(t.id) }, tabindex: '-1' },
      icon(ICON[t.level] || ICON.info, 'icon toast-icon'),
      h('span', { class: 'glyph glyph--waiting toast-glyph', 'aria-hidden': 'true' }),
      h('span', { class: 'toast-text' }));
  }

  function updateToast(el, t) {
    el.dataset.level = t.level;
    const isAttention = t.level === 'attention';
    const iconEl = el.querySelector('.toast-icon');
    const glyphEl = el.querySelector('.toast-glyph');
    iconEl.hidden = isAttention;
    glyphEl.hidden = !isAttention;
    if (!isAttention) attr(iconEl.querySelector('use'), 'href', `#i-${ICON[t.level] || ICON.info}`);
    setText(el.querySelector('.toast-text'), t.message);
    const existing = el.querySelector('.toast-action');
    if (existing) existing.remove();
    if (t.action) {
      const btn = h('button', {
        type: 'button', class: 'toast-action', text: t.action.label,
        onclick: (e) => { e.stopPropagation(); run?.(t.action.command, t.action.args); },
      });
      el.append(btn);
    }
  }

  return {
    update(m) {
      toastSeconds = m.config.toastSeconds;
      const live = new Set(m.toasts.map((t) => t.id));
      for (const id of timerOf.keys()) if (!live.has(id)) clearTimer(id);
      for (const id of paused) if (!live.has(id)) paused.delete(id);
      for (const t of m.toasts) if (!timerOf.has(t.id) && !paused.has(t.id)) schedule(t.id);
      reconcile(root, m.toasts, (t) => t.id, buildToast, updateToast);
    },
  };
}
