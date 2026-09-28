"""DemoSource: a deterministic scripted fleet (docs/DESIGN.md §3.4, W-9).

Reads demo_scenario.json: 9 sessions across 2 windows (4 Claude Code,
2 Codex, 3 plain shells) with a Claude permission prompt, a Claude
question menu on a 90 s loop (so a transition to waiting — and its
notification — keeps happening), spinners, a just-finished idle session,
a Codex approval, `tail -f` output, tab colors, labels, project names,
and usage data with a five-hour pace warning and current quota categories.

Everything is a pure function of (scenario, seed, clock time):
scenario time is `s = clock.now() - t0`, where t0 is the clock's time
when the source was built. Each session plays its `cycle` of
[seconds, screen] phases starting `offset` seconds in. Randomness
(spinner glyphs, token counts, log lines) comes from `random.Random`
seeded with strings built from the seed and the moment, so it doesn't
depend on how many times anything was called.

Actions mutate the scenario (goto focuses a window, close removes a tab,
new adds a shell, set_color recolors a tab). Nothing here touches the
real system: open_url and launch_iterm only record the request.

W-10 reply: `send_input` plays a tiny terminal. Typed text shows on the
session's prompt line; Enter submits it (agents go busy, shells echo
the command); a digit / shortcut letter / Enter picks from a Claude or
Codex menu; Esc / Ctrl-C interrupt a busy agent or decline a menu. The
resulting screen replaces the scripted one until that session's cycle
moves to its next phase (so a frozen `--clock fixed:` demo keeps it).

`build_demo_engine()` wires a DemoSource into an Engine, warms it up
over the scenario's last hour of virtual time (so ages, sparklines, and
usage history look lived-in), and returns it ready to serve.
`dump_state()` returns the canonical State JSON (tests/golden).
"""
import copy
import json
import os
import random
import re
import time
from datetime import datetime, timezone

from everwatch.clock import FixedClock, VirtualClock, parse_iso_epoch
from everwatch.engine import config, persist
from everwatch.engine.snapshot import (ItermSnapshot, PathsSnapshot,
                                       SessionInfo)
from everwatch.sources.base import DataSource, ItermError, ItermNotRunning

SCENARIO_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'demo_scenario.json')
SPINNER_GLYPHS = '✢✳✶✻✽'
RULE = '─' * 96

# W-10 demo replies (see send_input). A menu option line, optionally
# boxed and/or selected: "│ ❯ 1. Yes   │", "› 1. Yes, proceed (y)".
_MENU_LINE_RE = re.compile(r'^[\s│]*([❯›])?\s*(\d+)\.\s+(.*?)[\s│]*$')
_SHORTCUT_RE = re.compile(r'\((\w+)\)\s*$')
# Where a screen's interactive area (menu / prompt box) starts.
_INTERACTIVE_RE = re.compile(
    r'^\s*(?:╭|─{8,}|☐|›|Would you like to run)')
_SHELL_PROMPT_RE = re.compile(r'^(\S+@\S+ .*?% )')


def menu_options(lines):
    """[(n, label, shortcut, selected)] when `lines` show a selection menu
    (some option carries the ❯/› marker), else []."""
    opts = []
    for line in lines:
        m = _MENU_LINE_RE.match(line)
        if m:
            label = m.group(3)
            sc = _SHORTCUT_RE.search(label)
            opts.append((int(m.group(2)), label,
                         sc.group(1).lower() if sc else '', bool(m.group(1))))
    return opts if any(o[3] for o in opts) else []


def _context(lines, keep=10):
    """The transcript above a screen's interactive area."""
    cut = len(lines)
    for i, line in enumerate(lines):
        if _INTERACTIVE_RE.match(line) or _MENU_LINE_RE.match(line):
            cut = i
            break
    # a stale "… esc to interrupt" status line would keep it busy
    out = [line for line in lines[:cut]
           if 'esc to interrupt' not in line.lower()]
    while out and not out[-1].strip():
        out.pop()
    return out[-keep:]


def with_typed(lines, typed):
    """Show `typed` on the screen's prompt line (Claude's empty `❯`,
    Codex's `›` input, or a trailing shell prompt)."""
    lines = list(lines)
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        if line.rstrip() == '❯':
            lines[i] = '❯ ' + typed
            return lines
        if line.startswith('› ') and not _MENU_LINE_RE.match(line):
            lines[i] = '› ' + typed
            return lines
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip():
            if _SHELL_PROMPT_RE.match(lines[i]) and \
                    lines[i].rstrip().endswith('%'):
                lines[i] = lines[i].rstrip() + ' ' + typed
            return lines
    return lines
TITLE_SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

# Failure presets for onboarding/diagnostic demos (`fail` attribute).
FAILURES = {
    'not_running': None,
    'permission_denied': ('execution error: Not authorized to send Apple '
                          'events to iTerm. (-1743)'),
    'timeout': 'execution error: iTerm got an error: AppleEvent timed out. '
               '(-1712)',
    'error': 'execution error: iTerm got an error: unexpected failure. (-1)',
}


def load_scenario(path=None):
    with open(path or SCENARIO_PATH, encoding='utf-8') as f:
        return json.load(f)


def _fmt_elapsed(seconds):
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f'{seconds}s'
    return f'{seconds // 60}m {seconds % 60}s'


class DemoSource(DataSource):
    mode = 'demo'

    def __init__(self, clock, seed=1, scenario=None, quota=False):
        self.scenario = copy.deepcopy(scenario or load_scenario())
        self.clock = clock
        self.seed = seed
        self.t0 = clock.now()
        self.home = self.scenario.get('home', config.HOME)
        self.utc_offset = self.scenario.get('utc_offset_minutes', 0) * 60
        self.sessions = [dict(s) for s in self.scenario['sessions']]
        self.colors = {s['uid']: s['tab_color'] for s in self.sessions
                       if s.get('tab_color')}
        self.focused_window = self.sessions[0]['window_id'] \
            if self.sessions else 0
        self.fail = None
        self.opened = []
        self.launches = 0
        self._new_tabs = 0
        self.typed = {}     # W-10: uid -> text on the prompt line
        self.replies = {}   # W-10: uid -> reply screen (see send_input)
        self.quota_config = copy.deepcopy(self.scenario.get('quota'))
        if quota and isinstance(self.quota_config, dict):
            self.quota_config['enabled'] = True

    # ------------------------------------------------------- helpers

    def _rng(self, *parts):
        return random.Random(':'.join(str(p) for p in (self.seed,) + parts))

    def _s(self):
        return self.clock.now() - self.t0

    def _phase(self, sess, s):
        cycle = sess['cycle']
        period = sum(d for d, _ in cycle)
        pos = (sess.get('offset', 0) + s) % period
        start = 0
        for duration, key in cycle:
            if pos < start + duration:
                return key, pos - start
            start += duration
        return cycle[-1][1], 0  # pragma: no cover - float edge

    def _clock_text(self, epoch, millis=False):
        t = time.gmtime(epoch + self.utc_offset)
        text = time.strftime('%H:%M:%S', t)
        if millis:
            text += f'.{int((epoch % 1) * 1000):03d}'
        return text

    def _log_lines(self, uid, now):
        spec = self.scenario.get('access_log') or {}
        every = spec.get('every_seconds', 1.0)
        count = spec.get('lines', 12)
        routes = spec.get('routes') or [['GET', '/']]
        statuses = spec.get('statuses') or [200]
        last = int(now // every)
        out = []
        for i in range(last - count + 1, last + 1):
            rng = self._rng(uid, 'log', i)
            method, route = rng.choice(routes)
            path = route.replace('{id}', str(rng.randint(1000, 9999)))
            status = rng.choice(statuses)
            ms = rng.randint(2, 40) if status != 429 else 1
            req = '%08x' % rng.getrandbits(32)
            out.append(f'{self._clock_text(i * every, millis=True)} '
                       f'{method:<5} {path:<22} {status}  {ms:>3}ms  '
                       f'req={req}')
        return out

    def _fill(self, line, uid, key, now, elapsed):
        if '{' not in line:
            return line
        base = self._rng(uid, key, 'base').uniform(0.4, 2.5)
        return (line
                .replace('{spin}', self._rng(uid, 'spin', int(now))
                         .choice(SPINNER_GLYPHS))
                .replace('{elapsed}', _fmt_elapsed(elapsed))
                .replace('{tokens}', f'{base + int(elapsed) * 0.031:.1f}k'))

    def _render_lines(self, sess, now, s):
        """(lines, processing, phase key) before any typed input."""
        key, elapsed = self._phase(sess, s)
        uid = sess['uid']
        reply = self.replies.get(uid)
        if reply and reply['phase'] != key:
            # the scripted cycle moved on: drop the demo reply
            self.replies.pop(uid, None)
            self.typed.pop(uid, None)
            reply = None
        if reply:
            since = now - reply['at']
            return ([self._fill(line, uid, 'reply', now, since)
                     for line in reply['lines']], reply['processing'], key)
        screen = self.scenario['screens'][key]
        lines = []
        for line in screen['lines']:
            if line == '{log}':
                lines.extend(self._log_lines(uid, now))
                continue
            lines.append(self._fill(line, uid, key, now, elapsed))
        return lines, bool(screen.get('processing')), key

    def _render(self, sess, now, s):
        uid = sess['uid']
        lines, processing, _key = self._render_lines(sess, now, s)
        if self.typed.get(uid):
            lines = with_typed(lines, self.typed[uid])
        name = sess.get('name', '')
        if sess.get('agent') == 'claude':
            glyph = (self._rng(uid, 'title', int(now)).choice(TITLE_SPINNER)
                     if processing else '✳')
            name = f'{glyph} {name}'
        return '\n'.join(lines), processing, name

    def _raise_failure(self):
        if self.fail == 'not_running':
            raise ItermNotRunning()
        raise ItermError(FAILURES.get(self.fail) or FAILURES['error'])

    def _find(self, uid):
        for sess in self.sessions:
            if sess['uid'] == uid:
                return sess
        return None

    # --------------------------------------------------- DataSource

    def fetch_snapshot(self, at=0.0):
        if self.fail:
            self._raise_failure()
        now = self.clock.now()
        s = now - self.t0
        out = []
        for sess in self.sessions:
            text, processing, name = self._render(sess, now, s)
            out.append(SessionInfo(
                window_id=sess['window_id'], tab_index=sess['tab_index'],
                session_index=sess.get('session_index', 1), uid=sess['uid'],
                tty=sess['tty'], is_processing=processing, name=name,
                text=text))
        return ItermSnapshot(sessions=tuple(out), at=at)

    def fetch_paths(self, at=0.0):
        if self.fail:
            self._raise_failure()
        return PathsSnapshot(paths=tuple(
            (sess['uid'], sess.get('path', '')
             if sess.get('shell_integration', True) else '')
            for sess in self.sessions), at=at)

    def goto(self, uid):
        sess = self._find(uid)
        if not sess:
            return False
        self.focused_window = sess['window_id']
        return True

    def close_tab(self, window_id, tab_index):
        doomed = [x for x in self.sessions if x['window_id'] == window_id and
                  x['tab_index'] == tab_index]
        if not doomed:
            raise ItermError(f"iTerm got an error: Can't get tab {tab_index} "
                             f'of window id {window_id}. Invalid index. '
                             '(-1719)')
        self.sessions = [x for x in self.sessions if x not in doomed]
        for sess in doomed:
            self.colors.pop(sess['uid'], None)
        for sess in self.sessions:
            if sess['window_id'] == window_id and \
                    sess['tab_index'] > tab_index:
                sess['tab_index'] -= 1

    def new_tab(self):
        self._new_tabs += 1
        n = self._new_tabs
        window = self.focused_window
        tabs = [x['tab_index'] for x in self.sessions
                if x['window_id'] == window]
        used = {x['tty'] for x in self.sessions}
        tty_n = 12
        while f'/dev/ttys{tty_n:03d}' in used:
            tty_n += 1
        new = {'uid': f'D3E40000-0000-4000-8000-{n:012d}',
               'window_id': window, 'tab_index': max(tabs, default=0) + 1,
               'tty': f'/dev/ttys{tty_n:03d}', 'agent': None,
               'name': '-zsh', 'path': self.home,
               'cycle': [[3600, 'sh_new']], 'offset': 0}
        # keep window order: insert after the window's last session
        idx = max((i for i, x in enumerate(self.sessions)
                   if x['window_id'] == window), default=len(self.sessions) - 1)
        self.sessions.insert(idx + 1, new)

    def agent_ttys(self):
        return {sess['tty']: {sess['agent']} for sess in self.sessions
                if sess.get('agent')}

    # ------------------------------------------------ W-10 live + reply

    def fetch_screen(self, uid, hint=None):
        if self.fail:
            self._raise_failure()
        sess = self._find(uid)
        if not sess:
            return None
        now = self.clock.now()
        return self._render(sess, now, now - self.t0)[0]

    def _reply(self, sess, key, lines, processing):
        self.replies[sess['uid']] = {'phase': key, 'lines': lines,
                                     'processing': processing,
                                     'at': self.clock.now()}

    def _busy_lines(self, sess, context, echo):
        if sess.get('agent') == 'codex':
            return context + ['', echo, '',
                              '• Working ({elapsed} • esc to interrupt)', '',
                              '› Ask Codex to do anything', '',
                              '  ⏎ send   ⇧⏎ newline   ⌃T transcript   '
                              '⌃C quit']
        return context + ['', echo, '',
                          '{spin} Working on it… ({elapsed} · esc to '
                          'interrupt)', '', RULE, '❯ ', RULE,
                          '  ⏵⏵ accept edits on (shift+tab to cycle)']

    def _stopped_lines(self, sess, context, note):
        if sess.get('agent') == 'codex':
            return context + ['', f'■ {note}', '',
                              '› Ask Codex to do anything', '',
                              '  ⏎ send   ⇧⏎ newline   ⌃T transcript   '
                              '⌃C quit']
        return context + ['', f'  ⎿  {note}', '', RULE, '❯ ', RULE,
                          '  ⏵⏵ accept edits on (shift+tab to cycle)']

    def _shell_prompt(self, lines):
        for line in reversed(lines):
            m = _SHELL_PROMPT_RE.match(line)
            if m:
                return m.group(1)
        return f"{self.scenario.get('user', 'sam')}@mbp ~ % "

    def send_input(self, uid, items, hint=None):
        """Apply validated (kind, value) items (everwatch.terminput) to a
        demo session. Returns False if the session is gone."""
        sess = self._find(uid)
        if not sess:
            return False
        for kind, value in items:
            now = self.clock.now()
            lines, processing, key = self._render_lines(sess, now,
                                                        now - self.t0)
            self._apply(sess, key, lines, processing, kind, value)
        return True

    def _apply(self, sess, key, lines, processing, kind, value):
        uid = sess['uid']
        agent = sess.get('agent')
        menu = menu_options(lines) if agent else []
        if menu:
            pick = None
            if kind == 'text':
                t = value.strip().lower()
                pick = next((o for o in menu if t in (str(o[0]), o[2])),
                            None)
            elif value == 'enter':
                pick = next(o for o in menu if o[3])
            elif value in ('esc', 'ctrl-c'):
                pick = next((o for o in menu if o[2] == 'esc'), menu[-1])
            if pick is None:
                return
            context = _context(lines)
            if pick[1].lower().startswith('no'):
                self._reply(sess, key, self._stopped_lines(
                    sess, context, 'Declined · tell the agent what to do '
                                   'differently'), False)
            else:
                label = _SHORTCUT_RE.sub('', pick[1]).rstrip()
                echo = (f'• You chose: {pick[0]}. {label}'
                        if agent == 'codex'
                        else f'  ⎿  You chose: {pick[0]}. {label}')
                self._reply(sess, key, self._busy_lines(sess, context, echo),
                            True)
            return
        typed = self.typed.get(uid, '')
        if kind == 'text':
            self.typed[uid] = typed + value
        elif value == 'backspace':
            self.typed[uid] = typed[:-1]
        elif value == 'enter':
            self.typed.pop(uid, None)
            if agent:
                if typed:
                    echo = ('› ' if agent == 'codex' else '> ') + typed
                    self._reply(sess, key, self._busy_lines(
                        sess, _context(lines), echo), True)
            else:
                last = lines[-1] if lines else ''
                if _SHELL_PROMPT_RE.match(last) and \
                        last.rstrip().endswith('%'):
                    out = lines[:-1] + [last.rstrip() + ' ' + typed,
                                        self._shell_prompt(lines)]
                else:
                    out = lines + [typed]
                self._reply(sess, key, out, processing)
        elif value in ('esc', 'ctrl-c') and agent and processing:
            self.typed.pop(uid, None)
            self._reply(sess, key, self._stopped_lines(
                sess, _context(lines),
                'Interrupted · What should the agent do instead?'), False)
        elif value == 'ctrl-c' and not agent:
            self.typed.pop(uid, None)
            last = lines[-1] if lines else ''
            self._reply(sess, key, lines[:-1] + [last.rstrip() + '^C',
                                                 self._shell_prompt(lines)],
                        False)

    def tty_cwds(self, ttys):
        wanted = set(ttys)
        return {sess['tty']: sess.get('path', '') for sess in self.sessions
                if sess['tty'] in wanted}

    def fetch_colors(self):
        return dict(self.colors)

    def set_color(self, uid, name):
        if not self._find(uid):
            return False
        if name:
            self.colors[uid] = name
        else:
            self.colors.pop(uid, None)
        return True

    def _grow(self, spec, key):
        hours = (self.clock.now() - self.t0) / 3600
        value = spec.get(key, 0) + spec.get('rate_per_hour', 0) * hours
        return round(max(0.0, min(100.0, value)), 1)

    def usage_claude(self):
        spec = (self.scenario.get('usage') or {}).get('claude')
        if not spec:
            return None, None
        data = {}
        for key in ('five_hour', 'seven_day', 'seven_day_sonnet'):
            bucket = spec.get(key)
            if not bucket:
                continue
            data[key] = {
                'utilization': self._grow(bucket, 'utilization'),
                'resets_at': datetime.fromtimestamp(
                    self.t0 + bucket['resets_in'], timezone.utc).isoformat(),
            }
        extra = spec.get('extra_usage')
        if extra:
            limit = extra.get('monthly_limit')
            used = extra.get('used_credits', 0)
            data['extra_usage'] = {
                'is_enabled': bool(extra.get('is_enabled')),
                'monthly_limit': limit,
                'used_credits': used,
                'utilization': round(used / limit * 100, 1) if limit else None,
            }
        return data, None

    def usage_codex(self):
        spec = (self.scenario.get('usage') or {}).get('codex')
        if not spec:
            return None, None
        rate_limit = {}
        for key in ('primary_window', 'secondary_window'):
            window = spec.get(key)
            if not window:
                continue
            rate_limit[key] = {
                'used_percent': self._grow(window, 'used_percent'),
                'reset_at': int(self.t0 + window['resets_in']),
                'limit_window_seconds': window['limit_window_seconds'],
            }
        return {'rate_limit': rate_limit}, None

    def open_url(self, url):
        self.opened.append(url)

    def launch_iterm(self):
        self.launches += 1
        if self.fail == 'not_running':
            self.fail = None


# W-6/W-8: how far back to backfill each usage id's history so a fresh
# demo boot's burn-down chart has real shape immediately — several hours
# for the 5-hour windows, several days for the weekly ones — independent
# of `warmup_minutes` (which drives the engine's own, real-time-costly
# step loop for sparklines/transitions, not just usage history).
USAGE_BACKFILL_HOURS = {
    'cc.five_hour': 5.5, 'cc.seven_day': 4 * 24, 'cc.seven_day_sonnet': 4 * 24,
    'cx.five_hour': 5.5, 'cx.seven_day': 4 * 24,
}
CODEX_WINDOW_IDS = {18000: 'cx.five_hour', 604800: 'cx.seven_day'}
USAGE_BACKFILL_INTERVAL = 900  # seconds (15 min): enough shape, not too many points


def _usage_growth_specs(scenario):
    """`{id: (base, rate_per_hour)}` for every configured usage row, read
    from the same scenario fields `DemoSource._grow` uses for the live
    value."""
    usage = scenario.get('usage') or {}
    claude = usage.get('claude') or {}
    codex = usage.get('codex') or {}
    specs = {}
    for key in ('five_hour', 'seven_day', 'seven_day_sonnet'):
        bucket = claude.get(key)
        if bucket:
            specs[f'cc.{key}'] = (bucket.get('utilization', 0),
                                  bucket.get('rate_per_hour', 0))
    for key in ('primary_window', 'secondary_window'):
        window = codex.get(key)
        if window:
            uid = CODEX_WINDOW_IDS.get(window.get('limit_window_seconds'))
            if uid:
                specs[uid] = (window.get('used_percent', 0),
                              window.get('rate_per_hour', 0))
    return specs


def _seed_usage_history(usage_history, scenario, t0, already_covered_seconds):
    """Backfill `usage_history` with a deterministic ramp for every usage
    row, older than whatever the engine's own warmup loop already sampled
    (`already_covered_seconds`), so the burn-down charts (W-6/W-8) show a
    realistic multi-hour/multi-day shape the moment the demo boots. Uses
    the exact linear-growth math `DemoSource._grow` uses for the *live*
    value, evaluated at each backfilled instant, so the seam where the
    engine's own samples pick up lines up exactly. Pure function of
    (scenario, t0) — deterministic, no clock reads."""
    cutoff = t0 - already_covered_seconds
    new_samples = []
    for uid, (base, rate) in _usage_growth_specs(scenario).items():
        start = t0 - USAGE_BACKFILL_HOURS.get(uid, 0) * 3600
        n = max(0, int((cutoff - start) // USAGE_BACKFILL_INTERVAL))
        for i in range(n):
            at = start + i * USAGE_BACKFILL_INTERVAL
            pct = round(max(0.0, min(100.0, base + rate * (at - t0) / 3600)), 1)
            new_samples.append({'at': round(at, 3), 'id': uid, 'pct': pct})
    new_samples.sort(key=lambda s: (s['at'], s['id']))
    usage_history.samples[:0] = new_samples


class MemoryStore(persist.StateStore):
    """A StateStore that never reads or writes disk (demo mode must not
    touch the user's real labels or prefs)."""

    def __init__(self, now=None):
        super().__init__(path=os.devnull, now=now)

    def _load(self):
        return None

    def save(self):
        self._dirty_at = None


def demo_store(scenario, now):
    store = MemoryStore(now=now)
    for sess in scenario.get('sessions', ()):
        if sess.get('label'):
            store.set_label(sess['uid'], sess['label'], now=now)
    for i, name in enumerate(scenario.get('projects', ())[:5]):
        store.set_project(i + 1, name, now=now)
    store.set('projects_open', bool(scenario.get('projects_open')), now=now)
    store.update_prefs(scenario.get('prefs') or {}, now=now)
    store._dirty_at = None
    return store


def default_clock(scenario=None):
    scenario = scenario or load_scenario()
    return FixedClock(parse_iso_epoch(scenario['clock']))


def build_demo_engine(seed=1, clock=None, scenario=None, warmup=None,
                      quota=False, my_tty='', **engine_kwargs):
    """A demo Engine, warmed up and published. `clock` defaults to the
    scenario's fixed instant; `warmup` (seconds) defaults to the
    scenario's warmup_minutes."""
    from everwatch.engine_loop import Engine
    from everwatch.history import UsageHistory
    from everwatch.notify_policy import MemoryQuotaGate

    scenario = scenario or load_scenario()
    clock = clock or default_clock(scenario)
    source = DemoSource(clock, seed=seed, scenario=scenario, quota=quota)
    t0 = source.t0
    warm = scenario.get('warmup_minutes', 0) * 60 if warmup is None \
        else warmup
    engine_kwargs.setdefault('debug_state', False)
    engine_kwargs.setdefault('shell', False)
    engine = Engine(source, clock, store=demo_store(scenario, t0),
                    threaded=False, my_tty=my_tty,
                    quota_gate=MemoryQuotaGate(source.quota_config),
                    usage_history=UsageHistory(None, t0),
                    started=t0 - warm, path_home=source.home,
                    **engine_kwargs)
    if warm > 0:
        vclock = VirtualClock(t0 - warm)
        source.clock = engine.clock = vclock
        while vclock.now() < t0:
            engine.step(publish=False)
            vclock.advance(config.SNAPSHOT_INTERVAL)
        source.clock = engine.clock = clock
        engine._pending_events = []
    _seed_usage_history(engine.usage_history, scenario, t0, warm)
    engine.step()
    return engine


def dump_state(seed=1, clock=None, scenario=None, indent=1):
    """Canonical JSON of a freshly built demo engine's full State."""
    engine = build_demo_engine(seed=seed, clock=clock, scenario=scenario)
    return engine.published.to_json(include_screens=True, indent=indent)


def main(argv=None):
    """`python3 -m everwatch.sources.demo [--seed N] [--clock SPEC]
    [--tz ZONE] [-o FILE]`: print (or write) the demo State JSON. WP3
    wraps this as `make golden`. --tz pins the zone used for reset
    countdown text (default America/New_York, the scenario's zone) so
    the golden file doesn't depend on the machine."""
    import argparse
    import sys

    from everwatch.clock import parse_clock

    parser = argparse.ArgumentParser(prog='everwatch.sources.demo')
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--clock', default='')
    parser.add_argument('--tz', default='America/New_York')
    parser.add_argument('-o', '--output', default='')
    args = parser.parse_args(argv)
    if args.tz:
        os.environ['TZ'] = args.tz
        time.tzset()
    clock = parse_clock(args.clock) if args.clock else None
    text = dump_state(seed=args.seed, clock=clock) + '\n'
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':  # pragma: no cover
    raise SystemExit(main())
