"""FakeSource: a fully scriptable DataSource for tests (docs/DESIGN.md
§3.4). Every method records its call in `calls` and returns the next
queued response for that method, falling back to a sticky default.

    src = FakeSource()
    src.set('fetch_snapshot', snap)                 # sticky default
    src.queue('fetch_snapshot', ItermNotRunning())  # one-shot; raised
    src.calls  # [('fetch_snapshot', (), {'at': 12.0}), ...]

A queued/default value that is an Exception instance (or class) is
raised instead of returned. A callable default is called with the
method's arguments.
"""
from collections import defaultdict, deque

from everwatch.engine.snapshot import ItermSnapshot, PathsSnapshot
from everwatch.sources.base import DataSource

_DEFAULTS = {
    'fetch_snapshot': ItermSnapshot(),
    'fetch_paths': PathsSnapshot(),
    'goto': True,
    'close_tab': None,
    'new_tab': None,
    'agent_ttys': {},
    'tty_cwds': {},
    'fetch_colors': {},
    'set_color': True,
    'usage_claude': (None, None),
    'usage_codex': (None, None),
    'open_url': None,
    'launch_iterm': None,
    'fetch_screen': None,
    'send_input': True,
}


class FakeSource(DataSource):
    mode = 'fake'

    def __init__(self, **defaults):
        self.defaults = dict(_DEFAULTS)
        self.defaults.update(defaults)
        self.queues = defaultdict(deque)
        self.calls = []

    def set(self, method, value):
        self.defaults[method] = value

    def queue(self, method, *values):
        self.queues[method].extend(values)

    def calls_to(self, method):
        return [c for c in self.calls if c[0] == method]

    def _respond(self, method, *args, **kwargs):
        self.calls.append((method, args, kwargs))
        q = self.queues[method]
        value = q.popleft() if q else self.defaults[method]
        if isinstance(value, type) and issubclass(value, BaseException):
            raise value()
        if isinstance(value, BaseException):
            raise value
        if callable(value) and not isinstance(value, type):
            return value(*args, **kwargs)
        return value

    def fetch_snapshot(self, at=0.0):
        snap = self._respond('fetch_snapshot', at=at)
        if isinstance(snap, ItermSnapshot) and snap.at != at:
            snap = ItermSnapshot(sessions=snap.sessions, at=at,
                                 not_running=snap.not_running,
                                 error=snap.error)
        return snap

    def fetch_paths(self, at=0.0):
        return self._respond('fetch_paths', at=at)

    def goto(self, uid):
        return self._respond('goto', uid)

    def close_tab(self, window_id, tab_index):
        return self._respond('close_tab', window_id, tab_index)

    def new_tab(self):
        return self._respond('new_tab')

    def agent_ttys(self):
        return self._respond('agent_ttys')

    def tty_cwds(self, ttys):
        return self._respond('tty_cwds', ttys)

    def fetch_colors(self):
        return self._respond('fetch_colors')

    def set_color(self, uid, name):
        return self._respond('set_color', uid, name)

    def usage_claude(self):
        return self._respond('usage_claude')

    def usage_codex(self):
        return self._respond('usage_codex')

    def open_url(self, url):
        return self._respond('open_url', url)

    def launch_iterm(self):
        return self._respond('launch_iterm')

    def fetch_screen(self, uid, hint=None):
        return self._respond('fetch_screen', uid, hint=hint)

    def send_input(self, uid, items, hint=None):
        return self._respond('send_input', uid, items, hint=hint)
