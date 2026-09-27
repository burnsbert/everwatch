"""Ported from ultrawatch tests/test_projection.py. Not tagged with a
WP1 parity id: P-55 (pace projections) is WP2 scope, though this pure
math is ported now alongside usage_claude/usage_codex (P-51/P-52), which
depend on it."""
import unittest
from datetime import datetime, timedelta, timezone

from everwatch.engine import projection

NOW_UTC = datetime(2026, 6, 9, 12, 0, tzinfo=timezone.utc)
NOW_LOCAL = datetime(2026, 6, 15, 12, 0)  # mid-June: elapsed pace ~48.3%


def bucket(pct, hours_to_reset=2.5):
    """five_hour bucket: 2.5h to reset means 50% of the window elapsed."""
    resets = (NOW_UTC + timedelta(hours=hours_to_reset)).isoformat()
    return {'utilization': pct, 'resets_at': resets}


class TestLimitProjection(unittest.TestCase):
    def test_under_pace_returns_none(self):
        self.assertIsNone(
            projection.limit_projection('five_hour', bucket(30), now=NOW_UTC))

    def test_over_pace_warns(self):
        result = projection.limit_projection('five_hour', bucket(60), now=NOW_UTC)
        self.assertIsNotNone(result)
        text, is_hit = result
        self.assertIn('on pace to hit session limit', text)
        self.assertFalse(is_hit)

    def test_over_pace_carries_run_out_time(self):
        # 60% after 2.5h (9000s) -> 40% more takes 6000s at that rate
        result = projection.limit_projection('five_hour', bucket(60), now=NOW_UTC)
        self.assertEqual(result.at, NOW_UTC + timedelta(seconds=6000))
        self.assertEqual(result.at.tzinfo, timezone.utc)

    def test_hit_has_no_run_out_time(self):
        result = projection.limit_projection('five_hour', bucket(100), now=NOW_UTC)
        self.assertIsNone(result.at)

    def test_limit_hit(self):
        result = projection.limit_projection('five_hour', bucket(100), now=NOW_UTC)
        self.assertEqual(result, ('  ⚠ session limit hit', True))

    def test_weekly_short_name(self):
        resets = (NOW_UTC + timedelta(hours=84)).isoformat()  # half elapsed
        result = projection.limit_projection(
            'seven_day', {'utilization': 100, 'resets_at': resets}, now=NOW_UTC)
        self.assertEqual(result, ('  ⚠ weekly limit hit', True))

    def test_empty_bucket(self):
        self.assertIsNone(projection.limit_projection('five_hour', None,
                                                      now=NOW_UTC))
        self.assertIsNone(projection.limit_projection('five_hour', {},
                                                      now=NOW_UTC))

    def test_unknown_key(self):
        self.assertIsNone(
            projection.limit_projection('mystery', bucket(99), now=NOW_UTC))

    def test_malformed_resets_at_swallowed(self):
        malformed = {'utilization': 90, 'resets_at': 'not-a-timestamp'}
        self.assertIsNone(
            projection.limit_projection('five_hour', malformed, now=NOW_UTC))


class TestMonthlyLimitProjection(unittest.TestCase):
    def test_under_pace_returns_none(self):
        self.assertIsNone(
            projection.monthly_limit_projection(30, True, now=NOW_LOCAL))

    def test_over_pace_warns(self):
        result = projection.monthly_limit_projection(80, True, now=NOW_LOCAL)
        self.assertIsNotNone(result)
        text, is_hit = result
        self.assertIn('on pace to hit monthly limit', text)
        self.assertFalse(is_hit)

    def test_over_pace_carries_run_out_time(self):
        # 14.5 days elapsed (1252800s) at 80% -> 20% more takes 313200s
        result = projection.monthly_limit_projection(80, True, now=NOW_LOCAL)
        expected = (NOW_LOCAL + timedelta(seconds=313200)).astimezone(timezone.utc)
        self.assertEqual(result.at, expected)
        self.assertIsNone(projection.monthly_limit_projection(
            100, True, now=NOW_LOCAL).at)

    def test_limit_hit(self):
        result = projection.monthly_limit_projection(100, True, now=NOW_LOCAL)
        self.assertEqual(result, ('  ⚠ monthly limit hit', True))

    def test_no_limit_returns_none(self):
        self.assertIsNone(
            projection.monthly_limit_projection(80, False, now=NOW_LOCAL))

    def test_hit_time_after_month_end_returns_none(self):
        # Exactly on pace: projected hit lands precisely at next month start,
        # which is not strictly before it, so no warning.
        now = datetime(2026, 6, 16, 0, 0)  # 15 of 30 days elapsed = 50%
        self.assertIsNone(projection.monthly_limit_projection(50.0, True,
                                                              now=now))

    def test_malformed_now_swallowed(self):
        self.assertIsNone(
            projection.monthly_limit_projection(50, True, now=object()))


class TestCodexLimitProjection(unittest.TestCase):
    def window(self, pct):
        """5h window with 1h remaining -> 80% of the window elapsed."""
        return {
            'used_percent': pct,
            'reset_at': int(NOW_UTC.timestamp()) + 3600,
            'limit_window_seconds': 18000,
        }

    def test_under_pace_returns_none(self):
        self.assertIsNone(projection.codex_limit_projection(
            'CX 5h Limit', self.window(10), now=NOW_UTC))

    def test_over_pace_warns(self):
        result = projection.codex_limit_projection(
            'CX 5h Limit', self.window(85), now=NOW_UTC)
        self.assertIsNotNone(result)
        text, is_hit = result
        self.assertIn('on pace to hit Codex 5h limit', text)
        self.assertFalse(is_hit)

    def test_over_pace_carries_run_out_time(self):
        # 85% after 4h (14400s) -> 15% more takes ~2541s; whole seconds
        result = projection.codex_limit_projection(
            'CX 5h Limit', self.window(85), now=NOW_UTC)
        self.assertEqual(result.at, NOW_UTC + timedelta(seconds=2541))
        self.assertIsNone(projection.codex_limit_projection(
            'CX 5h Limit', self.window(100), now=NOW_UTC).at)

    def test_limit_hit(self):
        result = projection.codex_limit_projection(
            'CX 5h Limit', self.window(100), now=NOW_UTC)
        self.assertEqual(result, ('  ⚠ Codex 5h limit hit', True))

    def test_limit_reached_flag(self):
        result = projection.codex_limit_projection(
            'CX 7d Limit', self.window(50), limit_reached=True, now=NOW_UTC)
        self.assertEqual(result, ('  ⚠ Codex 7d limit hit', True))

    def test_missing_window(self):
        self.assertIsNone(projection.codex_limit_projection(
            'CX 5h Limit', None, now=NOW_UTC))

    def test_malformed_reset_at_swallowed(self):
        window = {'used_percent': 50, 'reset_at': 'not-a-timestamp',
                  'limit_window_seconds': 18000}
        self.assertIsNone(projection.codex_limit_projection(
            'CX 5h Limit', window, now=NOW_UTC))


class TestUsageBar(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(projection.usage_bar(0), '░' * 15)

    def test_full(self):
        self.assertEqual(projection.usage_bar(100), '█' * 15)

    def test_half(self):
        self.assertEqual(projection.usage_bar(50),
                         '█' * 8 + '░' * 7)

    def test_clamps_high(self):
        self.assertEqual(projection.usage_bar(150), '█' * 15)

    def test_clamps_low(self):
        self.assertEqual(projection.usage_bar(-10), '░' * 15)

    def test_custom_width(self):
        self.assertEqual(projection.usage_bar(50, width=10),
                         '█' * 5 + '░' * 5)
        self.assertEqual(len(projection.usage_bar(37, width=20)), 20)


class TestUsageLevel(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(projection.usage_level(0), 'green')
        self.assertEqual(projection.usage_level(49.9), 'green')
        self.assertEqual(projection.usage_level(50), 'yellow')
        self.assertEqual(projection.usage_level(79.9), 'yellow')
        self.assertEqual(projection.usage_level(80), 'red')
        self.assertEqual(projection.usage_level(100), 'red')


if __name__ == '__main__':
    unittest.main()
