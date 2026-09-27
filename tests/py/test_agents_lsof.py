"""New tests for the ps/lsof cwd fallback (P-06) and the ps agent scan's
subprocess wiring, not covered by ultrawatch's own suite (which only
unit-tests the pure detect_agents_from_process() classifier — see
test_agents.py). All subprocess calls are mocked; the real-I/O guard
(tests/py/__init__.py) would otherwise raise.
"""
import unittest
from unittest import mock

from everwatch.engine import agents


class TestFillMissingTtyCwds(unittest.TestCase):
    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_empty_ttys_short_circuits_without_subprocess(self, run):  # parity: P-06
        self.assertEqual(agents.fill_missing_tty_cwds([]), {})
        run.assert_not_called()

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_finds_cwd_via_ps_then_lsof(self, run):  # parity: P-06
        ps_out = 'PID TT\n  123 ttys003\n  456 ttys003\n'
        lsof_out = 'p456\nn/Users/x/project\n'
        run.side_effect = [
            mock.Mock(stdout=ps_out),
            mock.Mock(stdout=lsof_out),
        ]
        result = agents.fill_missing_tty_cwds(['/dev/ttys003'])
        self.assertEqual(result, {'/dev/ttys003': '/Users/x/project'})
        # last (highest) PID on the tty is used, not the login shell's
        ps_call, lsof_call = run.call_args_list
        self.assertEqual(ps_call.args[0], ['ps', '-eo', 'pid,tty'])
        self.assertIn('456', lsof_call.args[0])

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_no_matching_pid_returns_empty_without_lsof(self, run):  # parity: P-06
        run.return_value = mock.Mock(stdout='PID TT\n')
        self.assertEqual(agents.fill_missing_tty_cwds(['/dev/ttys999']), {})
        run.assert_called_once()  # only the ps call, no lsof follow-up

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_exception_swallowed_returns_empty(self, run):  # parity: P-06
        run.side_effect = OSError('boom')
        self.assertEqual(agents.fill_missing_tty_cwds(['/dev/ttys003']), {})

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_pid_missing_from_lsof_output_is_empty_cwd(self, run):  # parity: P-06
        run.side_effect = [
            mock.Mock(stdout='PID TT\n  456 ttys003\n'),
            mock.Mock(stdout=''),  # lsof found nothing for that pid
        ]
        result = agents.fill_missing_tty_cwds(['/dev/ttys003'])
        self.assertEqual(result, {'/dev/ttys003': ''})


class TestGetAgentTtys(unittest.TestCase):
    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_skips_question_mark_ttys(self, run):  # parity: P-07
        run.return_value = mock.Mock(
            stdout=' ??      launchd          /sbin/launchd\n'
                  'ttys004  claude           claude --resume\n')
        result = agents.get_agent_ttys()
        self.assertEqual(result, {'/dev/ttys004': {'claude'}})

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_exception_returns_empty_dict(self, run):  # parity: P-07
        run.side_effect = OSError('boom')
        self.assertEqual(agents.get_agent_ttys(), {})

    @mock.patch('everwatch.engine.agents.subprocess.run')
    def test_uses_ps_timeout_from_config(self, run):  # parity: P-07
        from everwatch.engine import config
        run.return_value = mock.Mock(stdout='')
        agents.get_agent_ttys()
        self.assertEqual(run.call_args.kwargs['timeout'], config.PS_TIMEOUT)


if __name__ == '__main__':
    unittest.main()
