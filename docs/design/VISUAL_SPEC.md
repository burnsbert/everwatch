# Everwatch visual spec: "calm, precise, native"

Status: proposal (T038, amended with the logo §11, agent badge §4.17, Tokens Used §4.18, tooltips §4.19, and the activity-strip and toast decisions). Scope: visual design only. Behavior, the API, and
keymap semantics stay as they are unless a row below says otherwise and
cites a decision (D1–D5, §9).
Baseline: the current Everwatch interface and its automated screenshots.
Audience: the engineers who will implement work packages WP-A to WP-F and T040 (§8).

This document does not replace docs/DESIGN.md. It refines §3.6 (Theming)
and the P-19/P-35/P-38 presentation rows. Where it conflicts with a
parity row marked `=`, that conflict is listed as a decision in §9, and it
should not ship without the owner's sign-off.

---

## 0. Evidence

All renders are headless Chromium runs against the real
`python3 -m everwatch serve --demo` backend (seed 1, fixed clock). Empty
states use the e2e fixture server. They live in the session scratchpad and
are not committed:

```
SHOTS=/tmp/everwatch-visuals/shots
MOCK=/tmp/everwatch-visuals/mock
```

- Naming: `{d|l}-{L|M|S}-{screen}.png`. `d`/`l` = dark or light.
  `L` = 1440×900, `M` = 1180×760 (the shell's default window size), `S` =
  720×760. Screens: split, list, grid, usage, settings, diagnostics,
  onb-welcome at all three sizes. At M only: palette, palette-search, help,
  ctxmenu, confirm, toast, label, statuspop, filter, filter-none, zoom,
  noprojects, onb-{iterm,automation,extras,done}, and
  empty-{norunning,denied,nosessions,error}. Plus `{d|l}-compact.png` at
  320×480. 84 files in total.
- Generator: `$SHOTS/../render.mjs` (a scratchpad copy of the approach in
  scripts/screenshots.mjs). Contrast checks: `$SHOTS/../contrast.mjs` and
  `$SHOTS/../c2.mjs`. Both use `contrastRatio` and `CONTRAST_PAIRS` from
  `everwatch/web/js/lib/theme.mjs`.
- Mockup of the target split view: `$MOCK/split-dark.png`,
  `$MOCK/split-light.png`, rendered from `$MOCK/split.html`. This is a
  static HTML sketch that uses exactly the tokens in §3.
- Caveat: the teammate's projects work was landing while the renders ran.
  Some light-theme shots already show the new folder button, which pushes
  the status chip into "Li…" truncation (finding A7). Treat the
  projects-panel pixels as "before" only.

---

## 1. Design principles (the tests every change must pass)

1. **One loud color.** Amber means "a session needs you". That is the
   product's whole reason to exist, so nothing else gets a saturated fill.
   Blue (`--accent`) is reserved for the primary action, selection, and
   focus. Status hues (green, red, yellow) show up as small glyphs and
   short text, never as large fills.
2. **Hierarchy through weight and position, not color.** Use three text
   tiers (`--fg`, `--fg-dim`, `--idle`) and three weights (500, 550, 600).
   Row names stay `--fg`; state lives in the glyph, the age text, and the
   left bar.
3. **Hairlines, not boxes.** Surfaces separate with 1px `--border` lines
   and small surface-tone steps. Cards appear only where content really is
   a group (settings groups, usage providers, grid tiles). No stacked
   card-in-card-in-card.
4. **Native rhythm.** macOS metrics: 15px body, 28px controls, 24px menu
   items, a 4-pt spacing grid, 6px control radius, 8px menu radius, and
   12px window-level radius. Title-case button labels, sentence-case
   section labels, no tracked all-caps eyebrows.
5. **Density that breathes.** Rows run 44px (split), 30px (list), and 28px
   (compact). Padding is predictable, so every column lines up on a
   baseline.

---

## 2. Audit: what reads as amateur today

Ordered by visual impact. "Ref" is a file in `$SHOTS`.

| # | Finding | Evidence / ref |
|---|---|---|
| A1 | **Selected rows are fully saturated reversed fills** that change hue by kind: amber (waiting), violet `#7c3aed` (Claude), blue (Codex), gray. The selected row is the loudest object on screen and changes color as you arrow through the list. | `d-M-split` (amber bar across the whole row), `d-M-label` (violet row), `l-M-confirm` (blue row). css/app.css `.row.is-selected*` |
| A2 | **Too many simultaneous accent colors.** One split screen shows amber fill, amber text, violet and blue badges, green names, gold label text, green/amber/gray sparkline stripes, 5 project dots, a blue primary button, and a green "Live" dot. The help sheet uses violet for section headings, and empty states use a violet glow and icon. | `d-M-split`, `d-M-help`, `d-M-empty-denied`, `l-M-empty-nosessions` |
| A3 | **Row name color carries state**: amber (waiting), green (fresh), gold (labeled), white (other). Four name colors in one list look random rather than meaningful. | `d-M-split` rows "stripe-webhooks", "tail -f", "tf-plan" |
| A4 | **Type scale sprawl:** 15 distinct font sizes (9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 15, 16, 17, 18, 19, 20px) and 5 weights (550, 600, 650, 700, 750). Half-pixel sizes and heavy weights (700/750 on 9.5–11px badges and pills) read as a web page, not a Mac app. | `grep font-size` over css/app.css + css/settings.css |
| A5 | **Radius and shadow sprawl:** 13 distinct radius values (2, 3, 4, 5, 6, 8, 12, 14, 24px, 50%, pill…) and about 20 distinct `box-shadow` recipes. The preview is a floating card with a drop shadow, a 3px colored top bar, and a colored border, all inside a pane. | `d-M-split` preview; css/app.css `.preview`, `.preview::before` |
| A6 | **Toolbar clutter: 7 different control shapes** in one 52px bar: logo tile, 2-line brand, pill (waiting), pill with border (status), pill with meters plus a separate chevron (usage), rounded rectangle (search, sort), segmented control, and bare icons. Mixed radii (pill vs 8px) and mixed borders. The brand repeats the native window title "Everwatch" right above it. | `d-L-split`, `d-M-split`. shell/Sources/App/WebWindows.swift:124-127 (standard titled window, so the title bar already says "Everwatch") |
| A7 | **Status chip truncates to "Li…" at the default 1180px width** once the projects toggle button exists. The chip is `flex: 0 0.1 auto`, so it is the first thing to shrink. "No permiss…" also truncates in `d-M-empty-denied`. | `l-M-onb-automation`, `l-M-empty-nosessions`, `d-M-empty-denied` |
| A8 | **Footer is a TUI port:** a 4-item glyph legend plus 13 keyboard hints (`↑↓ move · ↵ go to · a next ◉ · / filter · s sort · l label · n new · r refresh · v view · space zoom · u usage · ? help`) on every screen. It includes the session legend on Settings and Usage, where no sessions are shown. | `d-M-split`, `d-M-settings`, `d-M-usage` |
| A9 | **Badges are shouty:** `CC`/`CX`/`···` in 9.5px/750 uppercase, tinted per kind. The `···` badge on plain shells is noise, and every row repeats it. | `d-M-split` rows 1.4, 2.3, 2.4 |
| A10 | **Grid tiles are dimmed to `opacity: .72`** unless selected or waiting. That drops text below AA: tail text 4.45:1 (dark) and **3.26:1 (light)**, idle age **3.21 (dark) / 2.83 (light)**, computed with `contrastRatio`. Waiting tiles use a 2px amber border, so borders are uneven across the grid. | `d-M-grid`, `d-S-grid`; css/app.css `.tile { opacity: .72 }` |
| A11 | **Projects panel:** bordered card per slot. The placeholder names "Project 4" and "Project 5" are italic. A full-width "Clear all…" button (a destructive action) is the most prominent control in the panel. `1 session` repeats on every row. | `d-M-split` right column |
| A12 | **Pages don't feel like pages:** the full session toolbar (filter, sort, view switch, waiting pill) stays on Settings, Usage, Diagnostics, and Onboarding, where it does nothing. The page title is left-aligned at the window edge while the content column is centered, so the two don't align. "Back to sessions" is a big bordered button at top right. | `d-M-settings`, `d-M-diagnostics`, `d-M-usage` |
| A13 | **Settings:** tracked all-caps section titles inside each card, a separate card per single setting, 13px/550 labels, and the hotkey UI as three separate controls (`⌥⌘E` text + "Record…" + "Clear"). | `d-M-settings`, `l-M-settings` |
| A14 | **Diagnostics:** 13 separately bordered cards. Backticks render literally (`` `tccutil reset …` ``, `` `lsof` ``, `` `claude` ``). "Install Shell Integration" is an underlined link styled like a button. | `d-M-diagnostics` |
| A15 | **Onboarding:** the main toolbar and footer stay visible during first run. The welcome card has a 320px min-height, so half of it is empty. A primary-blue **"Skip"** is the main CTA on unsatisfied steps. The sticky nav bar draws a full-width `--bg` band over the card, and the "checks again…" note and "Still stuck?" slide under it. The Extras cards have lopsided padding and no status marker. | `d-M-onb-welcome`, `l-M-onb-automation`, `l-M-onb-extras` |
| A16 | **Usage:** redundant labels ("CC Session Limit" under a "CLAUDE CODE" header; they come from everwatch/model.py:28-29). Charts are heavy: vertical and horizontal grid lines, a shaded future region, a dashed projection, and a hard "NOW" rule. Traffic-light green for "fine" makes a calm state look like an alert. Two 300px-min columns at 720px wide are cramped. | `l-M-usage` (docs/screenshots/usage-light.png), `l-S-usage` |
| A17 | **Empty states:** a radial violet gradient, an 84px icon tile with a large drop shadow, and violet icons for non-agent states (lock, terminal). The unselected preview repeats a full empty card inside a bordered pane. | `d-M-empty-denied`, `d-M-filter-none` |
| A18 | **Overlays:** context menu items have no shortcut column and no separators between groups, and right-clicking a row doesn't select it (the highlight stays on deploy-fix). Palette results mix sessions and commands with no section headers. The help sheet uses skeuomorphic 2px-bottom-border keycaps. Toasts are pills that cover the preview title. The status popover is pinned at `left: 170px`, not anchored to its chip. | `d-M-ctxmenu`, `d-M-palette`, `d-M-help`, `d-M-toast`, `d-M-statuspop` |
| A19 | **Narrow (720px):** the path column truncates to useless tails ("…teway", "…rvice"). The projects panel eats a third of the window. The usage cards stay two columns. | `d-S-split`, `d-S-list`, `l-S-usage` |
| A20 | **Icon set inconsistency:** 16px icons with stroke widths 1.2 to 1.7, plus 48px illustration icons at stroke 2.4 (rendered heavier). A keyboard glyph stands in for "help". The view-switch "split" icon and the new projects toggle are both "panel" metaphors. | index.html sprite |
| A22 | **Existing AA failure:** in dark mode the destructive button is white on `--danger` `#ff6961`, which measures **2.82:1**. | `d-M-confirm`: salmon "Close tab" button with white label; css/app.css `.btn--danger` |
| A23 | **Two unrelated brand marks.** The web logo (everwatch/web/img/logo.svg, `#i-logo`) is a Tailwind violet→blue gradient tile with a white eye. The app icon (scripts/make_icon.swift) is a navy tile with a violet iris, a thin amber outline, and a fake "◉" notification badge top-right, which collides with the real Dock badge that shows the waiting count (P-19). At 16/32px the thin outline and the badge turn to specks. The menu bar uses the stock SF Symbol `eye`, so there is no brand there. README has no logo. | `$SHOTS/../logo/current/sheet.png` |
| A21 | **Press animations** (`transform: scale(.94–.98)` on every button) and a toast "rise + scale" are web idioms. macOS controls darken; they don't shrink. | css/app.css `.icon-btn:active`, `.btn:active`, `@keyframes toast-in` |

What is already good and should be kept: the system font stacks, the
integer 16px terminal line height, the left-ellipsized paths, the
AA-tested token system with its duplicated light block, the reduced-motion
global rule, the split-ratio persistence, and the automation illustration
concept.

---

## 3. Design tokens

Everything lives in `everwatch/web/css/tokens.css`. **Keep the existing
token names** where they still apply, so `tests/js/theme.test.mjs` and the
e2e `cssVar(...)` comparisons keep working. Values change; a few names are
added; some become aliases (§3.7). The light palette is still written twice
(forced + `prefers-color-scheme`), and the test still asserts that the two
copies are identical.

### 3.1 Typography

Font stacks stay as they are: `--font-ui` (-apple-system…) and
`--font-mono` (ui-monospace, SF Mono…). No bundled fonts.

| Token | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|
| `--text-caption` | 12px / 16px | 550 | 0.01em | kbd caps, chart ticks, kind badges |
| `--text-small` | 13px / 18px | 500 (550 for labels) | 0 | meta, ages, counts, status bar, section labels, toasts' secondary text |
| `--text-control` | 14px / 20px | 550 | 0 | buttons, inputs, select, segmented, toolbar text |
| `--text-body` | 15px / 22px | 500 (550 for row names) | 0 | body, row names, menu items, settings labels, palette items |
| `--text-title` | 17px / 24px | 600 | −0.01em | preview title, dialog/sheet title, empty-state title |
| `--text-page` | 22px / 30px | 600 | −0.015em | page titles (Usage, Settings, Diagnostics), onboarding step title |
| `--text-metric` | 24px / 32px | 600 | −0.01em, tabular | usage percentages only |
| `--mono-small` | 13px / 18px | 500 | 0 | paths, tab labels, meta lines |
| `--mono-tail` | 13px / 19px | 500 | 0 | grid tile tails, mini-strip |
| `--mono-screen` | 14px / 20px | 500 | 0 | preview terminal (keep the integer line height) |

Rules:

- Use 500 for regular text, 550 for labels and controls, and 600 for emphasis.
- No `text-transform: uppercase` anywhere except the two-letter kind
  badges (`CC`/`CX`, whose data is already uppercase).
- Numbers that update live (ages, counts, percentages, filter "N of M")
  use `font-variant-numeric: tabular-nums`.
- Implementation: define each as a pair of custom properties
  (`--text-body-size`, `--text-body-lh`) or as utility shorthands. Either
  works, as long as components reference tokens and not literals.

### 3.2 Spacing, sizing, radii

Spacing uses a 4-pt grid: `--sp-1: 4px`, `--sp-2: 8px`, `--sp-3: 12px`,
`--sp-4: 16px`, `--sp-5: 20px`, `--sp-6: 24px`, `--sp-8: 32px`,
`--sp-10: 40px`. Two half-steps are allowed only inside controls:
`--sp-0h: 2px` and `--sp-1h: 6px`.

| Sizing token | Value | Notes |
|---|---|---|
| `--toolbar-h` | **44px** | 52px only if WP-E's unified title bar lands (§5.1) |
| `--footer-h` | **30px** | unchanged height, but it now hosts the Tokens Used strip (§4.10, §4.18) |
| `--sidebar-w` | **216px** | currently 240 (teammate); coordinate |
| `--control-h` | 28px | buttons, inputs, select, segmented, icon buttons |
| `--control-h-sm` | 24px | small buttons, waiting pill, grid Agents/All, settings segmented |
| `--row-h` | 44px | split two-line row (currently 48) |
| `--row-h-list` | 30px | list view (currently 36) |
| `--row-h-compact` | 28px | compact panel |
| `--menu-item-h` | 24px | context menu |

| Radius token | Value | Use |
|---|---|---|
| `--radius-xs` | 4px | kbd, badges, chips-as-squares, inline code, menu item highlight |
| `--radius-s` | 6px | buttons, inputs, rows, icon buttons, segmented outer, palette items |
| `--radius-m` | 8px | menus, popovers, toasts, tiles, terminal inset |
| `--radius-l` | 12px | cards, dialogs, palette, help sheet, onboarding card |
| `--radius-pill` | 999px | waiting pill, state pill, toggle, filter chip |

The existing `--radius-s/m/l` get the new values (5→6, 8→8, 12→12) and
`--radius-xs` is added. Delete the literals `14px`, `24px`, `5px`, `3px`,
and `2px` (keep `2px` only for the 3px-wide bars and the `mark` element).

### 3.3 Elevation

Three levels. Panes get **no** shadow.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--shadow-1` | `0 1px 2px rgba(0,0,0,.35)` | `0 1px 2px rgba(16,16,24,.10)` | segmented thumb, toggle knob, popup button, onboarding card |
| `--shadow-2` | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(16,16,24,.14), 0 1px 3px rgba(16,16,24,.08)` | menus, popovers, toasts, overlay sidebar (<900px) |
| `--shadow-3` | `0 24px 64px rgba(0,0,0,.55)` | `0 24px 64px rgba(16,16,24,.20)` | dialogs, palette, help sheet |
| `--backdrop` | `rgba(0,0,0,.45)` | `rgba(0,0,0,.25)` | `::backdrop` with no blur. Native sheets don't blur, and dropping the blur keeps text behind the dialog crisp and cheap to render. |

Every level-2 and level-3 surface also gets `1px solid var(--border-strong)`.

### 3.4 Color: neutrals and semantics (exact hex)

Text-bearing backgrounds stay opaque hex.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--bg` | `#151517` | `#f2f2f4` | page canvas (Usage, Settings, Diagnostics, Onboarding) |
| `--bg-chrome` *(new)* | `#1c1c1f` | `#f6f6f8` | toolbar, status bar, projects sidebar |
| `--bg-pane` | `#19191c` | `#ffffff` ✓ | session list, preview, list and grid views, compact |
| `--bg-elev` | `#212125` | `#ffffff` | cards, tiles, popup buttons, segmented thumb |
| `--bg-popover` | `#2a2a2e` | `#ffffff` ✓ | menus, popovers, toasts, dialogs, palette |
| `--bg-term` | `#0f0f11` ✓ | `#f9f9fb` | terminal inset, tile tails, inline code |
| `--bg-hover` | `#252529` | `#f0f0f3` | hover rows, segmented track, neutral pills |
| `--bg-selected` *(new)* | `#132846` | `#e8f0fd` | selected row/item while the list or window is focused (accent-tinted) |
| `--bg-selected-inactive` *(new)* | `#2c2c31` | `#e6e6ea` | selected row when focus is elsewhere or the window is inactive |
| `--fg` | `#ececf0` ✓ | `#1d1d1f` ✓ | primary text |
| `--fg-dim` | `#a1a1aa` ✓ | `#5f5f68` ✓ | secondary text, icons at rest |
| `--idle` | `#8e8e98` ✓ | `#6c6c75` ✓ | tertiary text (idle ages, counts). **Never on `--bg-selected*`**: use `--fg-dim` there (§4.3). |
| `--border` | `#28282c` | `#e4e4e8` | hairlines between regions, card outlines |
| `--border-strong` | `#3a3a40` | `#d0d0d7` | control outlines, popover edges, kbd |
| `--chrome` | `#56565f` ✓ | `#b4b4bc` ✓ | sparkline "quiet" segments only |
| `--accent` | `#0a6cf0` | `#0a6cf0` | primary button fill, menu highlight, selection hue source. White on it = 4.76:1. |
| `--accent-hover` *(new)* | `#0a5fd6` | `#0a5fd6` | primary hover/pressed (white 5.80:1) |
| `--accent-fg` *(new)* | `#4c9bff` | `#0a5fd6` | accent as text/icon on surfaces (links, "Check Again", back button) |
| `--on-accent` | `#ffffff` ✓ | `#ffffff` ✓ | |
| `--focus` | `#4c9bff` ✓ | `#0a6cf0` | focus ring color. Rings use `0 0 0 3px color-mix(in srgb, var(--focus) 45%, transparent)` plus a 1px solid `--focus` border on inputs. |
| `--attention` | `#ffaf00` ✓ | `#955400` ✓ | waiting **text** |
| `--attention-fill` | `#ffaf00` ✓ | `#ffb224` ✓ | waiting glyph fill (dark), flash |
| `--attention-glyph` | `#ffaf00` ✓ | **`#c77700`** (was `#e58c00`: 2.60:1 on white, below the 3:1 non-text minimum; now 3.46:1, and 3.25:1 on `--row-waiting-bg`) | waiting glyph, 3px waiting bar |
| `--on-attention` | `#1a1000` ✓ | `#1f1300` ✓ | text on `--attention-fill` (flash only) |
| `--attention-soft` | `#3a2f17` | `#fbecd2` ✓ | waiting pill and state-pill background |
| `--row-waiting-bg` | `#211d15` | `#fff7e8` | waiting row tint (subtler than today's `#322a1b` / `#fff4e0`) |
| `--busy` | `#5fd38a` ✓ | **`#16753a`** (was `#1a7f3c`: 4.09:1 on the new `--bg-selected`; now 5.03) | busy glyph, "just finished", Live dot, OK status |
| `--danger` | `#ff6961` ✓ | `#c62828` ✓ | danger text and icons |
| `--danger-fill` *(new)* | `#c62828` | `#c62828` | destructive button fill (white 5.62:1) |
| `--warn` | **`#ffd60a`** | **`#7d6200`** | quota "yellow" severity, warn status text and icons. Retuned from the orange-ish `#ffc247` / `#8f5b00` to a true yellow so it can't be confused with waiting amber. Dark: ≥ 10:1 on every surface. Light: ≥ 5.06 on every surface (computed). |
| `--warn-fill` *(new)* | `#ffd60a` | `#a88600` | yellow meter fill and pace icon. Light: 3.46 on white, 3.20 on chrome, and 3.01 on the light meter track (non-text, 3:1 minimum). |
| `--meter-track` *(new)* | `#3a3a40` | `#efeff2` + `inset 0 0 0 1px var(--border)` | quota meter track. The light track is only 1.06:1 against chrome, which is why it needs the ring. |
| `--agent-claude` *(T037)* | `#4fe0cf` | `#0a6d63` | Claude agent badge text/glyph, preview accent. Teal, chosen by T037 to sit away from the 7 tab presets and the state colors. Adopted as-is. |
| `--agent-claude-bg` *(T037)* | `#123a37` | `#dff5f2` | Claude badge surface (opaque). Text on it: 7.65 dark / 5.47 light (computed). |
| `--agent-codex` *(T037)* | `#ed82d2` | `#a02280` | Codex agent badge text/glyph, preview accent (magenta) |
| `--agent-codex-bg` *(T037)* | `#37152f` | `#fbe9f7` | Codex badge surface (opaque). Text on it: 6.66 dark / 5.96 light (computed). |
| `--accent-claude`, `--accent-codex`, `--badge-claude-bg`, `--badge-codex-bg` | → aliases of the `--agent-*` tokens (§3.7) | | legacy names; still referenced by `CONTRAST_PAIRS` |
| `--badge-bg` *(new)* | `#2a2a2f` | `#efeff3` | neutral badge surface (self / dashboard badges, shortcut chips) |
| `--mark-bg` | `#5f4715` ✓ | `#ffe0a7` ✓ | filter-match highlight |
| `--chip-ring` *(new)* | `rgba(255,255,255,.16)` | `rgba(0,0,0,.28)` | 1px inset ring on project/tab color chips (graphic only, not text) |

Contrast verification (run, not assumed): `$SHOTS/../contrast2.mjs`
(the final run, including T037's `--agent-*` tokens, the retuned
`--warn`, and the new warn/agent pairs) checks all 40 current
`CONTRAST_PAIRS` (the working tree, including T037's two agent pairs)
plus 36 new pairs (fg, fg-dim,
idle, attention, busy, and accent-* on `--bg-chrome`, `--bg-selected`,
`--bg-selected-inactive`, `--row-waiting-bg`, `--badge-bg`, and others).
The script maps the retired tokens to their §3.7 aliases. Output with the
values above:

```
dark: 76 text pairs checked, 0 below 4.5, min 4.56
light FAIL --on-accent on --sel-claude-bg: 1.15
light FAIL --on-accent on --sel-codex-bg: 1.15
light: 76 text pairs checked, 2 below 4.5, min 1.15
```

The only two failures are pairs for tokens this spec retires (white text on
kind-colored selection), and they are removed together with those tokens
(§3.7). `--idle` on `--bg-selected` passes only narrowly (4.56 dark /
4.53 light). `--idle` on `--bg-selected-inactive` fails (4.28 dark / 4.18
light, computed separately in `c2.mjs`). That is why §4.3 maps `--idle` →
`--fg-dim` inside all selected rows. Non-text: `--focus` on
`--bg-pane` is 6.21 (dark) / 4.76 (light), and `--accent` on `--bg-pane`
is 3.69 / 4.76. Both are ≥ 3:1.

### 3.5 Project / tab colors

The fills **stay the exact iTerm2 preset RGB** (`--tab-red` … `--tab-gray`,
from itermcolor.py:23-31) in both themes. The chip's job is to match the
real iTerm2 tab, so a "tuned" hue would break the one thing it is for.
Tuning happens in the ring and the size:

- Chip: a circle, 8px in rows, 10px in the sidebar, preview header, and
  menus. `box-shadow: inset 0 0 0 1px var(--chip-ring)`.
- Why the ring: on white, yellow is 1.39:1, green 1.64, orange 1.92,
  purple 2.58, blue 2.60, and red 2.85 (all computed). The ring gives
  every chip a visible edge in light mode. Measured as a hue-darkened
  equivalent (`color-mix(tab 55%, #000)`), the edge is ≥ 4.4:1 on white
  for all seven. In dark mode every fill except gray (3.97) is already
  ≥ 6:1.
- Color is never the only cue. The project **name** always appears next
  to the chip (sidebar, preview meta, menu, tooltip), which satisfies
  WCAG 1.4.1.
- Never render text in a tab color.
- Unnamed slots display the **color name** ("Red", "Yellow") in `--fg-dim`
  with the pencil affordance, instead of an italic "Project 4". The slot
  *is* a color, so the color name is meaningful.

### 3.6 Motion

| Token | Value | Use |
|---|---|---|
| `--dur-1` | 100ms | hover/press color, bg, and opacity changes |
| `--dur-2` | 160ms | menus, popovers, toasts (in), focus ring |
| `--dur-3` | 240ms | dialogs, palette, sidebar show/hide, split resize snap |
| `--ease-out` | `cubic-bezier(.2,.8,.2,1)` ✓ | entrances |
| `--ease-standard` | `cubic-bezier(.4,0,.2,1)` | state changes, exits |

Rules:

- Animate only `opacity`, `background-color`, `color`, `border-color`, and
  `transform`. Translate is at most 4px and scale at least .98, and only
  on entrances.
- Delete every `:active { transform: scale(...) }`. Pressed state is
  `--bg-hover` darkened (`color-mix(in srgb, var(--fg) 8%, var(--bg-hover))`),
  or `--accent-hover` for primary buttons.
- Allowed continuous animations: the busy spinner (0.9s linear, P-34), the
  waiting halo (2.4s, **row glyph only**, not the toolbar pill), and the
  "connecting" breathe on the status dot.
- Menus and popovers: in = opacity 0→1 + translateY(−2px→0) over
  `--dur-2`; out = opacity over `--dur-1`. Dialogs: opacity + scale
  .98→1 over `--dur-3`. Toasts: opacity + translateY(−4px→0).
- Reduced motion: keep the existing global kill-switch. Additionally, the
  busy glyph renders as a static 270° arc (already true), the halo is
  hidden, and the flash becomes a static `--attention-soft` tint for
  1.5s (§4.3).

### 3.7 Token retirements and aliases (WP-A)

| Old | Becomes | Why |
|---|---|---|
| `--sel-claude-bg`, `--sel-codex-bg`, `--sel-plain-bg` | aliases of `--bg-selected` (D1-A) | one neutral selection |
| `--sel-plain-fg` | alias of `--fg` | text keeps its own color on the tinted selection |
| `--badge-plain-bg` | alias of `--badge-bg` | plain shells get no badge |
| `--accent-claude`, `--accent-codex` | aliases of `--agent-claude`, `--agent-codex` | one agent-color source (T037) |
| `--badge-claude-bg`, `--badge-codex-bg` | aliases of `--agent-claude-bg`, `--agent-codex-bg` | same |
| `--label` | alias of `--fg` (D1-A) | name color no longer encodes "labeled" |
| `--row-fresh-bg` | alias of `--bg-pane` (D1-A) | fresh is shown by green age text only |
| `--shadow` | removed after migration to `--shadow-1/2/3` | |
| `--dur-fast`, `--dur-med` | aliases of `--dur-1` and `--dur-3` during migration, then removed | |

`CONTRAST_PAIRS` (js/lib/theme.mjs) is updated in the same PR. Remove the
`--on-accent` on `--sel-*-bg` pairs. Add the new pairs from §3.4 and `['--on-accent','--danger-fill']`,
including `['--fg','--bg-selected']`, `['--fg-dim','--bg-selected']`,
`['--attention','--bg-selected']`, `['--busy','--bg-selected']`,
`['--warn','--bg-chrome']`, `['--warn','--bg-popover']`,
`['--fg','--bg-chrome']`, `['--fg-dim','--bg-chrome']`,
`['--idle','--bg-chrome']`, `['--accent-fg','--bg-pane']`,
`['--accent-fg','--bg-popover']`, `['--fg-dim','--row-waiting-bg']`, and
`['--fg-dim','--bg-selected-inactive']`.

---

## 4. Component specs

### 4.1 Icons: one set, one weight

- One sprite in index.html. Every symbol is drawn on a **16×16 viewBox**
  with round caps and joins, outline only (filled only for dots). The
  symbols carry **no `stroke-width` attribute**; CSS sets it, and it
  inherits into `<use>`:
  - `.icon { width:16px; height:16px; stroke-width:1.5 }`
  - `.icon--sm` (14px): `stroke-width:1.6`
  - `.icon--xs` (12px): `stroke-width:1.75`
  - `.icon--xl` (32px): `stroke-width:0.9`, which renders at about 1.8px
  - Set `fill:none; stroke:currentColor` on `.icon`. Each symbol's paths
    must not hard-code `stroke-width`.
- Required glyphs (SF Symbols-like metaphors, drawn fresh; don't copy
  Apple assets): `search`, `arrow.clockwise` (refresh), `plus`,
  `keyboard` (shortcuts, kept), `rectangle.split.2x1` (**split view**:
  two equal panes, so it no longer collides with the sidebar metaphor),
  `list.bullet`, `square.grid.2x2`, `sidebar.left` (**projects toggle**,
  replacing the folder, since it shows and hides a left sidebar),
  `chevron.down`, `chevron.left` (page back), `arrow.up.forward.app`
  (Go to Session), `xmark`, `gauge`, `pencil`, `ellipsis`,
  `checkmark.circle`, `exclamationmark.triangle`, `xmark.circle`,
  `info.circle`, `minus.circle`, `terminal`, `lock`, `powerplug`,
  `sparkles`, `magnifyingglass.minus`, `hourglass` (pace warning), `nosign` (limit hit), `agent.claude` (a 6-spoke asterisk, echoing the ✳ Claude Code puts in its own tab titles; original drawing, not a trademark), `agent.codex` (angle brackets `‹›`).
- The 48px illustration symbols (`i-terminal`, `i-lock`, `i-plug`,
  `i-sparkle`, `i-filter-empty`) are redrawn on the 16 grid and used at
  `.icon--xl`.
- Colors: resting icons are `--fg-dim`, hover/pressed icons are `--fg`,
  and status icons use their status token. No decorative violet.
- The logo (`i-logo`) is used only in the browser-mode brand (20px), on
  the onboarding welcome step (56px), and optionally in alerts (40px).

### 4.2 Toolbar (`header.toolbar`)

```
[brand*] [● 2 waiting] [● Live] [⏳ Claude session out ~4:41 PM]  ⟶spacer⟵  [⌕ Filter sessions  /] [Attention ⌄] [▥|☰|▦] │ [▯][↻][+][⌨]
 * browser mode only (html[data-shell="0"])
```

- 44px tall, `--bg-chrome`, 1px `--border` bottom, padding `0 12px`,
  gap 8px, with a 12px gap between the left cluster and the spacer.
- **Brand:** hidden when `html[data-shell="1"]`, because the native title
  bar already says "Everwatch" (WebWindows.swift:127). In browser mode:
  a 20px logo plus "Everwatch" in 13/600, one line only. The
  `N tabs · N agents` counts move to the status bar (§4.10).
  This touches P-19 presentation (D3).
- **Waiting pill:** 24px, `--radius-pill`, `--attention-soft` bg,
  `--attention` text 12/600 tabular, 8px glyph with no halo, **no
  border**. Hover: `color-mix(in srgb, var(--attention) 18%, var(--attention-soft))`.
- **Status indicator:** borderless 28px button, `--radius-s`. OK state:
  7px `--busy` dot + "Live" 12/500 `--fg-dim`, with no ring around the
  dot. Warn/danger: dot and text in `--warn`/`--danger`, bg
  `color-mix(in srgb, <state> 12%, var(--bg-chrome))`. **Never shrinks
  text**: `flex: none`. Below 820px it shows the dot only (text moves into
  `title` and `aria-label`). This fixes A7.
- **Token alert chip** (replaces the per-provider usage summary):
  a borderless 28px button that shows only the **single worst** quota
  state. Every individual quota now lives in the always-visible "Tokens
  Used" bar (§4.18), so the toolbar doesn't repeat them. The chip's rules
  are in §4.18.3. Clicking it opens Usage (P-21). Remove the collapse
  chevron (resolved: the user wants the strip always visible).
- **Search:** width `clamp(160px, 20vw, 240px)`, 28px, `--bg-pane` bg,
  1px `--border-strong`, `--radius-s`, 12px text, 14px icon at 8px
  inset. The `/` kbd is 16px (§4.12). Focus: `--focus` border + 3px ring.
  Active filter (text kept): border `--accent-fg`, not amber, because
  amber means waiting.
- **Sort:** a popup button. 28px, `--bg-elev`, 1px `--border-strong`,
  `--shadow-1`, `--radius-s`, label 12/500, 12px chevron. Below 640px it
  becomes a 28px icon button (`arrow.up.arrow.down`) that opens the same
  native `<select>`; don't hide it.
- **View switch:** segmented control. Track `--bg-hover`, no border,
  2px padding, `--radius-s`. Segments are 30×24 with 16px icons. The
  selected segment gets a `--bg-elev` thumb, `--shadow-1`, radius 4, and
  `--fg` icon.
- **Divider:** 1×16px `--border-strong` between the view switch and the
  action buttons.
- **Icon buttons:** 28×28, `--radius-s`, `--fg-dim`. Hover: `--bg-hover`
  + `--fg`. `aria-pressed="true"` (projects): `--bg-hover` bg + `--fg`
  icon, **not `--accent`** (this overrides the teammate's current
  `color: var(--accent)`).
- Page routes (`#app[data-view="usage"|"settings"|"diagnostics"|"onboarding"]`):
  hide the search, sort, view switch, divider, projects, refresh, and new
  buttons with `visibility: hidden` (so the layout doesn't jump). The
  waiting pill, status, usage, and help stay. Onboarding hides the whole
  toolbar (§4.15).

### 4.3 Session row: split view (`.row`)

```
┌─────────────────────────────────────────────────────────────┐
│▌ ◉   ● deploy-fix                               wait 4m     │  44px
│▌     ~/src/api-gateway                    [✳ Claude]  1.1  │
└─────────────────────────────────────────────────────────────┘
 │ │   │ └ name 13/500 --fg                       └ age 11 tabular
 │ │   └ project chip 8px (slot always reserved)   agent badge (§4.17) · tab mono 11
 │ └ state glyph 10px in a 16px column
 └ 3px waiting bar (waiting only)
```

- Grid: `16px minmax(0,1fr) auto`, column-gap 10px, height `--row-h`,
  padding `0 10px`, `--radius-s`. The list container has 6px padding and
  rows have 1px vertical gap.
- **Line 1:** a chip slot (8px + 6px gap), **always reserved** so names
  align whether or not a tab has a color, then the name at 13/500 `--fg`.
  The label and editor replace the name in the same slot.
- **Line 2:** path in `--mono-small` `--fg-dim`, left-ellipsized
  (unchanged mechanism).
- **Meta, top:** age 11 tabular `--idle`. Waiting: `--attention` 600.
  Fresh note "just finished": `--busy` 500.
- **Meta, bottom (gap 6):** the agent badge (§4.17, full form
  "✳ Claude" / "‹› Codex"), then the tab label (mono 11 `--fg-dim`,
  min-width 3ch, right-aligned, tooltip "iTerm2 window 1, tab 1").
- **No activity strip in the default row** (user decision, implemented in
  T037). When the opt-in Settings toggle "Show activity in session lists"
  is on, a 32×8 strip goes before the badge, styled as in §4.6.1.
- **No badge for plain shells** (D1). The glyph tooltip still says
  "Shell".
- **Glyphs** (10px, 1.5px strokes):
  - waiting: filled `--attention-glyph` + halo
  - busy: spinning 3/4 ring in `--busy`
  - idle: 1.5px `--idle` ring
  - active: 4px `--fg-dim` dot
  - quiet/none: empty
- **States:**

| State | Background | Other |
|---|---|---|
| rest | transparent | |
| hover | `--bg-hover` | |
| waiting | `--row-waiting-bg` | `::before` 3px bar at `left:2px; top:8px; bottom:8px`, `--attention-glyph`, radius 2; name 600 |
| selected, list or window focused | `--bg-selected` | all text keeps its own token, except `--idle` → `--fg-dim` |
| selected, unfocused | `--bg-selected-inactive` | same mapping |
| selected + waiting | `--bg-selected` | **waiting bar stays**, age stays `--attention` |
| flash (→waiting) | animate `--attention-soft` → the row's resting bg over 1.5s | reduced motion: hold `--attention-soft` for 1.5s, then clear |
| editing label | editor 24px, `--bg-pane`, 1px `--focus`, 3px ring, 13/500 | |
| drag source | opacity .6 | |

- "Focused" means `:focus-within` on `.session-list`, or the window is
  key. Use `html[data-key="1"]` if the shell exposes it (it already
  posts key changes via `onKeyChange`; I believe this is bridged but
  haven't confirmed). Otherwise fall back to `:focus-within` only.
- Remove the separate 2px focus ring around the selected row. On macOS
  the selection color *is* the focus indicator: active (tinted) vs
  inactive (gray). The list container itself keeps a `:focus-visible`
  inset ring only when it has no rows.
- Group headers (sorted by path or agents): 11/600 `--fg-dim` in sentence
  case, 24px, padding `0 10px`, margin-top 8px, no trailing rule.

### 4.4 Session row: list view and compact

- **List** (`.session-list--list .row`): 30px, one line. Columns:
  `16px 8px 34px 64px minmax(160px,1fr) minmax(0,1.4fr) 80px` =
  glyph, chip, tab (mono 11), agent badge (full form; compact form below
  900px, §4.17), name (13/500), path (mono 11
  `--fg-dim`), age (right). Column gap 10px. Below 760px **drop the path
  column**; it only shows useless tails at that width (A19).
- **Mini-strip** (list view): the same terminal inset as the preview
  (`--bg-term`, 1px `--border`, `--radius-m`), margin `0 12px 12px`.
  Header 24px, 11/500 `--fg-dim`: "Last 3 lines · ~/src/api-gateway".
  Body in `--mono-tail`.
- **Compact** (320×480 NSPanel): rows 28px, padding `0 10px`, **no bottom
  borders** (hover and selection only). Layout: glyph 10 · chip 8 · name
  12/500 · spacer · agent badge in **compact form** (§4.17; the kind must
  stay visible even here) · age 11. Waiting rows
  get `--row-waiting-bg` + 3px bar. Empty state: 12px `--fg-dim`,
  centered, 16px padding.

### 4.5 Grid tiles (`.tile`)

- `--bg-elev`, 1px `--border`, `--radius-m`, **full opacity** (delete
  `opacity:.72`; this fixes the A10 AA failures).
- Head: 34px, padding `0 10px`, gap 6. Contents: glyph 10 · chip 8 ·
  tab mono 11 `--fg-dim` · name 12/600 · spacer · agent badge (full
  form) · age 11. 1px `--border` bottom.
- Activity strip: **off by default**, following the same opt-in Settings
  toggle as rows (this is my proposal; T037's decision only names rows).
  When on, it is a 3px strip flush along the bottom of the head, styled
  as in §4.6.1.
- Tail: `--bg-term`, `--mono-tail` `--fg-dim`, padding `8px 10px`, keep
  the right-edge fade mask.
- Waiting: head bg `--row-waiting-bg`, 3px amber bar on the head's left
  edge, border stays 1px `--border` (not 2px amber).
- Selected: border `--focus` + `0 0 0 3px color-mix(in srgb, var(--focus) 30%, transparent)`;
  tail text `--fg`.
- Grid header: "Agents" 13/600 + count 11 `--idle`; the Agents/All
  segmented control is `--control-h-sm`.
- Gap 12px, padding `4px 16px 16px`.

### 4.6 Preview pane (`.preview`)

- **Flat pane.** Remove the outer card: no margin, border, shadow, or
  `::before` top bar. The pane has a `--bg-pane` background and is
  separated from the list by the splitter hairline. The splitter always
  shows a 1px `--border` line; hover and drag switch it to `--focus`.
- **Head**, padding `14px 16px 12px`:
  - Title row: chip 10 · name `--text-title` · state pill.
  - **State pill:** 20px, `--radius-pill`, 11/600 in **sentence case**
    ("Waiting 4m", "Busy", "Idle 26m"), 7px glyph.
    - waiting: `--attention-soft` bg + `--attention` text
    - busy: `--bg-hover` + `--busy`
    - idle and others: `--bg-hover` + `--fg-dim`
    - Never a full amber fill.
  - Meta line: `--mono-small` `--fg-dim`, formatted
    `path · Claude Code · tab 1.1 · <Project name>`.
  - Activity line: see §4.6.1.
  - Primary action at right: "Go to Session" (title case), 28px, with a
    `↵` glyph at 70% opacity. No kbd box inside the button.
  - Rule chip: 18px, 1px dashed `--border-strong`, mono 10.
- **Agent badge** in the title row after the state pill (full form,
  §4.17). The meta line still spells out "Claude Code" / "Codex".
- **Terminal inset:** margin `0 16px`, `--bg-term`, 1px `--border`,
  `--radius-m`, padding `12px 14px`, `--mono-screen`.
- **Foot:** 32px, padding `0 16px`, 11 `--fg-dim`. Left: 6px live dot +
  "Live · updated just now". Right: "Space to zoom".
- **Zoom:** the same pane filling `.content`, with no card or margin.
- **Nothing selected:** no inner card. Centered 13 `--fg-dim` "Select a
  session" and a small 11 `--idle` hint "or press a for the one waiting
  longest".

#### 4.6.1 Activity strip (preview pane only, by default)

This is the final styling for the decision T037 is implementing: rows are
opt-in, the preview is always on.

```
Activity · last 60 min   ▁▁▃▃▅▅█▅▃▁▁▁▁▁▁▁▅▅▅   ■ Busy  ■ Waiting        Waited 4× · 25m total today
```

- One line of 11px text under the meta line, gap 8, `--fg-dim`.
- Label: "Activity · last 60 min", 11/500 `--fg-dim`.
- Strip: 160×8 at ≥ 1000px pane width, 96×8 below. `--radius-xs`, no
  background box. The 60 one-minute segments sit flush with 1px gaps.
  - busy: `--busy`
  - waiting: `--attention-glyph`
  - active (output, non-agent): `color-mix(in srgb, var(--fg) 35%, transparent)`
  - idle and quiet: `color-mix(in srgb, var(--fg) 8%, transparent)`,
    which is nearly transparent
  - no data: transparent, over a 1px `--border` baseline so the empty
    window still reads as a timeline
- Legend: two 8×8 radius-2 swatches with "Busy" and "Waiting" in 11
  `--fg-dim`. Idle is deliberately not in the legend.
- The totals text ("Waited 4× · 25m total today") is right-aligned on the
  same line, dropping to its own line below 720px pane width.
- Tooltip (§4.19) on the strip: "Activity over the last 60 minutes, one
  segment per minute. Green = busy, amber = waiting for you."
- Remove the `.row-spark` default and the 900px media rule; the
  Settings toggle controls visibility.

### 4.7 Projects sidebar (after the teammate's move to the left)

- Docked: `--sidebar-w`, `--bg-chrome`, 1px `--border` right, **no
  shadow**. Overlay (<900px): same, plus `--shadow-2`.
- Header, 28px, padding `0 8px 0 12px`: "Projects" 11/600 `--fg-dim`,
  then a right-aligned **"Clear"** text button (11/500 `--fg-dim`, hover
  `--fg`). This replaces the full-width bottom "Clear all…" button while
  keeping the control visible (the user asked for visible controls).
  Opens the same confirm dialog.
- Slot rows: 28px, padding `0 8px`, `--radius-s`, **no border**, margin
  `0 4px`. Layout: chip 10 · name 13/400 (`--fg`; unnamed: the color name
  in `--fg-dim`, **not italic**) · spacer · count 11 tabular `--idle` (a
  bare number: "1", not "1 session"; the full phrase stays in
  `aria-label`) · pencil and × (the teammate's affordances, 16px icon
  buttons, visible on hover/focus, pencil always visible on unnamed
  slots).
- Show the slot key (1–5) as a 16px kbd on hover/focus, replacing the
  count while hovered. The rest state stays quiet.
- Hover: `--bg-hover`. Drop target: `--bg-selected` +
  `inset 0 0 0 1px var(--focus)`. Rename input: 22px, `--bg-pane`,
  1px `--focus`, 3px ring.

### 4.8 Buttons, inputs, and controls

| Control | Spec |
|---|---|
| `.btn` (secondary) | 28px, padding `0 12px`, `--radius-s`, `--bg-elev`, 1px `--border-strong`, `--shadow-1`, 12/500 `--fg`. Hover `--bg-hover`. Pressed: 8% `--fg` mix. |
| `.btn--primary` | `--accent` bg, no border, `--on-accent` 12/500. Hover and pressed `--accent-hover`. |
| `.btn--danger` | New token `--danger-fill: #c62828` in **both** themes, with white text (5.62:1). Today dark mode fills with `--danger` `#ff6961`, and white on that is **2.82:1, an existing AA failure** on the "Close tab" button (`d-M-confirm`). Add `['--on-accent','--danger-fill']` to `CONTRAST_PAIRS`. `--danger` itself stays for danger *text*. |
| `.btn--small` | 24px, padding `0 10px`, 12/500 |
| `.btn--plain` *(new)* | no bg or border, `--accent-fg` 12/500, hover underline off, bg `--bg-hover`. Used for Back, Skip for Now, and Clear. |
| Text input | 28px, `--bg-pane`, 1px `--border-strong`, `--radius-s`, 12px, placeholder `--idle`. Focus: `--focus` border + 3px ring. |
| Popup/select | as the toolbar sort control (§4.2) |
| Segmented | as the view switch; text variant 24px tall, 12/500 labels |
| Toggle | 34×20 track, `--radius-pill`. Off: `--border-strong`; on: `--accent`. 16px knob `#fff` with `--shadow-1`. |
| Checkbox/radio | native `accent-color: var(--accent)` |
| Link | `--accent-fg`, no underline at rest, underline on hover. External links get a 12px `arrow.up.forward` icon. |

Remove all `transform` on `:active`.

### 4.9 Popovers, menus, tooltips

- **Context menu (`.ctx-menu`):** min-width 200, padding 5, `--radius-m`,
  `--bg-popover`, 1px `--border-strong`, `--shadow-2`.
  - Items: `--menu-item-h`, padding `0 10px 0 8px`, radius 4, 13/400.
    Layout: leading 16px slot (chip or checkmark) · label · spacer ·
    shortcut in 12 `--fg-dim` (`↵`, `L`, `1`…`5`, `0`, `X`).
  - Highlight (hover or keyboard): `--accent` bg + `--on-accent` text,
    and the shortcut goes to white at 80%. That is the native menu look,
    and the `--on-accent`/`--accent` pair is already AA.
  - Group label "Project" (not "COLOR → PROJECT"): 11/600 `--fg-dim`,
    20px.
  - Separators between groups: 1px `--border`, margin `4px 6px`.
    Groups: {Rename…, Go to Session} | {projects 1–5, Clear Color} |
    {Close Tab…}.
  - A checkmark marks the current project.
  - Danger item: `--danger` text; highlighted: `--danger` bg + white.
  - Behavior fix (A18): right-clicking a row selects it first.
- **Status popover:** anchored under the chip (JS computes `left` from
  `chip.getBoundingClientRect()`; CSS anchor positioning isn't assumed
  for the WKWebView baseline). 280 wide, padding 12, `--radius-m`,
  `--shadow-2`. Title 13/600, body 12 `--fg-dim`, then a `.btn--small`
  "Diagnose…".
- **Chart tooltip:** `--bg-popover`, 1px `--border-strong`, radius 4,
  10/500 tabular, `--shadow-2`.
- **Tooltips:** the app's own tooltip component (§4.19) replaces `title` wherever an abbreviation, icon, glyph, chip, or meter appears. Native `title` stays only on truncated plain text (full-text reveal).

### 4.10 Bottom bar: "Tokens Used" + status (`footer.statusbar`)

The status bar becomes the home of the always-visible quota strip (§4.18).
Everything else in it gives way to the quotas when space runs out.

```
│ Tokens Used  Claude Code  Session ▬▬▬▬ 62% ⏳4:41 PM · Weekly ▬▬ 34% · Sonnet ▬▬▬▬▬ 100% ⛔ · Monthly ▬▬▬ 62%   Codex  5h ▬ 18% · Weekly ▬▬▬ 58%  ⟶  [filter ×] 9 tabs · 6 agents   ↵ Go to  ⌘K Commands │
```

- **30px** (`--footer-h: 30px`, up from the 26px in §3.2), `--bg-chrome`,
  1px `--border` top, padding `0 12px`, 11px `--fg-dim`.
- Left, never hidden: the Tokens Used strip (§4.18).
- Right, in the order they drop out as width shrinks:
  1. hints: at most 2, from a new `footer: true` flag in keymap.mjs
     BINDINGS (main: `↵ Go to` · `⌘K Commands`; zoom: `esc Back` ·
     `↵ Go to`; filter/label/pages: their existing hints)
  2. counts "9 tabs · 6 agents" (moved from the brand), tabular
  3. the kept-filter chip, which never drops while a filter is active:
     20px, `--radius-pill`, `--bg-hover` bg, `--fg` 11/500, 12px ×.
     Neutral, not amber.
- Implement the drop order with a container query on the bar
  (`container-type: inline-size`). Container queries need Safari 16+,
  which I believe the macOS 13 WKWebView baseline has but haven't
  confirmed. Fallback: a ResizeObserver that sets `data-fit` levels.
- **The glyph legend is removed** from the footer. It moves to the top of
  the help sheet (§4.11) and into glyph tooltips (§4.19). (D2:
  chrome.spec.mjs asserts the legend and the hints.)

### 4.11 Command palette, help sheet, dialogs

- **Palette:** width `min(600px, 100vw - 48px)`, placed at 18vh from the
  top, `--radius-l`, `--bg-popover`, 1px `--border-strong`, `--shadow-3`,
  `--backdrop` with no blur.
  - Input row: 48px, 16px icon, 15px input.
  - Mode control on the right: a text hint "⌘⇧F Screens" / "⌘K Commands"
    in 11/500 `--fg-dim` with a kbd, no pill border.
  - **Section headers** "Sessions" and "Commands" (11/600 `--fg-dim`,
    24px, padding `0 10px`); needs palette.mjs grouping.
  - Items: 32px, `--radius-s`, gap 10. Sessions show a leading glyph +
    chip; commands have no leading icon.
  - The group word ("Navigate") is removed from items. Key caps sit on
    the right.
  - Active item: `--bg-selected`. Screen hits use a mono context block
    (`--bg-term`, radius 4, `--mono-tail`).
  - Footer: 32px, 1px `--border` top.
- **Help sheet:** width `min(720px, …)`, `--radius-l`, `--shadow-3`.
  - Header: "Keyboard Shortcuts" `--text-title` + "Press any key to
    close" 11 `--idle`.
  - A new first row, "Status", shows the four glyphs with their words
    (the legend moved here).
  - Section headings: 11/600 `--fg-dim`, sentence case, **not violet**.
  - Each item: description 13 left, keys right-aligned (menu
    convention), row height 24.
- **Confirm/quota dialogs:** macOS alert rhythm. Width 320, padding 20,
  `--radius-l`, `--shadow-3`.
  - Optional 40px app logo top-left.
  - Title 13/600, detail 12 `--fg-dim` with margin-top 4.
  - Actions: right-aligned, 28px, min-width 80, gap 8, margin-top 20.
  - Default-focused Cancel shows the single 3px `--focus` ring, not
    today's double ring.

### 4.12 Keycaps (`kbd`)

There is one style everywhere (search, hints, help, palette, tips).
Remove the 2px bottom borders.

- 16px tall (18px in help and palette), min-width 16, padding `0 4px`
- `--radius-xs`, 1px `--border-strong`
- bg `--bg-elev` (`--bg-pane` on chrome surfaces)
- `--text-caption` `--fg-dim`

### 4.13 Toasts

- **No toast for show/hide actions.** The control's own state is the
  feedback. This drops the toasts for: projects panel show/hide, `$`
  dollar amounts, activity strips, and the grid Agents/All filter.
  Toggles with no visible state (sound on attention `b`) keep their toast.
  The split-ratio toast (P-22 parity) stays because it reports a number,
  not a show/hide; move it into a transient 11px label on the splitter if
  D5 allows (my suggestion, not a user request).
- **Auto-dismiss after 3.5 s.** The timer pauses while the pointer is over
  the toast or focus is inside it, and restarts at 3.5 s on leave (WCAG
  2.2.1). No toast is sticky except the P-31 errors that carry an action
  ("Retry"), which get 6 s. At most 3 are stacked; the oldest leaves
  first.
- Keep the top-center dock under the toolbar (the reasons are in the CSS
  comment). Offset 8px.
- 32px tall, padding `0 12px`, `--radius-m` (not pill), `--bg-popover`,
  1px `--border-strong`, `--shadow-2`, max-width 420.
- Text: 12/500 `--fg`.
- Leading 14px status icon: info `info.circle` `--accent-fg`, attention
  = waiting glyph, warn `exclamationmark.triangle` `--warn`, danger
  `xmark.circle` `--danger`. No colored borders.
- Action: `.btn--plain` style (`--accent-fg` 12/600).
- Motion: in = opacity + translateY(−4px → 0) over `--dur-2`; out =
  opacity over `--dur-1`. Reduced motion: opacity only.

### 4.14 Usage page

- Page shell (§4.16), column max-width 960. Cards use
  `grid-template-columns: repeat(auto-fit, minmax(380px, 1fr))`, so they
  fall to 1 column below about 820px of content width (fixes A19). Gap
  16px.
- **Card:** `--bg-elev`, 1px `--border`, `--radius-l`, padding
  `16px 20px`.
  - Head: provider name "Claude Code" 13/600 `--fg`, right status 11
    `--fg-dim` ("Updated 2m ago" / error in `--danger`).
- **Limit block**, 16px between blocks, separated by 1px `--border`:
  - Top row: label 13/500. Strip the redundant provider prefix and
    " Limit" suffix **at display time** in usage.mjs, so "CC Session
    Limit" shows as "Session"; the backend strings in model.py:28-29
    stay. Pct in `--text-metric`, tabular, right-aligned.
  - Meter: 6px, radius 3, track `--meter-track`. Fill as the Tokens Used
    strip (§4.18.2): `--fg-dim` ok, `--warn-fill` yellow, `--danger` red.
    A calm state isn't green. The same icons apply (`hourglass` pace,
    `nosign` hit), shown before the pct.
  - Sub-line: 11 `--fg-dim` "Resets in 2h 15m · Today 5:15 PM".
  - Projection line: 11 `--warn` "On pace to reach 100% at 4:41 PM"
    (`--danger` 500 when hit).
- **Chart** (hand-written SVG, keep the structure): height 96.
  - Y ticks only at 50% and 100% (10 `--idle`). Horizontal gridlines at
    50 and 100 in 1px `--border`, baseline `--border-strong`. **No
    vertical gridlines, and no shaded future region.**
  - Actual line: 1.5px in the fill color, area gradient 16% → 0.
  - Projection: 1.25px dashed `3 3` `--fg-dim` at 70%. Hit marker:
    hollow 7px `--warn`.
  - "Now" marker: 1px dashed `--fg-dim` at 50%, tag "Now" 10/500
    sentence case.
  - X ticks: start and "Resets Mon 7:00 PM" only.
- Foot: 11 `--fg-dim`, as today.

### 4.15 Settings, diagnostics, onboarding, empty states

**Settings** (System Settings grouping):

- Column max-width 640. Section title **outside** the group: 13/600
  `--fg`, margin `24px 0 8px 4px`.
- Group: `--bg-elev`, 1px `--border`, `--radius-m`. One group per
  section, multiple settings per group.
- Rows: min-height 40, padding `8px 12px`. Separators are 1px `--border`
  **inset 12px from the left**. Label 13/400, description 11 `--fg-dim`
  margin-top 2, control right-aligned.
- Hotkey recorder: a single 24px field, min-width 96, mono 12, showing
  the shortcut (`⌥⌘E`) or "Record Shortcut" in `--idle`. Click to record
  (border `--focus` while recording), with an inline 14px × to clear.
  This replaces the three separate controls (settings.mjs).
- Theme: text segmented at 24px.

**Diagnostics:**

- One grouped list: the same group and row anatomy as Settings, in
  CHECK_ORDER (unchanged).
- Row layout: 16px status icon (ok `checkmark.circle` `--busy`, warn
  `exclamationmark.triangle` `--warn`, error `xmark.circle` `--danger`,
  info `info.circle` `--fg-dim`, unknown `minus.circle` `--idle`) · title
  13/500 + detail 12 `--fg-dim` · action buttons right-aligned
  (`.btn--small`; below 640px they wrap under the detail).
- The status word stays in the row for screen readers (visually hidden
  or 11/500 next to the icon).
- Render backtick spans in `detail` as `<code>`: mono 11, `--bg-term`,
  radius 4, padding `0 4px`. Build them with DOM nodes, never innerHTML.
- The external "Install Shell Integration" link uses button styling with
  a ↗ icon.
- Summary under the page title: "1 of 13 needs attention" with a status
  icon.

**Onboarding** (`#app[data-view="onboarding"]`):

- Hide the toolbar **and** the status bar, the same way compact hides
  them. Canvas is `--bg`.
- Centered card: width `min(520px, 100vw - 48px)`, `--bg-elev`, 1px
  `--border`, `--radius-l`, `--shadow-1`, `max-height: calc(100vh - 64px)`.
  Laid out as a flex column: header / scrolling body / fixed footer.
  **Delete** the 320px min-height and the sticky page-level nav.
- Card header: padding `16px 20px 0`. "Step 3 of 5" 11/600 `--fg-dim`,
  then a 5-segment progress bar (each segment 4px, radius 2, gap 4; done
  and current `--accent`, todo `--border-strong`). Replaces the dots.
- Body: padding `24px 32px`.
  - Hero: `.icon--xl` in a 48px `--bg-hover` rounded-12 tile,
    `--accent-fg`. Welcome uses the 56px app logo instead.
  - Title: `--text-page`.
  - Text: 13 `--fg-dim`, max 44ch, centered.
- Footer inside the card: 1px `--border` top, padding `12px 16px`. Left:
  **Back** (`.btn--plain`, hidden on step 1). Right: when the step is
  satisfied, a primary **Continue**; when not, the step's own action as
  primary (e.g. "Open System Settings") plus **Skip for Now** as
  `.btn--plain`. **Never a primary "Skip".**
- Callout: `--bg-hover` bg, 3px `--attention-glyph` left bar,
  `--radius-m`, padding `10px 12px`. Title 13/600 `--fg`, body 12
  `--fg-dim`. Less orange text.
- Extras step: a grouped list (Settings anatomy) with status icons,
  instead of cards with lopsided padding.
- Keep the automation illustration. Its `--attention-glyph` ring and
  arrow pick up the new light value automatically.

**Empty states** (`.empty-page`, `.list-empty`, `.grid-empty`):

- **No radial gradient, no 84px shadowed tile.**
- Icon: `.icon--xl` `--fg-dim` in a 56px `--bg-hover` circle. Error
  kinds tint the icon `--warn` (not running, error) or `--danger` (no
  backend).
- Title `--text-title`, body 13 `--fg-dim`, max 40ch, gap 8.
- Steps: a plain numbered list, 13 `--fg`, line-height 22, no box.
- Actions: primary + secondary, 28px, gap 8, margin-top 16.
- Connecting/spinner kinds: a 16px busy-style spinner in `--fg-dim`
  under the title, instead of breathing the icon.
- The "No matching sessions" list empty state is the same, minus the
  circle: a 16px icon, 13/600 title, a small "Clear Filter" button.

### 4.16 Page shell (Usage, Settings, Diagnostics)

- `--bg` canvas, padding `24px 32px 40px`.
- Content column: `max-width: var(--page-w)` (640 settings, 720
  diagnostics, 960 usage), `margin: 0 auto`.
- The **title row sits inside the same column** (fixes the A12
  misalignment): a back button, `‹ Sessions` in `.btn--plain` with
  `chevron.left`, 28px, above the title; `--text-page` title; page
  actions right-aligned on the title row ("Check Again").
- "Back to sessions" keeps its accessible name for the existing tests.
  Set `aria-label="Back to sessions"` on the new button (D5).

### 4.17 Agent badge (Claude Code vs Codex)

**Goal:** you can tell which kind of agent a session is at a glance, in
every row state, without color.

Identity is carried by three redundant cues, in priority order:

1. **Word:** "Claude" or "Codex".
2. **Glyph:** `agent.claude` (asterisk) or `agent.codex` (`‹›`).
3. **Hue:** teal or magenta (T037's `--agent-*` tokens).

The badge's **shape** (a small rounded rectangle carrying text) is what
separates it from the other color-coded marks:

- project chips are *filled circles* with no text
- state marks are *circular glyphs* and pills that say "Waiting…" or
  "Busy"
- quota marks are *bars*

Hue alone can't separate them: seven tab presets plus four state colors
already cover the whole hue wheel. T037's teal/magenta pair avoids the
nearest presets. Note that teal Claude sits nearest to busy green
(`#4fe0cf` vs `#5fd38a` in dark), which is one more reason the word and
glyph lead. Violet no longer means anything special anywhere (help
headings, empty states).

| Form | Where | Anatomy |
|---|---|---|
| **Full** | split rows, grid tiles, preview title, list view ≥ 900px | 18px tall, padding `0 6px 0 5px`, `--radius-xs`, gap 4. 10px glyph + word in 11/600. Claude: `--agent-claude-bg` + `--agent-claude`. Codex: `--agent-codex-bg` + `--agent-codex`. Width ≈ 58px (Claude) / 52px (Codex); reserve 64px in list columns. |
| **Compact** | compact panel, list view < 900px, palette items, context menu header | 18×18 square, `--radius-xs`, glyph only (11px) on the same tinted surface. The tooltip and `aria-label` carry "Claude Code" / "Codex". |
| none | plain shells | nothing (D1). Everwatch's own tab and the ultrawatch dashboard keep a neutral `--badge-bg` "Everwatch" / "ultrawatch" word badge. |

- **AA holds in every row state because the badge is opaque.** Its own
  surface always sits under its text, so selected, inactive-selected,
  waiting, hover, and flash rows never change the text's contrast.
  Computed on T037's values: Claude 7.65 (dark) / 5.47 (light); Codex
  6.66 (dark) / 5.96 (light). The glyph is the same color, so its non-text
  contrast is well above 3:1.
- The badge surface itself is barely distinct from row backgrounds
  (1.01–1.41:1 against pane, selection, and waiting tints; computed), so
  the text carries the shape. In a selected row, add a 1px inset ring
  `color-mix(in srgb, currentColor 30%, transparent)` so the tinted
  badge doesn't dissolve into the accent-tinted selection.
- Order in the row meta line: `[agent badge] [tab label]`. The project
  chip stays on line 1 next to the name. Chip = *where* (project);
  badge = *who* (agent). They are never adjacent.
- Tooltip (§4.19): "Claude Code session" / "Codex session", plus the
  model if the backend ever reports it.
- **Never "CC"/"CX" alone** in the UI. The letters remain only inside
  data (`badge` field) and in tests.
- Relation to T037, which is in the working tree now: T037 has
  `badgeEl()` with `.badge-text--full` ("Claude"/"Codex") and
  `.badge-text--abbr` below the narrow breakpoint, plus the `--agent-*`
  tokens. The visual pass keeps all of that and:
  - adds the leading glyph
  - makes the *abbr* form glyph-only instead of letters. T037's
    `badgeAbbr` returns "CC"/"CX" (row.mjs:29-32).
  - **Watch out:** T037's `badgeFull` is `s.badge || (kind → 'Claude')`,
    and the backend always sends `badge: 'CC'/'CX'` (model.py BADGES;
    tests/golden/state_demo.json). So with real data the "full" form
    probably still renders "CC". I read this from the code and didn't
    render it. Map from `kind` first.
  - applies the sizes above and the selected-row ring
  - drops T037's plain-shell `···` text badge, per D1
  - keeps T037's preview accent line only if WP-B retains a
    left/top accent. §4.6 removes the preview's colored top bar, so the
    agent color shows up in the preview's title-row badge instead.

### 4.18 Tokens Used strip and the token alert chip (T040)

#### 4.18.1 Data and rules (no new severity logic; one optional backend field)

- Source: `usage.claude.rows[]` and `usage.codex.rows[]` from `/api/state`,
  with fields `id`, `label`, `pct`, `level`, `hit`, `projection{hit,text}`,
  `reset_text`, `reset_at`, and `dollars`.
- **Severity** comes from `level`, computed by the backend (P-54: ≥ 80
  red, ≥ 50 yellow, otherwise ok). The UI never re-derives thresholds.
- **Pace warning** = `projection && !projection.hit` (P-55).
- **Hit** = `hit || projection?.hit`.
- Display names are mapped from `id`. The backend `label` strings stay
  as they are.

| id | Strip label (full / short) | Tooltip name |
|---|---|---|
| `cc.five_hour` | Session / 5h | Claude Code — 5-hour session limit |
| `cc.seven_day` | Weekly / 7d | Claude Code — weekly limit |
| `cc.seven_day_sonnet` | Sonnet / Son. | Claude Code — weekly Sonnet limit |
| `cc.monthly` | Monthly / Mo. | Claude Code — monthly limit |
| `cc.extra` (model.py:252, used when no monthly limit is set) | Extra / Ext. | Claude Code — extra usage |
| `cx.five_hour` | 5h / 5h | Codex — 5-hour limit |
| `cx.seven_day` | Weekly / 7d | Codex — weekly limit |

Codex ids come from `_CODEX_IDS` (model.py:282), and unknown windows
come through as `cx.window{n}`. Unknown ids fall back to the backend
`label` with the provider prefix stripped.

#### 4.18.2 Strip anatomy (left side of the bottom bar)

```
Tokens Used │ ✳ Claude Code  Session ▬▬▬▬▬▬ 62% ⏳ 4:41 PM   Weekly ▬▬ 34%   Sonnet ▬▬▬▬▬▬ 100% ⛔   Monthly ▬▬▬ 62%  │ ‹› Codex  5h ▬ 18%   Weekly ▬▬▬ 58%
```

- **Section label "Tokens Used":** 11/600 `--fg-dim`, followed by a 1×14
  `--border-strong` divider. It is always shown, and the strip can't be
  hidden (user decision; this removes `usage.collapse.toggle` and the
  chevron, overriding P-59's "can be collapsed manually").
- **Provider group:** the agent glyph (12px, provider hue) + provider
  name 11/500 `--fg`, then its quotas. Groups are separated by a 1×14
  divider with 12px gutters.
- **Quota item** (gap 5):
  - label 11/400 `--fg-dim`
  - meter: 40×4 (full) or 24×4 (short), `--radius-xs`, `--meter-track`
  - pct: 11/500 tabular, min-width 4ch, right-aligned
  - optional state icon (12px)
  - items are separated by 12px
- Severity styles:

| State | Meter fill | Pct text | Icon | Extra |
|---|---|---|---|---|
| ok | `--fg-dim` | `--fg-dim` | none | calm, not green |
| yellow (≥50) | `--warn-fill` | `--warn` 600 | none | |
| red (≥80) | `--danger` | `--danger` 600 | none | |
| **pace warning** (any level) | per level | per level | `hourglass` `--warn-fill` | full width: "4:41 PM" in 11/500 `--warn` after the icon (the projected run-out time, from the projection) |
| **hit** | `--danger`, full | "100%" `--danger` 600 | `nosign` `--danger` | label gets 600 weight |
| stale / fetch failed (P-56) | track only | "—" `--idle` | `exclamationmark.triangle` `--idle` | tooltip gives the error / "showing data from 12m ago" |
| provider inactive (P-53) | — | — | — | the group collapses to name + "Not running" 11 `--idle` |
| dollars shown (`$`, P-58) | — | — | — | append " · $12.50" 11 `--fg-dim` in full width only |

- The pace warning is deliberately a **different kind of mark** (an icon
  plus a time) than severity (a color). A 34% weekly quota that's on pace
  to run out is visibly flagged even though its bar is calm.
- Motion: meter width transitions `--dur-3`. No pulsing. Reduced motion:
  no transition.
- Each quota item is a focusable button (tab order after the session
  list) that shows its tooltip on focus. Click or Enter opens Usage
  scrolled to that limit.
- **Tooltip text** (§4.19), built from the fields and never abbreviated:
  - Title: `Claude Code — 5-hour session limit`
  - Body: `62% used · resets today at 5:15 PM`
  - Warning line (in `--warn`): `On pace to run out at 4:41 PM, before
    it resets`
  - Hit line (in `--danger`): `Limit reached · resets Sunday at 7:00 PM`
  - The reset phrase comes from `reset_at` formatted locally
    ("today/tomorrow/weekday at h:mm AM/PM").
  - The run-out time: `projection` currently carries only `text` ("on
    pace to hit session limit Today at 4:41pm"). **T040 needs either a
    small backend addition `projection.at` (ISO time)**, or else it
    shows the backend text verbatim in sentence case. I recommend the
    backend field, since parsing prose is brittle.

#### 4.18.3 Token alert chip (toolbar)

It shows the single worst state across both providers. Priority: hit >
pace warning (earliest run-out first) > red > yellow > ok.

| Worst state | Chip content | Style |
|---|---|---|
| ok | `gauge` icon only | `--fg-dim`; tooltip "Tokens used: all limits OK" |
| yellow | `gauge` + "Claude weekly 62%" | text `--warn`, bg `color-mix(in srgb, var(--warn-fill) 14%, var(--bg-chrome))` |
| red | `gauge` + "Claude session 84%" | text `--danger`, bg danger 12% mix |
| pace | `hourglass` + "Claude session runs out ~4:41 PM" | text `--warn`, same bg as yellow |
| hit | `nosign` + "Claude Sonnet limit reached" | text `--danger`, danger 12% mix |

- More than one alert: append "+2" in 11/600, and the tooltip lists all
  of them (one line each, in the §4.18.2 wording).
- The chip uses the provider word ("Claude"/"Codex"), never "CC"/"CX".
- The chip is `flex: 0 1 auto` with text ellipsis, at min-width icon + 6ch.
  Below 820px it shows the icon only (+ the count). The tooltip always
  carries the full text.
- Click → Usage (P-21). The waiting pill keeps precedence in width
  (it's the product's primary signal).

#### 4.18.4 Collapsing at narrow widths (container query on the bar)

| Bar width | Strip form |
|---|---|
| ≥ 1100px | full: full labels, 40px meters, pace time shown, hints + counts on the right |
| 900–1099 | full labels, 40px meters, pace **icon** only (time in tooltip); hints drop |
| 720–899 | short labels ("5h", "7d", "Son.", "Mo."), 24px meters; counts drop |
| 480–719 | **worst-per-provider:** `✳ Claude ▬ 100% ⛔  ‹› Codex ▬ 58%`, 24px meter. The tooltip lists every quota for that provider; the label shortens to "Tokens" |
| < 480 (shell min is 480) | the same as above, without the label |
| compact panel | not shown (the panel stays a pure session list); the NSPanel title bar is unchanged |

Pages (Usage/Settings/Diagnostics) keep the strip; Onboarding hides the
whole bottom bar (§4.15).

### 4.19 Tooltip component

There is one component for every abbreviation, icon-only control, glyph,
chip, badge, meter, and sparkline. It replaces native `title` for those.

- **DOM:** a single `<div id="tooltip" role="tooltip">` appended to body.
  Targets declare `data-tip="…"` (plain text), or `data-tip-id` pointing
  at a structured builder (quota items, agent badges). While a tooltip is
  shown, its target gets `aria-describedby="tooltip"`. Content is always
  set with `textContent` / `h()`, never innerHTML, per the index.html
  sprite comment's rule that session data is never inserted as HTML.
- **Look:**
  - `--bg-popover`, 1px `--border-strong`, `--shadow-2`, `--radius-s`
  - padding `6px 8px`, **max-width 320px**, wrapping
  - title line 12/600 `--fg`; body 12/400 `--fg`; secondary lines 11
    `--fg-dim`; warning/danger lines in `--warn` / `--danger`
  - no arrow
- **Placement:** below the target, centered, 6px offset. It flips above
  when there isn't room, and is clamped 8px inside the viewport. Targets
  in the bottom bar default to above.
- **Timing:**
  - pointer: show after **500 ms** of hover; while "warm" (another
    tooltip closed within the last 300 ms), show immediately
  - hide 100 ms after the pointer leaves both the target and the tooltip
    (the tooltip itself is hoverable, WCAG 1.4.13)
  - no hide timeout while hovered
- **Keyboard:**
  - show immediately on `:focus-visible`, hide on blur
  - **Esc** hides an open tooltip and is consumed only then (if no
    tooltip is open, Esc keeps its normal meaning)
  - never steals focus
- **Motion:** opacity `--dur-1` in and out. Reduced motion: instant.
- **Rules:**
  - icon-only buttons keep their `aria-label`, and the tooltip repeats
    it with the shortcut ("Refresh now  R")
  - glyph tooltips say the state in words ("Waiting for you · 4 min")
  - tab labels say "iTerm2 window 1, tab 1"
  - the chip tooltip is the project name + "iTerm2 tab color: blue"

---

## 5. Window chrome and platform fit

### 5.1 Title bar

Today the window is a standard titled window
(`styleMask: [.titled, .closable, .miniaturizable, .resizable]`,
WebWindows.swift:124-127). That means a native title bar of roughly 28pt
reading "Everwatch", with the 52px web toolbar under it. The result is
~80px of chrome and the name shown twice.

- **Default (no Swift change, part of WP-B):** shrink the web toolbar to
  44px, hide the brand in shell mode, and give `--bg-chrome` a value
  close to the native title bar tone so the two bars read as one band.
  I have not measured the native title-bar color under WKWebView; tune
  it by eye in the real app (the implementer must look at the built app,
  which is out of bounds for this headless task).
- **Optional (WP-E, spike first):** a unified title bar.
  - Swift: `window.styleMask.insert(.fullSizeContentView)`,
    `window.titlebarAppearsTransparent = true`,
    `window.titleVisibility = .hidden`, plus an empty
    `NSToolbar` with `window.toolbarStyle = .unified`, so the traffic
    lights center in a 52pt band.
  - Web: `--toolbar-h: 52px` and `padding-left: 80px` on the toolbar
    when `html[data-shell="1"][data-titlebar="unified"]`.
  - Risk, unverified: WKWebView consumes mouse-downs, so the web toolbar
    wouldn't drag the window. Candidate fix: a bridge message on
    mousedown in empty toolbar areas that calls
    `window.performDrag(with: NSApp.currentEvent!)`. It is unconfirmed
    whether `currentEvent` is still the mousedown by the time the
    async message handler runs. The spike must prove dragging,
    double-click-to-zoom, and full-screen before this ships.
    `NSApp.appearance` mirroring (§3.6 DESIGN.md) is unaffected.
- The compact NSPanel keeps its utility title bar; its web content has
  no toolbar.

### 5.2 Native touches

- `user-select: none` on chrome (already done).
- `cursor: default` everywhere except text (already done).
- Scrollbars: rely on overlay scrollbars. Don't style them.
- Selected rows go gray when the window resigns key (§4.3).
- Button labels are Title Case ("Go to Session", "Check Again", "Skip
  for Now", "Clear Filter"). Section labels are sentence case.

---

## 6. Density at narrow widths

| Width | Behavior |
|---|---|
| ≥ 1280 | Sidebar docked 216. List `split_ratio` (default .42). Everything shown. |
| 1100–1279 | Same. Tokens Used strip at full form (§4.18.4). |
| 900–1099 | Search 160–200px. Tokens Used: pace time moves into the tooltip; footer hints drop. |
| < 900 | Sidebar overlays with `--shadow-2` (teammate). Split falls back to list + mini-strip (existing). Status shows the dot only below 820px. |
| < 760 | List view drops the path column. (Row activity strips are off by default at every width.) |
| < 640 | Sort becomes an icon button. The search field shrinks to `flex: 1 1 120px`, min 96. |
| < 540 | Refresh and New hidden (as today; ⌘K still has them). Sidebar `min(216px, 80vw)`. |
| 720–899 / < 720 | Tokens Used switches to short labels, then to worst-per-provider (§4.18.4). The token alert chip shows the icon only below 820. |
| Compact 320 | §4.4. |

---

## 7. Before and after, per screen

| Screen (ref) | Before | After |
|---|---|---|
| Split (`d-M-split`, `l-M-split`) | Saturated amber selected row, kind-colored selections, 4 name colors, floating preview card with a colored top bar and border, 52px toolbar + brand + 13-hint footer | Tinted neutral selection with the amber bar kept, all names `--fg`, flat preview pane with hairline, 44px toolbar, no brand in the shell, 4-hint footer. See `$MOCK/split-{dark,light}.png`. |
| List (`d-M-list`, `d-S-list`) | 36px rows, `···` badges, useless path tails at 720 | 30px rows, fixed chip column, no plain-shell badge, path dropped below 760 |
| Grid (`d-M-grid`) | Dimmed tiles (AA fail), 2px amber borders, 5px inset spark bar | Full-opacity tiles, 1px borders, waiting head tint + bar, 3px flush spark |
| Zoom (`d-M-zoom`) | Card with amber border inside the content area | Flat full pane |
| Compact (`d-compact`) | Bordered rows, badges | Borderless 28px rows, chip + glyph + name + age |
| Projects (`d-M-split` panel) | Bordered slot cards, italic "Project 4", big "Clear all…" | Source-list rows, color-name placeholders, header "Clear" text button, bare counts |
| Usage (`l-M-usage`, `l-S-usage`) | "CC Session Limit", green meters, heavy grids and shaded future, 2 columns at 720 | "Session", accent meters, 2 gridlines, no shading, 1 column below 820 |
| Settings (`d-M-settings`) | All-caps titles in cards, one card per setting, 3-control hotkey UI | System Settings groups, inset separators, one recorder field |
| Diagnostics (`d-M-diagnostics`) | 13 cards, literal backticks, underlined link-button | One grouped list with status icons, `<code>` spans, consistent buttons |
| Onboarding (`*-onb-*`) | Toolbar and footer visible, half-empty card, primary "Skip", sticky nav band overlapping content | Full-window card with an internal footer, progress segments, primary = the step's action, "Skip for Now" plain |
| Empty states (`*-empty-*`) | Violet glow, 84px shadowed tile, violet icons | Neutral 56px circle, status-tinted icon, plain steps list |
| Palette (`d-M-palette`) | Flat mixed list, "Navigate" group words | Sessions/Commands sections, glyph + chip on sessions, tinted active row |
| Help (`d-M-help`) | Violet all-caps headings, 2px-bottom keycaps | Neutral sentence-case headings, flat keycaps, Status legend row |
| Context menu (`d-M-ctxmenu`) | No shortcuts, no separators, doesn't select the row | Shortcut column, 3 groups, native accent highlight, selects on open |
| Toast (`d-M-toast`) | Pill covering the preview title | 32px rounded-8 toast with a status icon, 8px under the toolbar |
| Confirm (`l-M-confirm`) | 420px, double focus ring | 320px alert rhythm, single ring |
| Status popover (`d-M-statuspop`) | Pinned at `left:170px` | Anchored under the chip |
| Quotas (toolbar `CC 100% CX 58%`) | One % per provider, collapsible, CC/CX only | Always-visible "Tokens Used" strip with every limit, severity color, pace icon + time, full-name tooltips; toolbar chip shows the single worst alert |
| Agent kind (`CC`/`CX` pills) | Two-letter 9.5px/750 pills; lost on selected rows | "✳ Claude" / "‹› Codex" opaque badges, AA in every row state; glyph-only form with tooltip in tight spots |
| Logo / icon (`logo/current/sheet.png`) | Two unrelated marks, a fake Dock badge, SF `eye` in the menu bar | One "Watch ring" mark across icon, favicon, in-app, menu bar template, and README |

---

## 8. Implementation plan

Rules for all WPs:

- Each WP is one PR.
- Each regenerates `docs/screenshots/*.png` via `node scripts/screenshots.mjs`.
- Each runs `make test` locally (the implementer does; this spec did not
  run it).
- When a WP changes asserted presentation, it updates only the specific
  e2e expectations named, and cites the decision.

To keep the parallel WPs from colliding in one 1,400-line file, **WP-A
first splits css/app.css** (no rule changes) into
`css/base.css` (reset, focus, icons, buttons, controls, kbd),
`css/chrome.css` (toolbar, status bar, toasts),
`css/sessions.css` (split, rows, list, grid, preview, compact, projects),
`css/overlays.css` (palette, help, dialogs, menus, popovers), and
`css/pages.css` (usage, empty states; settings.css stays). All are linked
in index.html in that order. CSP is unaffected (`style-src 'self'`).

| WP | Scope | Files | Depends on | Tests touched | Size |
|---|---|---|---|---|---|
| **WP-A: Foundations** | CSS split (mechanical); all §3 tokens (type, spacing, radii, elevation, color, motion) with aliases; `CONTRAST_PAIRS` update; §4.1 icon sprite redraw with CSS stroke widths; §4.8 buttons, inputs, select, segmented, toggle; §4.12 kbd; remove press-scale; focus ring | tokens.css, app.css → 5 files, settings.css (toggle), index.html (sprite, links), js/lib/theme.mjs | nothing; can start now (stay out of the projects/row rules the teammate is editing) | tests/js/theme.test.mjs (pairs), visual-only elsewhere | 1 senior, ~2–3 days |
| **WP-B: Main window** | §4.2 toolbar (brand hidden in shell, status never truncates, page-route hiding), §4.10 bottom bar shell (counts, 2-hint subset, legend removal, drop order; T040 fills the quota strip), §4.17 agent badge (refining T037), §4.3/§4.4/§4.5/§4.6 rows, list, compact, grid, preview, §4.7 sidebar styling, §6 breakpoints | chrome.css, sessions.css, index.html (toolbar/footer markup), header.mjs, footer.mjs, keymap.mjs (`footer` flag), row.mjs (chip slot, no plain badge), preview.mjs (pill text, meta project name), grid.mjs, compact.mjs, projects.mjs (color-name placeholder, count text), split.mjs (splitter hairline) | WP-A **and the teammate's projects/session-row work landing** (same rules and files) | rows.spec (P-38 color/weight asserts, per D1), chrome.spec (legend/hints, D2), header.spec (brand/counts, D3), projects.spec (Clear all label), grid.spec, compact.spec | 1 senior, ~3–4 days; may split B1 (chrome) / B2 (sessions) across two people |
| **WP-C: Overlays + tooltips** | **§4.19 tooltip component (lands first, since T040 and WP-B consume it)**; §4.9 context menu (shortcut column, separators, select-on-open, highlight), status popover anchoring, §4.11 palette sections, help sheet with Status legend, dialogs, §4.13 toasts (no show/hide toasts, 3.5 s auto-dismiss with hover pause) | overlays.css, chrome.css (toasts), new views/tooltip.mjs, commands.mjs (drop show/hide toasts), contextmenu.mjs, palette.mjs, help.mjs, toasts.mjs, header.mjs (popover position only), confirm.mjs, index.html (dialog markup) | WP-A | palette.spec, input.spec/views.spec where they assert menu text, chrome.spec (help) | 1 mid/senior, ~2 days |
| **WP-D: Pages** | §4.16 page shell + back button, §4.14 usage cards/meters/charts and label stripping, §4.15 settings groups + hotkey recorder field, diagnostics grouped list + `<code>` rendering, onboarding card/footer/progress/CTA rules + chrome hiding, empty states | pages.css, settings.css, usage.mjs, settings.mjs, diagnostics.mjs, diag_actions.mjs, onboarding.mjs, automation_illo.mjs (token pickup only), empty.mjs, main.mjs (route → `data-view` already set; hide chrome for onboarding) | WP-A | usage.spec, settings.spec, diagnostics.spec, onboarding.spec ("Skip" → "Skip for Now" / Continue naming), quota.spec, preview-wp7.spec ("Back to sessions" name kept via aria-label) | 1 senior, ~3 days |
| **T040: Tokens Used strip + alert chip** (separate engineer, already assigned) | §4.18 in full: strip in the bottom bar, severity and pace states, tooltips, container-query collapse, toolbar alert chip; remove `usage.collapse.toggle` and the chevron; optional backend `projection.at` | chrome.css, new views/tokens.mjs (from quota.mjs / the usage-strip code in header.mjs), header.mjs, footer.mjs, commands.mjs + keymap.mjs (remove collapse), lib/format.mjs (limit names, reset phrases), everwatch/model.py + engine/projection.py only if `projection.at` is added | WP-A tokens, WP-C tooltip, and the projects work landing | usage.spec / quota.spec / header.spec for the strip and chip; py tests if `projection.at` is added; P-59 row in DESIGN.md updated (collapse removed by user decision) | 1 mid/senior, ~2–3 days |
| **WP-F: Logo and app icon** | §11: new app icon (CoreGraphics port of logo-app-icon.svg + small-size art), in-app mark and favicon, menu bar template glyph, README header; optional Tahoe `.icon` | scripts/make_icon.swift, shell/AppIcon.icns (regenerated), everwatch/web/img/logo.svg, index.html (`#i-logo` symbol + gradient defs), shell/Sources/App/StatusItemController.swift (+ a small `StatusGlyph.swift` drawing the template image), README.md (header image), docs/screenshots | WP-A only for the in-app mark sizes; the icon parts are independent and can start now | shell tests (InfoPlistTests unaffected unless a `CFBundleIconName` is added); a new make_icon smoke check that all 10 PNGs are written; scripts/screenshots.mjs regenerated | 1 mid, ~1–2 days (+1 day for the `.icon` if Xcode 26 is available) |
| **WP-E: Unified title bar (optional)** | §5.1 spike, then implementation if it passes: window style, drag bridge, 52px toolbar with an 80px traffic-light inset | shell/Sources/App/WebWindows.swift, shell bridge handler, web/js/bridge.mjs, main.mjs (`data-titlebar`), chrome.css | WP-B | scripts/shell_selftest.sh; manual check of drag, zoom, and full-screen in the real app | 1 senior, 1 day spike + 1 day |

Order: WP-A → WP-C's tooltip → (rest of WP-C ∥ WP-D) → WP-B and T040
once the teammate lands → WP-E if approved. WP-F can run any time in
parallel. WP-C and WP-D don't touch the rules the teammate is editing, so
they can start as soon as WP-A merges.

Per-WP acceptance:

- `make test` green, including the AA test with the new pairs.
- Screenshots regenerated and eyeballed in both themes at 1440, 1180, and
  720.
- No literal hex, px font sizes, radii, or shadows outside tokens.css.
  Check with
  `rg -n "#[0-9a-f]{3,6}\b|font-size: *[0-9]|border-radius: *[0-9]|box-shadow: *0" everwatch/web/css --glob '!tokens.css'`.
  Allowed exceptions: 0/1px widths, `50%` radii, `#fff` knob.
- Reduced motion checked with `reducedMotion: 'reduce'`.

---

## 9. Decisions needed from the owner (before WP-B/WP-D merge)

- **D1: Row coloring vs parity P-38/P-35 (`=`).**
  - **A (recommended):** neutral tinted selection for all kinds; names
    always `--fg` (no gold label color, no green fresh name); waiting
    shown by bar + glyph + amber age + 600 weight; flash = soft amber;
    no `···` badge on plain shells.
  - **B (parity-preserving, calmer):** keep the rules but render them
    quietly: kind-tinted selection bgs (`--sel-claude-bg` dark `#2a2046`
    / light `#f0e9fc`, codex `#132846` / `#e8f0fd`) with `--fg` text;
    label and fresh name colors kept; waiting+selected = `--bg-selected`
    + bar.
  - B's Claude hexes, checked with `contrastRatio`: dark `#2a2046` gives
    fg 12.79, fg-dim 5.88, idle 4.64, attention 8.17, busy 8.02. Light
    `#f0e9fc` gives fg 14.24, fg-dim 5.35, **idle 4.40 (fails)**,
    attention 5.01, busy 4.88. So the idle→fg-dim rule in §4.3 applies
    under B too.
  - rows.spec.mjs lines 65–100 compare against `cssVar(...)`, so the
    value changes pass automatically. The `font-weight: 700` assert
    (line 76) and the on-attention name color (line 100) need updating
    under either option.
- **D2: Footer legend removal and a 2-hint subset** that drops first at
  narrow widths (the Tokens Used strip owns the bar). The legend moves
  into the help sheet and tooltips. chrome.spec.mjs asserts both.
- **D3: Brand and counts (P-19 `~`).** Hide the logo and name in shell
  mode; move the counts to the status bar.
- **D4: resolved by the user.** The quota strip is always visible and
  labeled "Tokens Used" (§4.18). The collapse chevron and
  `usage.collapse.toggle` are removed. DESIGN.md P-59 needs a note.
- **D5: Title Case button labels.** "Go to Session", "Check Again",
  "Skip for Now". Tests that match text by role/name need updating, or
  the old names can be kept as `aria-label`.

---

## 10. Open items and uncertainty

- The native title-bar color next to `--bg-chrome` (§5.1) was not
  measured. It needs a look in the real app, which this headless task
  could not open.
- Whether the window key state is available to the page as a DOM flag
  (§4.3 inactive selection) is unverified. `onKeyChange` exists in
  WebWindows.swift, but I haven't traced whether it reaches the page.
- The WP-E drag bridge is an unproven approach (§5.1).
- `projection` has no machine-readable run-out time. T040 wants
  `projection.at` (§4.18.2); without it, the tooltip shows the backend
  text.
- Container-query support in the macOS 13 WKWebView baseline is assumed,
  not verified. §4.10 gives a ResizeObserver fallback.
- The macOS 26+ legacy-icon treatment of the current `.icns` has not
  been observed here (§11.4 item 5). The `.icon` path needs Xcode 26,
  which isn't installed.
- The tile/grid activity strip default (off) is my extension of T037's
  row decision (§4.5). Confirm it with the owner.

---

## 11. Logo and app icon

### 11.1 What exists today

Renders are in `$SHOTS/../logo/current/sheet.png`: the app icon from a
scratchpad build of scripts/make_icon.swift, plus the web logo.

| Mark | Source | Problem |
|---|---|---|
| App icon | scripts/make_icon.swift (CoreGraphics, 1024 canvas, correct 824/100 grid) → scripts/make_icon.sh → iconutil → shell/AppIcon.icns | Violet iris ties the brand to Claude only. The amber outline is 34/1024 ≈ 0.5px at 16px. The fake notification badge competes with the real Dock badge. |
| Web logo / favicon | everwatch/web/img/logo.svg and the `#i-logo` sprite symbol (index.html) | A different design from the app icon (gradient tile, white sclera) |
| Menu bar | StatusItemController.swift:37 `NSImage(systemSymbolName: "eye")`, template, alpha .55 when idle | The system glyph, so there's no brand; "eye" also reads as "show/visibility" |
| README | none | |

### 11.2 Three concepts

All are drawn on Apple's macOS icon grid:

- 1024 canvas, 824 body at 100 margin, corner radius ~185
- layered depth: a tile gradient + top edge highlight, foreground layers
  with soft drop shadows
- separate small-size artwork for 16/32px
- a monochrome 18pt template glyph for the menu bar

Renders at 1024 / 128 / 32 / 16px, on light and dark, with the 16px
image zoomed ×6 and the menu glyph shown on light/dark menu bars:
`$SHOTS/../logo/c/sheet.png`. Individual PNGs:
`$SHOTS/../logo/c/c{1,2,3}-{1024,128,32,16}.png`,
`c{1,2,3}-small-{32,16}.png`, and `c{1,2,3}-menu-{18,36}.png`. SVG
sources are next to them.

| | C1 "Vigil eye" (refined current) | **C2 "Watch ring"** (recommended) | C3 "Bezel" |
|---|---|---|---|
| Idea | A clean almond eye, white sclera, amber pupil, on a graphite tile | A 3/4 arc (the in-app *busy* spinner) around an amber core (the in-app *waiting* dot) on a graphite tile. "Ever" = the unbroken watch loop; amber = "someone needs you". | A watch dial whose ticks are sessions (gray idle, green busy, one amber waiting) and whose hand points at the waiting one |
| At 1024/128 | Clear, friendly | Distinctive silhouette; reads as "live / on watch" | The richest story |
| At 32/16 | Legible | **Legible**: two shapes, high contrast | **Breaks down**: ticks turn to noise (see the ×6 zoom) |
| Menu glyph | Identical in spirit to SF `eye`, so no brand gain | Arc + dot: unique, crisp at 18pt | A speckle of dots |
| Risks | Surveillance connotation; generic (many "eye" apps); reads as "visibility" | Abstract, so it needs the name beside it the first time; at a glance it could evoke a power/record button (mitigated by the off-axis gap and the dark tile) | Recreates the multi-color traffic-light clutter the UI is removing |
| Fit with the visual system | Neutral | **Best: the icon *is* the app's two key state glyphs** | Poor |

**Recommendation: C2 "Watch ring".**

- It is the only concept that survives 16px *and* the menu bar template
  without special-casing.
- It is built from the product's own visual language, so the icon
  teaches the busy and waiting glyphs.
- It drops the Claude-only violet.
- It leaves the top-right corner free for the real Dock badge.
- Its three layers (tile, arc, core) map one-to-one onto Icon Composer
  groups for the macOS 26+ layered-icon treatment.

Fallback if the owner wants continuity with today's eye: C1.

### 11.3 Final artwork (source of truth, in this directory)

| File | Use |
|---|---|
| `docs/design/logo-app-icon.svg` | app icon, full art (iconset slots ≥ 64px) |
| `docs/design/logo-app-icon-small.svg` | app icon, small art (16px, 16@2x = 32px, 32px slots): thicker arc, bigger core, no track/glow/shadows |
| `docs/design/logo-menubar-template.svg` | menu bar template glyph (18×18pt, black on transparent) |
| `docs/design/logo-mark.svg` | in-app mark + favicon (32-unit, full-bleed tile), replaces everwatch/web/img/logo.svg and `#i-logo` |

The in-app mark was checked rendered at 16/20/32/56px on both toolbar
tones (`$SHOTS/../logo/mark.png`). All four files parse as valid XML.

Palette: tile `#383a42 → #131417` (top to bottom); arc `#ffffff →
#c4c8d2`; core `#ffd978 → #ffaf00 → #ea8a00` (the product's attention
amber). No violet, no blue.

`logo-mark.svg` (inline for convenience):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs><linearGradient id="ew-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#383a42"/><stop offset="1" stop-color="#131417"/></linearGradient></defs>
  <rect width="32" height="32" rx="7.2" fill="url(#ew-tile)"/>
  <circle cx="16" cy="16" r="8.9" fill="none" stroke="#f4f5f8" stroke-width="3.6" stroke-linecap="round" stroke-dasharray="39 56" transform="rotate(-20 16 16)"/>
  <circle cx="16" cy="16" r="4.6" fill="#ffaf00"/>
</svg>
```

Geometry for porting the full art (1024 canvas, SVG y-down):

- center (512, 512)
- track: circle r 248, stroke 76, white at 10%
- arc: same circle, round caps. It starts at screen angle −20° (20°
  above 3 o'clock) and sweeps **254°** clockwise on screen, so the gap
  sits in the upper-left (~234°→340°). Stroked with a white →
  `#c4c8d2` diagonal gradient.
- glow: radial, r 200, amber at 45% → 0
- core: r 118, radial gradient centered at (38%, 34%) of its box
- shadows: tile dy 14 / blur 16 / 32% black; arc and core dy 10 /
  blur 12 / 45%
- edge highlight: a 3px inset stroke, white 22% → 0 top to bottom

### 11.4 What WP-F must change

1. **scripts/make_icon.swift:** replace the eye drawing with the §11.3
   geometry.
   - CoreGraphics is y-up: flip the context, or mirror the angles.
   - To get a gradient stroke, use `replacePathWithStrokedPath()` + clip
     + `drawLinearGradient`.
   - Use the small art for the `icon_16x16`, `icon_16x16@2x` and
     `icon_32x32` slots (pixels ≤ 32), and the full art for the rest.
   - Keep the headless CG approach. Don't add a node/Playwright
     dependency to the build.
   - Regenerate shell/AppIcon.icns with `scripts/make_icon.sh`.
   - Optionally, write a 256px PNG to `docs/screenshots/app-icon.png`
     for the README.
2. **everwatch/web/img/logo.svg** ← `logo-mark.svg`. In index.html,
   replace the `#i-logo` symbol with the same drawing (viewBox 0 0 32 32)
   and delete the `#logo-grad` gradient. Keep the gradient id unique
   (`ew-tile`) because the sprite shares the document.
3. **Menu bar** (StatusItemController.swift:36-40): replace
   `NSImage(systemSymbolName: "eye")` with an 18×18pt template image
   drawn in code from `logo-menubar-template.svg`:
   - `NSImage(size:flipped:drawingHandler:)`, arc stroke 2pt with round
     caps plus a filled dot r 2.6
   - `isTemplate = true`, `accessibilityDescription = "Everwatch"`
   - Keep today's behavior (dim glyph when idle, count text when
     waiting).
   - Drawing in code avoids a resource bundle. I haven't confirmed
     whether `NSImage` loads SVG natively on the macOS 13 baseline, so
     don't rely on that.
4. **README.md:** add a centered header image, the 128px app icon or
   `everwatch/web/img/logo.svg` at 96px, above "# Everwatch".
5. **macOS 26+ (optional, external dependency):** per public reports,
   Tahoe renders legacy `.icns`-only icons smaller and/or on a gray
   squircle plate ([heise](https://www.heise.de/en/news/Icons-in-macOS-26-Fighting-the-Squircle-Prison-11075561.html),
   [9to5Mac](https://9to5mac.com/2025/08/08/macos-tahoe-fix-gray-box-icons/),
   [Successful Software](https://successfulsoftware.net/2025/09/26/updating-application-icons-for-macos-26-tahoe-and-liquid-glass/)).
   - I haven't verified this on this machine or with Everwatch's icon.
   - The native fix: an Icon Composer `.icon` (layers: tile / arc /
     core), compiled with `xcrun actool` into `Assets.car`, plus
     `CFBundleIconName` in shell/Info.plist, keeping `AppIcon.icns` for
     macOS 13–15.
   - **This machine has only the Command Line Tools
     (`xcrun --find actool` fails)**, so this step needs full Xcode 26+.
   - shell/Tests/InfoPlistTests.swift would gain a `CFBundleIconName`
     expectation.
