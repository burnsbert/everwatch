// Tokens Used strip (status bar, left), docs/design/VISUAL_SPEC.md §4.18 /
// T040, reworked per T046. Always visible — the user asked for a strip that
// can't be hidden, so there is no collapse control. Every quota the backend
// reports is shown with its severity (yellow ≥ 50, red ≥ 80, from the
// backend `level`) on its meter item, same as before. The toolbar's
// worst-state chip is gone entirely (user feedback: warnings belong at the
// bottom only) — every on-pace-to-run-out warning and every hit limit gets
// its *own* small chip instead, in `.tokens-alerts`, side by side, each
// opening Usage with the full-detail §4.18.2 tooltip on hover/focus.
// Full names ("Claude Code — 5-hour session limit") live in the §4.19
// tooltip and the accessible name, never "CC"/"CX".
//
// Width step-down (§4.18.4) is a fit loop, not fixed breakpoints: the bar
// gets `data-fit="0…6"` and each level hides one more thing until nothing
// overflows (0 full · 1 hints drop · 2 alert chips drop their label, icon +
// time/nothing only · 3 counts drop · 4 short labels + 24px meters · 5
// worst quota per provider + worst alert chip only, label "Tokens" · 6 no
// label). The kept-filter chip never drops.

import { h, icon, setText, attr, reconcile, classes } from './dom.mjs';
import { stripModel, paceHitAlerts, itemTip, itemLabel } from '../lib/tokens.mjs';
import { registerTip } from './tooltip.mjs';

export const FIT_LEVELS = 6;

function itemEl() {
  const full = h('span', { class: 'tok-full' });
  const short = h('span', { class: 'tok-short' });
  const fill = h('span', { class: 'tok-fill' });
  const pct = h('span', { class: 'tok-pct' });
  const dollars = h('span', { class: 'tok-dollars' });
  const el = h('button', { type: 'button', class: 'tok-item', 'data-tip-id': 'quota' },
    h('span', { class: 'tok-name' }, full, short),
    h('span', { class: 'tok-meter', 'aria-hidden': 'true' }, fill),
    pct, dollars);
  el.__p = {
    full, short, fill, pct, dollars,
  };
  return el;
}

function updateItem(el, item, worstId) {
  const p = el.__p;
  el.__item = item;
  el.dataset.id = item.id;
  el.dataset.state = item.state;
  el.dataset.level = item.level;
  classes(el, { 'is-hit': item.hit, 'is-worst': item.id === worstId });
  setText(p.full, item.full);
  setText(p.short, item.short);
  p.fill.style.setProperty('--pct', `${item.meter}%`);
  setText(p.pct, `${item.pct}%`);
  setText(p.dollars, item.dollars ? `· ${item.dollars}` : '');
  p.dollars.hidden = !item.dollars;
  attr(el, 'aria-label', `${itemLabel(item)}. Open Usage.`);
}

// One small pace/hit alert chip: an hourglass or a no-entry sign plus text
// that drops to icon-only (icon + time for pace) at narrow widths — see
// `.tok-alert-full`/`.tok-alert-short` in chrome.css.
function alertEl() {
  const pace = icon('hourglass', 'icon icon--sm tok-icon tok-icon--pace');
  const hit = icon('nosign', 'icon icon--sm tok-icon tok-icon--hit');
  const full = h('span', { class: 'tok-alert-full' });
  const short = h('span', { class: 'tok-alert-short' });
  const el = h('button', { type: 'button', class: 'tok-alert', 'data-tip-id': 'quota' }, pace, hit, full, short);
  el.__p = { pace, hit, full, short };
  return el;
}

function updateAlert(el, a, worstId) {
  const p = el.__p;
  el.__item = a.item;
  el.dataset.id = a.item.id;
  el.dataset.kind = a.kind;
  classes(el, { 'is-worst': a.item.id === worstId });
  p.pace.classList.toggle('is-shown', a.kind === 'pace');
  p.hit.classList.toggle('is-shown', a.kind === 'hit');
  setText(p.full, a.full);
  setText(p.short, a.short);
  p.short.hidden = !a.short;
  attr(el, 'aria-label', `${itemLabel(a.item)}. Open Usage.`);
}

function groupEl(p, run) {
  const name = h('span', { class: 'tok-provider-name', text: p.name });
  const word = h('span', { class: 'tok-provider-word', text: p.word });
  const head = h('span', { class: 'tok-provider', 'data-provider': p.key },
    icon(p.glyph, `icon icon--sm tok-glyph tok-glyph--${p.key}`), name, word);
  const items = h('span', { class: 'tok-items' });
  const note = h('span', { class: 'tok-note' });
  const warn = h('span', {
    class: 'tok-warn', tabindex: '0', role: 'img', hidden: true,
  }, icon('warn', 'icon icon--sm'));
  const el = h('div', { class: 'tok-group', 'data-provider': p.key, role: 'group', 'aria-label': p.name },
    head, items, note, warn);
  items.addEventListener('click', (e) => {
    const b = e.target.closest('.tok-item');
    if (!b) return;
    const id = b.dataset.id;
    run('usage.open');
    // §4.18.2: "opens Usage scrolled to that limit" — the page renders on
    // the next microtask; scroll once it's there.
    requestAnimationFrame(() => {
      const target = document.querySelector(`.usage-page .meter[data-limit-id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'center' });
    });
  });
  el.__p = {
    items, note, warn, head,
  };
  return el;
}

function updateGroup(el, g) {
  const p = el.__p;
  el.__group = g;
  el.dataset.status = g.status;
  const worstId = g.worst?.id || null;
  reconcile(p.items, g.items, (i) => i.id, itemEl, (it, item) => updateItem(it, item, worstId));
  setText(p.note, g.note);
  p.note.hidden = !g.note;
  p.warn.hidden = !g.warning;
  attr(p.warn, 'data-tip', g.warning || null);
  attr(p.warn, 'aria-label', g.warning || null);
}

export function createTokens({ run, doc = document }) {
  const bar = doc.getElementById('statusbar');
  const strip = doc.getElementById('tokens');
  const groupsEl = doc.getElementById('tokens-groups');
  const alertsEl = doc.getElementById('tokens-alerts');

  alertsEl.addEventListener('click', (e) => {
    const b = e.target.closest('.tok-alert');
    if (!b) return;
    const id = b.dataset.id;
    run('usage.open');
    requestAnimationFrame(() => {
      const target = document.querySelector(`.usage-page .meter[data-limit-id="${CSS.escape(id)}"]`);
      target?.scrollIntoView({ block: 'center' });
    });
  });

  // Tooltip builders (§4.19). A quota item's tooltip names the limit in
  // full; in the worst-per-provider form (fit ≥ 5) the one visible item
  // stands for its whole provider, so its tooltip lists every quota.
  registerTip('quota', (target) => {
    const item = target.__item;
    if (!item) return null;
    const fit = Number(bar.dataset.fit || 0);
    const group = target.closest('.tok-group')?.__group;
    if (fit >= 5 && group && group.items.length > 1) {
      return {
        title: `${group.name} — tokens used`,
        lines: group.items.map((i) => {
          const t = itemTip(i);
          return {
            text: `${t.title.replace(`${group.name} — `, '')}: ${[t.body, ...t.lines.map((l) => l.text)].join(' · ')}`,
            tone: i.hit || i.level === 'red' ? 'danger' : i.pace || i.level === 'yellow' ? 'warn' : undefined,
          };
        }),
      };
    }
    return itemTip(item);
  });

  // --- fit loop ---------------------------------------------------------
  let fitKey = '';
  function overflowing() {
    return bar.scrollWidth > bar.clientWidth + 1;
  }
  function fit() {
    let level = 0;
    bar.dataset.fit = '0';
    while (level < FIT_LEVELS && overflowing()) {
      level += 1;
      bar.dataset.fit = String(level);
    }
  }
  if (typeof ResizeObserver !== 'undefined') {
    let lastW = -1;
    new ResizeObserver(() => {
      const w = bar.clientWidth;
      if (w === lastW) return;
      lastW = w;
      fit();
    }).observe(bar);
  }

  return {
    update(m) {
      const groups = stripModel(m.usage, m.now, { showDollars: !!m.prefs?.show_dollars });
      reconcile(groupsEl, groups, (g) => g.key, (g) => groupEl(g, run), updateGroup);
      strip.dataset.worst = groups.some((g) => g.items.some((i) => i.state !== 'ok')) ? 'alert' : 'ok';

      // Pace/hit chips (T046): their own small chips, side by side, worst
      // (hit, else earliest run-out) first; only that worst one survives
      // the narrow-width worst-per-provider fit level (§4.18.4, chrome.css).
      const alerts = paceHitAlerts(groups);
      reconcile(alertsEl, alerts, (a) => a.id, alertEl, (el, a) => updateAlert(el, a, alerts[0]?.id));

      // Re-fit when what's in the bar changes (not every tick).
      const key = [
        bar.clientWidth, m.filter, m.filterEditing, m.context, m.prefs?.show_hints,
        ...groups.map((g) => `${g.status}:${g.items.map((i) => `${i.id}${i.state}${i.pct}${i.runOut}${i.dollars}`).join(',')}`),
        doc.getElementById('counts')?.textContent,
      ].join('|');
      if (key !== fitKey) {
        fitKey = key;
        fit();
      }
    },
    fit,
  };
}
