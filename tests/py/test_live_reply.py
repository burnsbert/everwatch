"""W-10 live preview + reply (docs/DESIGN.md W-10): targeted screen reads
and send scripts (argv only, never AppleScript source), the engine's
live leases and cadence, the send command, the threaded worker's
between-polls loop, the HTTP endpoints, and the demo's reply behavior.
Every osascript call is a stub or a patched subprocess.run."""
import queue
import threading
import time
import unittest
from unittest import mock

from everwatch import engine_loop as EL
from everwatch.clock import VirtualClock
from everwatch.engine import config, iterm
from everwatch.engine.snapshot import ScreenSnapshot
from everwatch.sources import demo as demo_mod
from everwatch.sources.fake import FakeSource
from everwatch.sources.real import RealSource
from tests.py.engine_helpers import (CLAUDE_BUSY, CLAUDE_WAITING,
                                     EngineFixture, sess, snap)
from tests.py.server_helpers import ServerFixture

A, B, C, D = 'UID-A', 'UID-B', 'UID-C', 'UID-D'
EVIL = '" & (do shell script "touch /tmp/pwned") & "'


class Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, script, args=()):
        self.calls.append((script, tuple(args)))
        return self.reply

    reply = 'ok'


# ------------------------------------------------------------ iterm.py

class TestItermScripts(unittest.TestCase):
    def test_fetch_screen_passes_uid_and_hint_as_argv(self):  # parity: W-10
        run = Recorder()
        run.reply = f'ok{iterm.US}line 1\nline 2\n'
        text = iterm.fetch_screen(EVIL, (7, 2, 1), run=run)
        self.assertEqual(text, 'line 1\nline 2')
        script, args = run.calls[0]
        self.assertEqual(script, iterm.SCREEN_SCRIPT)
        self.assertEqual(args, (EVIL, '7', '2', '1'))
        self.assertNotIn('pwned', script)

    def test_fetch_screen_without_hint_uses_zeros(self):
        run = Recorder()
        run.reply = f'ok{iterm.US}'
        self.assertEqual(iterm.fetch_screen(A, run=run), '')
        self.assertEqual(run.calls[0][1], (A, '0', '0', '0'))

    def test_fetch_screen_notfound_is_none(self):
        run = Recorder()
        run.reply = 'notfound\n'
        self.assertIsNone(iterm.fetch_screen(A, (1, 1, 1), run=run))

    def test_not_running_raises(self):
        run = Recorder()
        run.reply = iterm.NOT_RUNNING_SENTINEL + '\n'
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.fetch_screen(A, run=run)
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.send_input(A, ('x',), run=run)

    def test_send_input_chunks_pause_between_writes(self):  # parity: W-10
        run = Recorder()
        run.reply = 'ok\n'
        self.assertTrue(iterm.send_input(A, (EVIL, '\r'), (1, 3, 2), run=run))
        script, args = run.calls[0]
        self.assertEqual(script, iterm.SEND_SCRIPT)
        self.assertEqual(args, (A, '1', '3', '2', 'w:' + EVIL,
                                f'd:{iterm.SEND_PAUSE_MS}', 'w:\r'))
        self.assertNotIn('pwned', script)

    def test_send_input_notfound_is_false(self):
        run = Recorder()
        run.reply = 'notfound'
        self.assertFalse(iterm.send_input(A, ('\x1b',), run=run))

    def test_scripts_never_add_their_own_newline(self):
        self.assertIn('newline no', iterm.SEND_SCRIPT)
        self.assertNotIn('do shell script', iterm.SEND_SCRIPT)
        self.assertNotIn('do shell script', iterm.SCREEN_SCRIPT)
        # both refuse to launch iTerm2 just to read or type
        for script in (iterm.SEND_SCRIPT, iterm.SCREEN_SCRIPT):
            self.assertIn('is not running then return "__NOT_RUNNING__"',
                          script)

    def test_send_chunks(self):
        self.assertEqual(iterm.send_chunks(()), ())
        self.assertEqual(iterm.send_chunks(('a',)), ('w:a',))
        self.assertEqual(iterm.send_chunks(('a', 'b'), pause_ms=5),
                         ('w:a', 'd:5', 'w:b'))

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_real_osascript_argv(self, run):  # parity: W-10
        run.return_value = mock.Mock(returncode=0, stdout='ok\n', stderr='')
        src = RealSource()
        self.assertTrue(src.send_input(
            A, (('text', EVIL), ('key', 'enter')), hint=(4711, 1, 1)))
        argv = run.call_args.args[0]
        self.assertEqual(argv, ['osascript', '-', A, '4711', '1', '1',
                                'w:' + EVIL, 'd:100', 'w:\r'])
        self.assertEqual(run.call_args.kwargs['input'], iterm.SEND_SCRIPT)

    @mock.patch('everwatch.engine.iterm.subprocess.run')
    def test_real_fetch_screen(self, run):
        run.return_value = mock.Mock(returncode=0,
                                     stdout=f'ok{iterm.US}hello\n', stderr='')
        self.assertEqual(RealSource().fetch_screen(A, (1, 1, 1)), 'hello')
        self.assertEqual(run.call_args.kwargs['input'], iterm.SCREEN_SCRIPT)


# --------------------------------------------------------------- engine

def fleet(text_a='a0', text_b='b0'):
    return (sess(A, tty='/dev/ttys001', text=text_a, window=10, tab=1),
            sess(B, tty='/dev/ttys002', text=text_b, window=10, tab=2))


class LiveFixture(EngineFixture):
    def __init__(self, testcase, **kw):
        super().__init__(testcase, **kw)
        self.set_sessions(*fleet())
        self.reads = []
        self.texts = {A: 'a-live-1', B: 'b-live-1'}

        def fetch_screen(uid, hint=None):
            self.reads.append((uid, hint))
            return self.texts.get(uid)
        self.source.set('fetch_screen', fetch_screen)
        self.engine.step()


class TestLiveLease(unittest.TestCase):
    def setUp(self):
        self.fx = LiveFixture(self)
        self.eng = self.fx.engine

    def test_lease_on_an_unknown_session_is_just_not_live(self):
        self.assertFalse(self.eng.call('live', uid='nope')['live'])
        self.assertEqual(self.eng._live, {})

    def test_lease_reads_that_session_now_and_publishes_it(self):  # parity: W-10
        sub = self.fx.subscribe()
        out = self.eng.call('live', uid=A)
        self.assertEqual(out, {'ok': True, 'live': True,
                               'interval': config.LIVE_INTERVAL,
                               'lease': config.LIVE_LEASE_SECONDS})
        self.assertEqual(self.fx.reads, [(A, (10, 1, 1))])
        self.assertEqual(self.eng.published.screen(A)['text'], 'a-live-1')
        self.assertEqual(self.eng.published.screen(B)['text'], 'b0')
        screens = [e for e in self.fx.drain(sub) if e.type == 'screens']
        self.assertEqual(len(screens), 1)
        self.assertEqual(screens[0].data['screens'], {A: 'a-live-1'})

    def test_cadence_only_the_live_session_is_reread(self):  # parity: W-10
        self.eng.call('live', uid=A)
        del self.fx.reads[:]
        snaps_before = len(self.fx.source.calls_to('fetch_snapshot'))
        for _ in range(8):  # 4 s of virtual time, a pass every 0.5 s
            self.fx.step(0.5)
        snaps = len(self.fx.source.calls_to('fetch_snapshot')) - snaps_before
        self.assertEqual(snaps, 2)  # normal 2 s cadence, unchanged
        self.assertEqual([u for u, _ in self.fx.reads], [A, A])
        # the live reads land between full snapshots: 1 s effective

    def test_no_lease_no_reads(self):  # parity: W-10
        for _ in range(8):
            self.fx.step(0.5)
        self.assertEqual(self.fx.reads, [])

    def test_lease_expires_unless_renewed(self):  # parity: W-10
        self.eng.call('live', uid=A)
        self.fx.step(config.LIVE_LEASE_SECONDS - 1)
        self.eng.call('live', uid=A)  # renew
        self.fx.step(config.LIVE_LEASE_SECONDS - 1)
        self.assertIn(A, self.eng._live)
        self.fx.step(2)
        self.assertNotIn(A, self.eng._live)
        self.assertEqual(self.eng.driver.live, ())
        del self.fx.reads[:]
        for _ in range(6):
            self.fx.step(0.5)
        self.assertEqual(self.fx.reads, [])

    def test_release(self):
        self.eng.call('live', uid=A)
        out = self.eng.call('live', uid=A, on=False)
        self.assertFalse(out['live'])
        self.assertEqual(self.eng.driver.live, ())
        # releasing something never leased (or gone) is fine
        self.assertFalse(self.eng.call('live', uid='gone', on=False)['live'])

    def test_at_most_n_live_sessions(self):
        uids = [f'U{i}' for i in range(config.LIVE_MAX_SESSIONS + 1)]
        self.fx.set_sessions(*[sess(u, tty=f'/dev/ttys{i:03d}', tab=i + 1)
                               for i, u in enumerate(uids)])
        self.fx.step()
        for u in uids:
            self.eng.call('live', uid=u)
        self.eng.call('live', uid=uids[0])  # renewing moves it to the end
        self.assertEqual(list(self.eng._live), uids[2:] + uids[:1])

    def test_new_hint_after_the_tab_moves(self):
        self.eng.call('live', uid=A)
        self.fx.set_sessions(sess(A, tty='/dev/ttys001', text='a0',
                                  window=10, tab=5))
        self.fx.step()
        self.assertEqual(self.eng.driver.live, ((A, (10, 5, 1)),))

    def test_ignored_reads(self):
        self.eng.call('live', uid=A)
        before = self.eng._snapshot
        # gone, not live, unknown uid: all no-ops
        self.eng._on_screen(ScreenSnapshot(uid=A, text=None))
        self.eng._on_screen(ScreenSnapshot(uid=B, text='x'))
        self.eng._live['ghost'] = 1e12
        self.eng._on_screen(ScreenSnapshot(uid='ghost', text='x'))
        self.assertIs(self.eng._snapshot, before)
        # same text: no new snapshot object
        self.eng._on_screen(ScreenSnapshot(uid=A, text='a-live-1'))
        self.assertIs(self.eng._snapshot, before)

    def test_failed_read_is_skipped(self):
        def boom(uid, hint=None):
            raise RuntimeError('osascript fell over')
        self.fx.source.set('fetch_screen', boom)
        self.eng.call('live', uid=A)
        self.assertEqual(self.eng.published.screen(A)['text'], 'a0')

    def test_hello_config_carries_the_cadence(self):
        cfg = self.eng.hello()['config']
        self.assertEqual(cfg['live_interval'], config.LIVE_INTERVAL)
        self.assertEqual(cfg['live_lease'], config.LIVE_LEASE_SECONDS)


class TestSendCommand(unittest.TestCase):
    def setUp(self):
        self.fx = LiveFixture(self)
        self.eng = self.fx.engine

    def test_send_types_via_the_source_and_reports(self):  # parity: W-10
        sub = self.fx.subscribe()
        polls = len(self.fx.source.calls_to('fetch_snapshot'))
        out = self.eng.call('send', uid=B, body={'text': 'yes', 'enter': True})
        self.assertEqual(out, {'id': 'a1'})
        call = self.fx.source.calls_to('send_input')[0]
        self.assertEqual(call[1], (B, (('text', 'yes'), ('key', 'enter'))))
        self.assertEqual(call[2], {'hint': (10, 2, 1)})
        results = [e.data for e in self.fx.drain(sub)
                   if e.type == 'action_result']
        self.assertEqual(results, [{'id': 'a1', 'kind': 'send', 'ok': True,
                                    'detail': ''}])
        # an action triggers an immediate re-poll (P-03)
        self.assertEqual(len(self.fx.source.calls_to('fetch_snapshot')),
                         polls + 1)

    def test_invalid_bodies_never_reach_the_source(self):  # parity: W-10
        for body, code in (({'text': 'a\x1b[2J'}, 'invalid_text'),
                           ({'key': 'ctrl-d'}, 'invalid_key'),
                           ({'text': 'x' * 5000}, 'text_too_long'),
                           ({}, 'invalid_input')):
            with self.assertRaises(EL.CommandError) as ctx:
                self.eng.call('send', uid=A, body=body)
            self.assertEqual((ctx.exception.code, ctx.exception.status),
                             (code, 400))
        self.assertEqual(self.fx.source.calls_to('send_input'), [])

    def test_unknown_session(self):
        with self.assertRaises(EL.CommandError) as ctx:
            self.eng.call('send', uid='nope', body={'key': 'esc'})
        self.assertEqual(ctx.exception.status, 404)

    def test_refuses_everwatchs_own_tab(self):  # parity: W-10
        fx = LiveFixture(self, my_tty='/dev/ttys001')
        with self.assertRaises(EL.CommandError) as ctx:
            fx.engine.call('send', uid=A, body={'key': 'ctrl-c'})
        self.assertEqual((ctx.exception.code, ctx.exception.status),
                         ('self_session', 409))
        self.assertEqual(fx.source.calls_to('send_input'), [])

    def test_expect_hash_rechecks_the_screen_first(self):  # parity: W-10
        from everwatch.engine import heuristics as H
        sub = self.fx.subscribe()
        self.fx.texts[A] = 'Do you want to proceed?\n❯ 1. Yes'
        seen = H.text_hash(self.fx.texts[A])
        self.eng.call('send', uid=A, body={'text': '1', 'expect_hash': seen})
        self.fx.texts[A] = 'a different prompt\n❯ 1. Yes'
        self.eng.call('send', uid=A, body={'text': '1', 'expect_hash': seen})
        self.fx.texts[A] = None  # gone
        self.eng.call('send', uid=A, body={'text': '1', 'expect_hash': seen})
        results = [(e.data['ok'], e.data['detail']) for e in
                   self.fx.drain(sub) if e.type == 'action_result']
        self.assertEqual(results, [
            (True, ''),
            (False, 'the screen changed since you looked; not sent'),
            (False, 'session not found')])
        self.assertEqual(len(self.fx.source.calls_to('send_input')), 1)
        with self.assertRaises(EL.CommandError):
            self.eng.call('send', uid=A, body={'text': '1',
                                               'expect_hash': 'x'})

    def test_audit_log_never_contains_the_text(self):  # parity: W-10
        with self.assertLogs('everwatch.engine', 'INFO') as logs:
            self.eng.call('send', uid=A, body={'text': 'hunter2',
                                               'enter': True})
        self.assertEqual(len(logs.output), 1)
        self.assertIn('text[7] key:enter', logs.output[0])
        self.assertIn(A, logs.output[0])
        self.assertNotIn('hunter2', logs.output[0])

    def test_failure_results(self):
        sub = self.fx.subscribe()
        self.fx.source.queue('send_input', False, RuntimeError('boom'))
        self.eng.call('send', uid=A, body={'key': 'esc'})
        self.eng.call('send', uid=A, body={'key': 'esc'})
        results = [e.data for e in self.fx.drain(sub)
                   if e.type == 'action_result']
        self.assertEqual([(r['ok'], r['detail']) for r in results],
                         [(False, 'session not found'), (False, 'boom')])


# ----------------------------------------------------- threaded worker

class Events:
    def __init__(self):
        self.items = []

    def put(self, item):
        self.items.append(item)

    def of(self, kind):
        return [p for k, p in self.items if k == kind]


class TestWorkerBetweenPolls(unittest.TestCase):
    def make(self, live_interval=0.02, texts=None):
        src = FakeSource()
        src.set('fetch_screen', lambda uid, hint=None: (texts or {}).get(
            uid, f'{uid}-text'))
        events = Events()
        stop = threading.Event()
        w = EL.SourceItermWorker(events, stop, src, VirtualClock(5.0),
                                 live_interval=live_interval)
        return w, src, events, stop

    def test_reads_only_live_targets_until_the_deadline(self):  # parity: W-10
        w, src, events, _ = self.make()
        w.live_box.set(((A, (1, 1, 1)),))
        t0 = time.monotonic()
        w.wait_between_polls(t0 + 0.25)
        self.assertGreaterEqual(time.monotonic() - t0, 0.24)
        reads = events.of('screen')
        self.assertGreaterEqual(len(reads), 3)
        self.assertEqual({r.uid for r in reads}, {A})
        self.assertEqual(reads[0], ScreenSnapshot(uid=A, text='UID-A-text',
                                                  at=5.0))
        self.assertTrue(all(c[1] == (A,) for c in
                            src.calls_to('fetch_screen')))

    def test_no_targets_no_reads(self):
        w, _src, events, _ = self.make()
        w.wait_between_polls(time.monotonic() + 0.1)
        self.assertEqual(events.of('screen'), [])

    def test_wake_reads_now(self):  # parity: W-10
        w, _src, events, _ = self.make(live_interval=30)
        w.live_box.set(((A, None),))
        w.request('wake')
        w.wait_between_polls(time.monotonic() + 0.15)
        self.assertEqual(len(events.of('screen')), 1)

    def test_action_runs_then_returns_for_a_repoll(self):
        w, src, events, _ = self.make(live_interval=30)
        w.request('send', 'a9', A, (('key', 'esc'),), (1, 1, 1))
        t0 = time.monotonic()
        w.wait_between_polls(t0 + 5)
        self.assertLess(time.monotonic() - t0, 1)
        self.assertEqual(events.of('action'), [('a9', 'send', True, '')])
        self.assertEqual(src.calls_to('send_input')[0][1],
                         (A, (('key', 'esc'),)))

    def test_poll_kick_returns(self):
        w, _src, _events, _ = self.make()
        w.kick()
        t0 = time.monotonic()
        w.wait_between_polls(t0 + 5)
        self.assertLess(time.monotonic() - t0, 1)

    def test_stop(self):
        w, _src, _events, stop = self.make()
        stop.set()
        w.wait_between_polls(time.monotonic() + 5)  # returns at once

    def test_run_loop_polls_snapshot_and_paths(self):
        w, src, events, stop = self.make()

        def fetch(at=0.0):
            stop.set()
            return snap(sess(A), at=at)
        src.set('fetch_snapshot', fetch)
        w.run()
        self.assertEqual(len(events.of('iterm')), 1)
        self.assertEqual(len(events.of('paths')), 1)

    def test_threaded_driver_wakes_only_for_new_sessions(self):
        fx = EngineFixture(self, threaded=True)
        drv = fx.engine.driver
        worker = drv.pollers['iterm']
        drv.set_live(((A, (1, 1, 1)),))
        self.assertEqual(worker.actions.get_nowait(), ('wake', ()))
        drv.set_live(((A, (1, 2, 1)),))  # same uid, new hint
        with self.assertRaises(queue.Empty):
            worker.actions.get_nowait()
        self.assertEqual(worker.live_box.get(), ((A, (1, 2, 1)),))


# --------------------------------------------------------------- server

class TestEndpoints(unittest.TestCase):
    def setUp(self):
        self.fx = ServerFixture(self)
        self.fx.fixture.set_sessions(*fleet())
        self.fx.engine.step()

    def test_send(self):  # parity: W-10
        status, _h, body = self.fx.request(
            'POST', f'/api/sessions/{A}/send', body={'text': 'hi'})
        self.assertEqual((status, body), (200, {'id': 'a1'}))

    def test_send_validation_errors(self):  # parity: W-10
        status, _h, body = self.fx.request(
            'POST', f'/api/sessions/{A}/send', body={'text': 'x\x03'})
        self.assertEqual((status, body['error']), (400, 'invalid_text'))
        status, _h, body = self.fx.request(
            'POST', '/api/sessions/nope/send', body={'key': 'esc'})
        self.assertEqual((status, body['error']), (404, 'unknown_session'))

    def test_send_needs_token_and_json(self):  # parity: W-10
        status, _h, _b = self.fx.request(
            'POST', f'/api/sessions/{A}/send', body={'key': 'esc'},
            token=False)
        self.assertEqual(status, 401)
        status, _h, _b = self.fx.request(
            'POST', f'/api/sessions/{A}/send', body={'key': 'esc'},
            content_type=False, headers={'Content-Type': 'text/plain'})
        self.assertEqual(status, 403)
        status, _h, _b = self.fx.request('GET', f'/api/sessions/{A}/send')
        self.assertEqual(status, 405)
        self.assertEqual(self.fx.fixture.source.calls_to('send_input'), [])

    def test_live_on_off(self):  # parity: W-10
        status, _h, body = self.fx.request(
            'POST', f'/api/sessions/{A}/live', body={})
        self.assertEqual(status, 200)
        self.assertTrue(body['live'])
        status, _h, body = self.fx.request(
            'DELETE', f'/api/sessions/{A}/live', body={})
        self.assertEqual((status, body['live']), (200, False))
        status, _h, body = self.fx.request(
            'POST', '/api/sessions/nope/live', body={})
        self.assertEqual((status, body['live']), (200, False))


# ----------------------------------------------------------------- demo

class TestDemoReply(unittest.TestCase):
    def setUp(self):
        self.eng = demo_mod.build_demo_engine(warmup=0)
        self.src = self.eng.source
        self.U = {s['tab_label']: s['uid']
                  for s in self.eng.published.state['sessions']}

    def screen(self, tab):
        return self.eng.published.screen(self.U[tab])['text']

    def state(self, tab):
        self.eng.call('refresh')
        self.eng.call('refresh')  # debounce needs two polls
        return next(s['state'] for s in self.eng.published.state['sessions']
                    if s['tab_label'] == tab)

    def test_digit_picks_a_claude_menu_option(self):  # parity: W-10
        self.assertEqual(self.state('1.1'), 'waiting')
        self.eng.call('send', uid=self.U['1.1'], body={'text': '1'})
        self.assertIn('You chose: 1. Yes', self.screen('1.1'))
        self.assertNotIn('❯ 1. Yes', self.screen('1.1'))
        self.assertEqual(self.state('1.1'), 'busy')

    def test_shortcut_picks_a_codex_option(self):
        self.eng.call('send', uid=self.U['1.3'], body={'text': 'y'})
        self.assertIn('You chose: 1. Yes, proceed', self.screen('1.3'))
        self.assertEqual(self.state('1.3'), 'busy')

    def test_esc_declines_a_menu(self):  # parity: W-10
        self.eng.call('send', uid=self.U['1.1'], body={'key': 'esc'})
        self.assertIn('Declined', self.screen('1.1'))
        self.assertEqual(self.state('1.1'), 'idle')

    def test_enter_takes_the_highlighted_option(self):
        self.eng.call('send', uid=self.U['1.2'], body={'key': 'esc'})
        uid = self.U['1.1']
        self.eng.call('send', uid=uid, body={'key': 'enter'})
        self.assertIn('You chose: 1. Yes', self.screen('1.1'))

    def test_unmatched_text_in_a_menu_is_ignored(self):
        before = self.screen('1.1')
        self.eng.call('send', uid=self.U['1.1'], body={'text': 'hello'})
        self.eng.call('send', uid=self.U['1.1'], body={'key': 'up'})
        self.assertEqual(self.screen('1.1'), before)

    def test_typing_then_enter_at_an_idle_prompt(self):  # parity: W-10
        uid = self.U['1.5']
        self.eng.call('send', uid=uid, body={'text': 'run the testz'})
        self.eng.call('send', uid=uid, body={'key': 'backspace'})
        self.eng.call('send', uid=uid, body={'text': 's'})
        self.assertIn('❯ run the tests', self.screen('1.5'))
        self.eng.call('send', uid=uid, body={'key': 'enter'})
        self.assertIn('> run the tests', self.screen('1.5'))
        self.assertEqual(self.state('1.5'), 'busy')
        # esc interrupts it
        self.eng.call('send', uid=uid, body={'key': 'esc'})
        self.assertIn('Interrupted', self.screen('1.5'))
        self.assertEqual(self.state('1.5'), 'idle')

    def test_codex_prompt(self):
        uid = self.U['2.1']
        self.eng.call('send', uid=uid, body={'key': 'ctrl-c'})
        self.assertIn('Interrupted', self.screen('2.1'))
        self.eng.call('send', uid=uid, body={'text': 'ship it'})
        self.assertIn('› ship it', self.screen('2.1'))
        self.eng.call('send', uid=uid, body={'key': 'enter'})
        self.assertIn('Working', self.screen('2.1'))

    def test_empty_enter_at_agent_prompt_does_nothing(self):
        before = self.screen('1.5')
        self.eng.call('send', uid=self.U['1.5'], body={'key': 'enter'})
        self.assertEqual(self.screen('1.5'), before)

    def test_shell_echo_and_ctrl_c(self):  # parity: W-10
        self.eng.call('send', uid=self.U['2.3'],
                      body={'text': 'ls', 'enter': True})
        lines = self.screen('2.3').split('\n')
        self.assertEqual(lines[-2:], ['sam@mbp ~ % ls', 'sam@mbp ~ % '])
        self.eng.call('send', uid=self.U['1.4'], body={'key': 'ctrl-c'})
        lines = self.screen('1.4').split('\n')
        self.assertTrue(lines[-2].endswith('^C'))
        self.assertEqual(lines[-1], 'sam@mbp api-gateway % ')
        # Enter on a non-prompt line just echoes
        self.eng.call('send', uid=self.U['2.4'],
                      body={'text': 'h', 'enter': True})
        self.assertEqual(self.screen('2.4').split('\n')[-1], 'h')

    def test_reply_lasts_until_the_phase_changes(self):
        clock = VirtualClock(1000.0)
        src = demo_mod.DemoSource(clock)
        uid = src.sessions[1]['uid']  # 60 s busy / 30 s question cycle
        src.send_input(uid, (('key', 'esc'),))
        self.assertIn('Interrupted', src.fetch_screen(uid))
        clock.advance(40)  # busy (60 s from offset 25) -> question
        self.assertNotIn('Interrupted', src.fetch_screen(uid))

    def test_unknown_session_and_failures(self):
        self.assertFalse(self.src.send_input('nope', (('key', 'esc'),)))
        self.assertIsNone(self.src.fetch_screen('nope'))
        self.src.fail = 'not_running'
        with self.assertRaises(iterm.ItermNotRunning):
            self.src.fetch_screen(self.U['1.1'])

    def test_live_read_in_demo(self):
        self.eng.call('live', uid=self.U['1.5'])
        self.assertIsNotNone(self.src.fetch_screen(self.U['1.5']))

    def test_helpers(self):
        self.assertEqual(demo_mod.menu_options(['  1. not selected']), [])
        opts = demo_mod.menu_options(['│ ❯ 1. Yes │', '│   2. No (esc) │'])
        self.assertEqual(opts, [(1, 'Yes', '', True),
                                (2, 'No (esc)', 'esc', False)])
        self.assertEqual(demo_mod.with_typed(['no prompt here'], 'x'),
                         ['no prompt here'])
        self.assertEqual(demo_mod.with_typed([], 'x'), [])


class TestConfig(unittest.TestCase):
    def test_float_env(self):
        f = config._float_env
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={}), 1.0)
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={'X': '0.5'}), 0.5)
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={'X': '0'}), 0.25)
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={'X': '99'}), 10)
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={'X': 'fast'}), 1.0)
        self.assertEqual(f('X', 1.0, 0.25, 10, environ={'X': 'nan'}), 1.0)


if __name__ == '__main__':
    unittest.main()
