# Everwatch — Design

Everwatch is a native-feeling macOS app that watches your iTerm2 sessions and
tells you which AI coding agent (Claude Code, Codex) needs you. It reimagines
[ultrawatch](https://github.com/burnsbert/ultrawatch-for-iterm2) (a curses
TUI, v1.2.3) as a graphical app in its own window.

Source of truth for parity: the public `ultrawatch-for-iterm2` implementation. Every
behavior below comes from reading the source (`ultrawatch_lib/**`), not only
its README. File references like `heuristics.py:40` point into that repo.

**Hard rules, repeated here because every ticket must honor them**

1. **No sound, ever, in dev or tests.** A "sound on attention" option exists
   for parity with ultrawatch's `b` bell. It defaults off, lives only in the
   Swift shell, and is hard-disabled when `EVERWATCH_NO_SOUND=1`, which every
   test harness sets. The web UI and the Python backend have no way to make
   sound (enforced by a lint test, see §5).
2. **Tests stay headless.** No `screencapture`, no launching `Everwatch.app`,
   no driving or focusing real windows. No test may call real `osascript`,
   `ps`, `lsof`, `security`, or the network (enforced by a guard, see §5).
3. **Runtime has zero third-party dependencies.** Python stdlib (3.9+),
   vanilla ES modules, and a Swift shell built with Command Line Tools
   (CLT) only. npm packages are allowed as dev-only dependencies for tests.
4. **MIT license.**

---

## 0. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Engine and backend | Python 3.9+ stdlib package `everwatch/`. It ports the ultrawatch engine and serves a localhost HTTP JSON + Server-Sent Events (SSE) API through a pluggable **DataSource** (real iTerm2, demo, or test fake). | The engine is proven, has 163 passing unit tests, and needs no dependencies. `/usr/bin/python3` is 3.9.6 here, so 3.9 compatibility can be tested. |
| UI | Vanilla ES modules, HTML, and CSS with **no build step**. The Python server serves them from package data. | Keeps install foolproof and the runtime dependency-free. WKWebView supports ES modules. |
| Native shell | `Everwatch.app`: about 600 lines of Swift (AppKit, WKWebView, UserNotifications, Carbon hotkey), built with **`swiftc` directly** (not SwiftPM) and ad-hoc signed. | SwiftPM is broken on this CLT (see §5.4). `swiftc` builds the shell in about 1 s and makes universal binaries. |
| Fallback | `everwatch open` serves the UI and opens it in the default browser. | Works without the shell, but has no menu bar, native notifications, or hotkey. |

**How this differs from the coordinator's prior, and why:**

1. **No SwiftPM.** Its manifest step fails to link on this CLT. Everything is
   built with `swiftc` from a Makefile, and Swift tests use Swift Testing
   through `swiftc` (verified to work).
2. **The runtime payload lives outside the `.app` bundle.** The Python
   package and web assets go in `~/Library/Application Support/Everwatch/runtime/`.
   An ad-hoc signature's designated requirement is only the executable's
   cdhash (measured below), and TCC keys the Automation grant to that
   requirement. Anything sealed inside the bundle would change the cdhash on
   every update and silently re-prompt, or leave phantom permission rows.
   With the payload outside, the shell rarely changes, so the grant survives
   engine and UI updates.
3. **The shell runs its own SSE client** for the menu bar and notifications,
   so they keep working when the window is closed. Notification policy is
   decided in Python, where it can be tested; the shell only renders.
4. **The shell checks Automation permission natively** with
   `AEDeterminePermissionToAutomateTarget(askUserIfNeeded:false)`, so it can
   tell "not asked yet" from "denied" without triggering a prompt.
5. **Tab colors use a private venv** at
   `~/Library/Application Support/Everwatch/venv` with `pip install iterm2`,
   instead of ultrawatch's `--break-system-packages` fallback.

**Alternatives rejected:**
- **All-SwiftUI app:** no Xcode, SwiftPM is broken, it would mean rewriting a
  tested engine, and its UI can't be tested headlessly.
- **Electron or Tauri:** large downloads and toolchains, which contradicts
  "foolproof install".
- **Chrome app-mode only:** no menu bar or hotkey, and TCC would attribute
  Apple Events to Chrome.

---

## 1. Feature parity matrix

Status key: **=** same behavior, **~** adapted to the GUI, **N/A** doesn't
apply to a GUI (with the reason). "Test" names the layer that must cover the
row: `py` (Python unit), `js` (JS unit), `e2e` (Playwright), `sw` (Swift
Testing). `scripts/check_parity.py` fails the build if any P-id listed here
has no test tagged `P-xx`.

### 1a. Engine: polling, iTerm2, and agents

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-01 | Batched snapshot AppleScript every 2 s. Collection queries fetch window id, unique id, tty, is processing, name, and full screen text. Records are framed with US (0x1f) and RS (0x1e). `missing value` becomes empty. Malformed records are dropped (`iterm.py:37-70,160-185`). | Ported as-is into `engine/iterm.py` and wrapped by `RealSource.fetch_snapshot`. | = | py |
| P-02 | Adaptive cadence: the next poll waits `max(interval, 2×elapsed)` (`pollers.py:66-70`). | Same, inside `ItermWorker`. | = | py |
| P-03 | A single worker serializes every osascript call. Actions drain between polls and force an immediate re-poll (`pollers.py:37-113`). | Same. HTTP handlers enqueue actions and never call osascript directly. | = | py |
| P-04 | Scripts go to `osascript -` on stdin with arguments in argv. Nothing is interpolated into the script. 10 s timeout (`iterm.py:147-156`). | Same. | = | py |
| P-05 | Paths loop reads iTerm2's `path` session variable every 10 s. It keeps the last value on failure and drops dead sessions (`iterm.py:72-95`, `app.py:104,136`). | Same. | = | py |
| P-06 | lsof cwd fallback for ttys with no path: the model publishes `needs_cwd_box` and `AgentsPoller` runs `ps` + `lsof -d cwd` (`agents.py:59-97`, `app.py:147-149`). | Same. | = | py |
| P-07 | Agent detection every 5 s from `ps -eo tty,comm,args`. It matches `claude`/`codex` in comm or argv0, `node`/`bun` plus a second argument named claude/codex, or `@anthropic-ai/claude-code` / `@openai/codex` in the first 3 tokens. `??` ttys are skipped. If both agents are on one tty, claude wins (`agents.py`, `app.py:153-161`). | Same. | = | py |
| P-08 | "iTerm2 not running" sentinel. Other osascript failures set an error status (`iterm.py:25`, `pollers.py:84-91`). | Same, plus parsing of error codes: `(-1743)` → `permission_denied`, `(-600)` → `not_running`, `(-1712)` → `timeout`. These feed diagnostics (§4). | ~ | py |
| P-09 | Actions: **goto** selects session, tab, and window, then activates iTerm2. **close** closes by window id + tab index. **new** creates a tab in the current window with the default profile and activates. A failure toasts `{kind} failed: {detail}` (`iterm.py:97-145`, `app.py:118-121`). | `POST /api/sessions/{uid}/goto`, `/api/tabs/{window_id}/{tab_index}/close`, `/api/tabs/new`. The result arrives as an SSE `action_result` event, and failures show a toast. | = | py, e2e |
| P-10 | Manual refresh (`r`) kicks every poller. Usage refetches only if its data is at least 10 s old (`pollers.py:247,290-291`). | `POST /api/refresh`, bound to `r`, ⌘R, and a toolbar button. | = | py, e2e |

### 1b. State heuristics

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-11 | Five states: busy, waiting, idle, active, quiet (`heuristics.py:16-20`). | Same enum, carried in the API as a string. | = | py |
| P-12 | Classifier reads the last 25 non-blank lines bottom-up; the first rule that matches wins. **Claude rules:** `menu-option` `❯ \d+\.\s` → waiting; `permission-question` (Do you want / Would you like to / tell Claude what to do differently) → waiting; `esc-to-interrupt` → busy; `spinner-verb` (glyph + text ending in … or ...) → busy. **Codex rules:** `approval-prompt` → waiting; `esc-to-interrupt` → busy; `working` → busy. **Fallback:** processing → busy, otherwise idle (`heuristics.py:31-80`). | Ported verbatim, including ultrawatch's fixture files. | = | py |
| P-13 | Non-agent sessions are active if processing or changed less than 5 s ago; otherwise quiet (`heuristics.py:128-131`). | Same. | = | py |
| P-14 | Change hash: crc32 of the screen text after stripping spinner glyphs and trailing blank lines (`heuristics.py:57-67`). | Same. The hash is also sent as `screen_hash` so the client can cache screens. | = | py |
| P-15 | Debounce: a new state publishes after 2 identical consecutive classifications. The first observation publishes immediately. The matched rule name updates even when the state doesn't change (`heuristics.py:146-172`). | Same. | = | py |
| P-16 | Attention latch: set when waiting publishes (including a first observation of waiting); cleared on a transition away from waiting or when the user visits the session. Tracks for vanished sessions are dropped (`heuristics.py:136-149,183-186`). | Same. Selecting a session in the UI sends `POST /api/sessions/{uid}/visit`. | = | py, e2e |
| P-17 | `waiting_uids` lists sessions longest-waiting first. The attention count equals the number waiting (`heuristics.py:188-195`). | Sent as `waiting_order` and `counts.waiting` in the state. | = | py |
| P-18 | `UW_DEBUG_STATE=1` shows `rule: <name>` in the preview footer (`config.py:36`, `split_view.py:58-61`). | `EVERWATCH_DEBUG_STATE=1` (also accepts `UW_DEBUG_STATE`) plus a Settings toggle "Show matched rule". Shows a rule chip in the preview header. | ~ | py, e2e |

### 1c. Views and layout

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-19 | Header shows the brand, `N tabs · N agents`, and an amber `· N waiting` when any are waiting (`app.py:431-449`). | Toolbar: an amber "N waiting" pill that runs next-waiting when clicked. The window title and Dock badge show the waiting count. The logo and name show only in browser mode (in the app the native title bar already says "Everwatch"), and the `N tabs · N agents` counts moved to the status bar (VISUAL_SPEC D3). | ~ | e2e |
| P-20 | Header status: **iTerm2 not running** (danger), **STALE** on a query error, **STALE {age}** when the snapshot is older than 4×interval (8 s) (`app.py:450-458`). | A status chip with the same three states, each with a tooltip explaining it and a "Diagnose" link. | ~ | e2e |
| P-21 | Clicking the header opens the usage screen (`app.py:742-744`). | The token alert chip in the toolbar (the single worst quota state, e.g. "Claude Sonnet limit reached +3") opens the Usage view, as does clicking any quota in the status bar's Tokens Used strip. | ~ | e2e |
| P-22 | **Split view:** session list on the left and a live preview on the right. `split_ratio` defaults to 0.42, is clamped to 0.2–0.8, and moves in 0.05 steps with `<` `>` (also `,` `.`). The list is at least 26 columns and the preview at least 32. Toast: `list pane N% of width`. Persisted (`app.py:352-356`, `split_view.py:76-77`). | A draggable splitter plus the same keys and step, clamp, toast, and persisted ratio. Pixel minimums: list 280 px, preview 320 px. | ~ | e2e |
| P-23 | Split view falls back to list view when the terminal is narrower than 100 columns (`config.py:23`, `app.py:407`). | Responsive breakpoint: below 900 px wide, split renders as list. | ~ | e2e |
| P-24 | **List view:** full-width rows. "Window N" group headers appear only in natural sort with more than one window. A bottom strip shows the last 3 lines of the selected session (`❯ {path} ─ last 3 lines`) when the body has at least 10 rows (`list_view.py:125-180`). | Same grouping rule and a 3-line preview strip. | = | e2e |
| P-25 | **Grid view (camera wall):** agent sessions only, falling back to all sessions if there are no agents. `A` toggles all sessions. Empty message: `no agent sessions — press A to show all`. Tiles show the tail with chrome stripped (P-44), are dimmed unless selected, and get a heavy border when waiting. Tile title: glyph, tab, name (basename of `~/…`), badge, age. Arrow keys move ←→ by one and ↑↓ by one row of columns (`grid_view.py`, `app.py:246-250,588-596`). | Responsive CSS grid of tiles with the same content and rules. `A` and a segmented control switch agents/all. | = | e2e |
| P-26 | **Zoom (Space):** full-body preview of the selection. ↑↓ and j/k change the selection while zoomed; any other key exits (`app.py:559-566`, `zoom_view.py`). | Focus mode fills the content area. The same keys work; Esc or Space exits. | = | e2e |
| P-27 | Preview pane: tail of the screen text. Title: path · label · kind · state glyph + STATE + age (no age for busy). Border is amber when waiting, the agent color otherwise, chrome for plain shells. Footer: `live · updated just now` (under 3 s) or `updated Xs ago`, plus hints (`split_view.py:19-80`). | Same content. The preview is a monospace `<pre>` that sticks to the bottom and is selectable, so text can be copied. | = | e2e |
| P-28 | Title card instead of an infinite mirror: shown when previewing its own tab (`tty == MY_TTY`) or any tab whose first line has the `▛▞ ULTRAWATCH` banner. Uses the `▶▶▶` self badge (`title_card.py`, `app.py:215`). | Everwatch doesn't live in a tab. A tab running ultrawatch gets a "UW" badge and a card saying "ultrawatch dashboard". A terminal running `everwatch open` or `everwatch serve` (backend tty == session tty) gets the self badge and an Everwatch card. | ~ | py, e2e |
| P-29 | Empty states: `iTerm2 is not running`, `iTerm2 query failed: …`, `connecting to iTerm2…` (`app.py:460-471`). | Illustrated empty states with action buttons (Launch iTerm2, Diagnose). | ~ | e2e |
| P-30 | Help overlay (`?`) shows two columns of keys; any key closes it (`help_view.py`). | A keyboard shortcut sheet (`?` or ⌘/) generated from the single keymap table, so it can't drift. | ~ | e2e |
| P-31 | Status line: glyph legend, plus `filter: x` when a filter is active. A toast replaces it for 5 s (`app.py:473-494`). | The glyph legend moved to the top of the help sheet and into glyph tooltips; the status bar keeps the neutral `filter: x` chip (VISUAL_SPEC D2). Toasts are stacked, auto-dismiss after 3.5 s, and appear in an accessibility live region. | ~ | e2e |
| P-32 | Context key-hint bar for main, grid, zoom, and usage (`app.py:496-538`). | A short context hint subset in the status bar (main/grid: go to, next waiting, filter, ⌘K commands; other contexts their own hints), dropped first when the Tokens Used strip needs the room; the full list is the help sheet. Can be hidden in Settings. | ~ | e2e |
| P-33 | Toast texts: `◉ {name} is waiting for your input`, `→ tab N`, `no sessions waiting`, `refreshing…`, `sort: X`, `list pane N%…`, `Claude monthly dollar limit shown/hidden`, `bell on/off`, `opening new tab…`, `closing tab N…`, `projects cleared`, `tab colors unavailable — see README`, `tab N: color cleared`, `tab N → {color} ({project})`, `{kind} failed: {detail}`. | Same messages. `bell on/off` becomes `sound on attention: on/off`, and "see README" becomes a "Set up…" link. | ~ | e2e |
| P-34 | The busy spinner animates at 5 fps, only while something is busy (`app.py:814-821`). | CSS animation, turned off under `prefers-reduced-motion`. | ~ | e2e |

### 1d. Session rows, selection, and input

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-35 | Row content: state glyph (◉ waiting / spinner busy / ○ idle / · active / blank quiet), badge (CC, CX, ···), tab label, path (`~`-shortened, left-ellipsized), display name (label, else session name), and a uniform-width age column (`list_view.py:22-70`). | A row component with the same fields. The badge is a word + glyph + hue ("✳ Claude" teal, "‹› Codex" magenta), glyph-only in the compact panel and narrow list view, never "CC"/"CX"; plain shells get a quiet outlined "Shell" badge instead of `···`. Deliberate change: the user asked that Claude Code vs Codex vs plain shell be obvious in every row state, which the two-letter codes weren't. | ~ | js, e2e |
| P-36 | Tab label is `3` with one window and `2.3` with several. The window number is its order of first appearance (`app.py:163-178`). | Same, computed server-side as `tab_label`. | = | py |
| P-37 | Age text: `wait {age}` while waiting; `idle {age}` for idle or quiet sessions with at least 60 s since the last change. Age format: s, m, h, d (`list_view.py:16-26`, `draw.py:91-100`). | Same logic in `web/js/lib/format.mjs`, ticking locally with clock-skew correction. | = | js |
| P-38 | Row colors: selected rows are reversed in an accent (amber if waiting, else agent color, else text). A 1.5 s black-on-amber flash on a transition to waiting. Waiting rows are amber and bold. **Fresh** rows (not busy or waiting, last change more than 5 s after startup and less than 30 s ago) are green. Labels use the label color (`list_view.py:7-14,42-106`). | Same states as CSS classes (`.is-selected`, `.is-flash`, `.is-waiting`, `.is-fresh`, `.has-label`), rendered calmly (VISUAL_SPEC D1-A): one neutral tinted selection for every kind (gray when the window isn't key), waiting = 3px amber bar + amber age + 600 weight on a soft tint (the bar stays when selected), flash = soft amber, fresh = green age text, names always `--fg`. Kind is shown by the explicit agent badge instead of the selection color. Deliberate change: reversed amber/agent-colored fills made amber mean two things and failed AA in light mode. | ~ | js, e2e |
| P-39 | A tab-color dot next to the badge when the session has an iTerm2 tab color (`list_view.py:95-97`). | Colored dot using the exact iTerm2 preset RGB values. Its tooltip names the color and project. | = | e2e |
| P-40 | Selection is kept by uid. A stale selection snaps to the first row. Selecting a row counts as a visit (`app.py:256-276,381-385`). | Same, held per window on the client. | = | e2e |
| P-41 | Keys: ↑↓/j/k move; ↑ from the top session enters the projects panel; ⏎ goes to the session (or edits the focused project); `g` goes to the session; `a` cycles through waiting sessions starting with the longest-waiting (`app.py:278-296,305-323,579-662`). | Same keys when no text field has focus. Double-click and ⌘⏎ also go to the session. | = | e2e |
| P-42 | Mouse: click selects, double-click goes to the session, the wheel moves the selection with bursts coalesced to 90 ms, clicking the header opens usage, clicking a project slot edits it (`app.py:723-760`). | Click, double-click, native scrolling (the wheel scrolls instead of moving the selection, a deliberate GUI change), click to edit slots. | ~ | e2e |
| P-43 | `q`/`Q` quits. Esc unwinds: first the filter, then quits (`app.py:580-586`). | ⌘Q quits and ⌘W hides the window (the app stays in the menu bar). Esc unwinds overlay → filter → selection. A bare `q` closes the current overlay and otherwise shows the toast "⌘Q to quit". | ~ | e2e |
| P-44 | `strip_chrome` for small previews: drops up to 8 trailing chrome lines (blank, `❯`, lines made only of ─ or ━, lines starting with `⏵⏵`, lines containing `% remaining]`) (`draw.py:56-89`). | Ported to `format.mjs` (`tailLines`) with shared golden cases. | = | js, py |
| P-45 | Scrollbar thumb, and the selection is kept in view (`split_view.py:100-105`, `list_view.py:109-116`). | Native scrolling plus `scrollIntoView({block:'nearest'})`. | ~ | e2e |

### 1e. Filter, sort, labels, and views

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-46 | `/` fuzzy filter: case-insensitive subsequence match over `path name label`. Live `N of M match`. ⏎ keeps the filter, Esc clears it. Not persisted (`draw.py:102-114`, `app.py:210-222,710-721`). | A search field (`/` or ⌘F) with the same matcher, live count, and keys, plus highlighted matched characters. | = | js, e2e |
| P-47 | `s` cycles sorts: natural (window, tab, pane) → attention (state rank waiting < busy < active < idle < quiet < none; waiting sorted by `since`) → agents (agents first) → activity (most recent change first) → path. Toast `sort: X`. Persisted (`app.py:229-244,617-621`). | Same ordering rules in `web/js/lib/rows.mjs`. `s` plus a sort dropdown. | = | js, e2e |
| P-48 | `l` edits a label inline; saving an empty label removes it. Labels persist keyed by uid with `last_seen`, are garbage-collected after 14 days unseen, and are touched on every snapshot for live sessions (`persist.py:58-104,124-130`). | Inline rename (`l`, double-click the name, or the context menu) via `PUT /api/sessions/{uid}/label`. Same garbage collection and touch rules. | = | py, e2e |
| P-49 | `v` cycles split → list → grid. Persisted (`app.py:610-613`). | `v`, ⌘1/⌘2/⌘3, and a segmented control. Persisted. | = | e2e |
| P-50 | `A` (grid view only) toggles agents/all. Kept in memory only (`app.py:653-654`). | Same key. Persisted as `grid_all`, a deliberate small upgrade. The toolbar's "AI sessions only" toggle (`i`, persisted `agents_only`) applies the same filter to every view; while it's on, the grid's own Agents/All control hides. | ~ | e2e |

### 1f. Usage limits

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-51 | Claude usage: OAuth token read via `security find-generic-password -s 'Claude Code-credentials' -w` (`.claudeAiOauth.accessToken`), then `GET https://api.anthropic.com/api/oauth/usage` with the beta and User-Agent headers. 5-minute interval, 5 s timeout (`usage_claude.py:11-56`). | Ported verbatim. | = | py |
| P-52 | Codex usage: token from `~/.codex/auth.json`, then `GET chatgpt.com/backend-api/wham/usage`. Missing 5h/7d windows are filled from the 10 newest `~/.codex/sessions/*/*/*/*.jsonl` files (under 24 h old, last 8 MB, `rate_limits`) (`usage_codex.py`). | Ported verbatim. | = | py |
| P-53 | Usage pollers run only while a matching agent is running. When none is, the data clears and an `inactive` event is published once. Retry-After is honored as `max(base, retry)`, and the last good data is kept on failure (`pollers.py:241-304`). | Same. | = | py |
| P-54 | Footer rows: CC Session (5h), Weekly (7d), Sonnet (7d); CC Monthly Limit, or `CC Extra Usage` when no limit is set; CX 5h and 7d. Each shows a percent, a bar, severity (≥80 red, ≥50 yellow, else green), and a reset countdown like `2h 15m (Today at 5:59pm)` (`usage_footer.py`, `projection.py:119-138`, `timefmt.py`). | A collapsible usage strip at the bottom: compact meters with the same labels, colors, and countdowns. | ~ | py, e2e |
| P-55 | Pace projections: `on pace to hit {name} limit {when}` (warning) and `{name} limit hit` (danger). The monthly projection appears only if the hit would happen before next month starts. Codex has the same (`projection.py:24-116`). | Warning line under each meter, plus a dashed projection line on the burn-down chart (W-6). | = | py, e2e |
| P-56 | Error rows: `usage API fetch failed` and `Codex usage fetch failed` when there's no data. The usage screen shows `fetch failing — showing data from X ago` when data is stale (`usage_footer.py:46-47,60-62`, `usage_view.py:80-84,109-113`). | Same text in the meter and the Usage view, with a retry button. | = | py, e2e |
| P-57 | Usage screen (`u`): Claude Code and Codex sections, a `refreshed X ago` footer, and `no Claude Code or Codex sessions running` when empty. Keys: `$`, `r`, `u`/Esc (`usage_view.py`, `app.py:567-574`). | Usage view (`u` or toolbar) with the same sections and keys, plus charts (W-6). | ~ | e2e |
| P-58 | `$` shows or hides dollar amounts (credits / 100, formatted `$1,234` or `$12.50`). Persisted `show_dollars`, default hidden (`usage_claude.py:59-69`, `app.py:358-362`). | Same key plus an eye toggle on the meter. Persisted. | = | py, e2e |
| P-59 | The footer is capped so the body keeps at least 8 rows (`app.py:393-394`). | The always-visible Tokens Used strip in the status bar shows every quota; it steps down (hints and counts drop, then short labels, then the worst quota per provider) as the window narrows, and it **can't** be hidden (user decision, VISUAL_SPEC D4: the collapse chevron and `usage.collapse.toggle` were removed; a leftover `usage_collapsed` pref is ignored). | ~ | e2e |

### 1g. Projects and tab colors

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-60 | Optional tab colors through the iTerm2 Python API, polled every 5 s over a fresh connection each time. Colors map to the nearest of 7 presets (red, orange, yellow, green, blue, purple, gray; exact RGB values in `itermcolor.py:23-31`). If the `iterm2` package is missing, polling stops permanently and silently. Other failures are transient (`itermcolor.py`, `pollers.py:165-238`). | Same poller, reported in the state as `capabilities.tab_colors` (`available`, `not_installed`, `api_disabled`, `error`). Onboarding offers "Enable tab colors" (§4). | = | py |
| P-61 | Projects panel (`p`, persisted `projects_open`): 5 numbered slots colored blue, purple, green, red, yellow. Names persist. ↑ from the top session focuses the slots. ⏎ or a click edits a slot (`projects_view.py`, `app.py:278-296,627-631`). | A Projects sidebar section with 5 colored slots edited inline, the same keyboard entry, and a session count per project (sessions with that tab color). | ~ | py, e2e |
| P-62 | `1`–`5` sets the selected session's tab color to that project's color by injecting an OSC 6 escape sequence (`async_inject`). `0` clears it with `…bg;*;default`. Toasts as in P-33. If tab colors are unavailable, toast instead (`app.py:329-350`, `itermcolor.py:129-186`). | Same keys plus a context menu and drag-onto-project, via `PUT /api/sessions/{uid}/color {"slot":n}` or `{"slot":null}`. | = | py, e2e |
| P-63 | `c` clears all 5 project names after a `y/n` confirmation (`app.py:635-636,704-708`). | "Clear projects…" with a confirmation dialog (`c` opens it). `DELETE /api/projects`. | = | e2e |

### 1h. Tab management

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-64 | `x` asks `Close tab N ({label})? (y/n)`; `y` closes it and toasts `closing tab N…` (`app.py:640-644,683-688`). | A confirmation dialog (focus defaults to Cancel; `y` or ⏎ on Close confirms). The close endpoint requires `{"confirm":true}`. | = | e2e |
| P-65 | `n` opens a new tab and toasts `opening new tab…` (`app.py:637-639`). | `n` plus a toolbar ＋ button. | = | e2e |

### 1i. Attention alerts

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-66 | On a transition to waiting: row flash, toast, and `curses.beep()` if `bell` is on (`app.py:139-145`). | Row flash and toast, plus a silent native notification (W-1), Dock badge, and optional Dock bounce. **Sound on attention** is a persisted pref, default **off**, played only by the Swift shell, and hard-disabled by `EVERWATCH_NO_SOUND=1`. | ~ | py, e2e, sw |
| P-67 | `b` toggles the bell (persisted `bell`) with the toast `bell on/off` (`app.py:649-652`). | `b` toggles `sound_on_attention` with the toast `sound on attention: on/off`. Importing an ultrawatch state never turns sound on (§3.7). | ~ | e2e |

### 1j. Quota email notifier

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-68 | Opt-in via `~/.claude/quota-email/config.json` with `"enabled": true`. `threshold_percent` defaults to 90. Checked on every Claude usage event whose `extra_usage.is_enabled` is set, using `utilization`. At most once per calendar month (`~/.claude/quota-email/.last-email-sent` holds `YYYY-MM`). A missing, invalid, or disabled config does nothing (`notifier.py`, `app.py:111-115`). | Same files and rules, kept compatible with ultrawatch. Logic lives in `engine/notifier.py`, but instead of running a dialog it emits a `quota_prompt`. | = | py |
| P-69 | An osascript `display dialog` offers "Skip This Month" or "Draft Email". Draft opens `https://mail.google.com/mail/?view=cm&to=…&su=…&body=…`. The month is marked either way (`notifier.py:44-83`). | An in-app modal (no system dialog) plus a native notification. `POST /api/quota/draft` opens the Gmail URL with `open`; `POST /api/quota/skip` does not. Both mark the month. Settings shows the config status and example. | ~ | py, e2e |

### 1k. Persistence, configuration, and tooling

| ID | Ultrawatch behavior (source) | Everwatch equivalent | St | Test |
|---|---|---|---|---|
| P-70 | `state.json` v1 holds `labels`, `view`, `sort`, `show_dollars`, `bell`, `split_ratio`, `projects[5]`, and `projects_open`. Written atomically (tempfile + `os.replace`) with a 2 s debounce, best-effort, and saved on shutdown. Invalid values are normalized (`persist.py`). | `everwatch/engine/persist.py` with schema v2 (§3.7): same atomic, debounced, best-effort behavior plus new keys. | ~ | py |
| P-71 | State dir is `$XDG_CONFIG_HOME/ultrawatch` (`config.py:30-34`). | `~/Library/Application Support/Everwatch/`, overridable with `EVERWATCH_HOME`. Tests always set it to a temp dir. A one-time import from ultrawatch is offered (§3.7). | ~ | py |
| P-72 | stderr from libraries goes to `stderr.log`, truncated each run (`quiet.py`). | The backend's stdout and stderr go to `~/Library/Logs/Everwatch/backend.log`, rotated at 1 MB × 3. The UI never sees stray output. | ~ | py |
| P-73 | Redraw heartbeat and SIGWINCH repaint policy (`redraw.py`). | **N/A.** The browser engine handles repaint. | N/A | — |
| P-74 | `UW_SCREENSHOT` and `UW_SCREENSHOT_AFTER` dump a text screenshot; `tests/drive_tui.py` is a pty driver (`app.py:764-775,800-828`). | Replaced by `make screenshots` (headless Playwright, demo source) and `everwatch state --json`, which dumps the current state. | ~ | e2e |
| P-75 | Timing constants: snapshot 2 s, paths 10 s, agents 5 s, usage 300 s, colors 5 s, osascript timeout 10 s, ps 3 s, HTTP 5 s, toast 3.5 s, flash 1.5 s, fresh 30 s, label GC 14 d (`config.py`). | Same values in `everwatch/engine/config.py`, one source for backend and client (sent in `hello.config`). | = | py |
| P-76 | Distribution: `./ultrawatch` launcher, `make dist` builds a zipapp, `make install-colors`, `make test`, `make check` (`Makefile`). | `install.sh`, `make install`, the `everwatch` CLI (`open`, `serve`, `doctor`, `demo`, `state`, `uninstall`, `update`), the "Enable tab colors" button (or `install.sh --with-colors`), `make test` (§4, §5). | ~ | e2e (CLI via py) |
| P-77 | Version string shown on the title card (`__init__.py`). | About panel, `everwatch --version`, and `hello.version`. The shell shows both the shell version and the runtime version. | ~ | py, sw |

---

## 2. Extra ("wow") features

The table is ranked by value ÷ cost. The v1 list is bounded on purpose;
everything else waits.

### Ship in v1

| # | Feature | Rationale | Cost |
|---|---|---|---|
| W-1 | **Silent native notifications with click-to-focus.** "◉ api-gateway is waiting for your input". Clicking focuses that exact iTerm2 session. The backend decides when to notify (on a transition to waiting, `notify_on_waiting` default off, 30 s cooldown per session, coalesced if 3 or more arrive within 2 s). The shell suppresses them while its window is key. Authorization asks for `.alert` only, never `.sound` or `.badge`, and `content.sound = nil`. The Dock waiting count has a separate `show_dock_badge` preference, also default off. | This is the core promise ("who needs me?") and works while you're heads-down in iTerm2. | S–M |
| W-2 | **Menu bar status item.** Shows `◉ 2` in amber when anything is waiting, or the Watch-ring glyph (the app's logo mark, as a template image) otherwise. Its menu lists waiting sessions longest-first (click to go there), then Show Everwatch, Compact Mode, Settings, Quit. Works with the window closed. | Glanceable with no window on screen, and replaces the curses header on its own tab. | S |
| W-3 | **Command palette (⌘K).** Fuzzy "go to session…" plus every command in the keymap (views, sorts, label, color → project, new or close tab, toggles, diagnostics). Entries show their shortcuts. | Keyboard-first users get everything without memorizing keys, and it reuses the keymap table. | S |
| W-4 | **Global hotkey.** ⌥⌘E brings Everwatch forward; ⌥⌘J jumps to the longest-waiting session in iTerm2 without showing Everwatch. Uses Carbon `RegisterEventHotKey`, which needs no Accessibility permission (verified to compile under CLT). Configurable in Settings, with conflict detection. | Makes "who needs me" a one-chord action. | S |
| W-5 | **Activity sparklines and attention timeline.** A 60-minute per-session state strip (busy/waiting/idle segments) on each row and tile. The session detail shows "waited 3× · 11 m total today". The backend keeps a ring buffer of published transitions (memory only, 2 h). | Shows which agent keeps blocking on you and how long it sat unnoticed. The data is nearly free because the tracker already publishes transitions. | M |
| W-6 | **Usage burn-down charts.** In the Usage view, each limit shows an SVG line of utilization over its window, from usage samples (every 5 min, persisted to `usage-history.jsonl`, 8 days retained), with a dashed pace-projection line to 100% and the reset marker. | Makes P-55's projection visual and trustworthy. Small hand-written SVG, no chart library. | M |
| W-7 | **Compact always-on-top mode (⌘\\).** A floating `NSPanel` (non-activating) loads `?mode=compact`: a narrow list of agent sessions with state, age, and a waiting highlight; click goes to the session. Position and size autosave per display. Main-window frames autosave too, which covers multi-monitor setups. | A "HUD" beside iTerm2 for people who don't want a second big window. The shell cost is about one panel class; the UI cost is one CSS layout. | S–M |
| W-8 | **Search across screen contents.** The palette's "Search screens" mode (⌘⇧F) greps the visible screen text of every session in memory, lists hits with context, and jumps to the session with the match highlighted in the preview. | "Which tab had that stack trace?" Cheap, because all screen text is already in the snapshot. | S |
| W-9 | **Demo mode** (`everwatch demo`, or a Settings "Try demo" button). A deterministic scripted fleet of 9 sessions across 2 windows with realistic transitions. | Lets people try it before granting permissions, and drives every e2e test and README screenshot, so it has to exist anyway. | (in WP2) |
| W-10 | **Live preview + reply.** While the selected session's preview is on screen (split or zoom, page visible), the web UI holds a live lease on it (`POST /api/sessions/{uid}/live`, renewed every 2 s, dropped after 6 s without renewal, at most 3 live sessions) and the iTerm2 worker re-reads just that session's screen every `EVERWATCH_LIVE_INTERVAL` seconds (default 1, clamped 0.25–10) between full snapshots: a targeted two-Apple-Event read (`session S of tab T of window id W`, id-verified, full-walk fallback) on the same single worker, so iTerm2 never sees concurrent Apple Events and unwatched sessions keep the normal 2 s cadence. A reply bar under the preview types into the session (`POST /api/sessions/{uid}/send`, `{text, enter}` or `{key}`) via AppleScript `write text … newline no`, every value passed as osascript argv, never script source; text is capped at 2000 characters and may not contain control characters; keys are a fixed list (enter, esc, tab, shift-tab, backspace, arrows, ctrl-c); Return after text is a separate write 100 ms later so agents see a keypress, not a paste. Quick-reply buttons appear when the screen shows a Claude Code / Codex numbered menu, a Codex `(y)`/`(esc)` approval, or a `[y/N]` question; they carry the `screen_hash` they were read from and the worker re-reads the session and refuses if it changed. "Don't ask again" / "always" answers get no button. Every send is logged to backend.log with its kind and length only, never the text. Everwatch's own tab is refused. Hidden in compact mode (no preview there). | Answer a waiting agent, interrupt one, or type a follow-up without leaving Everwatch, and watch it respond in near real time. | M |

### Later, with the reason for deferring

| Feature | Why not v1 |
|---|---|
| ~~Quick reply to permission prompts~~ — shipped as part of W-10 | The safety notes that kept it out of v1 still apply, and W-10 implements most of them: quick replies re-fetch that one session immediately before sending and refuse if its screen hash changed; they send a single digit / shortcut letter / Esc that appears in the menu; "don't ask again" / "always" options get no button; the prompt text is on screen right above the buttons; every send is audit-logged (kind and length only). **Not** implemented: a per-session opt-in, and a server-side check that the tracker still says `waiting` with rule `menu-option` (the hash check already pins the exact screen the user saw, and y/n shell prompts are never `waiting`). The uid is verified inside the AppleScript before typing, so a moved tab can't be mis-targeted. |
| Full interactive terminal (a real terminal emulator per session, raw keystrokes, colors, full-screen TUIs) | A large project of its own: terminal emulation in the page, the iTerm2 Python API's streaming screen updates, keystroke forwarding with per-key latency, and a new permission surface. W-10 covers the common case (answer, interrupt, follow up). Plan: [docs/ROADMAP.md](ROADMAP.md). |
| Search beyond the visible screen (scrollback) | Needs `contents` per session: expensive Apple Events that grow with history. |
| Custom heuristic rule editor | The engine supports it, but it needs validation UX. Ship after the rules stabilize. |
| iTerm2 plugin (§6) | iTerm2 Python-runtime friction; small marginal value. |
| Per-project dashboards and filters | Natural after sparklines. Filtering by tab color is a small add-on. |
| Homebrew cask | Needs a stable release cadence first. |
| Auto-update check | The v1 About panel has a manual "Check for updates" (one GitHub API call when clicked). Automatic checks need an opt-in design. |

---

## 3. Architecture

### 3.1 Components and process model

```
Everwatch.app  (Swift, ad-hoc signed, bundle id io.github.burnsbert.everwatch)
 ├─ BackendSupervisor ── spawns ─▶ python3 -m everwatch serve --port 0 --parent-pipe
 │     env: EVERWATCH_TOKEN=<32B urlsafe>, EVERWATCH_HOME, EVERWATCH_SHELL=1
 │     reads stdout handshake line:  EVERWATCH_READY <port>
 │     stdin pipe held open; EOF ⇒ backend exits (no orphans)
 │     restarts with backoff (1s,2s,4s; >3 crashes/60s ⇒ error page)
 ├─ MainWindow (NSWindow + WKWebView → http://127.0.0.1:<port>/)
 │     token injected by WKUserScript at document start (never in URL)
 │     bridge: window.webkit.messageHandlers.everwatch  (see 3.5)
 ├─ CompactPanel (NSPanel, floating, WKWebView ?mode=compact)
 ├─ StatusItem (menu bar) ─┐
 ├─ Notifier (UNUserNotificationCenter, no sound) ─┤ fed by NativeSSEClient
 ├─ HotKeys (Carbon)       ─┘ (URLSession bytes stream on /api/events)
 └─ SoundPolicy (only sound site in the repo; pref && !EVERWATCH_NO_SOUND)

python3 everwatch serve  (stdlib; one process)
 ├─ Pollers (threads, ported): ItermWorker, AgentsPoller, ColorsPoller,
 │   UsagePoller×2  ── all I/O through DataSource ──▶ queue.Queue
 ├─ Engine thread (single owner of SessionTracker, StateStore, History,
 │   Notifier policy): drains poller queue + command queue, builds an
 │   immutable PublishedState(rev), fans out SSE events
 ├─ ThreadingHTTPServer (127.0.0.1:0): static web assets + JSON API + SSE;
 │   handlers only read the PublishedState reference or enqueue commands
 └─ DataSource: RealSource (osascript/ps/lsof/security/urllib) |
                DemoSource (scripted, virtual clock) | FakeSource (tests)
```

**Responsibility and TCC.** Apple Events sent by the `osascript` grandchild
are charged to the *responsible process*, which is `Everwatch.app`. `exec`
and plain `posix_spawn` keep the responsible pid; this is the same mechanism
that made ultrawatch prompt for "your terminal". So the system prompt will
read **"Everwatch" wants to control "iTerm2"**. `Info.plist` must include
`NSAppleEventsUsageDescription`. The app is not hardened-runtime, so no
`com.apple.security.automation.apple-events` entitlement is needed. It also
sets `NSAppTransportSecurity/NSAllowsLocalNetworking=true` so http loads of
127.0.0.1 are allowed. **Verified** on macOS 27.0 (26A428) with
Homebrew's `python@3.14` (`Python.app/Contents/MacOS/Python`, spawned by
`BackendSupervisor` via `Process`): tccd logs the backend's `osascript` as
`responsible={identifier=io.github.burnsbert.everwatch, pid=<Everwatch>}`,
prompts "for access to indirect object iTerm.app by Everwatch.app", and
creates the `kTCCServiceAppleEvents` row for `io.github.burnsbert.everwatch`
when the user clicks OK. The shell's own `AEDeterminePermissionToAutomateTarget`
probe therefore reads the same grant. It is only a snapshot, though: the
first one runs at page load, often before the user has answered the
prompt. So the backend's osascript result always wins in the UI
(`lib/diagnostics_ui.mjs` `mergeAutomation`), and the shell re-probes
whenever the backend's `iterm.status` changes. `docs/PERMISSIONS.md`'s
Automation section keeps the user-facing fallback in case another macOS
version attributes differently.

**Browser fallback.** `everwatch open` runs the server in the foreground and
opens `http://127.0.0.1:<port>/#t=<token>`. The page moves the token into
`sessionStorage` and strips the fragment. The TCC-responsible app is then the
launching terminal. There is no native notifications, menu bar, or hotkey;
the UI shows a "running in browser mode" chip explaining what's missing.

### 3.2 Repo layout

```
LICENSE  README.md  Makefile  install.sh  package.json (devDependencies only)
playwright.config.mjs  .gitignore (/.*.md, build/, node_modules/, test-results/)
docs/DESIGN.md  docs/screenshots/*.png
everwatch/                      # python package, stdlib only, py3.9+
  __init__.py (__version__)  __main__.py  cli.py
  engine/   config.py iterm.py agents.py heuristics.py pollers.py snapshot.py
            projection.py timefmt.py persist.py itermcolor.py notifier.py
            usage_claude.py usage_codex.py      # ported from ultrawatch_lib
  model.py        # rows/tab labels/paths/titles/usage rows (from ui/app.py + usage_footer)
  engine_loop.py  # Engine thread, PublishedState, command handling
  history.py      # transition ring buffer + usage-history.jsonl
  notify_policy.py  diagnostics.py  server.py  sse.py  security.py  logs.py
  sources/  base.py real.py demo.py fake.py  demo_scenario.json
  web/  index.html  compact.html
        css/ tokens.css app.css
        js/ main.mjs api.mjs sse.mjs store.mjs keymap.mjs bridge.mjs
            views/ header.mjs list.mjs split.mjs grid.mjs zoom.mjs usage.mjs
                   projects.mjs palette.mjs settings.mjs onboarding.mjs toasts.mjs
            lib/ rows.mjs format.mjs fuzzy.mjs theme.mjs sparkline.mjs chart.mjs
        img/ logo.svg
shell/
  Sources/Core/*.swift   # Foundation-only: Handshake, PythonLocator, SSEParser,
                         # BridgeMessage, StatusTitle, SoundPolicy, NotifyGate, Prefs
  Sources/App/*.swift    # AppKit/WebKit/UN/Carbon glue (thin, not unit-tested)
  Tests/*.swift          # Swift Testing
  Info.plist  AppIcon.icns (generated)
tests/ py/ js/ e2e/ fixtures/ (from ultrawatch) golden/
scripts/ build_app.sh  screenshots.mjs  make_icon.sh  lint_nosound.py
         check_parity.py  release.sh
```

### 3.3 Threading rules

- Pollers keep their ultrawatch threading unchanged. Only `ItermWorker`
  talks to iTerm2 over AppleScript, and only `ColorsPoller` uses the iTerm2
  Python API.
- The **Engine thread is the single writer** of the tracker, store, and
  history. HTTP handler threads do three things only: read
  `engine.published` (an immutable object swapped atomically), `put()` a
  command, and wait on a per-command `Future` with a 5 s timeout.
- SSE: each subscriber gets a bounded `queue.Queue(maxsize=64)`. On overflow
  the subscriber is sent a fresh `state` and its backlog is cleared, so a
  slow client never blocks the engine. A `ping` goes out every 15 s.
- The engine publishes whenever it drains events, plus a 1 Hz tick for
  flash expiry, stale-status transitions, and `now`. Usage rows are rebuilt
  on usage events and every 30 s so countdown text stays current.
- Time comes through an injected `Clock` (`time.time` for real runs, a
  virtual clock for demo and tests).

### 3.4 DataSource abstraction

```python
class DataSource(Protocol):
    def fetch_snapshot(self) -> ItermSnapshot: ...      # raises ItermNotRunning / ItermError(code)
    def fetch_paths(self) -> PathsSnapshot: ...
    def goto(self, uid: str) -> bool: ...
    def close_tab(self, window_id: int, tab_index: int) -> None: ...
    def new_tab(self) -> None: ...
    def agent_ttys(self) -> dict: ...                   # {tty: {'claude','codex'}}
    def tty_cwds(self, ttys) -> dict: ...
    def fetch_colors(self) -> dict: ...                 # raises ColorApiUnavailable
    def set_color(self, uid: str, name) -> bool: ...
    def usage_claude(self): ...                         # (dict|None, retry_after|None)
    def usage_codex(self): ...
    def open_url(self, url: str) -> None: ...           # quota draft
    def launch_iterm(self) -> None: ...
```

- **RealSource** wraps the ported functions.
- **DemoSource** reads `demo_scenario.json`: 9 sessions across 2 windows
  (4 Claude, 2 Codex, 3 shells). It includes a permission prompt, a spinner,
  a just-finished idle session, a Codex approval, `tail -f` output, tab
  colors on 3 sessions, labels, and usage data that produces a warning and a
  "hit" row. A timeline loops every 90 s so a transition to waiting (and its
  notification) happens. Actions mutate the scenario. `--clock fixed:<iso>`
  plus `--seed` make it deterministic.
- **FakeSource** is fully scriptable from tests: queued responses and
  recorded calls.

### 3.5 API contract (all under `/api`, JSON, auth required)

**Auth.** Every request needs header `X-Everwatch-Token: <token>`, except
`GET /api/events?token=<token>` (EventSource can't set headers). The server
also returns **403** if `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`
(blocks DNS rebinding), if an `Origin` header is present and isn't that same
origin, or if a mutating request isn't `Content-Type: application/json`
(blocks CSRF). Tokens are compared with `hmac.compare_digest`. Static files
are served without a token and contain no data.

| Method and path | Body | Returns |
|---|---|---|
| GET `/api/state` | — | `State` including all `screens` |
| GET `/api/events` | — | SSE stream (events below) |
| GET `/api/sessions/{uid}/screen` | — | `{uid, text, screen_hash}` |
| POST `/api/sessions/{uid}/goto` | `{}` | `{id}`; result arrives as `action_result` |
| POST `/api/sessions/{uid}/visit` | `{}` | `{ok}` |
| POST `/api/sessions/{uid}/send` | `{text, enter?}` or `{key}` (+ optional `expect_hash`) — W-10 | `{id}`; result arrives as `action_result` (kind `send`). 400 `invalid_text` / `invalid_key` / `text_too_long` / `invalid_input`, 404 `unknown_session`, 409 `self_session` |
| POST / DELETE `/api/sessions/{uid}/live` | `{}` — W-10 | `{ok, live, interval, lease}` |
| PUT `/api/sessions/{uid}/label` | `{label}` | `{ok}` (an empty label removes it) |
| PUT `/api/sessions/{uid}/color` | `{slot: 1-5 \| null}` | `{id}` or 409 `{error:"tab_colors_unavailable"}` |
| POST `/api/tabs/new` | `{}` | `{id}` |
| POST `/api/tabs/{window_id}/{tab_index}/close` | `{confirm:true}` | `{id}`, or 400 without `confirm` |
| POST `/api/refresh` | `{}` | `{ok}` |
| PATCH `/api/prefs` | partial `Prefs` | `Prefs` (validated and clamped) |
| PUT `/api/projects/{n}` | `{name}` | `{ok}` |
| DELETE `/api/projects` | — | `{ok}` |
| GET `/api/history?uid=&minutes=60` | — | `{transitions:[{uid,from,to,at}]}` |
| GET `/api/usage/history?since=` | — | `{samples:[{at,id,pct}]}` |
| GET `/api/diagnostics` / POST `/api/diagnostics/recheck` | — | `Diagnostics` |
| POST `/api/quota/draft` / `/api/quota/skip` | `{}` | `{ok}` |
| POST `/api/colors/install` | `{}` | `{id}`; progress arrives as `diagnostics` events |
| POST `/api/import/ultrawatch` | `{}` | `{imported:{labels,projects,prefs}}` |
| POST `/api/iterm/launch` | `{}` | `{ok}` |

**`State` shape** (abridged; `tests/golden/state_demo.json` is the canonical
example, generated by `make golden` and consumed by the JS tests):

```json
{
  "rev": 412, "now": 1790000000.1, "started": 1789999000.0, "version": "0.2.4",
  "mode": "real|demo", "debug_state": false,
  "iterm": {"status": "ok|connecting|not_running|permission_denied|timeout|error",
            "error": "", "snapshot_at": 1790000000.0},
  "counts": {"tabs": 9, "agents": 4, "waiting": 2},
  "waiting_order": ["C2F1…", "9A0B…"],
  "sessions": [{
    "uid": "C2F1…", "window_id": 4711, "window_no": 1, "tab_index": 3, "session_index": 1,
    "tab_label": "1.3", "tty": "/dev/ttys004", "name": "claude", "path": "~/src/api-gateway",
    "kind": "claude", "badge": "CC", "is_self": false, "is_dashboard": false,
    "state": "waiting", "state_since": 1789999800.0, "rule": "menu-option",
    "attention": true, "last_change": 1789999990.0, "label": "deploy-fix",
    "display_name": "deploy-fix", "title": "deploy-fix", "tab_color": "blue",
    "project": 1, "screen_hash": 2891443211, "spark": "bbbbwwwwiibb"
  }],
  "screens": {"C2F1…": "…full visible text…"},
  "usage": {
    "claude": {"status": "ok|inactive|failing|stale|no_token", "at": 1789999900.0, "rows": [
      {"id": "cc.five_hour", "label": "CC Session Limit", "pct": 62, "level": "yellow",
       "reset_at": "2026-09-25T21:59:00+00:00", "reset_text": "2h 15m (Today at 5:59pm)",
       "dollars": null, "projection": {"text": "on pace to hit session limit Today at 4:10pm", "hit": false,
                                        "at": "2026-09-25T20:10:00+00:00"}}]},
    "codex": {"status": "inactive", "at": 0, "rows": []}
  },
  "projects": {"open": true, "slots": [{"n": 1, "name": "API", "color": "blue", "count": 2}]},
  "prefs": {"view": "split", "sort": "attention", "split_ratio": 0.42, "show_dollars": false,
            "sound_on_attention": false, "dock_bounce": false, "notify_on_waiting": false,
            "show_dock_badge": false, "theme": "system", "session_font": "system", "session_font_size": 13,
            "grid_all": false, "usage_collapsed": false,
            "hotkey_show": "opt+cmd+e", "hotkey_next": "opt+cmd+j", "show_hints": true},
  "capabilities": {"tab_colors": "available|not_installed|api_disabled|error",
                   "shell": true, "notifications": "authorized|denied|not_determined|unknown"},
  "quota_prompt": null
}
```

**SSE events.** Each event carries `id: <rev>`. On reconnect, `Last-Event-ID`
gets a fresh `state`.

| Event | Payload | Consumer |
|---|---|---|
| `hello` | `{version, config:{intervals…}, state}` | web, shell |
| `state` | `State` without `screens` | web, shell |
| `screens` | `{rev, screens:{uid:text}}`, only for hashes that changed | web |
| `transition` | `{uid, from, to, at, title}` | web (flash, toast), shell (sound policy) |
| `notify` | `{id, uid, title, body}` (already filtered by policy) | shell only |
| `toast` | `{message, level:"info\|warn\|danger"}` | web |
| `action_result` | `{id, kind, ok, detail}` | web |
| `quota_prompt` | `{pct, to, month}` | web, shell (notification) |
| `diagnostics` | `Diagnostics` | web |
| `ping` | `{now}` | all |

**Native bridge** (web → shell, `postMessage`):
`{type:"appearance", theme}`, `{type:"openCompact"}`, `{type:"openSettings"}`,
`{type:"requestNotifications"}`, `{type:"openSystemSettings", pane:"automation|notifications"}`,
`{type:"setHotkeys", show, next}`, `{type:"ready"}`.
Shell → web goes through `window.everwatchNative.dispatch({type:…})`:
`notificationClicked{uid}`, `nativeStatus{automation, notifications, hotkeys}`,
`focus{key:boolean}`. **There is no bridge message for sound.** Sound is
decided inside the shell from `transition` plus prefs.

### 3.6 Theming

- `tokens.css` defines semantic custom properties: `--bg`, `--bg-elev`,
  `--fg`, `--fg-dim`, `--chrome`, `--accent-claude` (magenta/violet),
  `--accent-codex` (blue), `--attention` (amber, #FFAF00 in dark, darker in
  light for AA contrast), `--busy` (green), `--idle`, `--danger`, `--warn`,
  `--label`, `--flash-bg`, and `--tab-{red…gray}` (the exact iTerm2 preset
  RGB values from `itermcolor.py:23-31`).
- `html[data-theme="dark"|"light"]` set explicit palettes. `system` removes
  the attribute and relies on `@media (prefers-color-scheme)`. `theme.mjs`
  resolves the preference, and the shell mirrors it with `NSApp.appearance`
  so the title bar matches.
- Contrast: every text/background token pair must pass WCAG AA (4.5:1),
  checked by a JS unit test over the token table.
- Fonts: `-apple-system` for UI and `ui-monospace, "SF Mono", Menlo` for
  previews. No bundled fonts.

### 3.7 Persistence and migration

- Directory: `~/Library/Application Support/Everwatch/` (`EVERWATCH_HOME`
  overrides). It holds `state.json` (schema v2), `usage-history.jsonl`, the
  `runtime/` payload, and the optional `venv/`. Logs go to
  `~/Library/Logs/Everwatch/`.
- Schema v2 is the v1 keys plus `theme`, `sound_on_attention` (replaces
  `bell`), `dock_bounce`, `notify_on_waiting`, `grid_all`, `usage_collapsed`,
  `hotkey_show`, `hotkey_next`, `show_hints`, `compact`
  (`{agents_only:true}`), `onboarding_done`, and `imported_from_ultrawatch`.
  Unknown keys are preserved and invalid values normalized, as in
  `persist.py`.
- **Migration (optional, offered once in onboarding).** If
  `$XDG_CONFIG_HOME/ultrawatch/state.json` or `~/.config/ultrawatch/state.json`
  exists, import `labels` (same iTerm2 uids, so they keep working),
  `projects`, `projects_open`, `view`, `sort`, `split_ratio`, and
  `show_dollars`. **`bell` is never imported as sound-on.** If it was true,
  onboarding shows "ultrawatch's bell was on; Everwatch keeps sound off —
  enable it in Settings if you want it." The ultrawatch file is left
  untouched.

### 3.8 Localhost security summary

The server binds `127.0.0.1` only, on port 0 (the OS picks a free port), with
a per-launch 256-bit token from the shell (`SecRandomCopyBytes`) or the CLI
(`secrets.token_urlsafe(32)`). Requests are checked for Host, Origin, and
content type. Responses send
`Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff`, and `Cache-Control: no-store` on `/api`.
There are no CORS headers. Screen text is inserted with `textContent`, never
`innerHTML`, so terminal output can't inject markup (e2e test with a hostile
fixture). The backend exits when the parent pipe closes. The threat model
excludes same-user processes, which can already read the token from the
environment.

---

## 4. Permissions and install UX

### 4.1 Install

| Path | Command | What it does |
|---|---|---|
| One-liner (recommended) | `curl -fsSL https://raw.githubusercontent.com/burnsbert/everwatch/main/install.sh \| bash` | (1) Checks macOS ≥ 13 and that iTerm2 is installed (`/Applications/iTerm.app` or via `mdfind "kMDItemCFBundleIdentifier == com.googlecode.iterm2"`). (2) Finds python3 ≥ 3.9. It tries Homebrew first, then `/usr/bin/python3` **only if `xcode-select -p` succeeds**, so it never triggers the CLT install dialog; otherwise it prints `xcode-select --install` or `brew install python`. (3) Downloads `everwatch-<ver>.tar.gz` from the latest GitHub release and **verifies its sha256**. (4) Installs the runtime to `~/Library/Application Support/Everwatch/runtime/<ver>` with a `current` symlink. (5) Installs the prebuilt universal, ad-hoc-signed `Everwatch.app` to `~/Applications`, only if the shell version changed; if it can't, it builds with `swiftc` when available; if neither works, it falls back to browser mode. (6) Links `~/.local/bin/everwatch`, warning if that isn't on PATH. (7) Asks "Open Everwatch now? [Y/n]". curl downloads carry no quarantine attribute, so Gatekeeper doesn't block the ad-hoc app. No sudo. |
| From source | `git clone … && cd everwatch && make install` | Same layout. Builds the shell with `swiftc` (requires CLT) and copies the runtime from the working tree. `make install-dev` symlinks the runtime to the checkout. |
| Flags | `install.sh --browser-only`, `--with-colors`, `--prefix DIR`, `--version X` | `--with-colors` creates the venv and runs `pip install iterm2` into it. |
| Uninstall | `everwatch uninstall [--purge]` (or `install.sh --uninstall`) | Removes the app, runtime, venv, and CLI link. Keeps `state.json` unless `--purge`. With `--purge` it also runs `tccutil reset AppleEvents io.github.burnsbert.everwatch` (user-level, no sudo) so no phantom Automation permission row is left. |
| Update | `everwatch update`, or About → Check for updates | Re-runs the installer for the latest release. A runtime-only update leaves `Everwatch.app` byte-identical, **so the Automation grant survives**. If the shell changed, the installer warns that macOS will ask for permission once more. |

### 4.2 First-run onboarding and diagnostics

Onboarding is a wizard shown until `onboarding_done`. The same checks live
in Settings → Diagnostics and in `everwatch doctor`, which prints the same
table in the terminal. Each check shows ✓, ⚠, or ✗ plus one primary action
button.

| # | Check | How it's detected | If it isn't OK |
|---|---|---|---|
| 1 | Python ≥ 3.9 is found | Shell `PythonLocator` (a Core unit, tested) | The shell loads a local HTML error page (no `NSAlert`) with copyable `brew install python` / `xcode-select --install` commands. |
| 2 | iTerm2 is installed | `NSWorkspace.urlForApplication(withBundleIdentifier:"com.googlecode.iterm2")`, backend `mdfind` | "Get iTerm2" link. |
| 3 | iTerm2 is running | Snapshot status | A "Launch iTerm2" button (`open -b com.googlecode.iterm2`). Everwatch keeps polling and recovers by itself. |
| 4 | **Automation → iTerm2** | Shell: `AEDeterminePermissionToAutomateTarget(iTerm2, typeWildCard, typeWildCard, askUserIfNeeded:false)`: `noErr` = granted, `-1744` = not asked yet, `-1743` = denied. Backend: `(-1743)` seen in osascript stderr. Precedence: the backend's osascript result (`ok`, or `error` from `-1743`/`-1744`) always wins, because the backend is what actually sends the events. The shell probe fills in only while the backend has no result yet (`unknown`). The shell re-probes on every `iterm.status` change so its snapshot doesn't go stale. | **Not asked:** a step that explains what the prompt will say, then a "Connect to iTerm2" button that triggers the first poll (the system prompt appears). **Denied:** a "Open System Settings" button (`x-apple.systempreferences:com.apple.preference.security?Privacy_Automation`), a 3-step illustrated guide (find Everwatch → enable iTerm2), then automatic re-check. A "Still stuck?" section offers the `tccutil reset AppleEvents io.github.burnsbert.everwatch` command with a copy button. |
| 5 | Shell integration (paths) | Share of sessions without a `path` variable | Info only. Paths fall back to lsof; link to iTerm2's "Install Shell Integration". |
| 6 | Agents detected | Agents snapshot | Info: "No Claude Code or Codex running — start one to see states and usage." |
| 7 | Claude usage | Token present or missing, last fetch ok / failing / Retry-After | Info: "Sign in with `claude` to see limits." Failures show the HTTP status. |
| 8 | Codex usage | `~/.codex/auth.json` present, last fetch | Info. |
| 9 | Tab colors (optional) | `capabilities.tab_colors` | **not_installed:** an "Enable tab colors" button runs `POST /api/colors/install` (create the venv, `pip install iterm2`, restart the backend on the venv python) with progress. **api_disabled:** "iTerm2 → Settings → General → Magic → Enable Python API", then re-check. It notes that iTerm2 shows a one-time "allow connection" dialog on first connect. |
| 10 | Notifications | Shell `getNotificationSettings` | **not_determined:** a "Allow notifications" button (requests `.alert` only). **denied:** opens the Notifications settings pane. It notes they're always silent. |
| 11 | Hotkeys | `RegisterEventHotKey` result | On a conflict: pick another shortcut. |
| 12 | Quota email (optional) | `~/.claude/quota-email/config.json` status | Shows enabled/disabled and the threshold, with a "copy example config" button. |
| 13 | ultrawatch state found | File exists and not yet imported | "Import labels & projects" button. |

The wizard asks for exactly one required permission (step 4). Everything
else can be skipped. A "Try demo mode" link is always available so people
can explore before granting anything.

### 4.3 Code signing and TCC stability

- Ad-hoc signing is done with
  `codesign --force --sign - --identifier io.github.burnsbert.everwatch Everwatch.app`.
  Measured: the designated requirement is `cdhash H"…"` only. TCC's grant is
  therefore tied to the exact executable. Mitigation: the bundle contains
  only the executable, `Info.plist`, and the icon, so updates normally don't
  touch it. `SHELL_VERSION` is bumped only when Swift code changes.
- Optional (documented, not default): `make signing-identity` creates a
  self-signed code-signing certificate in the login keychain, so rebuilds
  keep a certificate-anchored requirement. This is for contributors who
  rebuild the shell often. It needs the user to approve a keychain trust
  prompt, so it stays off the install path.
- The release app is built universal (`swiftc -target arm64-apple-macos13`
  and `-target x86_64-apple-macos13`, combined with `lipo`; verified; the
  x86_64 build only warns about `libswiftCompatibilityPacks.a`).

---

## 5. Test strategy

### 5.1 One entry point

| Target | Runs | Needs |
|---|---|---|
| `make test` | `test-py`, `test-py39`, `test-js`, `test-swift`, `test-e2e`, `lint` | python3, node, CLT, cached Chromium |
| `make test-fast` | Everything except e2e | — |
| `make test-py` | `EVERWATCH_NO_SOUND=1 EVERWATCH_HOME=$(mktemp -d) python3 -m coverage run --branch -m unittest discover -s tests/py && python3 -m coverage report --fail-under=90` | coverage (dev) |
| `make test-py39` | `/usr/bin/python3 -m unittest discover -s tests/py` (3.9.6, no coverage) | CLT python |
| `make test-js` | `npx c8 --check-coverage --lines 90 --branches 85 node --test tests/js/` (Node 20 has no built-in coverage thresholds, see 5.4) | c8 (dev) |
| `make test-swift` | `scripts/build_app.sh --tests && build/shell-tests` (Swift Testing via swiftc, 5.4) | CLT |
| `make test-e2e` | `npx playwright test` (headless Chromium; the web server is `python3 -m everwatch serve --demo --clock fixed:2026-09-25T15:00:00-04:00 --seed 1 --token test --port 0`) | @playwright/test (dev) |
| `make lint` | `scripts/lint_nosound.py`, `scripts/check_parity.py`, `python3 -m py_compile` over the package, `node --check` over the JS | — |
| `make screenshots` | `node scripts/screenshots.mjs` → `docs/screenshots/{split,grid,usage,compact,palette,onboarding}-{dark,light}.png` | same as e2e |

### 5.2 Layers

- **Python unit tests** (`tests/py`, stdlib `unittest`). Port all 163
  ultrawatch tests and fixtures. New tests cover `model.py` (every P-row
  marked `py`), `engine_loop` command handling, `notify_policy` (cooldown,
  coalescing), `history`, `diagnostics` (error-code parsing), persistence v2
  and migration (bell never becomes sound), `server` (auth, Host/Origin/CSRF
  403s, every endpoint against FakeSource, SSE framing and backpressure),
  DemoSource determinism, and the CLI. Coverage gate: **≥ 90 % branch** for
  `everwatch/`.
  **Guard:** `tests/py/__init__.py` patches `subprocess.run`,
  `subprocess.Popen`, `os.system`, `urllib.request.urlopen`, and
  `socket.create_connection` (except to 127.0.0.1). Any test that reaches
  them without an explicit fake fails with `RealIOForbidden`, so no test can
  touch iTerm2, the keychain, or the network, or run `afplay`, `say`, or
  `osascript`.
- **JS unit tests** (`tests/js`, `node:test`). Cover `rows.mjs` (sort and
  filter), `fuzzy.mjs`, `format.mjs` (age text, fresh, `tailLines`,
  `stripChrome`), `keymap.mjs` (a reducer: key + context → command, covering
  every binding in §1), `theme.mjs`, token contrast, palette scoring,
  `sse.mjs` (reconnect state machine), and `sparkline`/`chart` path math.
  Shared golden JSON cases in `tests/golden/*.json` run in **both** Python
  and JS where logic exists in both places (fuzzy, `tailLines`), so the two
  can't drift.
- **E2E** (`tests/e2e`, Playwright, headless Chromium). Every test title
  includes its `P-xx` or `W-x` tags. Tests use `page.clock` for time,
  `page.emulateMedia({colorScheme})` for themes, and an injected
  `window.webkit.messageHandlers` stub to assert bridge calls. Coverage
  includes all views, keys and mouse actions, dialogs, onboarding states
  (driven by `--demo-diagnostics=<preset>`), the XSS fixture, and browser
  mode. `page.screenshot()` renders offscreen in the headless browser and
  never captures the real display. The config sets `headless: true`
  explicitly, and a lint check rejects `headless: false` or `--headed`.
  A **WebKit project** (closest to WKWebView) is available as
  `make test-e2e-webkit`, but needs `npx playwright install webkit` because
  revision 2359 isn't cached.
- **Swift tests.** Swift Testing tests cover `shell/Sources/Core`, which
  imports Foundation only: handshake parsing, `PythonLocator` (with an
  injected filesystem, including "don't touch /usr/bin/python3 without
  CLT"), `SSEParser`, bridge message decoding, `StatusTitle`, `NotifyGate`
  (key-window suppression), and **`SoundPolicy`** (plays only when
  `pref == true` and `EVERWATCH_NO_SOUND` is unset, using an injected player
  fake that records calls; nothing real is ever called). AppKit glue is
  compiled by `make test-swift` (a build check) but **never launched**.
- **Parity accounting.** `scripts/check_parity.py` parses the P-/W- ids in
  this document and fails if any non-N/A id lacks a test tag, or if a tag
  refers to an unknown id.
- **No-sound lint.** `scripts/lint_nosound.py` greps the repo for
  `NSSound`, `AudioServicesPlay`, `NSBeep`, `beep(`, `afplay`, `say `,
  `AudioContext`, `new Audio`, `<audio`, `.play(`, `curses.beep`,
  `sound name`, `UNNotificationSound`, `.sound` in `UNAuthorizationOptions`,
  and a literal `\a` or `\x07` written to a tty. The only allowlisted sites
  are `shell/Sources/Core/SoundPolicy.swift` (the gate),
  `shell/Sources/App/SystemSoundPlayer.swift` (the single `NSSound.beep()`),
  and the OSC terminator in `engine/itermcolor.py`, where `\x07` is the
  string terminator for a sequence injected into iTerm2, not a bell.

### 5.3 README screenshots, reproducibly

`scripts/screenshots.mjs` starts the demo server with a fixed clock and seed,
opens `/?frame=mac` (a CSS-drawn window frame, so no real window is
involved), and uses viewport 1440×900 at `deviceScaleFactor: 2`. For each
view × {dark, light} it waits for `document.body.dataset.ready === "1"` and
disables animations (`reducedMotion: 'reduce'`). It writes PNGs to
`docs/screenshots/`. Output is deterministic apart from font rasterization. A
review diff in `make screenshots-check` uses Playwright's `toHaveScreenshot`
with `maxDiffPixelRatio: 0.01`.

### 5.4 Feasibility results (run here, 2026-09-25)

The feasibility checks used an isolated temporary workspace.

**Toolchain**
```
$ swift --version
swift-driver version: 1.168.6 Apple Swift version 6.4 (swiftlang-6.4.0.34.1 clang-2100.3.34.1)
Target: arm64-apple-macosx27.0.0
$ xcode-select -p
/Library/Developer/CommandLineTools
$ ls /Library/Developer/CommandLineTools/Library/Developer/Frameworks
_Testing_AppKit.framework … Testing.framework        (no XCTest.framework)
```

**SwiftPM (`swift test` / `swift build`) is broken on this CLT.** With a
minimal package (1 library, 1 test target) and tools-version 6.0, 5.9, 6.1,
6.2, or 6.3:
```
error: 'swiftpkg': Invalid manifest …
Undefined symbols for architecture arm64:
  "PackageDescription.Package.__allocating_init(name: … swiftLanguageVersions: [PackageDescription.SwiftVersion]? …)"
ld: symbol(s) not found for architecture arm64
```
Cause: `nm -gU …/pm/ManifestAPI/libPackageDescription.dylib | swift demangle`
exports only inits typed `[SwiftLanguageMode]?`. The shipped
`PackageDescription.swiftmodule` references `[SwiftVersion]?`, so the CLT
dylib and interface don't match. Passing `swiftLanguageModes:` explicitly
fails with `error: extra argument 'swiftLanguageModes' in call`. **Decision:
don't use SwiftPM.**

**Swift Testing via swiftc works**, with an explicit entry point:
```
$ F=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
$ L=/Library/Developer/CommandLineTools/Library/Developer/usr/lib
$ swiftc -parse-as-library -F $F -I $F \
    -plugin-path /Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing \
    -Xlinker -rpath -Xlinker $F -Xlinker -rpath -Xlinker $L -framework Testing \
    Sources/ShellCore/Core.swift Tests/ShellCoreTests/CoreTests.swift build/main.swift -o build/shelltests
$ ./build/shelltests
✔ Test rejectsGarbage() passed after 0.001 seconds.
✔ Test parsesHandshake() passed after 0.001 seconds.
✔ Test run with 2 tests in 0 suites passed after 0.001 seconds.
exit=0
```
`main.swift` is
`import Testing; @main struct Runner { static func main() async { await Testing.__swiftPMEntryPoint() as Never } }`.
Without the `$L` rpath the binary fails at launch with
`dyld: Library not loaded: @rpath/lib_TestingInterop.dylib`. With one
deliberately failing expectation it reports
`✘ Test run with 2 tests in 0 suites failed … with 1 issue.` and `exit=1`.
Caveat: `__swiftPMEntryPoint` is an underscored SPI and could change between
toolchains. `build_app.sh` should fall back to a tiny assertion runner if it
disappears.

**The AppKit shell compiles under CLT (compiled only, never launched).** A
test `main.swift` importing AppKit, WebKit, UserNotifications, and
Carbon.HIToolbox (NSWindow + WKWebView + NSStatusItem + UNNotificationContent
with `sound=nil` + `RegisterEventHotKey`) builds in about 1 s with
`swiftc -O main.swift -o Everwatch`. Also:
```
$ swiftc -O -target x86_64-apple-macos13 … && swiftc -O -target arm64-apple-macos13 … && lipo -create …
Architectures in the fat file: E_uni are: x86_64 arm64
$ codesign --force --sign - --identifier io.github.burnsbert.everwatch Everwatch.app
$ codesign -dv Everwatch.app  →  Identifier=io.github.burnsbert.everwatch  Signature=adhoc  TeamIdentifier=not set
$ codesign -d -r- Everwatch.app  →  # designated => cdhash H"51182a6a1431023e0adb6fce8a6c39c04c00d0af"
```

**Playwright.** No project-local install, and no global one.
`npx --no-install playwright --version` gives
`npx canceled due to missing packages`. The browser cache
`~/Library/Caches/ms-playwright` has `chromium-1243` and
`chromium_headless_shell-1243` (plus 1179 and 1228), `webkit-2182`,
`webkit-2311`, `firefox-1488`, `firefox-1532`, and `ffmpeg-1011`. In the
scratch dir, `npm i -D @playwright/test` then `npx playwright --version`
gives `Version 1.63.0`. It expects chromium 1243 (**cached**) and webkit
2359 (**not cached**).
```
$ npx playwright test --project=chromium --reporter=line
[1/1] [chromium] › t/smoke.spec.js:2:1 › headless render + offscreen screenshot
  1 passed (1.6s)
$ npx playwright test --project=webkit --reporter=line
Error: browserType.launch: Executable doesn't exist at …/ms-playwright/webkit-2359/pw_run.sh
```
Pin `@playwright/test@1.63.0` so the cached Chromium is reused without a
download.

**Python and Node**
```
$ /usr/bin/python3 --version → Python 3.9.6      $ python3 --version → Python 3.13.15
$ python3 -m coverage --version → Coverage.py, version 7.16.1 with C extension
$ python3 -c "import iterm2" → /opt/homebrew/lib/python3.13/site-packages/iterm2   (/usr/bin/python3: ModuleNotFoundError)
$ node --version → v20.19.0 ; npm 10.8.2
$ node --test --experimental-test-coverage --test-coverage-lines=100 m.test.mjs → node: bad option: --test-coverage-lines=100
```
Node 20 has coverage reporting but no thresholds, so `c8` is used (a dev
dependency). The reference suite `python3 -m unittest discover -s tests` in
ultrawatch gives `Ran 163 tests in 0.023s  OK`.

---

## 6. Optional iTerm2 plugin

| Option | What it does | Cost and friction |
|---|---|---|
| A. AutoLaunch Python API script (`~/Library/Application Support/iTerm2/Scripts/AutoLaunch/everwatch.py`) | Holds one persistent API connection and pushes session create/terminate, focus, and tab-color changes to Everwatch via `POST /api/push`. It finds the port and token in `~/Library/Application Support/Everwatch/runtime.json` (mode 0600). | Needs iTerm2's own Python runtime (Scripts → Manage → Install Python Runtime, about 100 MB). It removes the tab-color reconnect every 5 s and gives instant new/closed-tab updates. |
| B. Status bar component (`iterm2.StatusBarComponent`) | "◉ 2 waiting" inside iTerm2's status bar; clicking focuses the longest-waiting session. | Same runtime requirement, plus the user adds it to each profile's status bar by hand. |
| C. Scripts-menu item | "Open Everwatch" and "Next waiting" in the iTerm2 Scripts menu. | Trivial, but the global hotkey already covers it. |

**Recommendation: not in v1.** The menu bar item (W-2) and hotkey (W-4) cover
B and C without any iTerm2-side install, and A only improves latency for an
optional feature. Keep a push-ingest endpoint out of the v1 API. In v1.x,
ship B+A as one `plugin/everwatch_iterm2.py`, installed by
`everwatch plugin install`, if users ask for it.

---

## 7. Work packages

Every package ends with `make test-fast` green, plus `make test-e2e` for
anything UI-facing. "Accept" lists the checks the reviewer runs. The P- and
W-ids listed must have tagged tests.

| WP | Title | Depends on | Scope | Accept | Seniority |
|---|---|---|---|---|---|
| WP1 | **Scaffold + engine port + Python test harness** | — | Repo skeleton (§3.2), MIT LICENSE, .gitignore, Makefile targets (stubs allowed), `everwatch/engine/*` ported (renamed paths and env vars), ultrawatch tests and fixtures ported, the real-I/O guard, coverage gate, py3.9 run, `lint_nosound.py`, `check_parity.py` (reporting only). | `make test-py test-py39 lint` pass; 163+ tests; branch coverage ≥ 90 % on `engine/`; the guard fails a probe test that calls `subprocess.run` unmocked (deliberate-bug check). P-01–P-17, P-51–P-53, P-60, P-68, P-75. | midlevel |
| WP2 | **DataSource + model + engine loop + demo** | WP1 | `sources/{base,real,fake,demo}`, `model.py` (rows, tab labels, paths, titles, usage rows, self/dashboard detection), `engine_loop.py` (single-writer, commands, PublishedState, clock), `persist` v2 + migration, `notify_policy`, `history`, error-code parsing. | Unit tests for every `py` P-row; DemoSource gives byte-identical state for the same seed and clock; migration never sets sound on. P-08, P-18, P-28, P-36, P-48, P-66 (policy), P-69 (logic), P-70–P-72, W-5 (data), W-9. | senior |
| WP3 | **HTTP/SSE server, security, CLI** | WP2 | `server.py`, `sse.py`, `security.py`, every endpoint in §3.5, golden `state_demo.json`, CLI `serve/open/demo/doctor/state/--version`, parent-pipe exit, logging. | Server tests: auth, Host, Origin, and CSRF 403s; each endpoint against FakeSource; SSE framing, `Last-Event-ID`, and backpressure; `everwatch serve --demo --port 0` prints the handshake; `make golden` is idempotent. P-09, P-10, P-74, P-76, P-77. | senior |
| WP4 | **Frontend foundation** | WP3 | `index.html`, tokens and themes (dark, light, system), store, SSE client, keymap reducer, header/status/toasts/hint bar, session row, split + list views, preview, selection and visit, filter and sort, labels, empty states, help sheet. | `make test-js` ≥ 90 % lines; e2e for P-19–P-24, P-27, P-29–P-35, P-37–P-49; AA contrast test passes in both themes. | senior |
| WP5 | **Frontend parity completion** | WP4 | Grid and zoom, usage strip and Usage view, `$`, projects sidebar + colors (keys, context menu, drag), close/new tab dialogs, quota modal, debug rule chip, `b` toggle, compact layout (`?mode=compact`). | e2e for P-25, P-26, P-50, P-54–P-59, P-61–P-65, P-67, P-69; `check_parity.py` reports no missing UI P-ids. | midlevel |
| WP6 | **Swift shell** | WP3 (API), WP4 (page) | `shell/Sources/Core/*` + tests; `Sources/App/*`: window with frame autosave, WKWebView + token user script, backend supervisor, bridge, appearance, native SSE client, status item (W-2), silent notifications with click-to-focus (W-1), hotkeys (W-4), compact NSPanel (W-7), SoundPolicy + SystemSoundPlayer; `scripts/build_app.sh` (universal, ad-hoc sign, icon generated headlessly with `make_icon.sh` + `iconutil`). | `make test-swift` passes (Swift Testing via swiftc); `codesign -dv` shows the identifier; `lint_nosound` passes with only the allowlisted sites; SoundPolicy tests prove `EVERWATCH_NO_SOUND` blocks playback. Manual smoke (maintainer, not CI) is listed in the PR. P-66/P-67 (shell), P-77. | senior |
| WP7 | **Diagnostics + onboarding + tab-color installer** | WP3, WP4, WP6 | `diagnostics.py` checks 1–13, `everwatch doctor`, the onboarding wizard and Settings → Diagnostics, `AEDeterminePermission` bridge, notifications status, venv installer for `iterm2`, ultrawatch import UI. | e2e for each wizard state via `--demo-diagnostics` presets; unit tests for every check's parsing; the `doctor` output snapshot test. **Manual (maintainer):** confirm on a real Mac that the prompt names "Everwatch", that `-1743` is detected after "Don't Allow", and that a runtime-only update keeps the grant. | senior |
| WP8 | **Wow v1: palette, screen search, sparklines, burn-down** | WP5 | W-3 palette (commands from the keymap), W-8 screen search, W-5 row/tile sparklines + detail stats, W-6 usage history store + SVG charts. | JS unit tests for scoring, sparkline, and chart math; e2e tagged W-3, W-5, W-6, W-8; no new runtime dependencies. | midlevel |
| WP9 | **E2E hardening + `make test` aggregate** | WP5 (grows with WP7/WP8) | Playwright config (pinned 1.63.0, headless Chromium, webServer demo), XSS fixture, browser-mode test, `check_parity.py` switched to enforcing, optional WebKit project, `make test` wiring, no-sound lint in CI mode. | Full `make test` passes from a clean clone; `check_parity.py` exits 0 with every non-N/A id tagged; a deliberately untagged id makes it fail. | midlevel |
| WP10 | **Install, update, uninstall, release, README** | WP6, WP7, WP9 | `install.sh` (every §4.1 path, sha256, python discovery without the CLT prompt, fallbacks), `make install` / `install-dev`, `everwatch update` / `uninstall [--purge]`, `scripts/release.sh` (tarball + sha256 + universal app zip; **publishing needs the user's explicit OK**), `make screenshots`, README (hero screenshots dark/light, 60-second install, permissions walkthrough, keys table generated from the keymap, FAQ, troubleshooting TCC, MIT). | `bash -n install.sh`; `install.sh --prefix $(mktemp -d) --from-local build/` works end-to-end without the network (test mode); screenshots regenerate identically twice; README links resolve. | midlevel (README: junior) |

Critical path: WP1 → WP2 → WP3 → WP4 → WP5 → WP9 → WP10. WP6 can start
after WP3, and WP8 after WP5.

---

## 8. Open risks

| Risk | Impact | Mitigation / owner |
|---|---|---|
| TCC attribution through framework Python's `Python.app`: **verified on macOS 27.0** (§3.1). The backend's osascript is charged to Everwatch.app, and the prompt names Everwatch. Not yet checked on macOS 13–26. | On another macOS version the prompt could name "Python" instead, and the grant might not match. | Re-check on older macOS when possible. Fallback: the shell runs osascript itself through a tiny `everwatch-osa` helper, or uses `NSAppleScript`, and exposes it to the backend over its pipe. |
| The shell's Automation probe is a point-in-time snapshot. It can disagree with the backend (e.g. `not_determined` taken before the user clicked OK). | Observed: onboarding stuck on "Connect to iTerm2" and re-checking every 4 s while the backend already had access. | Fixed: the backend's result wins in `mergeAutomation` (unit-tested for every combination), and the shell re-probes on every `iterm.status` change. |
| Ad-hoc cdhash changes whenever the shell is rebuilt. | Users are re-prompted after shell updates. | Keep the shell tiny and stable; runtime-only updates; `make signing-identity` for developers; warn in the updater. |
| The Claude and Codex usage endpoints and screen heuristics are undocumented and move. | Usage rows go missing or states are misclassified. | Same as ultrawatch: fixtures, the debug-rule chip, last-good data, `doctor` shows the HTTP status. |
| Keychain ACL prompt when `security` runs under Everwatch. | An unexpected dialog. | *I believe the ACL is per-binary (`/usr/bin/security`), so it behaves as it did under ultrawatch, but I haven't confirmed it.* WP7 manual check. `docs/PERMISSIONS.md`'s Keychain section has the user-facing fallback if it doesn't. |
| `Testing.__swiftPMEntryPoint` is underscored SPI; the CLT SwiftPM breakage may be fixed or change. | Swift tests stop building. | `build_app.sh` detects this and falls back to a minimal assertion runner; revisit SwiftPM when CLT is fixed. |
| WebKit revision 2359 isn't cached, so the default e2e suite runs on Chromium, not the engine WKWebView uses. | WebKit-only CSS or JS bugs. | Optional `make test-e2e-webkit` (one-time download); only use web features supported by Safari 17+. |
| Payload volume: all screen text for 50+ sessions every 2 s. | CPU use in the webview. | `screens` events carry only changed hashes, and the client renders previews only for visible tiles. |
