"""iTerm2 interaction: batched AppleScript snapshot, paths, and actions.

Ported verbatim from ultrawatch_lib/iterm.py (P-01, P-04, P-05, P-09).

Protocol notes:
- Screen text contains tabs and newlines, so records use ASCII control
  separators: US (0x1f) between fields, RS (0x1e) between records.
  iTerm2's `text` property returns rendered screen cells, which can never
  contain raw C0 control characters, so the framing is unambiguous.
- AppleScript `&` on a non-text left operand builds a *list*, so every
  numeric field is coerced with `as text` before concatenation.
- Collection queries (`text of sessions of tabs of windows`) cost one
  Apple Event per property regardless of session count (~200ms for a full
  snapshot including all screen text), versus one event per property per
  session for `tell`-style loops.
- Scripts are passed to `osascript -` via stdin; parameters travel through
  `on run argv` — user-influenced strings are never interpolated into
  AppleScript source.
"""
import subprocess

from everwatch.engine import config
from everwatch.engine.snapshot import ItermSnapshot, PathsSnapshot, SessionInfo

US = '\x1f'
RS = '\x1e'
NOT_RUNNING_SENTINEL = '__NOT_RUNNING__'


class ItermNotRunning(Exception):
    pass


class ItermError(Exception):
    pass


SNAPSHOT_SCRIPT = '''
set US to (ASCII character 31)
set RS to (ASCII character 30)
if application "iTerm2" is not running then return "__NOT_RUNNING__"
tell application "iTerm2"
    set winIds to id of windows
    set ids to unique id of sessions of tabs of windows
    set ttys to tty of sessions of tabs of windows
    set procs to is processing of sessions of tabs of windows
    set names to name of sessions of tabs of windows
    set texts to text of sessions of tabs of windows
end tell
set recs to {}
repeat with wi from 1 to (count of ids)
    set wTabs to item wi of ids
    repeat with ti from 1 to (count of wTabs)
        set tSess to item ti of wTabs
        repeat with si from 1 to (count of tSess)
            set end of recs to ((item wi of winIds) as text) & US & ¬
                (ti as text) & US & (si as text) & US & ¬
                (item si of tSess) & US & ¬
                (item si of (item ti of (item wi of ttys))) & US & ¬
                ((item si of (item ti of (item wi of procs))) as text) & US & ¬
                (item si of (item ti of (item wi of names))) & US & ¬
                (item si of (item ti of (item wi of texts)))
        end repeat
    end repeat
end repeat
set AppleScript's text item delimiters to RS
return recs as text
'''

PATHS_SCRIPT = '''
set US to (ASCII character 31)
set RS to (ASCII character 30)
if application "iTerm2" is not running then return "__NOT_RUNNING__"
set recs to {}
tell application "iTerm2"
    repeat with w in windows
        repeat with t in (tabs of w)
            repeat with s in (sessions of t)
                tell s
                    set u to unique id
                    set p to missing value
                    try
                        set p to variable named "path"
                    end try
                end tell
                if p is missing value then set p to ""
                set end of recs to u & US & p
            end repeat
        end repeat
    end repeat
end tell
set AppleScript's text item delimiters to RS
return recs as text
'''

GOTO_SCRIPT = '''
on run argv
    set target to item 1 of argv
    tell application "iTerm2"
        repeat with w in windows
            repeat with t in (tabs of w)
                repeat with s in (sessions of t)
                    if (unique id of s) is target then
                        select s
                        select t
                        select w
                        activate
                        return "ok"
                    end if
                end repeat
            end repeat
        end repeat
    end tell
    return "notfound"
end run
'''

CLOSE_TAB_SCRIPT = '''
on run argv
    set winId to (item 1 of argv) as integer
    set tabIx to (item 2 of argv) as integer
    tell application "iTerm2"
        tell (first window whose id is winId)
            close tab tabIx
        end tell
    end tell
    return "ok"
end run
'''

NEW_TAB_SCRIPT = '''
tell application "iTerm2"
    tell current window
        create tab with default profile
    end tell
    activate
end tell
'''


# Live preview + reply (docs/DESIGN.md W-10). Both scripts find the session
# from the last snapshot's (window id, tab index, session index) hint --
# two Apple Events when the hint is still right -- verifying the unique id
# before touching it, and fall back to the full walk GOTO_SCRIPT does when
# tabs have moved. Every value (uid, hint, text to type) arrives through
# `on run argv`; nothing user-influenced is ever part of the script source.
FIND_SESSION_HANDLER = """
on findSession(target, winId, tabIx, sessIx)
    tell application "iTerm2"
        try
            set s to session sessIx of tab tabIx of window id winId
            if (id of s) is target then return s
        end try
        repeat with w in windows
            repeat with t in (tabs of w)
                repeat with s in (sessions of t)
                    if (unique id of s) is target then return contents of s
                end repeat
            end repeat
        end repeat
    end tell
    return missing value
end findSession
"""

SCREEN_SCRIPT = FIND_SESSION_HANDLER + """
on run argv
    if application "iTerm2" is not running then return "__NOT_RUNNING__"
    set s to my findSession(item 1 of argv, (item 2 of argv) as integer, ¬
        (item 3 of argv) as integer, (item 4 of argv) as integer)
    if s is missing value then return "notfound"
    tell application "iTerm2"
        set t to text of s
    end tell
    return "ok" & (ASCII character 31) & t
end run
"""

# argv 5.. are chunks: "w:<text>" writes <text> exactly as typed (no
# newline of its own), "d:<ms>" pauses. A Return after typed text is sent
# as a separate write after a short pause so Claude Code / Codex see a
# keypress rather than the tail of a paste (which they'd turn into a
# newline instead of a submit).
SEND_SCRIPT = FIND_SESSION_HANDLER + """
on run argv
    if application "iTerm2" is not running then return "__NOT_RUNNING__"
    set s to my findSession(item 1 of argv, (item 2 of argv) as integer, ¬
        (item 3 of argv) as integer, (item 4 of argv) as integer)
    if s is missing value then return "notfound"
    tell application "iTerm2"
        repeat with i from 5 to (count of argv)
            set chunk to item i of argv
            if chunk starts with "d:" then
                delay ((text 3 thru -1 of chunk) as integer) / 1000
            else
                tell s to write text (text 3 thru -1 of chunk) newline no
            end if
        end repeat
    end tell
    return "ok"
end run
"""

SEND_PAUSE_MS = 100


def run_osascript(script, args=(), timeout=config.OSASCRIPT_TIMEOUT):
    """Run an AppleScript from stdin. Returns stdout; raises on failure."""
    result = subprocess.run(
        ['osascript', '-', *args],
        input=script, capture_output=True, text=True, timeout=timeout,
    )
    if result.returncode != 0:
        raise ItermError(result.stderr.strip() or
                         f'osascript exited {result.returncode}')
    return result.stdout


def parse_snapshot(raw, at=0.0):
    """Parse snapshot script output into an ItermSnapshot (pure function)."""
    body = raw.rstrip('\n')
    if body.strip() == NOT_RUNNING_SENTINEL:
        raise ItermNotRunning()
    sessions = []
    if body:
        for rec in body.split(RS):
            parts = rec.split(US, 7)
            if len(parts) != 8:
                continue  # defensive: drop malformed records
            win_id, tab_ix, sess_ix, uid, tty, proc, name, text = parts
            try:
                win_id_i, tab_i, sess_i = int(win_id), int(tab_ix), int(sess_ix)
            except ValueError:
                continue
            if tty == 'missing value':
                tty = ''
            if name == 'missing value':
                name = ''
            sessions.append(SessionInfo(
                window_id=win_id_i, tab_index=tab_i, session_index=sess_i,
                uid=uid, tty=tty, is_processing=(proc == 'true'),
                name=name, text=text))
    return ItermSnapshot(sessions=tuple(sessions), at=at)


def parse_paths(raw, at=0.0):
    """Parse paths script output into a PathsSnapshot (pure function)."""
    body = raw.rstrip('\n')
    if body.strip() == NOT_RUNNING_SENTINEL:
        raise ItermNotRunning()
    pairs = []
    if body:
        for rec in body.split(RS):
            parts = rec.split(US, 1)
            if len(parts) != 2:
                continue
            uid, path = parts
            if path == 'missing value':
                path = ''
            pairs.append((uid, path))
    return PathsSnapshot(paths=tuple(pairs), at=at)


def fetch_snapshot(at=0.0, run=run_osascript):
    return parse_snapshot(run(SNAPSHOT_SCRIPT), at=at)


def fetch_paths(at=0.0, run=run_osascript):
    return parse_paths(run(PATHS_SCRIPT), at=at)


def goto_session(uid, run=run_osascript):
    return run(GOTO_SCRIPT, args=(uid,)).strip() == 'ok'


def close_tab(window_id, tab_index, run=run_osascript):
    run(CLOSE_TAB_SCRIPT, args=(str(window_id), str(tab_index)))


def new_tab(run=run_osascript):
    run(NEW_TAB_SCRIPT)


def _hint_args(uid, hint):
    win, tab, sess = hint or (0, 0, 0)
    return (uid, str(int(win)), str(int(tab)), str(int(sess)))


def _check_running(out):
    if out.strip() == NOT_RUNNING_SENTINEL:
        raise ItermNotRunning()
    return out


def fetch_screen(uid, hint=None, run=run_osascript):
    """One session's visible text, or None if it no longer exists.
    `hint` is (window_id, tab_index, session_index) from the last
    snapshot."""
    out = _check_running(run(SCREEN_SCRIPT, args=_hint_args(uid, hint)))
    body = out.rstrip('\n')
    if not body.startswith('ok' + US):
        return None
    return body[3:]


def send_chunks(writes, pause_ms=SEND_PAUSE_MS):
    """Literal writes (see terminput.items_to_writes) -> SEND_SCRIPT argv
    chunks, pausing between consecutive writes."""
    chunks = []
    for w in writes:
        if chunks:
            chunks.append(f'd:{int(pause_ms)}')
        chunks.append('w:' + w)
    return tuple(chunks)


def send_input(uid, writes, hint=None, run=run_osascript):
    """Type `writes` into session `uid`. Returns False if it's gone."""
    args = _hint_args(uid, hint) + send_chunks(writes)
    return _check_running(run(SEND_SCRIPT, args=args)).strip() == 'ok'
