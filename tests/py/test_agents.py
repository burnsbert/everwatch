"""Ported from ultrawatch tests/test_agents.py (P-07)."""
import unittest

from everwatch.engine import agents


class TestDetectAgentsFromProcess(unittest.TestCase):
    def test_comm_claude(self):  # parity: P-07
        self.assertEqual(agents.detect_agents_from_process('claude', ''),
                         {'claude'})

    def test_args_first_token_claude(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process('node', 'claude --resume'),
            {'claude'})

    def test_node_launcher_claude(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process(
                'node', 'node /Users/x/.local/bin/claude --dangerously-skip-permissions'),
            {'claude'})

    def test_bun_launcher_codex(self):  # parity: P-07
        self.assertEqual(agents.detect_agents_from_process('bun', 'bun codex'),
                         {'codex'})

    def test_anthropic_package_in_launch_prefix(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process(
                'node',
                'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'),
            {'claude'})

    def test_openai_codex_package_in_launch_prefix(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process(
                'node', 'node /usr/lib/node_modules/@openai/codex/bin/codex.js'),
            {'codex'})

    def test_comm_codex(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process('codex', 'codex exec'),
            {'codex'})

    def test_plain_process_empty(self):  # parity: P-07
        self.assertEqual(agents.detect_agents_from_process('vim', 'vim file.txt'),
                         set())
        self.assertEqual(agents.detect_agents_from_process('zsh', '-zsh'),
                         set())

    def test_never_both_agents_from_one_process(self):  # parity: P-07
        cases = [
            ('claude', 'claude'),
            ('node', 'node /x/claude'),
            ('codex', 'codex'),
            ('bun', 'bun codex'),
            ('node', 'node /x/@anthropic-ai/claude-code/cli.js'),
            ('node', 'node /x/@openai/codex/bin/codex.js'),
        ]
        for comm, args in cases:
            with self.subTest(comm=comm, args=args):
                self.assertLessEqual(
                    len(agents.detect_agents_from_process(comm, args)), 1)

    def test_quoted_basename(self):  # parity: P-07
        self.assertEqual(
            agents.detect_agents_from_process('node', '"/Users/x/bin/Claude"'),
            {'claude'})

    def test_empty_args(self):  # parity: P-07
        self.assertEqual(agents.detect_agents_from_process('login', ''), set())


if __name__ == '__main__':
    unittest.main()
