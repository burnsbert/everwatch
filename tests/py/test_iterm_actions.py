"""New tests covering osascript invocation and iTerm2 actions (P-04, P-09):
not covered by ultrawatch's own suite, which only unit-tests the pure
parsers (see test_iterm_parse.py) and injects a fake `run` for actions
elsewhere. These exercise run_osascript() itself (stdin script, argv
args, timeout, error handling) and the three action helpers.
"""
import unittest
from unittest import mock

from everwatch.engine import config, iterm


class TestRunOsascript(unittest.TestCase):
    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_script_goes_to_stdin_args_in_argv(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=0, stdout='ok\n', stderr='')
        out = iterm.run_osascript('tell app "X"', args=('a', 'b'))
        self.assertEqual(out, 'ok\n')
        call_args, call_kwargs = run.call_args
        self.assertEqual(call_args[0], ['osascript', '-', 'a', 'b'])
        self.assertEqual(call_kwargs['input'], 'tell app "X"')
        self.assertNotIn('tell app "X"', call_args[0])  # never interpolated

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_default_timeout_is_the_configured_constant(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=0, stdout='', stderr='')
        iterm.run_osascript('script')
        self.assertEqual(run.call_args.kwargs['timeout'], config.OSASCRIPT_TIMEOUT)

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_custom_timeout_is_passed_through(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=0, stdout='', stderr='')
        iterm.run_osascript('script', timeout=1)
        self.assertEqual(run.call_args.kwargs['timeout'], 1)

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_nonzero_exit_raises_iterm_error_with_stderr(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=1, stdout='', stderr='boom\n')
        with self.assertRaises(iterm.ItermError) as ctx:
            iterm.run_osascript('script')
        self.assertEqual(str(ctx.exception), 'boom')

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_empty_stderr_falls_back_to_generic_message(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=2, stdout='', stderr='   ')
        with self.assertRaises(iterm.ItermError) as ctx:
            iterm.run_osascript('script')
        self.assertEqual(str(ctx.exception), 'osascript exited 2')


class TestFetchWrappers(unittest.TestCase):
    def test_fetch_snapshot_uses_injected_run(self):  # parity: P-01
        raw = 'garbage-no-separators'
        snap = iterm.fetch_snapshot(at=9.0, run=lambda script, args=(): raw)
        self.assertEqual(snap.at, 9.0)
        self.assertEqual(snap.sessions, ())

    def test_fetch_paths_uses_injected_run(self):  # parity: P-05
        raw = f'UID-1{iterm.US}/tmp'
        snap = iterm.fetch_paths(at=3.0, run=lambda script, args=(): raw)
        self.assertEqual(snap.at, 3.0)
        self.assertEqual(snap.paths, (('UID-1', '/tmp'),))

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_fetch_snapshot_default_run_hits_osascript(self, run):  # parity: P-04
        run.return_value = mock.Mock(returncode=0, stdout='\n', stderr='')
        snap = iterm.fetch_snapshot(at=1.0)
        self.assertEqual(snap.sessions, ())
        self.assertEqual(run.call_args[0][0][:2], ['osascript', '-'])


class TestGotoSession(unittest.TestCase):
    def test_ok_returns_true(self):  # parity: P-09
        self.assertTrue(
            iterm.goto_session('UID-1', run=lambda s, args=(): 'ok\n'))

    def test_notfound_returns_false(self):  # parity: P-09
        self.assertFalse(
            iterm.goto_session('UID-1', run=lambda s, args=(): 'notfound'))

    def test_uid_is_passed_as_argv_not_interpolated(self):  # parity: P-09
        seen = {}

        def fake_run(script, args=()):
            seen['args'] = args
            return 'ok'
        iterm.goto_session('UID-42', run=fake_run)
        self.assertEqual(seen['args'], ('UID-42',))


class TestCloseTab(unittest.TestCase):
    def test_window_and_tab_ids_stringified_as_argv(self):  # parity: P-09
        calls = []
        iterm.close_tab(4711, 3,
                        run=lambda s, args=(): calls.append(args) or 'ok')
        self.assertEqual(calls, [('4711', '3')])


class TestNewTab(unittest.TestCase):
    def test_runs_new_tab_script(self):  # parity: P-09
        calls = []
        iterm.new_tab(run=lambda s, args=(): calls.append(s) or '')
        self.assertEqual(len(calls), 1)
        self.assertIn('create tab with default profile', calls[0])


if __name__ == '__main__':
    unittest.main()
