"""Ported from ultrawatch tests/test_usage_rows.py (Claude half) plus new
tests for get_oauth_token()/fetch_usage() (P-51), which the original
suite didn't cover directly since it only tests the pure row-building
functions. All subprocess/network calls are mocked; the real-I/O guard
(tests/py/__init__.py) would otherwise raise.
"""
import json
import unittest
import urllib.error
from datetime import datetime
from unittest import mock

from everwatch.engine import usage_claude

NOW_LOCAL = datetime(2026, 6, 9, 12, 0)


def claude_payload(extra=None):
    payload = {
        'five_hour': {'utilization': 42.0,
                      'resets_at': '2026-06-09T17:00:00+00:00'},
        'seven_day': {'utilization': 10.0,
                      'resets_at': '2026-06-12T00:00:00+00:00'},
    }
    if extra is not None:
        payload['extra_usage'] = extra
    return payload


class TestGetOauthToken(unittest.TestCase):
    @mock.patch('everwatch.engine.usage_claude.subprocess.run')
    def test_reads_token_from_keychain(self, run):  # parity: P-51
        creds = {'claudeAiOauth': {'accessToken': 'tok-123'}}
        run.return_value = mock.Mock(returncode=0, stdout=json.dumps(creds))
        self.assertEqual(usage_claude.get_oauth_token(), 'tok-123')
        args, _kwargs = run.call_args
        self.assertEqual(args[0], ['security', 'find-generic-password',
                                   '-s', 'Claude Code-credentials', '-w'])

    @mock.patch('everwatch.engine.usage_claude.subprocess.run')
    def test_nonzero_exit_returns_none(self, run):  # parity: P-51
        run.return_value = mock.Mock(returncode=1, stdout='')
        self.assertIsNone(usage_claude.get_oauth_token())

    @mock.patch('everwatch.engine.usage_claude.subprocess.run')
    def test_bad_json_returns_none(self, run):  # parity: P-51
        run.return_value = mock.Mock(returncode=0, stdout='not json')
        self.assertIsNone(usage_claude.get_oauth_token())

    @mock.patch('everwatch.engine.usage_claude.subprocess.run')
    def test_exception_returns_none(self, run):  # parity: P-51
        run.side_effect = OSError('boom')
        self.assertIsNone(usage_claude.get_oauth_token())


class TestFetchUsage(unittest.TestCase):
    @mock.patch.object(usage_claude, 'get_oauth_token', return_value=None)
    def test_no_token_short_circuits(self, _token):  # parity: P-51
        self.assertEqual(usage_claude.fetch_usage(), (None, None))

    @mock.patch('everwatch.engine.usage_claude.urllib.request.urlopen')
    @mock.patch.object(usage_claude, 'get_oauth_token', return_value='tok')
    def test_success_returns_parsed_json(self, _token, urlopen):  # parity: P-51
        resp = mock.MagicMock()
        resp.read.return_value = b'{"ok": true}'
        resp.__enter__.return_value = resp
        urlopen.return_value = resp
        data, retry = usage_claude.fetch_usage()
        self.assertEqual(data, {'ok': True})
        self.assertIsNone(retry)
        req = urlopen.call_args[0][0]
        self.assertEqual(req.full_url,
                         'https://api.anthropic.com/api/oauth/usage')
        self.assertEqual(req.headers['Authorization'], 'Bearer tok')

    @mock.patch('everwatch.engine.usage_claude.urllib.request.urlopen')
    @mock.patch.object(usage_claude, 'get_oauth_token', return_value='tok')
    def test_http_error_returns_retry_after(self, _token, urlopen):  # parity: P-51
        err = urllib.error.HTTPError(
            'url', 429, 'Too Many', {'Retry-After': '30'}, None)
        urlopen.side_effect = err
        data, retry = usage_claude.fetch_usage()
        self.assertIsNone(data)
        self.assertEqual(retry, 30)

    @mock.patch('everwatch.engine.usage_claude.urllib.request.urlopen')
    @mock.patch.object(usage_claude, 'get_oauth_token', return_value='tok')
    def test_http_error_without_retry_after_returns_none(self, _token, urlopen):  # parity: P-51
        err = urllib.error.HTTPError('url', 500, 'Server Error', {}, None)
        urlopen.side_effect = err
        data, retry = usage_claude.fetch_usage()
        self.assertIsNone(data)
        self.assertIsNone(retry)

    @mock.patch('everwatch.engine.usage_claude.urllib.request.urlopen')
    @mock.patch.object(usage_claude, 'get_oauth_token', return_value='tok')
    def test_generic_exception_returns_none_none(self, _token, urlopen):  # parity: P-51
        urlopen.side_effect = TimeoutError('slow')
        self.assertEqual(usage_claude.fetch_usage(), (None, None))


class TestFormatDollarLimit(unittest.TestCase):
    def test_whole_dollars(self):
        self.assertEqual(usage_claude.format_dollar_limit(30000), '$300')

    def test_cents(self):
        self.assertEqual(usage_claude.format_dollar_limit(12345), '$123.45')

    def test_invalid(self):
        self.assertEqual(usage_claude.format_dollar_limit(None), '')
        self.assertEqual(usage_claude.format_dollar_limit('abc'), '')


class TestClaudeExtraUsageRow(unittest.TestCase):
    def test_none_usage(self):  # parity: P-51
        self.assertIsNone(usage_claude.claude_extra_usage_row(None,
                                                              now=NOW_LOCAL))

    def test_missing_extra_usage(self):  # parity: P-51
        self.assertIsNone(
            usage_claude.claude_extra_usage_row(claude_payload(),
                                                now=NOW_LOCAL))

    def test_disabled_extra_usage(self):  # parity: P-51
        usage = claude_payload({'is_enabled': False, 'used_credits': 100,
                                'monthly_limit': 30000})
        self.assertIsNone(usage_claude.claude_extra_usage_row(usage,
                                                              now=NOW_LOCAL))

    def test_pct_computed_from_used_and_limit(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 15000,
                                'monthly_limit': 30000})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['pct'], 50.0)
        self.assertEqual(row['label'], 'CC Monthly Limit')
        self.assertFalse(row['hit'])

    def test_utilization_takes_precedence(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 15000,
                                'monthly_limit': 30000, 'utilization': 51.5})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['pct'], 51.5)

    def test_dollar_detail_hidden_by_default(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 100,
                                'monthly_limit': 30000, 'utilization': 1.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertNotIn('limit $', row['detail'])
        self.assertIn('resets in 21d 12h', row['detail'])

    def test_dollar_detail_shown_when_requested(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 100,
                                'monthly_limit': 30000, 'utilization': 1.0})
        row = usage_claude.claude_extra_usage_row(usage, show_dollar_limit=True,
                                                  now=NOW_LOCAL)
        self.assertIn('limit $300', row['detail'])
        self.assertIn('resets in 21d 12h', row['detail'])

    def test_no_limit_extra_usage_label(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 500,
                                'utilization': 12.5})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertEqual(row['label'], 'CC Extra Usage ')
        self.assertEqual(row['detail'], '')
        self.assertEqual(row['pct'], 12.5)
        self.assertFalse(row['hit'])
        self.assertIsNone(row['projection'])  # no limit -> no projection

    def test_hit_and_projection(self):  # parity: P-51
        usage = claude_payload({'is_enabled': True, 'used_credits': 31500,
                                'monthly_limit': 30000, 'utilization': 105.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertTrue(row['hit'])
        self.assertEqual(row['projection'], ('  ⚠ monthly limit hit', True))

    def test_on_pace_projection(self):  # parity: P-51
        # June 9 noon: ~28% of June elapsed, 80% used -> on pace warning
        usage = claude_payload({'is_enabled': True, 'used_credits': 24000,
                                'monthly_limit': 30000, 'utilization': 80.0})
        row = usage_claude.claude_extra_usage_row(usage, now=NOW_LOCAL)
        self.assertIsNotNone(row['projection'])
        self.assertIn('on pace to hit monthly limit', row['projection'][0])


if __name__ == '__main__':
    unittest.main()
