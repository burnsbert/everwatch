import os
import unittest
from unittest import mock

from everwatch.engine import config


class TestTimingConstants(unittest.TestCase):
    def test_polling_cadences(self):  # parity: P-75
        self.assertEqual(config.SNAPSHOT_INTERVAL, 2)
        self.assertEqual(config.PATHS_INTERVAL, 10)
        self.assertEqual(config.AGENTS_INTERVAL, 5)
        self.assertEqual(config.USAGE_REFRESH_INTERVAL, 300)
        self.assertEqual(config.CODEX_USAGE_REFRESH_INTERVAL, 300)
        self.assertEqual(config.COLOR_INTERVAL, 5)

    def test_subprocess_timeouts(self):  # parity: P-75
        self.assertEqual(config.OSASCRIPT_TIMEOUT, 10)
        self.assertEqual(config.PS_TIMEOUT, 3)
        self.assertEqual(config.HTTP_TIMEOUT, 5)

    def test_ui_timing(self):  # parity: P-75
        self.assertEqual(config.TOAST_SECONDS, 3.5)
        self.assertEqual(config.FLASH_SECONDS, 1.5)
        self.assertEqual(config.FRESH_SECONDS, 30)
        self.assertEqual(config.LABEL_GC_DAYS, 14)


class TestEverwatchHome(unittest.TestCase):
    def test_env_override_wins(self):
        # The harness sets EVERWATCH_HOME for every test run (see
        # tests/py/__init__.py's use in the Makefile); config reads it
        # at import time, so the running value should match it exactly.
        self.assertEqual(config.STATE_DIR, os.environ['EVERWATCH_HOME'])
        self.assertEqual(config.STATE_PATH,
                         os.path.join(os.environ['EVERWATCH_HOME'], 'state.json'))

    def test_default_falls_back_to_application_support(self):
        env = dict(os.environ)
        env.pop('EVERWATCH_HOME', None)
        with mock.patch.dict(os.environ, env, clear=True):
            home = config._everwatch_home()
        self.assertTrue(home.endswith(
            os.path.join('Library', 'Application Support', 'Everwatch')))


class TestDebugStateEnvAlias(unittest.TestCase):
    def test_new_var_enables(self):
        with mock.patch.dict(os.environ, {'EVERWATCH_DEBUG_STATE': '1'}):
            self.assertTrue(config._debug_state_enabled())

    def test_legacy_uw_var_still_accepted(self):
        env = dict(os.environ)
        env.pop('EVERWATCH_DEBUG_STATE', None)
        env['UW_DEBUG_STATE'] = '1'
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertTrue(config._debug_state_enabled())

    def test_neither_set_disables(self):
        env = dict(os.environ)
        env.pop('EVERWATCH_DEBUG_STATE', None)
        env.pop('UW_DEBUG_STATE', None)
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertFalse(config._debug_state_enabled())


if __name__ == '__main__':
    unittest.main()
