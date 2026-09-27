"""Backend logging (docs/DESIGN.md P-72).

The backend's log output (and, once the CLI has printed its handshake
line, its stray stdout/stderr) goes to `backend.log`, rotated at
1 MB x 3, so the UI never sees library noise.

Log dir: `EVERWATCH_LOG_DIR` if set; else `$EVERWATCH_HOME/logs` when
EVERWATCH_HOME points somewhere other than the default Application
Support dir (tests and dev runs, so they never write to the real user's
Logs folder); else `~/Library/Logs/Everwatch` (the shell sets
EVERWATCH_HOME to the default dir, so real runs log there).
"""
import logging
import logging.handlers
import os
import sys

from everwatch.engine import config

LOG_NAME = 'backend.log'
MAX_BYTES = 1024 * 1024
BACKUP_COUNT = 3
LOGGER_NAME = 'everwatch'


def log_dir(environ=None, home=None):
    environ = os.environ if environ is None else environ
    if environ.get('EVERWATCH_LOG_DIR'):
        return environ['EVERWATCH_LOG_DIR']
    home = home or config.HOME
    default_home = os.path.join(home, 'Library', 'Application Support',
                                'Everwatch')
    ew_home = environ.get('EVERWATCH_HOME')
    if ew_home and os.path.normpath(ew_home) != default_home:
        return os.path.join(ew_home, 'logs')
    return os.path.join(home, 'Library', 'Logs', 'Everwatch')


class _StreamToLogger:
    """File-like object that forwards complete lines to a logger."""

    def __init__(self, logger, level):
        self.logger = logger
        self.level = level
        self._buf = ''

    def write(self, text):
        self._buf += text
        while '\n' in self._buf:
            line, self._buf = self._buf.split('\n', 1)
            if line.strip():
                self.logger.log(self.level, line)
        return len(text)

    def flush(self):
        if self._buf.strip():
            self.logger.log(self.level, self._buf)
        self._buf = ''

    def isatty(self):
        return False


def setup(directory=None, redirect_stdio=False):
    """Attach a rotating file handler to the 'everwatch' logger and return
    (logger, handler). With redirect_stdio, sys.stdout/sys.stderr are
    replaced by line-forwarding shims (call after the handshake)."""
    directory = directory or log_dir()
    os.makedirs(directory, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        os.path.join(directory, LOG_NAME), maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT, encoding='utf-8')
    handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s %(name)s: %(message)s'))
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(logging.INFO)
    logger.addHandler(handler)
    if redirect_stdio:
        sys.stdout = _StreamToLogger(logger.getChild('stdout'), logging.INFO)
        sys.stderr = _StreamToLogger(logger.getChild('stderr'),
                                     logging.WARNING)
    return logger, handler


def teardown(handler):
    logging.getLogger(LOGGER_NAME).removeHandler(handler)
    handler.close()
