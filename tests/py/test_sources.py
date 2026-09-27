"""DataSource interface, error-code parsing (P-08), FakeSource, and the
RealSource delegation layer. RealSource tests inject/mocks every I/O
entry point; nothing real runs (the tests/py guard enforces it)."""
import subprocess
import unittest
from unittest import mock

from everwatch.engine import iterm
from everwatch.engine.snapshot import ItermSnapshot
from everwatch.sources import base
from everwatch.sources.fake import FakeSource
from everwatch.sources.real import RealSource


class TestItermStatusFromError(unittest.TestCase):
    def test_permission_denied_1743(self):  # parity: P-08
        msg = ('execution error: Not authorized to send Apple events to '
               'iTerm. (-1743)')
        self.assertEqual(base.iterm_status_from_error(msg),
                         'permission_denied')
        self.assertEqual(base.iterm_status_from_error(iterm.ItermError(msg)),
                         'permission_denied')

    def test_not_running_600(self):  # parity: P-08
        self.assertEqual(base.iterm_status_from_error(
            "iTerm got an error: Application isn't running. (-600)"),
            'not_running')
        self.assertEqual(base.iterm_status_from_error(iterm.ItermNotRunning()),
                         'not_running')

    def test_timeout_1712_and_subprocess_timeout(self):  # parity: P-08
        self.assertEqual(base.iterm_status_from_error(
            'AppleEvent timed out. (-1712)'), 'timeout')
        self.assertEqual(base.iterm_status_from_error(
            subprocess.TimeoutExpired(['osascript', '-'], 10)), 'timeout')
        self.assertEqual(base.iterm_status_from_error(
            "Command '['osascript', '-']' timed out after 10 seconds"),
            'timeout')

    def test_unknown_codes_and_text_are_error(self):  # parity: P-08
        self.assertEqual(base.iterm_status_from_error('boom (-1)'), 'error')
        self.assertEqual(base.iterm_status_from_error(''), 'error')
        self.assertEqual(base.iterm_status_from_error(None), 'error')


class TestInterface(unittest.TestCase):
    def test_every_method_is_abstract(self):
        ds = base.DataSource()
        calls = [('fetch_snapshot', ()), ('fetch_paths', ()), ('goto', ('u',)),
                 ('close_tab', (1, 2)), ('new_tab', ()), ('agent_ttys', ()),
                 ('tty_cwds', ((),)), ('fetch_colors', ()),
                 ('set_color', ('u', None)), ('usage_claude', ()),
                 ('usage_codex', ()), ('open_url', ('https://x',)),
                 ('launch_iterm', ())]
        for name, args in calls:
            with self.subTest(name), self.assertRaises(NotImplementedError):
                getattr(ds, name)(*args)


class TestFakeSource(unittest.TestCase):
    def test_defaults_queue_and_calls(self):
        src = FakeSource()
        self.assertEqual(src.agent_ttys(), {})
        src.queue('goto', False)
        self.assertFalse(src.goto('A'))
        self.assertTrue(src.goto('B'))  # back to the sticky default
        self.assertEqual([c[1] for c in src.calls_to('goto')],
                         [('A',), ('B',)])

    def test_exceptions_are_raised_classes_and_instances(self):
        src = FakeSource()
        src.queue('fetch_snapshot', iterm.ItermNotRunning,
                  iterm.ItermError('(-1743)'))
        with self.assertRaises(iterm.ItermNotRunning):
            src.fetch_snapshot(at=1.0)
        with self.assertRaises(iterm.ItermError):
            src.fetch_snapshot(at=1.0)

    def test_callable_defaults_receive_arguments(self):
        src = FakeSource(tty_cwds=lambda ttys: {t: '/x' for t in ttys})
        self.assertEqual(src.tty_cwds(['/dev/a']), {'/dev/a': '/x'})

    def test_snapshot_is_restamped_with_requested_time(self):
        src = FakeSource()
        src.set('fetch_snapshot', ItermSnapshot(at=1.0))
        self.assertEqual(src.fetch_snapshot(at=9.0).at, 9.0)

    def test_remaining_methods_record(self):
        src = FakeSource()
        src.fetch_paths(at=1)
        src.close_tab(1, 2)
        src.new_tab()
        src.fetch_colors()
        src.set_color('u', 'red')
        src.usage_claude()
        src.usage_codex()
        src.open_url('https://example.com')
        src.launch_iterm()
        self.assertEqual(len(src.calls), 9)


class TestRealSource(unittest.TestCase):
    def test_osascript_calls_go_through_the_injected_runner(self):
        run = mock.Mock(side_effect=['', '', 'ok\n', 'ok', ''])
        src = RealSource(run=run)
        self.assertEqual(src.fetch_snapshot(at=3.0).sessions, ())
        self.assertEqual(src.fetch_paths(at=3.0).paths, ())
        self.assertTrue(src.goto('UID'))
        src.close_tab(7, 2)
        src.new_tab()
        self.assertEqual(run.call_args_list[2][1]['args'], ('UID',))
        self.assertEqual(run.call_args_list[3][1]['args'], ('7', '2'))

    def test_default_runner_is_the_ported_osascript_runner(self):
        self.assertIs(RealSource()._run, iterm.run_osascript)

    def test_agents_colors_usage_delegate(self):
        src = RealSource(run=mock.Mock())
        with mock.patch('everwatch.sources.real.agents.get_agent_ttys',
                        return_value={'/dev/a': {'claude'}}) as a, \
                mock.patch('everwatch.sources.real.agents.'
                           'fill_missing_tty_cwds',
                           return_value={'/dev/a': '/p'}) as f, \
                mock.patch('everwatch.sources.real.itermcolor.fetch_colors',
                           return_value={'U': 'red'}), \
                mock.patch('everwatch.sources.real.itermcolor.'
                           'set_session_color', return_value=True) as sc, \
                mock.patch('everwatch.sources.real.usage_claude.fetch_usage',
                           return_value=({'x': 1}, None)), \
                mock.patch('everwatch.sources.real.usage_codex.'
                           'fetch_codex_usage', return_value=(None, 30)):
            self.assertEqual(src.agent_ttys(), {'/dev/a': {'claude'}})
            self.assertEqual(src.tty_cwds(['/dev/a']), {'/dev/a': '/p'})
            self.assertEqual(src.fetch_colors(), {'U': 'red'})
            self.assertTrue(src.set_color('U', 'blue'))
            self.assertEqual(src.usage_claude(), ({'x': 1}, None))
            self.assertEqual(src.usage_codex(), (None, 30))
        a.assert_called_once_with()
        f.assert_called_once_with(['/dev/a'])
        sc.assert_called_once_with('U', 'blue')

    def test_open_url_and_launch_use_open(self):
        popen = mock.Mock()
        src = RealSource(run=mock.Mock(), popen=popen)
        src.open_url('https://mail.google.com/mail/?view=cm')
        src.launch_iterm()
        self.assertEqual(popen.call_args_list[0][0][0],
                         ['open', 'https://mail.google.com/mail/?view=cm'])
        self.assertEqual(popen.call_args_list[1][0][0],
                         ['open', '-b', 'com.googlecode.iterm2'])

    def test_open_url_refuses_non_https(self):
        popen = mock.Mock()
        src = RealSource(run=mock.Mock(), popen=popen)
        for url in ('file:///etc/passwd', 'javascript:alert(1)',
                    'http://example.com'):
            with self.subTest(url), self.assertRaises(ValueError):
                src.open_url(url)
        popen.assert_not_called()

    def test_default_spawn_is_subprocess_popen_and_guarded(self):
        # Without an injected popen, RealSource uses subprocess.Popen --
        # which the tests/py guard replaces, proving no real `open` runs.
        from tests.py import RealIOForbidden
        with self.assertRaises(RealIOForbidden):
            RealSource(run=mock.Mock()).launch_iterm()


if __name__ == '__main__':
    unittest.main()
