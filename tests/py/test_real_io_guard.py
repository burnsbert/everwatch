"""Proves the real-I/O guard installed by tests/py/__init__.py actually
blocks unmocked real I/O (docs/DESIGN.md §5.2, hard rules #1-2).

Deliberate-bug check (see the WP1 receipt for the literal transcript):
a probe test that asserted the *opposite* — that an unmocked
`subprocess.run(['true'])` succeeds — was run first and failed with
`RealIOForbidden`, proving the guard is active. This file keeps the
correct assertion (the guard raises) as a permanent regression test.
"""
import os
import socket
import subprocess
import unittest
import urllib.request

from tests.py import RealIOForbidden


class TestRealIOGuardBlocksSubprocess(unittest.TestCase):
    def test_unmocked_run_raises(self):
        with self.assertRaises(RealIOForbidden):
            subprocess.run(['true'])

    def test_unmocked_popen_raises(self):
        with self.assertRaises(RealIOForbidden):
            subprocess.Popen(['true'])


class TestRealIOGuardBlocksOsSystem(unittest.TestCase):
    def test_unmocked_os_system_raises(self):
        with self.assertRaises(RealIOForbidden):
            os.system('true')


class TestRealIOGuardBlocksNetwork(unittest.TestCase):
    def test_unmocked_urlopen_raises(self):
        with self.assertRaises(RealIOForbidden):
            urllib.request.urlopen('https://example.invalid')

    def test_unmocked_non_loopback_socket_raises(self):
        with self.assertRaises(RealIOForbidden):
            socket.create_connection(('example.invalid', 80), timeout=1)


class TestExplicitMockOverridesTheGuard(unittest.TestCase):
    """A test's own mock.patch stacks on top of the guard and is
    restored to the guard afterward — the whole point of patching with
    `mock.patch(...).start()` at import time instead of monkeypatching
    the functions permanently."""

    def test_mocked_subprocess_run_is_not_blocked(self):
        from unittest import mock
        with mock.patch('subprocess.run') as run:
            run.return_value = mock.Mock(returncode=0)
            result = subprocess.run(['true'])
            self.assertEqual(result.returncode, 0)
        # guard is back in place once the patch exits
        with self.assertRaises(RealIOForbidden):
            subprocess.run(['true'])


if __name__ == '__main__':
    unittest.main()
