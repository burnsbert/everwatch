"""RealSource: the ported ultrawatch I/O functions behind the DataSource
interface (docs/DESIGN.md §3.4). No logic of its own beyond delegation,
so every behavior here is the ported engine's (P-01..P-07, P-51, P-52,
P-60)."""
import subprocess

from everwatch import terminput
from everwatch.engine import agents, iterm, itermcolor, usage_claude, \
    usage_codex
from everwatch.sources.base import DataSource

ITERM_BUNDLE_ID = 'com.googlecode.iterm2'


class RealSource(DataSource):
    mode = 'real'

    def __init__(self, run=None, popen=None):
        # `run` is the osascript runner (iterm.run_osascript by default);
        # `popen` launches fire-and-forget helpers (`open`). Both are
        # injectable so tests never spawn real processes.
        self._run = run or iterm.run_osascript
        self._popen = popen

    def fetch_snapshot(self, at=0.0):
        return iterm.fetch_snapshot(at=at, run=self._run)

    def fetch_paths(self, at=0.0):
        return iterm.fetch_paths(at=at, run=self._run)

    def goto(self, uid):
        return iterm.goto_session(uid, run=self._run)

    def close_tab(self, window_id, tab_index):
        iterm.close_tab(window_id, tab_index, run=self._run)

    def new_tab(self):
        iterm.new_tab(run=self._run)

    def agent_ttys(self):
        return agents.get_agent_ttys()

    def tty_cwds(self, ttys):
        return agents.fill_missing_tty_cwds(ttys)

    def fetch_colors(self):
        return itermcolor.fetch_colors()

    def set_color(self, uid, name):
        return itermcolor.set_session_color(uid, name)

    def usage_claude(self):
        return usage_claude.fetch_usage()

    def usage_codex(self):
        return usage_codex.fetch_codex_usage()

    def _spawn(self, argv):
        popen = self._popen or subprocess.Popen
        popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL)

    def open_url(self, url):
        # Only https URLs we built ourselves (the quota Gmail draft) reach
        # here; refuse anything else rather than hand it to `open`.
        if not url.startswith('https://'):
            raise ValueError('refusing to open a non-https URL')
        self._spawn(['open', url])

    def launch_iterm(self):
        self._spawn(['open', '-b', ITERM_BUNDLE_ID])

    def fetch_screen(self, uid, hint=None):
        return iterm.fetch_screen(uid, hint, run=self._run)

    def send_input(self, uid, items, hint=None):
        return iterm.send_input(uid, terminput.items_to_writes(items), hint,
                                run=self._run)
