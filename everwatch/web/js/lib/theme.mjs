// Theme resolution (§3.6) and WCAG contrast math used by the token test.
// `system` removes html[data-theme] and lets prefers-color-scheme decide.

export const THEMES = Object.freeze(['system', 'dark', 'light']);

/** Normalise a pref value; anything unknown means `system`. */
export function normalizeTheme(pref) {
  return THEMES.includes(pref) ? pref : 'system';
}

/** The palette actually shown for a pref, given the OS appearance. */
export function resolveTheme(pref, systemDark) {
  const p = normalizeTheme(pref);
  if (p === 'system') return systemDark ? 'dark' : 'light';
  return p;
}

/**
 * Apply a theme pref to <html>. Explicit dark/light set `data-theme`;
 * `system` removes it. `colorScheme` keeps form controls/scrollbars in sync.
 * Returns the resolved palette name.
 */
export function applyTheme(root, pref, systemDark) {
  const p = normalizeTheme(pref);
  if (p === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', p);
  const resolved = resolveTheme(p, systemDark);
  root.dataset.resolvedTheme = resolved;
  return resolved;
}

/** Human label for a theme pref (toolbar toggle tooltip, Settings). */
export const THEME_LABELS = Object.freeze({ system: 'Match System', light: 'Light', dark: 'Dark' });

/** The explicit palette opposite to the one currently shown. */
export function nextTheme(pref, systemDark = false) {
  return resolveTheme(pref, systemDark) === 'dark' ? 'light' : 'dark';
}

// --- contrast ---------------------------------------------------------------

/** '#rgb' / '#rrggbb' / 'rgb(r, g, b)' → [r, g, b] (0–255) or null. */
export function parseColor(value) {
  const v = String(value || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(v);
  if (m) return [m[1], m[2], m[3]].map(Number);
  return null;
}

function channel(c) {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an [r, g, b] triple. */
export function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two colours (any order), 1–21. */
export function contrastRatio(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) throw new Error(`unparseable colour: ${a} / ${b}`);
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every text-on-background token pairing the UI actually renders. The
 * contrast unit test checks each pair in both palettes against AA 4.5:1.
 * Retired names (docs/design/VISUAL_SPEC.md §3.7: --label, --row-fresh-bg,
 * --accent-claude, --badge-*-bg, …) are aliases in tokens.css and resolve to
 * their replacement; they stay listed while unmigrated rules still use them.
 */
export const CONTRAST_PAIRS = Object.freeze([
  // body text on every surface it appears on
  ['--fg', '--bg'], ['--fg', '--bg-chrome'], ['--fg', '--bg-pane'], ['--fg', '--bg-elev'], ['--fg', '--bg-term'],
  ['--fg', '--bg-hover'], ['--fg', '--bg-popover'],
  ['--fg-dim', '--bg'], ['--fg-dim', '--bg-chrome'], ['--fg-dim', '--bg-pane'], ['--fg-dim', '--bg-elev'],
  ['--fg-dim', '--bg-hover'], ['--fg-dim', '--bg-popover'], ['--fg-dim', '--bg-term'],
  ['--idle', '--bg'], ['--idle', '--bg-chrome'], ['--idle', '--bg-pane'], ['--idle', '--bg-elev'], ['--idle', '--bg-hover'],
  // selection (§4.3): text keeps its own token; --idle maps to --fg-dim there
  ['--fg', '--bg-selected'], ['--fg-dim', '--bg-selected'], ['--attention', '--bg-selected'], ['--busy', '--bg-selected'],
  ['--fg', '--bg-selected-inactive'], ['--fg-dim', '--bg-selected-inactive'],
  ['--attention', '--bg-selected-inactive'], ['--busy', '--bg-selected-inactive'],
  // waiting rows
  ['--fg', '--row-waiting-bg'], ['--fg-dim', '--row-waiting-bg'], ['--attention', '--row-waiting-bg'],
  // state colours used as text
  ['--attention', '--bg'], ['--attention', '--bg-chrome'], ['--attention', '--bg-pane'], ['--attention', '--bg-elev'],
  ['--busy', '--bg-chrome'], ['--busy', '--bg-pane'], ['--busy', '--bg-elev'], ['--busy', '--row-fresh-bg'],
  ['--danger', '--bg'], ['--danger', '--bg-chrome'], ['--danger', '--bg-elev'], ['--danger', '--bg-pane'],
  ['--danger', '--bg-popover'],
  // quota severity yellow (§4.18) wherever the strip, chip, cards and toasts sit
  ['--warn', '--bg'], ['--warn', '--bg-chrome'], ['--warn', '--bg-pane'], ['--warn', '--bg-elev'],
  ['--warn', '--bg-hover'], ['--warn', '--bg-popover'],
  // accent as text (links, Check Again, back button, plain buttons)
  ['--accent-fg', '--bg'], ['--accent-fg', '--bg-chrome'], ['--accent-fg', '--bg-pane'], ['--accent-fg', '--bg-elev'],
  ['--accent-fg', '--bg-hover'], ['--accent-fg', '--bg-popover'],
  ['--label', '--bg-pane'], ['--label', '--bg-hover'],
  ['--accent-claude', '--bg-pane'], ['--accent-codex', '--bg-pane'],
  ['--accent-claude', '--badge-claude-bg'], ['--accent-codex', '--badge-codex-bg'],
  // neutral badges (self / dashboard word badges, shortcut chips)
  ['--fg', '--badge-bg'], ['--fg-dim', '--badge-bg'], ['--busy', '--badge-bg'], ['--fg-dim', '--badge-plain-bg'],
  // stable per-agent badge colour (P-39 vs agent kind; distinct from tab
  // colors and state colors), always on its own opaque badge background
  ['--agent-claude', '--agent-claude-bg'], ['--agent-codex', '--agent-codex-bg'],
  // filled accents (primary/destructive buttons, pills, flash)
  ['--on-attention', '--attention-fill'], ['--flash-fg', '--flash-bg'],
  ['--on-accent', '--accent'], ['--on-accent', '--accent-hover'], ['--on-accent', '--danger-fill'],
  ['--attention', '--attention-soft'],
  ['--fg', '--mark-bg'],
  // per-project session-title color (§4.3 project-tinted rows): dark theme
  // tints the title text itself (checked on every row background it can
  // sit on); light theme tints the row background instead, so its own
  // token only ever needs to clear AA against --fg (§3.7/T046).
  ['--project-red-text', '--bg-pane'], ['--project-red-text', '--bg-selected'], ['--project-red-text', '--row-waiting-bg'],
  ['--project-yellow-text', '--bg-pane'], ['--project-yellow-text', '--bg-selected'], ['--project-yellow-text', '--row-waiting-bg'],
  ['--project-green-text', '--bg-pane'], ['--project-green-text', '--bg-selected'], ['--project-green-text', '--row-waiting-bg'],
  ['--project-blue-text', '--bg-pane'], ['--project-blue-text', '--bg-selected'], ['--project-blue-text', '--row-waiting-bg'],
  ['--project-purple-text', '--bg-pane'], ['--project-purple-text', '--bg-selected'], ['--project-purple-text', '--row-waiting-bg'],
  ['--fg', '--project-red-tint'], ['--fg', '--project-yellow-tint'], ['--fg', '--project-green-tint'],
  ['--fg', '--project-blue-tint'], ['--fg', '--project-purple-tint'],
]);

/**
 * Non-text marks that must stay visible (WCAG 1.4.11, 3:1): focus ring,
 * primary fill edge, waiting glyph/bar, quota meter fills on their track.
 */
export const NONTEXT_PAIRS = Object.freeze([
  ['--focus', '--bg'], ['--focus', '--bg-chrome'], ['--focus', '--bg-pane'],
  ['--accent', '--bg-pane'],
  ['--attention-glyph', '--bg-pane'], ['--attention-glyph', '--row-waiting-bg'], ['--attention-glyph', '--bg-selected'],
  ['--busy', '--bg-pane'],
  ['--warn-fill', '--bg-chrome'], ['--warn-fill', '--bg-pane'], ['--warn-fill', '--meter-track'],
  ['--danger', '--meter-track'], ['--fg-dim', '--meter-track'],
]);

/** AA threshold for normal-size text. */
export const AA = 4.5;

/** WCAG 1.4.11 threshold for non-text UI components and graphics. */
export const AA_NONTEXT = 3;
