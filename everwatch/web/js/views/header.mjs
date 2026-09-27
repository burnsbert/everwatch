// Toolbar (P-19, P-20, P-21, VISUAL_SPEC §4.2): brand (browser mode only —
// D3 moved the `N tabs · N agents` counts to the status bar), amber
// waiting pill (click → next waiting), status chip with explanation
// popover + Diagnose, the token alert chip (views/tokens.mjs fills it;
// click → Usage), filter field with live `N of M`, sort select, the "AI
// sessions only" toggle (`agents_only`), view segmented control, refresh /
// new tab / help buttons. The projects toggle (P-61) moved out of the
// toolbar in v0.2.2 — it's now the accordion handle/rail in
// views/projects.mjs, pinned where the projects column lives.

import { setText, attr } from './dom.mjs';
import { statusChip } from '../lib/format.mjs';
import { shortcutFor } from '../keymap.mjs';
import { normalizeTheme, THEME_LABELS } from '../lib/theme.mjs';
// §4.19: this is the app's one tooltip mount point. Every other view just
// adds `data-tip`/`data-tip-id` to its own markup — header.mjs is always
// created first (main.mjs), so instantiating it here (a side effect of
// this factory, not of the module) reaches the whole document without
// main.mjs having to know this module exists.
import { createTooltip } from './tooltip.mjs';

export function createHeader({ run, doc = document }) {
  createTooltip({ doc });
  const $ = (id) => doc.getElementById(id);
  const pill = $('waiting-pill');
  const pillText = $('waiting-pill-text');
  const chip = $('status-chip');
  const chipText = $('status-text');
  const pop = $('status-pop');
  const popTitle = $('status-pop-title');
  const popBody = $('status-pop-body');
  const filter = $('filter');
  const filterCount = $('filter-count');
  const filterKbd = $('filter-kbd');
  const sort = $('sort-select');
  const views = [...$('view-switch').querySelectorAll('button[data-view]')];
  const btnAgents = $('btn-agents');
  const btnTheme = $('btn-theme');
  const btnThemeIcon = btnTheme.querySelector('use');

  // §4.9: anchored under the chip — CSS can't assume anchor positioning at
  // the WKWebView baseline, so JS computes `left` from the chip's own
  // rect, clamped inside the viewport (the popover's fixed 280px width
  // matches overlays.css`.status-pop`).
  function positionStatusPop() {
    const r = chip.getBoundingClientRect();
    const vw = doc.documentElement.clientWidth;
    const w = pop.offsetWidth || 280;
    pop.style.left = `${Math.max(8, Math.min(r.left, vw - w - 8))}px`;
  }
  // The popover attribute needs Safari 17+; older WKWebViews would render
  // the panel inline, so fall back to a hidden-attribute toggle there.
  if (!('popover' in HTMLElement.prototype)) {
    pop.removeAttribute('popover');
    chip.removeAttribute('popovertarget');
    pop.hidden = true;
    pop.hidePopover = () => { pop.hidden = true; };
    chip.addEventListener('click', () => {
      pop.hidden = !pop.hidden;
      if (!pop.hidden) positionStatusPop();
    });
  } else {
    pop.addEventListener('toggle', (e) => { if (e.newState === 'open') positionStatusPop(); });
  }

  pill.addEventListener('click', () => run('waiting.next'));
  $('status-diagnose').addEventListener('click', () => {
    pop.hidePopover?.();
    run('diagnose.open');
  });
  btnAgents.addEventListener('click', () => run('agents.toggle'));
  btnTheme.addEventListener('click', () => run('theme.cycle'));
  $('btn-refresh').addEventListener('click', () => run('session.refresh'));
  $('btn-new').addEventListener('click', () => run('tab.new'));
  $('btn-settings').addEventListener('click', () => run('settings.open'));
  $('btn-help').addEventListener('click', () => run('help.open'));
  sort.addEventListener('change', () => {
    run('sort.set', { sort: sort.value });
    sort.blur();
  });
  for (const b of views) b.addEventListener('click', () => run(`view.${b.dataset.view}`));

  filter.addEventListener('input', () => run('filter.set', { text: filter.value }));
  filter.addEventListener('focus', () => run('filter.focus'));
  filter.addEventListener('blur', () => {
    // leaving the field keeps the text (like ⏎); Esc already cleared it
    run('filter.keep');
  });

  return {
    focusFilter() {
      if (doc.activeElement !== filter) filter.focus();
      filter.select();
    },
    blurFilter() {
      if (doc.activeElement === filter) filter.blur();
    },
    update(m) {
      const c = m.server?.counts || { tabs: 0, agents: 0, waiting: 0 };
      pill.hidden = !c.waiting;
      setText(pillText, `${c.waiting} waiting`);
      const pillLabel = `${c.waiting} waiting — jump to next waiting session`;
      attr(pill, 'aria-label', pillLabel);
      attr(pill, 'data-tip', c.waiting ? `${pillLabel}  ${shortcutFor('waiting.next')}` : null);

      const st = statusChip(m.server?.iterm, m.now, m.config.snapshotInterval, m.conn);
      chip.dataset.level = st.level;
      setText(chipText, st.text);
      // §4.2: the status text never shrinks; below 820px only the dot
      // shows, so the words live in the tooltip and the accessible name.
      attr(chip, 'title', `${st.tip} Click for details.`);
      attr(chip, 'aria-label', `Status: ${st.text}. ${st.tip}`);
      setText(popTitle, st.text);
      setText(popBody, st.tip);

      if (filter.value !== m.filter && doc.activeElement !== filter) filter.value = m.filter;
      if (filter.value !== m.filter && !m.filterEditing) filter.value = m.filter;
      setText(filterCount, m.filter ? `${m.rows.length} of ${m.total}` : '');
      filterKbd.hidden = !!m.filter || m.filterEditing;
      filter.closest('.search').classList.toggle('is-active', !!m.filter);

      if (sort.value !== m.prefs.sort) sort.value = m.prefs.sort;
      for (const b of views) attr(b, 'aria-checked', b.dataset.view === m.prefs.view ? 'true' : 'false');

      // AI sessions only ↔ All sessions. Pressed = only Claude Code and
      // Codex sessions are listed; the tooltip says what a click does.
      const agentsOnly = !!m.prefs.agents_only;
      attr(btnAgents, 'aria-pressed', agentsOnly ? 'true' : 'false');
      const agentsLabel = agentsOnly ? 'Show all sessions' : 'Show Claude Code and Codex sessions only';
      attr(btnAgents, 'aria-label', agentsLabel);
      attr(btnAgents, 'data-tip', `${agentsOnly
        ? 'Showing Claude Code and Codex sessions — click for all iTerm2 sessions, including plain shells'
        : 'Showing all iTerm2 sessions, including plain shells — click for Claude Code and Codex sessions'}  ${shortcutFor('agents.toggle')}`);

      // The icon names the destination. System appearance stays selectable
      // from Settings; the toolbar button switches to an explicit theme.
      const theme = normalizeTheme(m.prefs.theme);
      const showingDark = theme === 'dark' || (theme === 'system' && doc.documentElement.dataset.resolvedTheme === 'dark');
      const target = showingDark ? 'Light' : 'Dark';
      attr(btnThemeIcon, 'href', `#i-theme-${showingDark ? 'sun' : 'moon'}`);
      attr(btnTheme, 'aria-label', `Switch to ${target} mode`);
      attr(btnTheme, 'data-tip', `Switch to ${target} mode (currently ${THEME_LABELS[theme]})  ${shortcutFor('theme.cycle')}`);
    },
  };
}
