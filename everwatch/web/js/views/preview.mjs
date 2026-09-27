// Live preview pane (P-27): title (path · label · kind · STATE age), accent
// border (amber waiting / agent colour / chrome), monospace <pre> that
// sticks to the bottom and stays selectable, and a freshness footer. Used
// by split view and zoom. Screen text is set with textContent only.

import {
  h, icon, setText, attr, setRuns,
} from './dom.mjs';
import { previewTitle, freshnessText, screenBody, KIND_NAMES } from '../lib/format.mjs';
import { waitSummary } from '../lib/sparkline.mjs';
import { globalMatchSpan } from '../lib/search.mjs';
import { highlightRuns } from '../lib/fuzzy.mjs';
import { spark, updateSpark } from './spark.mjs';
import {
  badgeEl, updateBadge, projectName, chipTip, colorName,
} from './row.mjs';

// §4.6: sentence case, never a full amber fill ("Waiting 4m", "Busy").
const STATE_TEXT = { waiting: 'Waiting', busy: 'Busy', idle: 'Idle' };

export function accentOf(s) {
  if (!s) return 'plain';
  if (s.state === 'waiting') return 'waiting';
  return s.kind || 'plain';
}

export function createPreview({ onGoto, zoom = false, reply = null } = {}) {
  let projects = null;
  const name = h('h2', { class: 'preview-name' });
  const chip = h('span', { class: 'tab-dot preview-chip', 'aria-hidden': 'true' });
  const kindBadge = badgeEl();
  const pillGlyph = h('span', { class: 'glyph', 'aria-hidden': 'true' });
  const pillText = h('span', { class: 'state-pill-text' });
  const pill = h('span', { class: 'state-pill' }, pillGlyph, pillText);
  const meta = h('p', { class: 'preview-meta' });
  const rule = h('span', { class: 'rule-chip', hidden: true });
  // W-5 activity strip, made self-explanatory (a validator finding: it read
  // as unlabelled "noise"): a visible label, a tiny busy/waiting legend, and
  // idle/no-data segments rendered nearly transparent (app.css) so only the
  // two states anyone cares about actually stand out.
  const activityLabel = h('span', { class: 'preview-detail-label', text: 'Activity · last 60 min' });
  const legend = h('span', { class: 'preview-legend' },
    h('span', { class: 'preview-legend-item' }, h('span', { class: 'preview-legend-dot preview-legend-dot--busy' }), h('span', { text: 'Busy' })),
    h('span', { class: 'preview-legend-item' }, h('span', { class: 'preview-legend-dot preview-legend-dot--waiting' }), h('span', { text: 'Waiting' })));
  const detailSpark = spark('preview-spark');
  const detailText = h('span', { class: 'preview-detail-text' });
  const detail = h('p', { class: 'preview-detail', hidden: true }, activityLabel, detailSpark, legend, detailText);
  // D5 title case; the ↵ glyph at 70% opacity replaces the old kbd box.
  const go = h('button', {
    type: 'button', class: 'btn btn--primary preview-go', 'aria-label': 'Go to Session', 'data-tip': 'Go to this session in iTerm2  ⏎',
  }, h('span', { text: 'Go to Session' }), h('span', { class: 'preview-go-key', 'aria-hidden': 'true', text: '↵' }));
  go.addEventListener('click', () => onGoto?.(root.dataset.uid));
  const screen = h('pre', { class: 'screen', tabindex: '0' });
  const card = h('div', { class: 'title-card', hidden: true });
  const body = h('div', { class: 'preview-body' }, screen, card);
  const fresh = h('span', { class: 'freshness' });
  const hints = h('span', { class: 'preview-hints', text: zoom ? 'Esc to go back · ↑↓ to switch session' : 'Space to zoom' });
  const empty = h('div', { class: 'preview-empty', hidden: true },
    h('p', { class: 'preview-empty-title', text: 'Select a session' }),
    h('p', { class: 'preview-empty-hint', text: 'or press a for the one waiting longest' }));
  const head = h('header', { class: 'preview-head' },
    h('div', { class: 'preview-heading' }, h('div', { class: 'preview-title' }, chip, name, pill, kindBadge, rule), meta, detail),
    go);
  const foot = h('footer', { class: 'preview-foot' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), fresh,
    h('span', { class: 'spacer' }), hints);
  const root = h('section', { class: `preview${zoom ? ' preview--zoom' : ''}`, 'aria-label': 'Session preview' },
    head, body, reply?.el, foot, empty); // W-10 reply bar (views/reply.mjs) between screen and footer

  let lastUid = null;
  let lastText = null;
  let lastHlKey = '';

  function update({
    session: s, screen: text, now, snapshotAt, debugState, historyStats, searchHighlight, projects: proj,
  } = {}) {
    projects = proj || null;
    root.dataset.accent = accentOf(s);
    const has = !!s;
    head.hidden = !has;
    body.hidden = !has;
    foot.hidden = !has;
    empty.hidden = has;
    reply?.update({ session: s, screen: text });
    if (!has) {
      root.dataset.uid = '';
      lastUid = null;
      return;
    }
    root.dataset.uid = s.uid;
    updateBadge(kindBadge, s);
    const t = previewTitle(s, now);
    setText(name, s.display_name || s.name || t.parts[0]);
    attr(name, 'title', s.display_name || s.name || '');
    const metaParts = [...t.parts];
    if (!s.path) metaParts.shift(); // it's the name, already the heading
    // §4.6 meta: path · Claude Code · tab 1.1 · <Project name>
    const pname = s.tab_color && s.project ? projectName(projects, s.project) : '';
    const kindWord = KIND_NAMES[s.kind] || (s.is_self || s.is_dashboard ? '' : 'Plain shell');
    const parts = metaParts.filter((x) => x !== KIND_NAMES[s.kind]);
    setText(meta, [...parts, kindWord, `tab ${s.tab_label}`, pname || (s.tab_color ? colorName(s.tab_color) : '')].filter(Boolean).join(' · '));
    const cc = `tab-dot preview-chip tab-dot--${s.tab_color || 'none'}`;
    if (chip.className !== cc) chip.className = cc;
    chip.hidden = !s.tab_color;
    attr(chip, 'data-tip', s.tab_color ? chipTip(s, projects).replace(/ — click to change$/, '') : null);
    attr(meta, 'title', metaParts.join(' · '));
    if (t.state) {
      pill.hidden = false;
      pill.dataset.state = t.state;
      pillGlyph.className = `glyph glyph--${t.state}`;
      setText(pillText, `${STATE_TEXT[t.state]}${t.age ? ` ${t.age}` : ''}`);
    } else {
      pill.hidden = true;
    }
    rule.hidden = !(debugState && s.rule);
    setText(rule, s.rule ? `rule: ${s.rule}` : '');

    // W-5: 60-minute activity sparkline + "waited N× · Mm total today".
    updateSpark(detailSpark, s.spark);
    attr(detailSpark, 'data-tip', s.spark ? 'Activity over the last 60 minutes, one segment per minute. Green = busy, amber = waiting for you.' : null);
    const summary = waitSummary(historyStats);
    setText(detailText, summary);
    detail.hidden = !s.spark && !summary;

    // self / ultrawatch dashboard get a title card instead of a mirror (P-28)
    const cardKind = s.is_self ? 'self' : s.is_dashboard ? 'dashboard' : null;
    card.hidden = !cardKind;
    screen.hidden = !!cardKind;
    if (cardKind && card.dataset.kind !== cardKind) {
      card.dataset.kind = cardKind;
      card.replaceChildren(
        icon('logo', 'title-card-logo'),
        h('p', { class: 'title-card-name', text: cardKind === 'self' ? 'Everwatch' : 'ultrawatch dashboard' }),
        h('p', { class: 'title-card-body', text: cardKind === 'self'
          ? 'This tab is running Everwatch itself — no infinite mirrors here.'
          : 'This tab is running the ultrawatch terminal dashboard.' }),
      );
    }

    const body_ = screenBody(text ?? '');
    const switched = s.uid !== lastUid;
    // W-8: highlight the single screen-search match jumped to from the
    // palette, computed against this same trimmed body so offsets line up
    // with what search.mjs matched (views/palette.mjs searches the same
    // trimmed text — see buildScreens() there).
    const hl = searchHighlight && searchHighlight.uid === s.uid ? searchHighlight : null;
    const hlKey = hl ? `${hl.lineIndex}:${hl.matchStart}:${hl.matchEnd}` : '';
    if (switched || body_ !== lastText || hlKey !== lastHlKey) {
      const atBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 32;
      if (hl) {
        const { start, end } = globalMatchSpan(body_, hl.lineIndex, hl.matchStart, hl.matchEnd);
        const indexes = [];
        for (let i = start; i < end; i += 1) indexes.push(i);
        setRuns(screen, highlightRuns(body_, indexes), `${body_}|${hlKey}`);
      } else {
        screen.__runsKey = null; // force the next highlight to re-render, not skip as "unchanged"
        screen.textContent = body_ || '(no screen text yet)';
      }
      screen.classList.toggle('is-placeholder', !body_);
      attr(screen, 'aria-label', `Screen of ${s.display_name || s.name} (${KIND_NAMES[s.kind] || 'shell'})`);
      if (hl) queueMicrotask(() => screen.querySelector('mark')?.scrollIntoView({ block: 'center' }));
      else if (switched || atBottom) screen.scrollTop = screen.scrollHeight;
      lastText = body_;
      lastHlKey = hlKey;
    }
    lastUid = s.uid;

    const ft = freshnessText(now, snapshotAt);
    setText(fresh, ft);
    root.classList.toggle('is-live', ft.startsWith('live'));
  }

  return { el: root, update, screen };
}
