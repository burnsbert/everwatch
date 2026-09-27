// Usage burn-down chart math (W-6): pure scale/series/projection helpers
// for a hand-written SVG line, from `/api/usage/history` samples
// (`{at, id, pct}`). No chart library, no DOM — views/usage.mjs draws the
// `<svg>` and handles hover.

/**
 * Linear scale: domain `[d0,d1]` → range `[r0,r1]`. `clamp` restricts the
 * output to the range (used for the y axis; the x axis is left unclamped
 * so a projection line can run past "now").
 */
export function linearScale([d0, d1], [r0, r1], clamp = false) {
  const span = d1 - d0;
  return (v) => {
    const t = span === 0 ? 0 : (v - d0) / span;
    const ct = clamp ? Math.max(0, Math.min(1, t)) : t;
    return r0 + ct * (r1 - r0);
  };
}

/** This usage id's samples, sorted by time ascending: `[{t, pct}]`. */
export function seriesFor(samples, id) {
  return (samples || [])
    .filter((s) => s && s.id === id && typeof s.at === 'number' && typeof s.pct === 'number')
    .map((s) => ({ t: s.at, pct: s.pct }))
    .sort((a, b) => a.t - b.t);
}

/** SVG path `d` for a polyline through `{t,pct}` points, via scale fns. */
export function linePath(points, x, y) {
  if (!points || !points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)},${y(p.pct).toFixed(2)}`).join(' ');
}

/**
 * Least-squares pace projection from the last `windowPoints` samples to
 * `target` (default 100), the dashed line in P-55/W-6. `null` when there
 * are fewer than 2 points, the series is already at/over target, the pace
 * is flat or falling, or the fit is degenerate (all points at the same
 * time). `to.pct` is exactly `target` when the projection reaches it
 * within `maxHorizonSeconds`; otherwise the line is clipped at the
 * horizon and `hits` is `false`.
 */
export function paceProjection(points, { target = 100, windowPoints = 8, maxHorizonSeconds = 30 * 86400 } = {}) {
  if (!points || points.length < 2) return null;
  const pts = points.slice(-windowPoints);
  const n = pts.length;
  const meanT = pts.reduce((a, p) => a + p.t, 0) / n;
  const meanP = pts.reduce((a, p) => a + p.pct, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of pts) {
    num += (p.t - meanT) * (p.pct - meanP);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den; // pct per second
  if (slope <= 0) return null;
  const last = pts[pts.length - 1];
  if (last.pct >= target) return null;
  const horizon = last.t + maxHorizonSeconds;
  const hitT = last.t + (target - last.pct) / slope;
  if (hitT <= last.t) return null;
  const hits = hitT <= horizon;
  const to = hits
    ? { t: hitT, pct: target }
    : { t: horizon, pct: Math.min(target, last.pct + slope * maxHorizonSeconds) };
  return { from: { t: last.t, pct: last.pct }, to, hits };
}

/** The sample nearest time `t` (for a hover tooltip), or null when empty. */
export function nearestPoint(points, t) {
  if (!points || !points.length) return null;
  let best = points[0];
  let bestDist = Math.abs(points[0].t - t);
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestDist) { best = p; bestDist = d; }
  }
  return best;
}

/** The four horizontal gridlines/y-axis labels a burn-down chart draws
 * (W-6 polish): 25/50/75/100%, never 0 (the chart's own baseline). */
export const GRID_PCTS = [25, 50, 75, 100];

/** `[{pct, y}]` for `GRID_PCTS` (or a custom list) through a y-scale fn. */
export function yTicks(y, pcts = GRID_PCTS) {
  return pcts.map((pct) => ({ pct, y: y(pct) }));
}

/**
 * SVG path `d` for the filled area under `points`, closed down to
 * `baseY` (the chart's bottom edge) so it can be drawn with a soft
 * top-to-bottom gradient fill. `''` below 2 points, matching `linePath`.
 */
export function areaPath(points, x, y, baseY) {
  if (!points || points.length < 2) return '';
  const top = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(2)},${y(p.pct).toFixed(2)}`).join(' ');
  const last = points[points.length - 1];
  const first = points[0];
  return `${top} L${x(last.t).toFixed(2)},${baseY.toFixed(2)} L${x(first.t).toFixed(2)},${baseY.toFixed(2)} Z`;
}

// --- limit-window model (W-6) -------------------------------------------------
// A usage limit is a fixed window that ends at its reset: the chart's
// x-domain is exactly `[reset − window length, reset]`, samples outside it
// belong to an earlier window and are dropped, and the pace projection is
// the backend's own model (engine/projection.py): the average rate since
// the window started, extended from the latest point — so where the dashed
// line meets 100% is the same moment the row's "on pace to hit … at …"
// text names.

/** Window length (seconds) per usage-row id with a fixed-length window. */
export const WINDOW_SECONDS = Object.freeze({
  'cc.five_hour': 5 * 3600,
  'cx.five_hour': 5 * 3600,
  'cc.seven_day': 7 * 86400,
  'cc.seven_day_sonnet': 7 * 86400,
  'cx.seven_day': 7 * 86400,
});

/** Rows that never get a chart: uncapped extra usage has no window/limit. */
export function hasChart(id) {
  return id !== 'cc.extra';
}

/** Local-midnight start of the calendar month before `resetAt` (epoch s),
 * i.e. the start of the month whose end is `resetAt` (a month start). */
export function monthStartBefore(resetAt) {
  const d = new Date(resetAt * 1000);
  return new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime() / 1000;
}

/** `[start, end]` for a limit row with a known window, else `null`. */
export function limitWindow(id, resetAt) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt)) return null;
  if (WINDOW_SECONDS[id]) return { start: resetAt - WINDOW_SECONDS[id], end: resetAt, windowed: true };
  if (id === 'cc.monthly') return { start: monthStartBefore(resetAt), end: resetAt, windowed: true };
  return null;
}

/**
 * The chart's x-domain: the limit window when the row has one; otherwise
 * (an unknown Codex window, or no reset time) the span of the samples,
 * stretched to `now` and to a future reset. `null` with nothing to show.
 */
export function chartWindow({
  id, resetAt, series, now,
}) {
  const win = limitWindow(id, resetAt);
  if (win) return win;
  if (!series || !series.length) return null;
  const start = series[0].t;
  let end = Math.max(now ?? start, series[series.length - 1].t);
  if (typeof resetAt === 'number' && resetAt > end) end = resetAt;
  if (end <= start) end = start + 1;
  return { start, end, windowed: false };
}

/**
 * The points to plot: samples inside the window, plus the row's live value
 * at `now` (the meter's own number) when it's newer than the last sample,
 * so the line always ends where the meter says usage is right now.
 */
export function plotPoints(series, win, live) {
  if (!win) return [];
  const pts = (series || []).filter((p) => p.t >= win.start && p.t <= win.end);
  if (live && typeof live.pct === 'number' && Number.isFinite(live.pct)
    && typeof live.t === 'number' && live.t >= win.start && live.t <= win.end
    && (!pts.length || live.t > pts[pts.length - 1].t)) {
    pts.push({ t: live.t, pct: live.pct });
  }
  return pts;
}

/**
 * Dashed pace projection from the latest point, clipped to the window's
 * end (the reset). Windowed rows use the backend's average-since-window-
 * start rate; others fall back to a least-squares fit of recent samples.
 * `hits` means 100% is reached before reset, and `to` is that point;
 * otherwise `to` is where the pace leaves off at reset. `null` when
 * there's no upward pace, the limit is already hit, or reset has passed
 * (the latest point, or `now` when given, is at/after the window's end).
 */
export function projectToReset(points, win, now = null) {
  if (!points || !points.length || !win) return null;
  const last = points[points.length - 1];
  if (last.pct >= 100 || last.t >= win.end) return null;
  if (typeof now === 'number' && now >= win.end) return null;
  if (!win.windowed) {
    const proj = paceProjection(points, { maxHorizonSeconds: win.end - last.t });
    return proj ? { ...proj, to: { t: Math.min(proj.to.t, win.end), pct: proj.to.pct } } : null;
  }
  const elapsed = last.t - win.start;
  if (elapsed <= 0 || last.pct <= 0) return null;
  const rate = last.pct / elapsed; // pct per second, averaged over the window so far
  const hitT = last.t + (100 - last.pct) / rate;
  if (hitT <= win.end) return { from: { ...last }, to: { t: hitT, pct: 100 }, hits: true };
  return { from: { ...last }, to: { t: win.end, pct: last.pct + rate * (win.end - last.t) }, hits: false };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** How time labels read for a domain this long: `time` (≤ ~1 day),
 * `day` (≤ ~1 week, weekday + time), or `date` (month-long). */
export function timeStyle(spanSeconds) {
  if (spanSeconds <= 26 * 3600) return 'time';
  if (spanSeconds <= 8 * 86400) return 'day';
  return 'date';
}

/** Local time label in the backend's own style ("10:59am", "Thu 5:00am",
 * "Oct 1") so the chart reads like the row's reset/projection text. */
export function clockText(t, style = 'time') {
  const d = new Date(t * 1000);
  if (style === 'date') return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const hr = d.getHours();
  const time = `${hr % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}${hr < 12 ? 'am' : 'pm'}`;
  return style === 'day' ? `${DAYS[d.getDay()]} ${time}` : time;
}

/**
 * Faint vertical guides inside the window: every hour for a short window,
 * every local midnight for a week-long one, none for a month.
 */
export function minorTicks(win, max = 24) {
  if (!win) return [];
  const span = win.end - win.start;
  const style = timeStyle(span);
  const out = [];
  if (style === 'date') return out;
  const d = new Date(win.start * 1000);
  if (style === 'time') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  while (out.length < max) {
    if (style === 'time') d.setHours(d.getHours() + 1);
    else d.setDate(d.getDate() + 1);
    const t = d.getTime() / 1000;
    if (t >= win.end) break;
    if (t > win.start) out.push(t);
  }
  return out;
}

const CHAR_PX = 6.2; // ~11px UI font, per character
const LABEL_GAP = 6;

/**
 * Top-strip annotation layout: the "now" tag centred over the now line
 * (pinned to an edge when it's close to one) and the "hits 100% …" tag
 * beside the hit dot — to its right when it fits, else its left, and
 * dropped (the row's projection text already says it) when neither side
 * clears the "now" tag. Fractions are of the plot width `widthPx`.
 */
export function annotationLayout({
  nowFrac = null, hitFrac = null, hitText = '', nowText = 'now', widthPx = 560,
}) {
  const W = Math.max(1, widthPx);
  let now = null;
  let nowBox = null;
  if (nowFrac !== null && nowFrac >= 0 && nowFrac <= 1) {
    const w = nowText.length * CHAR_PX + 10;
    const x = nowFrac * W;
    let align = 'center';
    if (x < w / 2) align = 'start';
    else if (W - x < w / 2) align = 'end';
    const left = align === 'start' ? x : align === 'end' ? x - w : x - w / 2;
    now = { frac: nowFrac, align };
    nowBox = [left, left + w];
  }
  let hit = null;
  if (hitFrac !== null && hitFrac >= 0 && hitFrac <= 1 && hitText) {
    const w = hitText.length * CHAR_PX;
    const x = hitFrac * W;
    const clear = ([a, b]) => !nowBox || b + LABEL_GAP <= nowBox[0] || a >= nowBox[1] + LABEL_GAP;
    const right = [x + LABEL_GAP, x + LABEL_GAP + w];
    const left = [x - LABEL_GAP - w, x - LABEL_GAP];
    if (right[1] <= W && clear(right)) hit = { frac: hitFrac, align: 'start' };
    else if (left[0] >= 0 && clear(left)) hit = { frac: hitFrac, align: 'end' };
  }
  return { now, hit };
}
