"""history.py: transition ring buffer + sparklines (W-5 data) and the
usage-history.jsonl store (W-6 data)."""
import json
import os
import tempfile
import unittest

from everwatch import history
from everwatch.engine import heuristics as H

T = 100_000.0


class TestTransitionLog(unittest.TestCase):
    def test_ring_buffer_keeps_two_hours(self):  # parity: W-5
        log = history.TransitionLog()
        log.add('A', H.BUSY, H.WAITING, T - 7300)
        log.add('A', H.WAITING, H.BUSY, T - 100)
        log.prune(T)
        self.assertEqual(log.transitions(),
                         [{'uid': 'A', 'from': H.WAITING, 'to': H.BUSY,
                           'at': T - 100}])

    def test_transitions_filter_by_uid_and_since(self):  # parity: W-5
        log = history.TransitionLog()
        log.add('A', H.BUSY, H.WAITING, T - 50)
        log.add('B', H.BUSY, H.IDLE, T - 40)
        log.add('A', H.WAITING, H.BUSY, T - 10)
        self.assertEqual([t['at'] for t in log.transitions(uid='A')],
                         [T - 50, T - 10])
        self.assertEqual([t['uid'] for t in log.transitions(since=T - 45)],
                         ['B', 'A'])

    def test_spark_reconstructs_states_backward(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 3600)
        log.add('A', H.BUSY, H.WAITING, T - 1500)   # 25 min ago
        log.add('A', H.WAITING, H.IDLE, T - 600)    # 10 min ago
        spark = log.spark('A', H.IDLE, T - 600, T)
        self.assertEqual(len(spark), 12)
        self.assertEqual(spark, 'bbbbbbbwwwii')

    def test_spark_marks_unobserved_time(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 900)  # seen only for the last 15 minutes
        self.assertEqual(log.spark('A', H.BUSY, T - 900, T),
                         '---------bbb')

    def test_spark_first_seen_defaults_to_state_since(self):  # parity: W-5
        log = history.TransitionLog()
        self.assertEqual(log.spark('Z', H.QUIET, T - 300, T),
                         '-----------q')

    def test_spark_tie_break_prefers_waiting(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 3600)
        log.add('A', H.BUSY, H.WAITING, T - 150)  # half of the last slot
        self.assertEqual(log.spark('A', H.WAITING, T - 150, T)[-1], 'w')

    def test_spark_unknown_state_is_blank(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 3600)
        self.assertEqual(log.spark('A', None, 0.0, T), '-' * 12)

    def test_timeline_ignores_transitions_before_window(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 7000)
        log.add('A', H.IDLE, H.BUSY, T - 5000)
        log.add('A', H.BUSY, H.WAITING, T - 60)
        segs = log.timeline('A', H.WAITING, T - 60, T - 600, T)
        self.assertEqual(segs, [(T - 600, T - 60, H.BUSY),
                                (T - 60, T, H.WAITING)])

    def test_wait_stats(self):  # parity: W-5
        log = history.TransitionLog()
        log.observe('A', T - 3600)
        log.add('A', H.BUSY, H.WAITING, T - 1000)
        log.add('A', H.WAITING, H.BUSY, T - 700)
        log.add('A', H.BUSY, H.WAITING, T - 100)
        self.assertEqual(log.wait_stats('A', H.WAITING, T - 100, T),
                         {'count': 2, 'seconds': 400})

    def test_forget_drops_first_seen(self):
        log = history.TransitionLog()
        log.observe('A', 1.0)
        log.observe('B', 2.0)
        log.forget({'B'})
        self.assertEqual(log.timeline('A', H.BUSY, 50.0, 0.0, 100.0),
                         [(50.0, 100.0, H.BUSY)])


class TestUsageHistory(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = os.path.join(tmp.name, 'sub', 'usage-history.jsonl')

    def usage(self, pct=10):
        return {'claude': {'rows': [{'id': 'cc.five_hour', 'pct': pct}]},
                'codex': {'rows': []}}

    def test_samples_every_five_minutes_and_persists(self):  # parity: W-6
        uh = history.UsageHistory(self.path, T)
        self.assertEqual(len(uh.maybe_sample(self.usage(10), T)), 1)
        self.assertEqual(uh.maybe_sample(self.usage(11), T + 60), [])
        uh.maybe_sample(self.usage(12), T + 300)
        with open(self.path) as f:
            lines = [json.loads(line) for line in f]
        self.assertEqual(lines, [{'at': T, 'id': 'cc.five_hour', 'pct': 10},
                                 {'at': T + 300, 'id': 'cc.five_hour',
                                  'pct': 12}])
        again = history.UsageHistory(self.path, T + 301)
        self.assertEqual(len(again.since(0)), 2)
        self.assertEqual(again.last_sample, T + 300)
        self.assertEqual(again.since(T + 1)[0]['pct'], 12)

    def test_nothing_to_sample(self):  # parity: W-6
        uh = history.UsageHistory(self.path, T)
        self.assertEqual(uh.maybe_sample({}, T), [])
        self.assertFalse(os.path.exists(self.path))

    def test_load_drops_old_and_corrupt_lines_and_rewrites(
            self):  # parity: W-6
        os.makedirs(os.path.dirname(self.path))
        with open(self.path, 'w') as f:
            f.write(json.dumps({'at': T - 9 * 86400, 'id': 'x', 'pct': 1})
                    + '\n')
            f.write('{broken\n')
            f.write(json.dumps({'at': 'soon', 'id': 'x', 'pct': 1}) + '\n')
            f.write(json.dumps({'at': T - 10, 'id': 'x', 'pct': 5}) + '\n')
        uh = history.UsageHistory(self.path, T)
        self.assertEqual(uh.since(), [{'at': T - 10, 'id': 'x', 'pct': 5}])
        with open(self.path) as f:
            self.assertEqual(len(f.readlines()), 1)

    def test_daily_prune_rewrites_file(self):  # parity: W-6
        uh = history.UsageHistory(self.path, T)
        uh.maybe_sample(self.usage(1), T)
        later = T + 8 * 86400 + 10
        uh.maybe_sample(self.usage(2), later)
        self.assertEqual([s['pct'] for s in uh.since()], [2])
        with open(self.path) as f:
            self.assertEqual(len(f.readlines()), 1)
        uh.prune(later)  # nothing more to drop: no rewrite needed

    def test_memory_only_when_path_is_none(self):  # parity: W-6
        uh = history.UsageHistory(None, T)
        uh.maybe_sample(self.usage(3), T, force=True)
        uh.prune(T + 9 * 86400)
        self.assertEqual(uh.since(), [])

    def test_io_errors_are_swallowed(self):  # parity: W-6
        blocker = os.path.join(os.path.dirname(os.path.dirname(self.path)),
                               'file')
        with open(blocker, 'w') as f:
            f.write('x')
        uh = history.UsageHistory(os.path.join(blocker, 'u.jsonl'), T)
        uh.maybe_sample(self.usage(3), T)       # append fails quietly
        uh.prune(T + 9 * 86400)                 # rewrite fails quietly
        self.assertEqual(uh.since(), [])


if __name__ == '__main__':
    unittest.main()
