"""Adapted from ultrawatch tests/test_notifier.py for the new pure
check_quota()/mark_notified() API (P-68) — see notifier.py's module
docstring for why the osascript dialog itself isn't ported (P-69, WP2).
"""
import json
import os
import tempfile
import unittest
from unittest import mock

from everwatch.engine import notifier


class TestQuotaNotifier(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.config_path = os.path.join(self.tmp.name, 'config.json')
        self.flag_path = os.path.join(self.tmp.name, '.last-email-sent')
        patcher = mock.patch.multiple(
            notifier, CONFIG_PATH=self.config_path, FLAG_PATH=self.flag_path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write_config(self, **overrides):
        cfg = {'enabled': False, 'threshold_percent': 90,
               'email': {'to': 'manager@example.com', 'subject': 'Subject',
                         'body': 'Body'}}
        cfg.update(overrides)
        with open(self.config_path, 'w') as f:
            json.dump(cfg, f)

    def test_missing_config_does_nothing(self):  # parity: P-68
        self.assertIsNone(notifier.check_quota(100))

    def test_missing_enabled_key_does_nothing(self):  # parity: P-68
        self.write_config()
        with open(self.config_path) as f:
            cfg = json.load(f)
        del cfg['enabled']
        with open(self.config_path, 'w') as f:
            json.dump(cfg, f)
        self.assertIsNone(notifier.check_quota(100))

    def test_explicitly_disabled_does_nothing(self):  # parity: P-68
        self.write_config(enabled=False)
        self.assertIsNone(notifier.check_quota(100))

    def test_enabled_at_default_threshold_fires(self):  # parity: P-68
        self.write_config(enabled=True)
        cfg = notifier.check_quota(90)
        self.assertIsNotNone(cfg)
        self.assertEqual(cfg['email']['to'], 'manager@example.com')

    def test_below_default_threshold_does_nothing(self):  # parity: P-68
        self.write_config(enabled=True)
        self.assertIsNone(notifier.check_quota(89))

    def test_custom_threshold_respected(self):  # parity: P-68
        self.write_config(enabled=True, threshold_percent=50)
        self.assertIsNotNone(notifier.check_quota(55))
        self.assertIsNone(notifier.check_quota(45))

    def test_at_most_once_per_month(self):  # parity: P-68
        self.write_config(enabled=True)
        self.assertIsNotNone(notifier.check_quota(95, now=1000.0))
        notifier.mark_notified(now=1000.0)
        self.assertIsNone(notifier.check_quota(95, now=1000.0))

    def test_new_month_fires_again(self):  # parity: P-68
        self.write_config(enabled=True)
        notifier.mark_notified(now=1000.0)  # 1970-01-01
        self.assertIsNotNone(
            notifier.check_quota(95, now=1000.0 + 40 * 86400))

    def test_corrupt_config_does_nothing(self):  # parity: P-68
        with open(self.config_path, 'w') as f:
            f.write('{not json')
        self.assertIsNone(notifier.check_quota(100))

    def test_flag_file_missing_is_not_yet_notified(self):  # parity: P-68
        self.assertFalse(notifier.already_notified())


if __name__ == '__main__':
    unittest.main()
