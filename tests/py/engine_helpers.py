"""Shared builders for the WP2 engine tests (not a test module itself).

Every engine built here is hermetic: a FakeSource, a VirtualClock, a
state file and usage history inside a per-test temp dir, an in-memory
quota gate (never the real ~/.claude/quota-email), my_tty='' and no
debug/shell environment leakage.
"""
import os
import tempfile

from everwatch.clock import VirtualClock
from everwatch.engine import persist
from everwatch.engine.snapshot import ItermSnapshot, SessionInfo
from everwatch.engine_loop import Engine
from everwatch.history import UsageHistory
from everwatch.notify_policy import MemoryQuotaGate
from everwatch.sources.fake import FakeSource

T0 = 1_790_000_000.0
HOME = '/Users/tester'

CLAUDE_WAITING = ('⏺ Let me run the tests.\n'
                  '│ Do you want to proceed?\n'
                  '│ ❯ 1. Yes\n'
                  '│   2. No, and tell Claude what to do differently (esc)')
CLAUDE_BUSY = '✻ Ruminating… (3s · esc to interrupt)'
CLAUDE_IDLE = '✻ Worked for 3s\n❯ '


def sess(uid, tty='/dev/ttys001', text='$ ', proc=False, window=1, tab=1,
         pane=1, name='zsh'):
    return SessionInfo(window_id=window, tab_index=tab, session_index=pane,
                       uid=uid, tty=tty, is_processing=proc, name=name,
                       text=text)


def snap(*sessions, at=0.0):
    return ItermSnapshot(sessions=tuple(sessions), at=at)


class EngineFixture:
    """engine + source + clock + tmp dir, built fresh per test."""

    def __init__(self, testcase, source=None, quota_cfg=None, **engine_kw):
        tmp = tempfile.TemporaryDirectory()
        testcase.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.clock = VirtualClock(T0)
        self.source = source or FakeSource()
        self.quota = MemoryQuotaGate(quota_cfg)
        self.store = persist.StateStore(
            path=os.path.join(self.dir, 'state.json'), now=T0)
        engine_kw.setdefault('threaded', False)
        engine_kw.setdefault('my_tty', '')
        engine_kw.setdefault('debug_state', False)
        engine_kw.setdefault('shell', False)
        engine_kw.setdefault('path_home', HOME)
        self.engine = Engine(
            self.source, self.clock, store=self.store,
            usage_history=UsageHistory(
                os.path.join(self.dir, 'usage-history.jsonl'), T0),
            quota_gate=self.quota, **engine_kw)
        self.sub = None

    def set_sessions(self, *sessions):
        self.source.set('fetch_snapshot', snap(*sessions))

    def step(self, seconds=2.0):
        """Advance virtual time, then run one engine pass."""
        if seconds:
            self.clock.advance(seconds)
        self.engine.step()
        return self.engine.published.state

    def subscribe(self, initial=None):
        self.sub = self.engine.subscribe(initial=initial)
        return self.sub

    def drain(self, sub=None):
        sub = sub or self.sub
        out = []
        while True:
            ev = sub.get(timeout=0)
            if ev is None:
                return out
            out.append(ev)

    def session(self, uid):
        for s in self.engine.published.state['sessions']:
            if s['uid'] == uid:
                return s
        return None
