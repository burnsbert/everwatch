"""Real-I/O guard for tests/py (docs/DESIGN.md §5.2, hard rules #1-2).

Importing this package (unittest discover imports every package's
`__init__.py` as part of discovery) does two things for the whole test
run:

1. Inserts the repo root onto sys.path so `import everwatch...` works
   regardless of the current working directory or which Python invoked
   `unittest discover` (this lets `tests/py/test_*.py` avoid the
   `sys.path.insert(dirname(dirname(...)))` boilerplate the ultrawatch
   tests needed).
2. Patches every real I/O entry point a test could accidentally reach —
   `subprocess.run`, `subprocess.Popen`, `os.system`,
   `urllib.request.urlopen`, and non-loopback `socket.create_connection`
   — to raise `RealIOForbidden` instead of doing the real thing. A test
   that needs one of these must mock it explicitly (e.g.
   `@mock.patch('everwatch.engine.iterm.subprocess.run')`); that test's
   own `mock.patch` stacks on top of this module-level patch and is
   restored to it afterward, same as any other nested `mock.patch`.

This is what keeps every test headless per the hard rules: no test can
reach real iTerm2 (osascript), the keychain (`security`), the network
(Claude/Codex usage APIs), or shell out to a sound-playing command,
even by accident.
"""
import os
import socket
import subprocess
import sys
import urllib.request
from unittest import mock

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)


class RealIOForbidden(RuntimeError):
    """Raised when a test reaches real subprocess/network I/O unmocked."""


def _forbid(name):
    def _blocked(*args, **kwargs):
        raise RealIOForbidden(
            f'{name} was called without a mock in a test. Tests must '
            'never touch real iTerm2, the keychain, sound, or the '
            'network -- mock this call explicitly.')
    return _blocked


_real_create_connection = socket.create_connection


def _guarded_create_connection(address, *args, **kwargs):
    host = address[0] if isinstance(address, tuple) else address
    if host in ('127.0.0.1', 'localhost', '::1'):
        return _real_create_connection(address, *args, **kwargs)
    raise RealIOForbidden(
        'socket.create_connection to a non-loopback host was called '
        'without a mock in a test.')


_GUARD_PATCHES = (
    mock.patch('subprocess.run', new=_forbid('subprocess.run')),
    mock.patch('subprocess.Popen', new=_forbid('subprocess.Popen')),
    mock.patch('os.system', new=_forbid('os.system')),
    mock.patch('urllib.request.urlopen', new=_forbid('urllib.request.urlopen')),
    mock.patch('socket.create_connection', new=_guarded_create_connection),
)

for _patch in _GUARD_PATCHES:
    _patch.start()
