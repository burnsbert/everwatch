# Everwatch — Future goals

Ideas big enough to need their own design pass. Each one says what exists
today, what the goal is, and a rough plan. Nothing here is scheduled.

## Subagent sessions in the session list

**Deferred from this version:** Everwatch currently lists top-level iTerm2
sessions. A future version could offer a toggle between top-level sessions
only and top-level sessions followed by their subagents.

That version needs a design for matching Codex and Claude Code subagent IDs to
their parent iTerm2 session. Lifecycle hooks are one possible source, but
their installation, trust prompts, runtime cost, and behavior when a hook is
unavailable need review. Subagents without their own terminal would need a
distinct row that does not imply Everwatch can focus or preview a separate
iTerm2 tab. No subagent hooks or tracking are included in this version.

## Fully interactive sessions (a real terminal in the preview)

**Today (W-10, docs/DESIGN.md §2):** the selected session's preview refreshes
about once a second while it's on screen, and a reply bar under it types
text, Return, Esc, Ctrl-C, Tab/Shift-Tab, Backspace, and arrows into the
session. Quick-reply buttons answer Claude Code / Codex menus and y/n
prompts. The preview is still plain text: no colors, no cursor, and
keystrokes go through a text box rather than straight to the program.

**Goal:** the preview *is* the terminal. Click into it and type as if you
were in iTerm2: every key goes to the session as you press it, full-screen
programs (vim, htop, less, Claude Code's own TUI) render and respond
properly, with colors and a cursor, and updates show up in well under a
second.

### Why it's a mountain

- **Terminal emulation in the page.** The screen has to be rendered from a
  cell grid (characters plus attributes: colors, bold, underline, wide
  glyphs, cursor position), not from `text of session`, which throws the
  attributes away. That means vendoring an emulator (xterm.js is the
  obvious choice; about 300 KB, no build step needed if we ship its
  prebuilt ES module) or writing a renderer for iTerm2's own cell data.
  Everwatch has no runtime dependencies today, so this is a first.
- **Streaming screen updates.** AppleScript can only poll the whole
  visible text. Real-time rendering needs the iTerm2 Python API
  (`iterm2` package, the same optional venv tab colors use): a
  `ScreenStreamer` per watched session, pushing
  `ScreenContents` (lines, style runs, cursor) on every change. That's a
  persistent websocket connection to iTerm2 held by a new backend thread,
  plus an async/threads bridge into the single-writer engine. Today's
  color poll reconnects every time, which won't do for streaming.
- **Raw keystroke forwarding.** Every keydown becomes a `send` of that key's
  bytes (xterm.js produces them in its `onData`), so the validation in
  `everwatch/terminput.py` grows from "a text box plus ten named keys" to
  "any byte sequence a terminal can produce", deliberately including
  control characters. The safety model has to change with it (see below).
  Per-key latency matters too: one osascript per key (~50–100 ms) feels
  sluggish, so keys should go through the Python API's `async_send_text`
  over the same persistent connection, batched per animation frame.
- **Size and resize.** The page's terminal and iTerm2's session have to
  agree on rows × columns, or full-screen programs draw garbage. Either the
  preview adopts iTerm2's size (letterboxing or scaling to fit), or it
  resizes the real session, which is visible in iTerm2 and surprising.
- **CPU and battery.** A ScreenStreamer on a busy session (a build log, a
  spinner) produces dozens of updates per second. That needs coalescing to
  the display rate on the backend, diffing rather than full screens over
  SSE (or a websocket for this one stream), and a hard stop when the
  preview is hidden, the window loses visibility, or the Mac is on battery
  and idle.
- **Permissions and trust.** Typing arbitrary keys into a shell from a
  local web page is remote control of that shell. Today's localhost token,
  Host/Origin checks, and JSON-only POSTs still apply, but the feature
  should also be opt-in (a Settings toggle, off by default), be
  unmistakable while active (focus ring, "keys go to <session>" banner),
  need an explicit click into the terminal before keys flow, and refuse
  Everwatch's own tab. The Python API connection also needs iTerm2's
  "Enable Python API" setting, which is another onboarding step.

### Rough plan

1. **Spike (a day or two):** in a scratch branch, drive one session through
   the `iterm2` package with `ScreenStreamer` + `async_send_text`; measure
   update rate, latency per key, and CPU for an idle prompt, a spinner, and
   `yes | head -n 100000`. Decide xterm.js vs. a custom cell renderer from
   what `ScreenContents` actually exposes (style runs vs. per-cell data).
2. **Backend stream:** a `StreamWorker` thread owning one persistent API
   connection; `POST/DELETE /api/sessions/{uid}/stream` (the same lease
   pattern W-10 uses for `live`) starts and stops a streamer; updates reach
   the engine inbox as coalesced `screen_cells` events and go out as their
   own SSE event type, so the plain-text `screens` path stays for
   everything else. Fall back to W-10's 1 s osascript reads when the API
   isn't available.
3. **Keystrokes:** `POST /api/sessions/{uid}/keys` with base64 bytes,
   rate-limited, only while that session holds a stream lease and the
   interactive toggle is on; delivered via `async_send_text`.
4. **Web terminal:** a `views/terminal.mjs` wrapping the emulator, mounted
   in place of the `<pre>` when interactive mode is on; click to focus, Esc
   Esc (or ⌘⇧I) to release focus back to Everwatch's keymap; fit-to-pane
   scaling instead of resizing the iTerm2 session.
5. **Tests:** the demo backend grows a scripted cell stream (a tiny fake
   TUI) so e2e can type into it and assert on rendered cells, headless as
   always; unit tests for the key encoder and the coalescer.
6. **Ship behind the Settings toggle**, default off, with a Diagnostics
   check for the Python API and a README section on the trust model.
