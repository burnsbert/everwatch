"""Ported from ultrawatch tests/test_heuristics.py (P-11 through P-17)."""
import os
import unittest

from everwatch.engine import heuristics as H
from everwatch.engine.snapshot import SessionInfo

FIXTURES = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'fixtures')


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding='utf-8') as f:
        return f.read()


def session(uid='U1', tty='/dev/ttys001', text='hello', proc=False):
    return SessionInfo(window_id=1, tab_index=1, session_index=1, uid=uid,
                       tty=tty, is_processing=proc, name='x', text=text)


class TestStates(unittest.TestCase):
    def test_five_distinct_states(self):  # parity: P-11
        self.assertEqual({H.BUSY, H.WAITING, H.IDLE, H.ACTIVE, H.QUIET},
                         {'busy', 'waiting', 'idle', 'active', 'quiet'})


class TestClassify(unittest.TestCase):
    def test_claude_idle_real_screen(self):  # parity: P-12
        state, rule = H.classify_agent('claude', fixture('claude_idle.txt'),
                                       False)
        self.assertEqual(state, H.IDLE)

    def test_claude_busy_spinner_real_screen(self):  # parity: P-12
        state, rule = H.classify_agent(
            'claude', fixture('claude_busy_spinner.txt'), True)
        self.assertEqual(state, H.BUSY)
        self.assertEqual(rule, 'spinner-verb')

    def test_claude_permission_prompt(self):  # parity: P-12
        state, rule = H.classify_agent(
            'claude', fixture('claude_permission_prompt.txt'), False)
        self.assertEqual(state, H.WAITING)

    def test_claude_busy_with_old_prompt_above(self):  # parity: P-12
        # An answered permission box higher up must not shadow the
        # active "esc to interrupt" status below it (bottom-up scan).
        state, rule = H.classify_agent(
            'claude', fixture('claude_busy_esc.txt'), True)
        self.assertEqual(state, H.BUSY)
        self.assertEqual(rule, 'esc-to-interrupt')

    def test_codex_working(self):  # parity: P-12
        state, rule = H.classify_agent('codex', fixture('codex_working.txt'),
                                       True)
        self.assertEqual(state, H.BUSY)

    def test_codex_approval(self):  # parity: P-12
        state, rule = H.classify_agent('codex', fixture('codex_approval.txt'),
                                       False)
        self.assertEqual(state, H.WAITING)

    def test_fallback_processing(self):  # parity: P-12
        state, rule = H.classify_agent('claude', 'plain output\nno markers',
                                       True)
        self.assertEqual((state, rule), (H.BUSY, 'fallback-processing'))

    def test_fallback_idle(self):  # parity: P-12
        state, rule = H.classify_agent('claude', 'plain output\nno markers',
                                       False)
        self.assertEqual((state, rule), (H.IDLE, 'fallback-idle'))

    def test_completion_line_is_not_busy(self):  # parity: P-12
        # "✻ Worked for 11s" (no ellipsis) marks completion, not activity
        state, _ = H.classify_agent('claude', '✻ Worked for 11s\n', False)
        self.assertEqual(state, H.IDLE)

    def test_old_marker_beyond_scan_window_ignored(self):  # parity: P-12
        text = 'Do you want to proceed?\n' + '\n'.join(
            f'line {i}' for i in range(H.SCAN_LINES + 5))
        state, _ = H.classify_agent('claude', text, False)
        self.assertEqual(state, H.IDLE)


class TestHashing(unittest.TestCase):
    def test_spinner_change_does_not_change_hash(self):  # parity: P-14
        a = '✢ Ruminating…\noutput line\n'
        b = '✻ Ruminating…\noutput line\n'
        self.assertEqual(H.text_hash(a), H.text_hash(b))

    def test_trailing_blank_lines_ignored(self):  # parity: P-14
        self.assertEqual(H.text_hash('x\ny'), H.text_hash('x\ny\n\n  \n'))

    def test_real_change_changes_hash(self):  # parity: P-14
        self.assertNotEqual(H.text_hash('x\ny'), H.text_hash('x\nz'))


class TestTracker(unittest.TestCase):
    def setUp(self):
        self.tr = H.SessionTracker()
        self.kinds = {'/dev/ttys001': 'claude'}

    def test_first_observation_publishes_immediately_no_event(self):  # parity: P-15
        events = self.tr.update([session(text=fixture('claude_idle.txt'))],
                                self.kinds, now=100.0)
        self.assertEqual(events, [])
        state, since, _ = self.tr.state('U1')
        self.assertEqual(state, H.IDLE)
        self.assertEqual(since, 100.0)

    def test_transition_debounced_two_snapshots(self):  # parity: P-15
        idle = fixture('claude_idle.txt')
        waiting = fixture('claude_permission_prompt.txt')
        self.tr.update([session(text=idle)], self.kinds, now=100.0)
        ev1 = self.tr.update([session(text=waiting)], self.kinds, now=102.0)
        self.assertEqual(ev1, [])  # one observation isn't enough
        self.assertEqual(self.tr.state('U1')[0], H.IDLE)
        ev2 = self.tr.update([session(text=waiting)], self.kinds, now=104.0)
        self.assertEqual(ev2, [('U1', H.IDLE, H.WAITING)])
        self.assertEqual(self.tr.state('U1')[0], H.WAITING)
        self.assertTrue(self.tr.has_attention('U1'))

    def test_flicker_does_not_transition(self):  # parity: P-15
        idle = fixture('claude_idle.txt')
        waiting = fixture('claude_permission_prompt.txt')
        self.tr.update([session(text=idle)], self.kinds, now=100.0)
        self.tr.update([session(text=waiting)], self.kinds, now=102.0)
        ev = self.tr.update([session(text=idle)], self.kinds, now=104.0)
        self.assertEqual(ev, [])
        self.assertEqual(self.tr.state('U1')[0], H.IDLE)

    def test_attention_cleared_on_visit(self):  # parity: P-16
        waiting = fixture('claude_permission_prompt.txt')
        self.tr.update([session(text=waiting)], self.kinds, now=100.0)
        self.assertTrue(self.tr.has_attention('U1'))
        self.tr.visit('U1')
        self.assertFalse(self.tr.has_attention('U1'))
        self.assertEqual(self.tr.state('U1')[0], H.WAITING)  # state unchanged

    def test_waiting_uids_ordered_oldest_first(self):  # parity: P-17
        waiting = fixture('claude_permission_prompt.txt')
        kinds = {'/dev/ttys001': 'claude', '/dev/ttys002': 'claude'}
        self.tr.update([session(uid='A', tty='/dev/ttys001', text=waiting)],
                       kinds, now=100.0)
        self.tr.update(
            [session(uid='A', tty='/dev/ttys001', text=waiting),
             session(uid='B', tty='/dev/ttys002', text=waiting)],
            kinds, now=105.0)
        self.assertEqual(self.tr.waiting_uids(), ['A', 'B'])

    def test_non_agent_active_quiet(self):  # parity: P-13
        self.tr.update([session(text='shell output', proc=True)], {}, now=100.0)
        self.assertEqual(self.tr.state('U1')[0], H.ACTIVE)
        # quiet after no changes for >5s and not processing
        self.tr.update([session(text='shell output')], {}, now=110.0)
        self.tr.update([session(text='shell output')], {}, now=112.0)
        ev = self.tr.update([session(text='shell output')], {}, now=114.0)
        self.assertEqual(self.tr.state('U1')[0], H.QUIET)
        self.assertEqual(ev, [])

    def test_disappeared_sessions_pruned(self):  # parity: P-16
        self.tr.update([session(text='x')], {}, now=100.0)
        self.tr.update([], {}, now=102.0)
        self.assertEqual(self.tr.state('U1'), (None, 0.0, ''))

    def test_last_change_tracks_text_changes(self):  # parity: P-14
        self.tr.update([session(text='a')], {}, now=100.0)
        self.tr.update([session(text='a')], {}, now=105.0)
        self.assertEqual(self.tr.last_change('U1'), 100.0)
        self.tr.update([session(text='b')], {}, now=110.0)
        self.assertEqual(self.tr.last_change('U1'), 110.0)


if __name__ == '__main__':
    unittest.main()
