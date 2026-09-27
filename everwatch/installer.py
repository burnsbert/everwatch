"""The tab-color venv installer (docs/DESIGN.md §4.1, §7 WP7 row).

`ColorsInstaller.install(venv_dir)` is a generator: `python3 -m venv
<venv_dir>`, then `<venv_dir>/bin/python3 -m pip install iterm2`, and
yields one `(status, detail)` progress step before and after each
subprocess call so the caller (engine_loop.Engine) can turn every step
into a `diagnostics` SSE event. `status` is one of:

    'installing'        -- still running, `detail` is progress text
    'restart_required'  -- succeeded; the running backend can't import
                            the freshly installed `iterm2` package
                            until it restarts on the venv's python
    'error'              -- failed; `detail` explains why

All subprocess work goes through an injectable `runner` --
`(argv, timeout=None) -> (returncode, stdout, stderr)` -- so tests never
spawn a real `venv`/`pip` process (docs/DESIGN.md hard rule #2). The
default runner is a thin `subprocess.run` wrapper, used only outside
tests.
"""
import os
import subprocess
import sys

PACKAGE = 'iterm2'


def default_runner(argv, timeout=None):
    result = subprocess.run(argv, capture_output=True, text=True,
                            timeout=timeout)
    return result.returncode, result.stdout, result.stderr


def venv_python(venv_dir):
    return os.path.join(venv_dir, 'bin', 'python3')


def _summarize(stderr, stdout, returncode):
    text = (stderr or '').strip() or (stdout or '').strip()
    if text:
        # Keep the last few lines: pip/venv failures are often preceded
        # by a long, unhelpful traceback of intermediate steps.
        lines = [line for line in text.splitlines() if line.strip()]
        text = '\n'.join(lines[-4:])
    return text or f'exited with status {returncode}'


class ColorsInstaller:
    def __init__(self, runner=None, python_exe=None,
                venv_timeout=60, pip_timeout=180):
        self.runner = runner or default_runner
        self.python_exe = python_exe or sys.executable
        self.venv_timeout = venv_timeout
        self.pip_timeout = pip_timeout

    def install(self, venv_dir):
        yield ('installing', 'Creating a private Python environment…')
        try:
            rc, out, err = self.runner(
                [self.python_exe, '-m', 'venv', venv_dir],
                timeout=self.venv_timeout)
        except Exception as e:
            yield ('error', f'Could not create the venv: {e}')
            return
        if rc != 0:
            yield ('error',
                  f'Could not create the venv: {_summarize(err, out, rc)}')
            return

        yield ('installing', f'Installing the {PACKAGE} package…')
        try:
            rc, out, err = self.runner(
                [venv_python(venv_dir), '-m', 'pip', 'install', '-q',
                 PACKAGE], timeout=self.pip_timeout)
        except Exception as e:
            yield ('error', f'pip install failed: {e}')
            return
        if rc != 0:
            detail = _summarize(err, out, rc)
            yield ('error', f'pip install failed: {detail}')
            return

        yield ('restart_required',
              'Installed. Restart Everwatch to enable tab colors.')
