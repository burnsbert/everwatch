"""DataSource abstraction (docs/DESIGN.md §3.4).

Every piece of outside-world I/O the engine does goes through one of
these methods, so the same engine runs against real iTerm2
(RealSource), a scripted demo fleet (DemoSource), or a test double
(FakeSource).

Error contract:
- fetch_snapshot / fetch_paths raise `ItermNotRunning` when iTerm2 isn't
  running and `ItermError` (any other message) for other failures. The
  message is parsed by `iterm_status_from_error` (P-08) into one of the
  `iterm.status` values the API exposes.
- fetch_colors / set_color raise `ColorApiUnavailable` when the optional
  `iterm2` package is missing (permanent); anything else is transient.
- usage_claude / usage_codex return `(dict|None, retry_after|None)` and
  never raise, like the ported fetchers.
"""
import re
import subprocess

from everwatch.engine.iterm import ItermError, ItermNotRunning  # noqa: F401
from everwatch.engine.itermcolor import ColorApiUnavailable  # noqa: F401

# iterm.status values (docs/DESIGN.md §3.5 State shape).
STATUS_OK = 'ok'
STATUS_CONNECTING = 'connecting'
STATUS_NOT_RUNNING = 'not_running'
STATUS_PERMISSION_DENIED = 'permission_denied'
STATUS_TIMEOUT = 'timeout'
STATUS_ERROR = 'error'

# AppleScript / Apple Event error numbers seen in osascript stderr, e.g.
# "execution error: Not authorized to send Apple events to iTerm. (-1743)"
_APPLE_EVENT_CODES = {
    -1743: STATUS_PERMISSION_DENIED,   # errAEEventNotPermitted
    -1744: STATUS_PERMISSION_DENIED,   # errAEEventWouldRequireUserConsent
    -600: STATUS_NOT_RUNNING,          # procNotFound
    -609: STATUS_NOT_RUNNING,          # connectionInvalid (app quit mid-call)
    -1712: STATUS_TIMEOUT,             # errAETimeout
}
_CODE_RE = re.compile(r'\((-\d+)\)')


def iterm_status_from_error(error):
    """Map an osascript failure (exception or message) to an iterm.status
    value (P-08). Unknown failures are 'error'."""
    if isinstance(error, ItermNotRunning):
        return STATUS_NOT_RUNNING
    if isinstance(error, subprocess.TimeoutExpired):
        return STATUS_TIMEOUT
    text = str(error or '')
    for match in _CODE_RE.finditer(text):
        status = _APPLE_EVENT_CODES.get(int(match.group(1)))
        if status:
            return status
    if 'timed out' in text.lower():
        return STATUS_TIMEOUT
    return STATUS_ERROR


class DataSource:
    """Interface only; see the module docstring for the error contract.
    Subclasses override every method."""

    mode = 'real'

    def fetch_snapshot(self, at=0.0):        # -> ItermSnapshot
        raise NotImplementedError

    def fetch_paths(self, at=0.0):           # -> PathsSnapshot
        raise NotImplementedError

    def goto(self, uid):                     # -> bool (found)
        raise NotImplementedError

    def close_tab(self, window_id, tab_index):
        raise NotImplementedError

    def new_tab(self):
        raise NotImplementedError

    def agent_ttys(self):                    # -> {tty: {'claude','codex'}}
        raise NotImplementedError

    def tty_cwds(self, ttys):                # -> {tty: cwd}
        raise NotImplementedError

    def fetch_colors(self):                  # -> {uid: color name}
        raise NotImplementedError

    def set_color(self, uid, name):          # -> bool
        raise NotImplementedError

    def usage_claude(self):                  # -> (dict|None, retry|None)
        raise NotImplementedError

    def usage_codex(self):
        raise NotImplementedError

    def open_url(self, url):
        raise NotImplementedError

    def launch_iterm(self):
        raise NotImplementedError

    # W-10 live preview + reply. `hint` is the session's last-known
    # (window_id, tab_index, session_index); `items` come from
    # everwatch.terminput.parse_send (already validated).
    def fetch_screen(self, uid, hint=None):  # -> str | None (gone)
        raise NotImplementedError

    def send_input(self, uid, items, hint=None):  # -> bool (found)
        raise NotImplementedError
