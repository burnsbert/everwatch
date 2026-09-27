"""Ported from ultrawatch tests/test_usage_rows.py (Codex half) plus new
tests for get_codex_oauth_token()/fetch_codex_usage() (P-52), which the
original suite didn't cover directly. All subprocess/network calls are
mocked or scoped to a temp HOME; the real-I/O guard (tests/py/__init__.py)
would otherwise raise on the network calls.
"""
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock

from everwatch.engine import config, usage_codex

NOW_UTC = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)


def codex_payload(primary=True, secondary=True, **overrides):
    rate_limit = {}
    if primary:
        rate_limit['primary_window'] = {
            'used_percent': overrides.get('primary_pct', 42.0),
            'reset_at': int(NOW_UTC.timestamp()) + 3600,
            'limit_window_seconds': 18000,
        }
    if secondary:
        rate_limit['secondary_window'] = {
            'used_percent': overrides.get('secondary_pct', 12.0),
            'reset_at': int(NOW_UTC.timestamp()) + 3 * 86400,
            'limit_window_seconds': 604800,
        }
    return {'rate_limit': rate_limit}


class TestGetCodexOauthToken(unittest.TestCase):
    def test_reads_token_from_auth_json(self):  # parity: P-52
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, '.codex'))
            with open(os.path.join(home, '.codex', 'auth.json'), 'w') as f:
                json.dump({'tokens': {'access_token': 'tok-xyz'}}, f)
            with mock.patch.object(config, 'HOME', home):
                self.assertEqual(usage_codex.get_codex_oauth_token(),
                                 'tok-xyz')

    def test_missing_file_returns_none(self):  # parity: P-52
        with tempfile.TemporaryDirectory() as home:
            with mock.patch.object(config, 'HOME', home):
                self.assertIsNone(usage_codex.get_codex_oauth_token())

    def test_malformed_json_returns_none(self):  # parity: P-52
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, '.codex'))
            with open(os.path.join(home, '.codex', 'auth.json'), 'w') as f:
                f.write('{not json')
            with mock.patch.object(config, 'HOME', home):
                self.assertIsNone(usage_codex.get_codex_oauth_token())


class TestFetchCodexUsage(unittest.TestCase):
    @mock.patch.object(usage_codex, 'get_codex_oauth_token', return_value=None)
    def test_no_token_short_circuits(self, _token):  # parity: P-52
        self.assertEqual(usage_codex.fetch_codex_usage(), (None, None))

    @mock.patch.object(usage_codex, 'session_rate_limit_windows', return_value={})
    @mock.patch('everwatch.engine.usage_codex.urllib.request.urlopen')
    @mock.patch.object(usage_codex, 'get_codex_oauth_token', return_value='tok')
    def test_success_merges_session_windows(self, _token, urlopen, _sessions):  # parity: P-52
        resp = mock.MagicMock()
        resp.read.return_value = json.dumps(codex_payload()).encode()
        resp.__enter__.return_value = resp
        urlopen.return_value = resp
        data, retry = usage_codex.fetch_codex_usage()
        self.assertIsNone(retry)
        self.assertEqual(data['rate_limit']['primary_window']['used_percent'],
                         42.0)
        req = urlopen.call_args[0][0]
        self.assertEqual(req.full_url,
                         'https://chatgpt.com/backend-api/wham/usage')

    @mock.patch('everwatch.engine.usage_codex.urllib.request.urlopen')
    @mock.patch.object(usage_codex, 'get_codex_oauth_token', return_value='tok')
    def test_generic_exception_returns_none(self, _token, urlopen):  # parity: P-52
        urlopen.side_effect = OSError('down')
        self.assertEqual(usage_codex.fetch_codex_usage(), (None, None))


class TestMergeSessionRateLimits(unittest.TestCase):
    def test_session_window_fills_missing_api_window(self):  # parity: P-52
        usage = codex_payload(primary=False)
        five_hour = {
            18000: {'used_percent': 7.0,
                    'reset_at': int(NOW_UTC.timestamp()) + 3600,
                    'limit_window_seconds': 18000},
        }
        merged = usage_codex.merge_session_rate_limits(usage, five_hour)
        rows = usage_codex.codex_usage_rows(merged, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows],
                         ['CX 5h Limit', 'CX 7d Limit'])
        self.assertEqual([r['pct'] for r in rows], [7.0, 12.0])

    def test_missing_session_window_is_hidden(self):  # parity: P-52
        usage = codex_payload(primary=False)
        merged = usage_codex.merge_session_rate_limits(usage, {})
        rows = usage_codex.codex_usage_rows(merged, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_none_usage_passthrough(self):
        self.assertIsNone(usage_codex.merge_session_rate_limits(None, {}))


class TestSessionRateLimitWindows(unittest.TestCase):
    def test_reads_both_windows_across_recent_session_logs(self):  # parity: P-52
        now = NOW_UTC.timestamp()
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            weekly = os.path.join(day, 'weekly.jsonl')
            both = os.path.join(day, 'both.jsonl')
            payloads = [
                (weekly, {'primary': {'used_percent': 12,
                                      'window_minutes': 10080,
                                      'resets_at': now + 86400},
                          'secondary': None}),
                (both, {'primary': {'used_percent': 7,
                                    'window_minutes': 300,
                                    'resets_at': now + 3600},
                        'secondary': {'used_percent': 11,
                                      'window_minutes': 10080,
                                      'resets_at': now + 86400}}),
            ]
            for index, (path, limits) in enumerate(payloads):
                with open(path, 'w') as f:
                    f.write(json.dumps({'payload': {
                        'rate_limits': limits}}) + '\n')
                os.utime(path, (now - index, now - index))
            windows = usage_codex.session_rate_limit_windows(root, now=now)
        self.assertEqual(windows[18000]['used_percent'], 7)
        self.assertEqual(windows[604800]['used_percent'], 12)

    def test_missing_root_returns_empty(self):  # parity: P-52
        with tempfile.TemporaryDirectory() as root:
            missing = os.path.join(root, 'does-not-exist')
            self.assertEqual(
                usage_codex.session_rate_limit_windows(missing, now=0.0), {})

    def test_stale_session_log_is_skipped(self):  # parity: P-52
        now = NOW_UTC.timestamp()
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            stale = os.path.join(day, 'stale.jsonl')
            with open(stale, 'w') as f:
                f.write(json.dumps({'payload': {'rate_limits': {
                    'primary': {'used_percent': 99, 'window_minutes': 300,
                               'resets_at': now + 3600}}}}) + '\n')
            two_days_ago = now - usage_codex.SESSION_LOG_MAX_AGE - 3600
            os.utime(stale, (two_days_ago, two_days_ago))
            windows = usage_codex.session_rate_limit_windows(root, now=now)
        self.assertEqual(windows, {})

    def test_expired_reset_at_window_is_excluded(self):  # parity: P-52
        now = NOW_UTC.timestamp()
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            path = os.path.join(day, 'expired.jsonl')
            with open(path, 'w') as f:
                f.write(json.dumps({'payload': {'rate_limits': {
                    'primary': {'used_percent': 99, 'window_minutes': 300,
                               'resets_at': now - 60}}}}) + '\n')
            windows = usage_codex.session_rate_limit_windows(root, now=now)
        self.assertEqual(windows, {})

    def test_line_without_rate_limits_is_ignored(self):  # parity: P-52
        with tempfile.TemporaryDirectory() as root:
            day = os.path.join(root, '2026', '06', '09')
            os.makedirs(day)
            path = os.path.join(day, 'norates.jsonl')
            with open(path, 'w') as f:
                f.write(json.dumps({'payload': {'other': 'stuff'}}) + '\n')
            self.assertIsNone(usage_codex._last_log_rate_limits(path))

    def test_unreadable_log_file_returns_none(self):  # parity: P-52
        self.assertIsNone(
            usage_codex._last_log_rate_limits('/no/such/file.jsonl'))


class TestCodexUsageRows(unittest.TestCase):
    def test_both_windows(self):  # parity: P-52
        rows = usage_codex.codex_usage_rows(codex_payload(), now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows],
                         ['CX 5h Limit', 'CX 7d Limit'])
        self.assertEqual(rows[0]['pct'], 42.0)
        self.assertTrue(rows[0]['reset'].startswith('1h 0m ('))
        self.assertTrue(rows[1]['reset'].startswith('3d 0h ('))
        self.assertFalse(rows[0]['hit'])
        self.assertFalse(rows[1]['hit'])

    def test_missing_secondary_window(self):  # parity: P-52
        rows = usage_codex.codex_usage_rows(codex_payload(secondary=False),
                                            now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 5h Limit'])

    def test_primary_weekly_window_is_labeled_by_duration(self):  # parity: P-52
        usage = codex_payload(secondary=False)
        usage['rate_limit']['primary_window']['limit_window_seconds'] = 604800
        rows = usage_codex.codex_usage_rows(usage, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_none_used_percent_skipped(self):  # parity: P-52
        rows = usage_codex.codex_usage_rows(
            codex_payload(primary_pct=None), now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 7d Limit'])

    def test_hit_flag_at_100(self):  # parity: P-52
        rows = usage_codex.codex_usage_rows(
            codex_payload(primary_pct=100.0), now=NOW_UTC)
        self.assertTrue(rows[0]['hit'])
        self.assertEqual(rows[0]['projection'],
                         ('  ⚠ Codex 5h limit hit', True))

    def test_none_usage(self):  # parity: P-52
        self.assertEqual(usage_codex.codex_usage_rows(None, now=NOW_UTC), [])

    def test_missing_rate_limit(self):  # parity: P-52
        self.assertEqual(usage_codex.codex_usage_rows({}, now=NOW_UTC), [])

    def test_unrecognized_window_seconds_keeps_fallback_label(self):  # parity: P-52
        usage = codex_payload(secondary=False)
        usage['rate_limit']['primary_window']['limit_window_seconds'] = 999
        rows = usage_codex.codex_usage_rows(usage, now=NOW_UTC)
        self.assertEqual([r['label'] for r in rows], ['CX 5h Limit'])


if __name__ == '__main__':
    unittest.main()
