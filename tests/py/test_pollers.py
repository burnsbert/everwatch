"""Ported from ultrawatch tests/test_pollers.py (P-53, P-60), plus new
tests for ItermWorker's adaptive cadence, action dispatch, and error
capture (P-02, P-03, P-08), which ultrawatch's own suite didn't cover
directly (it only unit-tests UsagePoller/ColorsPoller by calling
poll()/​_do_action() synchronously — ItermWorker.run() is a blocking
thread loop that isn't itself unit-tested; see pollers.py's module
docstring for why adaptive_wait() was pulled out as a pure function).
"""
import queue
import threading
import unittest
from unittest import mock

from everwatch.engine import iterm, itermcolor, pollers
from everwatch.engine.snapshot import AgentSnapshot


def agents_snap(*ttys_agents):
    return AgentSnapshot(
        ttys=tuple((t, frozenset(a)) for t, a in ttys_agents), at=1.0)


class TestAdaptiveWait(unittest.TestCase):
    def test_uses_interval_when_poll_is_fast(self):  # parity: P-02
        self.assertEqual(pollers.adaptive_wait(2, 0.05), 2)

    def test_doubles_elapsed_when_poll_is_slow(self):  # parity: P-02
        self.assertEqual(pollers.adaptive_wait(2, 3.0), 6.0)

    def test_never_below_interval(self):  # parity: P-02
        self.assertEqual(pollers.adaptive_wait(2, 0.0), 2)


class TestItermWorkerPollSnapshotErrors(unittest.TestCase):
    def setUp(self):
        self.events = queue.Queue()
        self.worker = pollers.ItermWorker(self.events, threading.Event())

    def test_not_running_sets_sentinel_flag(self):  # parity: P-08
        with mock.patch('everwatch.engine.pollers.iterm.fetch_snapshot',
                       side_effect=iterm.ItermNotRunning):
            self.worker._poll_snapshot()
        kind, snap = self.events.get_nowait()
        self.assertEqual(kind, 'iterm')
        self.assertTrue(snap.not_running)
        self.assertEqual(snap.error, '')

    def test_other_failure_sets_error_message(self):  # parity: P-08
        with mock.patch('everwatch.engine.pollers.iterm.fetch_snapshot',
                       side_effect=iterm.ItermError('(-1743)')):
            self.worker._poll_snapshot()
        kind, snap = self.events.get_nowait()
        self.assertFalse(snap.not_running)
        self.assertEqual(snap.error, '(-1743)')

    def test_success_posts_snapshot_unmodified(self):  # parity: P-08
        from everwatch.engine.snapshot import ItermSnapshot
        fake = ItermSnapshot(sessions=(), at=5.0)
        with mock.patch('everwatch.engine.pollers.iterm.fetch_snapshot',
                       return_value=fake):
            self.worker._poll_snapshot()
        kind, snap = self.events.get_nowait()
        self.assertIs(snap.error, '')
        self.assertFalse(snap.not_running)

    def test_poll_paths_failure_is_swallowed(self):  # parity: P-05
        with mock.patch('everwatch.engine.pollers.iterm.fetch_paths',
                       side_effect=RuntimeError('boom')):
            self.worker._poll_paths()  # must not raise
        self.assertTrue(self.events.empty())


class TestItermWorkerActions(unittest.TestCase):
    def setUp(self):
        self.events = queue.Queue()
        self.worker = pollers.ItermWorker(self.events, threading.Event())

    def test_request_enqueues_kind_and_args(self):  # parity: P-03
        self.worker.request('goto', 'UID-1')
        self.assertEqual(self.worker.actions.get_nowait(),
                         ('goto', ('UID-1',)))

    def test_kick_enqueues_poll_sentinel(self):  # parity: P-03
        self.worker.kick()
        self.assertEqual(self.worker.actions.get_nowait(), ('poll', ()))

    def test_do_action_goto_success(self):  # parity: P-09
        with mock.patch('everwatch.engine.pollers.iterm.goto_session',
                       return_value=True):
            self.worker._do_action('goto', ('UID-1',))
        kind, (action_kind, ok, detail) = self.events.get_nowait()
        self.assertEqual((kind, action_kind, ok, detail),
                         ('action', 'goto', True, ''))

    def test_do_action_goto_not_found(self):  # parity: P-09
        with mock.patch('everwatch.engine.pollers.iterm.goto_session',
                       return_value=False):
            self.worker._do_action('goto', ('UID-1',))
        _, (_, ok, detail) = self.events.get_nowait()
        self.assertFalse(ok)
        self.assertEqual(detail, 'session not found')

    def test_do_action_close_success(self):  # parity: P-09
        with mock.patch('everwatch.engine.pollers.iterm.close_tab') as close:
            self.worker._do_action('close', (4711, 3))
        close.assert_called_once_with(4711, 3)
        _, (_, ok, _detail) = self.events.get_nowait()
        self.assertTrue(ok)

    def test_do_action_new_success(self):  # parity: P-09
        with mock.patch('everwatch.engine.pollers.iterm.new_tab') as new:
            self.worker._do_action('new', ())
        new.assert_called_once_with()
        _, (_, ok, _detail) = self.events.get_nowait()
        self.assertTrue(ok)

    def test_do_action_failure_reports_exception_message(self):  # parity: P-09
        with mock.patch('everwatch.engine.pollers.iterm.goto_session',
                       side_effect=RuntimeError('boom')):
            self.worker._do_action('goto', ('UID-1',))
        _, (_, ok, detail) = self.events.get_nowait()
        self.assertFalse(ok)
        self.assertEqual(detail, 'boom')


class TestItermWorkerRunLoop(unittest.TestCase):
    """Drives ItermWorker.run() itself (not just its poll/action helpers)
    with everything mocked out, so the loop terminates deterministically
    without real sleeping or real subprocess calls."""

    def test_empty_action_queue_breaks_inner_loop_and_stops(self):  # parity: P-02
        events = queue.Queue()
        stop = threading.Event()
        worker = pollers.ItermWorker(events, stop, snapshot_interval=0.01,
                                     paths_interval=1000)

        class ImmediatelyEmptyQueue:
            def get(self, timeout=None):
                stop.set()  # simulate "nothing arrived before stop"
                raise queue.Empty

        worker.actions = ImmediatelyEmptyQueue()
        with mock.patch.object(worker, '_poll_snapshot'), \
             mock.patch.object(worker, '_poll_paths'):
            worker.run()  # must return promptly, not hang

    def test_seeded_action_is_drained_and_dispatched(self):  # parity: P-03
        events = queue.Queue()
        stop = threading.Event()
        worker = pollers.ItermWorker(events, stop, snapshot_interval=0.01,
                                     paths_interval=1000)
        worker.actions.put(('goto', ('UID-1',)))
        calls = {'n': 0}

        def fake_poll_snapshot():
            calls['n'] += 1
            if calls['n'] >= 2:
                stop.set()  # let the second outer iteration exit

        with mock.patch.object(worker, '_poll_snapshot',
                               side_effect=fake_poll_snapshot), \
             mock.patch.object(worker, '_poll_paths'), \
             mock.patch.object(worker, '_do_action') as do_action:
            worker.run()
        do_action.assert_called_once_with('goto', ('UID-1',))

    def test_seeded_poll_sentinel_breaks_without_dispatch(self):  # parity: P-03
        events = queue.Queue()
        stop = threading.Event()
        worker = pollers.ItermWorker(events, stop, snapshot_interval=0.01,
                                     paths_interval=1000)
        worker.actions.put(('poll', ()))
        calls = {'n': 0}

        def fake_poll_snapshot():
            calls['n'] += 1
            if calls['n'] >= 2:
                stop.set()

        with mock.patch.object(worker, '_poll_snapshot',
                               side_effect=fake_poll_snapshot), \
             mock.patch.object(worker, '_poll_paths'), \
             mock.patch.object(worker, '_do_action') as do_action:
            worker.run()
        do_action.assert_not_called()


class TestAgentsPollerPoll(unittest.TestCase):
    def setUp(self):
        self.events = queue.Queue()
        self.needs_cwd_box = pollers.LatestBox()
        self.agents_box = pollers.LatestBox()

    def poller(self, scan, fill=None):
        return pollers.AgentsPoller(
            self.events, threading.Event(), self.needs_cwd_box,
            self.agents_box, scan=scan, fill=fill or (lambda ttys: {}))

    def test_publishes_snapshot_and_updates_agents_box(self):  # parity: P-07
        p = self.poller(scan=lambda: {'/dev/ttys001': {'claude'}})
        p.poll()
        kind, snap = self.events.get_nowait()
        self.assertEqual(kind, 'agents')
        self.assertEqual(dict(snap.ttys), {'/dev/ttys001': frozenset({'claude'})})
        self.assertIs(self.agents_box.get(), snap)

    def test_scan_exception_yields_empty_snapshot(self):  # parity: P-07
        def broken_scan():
            raise RuntimeError('ps failed')
        p = self.poller(scan=broken_scan)
        p.poll()
        _kind, snap = self.events.get_nowait()
        self.assertEqual(snap.ttys, ())

    def test_needs_cwd_gates_the_lsof_fill(self):  # parity: P-06
        fill_calls = []

        def fill(ttys):
            fill_calls.append(tuple(ttys))
            return {'/dev/ttys003': '/Users/x'}

        p = self.poller(scan=lambda: {}, fill=fill)
        self.needs_cwd_box.set(('/dev/ttys003',))
        p.poll()
        self.assertEqual(fill_calls, [('/dev/ttys003',)])
        _kind, snap = self.events.get_nowait()
        self.assertEqual(dict(snap.tty_cwd), {'/dev/ttys003': '/Users/x'})

    def test_no_needs_cwd_skips_the_lsof_fill(self):  # parity: P-06
        fill = mock.Mock()
        p = self.poller(scan=lambda: {}, fill=fill)
        p.poll()
        fill.assert_not_called()

    def test_fill_exception_yields_empty_cwds(self):  # parity: P-06
        def broken_fill(ttys):
            raise RuntimeError('lsof failed')
        p = self.poller(scan=lambda: {}, fill=broken_fill)
        self.needs_cwd_box.set(('/dev/ttys003',))
        p.poll()
        _kind, snap = self.events.get_nowait()
        self.assertEqual(snap.tty_cwd, ())


class TestStartPollersAndKickAll(unittest.TestCase):
    def test_start_pollers_wires_and_starts_all_five(self):
        # Patch Thread.start so nothing actually runs in the background
        # (the pollers would otherwise immediately hit the real-I/O
        # guard in a tight retry loop); this test only proves
        # start_pollers() builds and starts the right five pollers.
        events = queue.Queue()
        stop = threading.Event()
        with mock.patch.object(threading.Thread, 'start') as start:
            started, needs_cwd_box = pollers.start_pollers(events, stop)
        self.assertEqual(set(started),
                         {'iterm', 'agents', 'colors', 'usage_claude',
                          'usage_codex'})
        self.assertEqual(start.call_count, 5)
        self.assertIsInstance(needs_cwd_box, pollers.LatestBox)
        self.assertIsInstance(started['iterm'], pollers.ItermWorker)
        self.assertIsInstance(started['agents'], pollers.AgentsPoller)
        self.assertIsInstance(started['colors'], pollers.ColorsPoller)
        self.assertEqual(started['usage_claude'].event_name, 'usage_claude')
        self.assertEqual(started['usage_codex'].event_name, 'usage_codex')

    def test_kick_all_kicks_every_poller(self):
        fakes = {'a': mock.Mock(), 'b': mock.Mock()}
        pollers.kick_all(fakes)
        fakes['a'].kick.assert_called_once_with()
        fakes['b'].kick.assert_called_once_with()


class TestUsagePollerGating(unittest.TestCase):
    """Exercises poll() synchronously — no threads started."""

    def setUp(self):
        self.events = queue.Queue()
        self.box = pollers.LatestBox()
        self.fetches = []

    def poller(self, result=({'x': 1}, None)):
        def fetch():
            self.fetches.append(1)
            return result
        return pollers.UsagePoller('usage_claude', self.events,
                                   threading.Event(), self.box, 'claude',
                                   fetch, base_interval=300)

    def drain(self):
        out = []
        while not self.events.empty():
            out.append(self.events.get_nowait())
        return out

    def test_inactive_publishes_once_no_fetch(self):  # parity: P-53
        self.box.set(agents_snap(('/dev/ttys001', {'codex'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0)
        events = self.drain()
        self.assertEqual(len(events), 1)
        self.assertTrue(events[0][1].inactive)
        self.assertEqual(self.fetches, [])

    def test_active_fetches_then_waits_interval(self):  # parity: P-53
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0)   # within interval — no fetch
        p.poll(now=401.0)   # past interval — fetch again
        self.assertEqual(len(self.fetches), 2)
        events = self.drain()
        self.assertEqual(len(events), 2)
        self.assertEqual(events[0][1].data, {'x': 1})
        self.assertTrue(events[0][1].ok)

    def test_failure_keeps_last_good_and_respects_retry_after(self):  # parity: P-53
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        def failing_fetch():
            self.fetches.append(1)
            return (None, 900)
        p.fetch = failing_fetch
        p.poll(now=401.0)
        events = self.drain()
        self.assertEqual(events[1][1].data, {'x': 1})  # last good kept
        self.assertFalse(events[1][1].ok)
        self.assertEqual(p.interval, 900)
        p.poll(now=401.0 + 350)  # would be due at base interval, not at 900
        self.assertEqual(len(self.fetches), 2)

    def test_agent_disappearing_clears_data(self):  # parity: P-53
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        self.box.set(agents_snap())
        p.poll(now=105.0)
        events = self.drain()
        self.assertTrue(events[-1][1].inactive)
        self.assertIsNone(p.data)

    def test_forced_kick_rate_floored(self):  # parity: P-10
        self.box.set(agents_snap(('/dev/ttys001', {'claude'})))
        p = self.poller()
        p.poll(now=100.0)
        p.poll(now=105.0, forced=True)   # only 5s old — no refetch
        self.assertEqual(len(self.fetches), 1)
        p.poll(now=115.0, forced=True)   # >10s old — refetch
        self.assertEqual(len(self.fetches), 2)


class TestColorsPoller(unittest.TestCase):
    """Exercises poll() synchronously — no threads, no real iTerm2."""

    def setUp(self):
        self.events = queue.Queue()

    def drain(self):
        out = []
        while not self.events.empty():
            out.append(self.events.get_nowait())
        return out

    def poller(self, fetch):
        return pollers.ColorsPoller(self.events, threading.Event(),
                                    fetch=fetch)

    def test_normal_fetch_emits_snapshot(self):  # parity: P-60
        p = self.poller(lambda: {'UID-1': 'red', 'UID-2': 'blue'})
        p.poll(now=100.0)
        events = self.drain()
        self.assertEqual(len(events), 1)
        kind, snap = events[0]
        self.assertEqual(kind, 'colors')
        self.assertEqual(dict(snap.colors),
                         {'UID-1': 'red', 'UID-2': 'blue'})
        self.assertEqual(snap.at, 100.0)
        self.assertTrue(p.available)

    def test_unavailable_stops_future_polls_without_raising(self):  # parity: P-60
        calls = []

        def fetch():
            calls.append(1)
            raise itermcolor.ColorApiUnavailable('no iterm2 package')

        p = self.poller(fetch)
        p.poll(now=100.0)
        p.poll(now=105.0)  # poll() itself checks `available` and no-ops
        self.assertFalse(p.available)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.drain(), [])

    def test_transient_failure_is_swallowed_and_retried(self):  # parity: P-60
        calls = []

        def fetch():
            calls.append(1)
            raise ConnectionRefusedError('API not enabled yet')

        p = self.poller(fetch)
        p.poll(now=100.0)
        p.poll(now=105.0)
        self.assertTrue(p.available)
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.drain(), [])


class TestColorsPollerSetColor(unittest.TestCase):
    """Exercises request()/_do_action() synchronously — no thread spun."""

    def poller(self, set_color):
        return pollers.ColorsPoller(queue.Queue(), threading.Event(),
                                    fetch=lambda: {}, set_color=set_color)

    def test_request_enqueues_set_color_action(self):  # parity: P-60
        p = self.poller(lambda uid, name: None)
        p.request('UID-9', 'red')
        self.assertEqual(p.actions.get_nowait(),
                         ('set_color', ('UID-9', 'red')))

    def test_kick_enqueues_poll_sentinel(self):  # parity: P-60
        p = self.poller(lambda uid, name: None)
        p.kick()
        self.assertEqual(p.actions.get_nowait(), ('poll', ()))

    def test_do_action_calls_set_color(self):  # parity: P-60
        calls = []
        p = self.poller(lambda uid, name: calls.append((uid, name)))
        p._do_action('set_color', ('UID-1', 'red'))
        self.assertEqual(calls, [('UID-1', 'red')])
        self.assertTrue(p.available)

    def test_do_action_clear_passes_none(self):  # parity: P-60
        calls = []
        p = self.poller(lambda uid, name: calls.append((uid, name)))
        p._do_action('set_color', ('UID-1', None))
        self.assertEqual(calls, [('UID-1', None)])

    def test_do_action_unavailable_stops_poller(self):  # parity: P-60
        def set_color(uid, name):
            raise itermcolor.ColorApiUnavailable('no iterm2 package')
        p = self.poller(set_color)
        p._do_action('set_color', ('UID-1', 'red'))
        self.assertFalse(p.available)

    def test_do_action_transient_failure_swallowed(self):  # parity: P-60
        def set_color(uid, name):
            raise ConnectionRefusedError('API not enabled yet')
        p = self.poller(set_color)
        p._do_action('set_color', ('UID-1', 'red'))  # must not raise
        self.assertTrue(p.available)


class TestLatestBox(unittest.TestCase):
    def test_set_get(self):
        box = pollers.LatestBox()
        self.assertIsNone(box.get())
        box.set(42)
        self.assertEqual(box.get(), 42)


if __name__ == '__main__':
    unittest.main()
