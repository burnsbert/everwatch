// Activity sparkline (W-5): turn a session's 12-char `spark` string
// (everwatch/history.py TransitionLog.spark — one char per 5-minute slot
// over the last 60 minutes, oldest first) into renderable segments, plus
// the "waited N× · Mm total today" detail line from an /api/history
// `stats` object. Pure; views/row.mjs, views/grid.mjs and views/preview.mjs
// render the DOM.

import { ageStr } from './format.mjs';

export const SPARK_SLOTS = 12;
export const SPARK_SLOT_SECONDS = 300;

/** spark char → state name (must match everwatch/history.py SPARK_CHARS). */
export const SPARK_STATES = Object.freeze({
  b: 'busy', w: 'waiting', i: 'idle', a: 'active', q: 'quiet',
});

/** One entry per slot, oldest first: `{index, state}` (`state` is null for
 * `-`, meaning the session wasn't observed in that slot). */
export function parseSpark(spark) {
  return [...String(spark || '')].map((ch, index) => ({ index, state: SPARK_STATES[ch] || null }));
}

/**
 * Compress consecutive equal-state slots into runs, oldest first, so a
 * view can render one element per run instead of one per slot. A run with
 * `state: null` means "not observed" for that stretch.
 */
export function sparkSegments(spark) {
  const out = [];
  for (const { state } of parseSpark(spark)) {
    const last = out[out.length - 1];
    if (last && last.state === state) last.count += 1;
    else out.push({ state, count: 1 });
  }
  return out;
}

/**
 * "waited 3× · 11m total today" from an `/api/history?uid=` response's
 * `stats` object (`{count, seconds}`); '' when the session never waited in
 * the window (nothing to show).
 */
export function waitSummary(stats) {
  if (!stats || !stats.count) return '';
  return `waited ${stats.count}× · ${ageStr(stats.seconds)} total today`;
}
