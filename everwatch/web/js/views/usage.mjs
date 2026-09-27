// Usage page (P-21 target, P-54–P-59): one meter per usage row from
// `State.usage` with severity colour, reset countdown, pace/projection
// text, an optional `$` dollar amount, and per-section status text for
// failing/stale/inactive providers. WP8 adds burn-down charts (W-6).
// Presentation: docs/design/VISUAL_SPEC.md §4.14 (cards, meters, charts)
// and §4.18 (severity, the pace marker, display names from lib/limits.mjs).

import { h, icon, reconcile, setText, attr } from './dom.mjs';
import { createPage } from './page.mjs';
import { ageStr, formatDollars } from '../lib/format.mjs';
import {
  linearScale, seriesFor, linePath, areaPath, nearestPoint, yTicks, hasChart, chartWindow,
  plotPoints, projectToReset, timeStyle, annotationLayout,
} from '../lib/chart.mjs';
import {
  limitName, limitTitle, quotaState, resetLine, projectionLine, sentenceCase, clockLabel,
} from '../lib/limits.mjs';

const SECTIONS = [['claude', 'Claude Code'], ['codex', 'Codex']];
const FAIL_TEXT = { claude: 'usage API fetch failed', codex: 'Codex usage fetch failed' };

// --- W-6 burn-down chart: hand-written SVG, no chart library -------------------
// The x-domain is the limit's own window — [reset − 5h/7d/month, reset] —
// so the right edge *is* the reset. Samples outside the window are
// dropped, the line ends at the meter's live value at "now", and the
// dashed projection stops at the reset (or at 100%, with a "hits 100% at
// …" tag matching the row's projection text). Math: lib/chart.mjs.
const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_W = 320;
const CHART_H = 96;
const PAD_Y = 6;
// §4.14: y ticks and horizontal gridlines only at 50% and 100%.
const CHART_PCTS = [50, 100];
let gradSeq = 0;

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** `Date.parse` an ISO reset time to epoch seconds, or null. */
function isoEpoch(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 1000 : null;
}

/** Toggle an SVG node: `.hidden` is an HTMLElement property, so SVG
 * nodes use the attribute (styled `display: none` in app.css). */
function svgHide(el, hide) {
  el.toggleAttribute('hidden', !!hide);
}

/** A vertical marker as a slim `<rect>`, not a `<line>`: a vertical
 * `<line>`'s bounding box has zero width in Chromium (stroke isn't
 * counted), which reads as "hidden" to Playwright even when drawn. */
function vRect(el, x, w) {
  el.setAttribute('x', (x - w / 2).toFixed(2));
  el.setAttribute('y', String(PAD_Y));
  el.setAttribute('height', String(CHART_H - 2 * PAD_Y));
}

function chartParts() {
  gradSeq += 1;
  const gradId = `chart-grad-${gradSeq}`;
  const grad = svgEl('linearGradient', {
    id: gradId, x1: '0', y1: '0', x2: '0', y2: '1',
  });
  grad.append(svgEl('stop', { class: 'chart-grad-stop1', offset: '0%' }),
    svgEl('stop', { class: 'chart-grad-stop2', offset: '100%' }));
  const defs = svgEl('defs');
  defs.append(grad);
  const svg = svgEl('svg', {
    class: 'meter-chart-svg', viewBox: `0 0 ${CHART_W} ${CHART_H}`, preserveAspectRatio: 'none',
  });
  const gridLines = CHART_PCTS.map(() => svgEl('rect', {
    class: 'chart-grid', x: '0', width: String(CHART_W), height: '1',
  }));
  const baseLine = svgEl('rect', {
    class: 'chart-base', x: '0', y: String(CHART_H - PAD_Y), width: String(CHART_W), height: '1',
  });
  const areaEl = svgEl('path', { class: 'chart-area', fill: `url(#${gradId})`, stroke: 'none' });
  const resetMark = svgEl('rect', { class: 'chart-reset', width: '1' });
  const historyPath = svgEl('path', { class: 'chart-line', fill: 'none' });
  const projPath = svgEl('path', { class: 'chart-line chart-line--proj', fill: 'none' });
  // Dots are HTML, positioned in % over the plot: the SVG stretches
  // (preserveAspectRatio="none"), which would squash a <circle> into an oval.
  const liveDot = h('span', { class: 'chart-dot chart-dot--live', hidden: true });
  const hitDot = h('span', { class: 'chart-dot chart-dot--hit', hidden: true });
  const hoverDot = h('span', { class: 'chart-dot chart-dot--hover', hidden: true });
  // "Now" is an HTML hairline too: a dashed rule (§4.14) can't be drawn
  // with the fill-only <rect>s the SVG uses for its vertical marks.
  const nowLine = h('span', { class: 'chart-now', hidden: true });
  const svgDots = h('div', { class: 'chart-dots', 'aria-hidden': 'true' }, nowLine, liveDot, hitDot, hoverDot);
  const hoverRect = svgEl('rect', {
    class: 'chart-hover-rect', x: '0', y: '0', width: String(CHART_W), height: String(CHART_H), fill: 'transparent',
  });
  svg.append(defs, ...gridLines, baseLine, areaEl, historyPath, projPath, resetMark, hoverRect);
  const nowTag = h('span', { class: 'chart-tag chart-tag--now', text: 'Now' });
  // The on-pace-to-run-out marker (§4.18.2): an hourglass plus a time, a
  // different kind of mark than the severity colour.
  const hitText = h('span', { class: 'chart-tag-text' });
  const hitTag = h('span', { class: 'chart-tag chart-tag--hit', hidden: true }, icon('hourglass', 'icon icon--xs'), hitText);
  const annot = h('div', { class: 'chart-annot', 'aria-hidden': 'true' }, nowTag, hitTag);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const plot = h('div', { class: 'chart-plot' }, annot, svg, svgDots, tip);
  const yLabels = CHART_PCTS.map(() => h('span', { class: 'chart-ytick' }));
  const yaxis = h('div', { class: 'chart-yaxis', 'aria-hidden': 'true' }, ...yLabels);
  const body = h('div', { class: 'chart-body' }, yaxis, plot);
  const xStart = h('span', { class: 'chart-xtick chart-xtick--start' });
  const xReset = h('span', { class: 'chart-xtick chart-xtick--reset' });
  const xaxis = h('div', { class: 'chart-xaxis', 'aria-hidden': 'true' }, xStart, xReset);
  const empty = h('p', { class: 'chart-empty', hidden: true, text: 'Collecting data — the chart fills in over the next few minutes' });
  const wrap = h('div', { class: 'meter-chart', 'aria-hidden': 'true' }, body, xaxis, empty);
  const parts = {
    wrap, svg, plot, body, xaxis, tip, empty, gridLines, yLabels, areaEl,
    nowLine, resetMark, historyPath, projPath, liveDot, hitDot, hoverDot, hoverRect,
    nowTag, hitTag, hitText, xStart, xReset, points: [], x: null, y: null, style: 'time',
  };
  const place = (el, t, pct) => {
    el.style.left = `${((parts.x(t) / CHART_W) * 100).toFixed(2)}%`;
    el.style.top = `${((parts.y(pct) / CHART_H) * 100).toFixed(2)}%`;
  };
  parts.place = place;
  hoverRect.addEventListener('pointermove', (e) => {
    if (parts.points.length < 2) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const pt = nearestPoint(parts.points, parts.win.start + frac * (parts.win.end - parts.win.start));
    if (!pt) return;
    place(hoverDot, pt.t, pt.pct);
    hoverDot.hidden = false;
    setText(tip, `${Math.round(pt.pct)}% · ${clockLabel(pt.t, parts.style === 'time' ? 'time' : 'day')}`);
    tip.hidden = false;
    tip.style.left = `${Math.max(0, Math.min(100, (parts.x(pt.t) / CHART_W) * 100))}%`;
  });
  hoverRect.addEventListener('pointerleave', () => { hoverDot.hidden = true; tip.hidden = true; });
  return parts;
}

function showEmpty(parts, isEmpty) {
  parts.body.hidden = isEmpty;
  parts.xaxis.hidden = isEmpty;
  parts.empty.hidden = !isEmpty;
}

/** Draw (or empty-state) one row's chart; `parts` keeps the latest scales
 * so the hover handler can reuse them. */
function updateChart(parts, row, samples, now) {
  parts.wrap.hidden = !hasChart(row.id);
  if (parts.wrap.hidden) return;
  const resetAt = isoEpoch(row.reset_at);
  const series = seriesFor(samples, row.id);
  const win = chartWindow({
    id: row.id, resetAt, series, now,
  });
  const points = plotPoints(series, win, { t: now, pct: row.pct });
  if (!win || points.length < 2) {
    showEmpty(parts, true);
    parts.points = [];
    return;
  }
  showEmpty(parts, false);
  const span = win.end - win.start;
  const style = timeStyle(span);
  const x = linearScale([win.start, win.end], [0, CHART_W]);
  const y = linearScale([0, 100], [CHART_H - PAD_Y, PAD_Y], true);
  Object.assign(parts, {
    points, x, y, win, style,
  });
  const frac = (t) => (t - win.start) / span;

  attr(parts.historyPath, 'd', linePath(points, x, y));
  attr(parts.areaEl, 'd', areaPath(points, x, y, CHART_H - PAD_Y));
  const last = points[points.length - 1];
  parts.place(parts.liveDot, last.t, last.pct);
  parts.liveDot.hidden = false;

  // pace projection, clipped at the reset (or ending where it hits 100%)
  const proj = projectToReset(points, win, now);
  svgHide(parts.projPath, !proj);
  parts.projPath.classList.toggle('is-hit', !!proj?.hits);
  if (proj) attr(parts.projPath, 'd', linePath([proj.from, proj.to], x, y));
  parts.hitDot.hidden = !proj?.hits;
  if (proj?.hits) parts.place(parts.hitDot, proj.to.t, 100);

  // now: a dashed hairline (§4.14: no shaded future region, no vertical grid)
  const nowIn = now >= win.start && now <= win.end;
  parts.nowLine.hidden = !nowIn;
  if (nowIn) parts.nowLine.style.left = `${((x(now) / CHART_W) * 100).toFixed(2)}%`;
  const resetIn = resetAt !== null && resetAt >= win.start && resetAt <= win.end;
  svgHide(parts.resetMark, !resetIn);
  if (resetIn) vRect(parts.resetMark, Math.min(x(resetAt), CHART_W - 0.5), 1);

  // gridlines + y-axis % labels (50/100)
  yTicks(y, CHART_PCTS).forEach((tick, i) => {
    parts.gridLines[i].setAttribute('y', tick.y.toFixed(2));
    setText(parts.yLabels[i], `${tick.pct}%`);
    parts.yLabels[i].style.top = `${((tick.y / CHART_H) * 100).toFixed(2)}%`;
  });

  // top-strip tags: "Now" and the run-out marker (§4.18.2: an hourglass
  // plus the time the dashed pace line reaches 100%)
  const hitText = proj?.hits ? clockLabel(proj.to.t, style) : '';
  const layout = annotationLayout({
    nowFrac: nowIn ? frac(now) : null,
    hitFrac: proj?.hits ? frac(proj.to.t) : null,
    hitText: hitText ? `${hitText}xx` : '', // + the 12px hourglass
    widthPx: parts.svg.getBoundingClientRect().width || 560,
  });
  parts.nowTag.hidden = !layout.now;
  if (layout.now) {
    parts.nowTag.dataset.align = layout.now.align;
    parts.nowTag.style.left = `${(layout.now.frac * 100).toFixed(2)}%`;
  }
  parts.hitTag.hidden = !layout.hit;
  if (layout.hit) {
    setText(parts.hitText, hitText);
    parts.hitTag.dataset.align = layout.hit.align;
    parts.hitTag.style.left = `${(layout.hit.frac * 100).toFixed(2)}%`;
  }

  // x axis: the window's start and its reset (the right edge). A 7-day
  // window starts on the same weekday and time it resets, so its start
  // reads as a date ("Sep 17") rather than a second "Thu 5:00am".
  setText(parts.xStart, clockLabel(win.start, style === 'day' ? 'date' : style));
  parts.xReset.hidden = !resetIn;
  if (resetIn) {
    setText(parts.xReset, `Resets ${clockLabel(resetAt, style)}`);
    parts.xReset.style.left = `${(frac(resetAt) * 100).toFixed(2)}%`;
    parts.xReset.classList.toggle('at-end', frac(resetAt) > 0.85);
  }
}

/** P-56: error/stale status line for a provider section. */
export function sectionStatusText(key, u, now) {
  const status = u?.status;
  if (status === 'no_token') return 'not connected';
  if (status === 'failing' || status === 'stale') {
    if (u.rows?.length && u.at) return `fetch failing — showing data from ${ageStr(now - u.at)} ago`;
    return FAIL_TEXT[key] || 'usage fetch failed';
  }
  return '';
}

function meter() {
  const label = h('span', { class: 'meter-label' });
  const pct = h('span', { class: 'meter-pct' });
  const dollars = h('span', { class: 'meter-dollars' });
  // §4.18.2 state icons, shown before the pct: hourglass = on pace to run
  // out, nosign = limit reached.
  const paceIcon = icon('hourglass', 'icon icon--sm meter-icon meter-icon--pace');
  const hitIcon = icon('nosign', 'icon icon--sm meter-icon meter-icon--hit');
  const fill = h('span', { class: 'meter-fill' });
  const reset = h('span', { class: 'meter-reset' });
  const proj = h('p', { class: 'meter-proj' });
  const chart = chartParts();
  const el = h('div', { class: 'meter', role: 'group' },
    h('div', { class: 'meter-top' }, label, h('span', { class: 'meter-nums' }, dollars, paceIcon, hitIcon, pct)),
    h('div', { class: 'meter-bar', role: 'presentation' }, fill),
    h('div', { class: 'meter-bottom' }, reset), proj, chart.wrap);
  el.__p = {
    label, pct, dollars, paceIcon, hitIcon, fill, reset, proj, chart,
  };
  return el;
}

function updateMeter(el, {
  r, showDollars, samples, now,
}) {
  const p = el.__p;
  const st = quotaState(r);
  el.dataset.level = r.level || 'green';
  el.dataset.limitId = r.id; // the Tokens Used strip scrolls here on click (§4.18.2)
  el.classList.toggle('is-hit', st.hit);
  el.classList.toggle('is-pace', st.pace);
  setText(p.label, limitName(r, 'page'));
  const pctText = `${Math.round(r.pct ?? 0)}%`;
  setText(p.pct, pctText);
  const dollarsText = showDollars && r.dollars != null ? formatDollars(r.dollars) : '';
  p.dollars.hidden = !dollarsText;
  setText(p.dollars, dollarsText);
  p.paceIcon.classList.toggle('is-shown', st.pace);
  p.hitIcon.classList.toggle('is-shown', st.hit);
  p.fill.style.setProperty('--pct', `${st.hit ? 100 : Math.max(0, Math.min(100, r.pct ?? 0))}%`);
  const resetText = resetLine(r, now);
  setText(p.reset, resetText);
  const projText = projectionLine(r, now);
  p.proj.hidden = !projText;
  p.proj.classList.toggle('is-hit', st.hit);
  setText(p.proj, projText);
  el.setAttribute('aria-label', [
    `${limitTitle(r)}: ${Math.round(r.pct ?? 0)} percent used`,
    dollarsText, resetText, projText,
  ].filter(Boolean).join(', '));
  updateChart(p.chart, r, samples, now);
}

export function createUsageView({ run }) {
  const sections = new Map();
  const body = h('div', { class: 'usage-sections' });
  const empty = h('p', { class: 'usage-empty', text: 'No Claude Code or Codex sessions running' });
  for (const [key, name] of SECTIONS) {
    const list = h('div', { class: 'meters' });
    const status = h('span', { class: 'usage-status' });
    const glyph = icon(key === 'claude' ? 'agent-claude' : 'agent-codex', `icon icon--sm usage-glyph usage-glyph--${key}`);
    const sec = h('section', { class: 'usage-section', 'aria-label': name },
      h('header', { class: 'usage-head' }, h('h3', {}, glyph, h('span', { text: name })), status), list);
    sections.set(key, { sec, list, status });
    body.append(sec);
  }
  const retry = h('button', { type: 'button', class: 'btn btn--small', text: 'Retry', onclick: () => run('session.refresh') });
  const foot = h('footer', { class: 'usage-foot' }, retry);
  const page = createPage({
    title: 'Usage', width: 'usage', extraClass: 'usage-page', run, backCommand: 'usage.close',
  });
  page.col.append(body, empty, foot);

  return {
    el: page.el,
    update(m) {
      const usage = m.usage || {};
      let any = false;
      let anyFailing = false;
      for (const [key] of SECTIONS) {
        const u = usage[key] || { status: 'inactive', rows: [] };
        const { sec, list, status } = sections.get(key);
        const rows = u.rows || [];
        const failText = sectionStatusText(key, u, m.now);
        sec.hidden = !rows.length && !failText;
        any = any || rows.length > 0;
        anyFailing = anyFailing || !!failText;
        // §4.14 card head: "Updated 2m ago", or the error in --danger
        setText(status, failText ? sentenceCase(failText)
          : (u.at ? `Updated ${ageStr(m.now - u.at)} ago` : ''));
        status.classList.toggle('is-error', !!failText);
        reconcile(list, rows, (r) => r.id,
          meter, (el, r) => updateMeter(el, {
            r, showDollars: !!m.prefs?.show_dollars, samples: m.usageHistorySamples, now: m.now,
          }));
      }
      empty.hidden = any || anyFailing;
      foot.hidden = !anyFailing;
    },
  };
}
