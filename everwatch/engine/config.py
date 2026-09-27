"""Intervals, paths, and environment overrides.

Ported from ultrawatch_lib/config.py (values unchanged — P-75). Renamed
for Everwatch: `UW_DEBUG_STATE` -> `EVERWATCH_DEBUG_STATE` (the old name
is still accepted, see `_debug_state_enabled`), and the state directory
moves from `$XDG_CONFIG_HOME/ultrawatch` to
`~/Library/Application Support/Everwatch` (`EVERWATCH_HOME` overrides,
per docs/DESIGN.md §3.7). Every test harness sets `EVERWATCH_HOME` to a
temp dir (see tests/py/__init__.py) so tests never touch a real user's
state.
"""
import os
import pathlib

# Polling cadences (seconds)
SNAPSHOT_INTERVAL = 2          # batched iTerm2 metadata + screen text
PATHS_INTERVAL = 10            # per-session "path" variable loop
AGENTS_INTERVAL = 5            # ps scan for claude/codex ttys
USAGE_REFRESH_INTERVAL = 300   # Claude Code usage API
CODEX_USAGE_REFRESH_INTERVAL = 300
COLOR_INTERVAL = 5             # iTerm2 Python API tab-color poll (optional)


def _float_env(name, default, lo, hi, environ=os.environ):
    """A float from the environment, clamped to [lo, hi]; `default` when
    unset or unparseable."""
    try:
        value = float(environ.get(name, ''))
    except ValueError:
        return default
    if value != value:  # NaN
        return default
    return max(lo, min(hi, value))


# W-10 live preview: while a client holds a lease on a session (the
# selected session's preview is visible), only that session's screen is
# re-read at this cadence on top of the normal snapshot. Override with
# EVERWATCH_LIVE_INTERVAL (seconds, clamped to 0.25-10).
LIVE_INTERVAL = _float_env('EVERWATCH_LIVE_INTERVAL', 1.0, 0.25, 10.0)
LIVE_LEASE_SECONDS = 6         # a lease the client doesn't renew expires
LIVE_MAX_SESSIONS = 3          # at most this many live sessions at once

# Subprocess timeouts (seconds)
OSASCRIPT_TIMEOUT = 10
PS_TIMEOUT = 3
HTTP_TIMEOUT = 5

# UI
# §4.13 (VISUAL_SPEC.md): every toast auto-dismisses at ~3.5 s, errors
# included — a user requirement ("whatever popups we do need should
# disappear by themselves after 3-4 seconds"), overriding this file's
# previous 5 s.
TOAST_SECONDS = 3.5
FLASH_SECONDS = 1.5
FRESH_SECONDS = 30     # idle-less-than-this rows get the green highlight

HOME = str(pathlib.Path.home())
MY_TTY = os.ttyname(0) if os.isatty(0) else ''


def _everwatch_home():
    override = os.environ.get('EVERWATCH_HOME')
    if override:
        return override
    return os.path.join(HOME, 'Library', 'Application Support', 'Everwatch')


EVERWATCH_HOME = _everwatch_home()
STATE_DIR = EVERWATCH_HOME
STATE_PATH = os.path.join(STATE_DIR, 'state.json')


def _debug_state_enabled():
    """`EVERWATCH_DEBUG_STATE=1` (P-18's new name); `UW_DEBUG_STATE=1` is
    still accepted so an ultrawatch habit keeps working."""
    return (os.environ.get('EVERWATCH_DEBUG_STATE') == '1' or
            os.environ.get('UW_DEBUG_STATE') == '1')


DEBUG_STATE = _debug_state_enabled()

LABEL_GC_DAYS = 14
