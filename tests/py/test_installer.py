"""installer.py: the tab-color venv installer, exercised entirely
through a fake `runner` so no test ever spawns a real `venv`/`pip`
process (docs/DESIGN.md hard rule #2, §7 WP7 row)."""
import unittest
from unittest import mock

from everwatch import installer as I


class FakeRunner:
    """Scriptable stand-in for `(argv, timeout=None) -> (rc, out, err)`.
    `plan` is a list of (rc, out, err) tuples, one per call, or an
    Exception instance/class to raise instead."""

    def __init__(self, plan):
        self.plan = list(plan)
        self.calls = []

    def __call__(self, argv, timeout=None):
        self.calls.append((argv, timeout))
        step = self.plan.pop(0)
        if isinstance(step, type) and issubclass(step, BaseException):
            raise step()
        if isinstance(step, BaseException):
            raise step
        return step


class TestVenvPython(unittest.TestCase):
    def test_path_under_bin(self):
        self.assertEqual(I.venv_python('/x/venv'), '/x/venv/bin/python3')


class TestColorsInstaller(unittest.TestCase):
    def test_success_yields_installing_then_restart_required(self):
        runner = FakeRunner([(0, '', ''), (0, '', '')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        statuses = [s for s, _ in steps]
        self.assertEqual(statuses, ['installing', 'installing',
                                    'restart_required'])
        self.assertEqual(len(runner.calls), 2)
        self.assertEqual(runner.calls[0][0][-1], '/x/venv')
        self.assertIn('iterm2', runner.calls[1][0])
        self.assertIn('/x/venv/bin/python3', runner.calls[1][0])

    def test_venv_creation_failure_stops_before_pip(self):
        runner = FakeRunner([(1, '', 'permission denied')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertEqual([s for s, _ in steps], ['installing', 'error'])
        self.assertIn('permission denied', steps[-1][1])
        self.assertEqual(len(runner.calls), 1)  # pip never ran

    def test_pip_failure_reports_no_network(self):
        runner = FakeRunner([(0, '', ''),
                             (1, '', 'Temporary failure in name resolution')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertEqual(steps[-1][0], 'error')
        self.assertIn('pip install failed', steps[-1][1])

    def test_pip_failure_with_no_output_still_reports_something(self):
        runner = FakeRunner([(0, '', ''), (7, '', '')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertEqual(steps[-1][0], 'error')
        self.assertIn('7', steps[-1][1])

    def test_venv_runner_exception_is_caught(self):
        runner = FakeRunner([TimeoutError('timed out')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertEqual([s for s, _ in steps], ['installing', 'error'])
        self.assertIn('timed out', steps[-1][1])

    def test_pip_runner_exception_is_caught(self):
        runner = FakeRunner([(0, '', ''), OSError('no pip')])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertEqual(steps[-1][0], 'error')
        self.assertIn('no pip', steps[-1][1])

    def test_long_stderr_is_truncated_to_last_lines(self):
        stderr = '\n'.join(f'line {i}' for i in range(20))
        runner = FakeRunner([(1, '', stderr)])
        steps = list(I.ColorsInstaller(runner=runner).install('/x/venv'))
        self.assertNotIn('line 0', steps[-1][1])
        self.assertIn('line 19', steps[-1][1])

    def test_default_runner_and_python_exe(self):
        installer = I.ColorsInstaller()
        self.assertIs(installer.runner, I.default_runner)
        self.assertTrue(installer.python_exe)

    def test_default_runner_wraps_subprocess_run(self):
        fake_result = mock.Mock(returncode=0, stdout='ok', stderr='')
        with mock.patch('subprocess.run', return_value=fake_result) as run:
            rc, out, err = I.default_runner(['echo', 'hi'], timeout=5)
        run.assert_called_once_with(['echo', 'hi'], capture_output=True,
                                    text=True, timeout=5)
        self.assertEqual((rc, out, err), (0, 'ok', ''))


if __name__ == '__main__':
    unittest.main()
