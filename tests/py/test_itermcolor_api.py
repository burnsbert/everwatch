"""Exercises itermcolor.py's async iTerm2-Python-API paths (P-60) with a
minimal fake `iterm2` module injected via sys.modules, since the real
`iterm2` package isn't installed in the test environment (and must never
be reached for real per the hard rules). This covers fetch_colors(),
set_session_color(), and the connection lifecycle in _run_connected()
that ultrawatch's own suite didn't exercise (it only unit-tested the
pure classify_rgb()/uid_from_session_id() helpers and the "package not
installed" branch — see test_itermcolor.py).
"""
import sys
import types
import unittest
from unittest import mock

from everwatch.engine import itermcolor


class _FakeColor:
    def __init__(self, r, g, b):
        self.red, self.green, self.blue = r, g, b


class _FakeProfile:
    def __init__(self, use_tab_color=False, color=None):
        self.use_tab_color = use_tab_color
        self.tab_color = color


class _FakeSession:
    def __init__(self, session_id, profile=None):
        self.session_id = session_id
        self._profile = profile
        self.injected = []

    async def async_get_profile(self):
        return self._profile

    async def async_inject(self, data):
        self.injected.append(data)


class _FakeTab:
    def __init__(self, sessions):
        self.sessions = sessions


class _FakeWindow:
    def __init__(self, tabs):
        self.tabs = tabs


class _FakeApp:
    def __init__(self, windows):
        self.windows = windows


class _FakeConnection:
    """Runs `main(self)` to completion on a private event loop, mirroring
    enough of iterm2.Connection's shape for _run_connected()."""

    def __init__(self, app):
        self.loop = None
        self._app = app

    def run_until_complete(self, main, retry=False):
        import asyncio
        loop = asyncio.new_event_loop()
        self.loop = loop
        try:
            loop.run_until_complete(main(self))
        finally:
            pass  # _run_connected() closes self.loop itself


def _install_fake_iterm2(app):
    async def async_get_app(connection):
        return connection._app

    fake = types.ModuleType('iterm2')
    fake.Connection = lambda: _FakeConnection(app)
    fake.async_get_app = async_get_app
    return fake


class TestFetchColors(unittest.TestCase):
    def _app_with_sessions(self):
        colored = _FakeSession(
            'w0t0p0:AAAA', _FakeProfile(True, _FakeColor(95, 163, 248)))
        no_color_attr = _FakeSession('w0t0p1:BBBB', _FakeProfile(True, None))
        color_off = _FakeSession(
            'w0t0p2:CCCC', _FakeProfile(False, _FakeColor(251, 107, 98)))
        no_profile = _FakeSession('w0t0p3:DDDD', None)
        return _FakeApp([_FakeWindow([_FakeTab(
            [colored, no_color_attr, color_off, no_profile])])])

    def test_fetch_colors_classifies_only_colored_sessions(self):  # parity: P-60
        fake_iterm2 = _install_fake_iterm2(self._app_with_sessions())
        with mock.patch.dict(sys.modules, {'iterm2': fake_iterm2}):
            colors = itermcolor.fetch_colors()
        self.assertEqual(colors, {'AAAA': 'blue'})

    def test_fetch_colors_empty_when_no_windows(self):  # parity: P-60
        fake_iterm2 = _install_fake_iterm2(_FakeApp([]))
        with mock.patch.dict(sys.modules, {'iterm2': fake_iterm2}):
            self.assertEqual(itermcolor.fetch_colors(), {})


class TestSetSessionColor(unittest.TestCase):
    def _app_with_one_session(self):
        session = _FakeSession('w0t0p0:TARGET')
        return _FakeApp([_FakeWindow([_FakeTab([session])])]), session

    def test_sets_color_by_injecting_osc6_escape(self):  # parity: P-60
        app, session = self._app_with_one_session()
        fake_iterm2 = _install_fake_iterm2(app)
        with mock.patch.dict(sys.modules, {'iterm2': fake_iterm2}):
            ok = itermcolor.set_session_color('TARGET', 'blue')
        self.assertTrue(ok)
        self.assertEqual(len(session.injected), 1)
        self.assertIn(b'\x1b]6;1;bg;red;brightness;95\x07', session.injected[0])

    def test_clears_color_with_reset_sequence(self):  # parity: P-60
        app, session = self._app_with_one_session()
        fake_iterm2 = _install_fake_iterm2(app)
        with mock.patch.dict(sys.modules, {'iterm2': fake_iterm2}):
            ok = itermcolor.set_session_color('TARGET', None)
        self.assertTrue(ok)
        self.assertEqual(session.injected, [itermcolor.TAB_COLOR_RESET_BYTES])

    def test_uid_not_found_returns_false(self):  # parity: P-60
        app, _session = self._app_with_one_session()
        fake_iterm2 = _install_fake_iterm2(app)
        with mock.patch.dict(sys.modules, {'iterm2': fake_iterm2}):
            ok = itermcolor.set_session_color('NOPE', 'blue')
        self.assertFalse(ok)


if __name__ == '__main__':
    unittest.main()
