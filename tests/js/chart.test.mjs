import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linearScale, seriesFor, linePath, paceProjection, nearestPoint,
  GRID_PCTS, yTicks, areaPath, WINDOW_SECONDS, hasChart, monthStartBefore, limitWindow,
  chartWindow, plotPoints, projectToReset, timeStyle, clockText, minorTicks, annotationLayout,
} from '../../everwatch/web/js/lib/chart.mjs';

// # parity: W-6
test('linearScale maps a domain onto a range, optionally clamped', () => {
  const x = linearScale([0, 100], [0, 200]);
  assert.equal(x(0), 0);
  assert.equal(x(50), 100);
  assert.equal(x(100), 200);
  assert.equal(x(150), 300, 'unclamped extrapolates past the range');
  const y = linearScale([0, 100], [200, 0], true);
  assert.equal(y(0), 200);
  assert.equal(y(100), 0);
  assert.equal(y(150), 0, 'clamped stays in range');
  assert.equal(y(-50), 200);
  const flat = linearScale([5, 5], [0, 10]);
  assert.equal(flat(5), 0, 'degenerate domain does not divide by zero');
});

// # parity: W-6
test('seriesFor filters by id, sorts by time, drops malformed samples', () => {
  const samples = [
    { at: 30, id: 'cc.five_hour', pct: 60 },
    { at: 10, id: 'cc.five_hour', pct: 40 },
    { at: 20, id: 'cx.five_hour', pct: 10 },
    { at: 20, id: 'cc.five_hour', pct: 'nope' },
    null,
  ];
  assert.deepEqual(seriesFor(samples, 'cc.five_hour'), [{ t: 10, pct: 40 }, { t: 30, pct: 60 }]);
  assert.deepEqual(seriesFor(samples, 'cx.five_hour'), [{ t: 20, pct: 10 }]);
  assert.deepEqual(seriesFor(samples, 'nope'), []);
  assert.deepEqual(seriesFor(undefined, 'x'), []);
});

// # parity: W-6
test('linePath builds an SVG "M…L…" path through scaled points', () => {
  const x = linearScale([0, 10], [0, 100]);
  const y = linearScale([0, 100], [50, 0]);
  const points = [{ t: 0, pct: 0 }, { t: 5, pct: 50 }, { t: 10, pct: 100 }];
  assert.equal(linePath(points, x, y), 'M0.00,50.00 L50.00,25.00 L100.00,0.00');
  assert.equal(linePath([], x, y), '');
  assert.equal(linePath(undefined, x, y), '');
});

// # parity: W-6
test('paceProjection fits a line through recent points and projects to 100%', () => {
  // +2%/hour for the last 5 samples (3600s apart) starting at 50%
  const points = [0, 3600, 7200, 10800, 14400].map((t, i) => ({ t, pct: 50 + i * 2 }));
  const proj = paceProjection(points);
  assert.equal(proj.from.pct, 58);
  assert.equal(proj.to.pct, 100);
  assert.equal(proj.hits, true);
  assert.ok(proj.to.t > proj.from.t);
  // exact math: slope 2%/3600s from pct 58 at t=14400 to 100% is 21 more
  // points * 3600s = 75600s later
  assert.equal(Math.round(proj.to.t - proj.from.t), 75600);
});

test('paceProjection returns null for flat/falling/too-short/already-there series', () => {
  const flat = [{ t: 0, pct: 50 }, { t: 100, pct: 50 }];
  assert.equal(paceProjection(flat), null);
  const falling = [{ t: 0, pct: 80 }, { t: 100, pct: 60 }, { t: 200, pct: 40 }];
  assert.equal(paceProjection(falling), null);
  assert.equal(paceProjection([{ t: 0, pct: 10 }]), null);
  assert.equal(paceProjection([]), null);
  assert.equal(paceProjection(undefined), null);
  const done = [{ t: 0, pct: 90 }, { t: 100, pct: 100 }];
  assert.equal(paceProjection(done), null);
  const sameTime = [{ t: 5, pct: 10 }, { t: 5, pct: 20 }];
  assert.equal(paceProjection(sameTime), null);
});

test('paceProjection clips at the horizon when the pace is too slow to reach target', () => {
  const points = [{ t: 0, pct: 10 }, { t: 3600, pct: 10.1 }]; // 0.1%/hour
  const proj = paceProjection(points, { maxHorizonSeconds: 3600 * 24 });
  assert.ok(proj);
  assert.equal(proj.hits, false);
  assert.equal(proj.to.t, points[1].t + 3600 * 24);
  assert.ok(proj.to.pct < 100);
});

// # parity: W-6
test('nearestPoint finds the closest sample by time, for hover tooltips', () => {
  const points = [{ t: 0, pct: 1 }, { t: 10, pct: 2 }, { t: 30, pct: 3 }];
  assert.equal(nearestPoint(points, 9), points[1]);
  assert.equal(nearestPoint(points, -5), points[0]);
  assert.equal(nearestPoint(points, 100), points[2]);
  assert.equal(nearestPoint([], 5), null);
  assert.equal(nearestPoint(undefined, 5), null);
});

// # parity: W-6
test('yTicks maps the four gridline percentages through a y-scale', () => {
  const y = linearScale([0, 100], [140, 0], true);
  assert.deepEqual(GRID_PCTS, [25, 50, 75, 100]);
  assert.deepEqual(yTicks(y), [
    { pct: 25, y: 105 }, { pct: 50, y: 70 }, { pct: 75, y: 35 }, { pct: 100, y: 0 },
  ]);
  assert.deepEqual(yTicks(y, [0, 50]), [{ pct: 0, y: 140 }, { pct: 50, y: 70 }]);
});

// # parity: W-6
test('areaPath closes a filled region down to the baseline; empty below 2 points', () => {
  const x = linearScale([0, 10], [0, 100]);
  const y = linearScale([0, 100], [50, 0]);
  const points = [{ t: 0, pct: 0 }, { t: 10, pct: 100 }];
  assert.equal(areaPath(points, x, y, 50), 'M0.00,50.00 L100.00,0.00 L100.00,50.00 L0.00,50.00 Z');
  assert.equal(areaPath([points[0]], x, y, 50), '');
  assert.equal(areaPath([], x, y, 50), '');
  assert.equal(areaPath(undefined, x, y, 50), '');
});

// --- limit-window model: x-domain = [reset − window, reset] ------------------

const H = 3600;
const D = 86400;
const RESET = 1790008100; // an arbitrary reset instant (epoch s)

// # parity: W-6
test('limitWindow: a fixed-length limit spans exactly [reset − window, reset]', () => {
  assert.deepEqual(limitWindow('cc.five_hour', RESET), { start: RESET - 5 * H, end: RESET, windowed: true });
  assert.deepEqual(limitWindow('cx.five_hour', RESET), { start: RESET - 5 * H, end: RESET, windowed: true });
  for (const id of ['cc.seven_day', 'cc.seven_day_sonnet', 'cx.seven_day']) {
    assert.deepEqual(limitWindow(id, RESET), { start: RESET - 7 * D, end: RESET, windowed: true }, id);
  }
  assert.equal(limitWindow('cx.window1', RESET), null, 'unknown Codex window length → no fixed window');
  assert.equal(limitWindow('cc.five_hour', null), null, 'no reset → no window');
  assert.equal(limitWindow('cc.five_hour', NaN), null);
  assert.equal(limitWindow('cc.five_hour', Infinity), null);
  assert.ok(Object.isFrozen(WINDOW_SECONDS));
});

// # parity: W-6
test('limitWindow: the monthly limit spans the calendar month that ends at its reset', () => {
  const reset = new Date(2026, 9, 1).getTime() / 1000; // local Oct 1, the backend's next_month_start
  assert.equal(monthStartBefore(reset), new Date(2026, 8, 1).getTime() / 1000);
  assert.deepEqual(limitWindow('cc.monthly', reset), { start: new Date(2026, 8, 1).getTime() / 1000, end: reset, windowed: true });
  // January reset wraps back to December of the previous year
  const jan = new Date(2027, 0, 1).getTime() / 1000;
  assert.equal(monthStartBefore(jan), new Date(2026, 11, 1).getTime() / 1000);
});

test('hasChart: every limit row except uncapped extra usage', () => {
  assert.equal(hasChart('cc.five_hour'), true);
  assert.equal(hasChart('cc.monthly'), true);
  assert.equal(hasChart('cc.extra'), false);
});

// # parity: W-6
test('chartWindow: windowed rows use the limit window regardless of where samples or now sit', () => {
  const series = [{ t: RESET - 9 * H, pct: 90 }, { t: RESET - 1 * H, pct: 10 }];
  const win = chartWindow({ id: 'cc.five_hour', resetAt: RESET, series, now: RESET - 2 * H });
  assert.deepEqual(win, { start: RESET - 5 * H, end: RESET, windowed: true });
  // right edge is the reset, never "now" or the last sample
  assert.equal(win.end, RESET);
});

// # parity: W-6
test('chartWindow: fallback for unknown windows spans the samples, stretched to now and a future reset', () => {
  const series = [{ t: 1000, pct: 5 }, { t: 2000, pct: 9 }];
  assert.deepEqual(chartWindow({ id: 'cx.window1', resetAt: null, series, now: 2500 }), { start: 1000, end: 2500, windowed: false });
  assert.deepEqual(chartWindow({ id: 'cx.window1', resetAt: 9000, series, now: 2500 }), { start: 1000, end: 9000, windowed: false });
  assert.deepEqual(chartWindow({ id: 'cx.window1', resetAt: 1500, series, now: 1800 }), { start: 1000, end: 2000, windowed: false }, 'a past reset does not shrink the domain');
  assert.deepEqual(chartWindow({ id: 'cx.window1', resetAt: null, series }), { start: 1000, end: 2000, windowed: false }, 'no now → last sample');
  assert.deepEqual(chartWindow({ id: 'cx.window1', resetAt: null, series: [{ t: 7, pct: 1 }], now: 3 }), { start: 7, end: 8, windowed: false }, 'degenerate span is widened to 1s');
  assert.equal(chartWindow({ id: 'cx.window1', resetAt: null, series: [], now: 5 }), null);
  assert.equal(chartWindow({ id: 'cx.window1', resetAt: null, series: undefined, now: 5 }), null);
});

// # parity: W-6
test('plotPoints: drops samples from an earlier window and ends at the live value at now', () => {
  const win = { start: 100, end: 1000, windowed: true };
  const series = [{ t: 50, pct: 80 }, { t: 100, pct: 1 }, { t: 400, pct: 20 }, { t: 1001, pct: 3 }];
  assert.deepEqual(plotPoints(series, win, { t: 600, pct: 30 }),
    [{ t: 100, pct: 1 }, { t: 400, pct: 20 }, { t: 600, pct: 30 }]);
  assert.deepEqual(plotPoints(series, win, { t: 400, pct: 99 }), [{ t: 100, pct: 1 }, { t: 400, pct: 20 }], 'live not newer than last sample → not appended');
  assert.deepEqual(plotPoints(series, win, { t: 1200, pct: 30 }), [{ t: 100, pct: 1 }, { t: 400, pct: 20 }], 'live outside the window → not appended');
  assert.deepEqual(plotPoints(series, win, { t: 600, pct: null }), [{ t: 100, pct: 1 }, { t: 400, pct: 20 }]);
  assert.deepEqual(plotPoints(series, win, { t: 600, pct: NaN }), [{ t: 100, pct: 1 }, { t: 400, pct: 20 }]);
  assert.deepEqual(plotPoints(series, win, null), [{ t: 100, pct: 1 }, { t: 400, pct: 20 }]);
  assert.deepEqual(plotPoints([], win, { t: 600, pct: 30 }), [{ t: 600, pct: 30 }], 'live alone still plots');
  assert.deepEqual(plotPoints(undefined, win, null), []);
  assert.deepEqual(plotPoints(series, null, { t: 600, pct: 30 }), []);
});

// # parity: W-6, P-55
test('projectToReset: on pace to hit 100% before reset → the line ends exactly at the 100% hit point', () => {
  // 5h window; 2h in, 60% used → 30%/h average → 100% another 80 min later,
  // well before the reset 3h out. Same model as engine/projection.py.
  const win = limitWindow('cc.five_hour', RESET);
  const now = win.start + 2 * H;
  const points = [{ t: win.start + H, pct: 20 }, { t: now, pct: 60 }];
  const proj = projectToReset(points, win, now);
  assert.equal(proj.hits, true);
  assert.deepEqual(proj.from, { t: now, pct: 60 });
  assert.equal(proj.to.pct, 100);
  assert.ok(Math.abs(proj.to.t - (now + (40 / 60) * 2 * H)) < 1e-6);
  assert.ok(proj.to.t < win.end, 'hit point comes before the reset');
});

// # parity: W-6, P-55
test('projectToReset: too slow to hit 100% → the line is clipped at the reset, at the pace\'s value there', () => {
  const win = limitWindow('cc.five_hour', RESET);
  const now = win.start + 2 * H;
  const points = [{ t: win.start + H, pct: 5 }, { t: now, pct: 20 }]; // 10%/h
  const proj = projectToReset(points, win, now);
  assert.equal(proj.hits, false);
  assert.equal(proj.to.t, win.end, 'clipped exactly at reset');
  assert.ok(Math.abs(proj.to.pct - 50) < 1e-9, '20% + 10%/h × 3h');
  // exactly on the boundary: hit time == reset counts as a hit at the reset
  const edge = projectToReset([{ t: now, pct: 40 }], win, now); // 20%/h → 100% at reset
  assert.equal(edge.hits, true);
  assert.equal(edge.to.t, win.end);
});

test('projectToReset: null when already at 100%, reset passed, nothing used, or no data', () => {
  const win = limitWindow('cc.five_hour', RESET);
  const mid = win.start + 2 * H;
  assert.equal(projectToReset([{ t: mid, pct: 100 }], win, mid), null, 'already hit');
  assert.equal(projectToReset([{ t: win.end, pct: 40 }], win), null, 'latest point at reset');
  assert.equal(projectToReset([{ t: mid, pct: 40 }], win, win.end + 60), null, 'now is past reset (stale window)');
  assert.equal(projectToReset([{ t: mid, pct: 0 }], win, mid), null, 'nothing used → no pace');
  assert.equal(projectToReset([{ t: win.start, pct: 5 }], win, win.start), null, 'no time elapsed');
  assert.equal(projectToReset([], win), null);
  assert.equal(projectToReset(undefined, win), null);
  assert.equal(projectToReset([{ t: mid, pct: 40 }], null), null);
});

// # parity: W-6
test('projectToReset: fallback windows use a least-squares fit, clipped at the domain end', () => {
  const win = { start: 0, end: 10 * H, windowed: false };
  // +10%/h: from 30% at 2h → 100% at 9h, inside the domain
  const rising = [0, H, 2 * H].map((t, i) => ({ t, pct: 10 + i * 10 }));
  const hit = projectToReset(rising, win);
  assert.equal(hit.hits, true);
  assert.equal(hit.to.pct, 100);
  assert.ok(Math.abs(hit.to.t - 9 * H) < 1e-6);
  // +1%/h never reaches 100% by the end → clipped at the end
  const slow = [0, H, 2 * H].map((t, i) => ({ t, pct: 10 + i }));
  const clipped = projectToReset(slow, win);
  assert.equal(clipped.hits, false);
  assert.equal(clipped.to.t, 10 * H);
  assert.ok(Math.abs(clipped.to.pct - 20) < 1e-6);
  assert.equal(projectToReset([{ t: 0, pct: 50 }, { t: H, pct: 40 }], win), null, 'falling pace');
});

test('timeStyle / clockText: labels read like the row text (time, weekday+time, month day)', () => {
  assert.equal(timeStyle(5 * H), 'time');
  assert.equal(timeStyle(26 * H), 'time');
  assert.equal(timeStyle(7 * D), 'day');
  assert.equal(timeStyle(30 * D), 'date');
  const t = new Date(2026, 8, 24, 5, 0).getTime() / 1000; // Thu Sep 24, 5:00am local
  assert.equal(clockText(t), '5:00am');
  assert.equal(clockText(t, 'day'), 'Thu 5:00am');
  assert.equal(clockText(t, 'date'), 'Sep 24');
  assert.equal(clockText(new Date(2026, 8, 24, 0, 7).getTime() / 1000), '12:07am');
  assert.equal(clockText(new Date(2026, 8, 24, 12, 30).getTime() / 1000), '12:30pm');
  assert.equal(clockText(new Date(2026, 8, 24, 23, 59).getTime() / 1000), '11:59pm');
});

test('minorTicks: hourly guides for a 5h window, midnights for a week, none for a month', () => {
  const start = new Date(2026, 8, 21, 9, 30).getTime() / 1000;
  const five = minorTicks({ start, end: start + 5 * H });
  assert.deepEqual(five.map((t) => new Date(t * 1000).getHours()), [10, 11, 12, 13, 14]);
  assert.ok(five.every((t) => new Date(t * 1000).getMinutes() === 0));
  const week = minorTicks({ start, end: start + 7 * D });
  assert.equal(week.length, 7);
  assert.ok(week.every((t) => new Date(t * 1000).getHours() === 0 && t > start && t < start + 7 * D));
  assert.deepEqual(minorTicks({ start, end: start + 30 * D }), []);
  assert.deepEqual(minorTicks(null), []);
  assert.equal(minorTicks({ start, end: start + 26 * H }, 3).length, 3, 'capped at max');
  // a guide exactly on the window start is not drawn (it's the axis edge)
  const onHour = new Date(2026, 8, 21, 9, 0).getTime() / 1000;
  assert.equal(minorTicks({ start: onHour, end: onHour + 2 * H })[0], onHour + H);
});

// # parity: W-6
test('annotationLayout: a labeled "now" tag centred on the now line, pinned near the edges', () => {
  assert.deepEqual(annotationLayout({ nowFrac: 0.5, widthPx: 400 }).now, { frac: 0.5, align: 'center' });
  assert.deepEqual(annotationLayout({ nowFrac: 0.01, widthPx: 400 }).now, { frac: 0.01, align: 'start' });
  assert.deepEqual(annotationLayout({ nowFrac: 0.99, widthPx: 400 }).now, { frac: 0.99, align: 'end' });
  assert.equal(annotationLayout({ nowFrac: null }).now, null, 'now outside the window → no tag');
  assert.equal(annotationLayout({ nowFrac: 1.2 }).now, null);
  assert.equal(annotationLayout({ nowFrac: -0.1 }).now, null);
});

// # parity: W-6
test('annotationLayout: the "hits 100%" tag goes right of its dot, else left, else is dropped', () => {
  const hitText = 'hits 100% at 11:54am';
  assert.deepEqual(annotationLayout({ nowFrac: 0.3, hitFrac: 0.5, hitText, widthPx: 600 }).hit, { frac: 0.5, align: 'start' });
  assert.deepEqual(annotationLayout({ nowFrac: 0.3, hitFrac: 0.95, hitText, widthPx: 600 }).hit, { frac: 0.95, align: 'end' }, 'no room on the right');
  assert.equal(annotationLayout({ nowFrac: 0.62, hitFrac: 0.7, hitText, widthPx: 300 }).hit, null, 'collides with now on both sides');
  assert.deepEqual(annotationLayout({ hitFrac: 0.5, hitText, widthPx: 600 }).hit, { frac: 0.5, align: 'start' }, 'no now tag to avoid');
  assert.equal(annotationLayout({ nowFrac: 0.3, hitFrac: 0.5, hitText: '', widthPx: 600 }).hit, null);
  assert.equal(annotationLayout({ nowFrac: 0.3, hitFrac: null, hitText, widthPx: 600 }).hit, null);
  assert.deepEqual(annotationLayout({ widthPx: 0 }), { now: null, hit: null });
});
