// Tiny inline activity sparkline (W-5): one <span> per run of consecutive
// equal-state slots (lib/sparkline.sparkSegments), sized by flex-grow so it
// reads as a compact bar with no SVG/canvas. Shared by row.mjs, grid.mjs
// and preview.mjs; sizing is a CSS modifier class (`.row-spark`,
// `.tile-spark`, `.preview-spark`).

import { h, attr } from './dom.mjs';
import { sparkSegments, SPARK_SLOT_SECONDS } from '../lib/sparkline.mjs';

const SEG_LABELS = {
  busy: 'busy', waiting: 'waiting for input', idle: 'idle', active: 'producing output', quiet: 'quiet',
};

/** Build a `.spark` element (call `updateSpark` to fill it in). */
export function spark(modifier = '') {
  return h('span', { class: `spark${modifier ? ` ${modifier}` : ''}`, role: 'img', 'aria-hidden': 'true' });
}

/** Refresh a `.spark` element's segments; a no-op when the string is
 * unchanged (keyed, so it doesn't rebuild every render). Each segment gets
 * a cheap `title` tooltip naming its state and rough duration, since a bar
 * of solid color otherwise means nothing without hovering the whole strip. */
export function updateSpark(el, sparkString) {
  const key = sparkString || '';
  if (el.__sparkKey === key) return;
  el.__sparkKey = key;
  const segs = sparkSegments(key);
  el.replaceChildren(...segs.map((seg) => {
    const bar = h('span', { class: `spark-seg spark-seg--${seg.state || 'none'}` });
    bar.style.flexGrow = String(seg.count);
    const minutes = (seg.count * SPARK_SLOT_SECONDS) / 60;
    const label = seg.state ? SEG_LABELS[seg.state] || seg.state : 'no data';
    attr(bar, 'title', `${label} · ~${minutes}m`);
    return bar;
  }));
  el.hidden = !segs.length;
}
