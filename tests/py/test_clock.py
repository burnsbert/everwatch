"""Injected clocks (docs/DESIGN.md §3.3)."""
import unittest
import unittest.mock

from everwatch import clock


class TestClocks(unittest.TestCase):
    def test_system_clock_tracks_time_time(self):
        with unittest.mock.patch('everwatch.clock.time.time',
                                 return_value=123.5):
            self.assertEqual(clock.SystemClock().now(), 123.5)

    def test_fixed_clock_never_moves(self):
        c = clock.FixedClock(10)
        self.assertEqual(c.now(), 10.0)
        self.assertEqual(c.now(), 10.0)

    def test_virtual_clock_moves_only_when_told(self):
        c = clock.VirtualClock(5)
        self.assertEqual(c.advance(2.5), 7.5)
        c.set(100)
        self.assertEqual(c.now(), 100.0)

    def test_offset_clock_runs_from_its_start(self):
        ticks = iter([50.0, 53.25])
        c = clock.OffsetClock(1000, monotonic=lambda: next(ticks))
        self.assertEqual(c.now(), 1003.25)


class TestParse(unittest.TestCase):
    def test_iso_with_offset_and_z(self):
        self.assertEqual(clock.parse_iso_epoch('2026-09-25T15:00:00-04:00'),
                         clock.parse_iso_epoch('2026-09-25T19:00:00Z'))

    def test_naive_iso_is_utc(self):
        self.assertEqual(clock.parse_iso_epoch('1970-01-01T00:01:00'), 60.0)

    def test_fallback_parser_for_fractional_offsets(self):
        with unittest.mock.patch('everwatch.clock.datetime') as dt:
            dt.fromisoformat.side_effect = ValueError('old python')
            got = clock.parse_iso_epoch('1970-01-01T00:00:10.500+00:00')
        self.assertEqual(got, 10.5)

    def test_parse_clock_specs(self):
        self.assertIsInstance(clock.parse_clock(''), clock.SystemClock)
        self.assertIsInstance(clock.parse_clock('system'), clock.SystemClock)
        fixed = clock.parse_clock('fixed:2026-09-25T15:00:00-04:00')
        self.assertIsInstance(fixed, clock.FixedClock)
        self.assertEqual(fixed.now(), 1790362800.0)
        self.assertIsInstance(clock.parse_clock('start:1970-01-01T00:00:00Z'),
                              clock.OffsetClock)
        self.assertIsInstance(
            clock.parse_clock('virtual:1970-01-01T00:00:00Z'),
            clock.VirtualClock)

    def test_bad_specs_raise(self):
        for spec in ('fixed', 'fixed:', 'warp:2026-01-01T00:00:00Z',
                     'fixed:not-a-date'):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                clock.parse_clock(spec)


if __name__ == '__main__':
    unittest.main()
