"""model.py: rows, tab labels, paths, titles, self/dashboard detection,
usage rows, project slots, and the shared tail_lines/fuzzy golden cases."""
import json
import os
import unittest
from datetime import datetime, timedelta, timezone

from everwatch import model
from everwatch.engine import heuristics as H
from everwatch.engine.snapshot import (AgentSnapshot, ItermSnapshot,
                                       UsageSnapshot)
from tests.py.engine_helpers import sess

GOLDEN = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'golden')
NOW = 1_790_000_000.0


def golden(name):
    with open(os.path.join(GOLDEN, name), encoding='utf-8') as f:
        return json.load(f)['cases']


def agents(*pairs, cwd=()):
    return AgentSnapshot(ttys=tuple((t, frozenset(a)) for t, a in pairs),
                         tty_cwd=tuple(cwd))


class StubTracker:
    def __init__(self, states=None):
        self.states = states or {}

    def state(self, uid):
        return self.states.get(uid, (None, 0.0, ''))

    def has_attention(self, uid):
        return self.states.get(uid, (None,))[0] == H.WAITING

    def last_change(self, uid):
        return 5.0


class TestSessionHelpers(unittest.TestCase):
    def test_agent_kinds_claude_wins_shared_tty(self):  # parity: P-07
        kinds = model.agent_kinds(agents(('/dev/a', {'claude', 'codex'}),
                                         ('/dev/b', {'codex'}),
                                         ('/dev/c', set())))
        self.assertEqual(kinds, {'/dev/a': 'claude', '/dev/b': 'codex'})
        self.assertEqual(model.agent_kinds(None), {})

    def test_tab_label_single_window_is_bare_tab(self):  # parity: P-36
        ss = [sess('A', window=40, tab=1), sess('B', window=40, tab=3)]
        nos = model.window_numbers(ss)
        self.assertEqual(model.tab_label(ss[1], nos), '3')

    def test_tab_label_multi_window_uses_first_appearance_order(
            self):  # parity: P-36
        ss = [sess('A', window=900, tab=1), sess('B', window=12, tab=2),
              sess('C', window=900, tab=2)]
        nos = model.window_numbers(ss)
        self.assertEqual(nos, {900: 1, 12: 2})
        self.assertEqual([model.tab_label(s, nos) for s in ss],
                         ['1.1', '2.2', '1.2'])

    def test_session_path_prefers_path_variable_then_lsof(
            self):  # parity: P-05, P-06
        s = sess('A', tty='/dev/a')
        snap = agents(cwd=[('/dev/a', '/Users/t/src/x')])
        self.assertEqual(model.session_path(s, {'A': '/p'}, snap), '/p')
        self.assertEqual(model.session_path(s, {}, snap), '/Users/t/src/x')
        self.assertEqual(model.session_path(s, {}, None), '')

    def test_shorten_home(self):
        self.assertEqual(model.shorten('/Users/t/src', '/Users/t'), '~/src')
        self.assertEqual(model.shorten('/opt/x', '/Users/t'), '/opt/x')
        self.assertEqual(model.shorten('/opt/x', ''), '/opt/x')

    def test_row_title_fallbacks(self):
        self.assertEqual(model.row_title('ABCDEFGHIJ', 'lbl', '~/p', 'n'),
                         'lbl')
        self.assertEqual(model.row_title('ABCDEFGHIJ', '', '~/p', 'n'), '~/p')
        self.assertEqual(model.row_title('ABCDEFGHIJ', '', '', 'n'), 'n')
        self.assertEqual(model.row_title('ABCDEFGHIJ', '', '', ''),
                         'ABCDEFGH')

    def test_dashboard_banner_only_on_first_line(self):  # parity: P-28
        self.assertTrue(model.is_dashboard_text(
            ' ▛▞ ULTRAWATCH  9 tabs · 4 agents\nrest'))
        self.assertFalse(model.is_dashboard_text('x\n▛▞ ULTRAWATCH'))

    def test_badges(self):  # parity: P-28
        self.assertEqual(model.badge_for('claude', True, False), '▶▶▶')
        self.assertEqual(model.badge_for(None, False, True), 'UW')
        self.assertEqual(model.badge_for('codex', False, False), 'CX')
        self.assertEqual(model.badge_for('claude', False, False), 'CC')
        self.assertEqual(model.badge_for(None, False, False), '···')

    def test_project_for_color(self):  # parity: P-61
        self.assertEqual(model.project_for_color('blue'), 1)
        self.assertEqual(model.project_for_color('yellow'), 5)
        self.assertIsNone(model.project_for_color('orange'))
        self.assertIsNone(model.project_for_color(None))


class TestBuildSessions(unittest.TestCase):
    def build(self, sessions, my_tty='', labels=None, colors=None,
              states=None, paths=None, agents_snap=None):
        labels = labels or {}
        return model.build_sessions(
            ItermSnapshot(sessions=tuple(sessions)), paths=paths or {},
            agents_snap=agents_snap, colors=colors or {},
            tracker=StubTracker(states), label_for=lambda u: labels.get(u, ''),
            home='/Users/t', my_tty=my_tty,
            spark_for=lambda uid, st, since: f'spark:{uid}')

    def test_no_snapshot_no_rows(self):
        self.assertEqual(model.build_sessions(
            None, paths={}, agents_snap=None, colors={}, tracker=None,
            label_for=None, home=''), [])

    def test_fields_and_natural_order(self):  # parity: P-36, P-17
        rows = self.build(
            [sess('B', tty='/dev/b', window=2, tab=1, name='codex'),
             sess('A', tty='/dev/a', window=1, tab=2, name='✳ Fix'),
             sess('C', tty='/dev/c', window=1, tab=1, text='$ ls')],
            labels={'A': 'deploy-fix'}, colors={'A': 'purple'},
            paths={'A': '/Users/t/src/api', 'C': '/Users/t'},
            agents_snap=agents(('/dev/a', {'claude'}), ('/dev/b', {'codex'})),
            states={'A': (H.WAITING, 100.0, 'menu-option'),
                    'B': (H.BUSY, 90.0, 'working')})
        # natural order = window order of first appearance, then tab
        self.assertEqual([r['uid'] for r in rows], ['B', 'C', 'A'])
        a = rows[2]
        self.assertEqual(a['tab_label'], '2.2')
        self.assertEqual(a['window_no'], 2)
        self.assertEqual(a['kind'], 'claude')
        self.assertEqual(a['badge'], 'CC')
        self.assertEqual(a['path'], '~/src/api')
        self.assertEqual(a['display_name'], 'deploy-fix')
        self.assertEqual(a['title'], 'deploy-fix')
        self.assertEqual(a['tab_color'], 'purple')
        self.assertEqual(a['project'], 2)
        self.assertTrue(a['attention'])
        self.assertEqual(a['state'], H.WAITING)
        self.assertEqual(a['rule'], 'menu-option')
        self.assertEqual(a['screen_hash'], H.text_hash('$ '))
        self.assertEqual(a['spark'], 'spark:A')
        c = rows[1]
        self.assertEqual((c['kind'], c['badge'], c['title'], c['label']),
                         (None, '···', '~', ''))

    def test_self_session_gets_self_badge_and_name(self):  # parity: P-28
        rows = self.build([sess('S', tty='/dev/ttys009', name='python3')],
                          my_tty='/dev/ttys009')
        self.assertTrue(rows[0]['is_self'])
        self.assertFalse(rows[0]['is_dashboard'])
        self.assertEqual(rows[0]['badge'], '▶▶▶')
        self.assertEqual(rows[0]['display_name'], 'everwatch')

    def test_no_self_when_backend_has_no_tty(self):  # parity: P-28
        rows = self.build([sess('S', tty='')], my_tty='')
        self.assertFalse(rows[0]['is_self'])

    def test_ultrawatch_tab_is_a_dashboard(self):  # parity: P-28
        rows = self.build([sess('U', text='▛▞ ULTRAWATCH 3 tabs\n...',
                                name='Python')])
        self.assertTrue(rows[0]['is_dashboard'])
        self.assertEqual(rows[0]['badge'], 'UW')
        self.assertEqual(rows[0]['display_name'], 'Python')

    def test_counts_and_projects(self):  # parity: P-61, P-19
        rows = self.build(
            [sess('A', tty='/dev/a'), sess('B', tty='/dev/b', tab=2),
             sess('C', tty='/dev/c', tab=3)],
            colors={'A': 'blue', 'B': 'blue', 'C': 'orange'},
            agents_snap=agents(('/dev/a', {'claude'})))
        self.assertEqual(model.counts(rows, 1),
                         {'tabs': 3, 'agents': 1, 'waiting': 1})
        projects = model.build_projects(['API', 'Web', '', '', ''], True,
                                        rows)
        self.assertTrue(projects['open'])
        self.assertEqual(projects['slots'][0],
                         {'n': 1, 'name': 'API', 'color': 'blue', 'count': 2})
        self.assertEqual([s['count'] for s in projects['slots']],
                         [2, 0, 0, 0, 0])
        short = model.build_projects(['only'], False, rows)
        self.assertEqual(short['slots'][4]['name'], '')


class TestUsageRows(unittest.TestCase):
    def iso(self, seconds):
        return (datetime.fromtimestamp(NOW, timezone.utc) +
                timedelta(seconds=seconds)).isoformat()

    def test_section_status(self):  # parity: P-53, P-56
        self.assertEqual(model.section_status(None), 'inactive')
        self.assertEqual(model.section_status(UsageSnapshot(inactive=True)),
                         'inactive')
        self.assertEqual(model.section_status(UsageSnapshot(data={'a': 1})),
                         'ok')
        self.assertEqual(model.section_status(
            UsageSnapshot(data={'a': 1}, ok=False)), 'stale')
        self.assertEqual(model.section_status(
            UsageSnapshot(data=None, ok=False)), 'failing')
        self.assertEqual(model.section_status(UsageSnapshot(data=None)),
                         'inactive')

    def test_claude_rows_with_projection_and_hit(self):  # parity: P-54, P-55
        data = {
            # 2h15m left of 5h = 55% elapsed; 62% used -> on pace warning
            'five_hour': {'utilization': 62, 'resets_at': self.iso(8100)},
            'seven_day': {'utilization': 10, 'resets_at': self.iso(86400)},
            'seven_day_sonnet': {'utilization': 100,
                                 'resets_at': self.iso(3600)},
        }
        rows = model.claude_rows(data, False, NOW)
        self.assertEqual([r['id'] for r in rows],
                         ['cc.five_hour', 'cc.seven_day',
                          'cc.seven_day_sonnet'])
        five, week, sonnet = rows
        self.assertEqual(five['label'], 'CC Session Limit')
        self.assertEqual(five['level'], 'yellow')
        self.assertEqual(five['reset_text'].split(' (')[0], '2h 15m')
        self.assertFalse(five['projection']['hit'])
        self.assertTrue(five['projection']['text'].startswith(
            'on pace to hit session limit '))
        # machine-readable run-out time: 62% after 9900s -> 38% more in
        # 6067.7s, whole seconds, UTC ISO (VISUAL_SPEC §4.18.2)
        self.assertEqual(five['projection']['at'], datetime.fromtimestamp(
            int(NOW) + 6067, timezone.utc).isoformat())
        self.assertEqual((week['level'], week['projection']), ('green', None))
        self.assertEqual(week['label'], 'CC Weekly Limit')
        self.assertEqual(sonnet['level'], 'red')
        self.assertTrue(sonnet['hit'])
        self.assertEqual(sonnet['projection'],
                         {'text': 'sonnet limit hit', 'hit': True, 'at': None})
        self.assertEqual(model.claude_rows(None, False, NOW), [])

    def test_monthly_row_dollars_only_when_shown(self):  # parity: P-54, P-58
        data = {'extra_usage': {'is_enabled': True, 'monthly_limit': 20000,
                                'used_credits': 12345, 'utilization': 61.7}}
        hidden = model.claude_rows(data, False, NOW)[0]
        self.assertEqual(hidden['id'], 'cc.monthly')
        self.assertEqual(hidden['label'], 'CC Monthly Limit')
        self.assertIsNone(hidden['dollars'])
        self.assertTrue(hidden['reset_at'])
        self.assertTrue(hidden['reset_text'])
        shown = model.claude_rows(data, True, NOW)[0]
        self.assertEqual(shown['dollars'], {'used': '$123.45',
                                            'limit': '$200'})

    def test_extra_usage_without_limit(self):  # parity: P-54
        data = {'extra_usage': {'is_enabled': True, 'used_credits': 500}}
        row = model.claude_rows(data, True, NOW)[0]
        self.assertEqual((row['id'], row['label'], row['pct']),
                         ('cc.extra', 'CC Extra Usage', 0))
        self.assertIsNone(row['dollars'])
        self.assertIsNone(row['reset_at'])
        self.assertEqual(row['reset_text'], '')

    def test_codex_rows(self):  # parity: P-54, P-55
        data = {'rate_limit': {
            'primary_window': {'used_percent': 100,
                               'reset_at': int(NOW + 600),
                               'limit_window_seconds': 18000},
            'secondary_window': {'used_percent': 40,
                                 'reset_at': int(NOW + 86400 * 3),
                                 'limit_window_seconds': 604800}}}
        rows = model.codex_rows(data, NOW)
        self.assertEqual([r['id'] for r in rows],
                         ['cx.five_hour', 'cx.seven_day'])
        self.assertTrue(rows[0]['hit'])
        self.assertEqual(rows[0]['projection'],
                         {'text': 'Codex 5h limit hit', 'hit': True, 'at': None})
        self.assertEqual(rows[0]['reset_at'],
                         datetime.fromtimestamp(int(NOW + 600),
                                                timezone.utc).isoformat())
        self.assertIsNone(rows[1]['projection'])
        self.assertEqual(model.codex_rows(None, NOW), [])

    def test_codex_unknown_window_and_missing_pct(self):  # parity: P-54
        data = {'rate_limit': {
            'primary_window': {'used_percent': None, 'reset_at': 1,
                               'limit_window_seconds': 18000},
            'secondary_window': {'used_percent': 5, 'reset_at': None,
                                 'limit_window_seconds': 3600}}}
        rows = model.codex_rows(data, NOW)
        self.assertEqual(len(rows), 1)
        # ultrawatch falls back to the slot's label for unknown durations
        self.assertEqual(rows[0]['id'], 'cx.seven_day')
        self.assertIsNone(rows[0]['reset_at'])

    def test_epoch_iso_rejects_garbage(self):
        self.assertIsNone(model._epoch_iso('soon'))
        self.assertIsNone(model._epoch_iso(0))

    def test_build_usage_sections(self):  # parity: P-53, P-56
        failing = UsageSnapshot(data=None, ok=False, at=NOW)
        stale = UsageSnapshot(data={'rate_limit': {'primary_window': {
            'used_percent': 3, 'reset_at': int(NOW + 60),
            'limit_window_seconds': 18000}}}, ok=False, at=NOW)
        usage = model.build_usage(failing, stale,
                                  {'claude': 0, 'codex': NOW - 900}, False,
                                  NOW)
        self.assertEqual(usage['claude'],
                         {'status': 'failing', 'at': 0, 'checked_at': NOW,
                          'error': 'usage API fetch failed', 'rows': []})
        self.assertEqual(usage['codex']['status'], 'stale')
        self.assertEqual(usage['codex']['at'], NOW - 900)
        self.assertEqual(len(usage['codex']['rows']), 1)
        cx_fail = model.build_usage(None, failing, {}, False, NOW)['codex']
        self.assertEqual(cx_fail['error'], 'Codex usage fetch failed')
        inactive = model.build_usage(UsageSnapshot(inactive=True, at=NOW),
                                     None, {'claude': 5}, False, NOW)
        self.assertEqual(inactive['claude'],
                         {'status': 'inactive', 'at': 0, 'checked_at': 0,
                          'error': '', 'rows': []})

    def test_extra_usage_pct(self):  # parity: P-68
        self.assertIsNone(model.extra_usage_pct(None))
        self.assertIsNone(model.extra_usage_pct({'extra_usage': 'x'}))
        self.assertIsNone(model.extra_usage_pct(
            {'extra_usage': {'is_enabled': False, 'utilization': 99}}))
        self.assertEqual(model.extra_usage_pct(
            {'extra_usage': {'is_enabled': True, 'utilization': 91.5}}), 91.5)
        self.assertEqual(model.extra_usage_pct(
            {'extra_usage': {'is_enabled': True}}), 0)


class TestSharedGoldenCases(unittest.TestCase):
    """tests/golden/*.json run in both Python and JS (docs/DESIGN.md
    §5.2) so the two implementations can't drift."""

    def test_tail_lines_golden(self):  # parity: P-44
        cases = golden('tail_lines_cases.json')
        self.assertGreater(len(cases), 5)
        for i, c in enumerate(cases):
            with self.subTest(i=i, name=c.get('name')):
                self.assertEqual(model.tail_lines(
                    c['text'], c['n'], c['width'], c['strip_chrome']),
                    c['expected'])

    def test_tail_lines_without_width(self):  # parity: P-44
        self.assertEqual(model.tail_lines('a\nb\n\n', 5), ['a', 'b'])

    def test_fuzzy_golden(self):  # parity: P-46
        cases = golden('fuzzy_cases.json')
        for c in cases:
            with self.subTest(c=c):
                self.assertEqual(model.fuzzy_match(c['needle'],
                                                   c['haystack']),
                                 c['expected'])


if __name__ == '__main__':
    unittest.main()
