"""Ported from ultrawatch tests/test_iterm_parse.py (P-01, P-05)."""
import os
import unittest

from everwatch.engine import iterm

FIXTURES = os.path.join(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))), 'fixtures')

US, RS = iterm.US, iterm.RS


def rec(win='104', tab='1', sess='1', uid='UID-1', tty='/dev/ttys000',
        proc='false', name='zsh', text='hello\nworld'):
    return US.join([win, tab, sess, uid, tty, proc, name, text])


class TestParseSnapshot(unittest.TestCase):
    def test_real_fixture(self):  # parity: P-01
        with open(os.path.join(FIXTURES, 'snapshot_raw.txt'),
                  encoding='utf-8') as f:
            raw = f.read()
        snap = iterm.parse_snapshot(raw, at=123.0)
        self.assertEqual(len(snap.sessions), 11)
        self.assertEqual(snap.at, 123.0)
        first = snap.sessions[0]
        self.assertEqual(first.window_id, 104)
        self.assertEqual(first.tab_index, 1)
        self.assertEqual(first.tty, '/dev/ttys000')
        # every record carries a UUID and screen text
        for s in snap.sessions:
            self.assertRegex(s.uid, r'^[0-9A-F-]{36}$')
            self.assertTrue(s.text)
            self.assertIsInstance(s.is_processing, bool)

    def test_single_record(self):  # parity: P-01
        snap = iterm.parse_snapshot(rec(proc='true'))
        self.assertEqual(len(snap.sessions), 1)
        s = snap.sessions[0]
        self.assertTrue(s.is_processing)
        self.assertEqual(s.text, 'hello\nworld')
        self.assertEqual(s.name, 'zsh')

    def test_text_may_contain_tabs_and_newlines(self):  # parity: P-01
        text = 'col1\tcol2\nrow2\t\trow2b\n'
        snap = iterm.parse_snapshot(rec(text=text))
        self.assertEqual(snap.sessions[0].text, text.rstrip('\n'))

    def test_malformed_records_dropped(self):  # parity: P-01
        raw = RS.join([rec(), 'garbage-no-separators', rec(uid='UID-2')])
        snap = iterm.parse_snapshot(raw)
        self.assertEqual([s.uid for s in snap.sessions], ['UID-1', 'UID-2'])

    def test_non_numeric_indices_dropped(self):  # parity: P-01
        raw = RS.join([rec(win='abc'), rec(uid='UID-2')])
        snap = iterm.parse_snapshot(raw)
        self.assertEqual([s.uid for s in snap.sessions], ['UID-2'])

    def test_missing_value_tty_normalized(self):  # parity: P-01
        snap = iterm.parse_snapshot(rec(tty='missing value'))
        self.assertEqual(snap.sessions[0].tty, '')

    def test_not_running_sentinel(self):  # parity: P-01
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.parse_snapshot('__NOT_RUNNING__\n')

    def test_empty_output(self):  # parity: P-01
        snap = iterm.parse_snapshot('\n')
        self.assertEqual(snap.sessions, ())


class TestParsePaths(unittest.TestCase):
    def test_basic(self):  # parity: P-05
        raw = RS.join([f'UID-1{US}/Users/x/src', f'UID-2{US}'])
        snap = iterm.parse_paths(raw, at=5.0)
        self.assertEqual(snap.paths, (('UID-1', '/Users/x/src'), ('UID-2', '')))
        self.assertEqual(snap.at, 5.0)

    def test_missing_value_normalized(self):  # parity: P-05
        snap = iterm.parse_paths(f'UID-1{US}missing value')
        self.assertEqual(snap.paths, (('UID-1', ''),))

    def test_not_running(self):  # parity: P-05
        with self.assertRaises(iterm.ItermNotRunning):
            iterm.parse_paths('__NOT_RUNNING__')

    def test_malformed_dropped(self):  # parity: P-05
        raw = RS.join(['no-sep-here', f'UID-2{US}/tmp'])
        snap = iterm.parse_paths(raw)
        self.assertEqual(snap.paths, (('UID-2', '/tmp'),))


if __name__ == '__main__':
    unittest.main()
