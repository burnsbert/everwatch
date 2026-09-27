"""Engine wiring for diagnostics + the tab-color installer (WP7,
docs/DESIGN.md §3.5, §4.2, §7): `diagnostics`/`diagnostics_recheck`/
`colors_install` commands, the `diagnostics` SSE event (only once
diagnostics are first requested -- so every pre-WP7 engine test that
never asks for them is unaffected), and the colors-install progress ->
action_result -> restart-callback flow, all through a fake installer so
no test ever spawns real `venv`/`pip`.
"""
import os
import tempfile
import threading
import unittest
from unittest import mock

from everwatch import diagnostics as D
from everwatch import engine_loop as EL
from everwatch.sources.fake import FakeSource
from tests.py.engine_helpers import EngineFixture, sess
from tests.py.server_helpers import wait_until


class FakeInstaller:
    """A `ColorsInstaller` stand-in: `.install(venv_dir)` yields a fixed,
    injected sequence of (status, detail) steps and records the venv
    directory it was asked to install into."""

    def __init__(self, steps):
        self.steps = steps
        self.calls = []

    def install(self, venv_dir):
        self.calls.append(venv_dir)
        yield from self.steps


def diag_events(events):
    return [e for e in events if e.type == 'diagnostics']


class TestDiagnosticsCommand(unittest.TestCase):
    def test_lazy_until_first_requested(self):
        """Regression guard: engines that never ask for diagnostics must
        never compute or emit them (every pre-WP7 engine test relies on
        this -- see engine_loop._tick)."""
        fx = EngineFixture(self)
        sub = fx.subscribe()
        fx.set_sessions(sess('A'))
        for _ in range(3):
            fx.step()
        self.assertEqual(diag_events(fx.drain(sub)), [])
        self.assertIsNone(fx.engine._diagnostics)

    def test_get_returns_thirteen_checks_and_activates(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes())
        result = fx.engine.call('diagnostics')
        self.assertEqual(len(result['checks']), 13)
        self.assertTrue(fx.engine._diag_active)

    def test_get_emits_one_diagnostics_event_on_first_activation(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes())
        # Let the very first (cold-start) iterm/agents/colors poll settle
        # before activating diagnostics, exactly as TestEndpoints.setUp
        # does for command tests: otherwise that first poll and the
        # diagnostics activation share one `step()`, and the diagnostics
        # command's own refresh (which runs before the poll's events are
        # drained) legitimately differs from the tick's refresh right
        # after (which sees the fresh poll) -- two real, back-to-back
        # states, not a double-emit bug.
        fx.step()
        sub = fx.subscribe()
        fx.engine.call('diagnostics')
        events = diag_events(fx.drain(sub))
        self.assertEqual(len(events), 1)
        self.assertEqual(len(events[0].data['checks']), 13)

    def test_get_again_with_unchanged_state_does_not_re_emit(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes())
        fx.engine.call('diagnostics')
        sub = fx.subscribe()
        fx.engine.call('diagnostics')
        self.assertEqual(diag_events(fx.drain(sub)), [])

    def test_probes_run_once_then_cached_until_recheck(self):
        probes = D.FakeProbes()
        calls = []
        probes.iterm_installed = lambda: calls.append(1) or True
        fx = EngineFixture(self, diag_probes=probes)
        fx.engine.call('diagnostics')
        fx.engine.call('diagnostics')
        self.assertEqual(len(calls), 1)
        fx.engine.call('diagnostics_recheck')
        self.assertEqual(len(calls), 2)

    def test_changed_iterm_status_re_emits_on_next_tick(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes())
        fx.engine.call('diagnostics')
        sub = fx.subscribe()
        fx.source.queue('fetch_snapshot', EL.base.ItermNotRunning())
        fx.step()
        events = diag_events(fx.drain(sub))
        self.assertEqual(len(events), 1)
        row = next(c for c in events[0].data['checks']
                  if c['id'] == 'iterm_running')
        self.assertEqual(row['status'], D.STATUS_WARN)

    def test_recheck_forces_an_event_even_if_unchanged(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes())
        fx.engine.call('diagnostics')
        sub = fx.subscribe()
        fx.engine.call('diagnostics_recheck')
        self.assertEqual(len(diag_events(fx.drain(sub))), 1)

    def test_demo_preset_overrides_live_status(self):
        fx = EngineFixture(self, diag_probes=D.FakeProbes(),
                          demo_diag_preset='permission_denied')
        result = fx.engine.call('diagnostics')
        row = next(c for c in result['checks'] if c['id'] == 'automation')
        self.assertEqual(row['status'], D.STATUS_ERROR)

    def test_ultrawatch_imported_flag_reflects_store(self):
        # A real (but throwaway, temp-dir) ultrawatch state.json: the
        # store's import_ultrawatch() only sets `imported_from_ultrawatch`
        # once it has actually read a JSON object from `path`.
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        uw_path = os.path.join(tmp.name, 'uw-state.json')
        with open(uw_path, 'w', encoding='utf-8') as f:
            f.write('{}')
        fx = EngineFixture(self, diag_probes=D.FakeProbes(
            ultrawatch_path=uw_path))
        result = fx.engine.call('diagnostics')
        row = next(c for c in result['checks']
                  if c['id'] == 'ultrawatch_import')
        self.assertEqual(row['status'], D.STATUS_INFO)
        fx.engine.call('import_ultrawatch', path=uw_path)
        result = fx.engine.call('diagnostics_recheck')
        row = next(c for c in result['checks']
                  if c['id'] == 'ultrawatch_import')
        self.assertEqual(row['status'], D.STATUS_OK)


class TestColorsInstallCommand(unittest.TestCase):
    def _run_to_completion(self, fx, timeout=2.0):
        """The install runs on its own thread; since these fixtures never
        run the engine's own thread (`threaded=False`), nothing else
        drains `_inbox` -- so poll by calling `fx.step()` (which drains
        it) until the background thread's final event lands."""
        aid_result = fx.engine.call('colors_install')
        self.assertIn('id', aid_result)

        def _drain_and_check():
            fx.step(seconds=0)
            return not fx.engine._install_running

        self.assertTrue(wait_until(_drain_and_check, timeout=timeout))
        return aid_result

    def test_success_reports_progress_then_restart_required(self):
        steps = [('installing', 'Creating a private Python environment…'),
                 ('installing', 'Installing the iterm2 package…'),
                 ('restart_required', 'Installed. Restart Everwatch.')]
        fake = FakeInstaller(steps)
        fx = EngineFixture(self, diag_probes=D.FakeProbes(),
                          colors_installer=fake)
        with mock.patch.object(fx.engine, '_request_restart') as restart:
            sub = fx.subscribe()
            self._run_to_completion(fx)
            events = fx.drain(sub)
        self.assertTrue(fake.calls[0].endswith(os.sep + 'venv'))
        results = [e.data for e in events if e.type == 'action_result']
        self.assertEqual(results[-1], {'id': 'a1', 'kind': 'colors_install',
                                       'ok': True,
                                       'detail': steps[-1][1]})
        self.assertTrue(diag_events(events))
        last_diag = diag_events(events)[-1].data
        row = next(c for c in last_diag['checks'] if c['id'] == 'tab_colors')
        self.assertEqual(row['status'], D.STATUS_WARN)
        restart.assert_called_once()

    def test_failure_reports_error_and_never_restarts(self):
        fake = FakeInstaller([('installing', 'Creating…'),
                             ('error', 'pip install failed: no network')])
        fx = EngineFixture(self, diag_probes=D.FakeProbes(),
                          colors_installer=fake)
        with mock.patch.object(fx.engine, '_request_restart') as restart:
            sub = fx.subscribe()
            self._run_to_completion(fx)
            events = fx.drain(sub)
        results = [e.data for e in events if e.type == 'action_result']
        self.assertEqual(results[-1]['ok'], False)
        self.assertIn('no network', results[-1]['detail'])
        restart.assert_not_called()
        last_diag = diag_events(events)[-1].data
        row = next(c for c in last_diag['checks'] if c['id'] == 'tab_colors')
        self.assertEqual(row['status'], D.STATUS_ERROR)

    def test_concurrent_install_is_rejected(self):
        # A slow "installer" (blocks on an Event) so the first install is
        # still `_install_running` when the second is attempted.
        release = threading.Event()

        def slow_install(venv_dir):
            yield ('installing', 'Working…')
            release.wait(timeout=2)
            yield ('restart_required', 'done')

        fake = mock.Mock()
        fake.install = slow_install
        fx = EngineFixture(self, diag_probes=D.FakeProbes(),
                          colors_installer=fake)
        fx.engine.call('colors_install')
        self.assertTrue(wait_until(lambda: fx.engine._install_running))
        with self.assertRaises(EL.CommandError) as cm:
            fx.engine.call('colors_install')
        self.assertEqual(cm.exception.code, 'install_in_progress')
        self.assertEqual(cm.exception.status, 409)
        release.set()

        def _drain_and_check():
            fx.step(seconds=0)
            return not fx.engine._install_running

        self.assertTrue(wait_until(_drain_and_check))

    def test_venv_directory_is_named_venv_under_engine_home(self):
        fake = FakeInstaller([('restart_required', 'done')])
        fx = EngineFixture(self, diag_probes=D.FakeProbes(),
                          colors_installer=fake)
        self._run_to_completion(fx)
        self.assertEqual(fake.calls[0],
                         os.path.join(fx.engine.home, 'venv'))


class TestRestartCallback(unittest.TestCase):
    def test_fires_after_a_short_delay(self):
        fx = EngineFixture(self)
        fired = threading.Event()
        fx.engine.set_restart_callback(fired.set)
        fx.engine._request_restart(delay=0.02)
        self.assertTrue(fired.wait(timeout=2))

    def test_noop_without_a_callback(self):
        fx = EngineFixture(self)
        fx.engine._request_restart(delay=0.0)  # must not raise


class TestPollUntil(unittest.TestCase):
    """The generic wait loop (`engine_loop.poll_until`)'s timing, entirely
    decoupled from Engine and real I/O: fake `sleep`/`now` prove this
    never has to wait for real, in either direction (fast-path or
    timeout)."""

    def test_ready_immediately_never_sleeps_or_warns(self):
        waited = []

        def boom(_):
            raise AssertionError('must not sleep when already ready')

        ready = EL.poll_until(lambda: True, timeout=10, sleep=boom,
                              now=lambda: 0.0,
                              on_waiting=lambda: waited.append(1))
        self.assertTrue(ready)
        self.assertEqual(waited, [])

    def test_before_hook_runs_each_iteration_until_ready(self):
        calls = []
        clock = [0.0]
        ready = EL.poll_until(
            lambda: len(calls) >= 3, timeout=10,
            sleep=lambda s: clock.__setitem__(0, clock[0] + s),
            now=lambda: clock[0], before=lambda: calls.append(1))
        self.assertTrue(ready)
        self.assertEqual(len(calls), 3)

    def test_times_out_and_calls_on_waiting_exactly_once(self):
        clock = [0.0]
        waited = []
        ready = EL.poll_until(
            lambda: False, timeout=0.2,
            sleep=lambda s: clock.__setitem__(0, clock[0] + s),
            now=lambda: clock[0], interval=0.05,
            on_waiting=lambda: waited.append(1))
        self.assertFalse(ready)
        self.assertEqual(waited, [1])


class TestDiagnosticsReady(unittest.TestCase):
    """`engine_loop.diagnostics_ready`/`wait_for_first_results` against a
    real (InlineDriver) Engine + FakeSource -- no test here sleeps for
    real or touches real I/O."""

    def test_not_ready_before_the_first_poll(self):
        fx = EngineFixture(self)
        self.assertFalse(EL.diagnostics_ready(fx.engine))

    def test_ready_after_one_step(self):
        fx = EngineFixture(self)
        fx.step()
        self.assertTrue(EL.diagnostics_ready(fx.engine))

    def test_wait_for_first_results_pumps_a_non_running_engine_without_sleeping(self):
        fx = EngineFixture(self)

        def boom(_):
            raise AssertionError('must not sleep for a non-running engine')

        self.assertTrue(EL.wait_for_first_results(fx.engine, sleep=boom))
        self.assertTrue(EL.diagnostics_ready(fx.engine))

    def test_wait_for_first_results_never_calls_on_waiting_for_the_fast_path(self):
        fx = EngineFixture(self)
        waited = []
        EL.wait_for_first_results(fx.engine, sleep=lambda s: None,
                                  on_waiting=lambda: waited.append(1))
        self.assertEqual(waited, [])


class TestWaitForFirstResultsThreaded(unittest.TestCase):
    """A real `ThreadedDriver` + `FakeSource`: proves `wait_for_first_
    results` actually waits for asynchronous poller threads (an
    InlineDriver is always ready after one pump, so it can't exercise
    this), and that it gives up after its own `timeout`. The real
    `time.sleep` calls involved are tiny (well under a second) -- nowhere
    near the ~12s production default."""

    def test_becomes_ready_once_the_blocked_poller_reports(self):
        block = threading.Event()

        def slow_fetch_colors():
            block.wait(timeout=2)
            return {}

        src = FakeSource(fetch_colors=slow_fetch_colors)
        fx = EngineFixture(self, source=src, threaded=True)
        fx.engine.start()
        self.addCleanup(fx.engine.stop)
        self.addCleanup(block.set)
        timer = threading.Timer(0.05, block.set)
        timer.start()
        self.addCleanup(timer.cancel)

        waited = []
        ready = EL.wait_for_first_results(
            fx.engine, timeout=2.0, on_waiting=lambda: waited.append(1))
        self.assertTrue(ready)
        self.assertEqual(waited, [1])

    def test_gives_up_after_its_own_timeout(self):
        block = threading.Event()  # never set until cleanup

        def slow_fetch_colors():
            block.wait(timeout=5)
            return {}

        src = FakeSource(fetch_colors=slow_fetch_colors)
        fx = EngineFixture(self, source=src, threaded=True)
        fx.engine.start()
        self.addCleanup(fx.engine.stop)
        self.addCleanup(block.set)

        waited = []
        ready = EL.wait_for_first_results(
            fx.engine, timeout=0.2, on_waiting=lambda: waited.append(1))
        self.assertFalse(ready)
        self.assertEqual(waited, [1])


if __name__ == '__main__':
    unittest.main()
