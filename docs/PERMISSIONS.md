# Permissions guide

Live iTerm2 monitoring needs **one** macOS permission: Automation access
to control iTerm2. The scripted browser demo needs none. Everything else
(notifications, tab colors, global hotkeys) is optional. This page walks
through every state each permission can be in and the exact fix.

Run `everwatch doctor` any time to see the live state of every check
below as a terminal table (`--json` for raw output). The same checks
appear in the app's onboarding wizard and in Settings → Diagnostics.

## Automation → iTerm2

This is the one permission that matters. Everwatch sends AppleScript
(Apple Events) to iTerm2 to read session state and act on it (go to a
session, close/open a tab); macOS requires per-app consent for that.

| State | What you'll see | Fix |
|---|---|---|
| **Not asked yet** | Diagnostics shows "Automation permission is not yet known — it is granted the first time Everwatch successfully queries iTerm2." | Click **Connect to iTerm2** (or just let Everwatch poll once). macOS shows **"Everwatch" wants to control "iTerm2"** — click **OK**. |
| **Granted** | Diagnostics shows "Everwatch can already control iTerm2." (✓) | Nothing to do. |
| **Denied** | Diagnostics shows "iTerm2 denied Everwatch permission to send Apple Events." (✗) | See [Fixing "Don't Allow"](#fixing-dont-allow) below. |
| **iTerm2 not running** | Diagnostics shows "iTerm2 isn't running. Everwatch keeps polling and recovers on its own once it starts." (⚠) | Click **Launch iTerm2**, or open it yourself. Everwatch needs no restart — it recovers automatically. |

### Fixing "Don't Allow"

If you clicked **Don't Allow** on the system prompt (or denied it earlier
for any reason):

1. Open **System Settings → Privacy & Security → Automation**.
2. Find **Everwatch** in the list of apps.
3. Turn on the checkbox next to **iTerm2**.
4. Back in Everwatch, click **Diagnose** (or just wait — it re-checks on
   its own poll cycle) to confirm it now shows granted.

**If Everwatch doesn't appear in that list at all** (a common symptom when
a permission grant went stale after rebuilding or reinstalling the app),
reset the stale entry and let macOS ask again:

```bash
tccutil reset AppleEvents io.github.burnsbert.everwatch
```

Then relaunch Everwatch. This is a user-level command — it needs no
`sudo` and only affects Everwatch's own entry.

`everwatch uninstall --purge` also runs this same reset as part of a full
uninstall, so a later reinstall starts clean.

### Why it should say "Everwatch", not "your terminal" — and what to do if it doesn't

Unlike ultrawatch (a terminal script, so macOS attributed the Apple Events
to whatever terminal ran it), Everwatch is its own signed app, so the
system prompt is expected to name **Everwatch** specifically. This is
deliberate — it's one of the reasons Everwatch exists as a standalone app
rather than a script. This has been confirmed on macOS 27.0: the
backend's Apple Events are charged to Everwatch, the prompt names
Everwatch, and the grant is stored under Everwatch. Older macOS versions
haven't been checked yet (see `docs/DESIGN.md` §8).

Everwatch checks this permission two ways: its background process (the
one that actually talks to iTerm2) and a quick status query from the app
itself. If they disagree, the background process's result wins. For
example, a query made just before you clicked **OK** can briefly say "not
asked yet" even though access is working.

**If the prompt instead names "Python", "python3", or "Python.app"** (or
Everwatch doesn't appear in the Automation list at all after clicking OK):

1. Open **System Settings → Privacy & Security → Automation**.
2. Find whichever app name actually showed in the prompt (e.g. **Python**)
   and turn on **iTerm2** there — same checkbox, just under that name
   instead of "Everwatch".
3. Run `everwatch doctor` (or click **Diagnose** in the app). The
   Automation check reads the real permission state either way, so it
   reports **granted** regardless of which app name macOS used.
4. To force a clean re-prompt instead, run
   `tccutil reset AppleEvents io.github.burnsbert.everwatch` and relaunch
   Everwatch. If it still names Python after that, please file a bug —
   this is the unverified case above.

## Notifications (optional)

Notifications are **always silent** — Everwatch never uses `.sound` and
never plays audio for a notification, regardless of this setting. This
permission controls whether you see a notification banner when a
session starts waiting on you. Waiting notifications and the Dock icon
count are separate Settings options; both are off by default.

| State | What you'll see | Fix |
|---|---|---|
| **Not determined** | A prompt to "Allow notifications" (requests alerts and badges only — never sound). | Click **Allow notifications** in onboarding/Settings, then approve the system dialog. |
| **Authorized** | Diagnostics/Settings shows notifications enabled. | Nothing to do. |
| **Denied** | Diagnostics offers to open System Settings → Notifications. | Click through, find **Everwatch**, and turn notifications back on. Everwatch still works fully without them — you'll just rely on the menu bar and window instead of a banner. |

Notifications are decided by the backend (on a transition to *waiting*,
once per session at most every 30 seconds) but suppressed by the app while
its own window is frontmost, so you won't be notified about something
you're already looking at. Clicking a notification focuses that exact
iTerm2 session.

## Tab colors (optional)

Tab colors need iTerm2's separate Python API, which is off by default and
needs one extra local install. Everwatch never touches the Python API
unless you opt in.

| State | What you'll see | Fix |
|---|---|---|
| **Not installed** | "The optional `iterm2` Python package is not installed." (⚠) | Click **Enable tab colors**. Everwatch creates a private virtual environment at `~/Library/Application Support/Everwatch/venv` and installs the `iterm2` package into it — nothing is installed system-wide, and your regular `python3` is untouched. Everwatch restarts its backend once this finishes. |
| **iTerm2's Python API disabled** | "iTerm2's Python API is switched off." (⚠) | In iTerm2: **Settings → General → Magic → Enable Python API**, then click **Check again**. The first time Everwatch connects, iTerm2 shows a one-time "allow connection" dialog — approve it. |
| **Available** | "Tab colors are working." (✓) | Nothing to do. |
| **Temporarily unavailable (error)** | "Tab colors are temporarily unavailable." (⚠) | Usually transient (iTerm2 restarting, the API briefly unreachable). Click **Check again**; if it persists, restart iTerm2. |

Without tab colors set up, Everwatch works exactly the same — no error, no
colored dot next to a session, and the project-color keys (`1`–`5`, `0`)
just toast "tab colors unavailable" instead of doing anything.

## Keychain access (optional, for Claude Code usage)

Everwatch reads Claude Code's usage limits the same way the `claude` CLI's
own login already works: an OAuth token stored in the macOS Keychain under
the service name **"Claude Code-credentials"**, read with
`security find-generic-password -s 'Claude Code-credentials' -w`. Everwatch
never writes to the Keychain and never sees your password — only the token
`claude` already stored there.

| State | What you'll see | Fix |
|---|---|---|
| **Not signed in to Claude Code** | No Claude Code row in the Usage view; diagnostics shows "Sign in with `claude` to see limits." | Run `claude` and sign in, then let Everwatch refresh (or click **Diagnose**). |
| **Keychain access prompt** | The first time the token is read, macOS may show a one-time dialog asking whether "security" can access "Claude Code-credentials". | Click **Always Allow** so it doesn't ask again. Choosing **Deny** just means Everwatch can't show Claude Code usage (same as not being signed in) — nothing else breaks. |

The prompt should name **security** (the command-line tool doing the
read), not Everwatch or Python — Keychain ACLs are per-binary, and
Everwatch never touches the Keychain directly. Whether running under
Everwatch changes this at all hasn't been independently confirmed (see
`docs/DESIGN.md` §8's open risk). **If it prompts every launch even after
choosing Always Allow, or names something unexpected:** it doesn't block
anything else — worst case is the same as not being signed in (no Claude
Code row) — but please file a bug with what the dialog said.

Codex usage instead reads `~/.codex/auth.json` directly, which needs no
Keychain access or extra macOS permission.

## Hotkeys (optional)

Global hotkeys (default ⌥⌘E to show Everwatch, ⌥⌘J to jump to the
longest-waiting session) use `RegisterEventHotKey`, which needs **no**
Accessibility or Automation permission. If a hotkey conflicts with another
app already using that combination, Settings reports the conflict and
lets you choose a different shortcut.

## Everything else is read-only

Diagnostics also reports on things that need no permission at all — Python
version, whether iTerm2 is installed, shell integration coverage, agent
detection, Claude/Codex usage-API status, an optional quota-email
config, and a one-time offer to import labels/projects from an existing
ultrawatch install. `everwatch doctor` (or Settings → Diagnostics) shows
the state of all of these together.
