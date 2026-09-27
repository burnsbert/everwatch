// §4.19 tooltip component: the app's own tooltip, replacing native `title`
// wherever an abbreviation, icon, glyph, chip, or meter appears (native
// `title` stays only on truncated plain text — full-text reveal). One
// `<div id="tooltip" role="tooltip">` (index.html) shared by the whole
// document via delegated listeners, so any view can opt in just by adding
// `data-tip="…"` (plain text) to a target — no per-view wiring needed.
// `data-tip-id="…"` targets a structured builder registered with
// `registerTip()` for content that needs more than one line (quota items,
// agent badges, …) — call sites that need that (T040, WP-B) import
// `registerTip` directly; they don't need a tooltip instance of their own.
//
// Content is always set with `textContent` (dom.mjs's `setText`/`h`),
// never innerHTML, per the index.html sprite comment's rule that session
// data is never inserted as HTML.
//
// `createTooltip()` is called once, from header.mjs (the toolbar is always
// mounted before anything else renders) — every other view just uses
// `data-tip`/`data-tip-id` and never has to know this module exists.

import { h } from './dom.mjs';

/** `fn(target) => { title?, body?, lines?: [{text, tone?}] } | null`. */
const builders = new Map();

export function registerTip(id, fn) { builders.set(id, fn); }

function contentOf(target) {
  const id = target.dataset.tipId;
  if (id) {
    const fn = builders.get(id);
    return fn ? fn(target) : null;
  }
  const tip = target.dataset.tip;
  return tip ? { title: tip } : null;
}

function tipTargetOf(node) {
  return node?.closest?.('[data-tip], [data-tip-id]') || null;
}

/** `:focus-visible` may not exist on very old WebKit; treat that as "yes,
 * show" rather than throwing on an unsupported selector. */
function isFocusVisible(node) {
  try {
    return node.matches(':focus-visible');
  } catch {
    return true;
  }
}

export function createTooltip({ doc = document, timers = { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms), clearTimeout: (id) => globalThis.clearTimeout(id) } } = {}) {
  const el = doc.getElementById('tooltip');
  let target = null;
  let showTimer = null;
  let hideTimer = null;
  let lastHideAt = -Infinity;

  function clearTimers() {
    if (showTimer !== null) { timers.clearTimeout(showTimer); showTimer = null; }
    if (hideTimer !== null) { timers.clearTimeout(hideTimer); hideTimer = null; }
  }

  function render(content) {
    el.replaceChildren();
    if (content.title) el.append(h('div', { class: 'tip-title', text: content.title }));
    if (content.body) el.append(h('div', { class: 'tip-body', text: content.body }));
    for (const line of content.lines || []) {
      el.append(h('div', { class: `tip-line${line.tone ? ` tip-line--${line.tone}` : ''}`, text: line.text }));
    }
  }

  // Below the target, centered, §4.13's --tip-offset. Flips above when
  // there's no room, clamped 8px inside the viewport; a bottom-bar target
  // defaults to above.
  function place() {
    if (!target) return;
    const r = target.getBoundingClientRect();
    const offset = 6;
    const vw = doc.documentElement.clientWidth;
    const vh = doc.documentElement.clientHeight;
    el.style.left = '0px';
    el.style.top = '0px';
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const inBar = !!target.closest('.statusbar');
    let top = inBar ? r.top - th - offset : r.bottom + offset;
    let above = inBar;
    if (!inBar && top + th > vh - 8) { top = r.top - th - offset; above = true; }
    if (inBar && top < 8) { top = r.bottom + offset; above = false; }
    top = Math.max(8, Math.min(top, vh - th - 8));
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, vw - tw - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.classList.toggle('tip--above', above);
  }

  function show(t) {
    const content = contentOf(t);
    if (!content) return;
    clearTimers();
    target = t;
    render(content);
    el.classList.add('is-visible');
    place();
    target.setAttribute('aria-describedby', 'tooltip');
  }

  function hide() {
    clearTimers();
    if (target) target.removeAttribute('aria-describedby');
    target = null;
    el.classList.remove('is-visible');
    lastHideAt = Date.now();
  }

  function scheduleShow(t) {
    clearTimers();
    const warm = Date.now() - lastHideAt < 300; // §4.19: "warm" reopen shows immediately
    if (warm) { show(t); return; }
    showTimer = timers.setTimeout(() => show(t), 500);
  }

  function scheduleHide() {
    clearTimers();
    hideTimer = timers.setTimeout(hide, 100);
  }

  // The tooltip itself is hoverable (WCAG 1.4.13): moving the pointer onto
  // it (or back onto its own target) never counts as a "leave" — only
  // leaving *both* regions schedules a hide.
  function withinActive(node) {
    return !!node && (target?.contains(node) || el.contains(node));
  }
  doc.addEventListener('pointerover', (e) => {
    if (el.contains(e.target)) return;
    const t = tipTargetOf(e.target);
    if (!t || t === target) return;
    scheduleShow(t);
  });
  doc.addEventListener('pointerout', (e) => {
    if (!target) return;
    if (withinActive(e.target) && !withinActive(e.relatedTarget)) scheduleHide();
  });
  doc.addEventListener('focusin', (e) => {
    const t = tipTargetOf(e.target);
    if (!t) return;
    if (!isFocusVisible(t)) return; // a mouse click focusing a button isn't "keyboard focus"
    show(t);
  });
  doc.addEventListener('focusout', (e) => {
    const t = tipTargetOf(e.target);
    if (t && t === target) hide();
  });
  // Esc hides an open tooltip and is consumed only then; with none open it
  // keeps its normal meaning (other capture-phase Esc handlers still run).
  // A text field that has focus and isn't the tooltip's own target keeps
  // its Esc (e.g. cancelling a rename while a stale tooltip is still up
  // from a button whose focus was restored earlier); the tooltip still
  // closes.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !target) return;
    const t = e.target;
    const field = t instanceof Element && t.matches('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
    const own = field && target.contains(t);
    if (!field || own) e.stopPropagation();
    hide();
  }, true);

  return {
    hide,
    /** Re-renders the currently open tooltip's content (a `data-tip-id`
     * target whose backing data just changed, e.g. a live quota number). */
    refresh() { if (target) show(target); },
  };
}
