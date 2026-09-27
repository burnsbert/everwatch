"""Ported from ultrawatch tests/test_itermcolor.py (P-60)."""
import sys
import unittest
import unittest.mock

from everwatch.engine import itermcolor


class TestClassifyRgb(unittest.TestCase):
    def test_exact_presets(self):  # parity: P-60
        self.assertEqual(itermcolor.classify_rgb(251, 107, 98), 'red')
        self.assertEqual(itermcolor.classify_rgb(246, 172, 71), 'orange')
        self.assertEqual(itermcolor.classify_rgb(240, 220, 79), 'yellow')
        self.assertEqual(itermcolor.classify_rgb(181, 215, 73), 'green')
        self.assertEqual(itermcolor.classify_rgb(95, 163, 248), 'blue')
        self.assertEqual(itermcolor.classify_rgb(193, 142, 217), 'purple')
        self.assertEqual(itermcolor.classify_rgb(120, 120, 120), 'gray')

    def test_near_miss_snaps_to_nearest(self):  # parity: P-60
        # a couple of counts off pure red still reads as red
        self.assertEqual(itermcolor.classify_rgb(248, 110, 100), 'red')

    def test_pure_black_is_nearest_to_gray(self):  # parity: P-60
        self.assertEqual(itermcolor.classify_rgb(0, 0, 0), 'gray')


class TestUidFromSessionId(unittest.TestCase):
    def test_strips_window_tab_pane_prefix(self):  # parity: P-60
        sid = 'w0t2p0:2EAAC309-9A33-4F6B-A579-E813C968DCF2'
        self.assertEqual(itermcolor.uid_from_session_id(sid),
                         '2EAAC309-9A33-4F6B-A579-E813C968DCF2')

    def test_bare_guid_passthrough(self):  # parity: P-60
        sid = '2EAAC309-9A33-4F6B-A579-E813C968DCF2'
        self.assertEqual(itermcolor.uid_from_session_id(sid), sid)


class TestFetchColorsUnavailable(unittest.TestCase):
    def test_missing_package_raises_color_api_unavailable(self):  # parity: P-60
        # `iterm2` is an optional dependency this project never requires;
        # force the ImportError path regardless of whether it happens to
        # be installed in whatever environment runs this test.
        with unittest.mock.patch.dict(sys.modules, {'iterm2': None}):
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                itermcolor.fetch_colors()


class TestNameToRgb(unittest.TestCase):
    def test_has_all_seven_presets(self):  # parity: P-60
        self.assertEqual(set(itermcolor.NAME_TO_RGB),
                         {'red', 'orange', 'yellow', 'green', 'blue',
                          'purple', 'gray'})
        self.assertEqual(itermcolor.NAME_TO_RGB['red'], (251, 107, 98))


class TestSetSessionColorUnavailable(unittest.TestCase):
    def test_missing_package_raises_color_api_unavailable(self):  # parity: P-60
        with unittest.mock.patch.dict(sys.modules, {'iterm2': None}):
            with self.assertRaises(itermcolor.ColorApiUnavailable):
                itermcolor.set_session_color('UID-1', 'red')


if __name__ == '__main__':
    unittest.main()
