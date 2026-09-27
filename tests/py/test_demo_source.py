"""DemoSource + build_demo_engine (docs/DESIGN.md §3.4, W-9): the fleet's
shape, byte-identical determinism for a seed + clock, the 90 s loop,
actions that mutate the scenario, failure presets, and the golden
State file consumed by the JS tests."""
import io
import json
import os
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from everwatch.clock import FixedClock, VirtualClock, parse_iso_epoch
from everwatch.engine import heuristics as H
from everwatch.engine_loop import state_json
from everwatch.sources import demo

GOLDEN = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'golden', 'state_demo.json')
SCENARIO = demo.load_scenario()
T0 = parse_iso_epoch(SCENARIO['clock'])


class PinnedTZ:
    """Pin the local zone used by reset-countdown text."""

    def __init__(self, zone='America/New_York'):
        self.zone = zone

    def __enter__(self):
        self.saved = os.environ.get('TZ')
        os.environ['TZ'] = self.zone
        time.tzset()

    def __exit__(self, *exc):
        if self.saved is None:
            os.environ.pop('TZ', None)
        else:
            os.environ['TZ'] = self.saved
        time.tzset()


def by_uid(state):
    return {s['uid']: s for s in state['sessions']}


class TestFleet(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = demo.build_demo_engine()
        cls.state = cls.engine.published.state

    def test_nine_sessions_two_windows_mix_of_agents(self):  # parity: W-9
        st = self.state
        self.assertEqual(st['mode'], 'demo')
        self.assertEqual(st['counts'], {'tabs': 9, 'agents': 6,
                                        'waiting': 2})
        kinds = [s['kind'] for s in st['sessions']]
        self.assertEqual((kinds.count('claude'), kinds.count('codex'),
                          kinds.count(None)), (4, 2, 3))
        self.assertEqual({s['window_no'] for s in st['sessions']}, {1, 2})
        self.assertEqual(st['sessions'][0]['tab_label'], '1.1')

    def test_states_at_the_hero_moment(self):  # parity: W-9
        s = by_uid(self.state)
        api = s['5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B01']
        self.assertEqual((api['state'], api['rule'], api['label']),
                         ('waiting', 'permission-question', 'deploy-fix'))
        self.assertGreater(self.state['now'] - api['state_since'], 200)
        billing = s['5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B03']
        self.assertEqual((billing['state'], billing['rule']),
                         ('waiting', 'approval-prompt'))
        self.assertEqual(s['5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B02']['state'],
                         'busy')
        docs = s['5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B05']
        self.assertEqual(docs['state'], 'idle')
        self.assertLess(self.state['now'] - docs['last_change'], 30)  # fresh
        self.assertEqual(s['5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B04']['state'],
                         'active')  # tail -f
        infra = s['9A0B7C6D-2E3F-4A5B-8C7D-1E2F3A4B5C02']
        self.assertEqual(infra['path'], '~/src/infra')  # via lsof fallback
        self.assertEqual(self.state['waiting_order'][0], api['uid'])

    def test_colors_labels_projects_and_sparklines(self):  # parity: W-9, W-5
        st = self.state
        colored = [s for s in st['sessions'] if s['tab_color']]
        self.assertEqual(len(colored), 3)
        self.assertEqual([p['name'] for p in st['projects']['slots']][:3],
                         ['API', 'Dashboard', 'Billing'])
        self.assertTrue(st['projects']['open'])
        self.assertEqual(sum(1 for s in st['sessions'] if s['label']), 3)
        sparks = {s['spark'] for s in st['sessions']}
        self.assertTrue(all(len(x) == 12 for x in sparks))
        self.assertTrue(any('w' in x and 'b' in x for x in sparks))

    def test_usage_has_a_warning_and_a_hit(self):  # parity: W-9, P-55
        rows = (self.state['usage']['claude']['rows'] +
                self.state['usage']['codex']['rows'])
        warnings = [r for r in rows if r['projection'] and
                    not r['projection']['hit']]
        hits = [r for r in rows if r['projection'] and r['projection']['hit']]
        self.assertTrue(warnings)
        self.assertTrue(hits)
        self.assertEqual({r['level'] for r in rows},
                         {'green', 'yellow', 'red'})

    def test_screens_include_prompts(self):  # parity: W-9
        screens = '\n'.join(self.state['screens'].values())
        self.assertIn('Do you want to proceed?', screens)
        self.assertIn('Would you like to run the following command?', screens)
        self.assertIn('esc to interrupt', screens)
        self.assertIn('tail -f logs/access.log', screens)

    def test_warmup_recorded_history(self):  # parity: W-5, W-6
        hist = self.engine.call('history', minutes=60)
        self.assertGreater(len(hist['transitions']), 10)
        samples = self.engine.call('usage_history')['samples']
        self.assertGreaterEqual(len({s['at'] for s in samples}), 12)

    def test_usage_history_backfilled_hours_and_days(self):  # parity: W-6
        # a fresh demo boot's burn-down charts (W-6/W-8) should have real
        # shape immediately: several hours of five-hour-window history,
        # several days of weekly-window history — not just a dozen sparse
        # points from the last hour of engine warmup.
        samples = self.engine.call('usage_history')['samples']
        by_id = {}
        for s in samples:
            by_id.setdefault(s['id'], []).append((s['at'], s['pct']))
        for uid in ('cc.five_hour', 'cx.five_hour'):
            ats = [at for at, _pct in by_id[uid]]
            oldest_hours = (T0 - min(ats)) / 3600
            self.assertGreaterEqual(oldest_hours, 5, uid)
            self.assertGreaterEqual(len(ats), 20, uid)
        for uid in ('cc.seven_day', 'cc.seven_day_sonnet', 'cx.seven_day'):
            ats = [at for at, _pct in by_id[uid]]
            oldest_days = (T0 - min(ats)) / 86400
            self.assertGreaterEqual(oldest_days, 3, uid)
            self.assertGreaterEqual(len(ats), 100, uid)
        # deterministic and continuous with the live/`_grow` formula: the
        # backfilled points rise monotonically for cc.five_hour's positive
        # rate_per_hour
        pcts = [pct for _at, pct in sorted(by_id['cc.five_hour'])]
        self.assertEqual(pcts, sorted(pcts), 'cc.five_hour rises monotonically')

    def test_demo_never_persists(self):  # parity: W-9
        store = self.engine.store
        self.assertIsInstance(store, demo.MemoryStore)
        store.set('theme', 'dark')
        store.save()
        self.assertFalse(store.dirty)
        self.assertFalse(os.path.exists(os.devnull + '.tmp'))


class TestDeterminism(unittest.TestCase):
    def test_same_seed_and_clock_byte_identical(self):  # parity: W-9
        a = demo.dump_state(seed=1, clock=FixedClock(T0))
        b = demo.dump_state(seed=1, clock=FixedClock(T0))
        self.assertEqual(a.encode('utf-8'), b.encode('utf-8'))

    def test_seed_changes_the_details(self):  # parity: W-9
        a = demo.build_demo_engine(seed=1, warmup=60)
        b = demo.build_demo_engine(seed=2, warmup=60)
        self.assertNotEqual(state_json(a.published.state),
                            state_json(b.published.state))
        self.assertEqual(a.published.state['counts'],
                         b.published.state['counts'])

    def test_golden_file_is_current(self):  # parity: W-9
        with PinnedTZ():
            fresh = demo.dump_state(seed=1) + '\n'
        with open(GOLDEN, encoding='utf-8') as f:
            self.assertEqual(f.read(), fresh,
                             'tests/golden/state_demo.json is stale: run '
                             'python3 -m everwatch.sources.demo -o '
                             'tests/golden/state_demo.json')


class TestLiveBehavior(unittest.TestCase):
    def live(self, **kw):
        clock = VirtualClock(T0)
        kw.setdefault('warmup', 0)
        engine = demo.build_demo_engine(clock=clock, **kw)
        return engine, engine.source, clock

    def test_ninety_second_loop_reaches_waiting_and_notifies(
            self):  # parity: W-9, W-1
        engine, _src, clock = self.live(warmup=120)
        engine.store.set('notify_on_waiting', True)
        sub = engine.subscribe(initial=None)
        events = []
        for _ in range(60):  # two minutes of 2 s polls
            clock.advance(2)
            engine.step()
            while True:
                ev = sub.get(timeout=0)
                if ev is None:
                    break
                events.append(ev)
        dash = '5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B02'
        to_waiting = [e for e in events if e.type == 'transition' and
                      e.data['uid'] == dash and e.data['to'] == H.WAITING]
        self.assertTrue(to_waiting)
        self.assertTrue([e for e in events if e.type == 'notify' and
                         e.data['uid'] == dash])

    def test_tail_session_changes_every_poll(self):  # parity: W-9
        engine, src, clock = self.live()
        tail = '5E1C0A7B-1F2D-4E8A-9B3C-0D4E5F6A7B04'
        h1 = by_uid(engine.published.state)[tail]['screen_hash']
        clock.advance(2)
        engine.step()
        self.assertNotEqual(by_uid(engine.published.state)[tail]
                            ['screen_hash'], h1)

    def test_close_new_goto_and_color_actions(self):  # parity: W-9, P-09
        engine, src, clock = self.live()
        sub = engine.subscribe(initial=None)
        engine.call('close_tab', window_id=4711, tab_index=2)
        st = engine.published.state
        self.assertEqual(st['counts']['tabs'], 8)
        self.assertEqual([s['tab_label'] for s in st['sessions']
                          if s['window_no'] == 1],
                         ['1.1', '1.2', '1.3', '1.4'])
        engine.call('goto', uid='9A0B7C6D-2E3F-4A5B-8C7D-1E2F3A4B5C01')
        engine.call('new_tab')
        new = [s for s in engine.published.state['sessions']
               if s['uid'].startswith('D3E4')]
        self.assertEqual((len(new), new[0]['tab_label']), (1, '2.5'))
        clock.advance(10)  # its path arrives with the next paths poll
        engine.step()
        new = [s for s in engine.published.state['sessions']
               if s['uid'].startswith('D3E4')]
        self.assertEqual(new[0]['path'], '~')
        self.assertEqual(new[0]['tty'], '/dev/ttys012')
        engine.call('new_tab')
        ttys = [s['tty'] for s in engine.published.state['sessions']]
        self.assertEqual(len(ttys), len(set(ttys)))
        engine.call('set_color', uid=new[0]['uid'], slot=4)
        clock.advance(5)
        engine.step()
        self.assertEqual(by_uid(engine.published.state)[new[0]['uid']]
                         ['tab_color'], 'red')
        engine.call('set_color', uid=new[0]['uid'], slot=None)
        clock.advance(5)
        engine.step()
        self.assertIsNone(by_uid(engine.published.state)[new[0]['uid']]
                          ['tab_color'])
        engine.call('close_tab', window_id=4711, tab_index=99)
        results = [e.data for e in iter(lambda: sub.get(timeout=0), None)
                   if e.type == 'action_result']
        self.assertEqual([r['ok'] for r in results],
                         [True, True, True, True, True, True, False])
        self.assertIn('(-1719)', results[-1]['detail'])
        self.assertFalse(src.goto('nope'))
        self.assertFalse(src.set_color('nope', 'red'))

    def test_failure_presets_and_launch(self):  # parity: W-9, P-08
        engine, src, clock = self.live()
        for preset, status in (('permission_denied', 'permission_denied'),
                               ('timeout', 'timeout'), ('error', 'error'),
                               ('not_running', 'not_running')):
            with self.subTest(preset):
                src.fail = preset
                clock.advance(2)
                engine.step()
                self.assertEqual(engine.published.state['iterm']['status'],
                                 status)
        engine.call('launch_iterm')
        self.assertEqual(src.launches, 1)
        clock.advance(2)
        engine.step()
        self.assertEqual(engine.published.state['iterm']['status'], 'ok')
        src.fail = 'timeout'
        with self.assertRaises(Exception):
            src.fetch_paths()

    def test_quota_demo_prompt_and_draft(self):  # parity: W-9, P-69
        engine, src, clock = self.live(quota=True)
        prompt = engine.published.state['quota_prompt']
        self.assertEqual(prompt['to'], 'eng-manager@example.com')
        engine.call('quota_draft')
        self.assertTrue(src.opened[0].startswith(
            'https://mail.google.com/mail/?view=cm&to=eng-manager'))

    def test_empty_scenario_parts(self):  # parity: W-9
        scenario = json.loads(json.dumps(SCENARIO))
        scenario['usage'] = {}
        scenario['sessions'] = []
        scenario.pop('access_log')
        src = demo.DemoSource(FixedClock(T0), scenario=scenario)
        self.assertEqual(src.usage_claude(), (None, None))
        self.assertEqual(src.usage_codex(), (None, None))
        self.assertEqual(src.fetch_snapshot(at=1).sessions, ())
        src.new_tab()
        self.assertEqual(src.sessions[0]['tab_index'], 1)
        self.assertEqual(len(src._log_lines('u', T0)), 12)
        partial = json.loads(json.dumps(SCENARIO))
        partial['usage']['claude'] = {'five_hour': None, 'extra_usage': {
            'is_enabled': True, 'monthly_limit': 0, 'used_credits': 5}}
        partial['usage']['codex'] = {'primary_window': None}
        src = demo.DemoSource(FixedClock(T0), scenario=partial)
        self.assertIsNone(src.usage_claude()[0]['extra_usage']
                          ['utilization'])
        self.assertEqual(src.usage_codex()[0], {'rate_limit': {}})


class TestDumpCli(unittest.TestCase):
    def test_main_writes_file_and_stdout(self):  # parity: W-9, P-74
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = os.path.join(tmp.name, 'state.json')
        with PinnedTZ('UTC'):
            self.assertEqual(demo.main(['--seed', '3', '--tz',
                                        'America/New_York', '-o', out]), 0)
        with open(out) as f:
            state = json.load(f)
        self.assertEqual(state['now'], T0)
        buf = io.StringIO()
        with PinnedTZ('UTC'), redirect_stdout(buf), \
                mock.patch.object(demo, 'dump_state',
                                  return_value='{}') as dump:
            demo.main(['--clock', 'fixed:2026-01-01T00:00:00Z', '--tz', ''])
        self.assertEqual(buf.getvalue(), '{}\n')
        self.assertEqual(dump.call_args[1]['clock'].now(),
                         parse_iso_epoch('2026-01-01T00:00:00Z'))


if __name__ == '__main__':
    unittest.main()
