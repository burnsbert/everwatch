"""engine_loop.py: single-writer Engine, commands with futures, immutable
PublishedState with rev, subscriber fan-out with bounded queues and
overflow -> fresh state (docs/DESIGN.md §3.3), plus the error-status,
quota, and notification wiring. Almost everything runs single-threaded
via engine.step(); one test runs the real threaded driver against a
FakeSource."""
import json
import os
import queue
import tempfile
import threading
import time
import unittest
from unittest import mock

from everwatch import engine_loop as EL
from everwatch.engine import heuristics as H
from everwatch.engine import iterm, itermcolor
from everwatch.engine.snapshot import (AgentSnapshot, PathsSnapshot,
                                       UsageSnapshot)
from everwatch.sources.fake import FakeSource
from tests.py.engine_helpers import (CLAUDE_BUSY, CLAUDE_IDLE, CLAUDE_WAITING,
                                     T0, EngineFixture, sess, snap)

QUOTA_CFG = {'enabled': True, 'threshold_percent': 80,
             'email': {'to': 'boss@example.com', 'subject': 'S', 'body': 'B'}}


def claude_fleet():
    src = FakeSource()
    src.set('agent_ttys', {'/dev/a': {'claude'}, '/dev/b': {'codex'}})
    src.set('fetch_paths', PathsSnapshot(paths=(
        ('A', '/Users/tester/src/api'), ('B', '/Users/tester/src/billing'))))
    return src


class TestPublishing(unittest.TestCase):
    def test_initial_state_is_connecting(self):  # parity: P-29
        fx = EngineFixture(self)
        st = fx.engine.published.state
        self.assertEqual(st['rev'], 1)
        self.assertEqual(st['iterm'], {'status': 'connecting', 'error': '',
                                       'snapshot_at': 0})
        self.assertEqual(st['sessions'], [])
        self.assertEqual(st['mode'], 'fake')
        self.assertEqual(st['usage']['claude']['status'], 'inactive')
        self.assertEqual(st['capabilities'],
                         {'tab_colors': 'unknown', 'shell': False,
                          'notifications': 'unknown'})
        self.assertIsNone(st['quota_prompt'])
        self.assertFalse(st['prefs']['sound_on_attention'])

    def test_snapshot_publishes_new_rev_only_on_change(self):  # parity: P-36
        fx = EngineFixture(self, source=claude_fleet())
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_BUSY, window=7),
                        sess('B', tty='/dev/b', window=9, tab=1))
        st = fx.step()
        self.assertEqual(st['rev'], 2)
        self.assertEqual(st['iterm']['status'], 'ok')
        self.assertEqual(st['iterm']['snapshot_at'], T0 + 2)
        self.assertEqual(st['counts'], {'tabs': 2, 'agents': 2, 'waiting': 0})
        self.assertEqual([s['tab_label'] for s in st['sessions']],
                         ['1.1', '2.1'])
        self.assertEqual(st['sessions'][0]['path'], '~/src/api')
        self.assertEqual(st['screens']['A'], CLAUDE_BUSY)
        # nothing changed and no time-dependent field moved -> same rev
        rev = fx.engine.published.rev
        fx.engine.step()
        self.assertEqual(fx.engine.published.rev, rev)

    def test_published_state_is_replaced_not_mutated(self):  # parity: P-17
        fx = EngineFixture(self)
        before = fx.engine.published
        frozen = json.dumps(before.state, sort_keys=True)
        fx.set_sessions(sess('A'))
        fx.step()
        self.assertIsNot(fx.engine.published, before)
        self.assertEqual(json.dumps(before.state, sort_keys=True), frozen)
        with self.assertRaises(Exception):
            before.rev = 99

    def test_published_helpers(self):
        fx = EngineFixture(self)
        fx.set_sessions(sess('A', text='hello'))
        fx.step()
        pub = fx.engine.published
        self.assertEqual(pub.screen('A'),
                         {'uid': 'A', 'text': 'hello',
                          'screen_hash': H.text_hash('hello')})
        self.assertIsNone(pub.screen('nope'))
        self.assertNotIn('screens', json.loads(
            pub.to_json(include_screens=False)))
        self.assertIn('\n', pub.to_json(indent=1))
        self.assertEqual(EL.state_json({'b': 1, 'a': 'é'}),
                         '{"a":"é","b":1}')

    def test_waiting_transition_emits_transition_and_notify(
            self):  # parity: P-66, W-1, P-17
        fx = EngineFixture(self, source=claude_fleet())
        fx.store.set('notify_on_waiting', True)
        fx.store.set_label('A', 'deploy-fix', now=T0)
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_BUSY))
        fx.step()
        sub = fx.subscribe()
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_WAITING))
        fx.step()          # 1st waiting observation: debounced
        st = fx.step()     # 2nd: published
        self.assertEqual(st['waiting_order'], ['A'])
        self.assertTrue(fx.session('A')['attention'])
        events = fx.drain(sub)
        kinds = [e.type for e in events]
        self.assertIn('transition', kinds)
        self.assertIn('notify', kinds)
        tr = next(e for e in events if e.type == 'transition')
        self.assertEqual(tr.data, {'uid': 'A', 'from': 'busy',
                                   'to': 'waiting', 'at': T0 + 6,
                                   'title': 'deploy-fix'})
        self.assertEqual(tr.id, st['rev'])
        note = next(e for e in events if e.type == 'notify')
        self.assertEqual(note.data['title'],
                         '◉ deploy-fix is waiting for your input')
        self.assertEqual(note.data['body'], 'Claude Code · tab 1')
        # history got the transition (W-5)
        hist = fx.engine.call('history', uid='A')
        self.assertEqual(hist['transitions'][0]['to'], 'waiting')
        self.assertEqual(hist['stats']['count'], 1)

    def test_notify_respects_pref(self):  # parity: P-66, W-1
        fx = EngineFixture(self, source=claude_fleet())
        fx.store.set('notify_on_waiting', False)
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_BUSY))
        fx.step()
        sub = fx.subscribe()
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_WAITING))
        fx.step()
        fx.step()
        kinds = [e.type for e in fx.drain(sub)]
        self.assertIn('transition', kinds)
        self.assertNotIn('notify', kinds)

    def test_title_falls_back_to_path_then_name(self):
        fx = EngineFixture(self, source=claude_fleet())
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_BUSY))
        fx.step()
        sub = fx.subscribe()
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_IDLE))
        fx.step()
        fx.step()
        tr = [e for e in fx.drain(sub) if e.type == 'transition'][0]
        self.assertEqual(tr.data['title'], '~/src/api')

    def test_debug_state_from_env_or_pref(self):  # parity: P-18
        fx = EngineFixture(self)
        self.assertFalse(fx.engine.published.state['debug_state'])
        fx.engine.call('set_prefs', patch={'debug_state': True})
        self.assertTrue(fx.engine.published.state['debug_state'])
        env = EngineFixture(self, debug_state=True)
        self.assertTrue(env.engine.published.state['debug_state'])

    def test_rule_is_always_in_rows(self):  # parity: P-18
        fx = EngineFixture(self, source=claude_fleet())
        fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_WAITING))
        fx.step()
        self.assertEqual(fx.session('A')['rule'], 'permission-question')

    def test_self_detection_uses_backend_tty(self):  # parity: P-28
        fx = EngineFixture(self, my_tty='/dev/ttys042')
        fx.set_sessions(sess('ME', tty='/dev/ttys042', name='python3'))
        fx.step()
        self.assertTrue(fx.session('ME')['is_self'])
        self.assertEqual(fx.session('ME')['badge'], '▶▶▶')


class TestItermStatus(unittest.TestCase):
    def test_error_codes_and_recovery(self):  # parity: P-08
        fx = EngineFixture(self)
        fx.set_sessions(sess('A'))
        fx.step()
        cases = [
            (iterm.ItermNotRunning(), 'not_running', ''),
            (iterm.ItermError('Not authorized to send Apple events to '
                              'iTerm. (-1743)'), 'permission_denied', None),
            (iterm.ItermError('AppleEvent timed out. (-1712)'), 'timeout',
             None),
            (RuntimeError(''), 'error', 'RuntimeError'),
        ]
        for exc, status, error in cases:
            with self.subTest(status=status):
                fx.source.queue('fetch_snapshot', exc)
                st = fx.step()
                self.assertEqual(st['iterm']['status'], status)
                self.assertEqual(st['iterm']['error'],
                                 str(exc) if error is None else error)
                # last good sessions are kept (ultrawatch parity)
                self.assertEqual(len(st['sessions']), 1)
        st = fx.step()
        self.assertEqual(st['iterm'], {'status': 'ok', 'error': '',
                                       'snapshot_at': fx.clock.now()})


class TestCommands(unittest.TestCase):
    def setUp(self):
        self.fx = EngineFixture(self, source=claude_fleet())
        self.fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_BUSY),
                             sess('B', tty='/dev/b', tab=2))
        self.fx.step()
        self.sub = self.fx.subscribe()

    def results(self):
        return [e.data for e in self.fx.drain(self.sub)
                if e.type == 'action_result']

    def test_goto_reports_action_result(self):  # parity: P-09
        out = self.fx.engine.call('goto', uid='A')
        self.assertEqual(out, {'id': 'a1'})
        self.assertEqual(self.fx.source.calls_to('goto')[-1][1], ('A',))
        self.assertEqual(self.results(), [{'id': 'a1', 'kind': 'goto',
                                           'ok': True, 'detail': ''}])

    def test_goto_not_found_and_exception(self):  # parity: P-09
        self.fx.source.queue('goto', False, iterm.ItermError('boom'))
        self.fx.engine.call('goto', uid='A')
        self.fx.engine.call('goto', uid='A')
        self.assertEqual([(r['ok'], r['detail']) for r in self.results()],
                         [(False, 'session not found'), (False, 'boom')])

    def test_unknown_session_is_404(self):
        for kind, kw in (('goto', {}), ('visit', {}),
                         ('set_label', {'label': 'x'}),
                         ('set_color', {'slot': 1})):
            with self.subTest(kind), \
                    self.assertRaises(EL.CommandError) as cm:
                self.fx.engine.call(kind, uid='ZZZ', **kw)
            self.assertEqual((cm.exception.code, cm.exception.status),
                             ('unknown_session', 404))

    def test_visit_clears_attention(self):  # parity: P-16
        self.fx.set_sessions(sess('A', tty='/dev/a', text=CLAUDE_WAITING))
        self.fx.step()
        self.fx.step()
        self.assertTrue(self.fx.session('A')['attention'])
        self.assertEqual(self.fx.engine.call('visit', uid='A'), {'ok': True})
        self.assertFalse(self.fx.session('A')['attention'])

    def test_labels_set_trim_and_clear(self):  # parity: P-48
        self.fx.engine.call('set_label', uid='A', label='  deploy \n fix ')
        s = self.fx.session('A')
        self.assertEqual((s['label'], s['display_name'], s['title']),
                         ('deploy fix', 'deploy fix', 'deploy fix'))
        self.fx.engine.call('set_label', uid='A', label='x' * 200)
        self.assertEqual(len(self.fx.session('A')['label']), 80)
        self.fx.engine.call('set_label', uid='A', label='')
        self.assertEqual(self.fx.session('A')['label'], '')
        with self.assertRaises(EL.CommandError):
            self.fx.engine.call('set_label', uid='A', label=5)

    def test_labels_persist_after_debounce_and_touch(self):  # parity: P-48
        self.fx.engine.call('set_label', uid='A', label='api')
        self.fx.step(seconds=3)
        with open(self.fx.store.path) as f:
            saved = json.load(f)
        self.assertEqual(saved['labels']['A']['label'], 'api')
        self.fx.step(seconds=100)
        self.assertEqual(self.fx.store.state['labels']['A']['last_seen'],
                         int(self.fx.clock.now()))

    def test_set_color_maps_slot_to_project_color(self):  # parity: P-62
        out = self.fx.engine.call('set_color', uid='A', slot=2)
        self.assertEqual(out, {'id': 'a1'})
        self.assertEqual(self.fx.source.calls_to('set_color')[-1][1],
                         ('A', 'purple'))
        self.fx.engine.call('set_color', uid='A', slot=None)
        self.assertEqual(self.fx.source.calls_to('set_color')[-1][1],
                         ('A', None))
        self.assertEqual([r['kind'] for r in self.results()],
                         ['color', 'color'])
        for bad in (0, 6, True, '1'):
            with self.subTest(bad=bad), self.assertRaises(EL.CommandError):
                self.fx.engine.call('set_color', uid='A', slot=bad)

    def test_set_color_failure_modes(self):  # parity: P-62, P-60
        self.fx.source.queue('set_color', False, RuntimeError('x'),
                             itermcolor.ColorApiUnavailable('no pkg'))
        for _ in range(3):
            self.fx.engine.call('set_color', uid='A', slot=1)
        self.assertEqual([(r['ok'], r['detail']) for r in self.results()],
                         [(False, 'session not found'), (False, 'x'),
                          (False, 'tab colors unavailable')])
        self.assertEqual(
            self.fx.engine.published.state['capabilities']['tab_colors'],
            'not_installed')
        with self.assertRaises(EL.CommandError) as cm:
            self.fx.engine.call('set_color', uid='A', slot=1)
        self.assertEqual((cm.exception.code, cm.exception.status),
                         ('tab_colors_unavailable', 409))

    def test_tabs_new_and_close(self):  # parity: P-09
        self.assertEqual(self.fx.engine.call('new_tab'), {'id': 'a1'})
        self.assertEqual(self.fx.engine.call('close_tab', window_id=1,
                                             tab_index=2), {'id': 'a2'})
        self.assertEqual(self.fx.source.calls_to('close_tab')[-1][1], (1, 2))
        self.assertEqual([r['kind'] for r in self.results()],
                         ['new', 'close'])
        with self.assertRaises(EL.CommandError):
            self.fx.engine.call('close_tab', window_id='1', tab_index=2)

    def test_actions_force_an_immediate_repoll(self):  # parity: P-03
        n = len(self.fx.source.calls_to('fetch_snapshot'))
        self.fx.engine.call('new_tab')  # no clock advance
        self.assertEqual(len(self.fx.source.calls_to('fetch_snapshot')),
                         n + 1)

    def test_refresh_kicks_every_poller(self):  # parity: P-10
        counts = {m: len(self.fx.source.calls_to(m)) for m in
                  ('fetch_snapshot', 'fetch_paths', 'agent_ttys',
                   'fetch_colors')}
        self.assertEqual(self.fx.engine.call('refresh'), {'ok': True})
        for method, n in counts.items():
            with self.subTest(method):
                self.assertEqual(len(self.fx.source.calls_to(method)), n + 1)

    def test_set_prefs_validates_all_or_nothing(self):  # parity: P-70
        prefs = self.fx.engine.call('set_prefs', patch={
            'split_ratio': 0.99, 'view': 'grid', 'projects_open': True})
        self.assertEqual((prefs['split_ratio'], prefs['view']), (0.8, 'grid'))
        st = self.fx.engine.published.state
        self.assertTrue(st['projects']['open'])
        self.assertEqual(st['prefs']['view'], 'grid')
        with self.assertRaises(EL.CommandError) as cm:
            self.fx.engine.call('set_prefs', patch={'view': 'list',
                                                    'bogus': 1})
        self.assertEqual(cm.exception.code, 'invalid_prefs')
        self.assertEqual(self.fx.engine.published.state['prefs']['view'],
                         'grid')

    def test_projects(self):  # parity: P-61
        self.fx.engine.call('set_project', n=1, name='  API  gateway ')
        self.assertEqual(
            self.fx.engine.published.state['projects']['slots'][0]['name'],
            'API gateway')
        self.fx.engine.call('clear_projects')
        self.assertEqual(
            self.fx.engine.published.state['projects']['slots'][0]['name'],
            '')
        for kw in ({'n': 0, 'name': 'x'}, {'n': True, 'name': 'x'},
                   {'n': 1, 'name': 3}):
            with self.subTest(kw=kw), self.assertRaises(EL.CommandError):
                self.fx.engine.call('set_project', **kw)

    def test_history_arguments(self):  # parity: W-5
        self.assertEqual(self.fx.engine.call('history', minutes=9999),
                         {'transitions': []})
        with self.assertRaises(EL.CommandError):
            self.fx.engine.call('history', minutes='soon')

    def test_usage_history_command(self):  # parity: W-6
        self.assertEqual(self.fx.engine.call('usage_history'),
                         {'samples': []})
        with self.assertRaises(EL.CommandError):
            self.fx.engine.call('usage_history', since='x')

    def test_import_and_launch(self):  # parity: P-71, P-66
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = os.path.join(tmp.name, 'state.json')
        with open(path, 'w') as f:
            json.dump({'bell': True, 'labels': {
                'A': {'label': 'from-uw', 'last_seen': T0}}}, f)
        out = self.fx.engine.call('import_ultrawatch', path=path)
        self.assertTrue(out['bell_was_on'])
        st = self.fx.engine.published.state
        self.assertFalse(st['prefs']['sound_on_attention'])
        self.assertEqual(self.fx.session('A')['label'], 'from-uw')
        self.assertEqual(self.fx.engine.call('launch_iterm'), {'ok': True})
        self.assertEqual(len(self.fx.source.calls_to('launch_iterm')), 1)

    def test_unknown_command_and_bad_arguments(self):
        with self.assertRaises(EL.CommandError) as cm:
            self.fx.engine.call('self_destruct')
        self.assertEqual(cm.exception.code, 'unknown_command')
        with self.assertRaises(EL.CommandError) as cm:
            self.fx.engine.call('visit', uid='A', extra=1)
        self.assertEqual(cm.exception.code, 'bad_arguments')
        self.assertIn('bad_arguments', str(cm.exception))

    def test_cancelled_future_is_skipped(self):
        fut = self.fx.engine.submit('refresh')
        fut.cancel()
        self.fx.engine.step()
        self.assertTrue(fut.cancelled())


class TestQuotaPrompt(unittest.TestCase):
    def fleet(self, pct):
        src = claude_fleet()
        src.set('usage_claude', ({'extra_usage': {
            'is_enabled': True, 'monthly_limit': 1000, 'used_credits': 900,
            'utilization': pct}}, None))
        return src

    def test_prompt_draft_marks_month(self):  # parity: P-69, P-68
        fx = EngineFixture(self, source=self.fleet(91), quota_cfg=QUOTA_CFG)
        sub = fx.subscribe()
        st = fx.step()
        self.assertEqual(st['quota_prompt'],
                         {'pct': 91, 'to': 'boss@example.com',
                          'month': '2026-09'})
        self.assertEqual([e.data for e in fx.drain(sub)
                          if e.type == 'quota_prompt'],
                         [{'pct': 91, 'to': 'boss@example.com',
                           'month': '2026-09'}])
        self.assertEqual(fx.engine.call('quota_draft'),
                         {'ok': True, 'opened': True})
        url = fx.source.calls_to('open_url')[0][1][0]
        self.assertTrue(url.startswith('https://mail.google.com/mail/?'))
        self.assertIsNone(fx.engine.published.state['quota_prompt'])
        self.assertEqual(fx.quota.marked_month, '2026-09')
        fx.engine.call('refresh')  # usage refetch: already marked
        self.assertIsNone(fx.engine.published.state['quota_prompt'])
        with self.assertRaises(EL.CommandError) as cm:
            fx.engine.call('quota_draft')
        self.assertEqual(cm.exception.status, 409)

    def test_skip_marks_month_without_opening(self):  # parity: P-69
        cfg = dict(QUOTA_CFG, email={})
        fx = EngineFixture(self, source=self.fleet(95), quota_cfg=cfg)
        fx.step()
        self.assertEqual(fx.engine.published.state['quota_prompt']['to'], '')
        self.assertEqual(fx.engine.call('quota_skip'), {'ok': True})
        self.assertEqual(fx.source.calls_to('open_url'), [])
        self.assertEqual(fx.quota.marked_month, '2026-09')
        with self.assertRaises(EL.CommandError):
            fx.engine.call('quota_skip')

    def test_draft_without_email_opens_nothing(self):  # parity: P-69
        fx = EngineFixture(self, source=self.fleet(95),
                           quota_cfg=dict(QUOTA_CFG, email='x'))
        fx.step()
        self.assertEqual(fx.engine.call('quota_draft'),
                         {'ok': True, 'opened': False})

    def test_below_threshold_or_disabled_no_prompt(self):  # parity: P-68
        fx = EngineFixture(self, source=self.fleet(50), quota_cfg=QUOTA_CFG)
        self.assertIsNone(fx.step()['quota_prompt'])
        fx2 = EngineFixture(self, source=self.fleet(99), quota_cfg=None)
        self.assertIsNone(fx2.step()['quota_prompt'])


class TestUsageAndColors(unittest.TestCase):
    def test_usage_statuses_through_engine(self):  # parity: P-53, P-56
        src = claude_fleet()
        src.set('usage_claude', (None, 60))
        fx = EngineFixture(self, source=src)
        st = fx.step()
        self.assertEqual(st['usage']['claude']['status'], 'failing')
        self.assertEqual(st['usage']['claude']['error'],
                         'usage API fetch failed')
        # codex agent present but its fetch fails too
        self.assertEqual(st['usage']['codex']['status'], 'failing')
        src.set('agent_ttys', {})
        st = fx.step(seconds=6)
        self.assertEqual(st['usage']['claude']['status'], 'inactive')

    def test_usage_ok_then_stale_keeps_last_good(self):  # parity: P-53, P-56
        src = claude_fleet()
        src.set('usage_codex', ({'rate_limit': {'primary_window': {
            'used_percent': 10, 'reset_at': int(T0 + 3600),
            'limit_window_seconds': 18000}}}, None))
        fx = EngineFixture(self, source=src)
        st = fx.step()
        good_at = st['usage']['codex']['at']
        self.assertEqual(st['usage']['codex']['status'], 'ok')
        src.set('usage_codex', (None, None))
        fx.engine.call('refresh')
        fx.step(seconds=301)
        st = fx.engine.published.state
        self.assertEqual(st['usage']['codex']['status'], 'stale')
        self.assertEqual(st['usage']['codex']['at'], good_at)
        self.assertEqual(st['usage']['codex']['rows'][0]['pct'], 10)

    def test_usage_samples_recorded(self):  # parity: W-6
        src = claude_fleet()
        src.set('usage_claude', ({'five_hour': {
            'utilization': 40, 'resets_at': '2026-09-21T14:00:00+00:00'}},
            None))
        fx = EngineFixture(self, source=src)
        fx.step()
        samples = fx.engine.call('usage_history')['samples']
        self.assertEqual([(s['id'], s['pct']) for s in samples],
                         [('cc.five_hour', 40)])

    def test_show_dollars_rebuilds_usage_rows(self):  # parity: P-58
        src = claude_fleet()
        src.set('usage_claude', ({'extra_usage': {
            'is_enabled': True, 'monthly_limit': 5000,
            'used_credits': 1250}}, None))
        fx = EngineFixture(self, source=src)
        fx.step()
        row = fx.engine.published.state['usage']['claude']['rows'][0]
        self.assertIsNone(row['dollars'])
        fx.engine.call('set_prefs', patch={'show_dollars': True})
        row = fx.engine.published.state['usage']['claude']['rows'][0]
        self.assertEqual(row['dollars'], {'used': '$12.50', 'limit': '$50'})

    def test_colors_capability_states(self):  # parity: P-60
        src = claude_fleet()
        src.set('fetch_colors', {'A': 'blue'})
        fx = EngineFixture(self, source=src)
        fx.set_sessions(sess('A', tty='/dev/a'))
        st = fx.step()
        self.assertEqual(st['capabilities']['tab_colors'], 'available')
        self.assertEqual(fx.session('A')['tab_color'], 'blue')
        self.assertEqual(st['projects']['slots'][0]['count'], 1)
        src.queue('fetch_colors', ConnectionRefusedError())
        st = fx.step(seconds=5)
        self.assertEqual(st['capabilities']['tab_colors'], 'api_disabled')
        src.queue('fetch_colors', RuntimeError())
        st = fx.step(seconds=5)
        self.assertEqual(st['capabilities']['tab_colors'], 'error')
        src.queue('fetch_colors', itermcolor.ColorApiUnavailable('x'))
        st = fx.step(seconds=5)
        self.assertEqual(st['capabilities']['tab_colors'], 'not_installed')
        n = len(src.calls_to('fetch_colors'))
        fx.step(seconds=5)
        self.assertEqual(len(src.calls_to('fetch_colors')), n)  # stopped

    def test_lsof_cwd_fallback_is_kept_between_polls(self):  # parity: P-06
        src = FakeSource()
        src.set('agent_ttys', {'/dev/a': {'claude'}})
        src.set('tty_cwds', lambda ttys: {t: '/Users/tester/src/x'
                                          for t in ttys})
        fx = EngineFixture(self, source=src)
        fx.set_sessions(sess('A', tty='/dev/a'))
        fx.step()
        for _ in range(6):
            fx.step(seconds=5)
            self.assertEqual(fx.session('A')['path'], '~/src/x')
        self.assertEqual(src.calls_to('tty_cwds')[-1][1],
                         (frozenset({'/dev/a'}),))
        # vanished ttys are dropped from the cache
        fx.set_sessions(sess('B', tty='/dev/b'))
        fx.step()
        self.assertEqual(fx.engine._tty_cwd, {})

    def test_agents_poll_failures_are_swallowed(self):
        src = FakeSource(agent_ttys=RuntimeError('ps died'),
                         fetch_paths=RuntimeError('nope'))
        src.set('tty_cwds', RuntimeError('lsof died'))
        fx = EngineFixture(self, source=src)
        fx.set_sessions(sess('A', tty='/dev/a'))
        fx.step()
        st = fx.step(seconds=10)
        self.assertEqual(st['sessions'][0]['kind'], None)


class TestSubscribers(unittest.TestCase):
    def test_hello_then_state_and_changed_screens(self):  # parity: P-14
        fx = EngineFixture(self)
        sub = fx.subscribe(initial='hello')
        hello = sub.get(timeout=0)
        self.assertEqual(hello.type, 'hello')
        self.assertEqual(hello.data['config']['snapshot_interval'], 2)
        self.assertIn('screens', hello.data['state'])
        fx.set_sessions(sess('A', text='one'), sess('B', text='two', tab=2))
        fx.step()
        events = fx.drain(sub)
        self.assertEqual([e.type for e in events], ['state', 'screens'])
        self.assertNotIn('screens', events[0].data)
        self.assertEqual(events[1].data['screens'], {'A': 'one', 'B': 'two'})
        self.assertEqual({e.id for e in events}, {events[0].data['rev']})
        fx.set_sessions(sess('A', text='one'), sess('B', text='three',
                                                   tab=2))
        fx.step()
        events = fx.drain(sub)
        self.assertEqual(events[1].data['screens'], {'B': 'three'})

    def test_overflow_drops_backlog_and_sends_fresh_state(self):
        fx = EngineFixture(self)
        sub = fx.engine.subscribe(initial=None, maxsize=3)
        for i in range(5):
            fx.set_sessions(sess('A', text=f'frame {i}'))
            fx.step()
        self.assertGreaterEqual(sub.overflows, 1)
        events = fx.drain(sub)
        self.assertLessEqual(len(events), 3)
        last_state = [e for e in events if e.type == 'state'][-1]
        self.assertEqual(last_state.data['rev'], fx.engine.published.rev)
        screens = [e for e in events if e.type == 'screens'][-1]
        self.assertEqual(screens.data['screens'], {'A': 'frame 4'})

    def test_overflow_replaces_backlog_with_state_and_full_screens(self):
        fx = EngineFixture(self)
        fx.set_sessions(sess('A', text='a'), sess('B', text='b', tab=2))
        fx.step()
        sub = fx.engine.subscribe(initial=None, maxsize=2)
        fx.set_sessions(sess('A', text='a2'), sess('B', text='b', tab=2))
        fx.step()                       # state + screens: queue is full
        fx.engine.call('goto', uid='A')  # action_result overflows it
        events = fx.drain(sub)
        self.assertEqual(sub.overflows, 1)
        self.assertEqual([e.type for e in events], ['state', 'screens'])
        self.assertEqual(events[1].data['screens'], {'A': 'a2', 'B': 'b'})

    def test_initial_state_and_unsubscribe(self):
        fx = EngineFixture(self)
        sub = fx.engine.subscribe(initial='state')
        self.assertEqual([e.type for e in fx.drain(sub)],
                         ['state', 'screens'])
        self.assertEqual(fx.engine.subscriber_count, 1)
        fx.engine.unsubscribe(sub)
        self.assertEqual(fx.engine.subscriber_count, 0)
        self.assertTrue(sub.closed)
        self.assertIsNone(sub.get(timeout=0))
        sub.offer(EL.Event('state', 1, {}), lambda: [])
        self.assertEqual(sub.pending(), 0)

    def test_get_times_out_with_none(self):
        self.assertIsNone(EL.Subscription().get(timeout=0.01))

    def test_action_results_share_current_rev(self):
        fx = EngineFixture(self)
        fx.set_sessions(sess('A'))
        fx.step()
        sub = fx.subscribe()
        fx.engine.call('goto', uid='A')
        events = fx.drain(sub)
        self.assertEqual([e.type for e in events], ['action_result'])
        self.assertEqual(events[0].id, fx.engine.published.rev)

    def test_stop_saves_and_closes_subscribers(self):
        fx = EngineFixture(self)
        sub = fx.subscribe()
        fx.engine.call('set_project', n=2, name='Web')
        fx.engine.stop()
        self.assertTrue(sub.closed)
        with open(fx.store.path) as f:
            self.assertEqual(json.load(f)['projects'][1], 'Web')


class TestThreadedDriver(unittest.TestCase):
    def wait_for(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.02)
        return False

    def test_real_threads_with_fake_source(self):  # parity: P-03
        src = claude_fleet()
        src.set('fetch_snapshot', snap(sess('A', tty='/dev/a',
                                            text=CLAUDE_BUSY)))
        src.set('fetch_colors', {'A': 'green'})
        fx = EngineFixture(self, source=src, threaded=True)
        self.assertIsInstance(fx.engine.driver, EL.ThreadedDriver)
        sub = fx.engine.subscribe()
        fx.engine.start()
        fx.engine.start()  # idempotent
        self.addCleanup(fx.engine.stop)
        self.assertTrue(self.wait_for(
            lambda: fx.engine.published.state['sessions'] and
            fx.engine.published.state['capabilities']['tab_colors'] ==
            'available'))
        self.assertTrue(fx.engine.running)
        # commands from another thread go through the future
        self.assertEqual(fx.engine.call('visit', uid='A'), {'ok': True})
        aid = fx.engine.call('goto', uid='A')['id']
        cid = fx.engine.call('set_color', uid='A', slot=3)['id']
        self.assertEqual(fx.engine.call('refresh'), {'ok': True})

        seen = {}

        def results():
            while True:
                ev = sub.get(timeout=0)
                if ev is None:
                    break
                if ev.type == 'action_result':
                    seen[ev.data['id']] = ev.data
            return aid in seen and cid in seen
        self.assertTrue(self.wait_for(results))
        self.assertTrue(seen[aid]['ok'])
        self.assertEqual(seen[cid]['kind'], 'color')
        self.assertIn(('A', 'green'), [c[1] for c in
                                       src.calls_to('set_color')])
        fx.engine.stop()
        self.assertFalse(fx.engine.running)


class TestThreadedPollerPieces(unittest.TestCase):
    """The poller subclasses' bodies, called synchronously."""

    def setUp(self):
        self.events = queue.Queue()
        self.src = FakeSource()

    def test_iterm_worker_snapshot_paths_actions(self):
        from everwatch.clock import VirtualClock
        w = EL.SourceItermWorker(self.events, threading.Event(), self.src,
                                 VirtualClock(50.0))
        self.src.queue('fetch_snapshot', iterm.ItermNotRunning())
        w._poll_snapshot()
        self.assertTrue(self.events.get_nowait()[1].not_running)
        w._poll_paths()
        self.assertEqual(self.events.get_nowait()[0], 'paths')
        self.assertEqual(self.src.calls_to('fetch_paths')[-1][2], {'at': 50.0})
        self.src.queue('fetch_paths', RuntimeError())
        w._poll_paths()
        self.assertTrue(self.events.empty())
        w._do_action('close', ('a9', 3, 4))
        self.assertEqual(self.events.get_nowait(),
                         ('action', ('a9', 'close', True, '')))
        w._do_action('warp', ('a10',))
        self.assertEqual(self.events.get_nowait()[1][2:],
                         (False, 'unknown action warp'))

    def test_colors_poller_statuses_and_actions(self):
        p = EL.SourceColorsPoller(self.events, threading.Event(), self.src)
        self.src.queue('fetch_colors', FileNotFoundError(), {'U': 'red'},
                       itermcolor.ColorApiUnavailable('x'))
        p.poll()
        self.assertEqual(self.events.get_nowait(),
                         ('colors_status', 'api_disabled'))
        p.poll(now=3.0)
        kind, snap_ = self.events.get_nowait()
        self.assertEqual((kind, snap_.colors), ('colors', (('U', 'red'),)))
        p.poll()
        self.assertEqual(self.events.get_nowait(),
                         ('colors_status', 'not_installed'))
        self.assertFalse(p.available)
        p.poll()  # permanently stopped
        self.assertTrue(self.events.empty())
        p._do_action('poll', ())
        self.assertTrue(self.events.empty())
        self.src.queue('set_color', itermcolor.ColorApiUnavailable('x'))
        p._do_action('set_color', ('a1', 'U', 'red'))
        self.assertEqual(self.events.get_nowait(),
                         ('colors_status', 'not_installed'))
        self.assertEqual(self.events.get_nowait()[1][2:],
                         (False, 'tab colors unavailable'))

    def test_inbox_adapter_and_needs_cwd(self):
        fx = EngineFixture(self, threaded=True)
        drv = fx.engine.driver
        drv.set_needs_cwd(frozenset({'/dev/x'}))
        self.assertEqual(drv.needs_cwd_box.get(), frozenset({'/dev/x'}))
        drv.pump(0)  # no-op for threads
        drv.stop()


if __name__ == '__main__':
    unittest.main()
