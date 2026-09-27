"""cli.py: argument parsing, `everwatch --version`, the stub commands,
`everwatch state`, and a real (subprocess-free) `everwatch serve
--demo --parent-pipe` run: handshake line, live HTTP, and parent-pipe
EOF shutdown (docs/DESIGN.md §3.1, §4.1, §7 WP3 row)."""
import contextlib
import http.client
import io
import json
import os
import plistlib
import signal
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from everwatch import cli, diagnostics
from everwatch.sources.demo import build_demo_engine
from everwatch.sources.fake import FakeSource


class TestParser(unittest.TestCase):
    def test_version_flag_exits_zero(self):  # parity: P-77
        with self.assertRaises(SystemExit) as ctx:
            cli.build_parser().parse_args(['--version'])
        self.assertEqual(ctx.exception.code, 0)

    def test_help_flag_still_prints_usage_and_exits_zero(self):
        # `--help`/`-h` must stay exactly what they were: bare `everwatch`
        # (below) is the only thing that changes.
        out = io.StringIO()
        with mock.patch('sys.stdout', out):
            with self.assertRaises(SystemExit) as ctx:
                cli.build_parser().parse_args(['--help'])
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn('usage', out.getvalue().lower())

    def test_h_flag_still_prints_usage_and_exits_zero(self):
        out = io.StringIO()
        with mock.patch('sys.stdout', out):
            with self.assertRaises(SystemExit) as ctx:
                cli.build_parser().parse_args(['-h'])
        self.assertEqual(ctx.exception.code, 0)
        self.assertIn('usage', out.getvalue().lower())

    def test_help_text_mentions_bare_invocation_opens_the_app(self):
        out = io.StringIO()
        with mock.patch('sys.stdout', out):
            with self.assertRaises(SystemExit):
                cli.build_parser().parse_args(['--help'])
        self.assertIn('everwatch app', out.getvalue())

    def test_app_subcommand_exists(self):
        args = cli.build_parser().parse_args(['app'])
        self.assertIs(args.func, cli.cmd_app)
        self.assertEqual(args.port, 0)
        self.assertFalse(args.demo)

    def test_serve_defaults(self):
        args = cli.build_parser().parse_args(['serve'])
        self.assertEqual(args.port, 0)
        self.assertFalse(args.demo)
        self.assertEqual(args.seed, 1)
        self.assertEqual(args.clock, '')
        self.assertIsNone(args.token)
        self.assertFalse(args.parent_pipe)
        self.assertFalse(args.no_open)
        self.assertIs(args.func, cli.cmd_serve)

    def test_serve_all_flags(self):  # parity: P-76
        args = cli.build_parser().parse_args([
            'serve', '--port', '9', '--demo', '--seed', '3',
            '--clock', 'fixed:2026-01-01T00:00:00Z', '--token', 'tttt',
            '--parent-pipe', '--no-open'])
        self.assertEqual(args.port, 9)
        self.assertTrue(args.demo)
        self.assertEqual(args.seed, 3)
        self.assertEqual(args.clock, 'fixed:2026-01-01T00:00:00Z')
        self.assertEqual(args.token, 'tttt')
        self.assertTrue(args.parent_pipe)
        self.assertTrue(args.no_open)

    def test_open_demo_state_subcommands_exist(self):  # parity: P-76
        for argv, func in ((['open'], cli.cmd_open),
                          (['demo'], cli.cmd_demo),
                          (['state'], cli.cmd_state)):
            args = cli.build_parser().parse_args(argv)
            self.assertIs(args.func, func, argv)

    def test_update_uninstall_subcommands_exist(self):  # parity: P-76
        args = cli.build_parser().parse_args(['update'])
        self.assertIs(args.func, cli.cmd_update)
        self.assertFalse(args.yes)
        self.assertFalse(args.no_open)

        args = cli.build_parser().parse_args(['uninstall'])
        self.assertIs(args.func, cli.cmd_uninstall)
        self.assertFalse(args.purge)
        self.assertFalse(args.yes)

        args = cli.build_parser().parse_args(
            ['update', '--yes', '--no-open'])
        self.assertTrue(args.yes)
        self.assertTrue(args.no_open)

        args = cli.build_parser().parse_args(['uninstall', '--purge', '--yes'])
        self.assertTrue(args.purge)
        self.assertTrue(args.yes)

    def test_doctor_subcommand_defaults(self):
        args = cli.build_parser().parse_args(['doctor'])
        self.assertIs(args.func, cli.cmd_doctor)
        self.assertFalse(args.demo)
        self.assertFalse(args.json)
        self.assertIsNone(args.demo_diagnostics)

    def test_demo_diagnostics_rejects_unknown_preset(self):
        with self.assertRaises(SystemExit):
            cli.build_parser().parse_args(
                ['serve', '--demo-diagnostics', 'nonsense'])


class TestBuildEngine(unittest.TestCase):
    def test_demo_engine_is_in_demo_mode(self):
        args = cli.build_parser().parse_args(['state', '--demo'])
        engine = cli.build_engine(args)
        self.assertEqual(engine.mode, 'demo')
        engine.stop()

    def test_selftest_flag_defaults_off(self):
        self.assertFalse(cli.build_parser().parse_args(['serve']).selftest)
        self.assertTrue(cli.build_parser().parse_args(
            ['serve', '--selftest']).selftest)

    def test_selftest_engine_is_demo_with_everything_faked(self):
        # Everwatch.app's EVERWATCH_SELFTEST mode spawns
        # `serve --demo --selftest`: no real probe and no real venv/pip.
        args = cli.build_parser().parse_args(['serve', '--selftest'])
        engine = cli.build_engine(args)
        self.assertEqual(engine.mode, 'demo')
        self.assertIsInstance(engine.diag_probes, diagnostics.FakeProbes)
        self.assertEqual(engine._demo_diag_preset, 'all_ok')
        self.assertIs(engine.colors_installer.runner, cli._selftest_runner)
        steps = list(engine.colors_installer.install('/nonexistent/venv'))
        self.assertEqual(steps[-1][0], 'restart_required')
        engine.stop()

    def test_selftest_keeps_an_explicit_diagnostics_preset(self):
        args = cli.build_parser().parse_args(
            ['serve', '--demo', '--selftest', '--demo-diagnostics',
             'first_run'])
        engine = cli.build_engine(args)
        self.assertEqual(engine._demo_diag_preset, 'first_run')
        engine.stop()

    def test_selftest_runner_never_runs_anything(self):
        self.assertEqual(cli._selftest_runner(['pip', 'install', 'x'],
                                              timeout=1), (0, '', ''))

    def test_real_engine_uses_real_source_without_starting_it(self):
        # Construction only; never call .start() here (hard rule: never
        # run the real source in tests). RealSource's own I/O is guarded
        # and tested in tests/py/test_iterm_*.py.
        args = cli.build_parser().parse_args(['serve'])
        engine = cli.build_engine(args)
        self.assertEqual(engine.mode, 'real')


class TestStateCommand(unittest.TestCase):
    def test_state_demo_dumps_json(self):  # parity: P-74
        out = io.StringIO()
        code = cli.main(['state', '--demo'], stdin=io.StringIO(), stdout=out)
        self.assertEqual(code, 0)
        state = json.loads(out.getvalue())
        self.assertEqual(state['mode'], 'demo')
        self.assertIn('sessions', state)
        self.assertIn('version', state)


class TestBrowserWiring(unittest.TestCase):
    """cmd_open/cmd_demo/cmd_serve decide whether to open a browser and
    hand the right token/port through to `_run_server`; this is checked
    without ever starting a real HTTP server or touching a browser."""

    def _run(self, cmd, argv, fake_result=(0, 4242)):
        calls = []

        def fake_run_server(engine, **kwargs):
            calls.append(kwargs)
            engine.stop()
            return fake_result

        args = cli.build_parser().parse_args(argv)
        with mock.patch('everwatch.cli._run_server',
                        side_effect=fake_run_server):
            code = cmd(args, stdin=io.StringIO(), stdout=io.StringIO())
        self.assertEqual(len(calls), 1)
        return code, calls[0]

    def test_open_always_opens_browser(self):
        code, kwargs = self._run(cli.cmd_open, ['open', '--demo'])
        self.assertEqual(code, 0)
        self.assertTrue(kwargs['open_browser'])
        self.assertFalse(kwargs['parent_pipe'])

    def test_demo_opens_browser_by_default(self):
        code, kwargs = self._run(cli.cmd_demo, ['demo'])
        self.assertEqual(code, 0)
        self.assertTrue(kwargs['open_browser'])

    def test_demo_no_open_suppresses_browser(self):
        _code, kwargs = self._run(cli.cmd_demo, ['demo', '--no-open'])
        self.assertFalse(kwargs['open_browser'])

    def test_serve_never_opens_browser_by_default(self):
        # `serve` is the backend-only entry point (the shell, tests, and
        # `make golden` all spawn it): only `open`/`demo` open a browser.
        _code, kwargs = self._run(cli.cmd_serve, ['serve', '--demo'])
        self.assertFalse(kwargs['open_browser'])

    def test_serve_no_open_still_accepted_and_still_a_noop(self):
        _code, kwargs = self._run(
            cli.cmd_serve, ['serve', '--demo', '--no-open'])
        self.assertFalse(kwargs['open_browser'])

    def test_serve_parent_pipe_still_suppresses_browser(self):
        _code, kwargs = self._run(
            cli.cmd_serve, ['serve', '--demo', '--parent-pipe'])
        self.assertFalse(kwargs['open_browser'])
        self.assertTrue(kwargs['parent_pipe'])

    def test_webbrowser_open_builds_localhost_url_with_token(self):
        with mock.patch('everwatch.cli.webbrowser.open') as mock_open:
            cli._open_url(4242, 'tok123')
        mock_open.assert_called_once_with(
            'http://127.0.0.1:4242/#t=tok123')


class TestServeUntilStoppedRestartLoop(unittest.TestCase):
    """`_serve_until_stopped` (used by `cmd_open`/`cmd_demo`, not
    `cmd_serve`, which stays supervised by the native shell): a normal
    exit code returns immediately; `EX_TEMPFAIL` (the tab-colors
    installer's restart request, Fix 3 / docs/build/wp7-handoff.md)
    rebuilds the engine and restarts on the same port and token, opening
    a browser tab only on the very first pass. Without this loop, a
    browser-mode "Enable tab colors" install would kill the server for
    good (the user saw a `goto` failure and a stale page)."""

    def _fake_run_server(self, results):
        calls = []
        results = iter(results)

        def fake(engine, **kwargs):
            calls.append(kwargs)
            return next(results)

        return calls, fake

    def test_normal_exit_returns_immediately_without_restarting(self):
        calls, fake = self._fake_run_server([(0, 4242)])
        factory_calls = []

        def factory():
            factory_calls.append(1)
            return object()

        with mock.patch('everwatch.cli._run_server', side_effect=fake):
            code = cli._serve_until_stopped(
                factory, host='127.0.0.1', port=0, token='tok',
                stdin=io.StringIO(), stdout=io.StringIO(),
                open_browser=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(factory_calls), 1)
        self.assertTrue(calls[0]['open_browser'])

    def test_ex_tempfail_restarts_reusing_port_and_token_once_only(self):
        calls, fake = self._fake_run_server(
            [(cli.EX_TEMPFAIL, 4242), (cli.EX_TEMPFAIL, 4242), (0, 4242)])
        factory_calls = []

        def factory():
            factory_calls.append(1)
            return object()

        out = io.StringIO()
        with mock.patch('everwatch.cli._run_server', side_effect=fake):
            code = cli._serve_until_stopped(
                factory, host='127.0.0.1', port=0, token='tok',
                stdin=io.StringIO(), stdout=out, open_browser=True)
        self.assertEqual(code, 0)
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(factory_calls), 3)  # a fresh engine each pass
        # First pass: the original (ephemeral) port, browser opens.
        self.assertEqual(calls[0]['port'], 0)
        self.assertTrue(calls[0]['open_browser'])
        # Every restart: the actual resolved port, no second browser tab.
        for kwargs in calls[1:]:
            self.assertEqual(kwargs['port'], 4242)
            self.assertFalse(kwargs['open_browser'])
        for kwargs in calls:
            self.assertEqual(kwargs['token'], 'tok')
        self.assertIn('Restarting', out.getvalue())


class TestBareAndAppCommand(unittest.TestCase):
    """Bare `everwatch` and its explicit `everwatch app` alias: launch
    the installed native app, or fall back to exactly `everwatch open`'s
    behavior when there's no app to launch (a --browser-only install).
    Never runs a real `open`: `_launch_app` is always patched."""

    def setUp(self):
        self.app_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.app_dir.cleanup)
        patcher = mock.patch.dict(
            os.environ, {'EVERWATCH_APP_DIR': self.app_dir.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _install_fake_app(self):
        os.makedirs(os.path.join(self.app_dir.name, 'Everwatch.app'))

    def test_bare_command_launches_the_app_when_installed(self):
        self._install_fake_app()
        with mock.patch('everwatch.cli._launch_app') as mock_launch:
            code = cli.main([], stdin=io.StringIO(), stdout=io.StringIO())
        self.assertEqual(code, 0)
        mock_launch.assert_called_once_with()

    def test_app_subcommand_also_launches_the_app_when_installed(self):
        self._install_fake_app()
        with mock.patch('everwatch.cli._launch_app') as mock_launch:
            code = cli.main(['app'], stdin=io.StringIO(),
                            stdout=io.StringIO())
        self.assertEqual(code, 0)
        mock_launch.assert_called_once_with()

    def test_bare_command_falls_back_to_open_when_app_is_not_installed(self):
        # No Everwatch.app under EVERWATCH_APP_DIR: a --browser-only
        # install. Falls back to serving + opening a browser, exactly
        # like `everwatch open`.
        calls = []

        def fake_run_server(engine, **kwargs):
            calls.append(kwargs)
            return (0, 4242)

        with mock.patch('everwatch.cli._launch_app') as mock_launch, \
                mock.patch('everwatch.cli._run_server',
                           side_effect=fake_run_server):
            code = cli.main([], stdin=io.StringIO(), stdout=io.StringIO())
        self.assertEqual(code, 0)
        mock_launch.assert_not_called()
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]['open_browser'])

    def test_app_subcommand_falls_back_to_open_when_app_is_not_installed(self):
        calls = []

        def fake_run_server(engine, **kwargs):
            calls.append(kwargs)
            return (0, 4242)

        with mock.patch('everwatch.cli._launch_app') as mock_launch, \
                mock.patch('everwatch.cli._run_server',
                           side_effect=fake_run_server):
            code = cli.main(['app', '--demo'], stdin=io.StringIO(),
                            stdout=io.StringIO())
        self.assertEqual(code, 0)
        mock_launch.assert_not_called()
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]['open_browser'])

    def test_launch_app_runs_open_dash_a_against_the_app_dir(self):
        # `_launch_app` itself: the one real-I/O call site, never
        # exercised for real above -- `subprocess.run` is mocked here
        # instead of letting the real-I/O guard raise, per this file's
        # own pattern (docs/DESIGN.md hard rule #2).
        with mock.patch('everwatch.cli.subprocess.run') as mock_run:
            cli._launch_app()
        mock_run.assert_called_once_with(
            ['open', '-a',
             os.path.join(self.app_dir.name, 'Everwatch.app')])


class TestSignalAndParentPipeHelpers(unittest.TestCase):
    def test_install_signal_handlers_from_main_thread(self):
        old_term = signal.getsignal(signal.SIGTERM)
        old_int = signal.getsignal(signal.SIGINT)
        self.addCleanup(signal.signal, signal.SIGTERM, old_term)
        self.addCleanup(signal.signal, signal.SIGINT, old_int)
        stop_event = threading.Event()
        cli._install_signal_handlers(stop_event)
        handler = signal.getsignal(signal.SIGTERM)
        handler(signal.SIGTERM, None)
        self.assertTrue(stop_event.is_set())

    def test_install_signal_handlers_is_a_noop_off_the_main_thread(self):
        stop_event = threading.Event()
        ran = threading.Event()

        def run():
            cli._install_signal_handlers(stop_event)
            ran.set()

        t = threading.Thread(target=run)
        t.start()
        t.join(timeout=2)
        self.assertTrue(ran.is_set())
        self.assertFalse(stop_event.is_set())

    def test_watch_parent_pipe_sets_stop_event_on_read_error(self):
        class BadStdin:
            def read(self, n):
                raise ValueError('closed pipe')

        stop_event = threading.Event()
        t = cli._watch_parent_pipe(BadStdin(), stop_event)
        t.join(timeout=2)
        self.assertTrue(stop_event.is_set())


class TestRunServerDirect(unittest.TestCase):
    """Exercises `_run_server`'s branches that the higher-level cmd_*
    tests don't reach on their own: optional kwargs, the real
    (unmocked) parent_pipe=False path, actually opening a browser, and
    a KeyboardInterrupt arriving while waiting to stop."""

    def setUp(self):
        self.engine = build_demo_engine(seed=1)
        self._stdout, self._stderr = sys.stdout, sys.stderr
        self.addCleanup(self._restore_stdio)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ,
                                  {'EVERWATCH_HOME': self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _restore_stdio(self):
        sys.stdout, sys.stderr = self._stdout, self._stderr

    def test_ping_seconds_and_sse_maxsize_pass_through(self):
        stop_event = threading.Event()
        stop_event.set()  # already stopped: returns almost immediately
        code, port = cli._run_server(
            self.engine, host='127.0.0.1', port=0, token='t',
            stdin=io.StringIO(), stdout=io.StringIO(), parent_pipe=False,
            open_browser=False, ping_seconds=1.5, sse_maxsize=8,
            stop_event=stop_event)
        self.assertEqual(code, 0)
        self.assertGreater(port, 0)

    def test_open_browser_true_calls_open_url(self):
        stop_event = threading.Event()
        stop_event.set()
        with mock.patch('everwatch.cli._open_url') as mock_open_url:
            code, port = cli._run_server(
                self.engine, host='127.0.0.1', port=0, token='tok',
                stdin=io.StringIO(), stdout=io.StringIO(),
                parent_pipe=False, open_browser=True, stop_event=stop_event)
        self.assertEqual(code, 0)
        mock_open_url.assert_called_once_with(port, 'tok')

    def test_keyboard_interrupt_during_wait_is_swallowed(self):
        class RaisesOnWait:
            def wait(self):
                raise KeyboardInterrupt()

        code, _port = cli._run_server(
            self.engine, host='127.0.0.1', port=0, token='tok',
            stdin=io.StringIO(), stdout=io.StringIO(), parent_pipe=False,
            open_browser=False, stop_event=RaisesOnWait())
        self.assertEqual(code, 0)


class TestServeIntegration(unittest.TestCase):
    """A real `everwatch serve --demo --parent-pipe` run: no subprocess
    (the real-I/O guard forbids it), just `cli.main()` on a worker
    thread against an os.pipe() standing in for the shell's parent
    pipe, exactly as docs/DESIGN.md §3.1 describes the handshake."""

    def setUp(self):
        self._stdout = sys.stdout
        self._stderr = sys.stderr
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self._env_patch = mock.patch.dict(
            os.environ, {'EVERWATCH_HOME': self.tmp.name})
        self._env_patch.start()
        self.addCleanup(self._env_patch.stop)
        self.addCleanup(self._restore_stdio)

    def _restore_stdio(self):
        sys.stdout = self._stdout
        sys.stderr = self._stderr

    def test_handshake_live_http_and_parent_pipe_eof(self):  # parity: P-77
        read_fd, write_fd = os.pipe()
        stdin = os.fdopen(read_fd, 'r')
        stdout = io.StringIO()
        result = {}

        def run():
            result['code'] = cli.main(
                ['serve', '--demo', '--port', '0', '--token', 'tok',
                 '--parent-pipe'], stdin=stdin, stdout=stdout)

        with mock.patch('everwatch.cli.webbrowser.open') as mock_open:
            thread = threading.Thread(target=run, daemon=True)
            thread.start()
            self.addCleanup(lambda: thread.join(timeout=5))

            deadline = time.time() + 5
            line = ''
            while cli.READY_PREFIX not in line and time.time() < deadline:
                line = stdout.getvalue()
                time.sleep(0.02)
            self.assertIn(cli.READY_PREFIX, line)
            port = int(line.strip().split()[-1])

            conn = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
            conn.request('GET', '/api/state',
                        headers={'X-Everwatch-Token': 'tok'})
            resp = conn.getresponse()
            body = json.loads(resp.read())
            conn.close()
            self.assertEqual(resp.status, 200)
            self.assertEqual(body['mode'], 'demo')

            os.write(write_fd, b'x')  # a live parent writes nothing meaningful
            os.close(write_fd)  # parent-pipe EOF -> graceful shutdown
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result.get('code'), 0)
            mock_open.assert_not_called()  # --parent-pipe suppresses it


class TestDoctorCommand(unittest.TestCase):
    """`everwatch doctor` always runs with `--demo-diagnostics` here, so
    it only ever touches a `FakeProbes` (docs/DESIGN.md hard rule #2) --
    never the real keychain, `mdfind`, or iTerm2."""

    def _run(self, extra_args):
        out = io.StringIO()
        code = cli.main(['doctor', '--demo', '--demo-diagnostics'] +
                        extra_args, stdin=io.StringIO(), stdout=out)
        return code, out.getvalue()

    def test_all_ok_preset_exits_zero(self):
        code, text = self._run(['all_ok'])
        self.assertEqual(code, 0)
        self.assertIn('Python 3.9+', text)

    def test_permission_denied_preset_exits_one(self):
        code, text = self._run(['permission_denied'])
        self.assertEqual(code, 1)
        self.assertIn('Automation', text)

    def test_table_uses_glyphs_and_shows_action_labels(self):
        _code, text = self._run(['no_colors'])
        lines = text.splitlines()
        self.assertTrue(any(line.startswith('⚠ Tab colors')
                            for line in lines))
        self.assertIn('-> Enable tab colors', text)

    def test_json_flag_is_valid_json_with_thirteen_checks(self):
        code, text = self._run(['permission_denied', '--json'])
        result = json.loads(text)
        self.assertEqual(len(result['checks']), 13)
        self.assertEqual(code, 1)

    def test_rejects_unknown_preset(self):
        with self.assertRaises(SystemExit):
            cli.build_parser().parse_args(
                ['doctor', '--demo-diagnostics', 'bogus'])

    def test_doctor_table_matches_diagnostics_result(self):
        # A direct check that `doctor_table` renders exactly the checks
        # `build_diagnostics` produced, in order -- a lightweight
        # "snapshot" that doesn't hardcode wording.
        inputs = diagnostics.DiagnosticsInputs()
        diagnostics.apply_preset(inputs, 'all_ok')
        result = diagnostics.build_diagnostics(inputs, now=0.0)
        table = cli.doctor_table(result)
        for check in result['checks']:
            self.assertIn(check['title'], table)
            self.assertIn(check['detail'], table)


class TestRunServerRestartWiring(unittest.TestCase):
    def setUp(self):
        self.engine = build_demo_engine(seed=1)
        self._stdout, self._stderr = sys.stdout, sys.stderr
        self.addCleanup(self._restore_stdio)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ,
                                  {'EVERWATCH_HOME': self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _restore_stdio(self):
        sys.stdout, sys.stderr = self._stdout, self._stderr

    def test_run_server_wires_engine_restart_callback_to_stop_event(self):
        stop_event = threading.Event()
        stop_event.set()  # already stopped: _run_server returns quickly
        with mock.patch.object(self.engine, 'set_restart_callback') as setter:
            cli._run_server(
                self.engine, host='127.0.0.1', port=0, token='t',
                stdin=io.StringIO(), stdout=io.StringIO(),
                parent_pipe=False, open_browser=False, stop_event=stop_event)
        setter.assert_called_once_with(stop_event.set)


class TestRunServerExitCode(unittest.TestCase):
    """`_run_server`'s exit code: 0 for a normal stop, `EX_TEMPFAIL` (75)
    when the last thing the tab-colors installer did was ask for a
    restart -- the signal shell/Sources/App/BackendSupervisor.swift needs
    to restart immediately instead of counting it as a crash (Fix 2,
    docs/build/wp7-handoff.md)."""

    def setUp(self):
        self.engine = build_demo_engine(seed=1)
        self._stdout, self._stderr = sys.stdout, sys.stderr
        self.addCleanup(self._restore_stdio)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ,
                                  {'EVERWATCH_HOME': self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _restore_stdio(self):
        sys.stdout, sys.stderr = self._stdout, self._stderr

    def _run(self):
        stop_event = threading.Event()
        stop_event.set()  # already stopped: returns almost immediately
        return cli._run_server(
            self.engine, host='127.0.0.1', port=0, token='t',
            stdin=io.StringIO(), stdout=io.StringIO(), parent_pipe=False,
            open_browser=False, stop_event=stop_event)

    def test_normal_stop_exits_zero(self):
        code, _port = self._run()
        self.assertEqual(code, 0)

    def test_restart_required_install_progress_exits_ex_tempfail(self):
        self.engine._install_progress = {
            'status': 'restart_required',
            'detail': 'Installed. Restart Everwatch.'}
        code, _port = self._run()
        self.assertEqual(code, cli.EX_TEMPFAIL)
        self.assertEqual(cli.EX_TEMPFAIL, 75)  # sysexits.h EX_TEMPFAIL

    def test_other_install_progress_statuses_exit_zero(self):
        for status in ('installing', 'error', ''):
            self.engine._install_progress = {'status': status}
            code, _port = self._run()
            self.assertEqual(code, 0, status)


class TestDoctorAndStateRealPass(unittest.TestCase):
    """`doctor`/`state` without `--demo` build a real (RealSource-typed)
    engine, but real I/O itself is guarded (docs/DESIGN.md hard rule #2)
    -- exactly like `TestBuildEngine.
    test_real_engine_uses_real_source_without_starting_it`, this patches
    `RealSource` to a hermetic `FakeSource` and exercises the actual
    `engine.start()` / `wait_for_first_results` / `engine.stop()` wiring
    end to end (Fix 1, docs/build/wp7-handoff.md): no test needs real
    iTerm2 to prove `doctor`/`state` report a real poll's results instead
    of the cold-start "connecting"/empty defaults `Engine.__init__`
    publishes before anything has actually polled."""

    def setUp(self):
        patcher = mock.patch('everwatch.cli.RealSource', FakeSource)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_doctor_real_pass_reports_a_real_result_not_the_cold_start_default(self):
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()):  # any "Checking…"
            code = cli.main(['doctor', '--json'], stdin=io.StringIO(),
                            stdout=out)
        result = json.loads(out.getvalue())
        self.assertEqual(len(result['checks']), 13)
        automation = next(c for c in result['checks']
                          if c['id'] == 'automation')
        # FakeSource's default fetch_snapshot() succeeds, so a real pass
        # reports `ok`, never the cold-start "not yet known" `unknown`
        # doctor showed before Fix 1 (see the task's literal example).
        self.assertEqual(automation['status'], diagnostics.STATUS_OK)
        self.assertEqual(code, 0)

    def test_state_real_pass_reports_a_real_iterm_status_not_connecting(self):
        out = io.StringIO()
        with contextlib.redirect_stderr(io.StringIO()):  # any "Checking…"
            code = cli.main(['state'], stdin=io.StringIO(), stdout=out)
        self.assertEqual(code, 0)
        state = json.loads(out.getvalue())
        self.assertEqual(state['iterm']['status'], 'ok')


class TestDoctorAndStateWaitWiring(unittest.TestCase):
    """Mocks `wait_for_first_results` itself (its own timing/behavior is
    unit-tested in test_engine_diagnostics.py) to pin down exactly how
    cli.py wires it: called after `engine.start()`, with the started
    engine, and an `on_waiting` that writes "Checking…" to stderr (never
    stdout, which `--json` parses)."""

    def setUp(self):
        patcher = mock.patch('everwatch.cli.RealSource', FakeSource)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _run_with_mocked_wait(self, argv):
        calls = []

        def fake_wait(engine, on_waiting=None, **kwargs):
            calls.append(engine)
            self.assertTrue(engine.running)
            if on_waiting:
                on_waiting()
            return True

        out, err = io.StringIO(), io.StringIO()
        with mock.patch('everwatch.cli.wait_for_first_results',
                        side_effect=fake_wait), \
                mock.patch('sys.stderr', err):
            code = cli.main(argv, stdin=io.StringIO(), stdout=out)
        self.assertEqual(len(calls), 1)
        return code, out.getvalue(), err.getvalue()

    def test_doctor_waits_after_starting_and_prints_checking_to_stderr(self):
        _code, out, err = self._run_with_mocked_wait(['doctor', '--json'])
        self.assertIn('Checking', err)
        self.assertEqual(len(json.loads(out)['checks']), 13)

    def test_state_waits_after_starting_and_prints_checking_to_stderr(self):
        code, out, err = self._run_with_mocked_wait(['state'])
        self.assertIn('Checking', err)
        self.assertEqual(code, 0)
        json.loads(out)


class TestVersionCommand(unittest.TestCase):
    """`--version` (docs/DESIGN.md §7 P-77 row): the CLI's own version,
    plus the installed runtime/shell versions when present -- read with
    plistlib and plain file reads, never a subprocess."""

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.app_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.home.cleanup)
        self.addCleanup(self.app_dir.cleanup)
        patcher = mock.patch.dict(os.environ, {
            'EVERWATCH_HOME': self.home.name,
            'EVERWATCH_APP_DIR': self.app_dir.name,
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def _version_output(self):
        out = io.StringIO()
        with mock.patch('sys.stdout', out):
            with self.assertRaises(SystemExit) as ctx:
                cli.build_parser().parse_args(['--version'])
        self.assertEqual(ctx.exception.code, 0)
        return out.getvalue()

    def test_bare_cli_version_when_nothing_is_installed(self):
        text = self._version_output()
        self.assertEqual(text, f'everwatch {cli.__version__}\n')

    def test_shows_runtime_version_when_a_runtime_is_installed(self):
        runtime = os.path.join(self.home.name, 'runtime', 'current')
        os.makedirs(runtime)
        with open(os.path.join(runtime, 'VERSION'), 'w') as f:
            f.write('9.9.9\n')
        text = self._version_output()
        self.assertIn('runtime: 9.9.9', text)

    def test_shows_shell_version_when_the_app_is_installed(self):
        contents = os.path.join(self.app_dir.name, 'Everwatch.app',
                                'Contents')
        os.makedirs(contents)
        with open(os.path.join(contents, 'Info.plist'), 'wb') as f:
            plistlib.dump({'CFBundleShortVersionString': '0.2.0',
                          'CFBundleVersion': '42'}, f)
        text = self._version_output()
        self.assertIn('shell: 0.2.0 (build 42)', text)

    def test_missing_app_dir_is_silently_ignored(self):
        # No Everwatch.app anywhere under EVERWATCH_APP_DIR: no crash, no
        # "shell:" line.
        text = self._version_output()
        self.assertNotIn('shell:', text)


class TestUpdateCommand(unittest.TestCase):
    """`everwatch update` (docs/DESIGN.md §4.1's Update row): downloads
    install.sh and execs it with --yes. Both real-I/O sites are module-level
    functions patched directly, per the established pattern in this file
    (e.g. TestBrowserWiring patching `cli._open_url`)."""

    def _args(self, yes=False, no_open=False):
        return cli.build_parser().parse_args(
            ['update'] + (['--yes'] if yes else [])
                       + (['--no-open'] if no_open else []))

    def test_prompts_and_cancels_without_yes_or_confirmation(self):
        with mock.patch('everwatch.cli._download_install_script') as dl, \
                mock.patch('everwatch.cli._exec_install_script') as run:
            out = io.StringIO()
            code = cli.cmd_update(self._args(), stdin=io.StringIO(''),
                                  stdout=out)
        self.assertEqual(code, 0)
        self.assertIn('cancelled', out.getvalue().lower())
        dl.assert_not_called()
        run.assert_not_called()

    def test_confirming_with_y_runs_the_installer(self):
        with mock.patch('everwatch.cli._download_install_script',
                        return_value=b'#!/bin/sh\n') as dl, \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=0) as run:
            code = cli.cmd_update(self._args(), stdin=io.StringIO('y\n'),
                                  stdout=io.StringIO())
        self.assertEqual(code, 0)
        dl.assert_called_once_with(cli.INSTALL_SCRIPT_URL)
        run.assert_called_once_with(b'#!/bin/sh\n', ['--yes'])

    def test_yes_flag_skips_the_prompt(self):
        with mock.patch('everwatch.cli._download_install_script',
                        return_value=b'x') as dl, \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=0) as run:
            code = cli.cmd_update(self._args(yes=True), stdin=io.StringIO(),
                                  stdout=io.StringIO())
        self.assertEqual(code, 0)
        dl.assert_called_once()
        run.assert_called_once()

    def test_no_open_is_passed_through_to_the_installer(self):
        with mock.patch('everwatch.cli._download_install_script',
                        return_value=b'x'), \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=0) as run:
            cli.cmd_update(self._args(yes=True, no_open=True),
                          stdin=io.StringIO(), stdout=io.StringIO())
        run.assert_called_once_with(b'x', ['--yes', '--no-open'])

    def test_forwards_everwatch_prefix_to_the_installer_as_dash_dash_prefix(self):
        # A --prefix install's CLI wrapper (install.sh's install_cli_link)
        # exports EVERWATCH_PREFIX; `everwatch update` must forward it so a
        # prefix install's `update` re-installs into the same prefix instead
        # of install.sh falling back to the real $HOME.
        with mock.patch.dict(os.environ, {'EVERWATCH_PREFIX': '/tmp/some-prefix'}), \
                mock.patch('everwatch.cli._download_install_script',
                          return_value=b'x'), \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=0) as run:
            cli.cmd_update(self._args(yes=True),
                          stdin=io.StringIO(), stdout=io.StringIO())
        run.assert_called_once_with(b'x', ['--yes', '--prefix', '/tmp/some-prefix'])

    def test_no_prefix_forwarded_when_everwatch_prefix_is_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch('everwatch.cli._download_install_script',
                          return_value=b'x'), \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=0) as run:
            os.environ.pop('EVERWATCH_PREFIX', None)
            cli.cmd_update(self._args(yes=True),
                          stdin=io.StringIO(), stdout=io.StringIO())
        run.assert_called_once_with(b'x', ['--yes'])

    def test_download_failure_is_reported_and_returns_1(self):
        with mock.patch('everwatch.cli._download_install_script',
                        side_effect=OSError('network unreachable')), \
                mock.patch('everwatch.cli._exec_install_script') as run:
            out = io.StringIO()
            code = cli.cmd_update(self._args(yes=True), stdin=io.StringIO(),
                                  stdout=out)
        self.assertEqual(code, 1)
        self.assertIn('network unreachable', out.getvalue())
        run.assert_not_called()

    def test_installer_exit_code_is_propagated(self):
        with mock.patch('everwatch.cli._download_install_script',
                        return_value=b'x'), \
                mock.patch('everwatch.cli._exec_install_script',
                          return_value=3):
            code = cli.cmd_update(self._args(yes=True), stdin=io.StringIO(),
                                  stdout=io.StringIO())
        self.assertEqual(code, 3)

    def test_download_and_exec_helpers_only_touch_the_things_they_should(self):
        # A light integration check of the two real-I/O helpers themselves,
        # with urlopen/subprocess.run mocked (never real, per the guard).
        fake_resp = mock.MagicMock()
        fake_resp.__enter__.return_value = fake_resp
        fake_resp.read.return_value = b'echo hi\n'
        with mock.patch('everwatch.cli.urllib.request.urlopen',
                        return_value=fake_resp) as urlopen:
            script = cli._download_install_script('https://example.invalid/i.sh')
        self.assertEqual(script, b'echo hi\n')
        urlopen.assert_called_once()

        fake_result = mock.Mock(returncode=0)
        with mock.patch('everwatch.cli.subprocess.run',
                        return_value=fake_result) as run:
            code = cli._exec_install_script(b'echo hi\n', ['--yes'])
        self.assertEqual(code, 0)
        argv = run.call_args[0][0]
        self.assertEqual(argv[0], 'bash')
        self.assertTrue(argv[1].endswith('.sh'))
        self.assertEqual(argv[2:], ['--yes'])
        self.assertFalse(os.path.exists(argv[1]))  # temp file cleaned up


class TestUninstallCommand(unittest.TestCase):
    """`everwatch uninstall [--purge]` (docs/DESIGN.md §4.1's Uninstall
    row): removes the app/runtime/venv/CLI link, keeps state.json unless
    --purge, and --purge also resets the Automation grant. Every directory
    lives under a temp dir (EVERWATCH_HOME/APP_DIR/BIN_DIR env overrides),
    and `_tccutil_reset` is always patched -- never a real `tccutil` call
    (docs/DESIGN.md hard rule #2)."""

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.app_dir = tempfile.TemporaryDirectory()
        self.bin_dir = tempfile.TemporaryDirectory()
        for d in (self.home, self.app_dir, self.bin_dir):
            self.addCleanup(d.cleanup)
        patcher = mock.patch.dict(os.environ, {
            'EVERWATCH_HOME': self.home.name,
            'EVERWATCH_APP_DIR': self.app_dir.name,
            'EVERWATCH_BIN_DIR': self.bin_dir.name,
        })
        patcher.start()
        self.addCleanup(patcher.stop)

    def _populate(self):
        app = os.path.join(self.app_dir.name, 'Everwatch.app', 'Contents')
        os.makedirs(app)
        with open(os.path.join(app, 'marker'), 'w') as f:
            f.write('x')
        os.makedirs(os.path.join(self.home.name, 'runtime', '0.1.0'))
        os.makedirs(os.path.join(self.home.name, 'venv', 'bin'))
        with open(os.path.join(self.home.name, 'state.json'), 'w') as f:
            f.write('{}')
        with open(os.path.join(self.bin_dir.name, 'everwatch'), 'w') as f:
            f.write('#!/bin/sh\n')
        os.chmod(os.path.join(self.bin_dir.name, 'everwatch'), 0o755)

    def _args(self, purge=False, yes=False):
        return cli.build_parser().parse_args(
            ['uninstall'] + (['--purge'] if purge else [])
                          + (['--yes'] if yes else []))

    def test_without_yes_prompts_and_cancels(self):
        self._populate()
        out = io.StringIO()
        code = cli.cmd_uninstall(self._args(), stdin=io.StringIO(''),
                                 stdout=out)
        self.assertEqual(code, 0)
        self.assertIn('cancelled', out.getvalue().lower())
        self.assertTrue(os.path.exists(
            os.path.join(self.app_dir.name, 'Everwatch.app')))

    def test_confirming_with_y_removes_app_runtime_venv_and_link(self):
        self._populate()
        with mock.patch('everwatch.cli._tccutil_reset') as tcc:
            code = cli.cmd_uninstall(self._args(), stdin=io.StringIO('y\n'),
                                     stdout=io.StringIO())
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(
            os.path.join(self.app_dir.name, 'Everwatch.app')))
        self.assertFalse(os.path.exists(
            os.path.join(self.bin_dir.name, 'everwatch')))
        self.assertFalse(os.path.exists(
            os.path.join(self.home.name, 'runtime')))
        self.assertFalse(os.path.exists(
            os.path.join(self.home.name, 'venv')))
        # state.json is kept without --purge.
        self.assertTrue(os.path.exists(
            os.path.join(self.home.name, 'state.json')))
        tcc.assert_not_called()

    def test_yes_flag_skips_the_prompt(self):
        self._populate()
        with mock.patch('everwatch.cli._tccutil_reset'):
            code = cli.cmd_uninstall(self._args(yes=True), stdin=io.StringIO(),
                                     stdout=io.StringIO())
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(
            os.path.join(self.app_dir.name, 'Everwatch.app')))

    def test_purge_also_removes_state_json_and_resets_tcc(self):
        self._populate()
        with mock.patch('everwatch.cli._tccutil_reset') as tcc:
            code = cli.cmd_uninstall(self._args(purge=True, yes=True),
                                     stdin=io.StringIO(), stdout=io.StringIO())
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(self.home.name))
        tcc.assert_called_once_with(cli.BUNDLE_ID, mock.ANY)

    def test_nothing_installed_reports_nothing_to_remove(self):
        out = io.StringIO()
        code = cli.cmd_uninstall(self._args(yes=True), stdin=io.StringIO(),
                                 stdout=out)
        self.assertEqual(code, 0)
        self.assertIn('Nothing to remove.', out.getvalue())

    def test_purge_without_a_prior_install_does_not_crash(self):
        with mock.patch('everwatch.cli._tccutil_reset') as tcc:
            code = cli.cmd_uninstall(self._args(purge=True, yes=True),
                                     stdin=io.StringIO(), stdout=io.StringIO())
        self.assertEqual(code, 0)
        tcc.assert_called_once()


class TestTccutilReset(unittest.TestCase):
    """`_tccutil_reset` (used by `everwatch uninstall --purge`): must never
    raise or propagate a non-zero exit, and must never leak tccutil's raw
    "No such bundle identifier ... (OSStatus error -10814.)" stderr when
    Everwatch.app never ran and so never had an Automation grant to reset.
    `subprocess.run` is patched directly (never real -- docs/DESIGN.md hard
    rule #2), exercising `_tccutil_reset` itself rather than mocking it away."""

    def test_success_reports_grant_reset(self):
        fake_result = mock.Mock(returncode=0, stdout='', stderr='')
        out = io.StringIO()
        with mock.patch('everwatch.cli.subprocess.run',
                        return_value=fake_result) as run:
            cli._tccutil_reset(cli.BUNDLE_ID, out)
        run.assert_called_once_with(
            ['tccutil', 'reset', 'AppleEvents', cli.BUNDLE_ID],
            capture_output=True, text=True)
        self.assertIn('reset', out.getvalue().lower())
        self.assertNotIn('bundle identifier', out.getvalue().lower())

    def test_nothing_to_reset_is_reported_calmly_not_as_a_crash(self):
        fake_result = mock.Mock(
            returncode=1, stdout='',
            stderr='tccutil: No such bundle identifier '
                   '"io.github.burnsbert.everwatch": The operation '
                   "couldn’t be completed. (OSStatus error -10814.)\n")
        out = io.StringIO()
        with mock.patch('everwatch.cli.subprocess.run',
                        return_value=fake_result):
            cli._tccutil_reset(cli.BUNDLE_ID, out)  # must not raise
        self.assertIn('No Automation grant to reset', out.getvalue())
        self.assertNotIn('OSStatus', out.getvalue())
        self.assertNotIn('-10814', out.getvalue())

    def test_other_failure_warns_with_manual_command_but_does_not_raise(self):
        fake_result = mock.Mock(returncode=1, stdout='',
                                stderr='tccutil: something else went wrong\n')
        out = io.StringIO()
        with mock.patch('everwatch.cli.subprocess.run',
                        return_value=fake_result):
            cli._tccutil_reset(cli.BUNDLE_ID, out)  # must not raise
        text = out.getvalue()
        self.assertIn('something else went wrong', text)
        self.assertIn(f'tccutil reset AppleEvents "{cli.BUNDLE_ID}"', text)


if __name__ == '__main__':
    unittest.main()
