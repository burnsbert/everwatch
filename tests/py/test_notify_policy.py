"""notify_policy.py: W-1 notification policy (P-66 policy) and the quota
gate / Gmail draft (P-68, P-69 logic)."""
import json
import os
import tempfile
import unittest
import urllib.parse
from unittest import mock

from everwatch import notify_policy as NP
from everwatch.engine import notifier


def tr(uid, to='waiting', title=None):
    return {'uid': uid, 'to': to, 'title': title or uid, 'body': 'b'}


class TestNotifyPolicy(unittest.TestCase):
    def test_transition_to_waiting_notifies(self):  # parity: W-1, P-66
        p = NP.NotifyPolicy()
        out = p.decide([tr('A', title='api-gateway')], 100.0)
        self.assertEqual(out, [{'id': 'n1', 'uid': 'A',
                                'title': '◉ api-gateway is waiting for your '
                                         'input', 'body': 'b'}])

    def test_other_transitions_and_disabled_pref_do_not(
            self):  # parity: W-1, P-66
        p = NP.NotifyPolicy()
        self.assertEqual(p.decide([tr('A', to='busy'), tr('B', to='idle')],
                                  1.0), [])
        self.assertEqual(p.decide([tr('A')], 1.0, enabled=False), [])

    def test_cooldown_per_session(self):  # parity: W-1
        p = NP.NotifyPolicy()
        self.assertEqual(len(p.decide([tr('A')], 100.0)), 1)
        self.assertEqual(p.decide([tr('A')], 129.0), [])
        self.assertEqual(len(p.decide([tr('B')], 129.0)), 1)
        self.assertEqual(len(p.decide([tr('A')], 131.0)), 1)

    def test_three_in_one_batch_coalesce(self):  # parity: W-1
        p = NP.NotifyPolicy()
        out = p.decide([tr('A', title='a'), tr('B', title='b'),
                        tr('C', title='c'), tr('D', title='d')], 10.0)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['title'],
                         '◉ 4 sessions are waiting for your input')
        self.assertEqual(out[0]['body'], 'a, b, c +1 more')
        self.assertEqual(out[0]['uid'], 'A')

    def test_coalesce_across_batches_within_two_seconds(self):  # parity: W-1
        p = NP.NotifyPolicy()
        self.assertEqual(len(p.decide([tr('A')], 10.0)), 1)
        self.assertEqual(len(p.decide([tr('B')], 11.0)), 1)
        out = p.decide([tr('C')], 11.5)
        self.assertEqual(len(out), 1)
        self.assertIn('1 sessions', out[0]['title'])
        # folded silently while the summary window is open
        self.assertEqual(p.decide([tr('D')], 12.0), [])
        # after the window, individual notifications resume
        self.assertEqual(len(p.decide([tr('E')], 14.0)), 1)

    def test_old_notifications_leave_the_window(self):  # parity: W-1
        p = NP.NotifyPolicy()
        p.decide([tr('A')], 10.0)
        p.decide([tr('B')], 11.0)
        out = p.decide([tr('C')], 13.5)
        self.assertEqual(out[0]['title'], '◉ C is waiting for your input')

    def test_forget_vanished_sessions(self):  # parity: W-1
        p = NP.NotifyPolicy()
        p.decide([tr('A')], 10.0)
        p.forget(set())
        self.assertEqual(len(p.decide([tr('A')], 15.0)), 1)


class TestQuota(unittest.TestCase):
    CFG = {'enabled': True, 'threshold_percent': 80,
           'email': {'to': 'boss@example.com', 'subject': 'Quota & more',
                     'body': 'Line 1\nLine 2'}}

    def test_gmail_url_matches_ultrawatch_format(self):  # parity: P-69
        url = NP.gmail_draft_url(self.CFG)
        self.assertTrue(url.startswith('https://mail.google.com/mail/?'))
        q = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        self.assertEqual(q, {'view': ['cm'], 'to': ['boss@example.com'],
                             'su': ['Quota & more'],
                             'body': ['Line 1\nLine 2']})
        self.assertNotIn('+', url)  # quote, not quote_plus

    def test_gmail_url_needs_an_address(self):  # parity: P-69
        self.assertIsNone(NP.gmail_draft_url({'email': {}}))
        self.assertIsNone(NP.gmail_draft_url(None))

    def test_memory_gate_rules(self):  # parity: P-68, P-69
        gate = NP.MemoryQuotaGate(self.CFG)
        now = 1_790_000_000.0
        self.assertIsNone(gate.check(79, now))
        self.assertEqual(gate.check(80, now), self.CFG)
        gate.mark(now)
        self.assertIsNone(gate.check(95, now))
        self.assertEqual(gate.check(95, now + 40 * 86400), self.CFG)
        self.assertIsNone(NP.MemoryQuotaGate(None).check(100, now))
        self.assertEqual(gate.month(now), '2026-09')

    def test_real_gate_uses_notifier_files(self):  # parity: P-68, P-69
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        cfg_path = os.path.join(tmp.name, 'config.json')
        flag = os.path.join(tmp.name, '.last-email-sent')
        with open(cfg_path, 'w') as f:
            json.dump(self.CFG, f)
        now = 1_790_000_000.0
        with mock.patch.multiple(notifier, CONFIG_PATH=cfg_path,
                                 FLAG_PATH=flag):
            gate = NP.QuotaGate()
            self.assertEqual(gate.check(90, now)['threshold_percent'], 80)
            gate.mark(now)
            self.assertIsNone(gate.check(90, now))
            self.assertEqual(gate.month(now), '2026-09')
        with open(flag) as f:
            self.assertEqual(f.read(), '2026-09')


if __name__ == '__main__':
    unittest.main()
