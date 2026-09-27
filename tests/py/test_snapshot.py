"""New tests for everwatch/engine/snapshot.py's dataclasses, which
ultrawatch's own suite never tested directly (they're only exercised
indirectly through iterm.py/pollers.py)."""
import unittest

from everwatch.engine.snapshot import AgentSnapshot, ErrorSnapshot


class TestAgentSnapshotAgentsFor(unittest.TestCase):
    def test_returns_the_matching_ttys_agents(self):
        snap = AgentSnapshot(
            ttys=(('/dev/ttys001', frozenset({'claude'})),
                 ('/dev/ttys002', frozenset({'codex'}))))
        self.assertEqual(snap.agents_for('/dev/ttys001'), {'claude'})
        self.assertEqual(snap.agents_for('/dev/ttys002'), {'codex'})

    def test_unknown_tty_returns_empty_frozenset(self):
        snap = AgentSnapshot(ttys=(('/dev/ttys001', frozenset({'claude'})),))
        self.assertEqual(snap.agents_for('/dev/ttys999'), frozenset())

    def test_default_is_empty(self):
        self.assertEqual(AgentSnapshot().agents_for('/dev/ttys001'),
                         frozenset())


class TestErrorSnapshotDefaults(unittest.TestCase):
    def test_defaults(self):
        snap = ErrorSnapshot()
        self.assertEqual(snap.kind, '')
        self.assertEqual(snap.error, '')
        self.assertEqual(snap.at, 0.0)

    def test_fields_round_trip(self):
        snap = ErrorSnapshot(kind='iterm', error='boom', at=5.0)
        self.assertEqual((snap.kind, snap.error, snap.at), ('iterm', 'boom', 5.0))


if __name__ == '__main__':
    unittest.main()
