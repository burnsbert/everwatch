"""logs.py: backend.log with 1 MB x 3 rotation (P-72)."""
import logging
import os
import sys
import tempfile
import unittest

from everwatch import logs


class TestLogs(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def test_log_dir_precedence(self):  # parity: P-72
        self.assertEqual(logs.log_dir({'EVERWATCH_LOG_DIR': '/l',
                                       'EVERWATCH_HOME': '/h'}), '/l')
        self.assertEqual(logs.log_dir({'EVERWATCH_HOME': '/h'}, home='/U'),
                         '/h/logs')
        self.assertEqual(logs.log_dir({}, home='/Users/x'),
                         '/Users/x/Library/Logs/Everwatch')
        # the shell always sets EVERWATCH_HOME; the default one still
        # logs to ~/Library/Logs/Everwatch
        self.assertEqual(logs.log_dir(
            {'EVERWATCH_HOME': '/Users/x/Library/Application Support/'
                               'Everwatch/'}, home='/Users/x'),
            '/Users/x/Library/Logs/Everwatch')

    def test_default_dir_under_test_home(self):  # parity: P-72
        if os.environ.get('EVERWATCH_HOME'):
            self.assertTrue(logs.log_dir().startswith(
                os.environ['EVERWATCH_HOME']))

    def test_rotating_handler_and_stdio_redirect(self):  # parity: P-72
        saved = sys.stdout, sys.stderr
        logger, handler = logs.setup(self.dir, redirect_stdio=True)
        try:
            self.assertEqual(handler.maxBytes, 1024 * 1024)
            self.assertEqual(handler.backupCount, 3)
            logger.info('engine started')
            print('stray library output')
            sys.stderr.write('partial ')
            sys.stderr.write('warning line\n')
            sys.stderr.write('no newline yet')
            sys.stderr.flush()
            sys.stderr.write('\n')
            self.assertFalse(sys.stdout.isatty())
        finally:
            sys.stdout, sys.stderr = saved
            logs.teardown(handler)
        with open(os.path.join(self.dir, 'backend.log')) as f:
            text = f.read()
        self.assertIn('INFO everwatch: engine started', text)
        self.assertIn('everwatch.stdout: stray library output', text)
        self.assertIn('WARNING everwatch.stderr: partial warning line', text)
        self.assertIn('no newline yet', text)
        self.assertNotIn(handler, logging.getLogger('everwatch').handlers)

    def test_setup_without_redirect_leaves_stdio(self):  # parity: P-72
        saved = sys.stdout
        _logger, handler = logs.setup(os.path.join(self.dir, 'new'))
        try:
            self.assertIs(sys.stdout, saved)
        finally:
            logs.teardown(handler)


if __name__ == '__main__':
    unittest.main()
