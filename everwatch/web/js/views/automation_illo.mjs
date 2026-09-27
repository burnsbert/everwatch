// Inline SVG illustration of the one switch the user has to turn on:
// System Settings → Privacy & Security → Automation → Everwatch → iTerm2.
// Used by the onboarding wizard's "permission turned off" state. Built with
// createElementNS (never innerHTML, dom.mjs's rule) and themed entirely by
// settings.css classes over tokens.css colors, so it follows dark/light.

const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, text = null) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (text !== null) n.textContent = text;
  return n;
}

/** `<svg class="ob-illo">` showing the Everwatch → iTerm2 switch, turned on. */
export function automationIllustration() {
  const svg = el('svg', {
    class: 'ob-illo',
    viewBox: '0 0 400 168',
    role: 'img',
    'aria-label': 'System Settings, Privacy & Security, Automation: under Everwatch, the iTerm2 switch is turned on',
  });
  svg.append(
    // the settings window
    el('rect', { class: 'ob-illo-panel', x: 0.5, y: 0.5, width: 399, height: 167, rx: 12 }),
    el('text', { class: 'ob-illo-crumb', x: 20, y: 25 }, 'Privacy & Security'),
    el('text', { class: 'ob-illo-title', x: 20, y: 45 }, 'Automation'),
    // the grouped list
    el('rect', { class: 'ob-illo-group', x: 16, y: 60, width: 368, height: 94, rx: 9 }),
    // row 1: Everwatch (the app being allowed)
    el('use', { href: '#i-logo', x: 30, y: 72, width: 24, height: 24 }),
    el('text', { class: 'ob-illo-app', x: 64, y: 89 }, 'Everwatch'),
    el('rect', { class: 'ob-illo-divider', x: 64, y: 106, width: 320, height: 1 }),
    // row 2: iTerm2 (what it may control) with its switch turned on
    el('rect', { class: 'ob-illo-iterm', x: 64, y: 119, width: 22, height: 22, rx: 5.5 }),
    el('path', { class: 'ob-illo-iterm-glyph', d: 'M69.5 125.5l4 3.5-4 3.5M75.5 134h5' }),
    el('text', { class: 'ob-illo-target', x: 96, y: 135 }, 'iTerm2'),
    el('rect', { class: 'ob-illo-ring', x: 324, y: 114, width: 52, height: 32, rx: 16 }),
    el('rect', { class: 'ob-illo-track', x: 331, y: 119.5, width: 38, height: 21, rx: 10.5 }),
    el('circle', { class: 'ob-illo-thumb', cx: 358.5, cy: 130, r: 8.5 }),
    // "turn this on" callout above the switch
    el('text', { class: 'ob-illo-hint', x: 350, y: 90, 'text-anchor': 'middle' }, 'Turn on'),
    el('path', { class: 'ob-illo-arrow', d: 'M350 96v12M346 104l4 4 4-4' }),
  );
  return svg;
}
