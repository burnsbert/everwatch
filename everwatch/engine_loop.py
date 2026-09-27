"""The Engine: single owner of all mutable backend state (docs/DESIGN.md
§3.1, §3.3).

One Engine thread drains poller events and commands from one inbox,
updates the SessionTracker / StateStore / history / notify policy, and
publishes an immutable `PublishedState` (monotonic `rev`). Everything
else only:

- reads `engine.published` (swapped atomically; never mutated after
  publish — treat its dicts as read-only),
- calls `engine.submit(kind, **args)` -> concurrent.futures.Future, or
  `engine.call(kind, timeout=5, **args)` -> result (raises CommandError),
- `engine.subscribe()` -> Subscription (bounded queue of Event), and
  `engine.unsubscribe(sub)`.

Two poll drivers:
- ThreadedDriver (real iTerm2): the ported pollers from engine/pollers.py,
  each on its own thread, with every I/O call routed through the
  DataSource.
- InlineDriver (demo, fake, tests): polls the DataSource synchronously
  from the engine thread on the injected clock's schedule, so a given
  source + clock always yields byte-identical state.

Tests drive the engine without threads: `engine.step()` pumps the inline
driver, drains the inbox (resolving command futures), ticks, and
publishes.
"""
import concurrent.futures
import dataclasses
import json
import logging
import os
import queue
import sys
import threading
import time
from collections import namedtuple
from dataclasses import dataclass, field

from everwatch import __version__, diagnostics, installer, model, terminput
from everwatch.clock import SystemClock
from everwatch.engine import config
from everwatch.engine import heuristics as H
from everwatch.engine import persist, pollers
from everwatch.engine.snapshot import (AgentSnapshot, ColorsSnapshot,
                                       ItermSnapshot, ScreenSnapshot)
from everwatch.history import USAGE_FILENAME, TransitionLog, UsageHistory
from everwatch.notify_policy import NotifyPolicy, QuotaGate, gmail_draft_url
from everwatch.sources import base

LOG = logging.getLogger('everwatch.engine')

SUBSCRIBER_QUEUE_SIZE = 64
COMMAND_TIMEOUT = 5.0
TICK_SECONDS = 1.0
USAGE_REBUILD_SECONDS = 30
LABEL_MAX_LEN = 80
PROJECT_NAME_MAX_LEN = 40
HISTORY_MAX_MINUTES = 120

TAB_COLORS_UNKNOWN = 'unknown'
TAB_COLORS_AVAILABLE = 'available'
TAB_COLORS_NOT_INSTALLED = 'not_installed'
TAB_COLORS_API_DISABLED = 'api_disabled'
TAB_COLORS_ERROR = 'error'

Event = namedtuple('Event', 'type id data')


class CommandError(Exception):
    """A command was rejected. `status` is the HTTP status WP3 should
    return; `code` goes in the JSON body as `error`."""

    def __init__(self, code, detail='', status=400):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.code = code
        self.detail = detail
        self.status = status


@dataclass(frozen=True)
class PublishedState:
    rev: int
    state: dict                    # full State (includes `screens`)
    public: dict                   # State without `screens` (SSE `state`)
    hashes: dict = field(default_factory=dict)  # uid -> screen_hash

    def screen(self, uid):
        text = self.state.get('screens', {}).get(uid)
        if text is None:
            return None
        return {'uid': uid, 'text': text, 'screen_hash': self.hashes.get(uid)}

    def to_json(self, include_screens=True, indent=None):
        return state_json(self.state if include_screens else self.public,
                          indent=indent)


def state_json(state, indent=None):
    """Canonical serialization: sorted keys, UTF-8 text. Same input ->
    byte-identical output (the DemoSource determinism contract)."""
    if indent is None:
        return json.dumps(state, sort_keys=True, ensure_ascii=False,
                          separators=(',', ':'))
    return json.dumps(state, sort_keys=True, ensure_ascii=False,
                      indent=indent)


def _r(t):
    return round(t, 3) if isinstance(t, float) else t


class Subscription:
    """One consumer's bounded event queue. On overflow the backlog is
    dropped and replaced by a fresh `state` + full `screens`, so a slow
    client never blocks the engine (§3.3)."""

    def __init__(self, maxsize=SUBSCRIBER_QUEUE_SIZE):
        self._q = queue.Queue(maxsize=maxsize)
        self.overflows = 0
        self.closed = False

    def get(self, timeout=None):
        """Next Event, or None on timeout / after close."""
        if self.closed and self._q.empty():
            return None
        try:
            return self._q.get(timeout=timeout)
        except queue.Empty:
            return None

    def pending(self):
        return self._q.qsize()

    def _put_fresh(self, fresh):
        for ev in fresh:
            self._q.put_nowait(ev)

    def offer(self, event, fresh_fn):
        if self.closed:
            return
        try:
            self._q.put_nowait(event)
        except queue.Full:
            self.overflows += 1
            while True:
                try:
                    self._q.get_nowait()
                except queue.Empty:
                    break
            self._put_fresh(fresh_fn())

    def close(self):
        self.closed = True


class _InboxAdapter:
    """Lets the ported pollers `put(('kind', snap))` into the engine inbox."""

    def __init__(self, inbox):
        self._inbox = inbox

    def put(self, item):
        kind, payload = item
        self._inbox.put(('event', kind, payload))


# ---------------------------------------------------------------- drivers

class SourceItermWorker(pollers.ItermWorker):
    """ItermWorker with every osascript call routed through a DataSource
    and timestamps from the injected clock. Actions carry an id so the
    result can be matched to the request (`action_result`).

    W-10 live preview: between full snapshots it also re-reads just the
    sessions in `live_box` (the ones a client holds a live lease on)
    every `live_interval` seconds -- same single worker, so iTerm2 still
    never receives concurrent Apple Events, and sessions nobody is
    watching keep the normal cadence."""

    def __init__(self, events, stop, source, clock,
                 live_interval=config.LIVE_INTERVAL, monotonic=time.monotonic):
        super().__init__(events, stop)
        self.source = source
        self.clock = clock
        self.live_box = pollers.LatestBox()
        self.live_interval = live_interval
        self._mono = monotonic

    def run(self):
        last_paths = None
        while not self.stop_evt.is_set():
            t0 = self._mono()
            self._poll_snapshot()
            if last_paths is None or \
                    self._mono() - last_paths >= self.paths_interval:
                self._poll_paths()
                last_paths = self._mono()
            elapsed = self._mono() - t0
            self.wait_between_polls(self._mono() + pollers.adaptive_wait(
                self.snapshot_interval, elapsed))

    def wait_between_polls(self, deadline):
        """Serve actions and live reads until the next full snapshot is
        due: `deadline`, a 'poll' kick, or right after any action (P-03).
        A 'wake' (the live set changed) reads the live sessions now."""
        live_due = self._mono() + self.live_interval
        while not self.stop_evt.is_set():
            now = self._mono()
            targets = self.live_box.get() or ()
            wake = min(deadline, live_due) if targets else deadline
            timeout = wake - now
            if timeout <= 0:
                if now >= deadline:
                    return
                self._poll_live(targets)
                elapsed = self._mono() - now
                live_due = self._mono() + pollers.adaptive_wait(
                    self.live_interval, elapsed)
                continue
            try:
                kind, args = self.actions.get(timeout=timeout)
            except queue.Empty:
                continue
            if kind == 'wake':
                live_due = self._mono()
                continue
            if kind == 'poll':
                return
            self._do_action(kind, args)
            return

    def _poll_live(self, targets):
        for snap in fetch_live_screens(self.source, targets, self.clock):
            self.events.put(('screen', snap))

    def _poll_snapshot(self):
        self.events.put(('iterm', fetch_snapshot_safely(self.source,
                                                        self.clock.now())))

    def _poll_paths(self):
        try:
            self.events.put(('paths',
                             self.source.fetch_paths(at=self.clock.now())))
        except Exception:
            pass  # engine keeps the last paths snapshot

    def _do_action(self, kind, args):
        aid, rest = args[0], args[1:]
        self.events.put(('action', run_action(self.source, kind, aid, rest)))


class SourceColorsPoller(pollers.ColorsPoller):
    """ColorsPoller that also reports availability (capabilities.tab_colors)
    and action results."""

    def __init__(self, events, stop, source):
        super().__init__(events, stop, fetch=source.fetch_colors,
                         set_color=source.set_color)

    def poll(self, now=None):
        if not self.available:
            return
        try:
            colors = self.fetch()
        except base.ColorApiUnavailable:
            self.available = False
            self.events.put(('colors_status', TAB_COLORS_NOT_INSTALLED))
            return
        except Exception as e:
            self.events.put(('colors_status', colors_error_status(e)))
            return
        self.events.put(('colors', ColorsSnapshot(
            colors=tuple(sorted(colors.items())), at=now or 0.0)))

    def request(self, aid, uid, color_name):
        self.actions.put(('set_color', (aid, uid, color_name)))

    def _do_action(self, kind, args):
        if kind != 'set_color':
            return
        aid, uid, color_name = args
        result = run_color_action(self.set_color, aid, uid, color_name)
        if result[3] == 'tab colors unavailable':
            self.available = False
            self.events.put(('colors_status', TAB_COLORS_NOT_INSTALLED))
        self.events.put(('action', result))


def fetch_live_screens(source, targets, clock):
    """Targeted reads for the live sessions -> [ScreenSnapshot]. A failed
    read is skipped: the next full snapshot reports iTerm2 trouble."""
    out = []
    for uid, hint in targets:
        try:
            text = source.fetch_screen(uid, hint)
        except Exception:
            continue
        out.append(ScreenSnapshot(uid=uid, text=text, at=clock.now()))
    return out


def fetch_snapshot_safely(source, now):
    try:
        return source.fetch_snapshot(at=now)
    except base.ItermNotRunning:
        return ItermSnapshot(not_running=True, at=now)
    except Exception as e:
        return ItermSnapshot(error=str(e) or type(e).__name__, at=now)


def run_action(source, kind, aid, args):
    """Run one iTerm2 action; returns (aid, kind, ok, detail)."""
    ok, detail = True, ''
    try:
        if kind == 'goto':
            ok = bool(source.goto(args[0]))
            if not ok:
                detail = 'session not found'
        elif kind == 'close':
            source.close_tab(args[0], args[1])
        elif kind == 'new':
            source.new_tab()
        elif kind == 'send':
            ok, detail = run_send(source, *args)
        else:
            ok, detail = False, f'unknown action {kind}'
    except Exception as e:
        ok, detail = False, str(e) or type(e).__name__
    return (aid, kind, ok, detail)


def run_send(source, uid, items, hint, expect_hash=None):
    """W-10 send, on the worker. With `expect_hash`, re-read the session
    first and refuse if its screen changed since the user looked (the
    snapshot the UI rendered can be seconds old). -> (ok, detail)"""
    if expect_hash is not None:
        current = source.fetch_screen(uid, hint)
        if current is None:
            return False, 'session not found'
        if H.text_hash(current) != expect_hash:
            return False, 'the screen changed since you looked; not sent'
    if not source.send_input(uid, items, hint=hint):
        return False, 'session not found'
    return True, ''


def run_color_action(set_color, aid, uid, color_name):
    try:
        ok = bool(set_color(uid, color_name))
        return (aid, 'color', ok, '' if ok else 'session not found')
    except base.ColorApiUnavailable:
        return (aid, 'color', False, 'tab colors unavailable')
    except Exception as e:
        return (aid, 'color', False, str(e) or type(e).__name__)


def colors_error_status(exc):
    """Transient color-poll failure -> capabilities.tab_colors. A refused
    connection means iTerm2's Python API is switched off."""
    if isinstance(exc, (ConnectionRefusedError, FileNotFoundError)):
        return TAB_COLORS_API_DISABLED
    return TAB_COLORS_ERROR


class InlineDriver:
    """Synchronous, clock-scheduled polling (demo, fake, tests)."""

    inline = True

    def __init__(self, engine):
        self.engine = engine
        self.source = engine.source
        self.events = _InboxAdapter(engine._inbox)
        self.agents_box = pollers.LatestBox()
        self.due = {'agents': None, 'paths': None, 'iterm': None,
                    'colors': None, 'live': None}
        self.force = set()
        self.colors_available = True
        self.live = ()
        self.live_interval = config.LIVE_INTERVAL
        self.usage = [
            pollers.UsagePoller('usage_claude', self.events, None,
                                self.agents_box, 'claude',
                                self.source.usage_claude,
                                config.USAGE_REFRESH_INTERVAL),
            pollers.UsagePoller('usage_codex', self.events, None,
                                self.agents_box, 'codex',
                                self.source.usage_codex,
                                config.CODEX_USAGE_REFRESH_INTERVAL),
        ]
        self.usage_due = None
        self.usage_forced = False

    def start(self):
        pass

    def stop(self):
        pass

    def _is_due(self, key, now, interval):
        due = self.due[key]
        if key in self.force or due is None or now >= due:
            self.force.discard(key)
            self.due[key] = now + interval
            return True
        return False

    @property
    def pending_force(self):
        return bool(self.force)

    def pump(self, now):
        eng = self.engine
        if self._is_due('agents', now, config.AGENTS_INTERVAL):
            try:
                ttys = self.source.agent_ttys()
            except Exception:
                ttys = {}
            needs = eng._needs_cwd or ()
            cwds = {}
            if needs:
                try:
                    cwds = self.source.tty_cwds(needs)
                except Exception:
                    cwds = {}
            snap = AgentSnapshot(
                ttys=tuple((t, frozenset(a)) for t, a in sorted(ttys.items())),
                tty_cwd=tuple(sorted(cwds.items())), at=now)
            self.agents_box.set(snap)
            self.events.put(('agents', snap))
        if self._is_due('paths', now, config.PATHS_INTERVAL):
            try:
                self.events.put(('paths', self.source.fetch_paths(at=now)))
            except Exception:
                pass
        if self._is_due('iterm', now, config.SNAPSHOT_INTERVAL):
            self.events.put(('iterm', fetch_snapshot_safely(self.source, now)))
            # a full snapshot just read every live session too
            self.force.discard('live')
            self.due['live'] = now + self.live_interval
        elif self.live and self._is_due('live', now, self.live_interval):
            for snap in fetch_live_screens(self.source, self.live,
                                           self.engine.clock):
                self.events.put(('screen', snap))
        if self.colors_available and \
                self._is_due('colors', now, config.COLOR_INTERVAL):
            try:
                colors = self.source.fetch_colors()
            except base.ColorApiUnavailable:
                self.colors_available = False
                self.events.put(('colors_status', TAB_COLORS_NOT_INSTALLED))
            except Exception as e:
                self.events.put(('colors_status', colors_error_status(e)))
            else:
                self.events.put(('colors', ColorsSnapshot(
                    colors=tuple(sorted(colors.items())), at=now)))
        if self.usage_forced or self.usage_due is None or \
                now >= self.usage_due:
            forced, self.usage_forced = self.usage_forced, False
            self.usage_due = now + pollers.UsagePoller.GATE_INTERVAL
            for poller in self.usage:
                poller.poll(now=now, forced=forced)

    def action(self, kind, aid, args):
        self.events.put(('action', run_action(self.source, kind, aid, args)))
        self.force.add('iterm')

    def set_color(self, aid, uid, color_name):
        result = run_color_action(self.source.set_color, aid, uid, color_name)
        if result[3] == 'tab colors unavailable':
            self.colors_available = False
            self.events.put(('colors_status', TAB_COLORS_NOT_INSTALLED))
        self.events.put(('action', result))
        self.force.add('colors')

    def kick_all(self):
        self.force.update(self.due)
        self.usage_forced = True

    def set_needs_cwd(self, ttys):
        pass  # read directly from engine._needs_cwd at pump time

    def set_live(self, targets):
        if {u for u, _ in targets} - {u for u, _ in self.live}:
            self.force.add('live')  # a newly watched session: read it now
        self.live = targets


class ThreadedDriver:
    """The ported poller threads, routed through the DataSource (real)."""

    inline = False
    pending_force = False

    def __init__(self, engine):
        self.engine = engine
        src = engine.source
        events = _InboxAdapter(engine._inbox)
        self.stop_evt = threading.Event()
        self.needs_cwd_box = pollers.LatestBox()
        self.agents_box = pollers.LatestBox()
        self.pollers = {
            'iterm': SourceItermWorker(events, self.stop_evt, src,
                                       engine.clock),
            'agents': pollers.AgentsPoller(
                events, self.stop_evt, self.needs_cwd_box, self.agents_box,
                scan=src.agent_ttys, fill=src.tty_cwds),
            'colors': SourceColorsPoller(events, self.stop_evt, src),
            'usage_claude': pollers.UsagePoller(
                'usage_claude', events, self.stop_evt, self.agents_box,
                'claude', src.usage_claude, config.USAGE_REFRESH_INTERVAL),
            'usage_codex': pollers.UsagePoller(
                'usage_codex', events, self.stop_evt, self.agents_box,
                'codex', src.usage_codex,
                config.CODEX_USAGE_REFRESH_INTERVAL),
        }

    def start(self):
        for name in ('agents', 'iterm', 'colors', 'usage_claude',
                     'usage_codex'):
            self.pollers[name].start()

    def stop(self):
        self.stop_evt.set()

    def pump(self, now):
        pass

    def action(self, kind, aid, args):
        self.pollers['iterm'].request(kind, aid, *args)

    def set_color(self, aid, uid, color_name):
        self.pollers['colors'].request(aid, uid, color_name)

    def kick_all(self):
        pollers.kick_all(self.pollers)

    def set_needs_cwd(self, ttys):
        self.needs_cwd_box.set(ttys)

    def set_live(self, targets):
        worker = self.pollers['iterm']
        before = {u for u, _ in (worker.live_box.get() or ())}
        worker.live_box.set(targets)
        if {u for u, _ in targets} - before:
            worker.request('wake')


# ----------------------------------------------------------------- engine

HELLO_CONFIG = {
    'snapshot_interval': config.SNAPSHOT_INTERVAL,
    'paths_interval': config.PATHS_INTERVAL,
    'agents_interval': config.AGENTS_INTERVAL,
    'usage_interval': config.USAGE_REFRESH_INTERVAL,
    'codex_usage_interval': config.CODEX_USAGE_REFRESH_INTERVAL,
    'colors_interval': config.COLOR_INTERVAL,
    'stale_after': 4 * config.SNAPSHOT_INTERVAL,
    'toast_seconds': config.TOAST_SECONDS,
    'flash_seconds': config.FLASH_SECONDS,
    'fresh_seconds': config.FRESH_SECONDS,
    'label_gc_days': config.LABEL_GC_DAYS,
    'live_interval': config.LIVE_INTERVAL,
    'live_lease': config.LIVE_LEASE_SECONDS,
}


# ---------------------------------------------- diagnostics readiness (WP7)

#: `everwatch doctor`/`everwatch state` (non-demo, cli.py) need one real
#: result for each of the facts below before their one-shot output means
#: anything; give up and show whatever's known after this many seconds.
DIAG_READY_TIMEOUT = 12.0


def poll_until(predicate, timeout, *, sleep=time.sleep, now=time.monotonic,
               interval=0.05, on_waiting=None, before=None):
    """Generic "wait for predicate() or timeout" loop, deliberately
    decoupled from any engine or real I/O so its own timing is directly
    unit-testable with fake `sleep`/`now` callables -- nothing that uses
    this ever has to sleep for real (or touch real I/O) to prove the
    timeout/`on_waiting` behavior. `before`, if given, runs once per
    iteration ahead of the predicate check -- a non-threaded caller's hook
    to pump itself, since nothing else would. `on_waiting` (if given)
    fires at most once, the first time `predicate()` is about to make this
    loop actually wait. Returns whether `predicate()` ever came back true.
    """
    start = now()
    warned = False
    while True:
        if before is not None:
            before()
        if predicate():
            return True
        if now() - start >= timeout:
            return False
        if not warned and on_waiting is not None:
            on_waiting()
            warned = True
        sleep(interval)


def diagnostics_ready(engine):
    """True once `engine` has a first real result for every fact
    `doctor`'s (and `state`'s) one-shot real pass needs: an iTerm2
    snapshot, an agents poll, a tab-colors capability result, and a usage
    attempt for each provider. Each field starts at a known "not yet"
    sentinel, and `_on_event`/`_on_iterm` always move it away on the very
    first result -- success or failure alike -- so this never blocks
    forever on a check that would stay `unknown` regardless."""
    return (engine._iterm_status != base.STATUS_CONNECTING and
            engine._agents is not None and
            engine._tab_colors != TAB_COLORS_UNKNOWN and
            engine._usage['claude'] is not None and
            engine._usage['codex'] is not None)


def wait_for_first_results(engine, timeout=DIAG_READY_TIMEOUT,
                           sleep=time.sleep, now=time.monotonic,
                           on_waiting=None):
    """Block until `diagnostics_ready(engine)`, or `timeout` seconds
    elapse -- whichever comes first. `timeout` is deliberately measured on
    a real (or, in tests, fake) wall clock via `now`/`sleep`, never on
    `engine.clock`: a real caller may itself be running under a fixed/
    virtual `--clock` override, and this still has to give up after an
    actual `timeout` seconds of real waiting on its background threads,
    not zero (a clock that never advances would otherwise make this loop
    forever). Both `sleep` and `now` are injectable so tests never wait
    for real.

    If `engine` has no running background thread (it was never
    `.start()`-ed -- every existing engine test, and any caller that wants
    to pump synchronously instead), each iteration also calls
    `engine.step()` directly: an InlineDriver engine (demo/fake/tests) is
    always fully ready after its very first pump, so this returns True
    immediately in that case, with no sleeping at all. A real
    `ThreadedDriver` engine needs its own poller threads (already started
    by the caller, via `engine.start()`) to report in asynchronously, so
    this only polls and waits for them. Returns whether it became ready.
    """

    def _pump():
        if not engine.running:
            engine.step(publish=False)

    return poll_until(lambda: diagnostics_ready(engine), timeout,
                      sleep=sleep, now=now, before=_pump,
                      on_waiting=on_waiting)


class Engine:
    def __init__(self, source, clock=None, *, store=None, home=None,
                 threaded=None, my_tty=None, quota_gate=None,
                 notify_policy=None, usage_history=None, debug_state=None,
                 shell=None, started=None, path_home=None,
                 diag_probes=None, colors_installer=None,
                 restart_callback=None, demo_diag_preset=None):
        self.source = source
        self.clock = clock or SystemClock()
        self.mode = getattr(source, 'mode', 'real')
        now = self.clock.now()
        self.started = now if started is None else started
        home = home or config.EVERWATCH_HOME
        self.home = home
        self.store = store if store is not None else persist.StateStore(
            path=os.path.join(home, 'state.json'), now=now)
        self.usage_history = usage_history if usage_history is not None \
            else UsageHistory(os.path.join(home, USAGE_FILENAME), now)
        self.tracker = H.SessionTracker()
        self.transitions = TransitionLog()
        self.notify = notify_policy or NotifyPolicy()
        self.quota_gate = quota_gate or QuotaGate()
        self.my_tty = config.MY_TTY if my_tty is None else my_tty
        self.path_home = path_home or config.HOME  # for ~-shortening
        self.env_debug_state = config.DEBUG_STATE if debug_state is None \
            else debug_state
        self.shell = (os.environ.get('EVERWATCH_SHELL') == '1'
                      if shell is None else shell)

        # last-good inputs
        self._snapshot = None
        self._iterm_status = base.STATUS_CONNECTING
        self._iterm_error = ''
        self._paths = {}
        self._agents = None
        self._tty_cwd = {}      # last-known lsof cwd per tty (P-06)
        self._colors = {}
        self._tab_colors = TAB_COLORS_UNKNOWN
        self._usage = {'claude': None, 'codex': None}
        self._usage_good_at = {'claude': 0, 'codex': 0}
        self._usage_cache = None
        self._usage_cache_key = None
        self._usage_built_at = None
        self._needs_cwd = frozenset()
        self._live = {}          # uid -> lease expiry, most recent last
        self._live_targets = ()  # last pushed to the driver
        self.quota_prompt = None
        self._quota_cfg = None

        # diagnostics + colors installer (WP7, docs/DESIGN.md §4.2, §7)
        self.diag_probes = diag_probes or diagnostics.Probes()
        self.colors_installer = colors_installer or installer.ColorsInstaller()
        self._restart_cb = restart_callback
        self._demo_diag_preset = demo_diag_preset
        self._diag_active = False       # lazy: true once first requested
        self._diagnostics = None
        self._diag_fingerprint = None
        self._probe_cache = {}
        self._install_progress = {}
        self._install_running = False

        # engine plumbing
        self._inbox = queue.Queue()
        self._pending_events = []
        self._action_seq = 0
        self._rev = 0
        self._fingerprint = None
        self._last_hashes = {}
        self._subs = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self.published = None

        if threaded is None:
            threaded = self.mode == 'real'
        self.driver = ThreadedDriver(self) if threaded else InlineDriver(self)
        self._publish(now, force=True)

    # ------------------------------------------------------ lifecycle

    @property
    def running(self):
        return self._thread is not None and self._thread.is_alive()

    def set_restart_callback(self, callback):
        """Called (from a short-lived helper thread, once) after a
        successful `colors_install`. The CLI wires this to its
        `stop_event.set`, so the process exits gracefully and the
        shell's supervisor -- or, in a dev checkout, a person re-running
        `everwatch serve` -- restarts it on the venv's python, which
        `PythonLocator` already prefers (shell/README.md)."""
        self._restart_cb = callback

    def start(self):
        if self.running:
            return
        self._stop.clear()
        self.driver.start()
        self._thread = threading.Thread(target=self._run, name='engine',
                                        daemon=True)
        self._thread.start()

    def stop(self, timeout=2.0):
        self._stop.set()
        self.driver.stop()
        self._inbox.put(('wake',))
        if self._thread is not None:
            self._thread.join(timeout)
            self._thread = None
        if self.store.dirty:
            self.store.save()
        with self._lock:
            for sub in self._subs:
                sub.close()
            self._subs.clear()

    def _run(self):
        while not self._stop.is_set():
            try:
                item = self._inbox.get(timeout=0.25 if self.driver.inline
                                       else TICK_SECONDS)
                self._handle(item)
            except queue.Empty:
                pass
            if self._stop.is_set():
                break
            try:
                self.step()
            except Exception:  # pragma: no cover - defensive; keep serving
                import logging
                logging.getLogger('everwatch').exception('engine step failed')

    def step(self, publish=True):
        """One engine pass: pump the inline driver, drain the inbox, tick,
        and publish. Must run on the engine thread (or in a test with no
        engine thread running)."""
        now = self.clock.now()
        self.driver.pump(now)
        self._drain()
        if self.driver.pending_force:
            self.driver.pump(now)
            self._drain()
        self._tick(now)
        if publish:
            self._publish(now)

    def _drain(self):
        while True:
            try:
                item = self._inbox.get_nowait()
            except queue.Empty:
                return
            self._handle(item)

    def _handle(self, item):
        if item[0] == 'event':
            self._on_event(item[1], item[2])
        elif item[0] == 'cmd':
            _, kind, kwargs, future = item
            if not future.set_running_or_notify_cancel():
                return
            try:
                future.set_result(self._run_command(kind, kwargs))
            except Exception as e:
                future.set_exception(e)

    # ------------------------------------------------------- commands

    def submit(self, kind, **kwargs):
        future = concurrent.futures.Future()
        self._inbox.put(('cmd', kind, kwargs, future))
        return future

    def call(self, kind, timeout=COMMAND_TIMEOUT, **kwargs):
        """Submit and wait. Without a running engine thread (tests), the
        command runs synchronously via step()."""
        future = self.submit(kind, **kwargs)
        if not self.running:
            self.step()
        return future.result(timeout=timeout)

    def _run_command(self, kind, kwargs):
        handler = getattr(self, f'_cmd_{kind}', None)
        if handler is None:
            raise CommandError('unknown_command', kind, 400)
        try:
            return handler(**kwargs)
        except TypeError as e:
            raise CommandError('bad_arguments', str(e), 400) from e

    def _next_action_id(self):
        self._action_seq += 1
        return f'a{self._action_seq}'

    def _require_session(self, uid):
        if not self._session_info(uid):
            raise CommandError('unknown_session', uid, 404)

    def _session_info(self, uid):
        if self._snapshot:
            for s in self._snapshot.sessions:
                if s.uid == uid:
                    return s
        return None

    def _cmd_goto(self, uid):
        self._require_session(uid)
        aid = self._next_action_id()
        self.driver.action('goto', aid, (uid,))
        return {'id': aid}

    def _cmd_send(self, uid, body):
        """W-10: type into a session. Validation (terminput) first, so a
        malformed request never reaches the driver."""
        try:
            items = terminput.parse_send(body)
            expect = terminput.expected_hash(body)
        except terminput.InputError as e:
            raise CommandError(e.code, e.detail, 400) from None
        s = self._session_info(uid)
        if not s:
            raise CommandError('unknown_session', uid, 404)
        if self.my_tty and s.tty == self.my_tty:
            raise CommandError('self_session',
                               "won't type into Everwatch's own tab", 409)
        aid = self._next_action_id()
        # Audit trail in backend.log: what kind of input went where --
        # never the text itself (it may be a password typed at a prompt).
        LOG.info('send %s uid=%s tab=%s.%s %s%s', aid, uid, s.window_id,
                 s.tab_index, ' '.join(
                     f'text[{len(v)}]' if k == 'text' else f'key:{v}'
                     for k, v in items),
                 ' (checked)' if expect is not None else '')
        self.driver.action('send', aid, (uid, items, (
            s.window_id, s.tab_index, s.session_index), expect))
        return {'id': aid}

    def _cmd_live(self, uid, on=True):
        """W-10: take/renew (on) or drop a live-preview lease. Leases
        expire after LIVE_LEASE_SECONDS unless renewed; at most
        LIVE_MAX_SESSIONS are live (the least recently renewed goes).
        Best-effort: a session that just vanished (the client's view can
        lag a poll behind) is simply not live, not an error."""
        if on and self._session_info(uid):
            self._live.pop(uid, None)
            self._live[uid] = self.clock.now() + config.LIVE_LEASE_SECONDS
            while len(self._live) > config.LIVE_MAX_SESSIONS:
                del self._live[next(iter(self._live))]
        else:
            self._live.pop(uid, None)
        self._push_live()
        return {'ok': True, 'live': uid in self._live,
                'interval': config.LIVE_INTERVAL,
                'lease': config.LIVE_LEASE_SECONDS}

    def _push_live(self):
        """Hand the driver (uid, location hint) for every live session in
        the current snapshot, when that changed."""
        targets = []
        for uid in self._live:
            s = self._session_info(uid)
            if s:
                targets.append((uid, (s.window_id, s.tab_index,
                                      s.session_index)))
        targets = tuple(targets)
        if targets != self._live_targets:
            self._live_targets = targets
            self.driver.set_live(targets)

    def _expire_live(self, now):
        expired = [u for u, until in self._live.items() if until <= now]
        for uid in expired:
            del self._live[uid]
        if expired:
            self._push_live()

    def _cmd_visit(self, uid):
        self._require_session(uid)
        self.tracker.visit(uid)
        return {'ok': True}

    def _cmd_set_label(self, uid, label):
        if not isinstance(label, str):
            raise CommandError('invalid_label', 'label must be a string')
        self._require_session(uid)
        label = ' '.join(label.split())[:LABEL_MAX_LEN]
        self.store.set_label(uid, label, now=self.clock.now())
        return {'ok': True}

    def _cmd_set_color(self, uid, slot):
        if slot is not None and (isinstance(slot, bool) or
                                 not isinstance(slot, int) or
                                 not 1 <= slot <= len(model.PROJECT_COLORS)):
            raise CommandError('invalid_slot', 'slot must be 1-5 or null')
        self._require_session(uid)
        if self._tab_colors in (TAB_COLORS_NOT_INSTALLED,
                                TAB_COLORS_API_DISABLED):
            raise CommandError('tab_colors_unavailable', self._tab_colors,
                               409)
        color = model.PROJECT_COLORS[slot - 1] if slot else None
        aid = self._next_action_id()
        self.driver.set_color(aid, uid, color)
        return {'id': aid}

    def _cmd_new_tab(self):
        aid = self._next_action_id()
        self.driver.action('new', aid, ())
        return {'id': aid}

    def _cmd_close_tab(self, window_id, tab_index):
        for v in (window_id, tab_index):
            if isinstance(v, bool) or not isinstance(v, int):
                raise CommandError('invalid_tab', 'ids must be integers')
        aid = self._next_action_id()
        self.driver.action('close', aid, (window_id, tab_index))
        return {'id': aid}

    def _cmd_refresh(self):
        self.driver.kick_all()
        return {'ok': True}

    def _cmd_set_prefs(self, patch):
        clean, rejected = persist.normalize_prefs_patch(patch)
        if rejected:
            raise CommandError('invalid_prefs', ', '.join(rejected), 400)
        now = self.clock.now()
        for key, value in clean.items():
            self.store.set(key, value, now=now)
        return self.store.prefs()

    def _cmd_set_project(self, n, name):
        if isinstance(n, bool) or not isinstance(n, int) or \
                not 1 <= n <= persist.PROJECT_SLOTS:
            raise CommandError('invalid_project', 'n must be 1-5')
        if not isinstance(name, str):
            raise CommandError('invalid_project', 'name must be a string')
        name = ' '.join(name.split())[:PROJECT_NAME_MAX_LEN]
        self.store.set_project(n, name, now=self.clock.now())
        return {'ok': True}

    def _cmd_clear_projects(self):
        self.store.clear_projects(now=self.clock.now())
        return {'ok': True}

    def _cmd_history(self, uid=None, minutes=60):
        try:
            minutes = float(minutes)
        except (TypeError, ValueError):
            raise CommandError('invalid_minutes', str(minutes)) from None
        minutes = max(1.0, min(float(HISTORY_MAX_MINUTES), minutes))
        now = self.clock.now()
        out = {'transitions': [
            dict(t, at=_r(t['at'])) for t in
            self.transitions.transitions(uid=uid, since=now - minutes * 60)]}
        if uid:
            state, since, _rule = self.tracker.state(uid)
            out['stats'] = self.transitions.wait_stats(
                uid, state, since, now, window=minutes * 60)
        return out

    def _cmd_usage_history(self, since=0.0):
        try:
            since = float(since or 0)
        except (TypeError, ValueError):
            raise CommandError('invalid_since', str(since)) from None
        return {'samples': self.usage_history.since(since)}

    def _cmd_quota_draft(self):
        if not self.quota_prompt:
            raise CommandError('no_quota_prompt', '', 409)
        url = gmail_draft_url(self._quota_cfg)
        opened = False
        if url:
            self.source.open_url(url)
            opened = True
        self._finish_quota()
        return {'ok': True, 'opened': opened}

    def _cmd_quota_skip(self):
        if not self.quota_prompt:
            raise CommandError('no_quota_prompt', '', 409)
        self._finish_quota()
        return {'ok': True}

    def _finish_quota(self):
        # Marks the month whichever button was chosen (P-69).
        self.quota_gate.mark(self.clock.now())
        self.quota_prompt = None
        self._quota_cfg = None

    def _cmd_import_ultrawatch(self, path=None):
        return self.store.import_ultrawatch(path=path, now=self.clock.now())

    def _cmd_launch_iterm(self):
        self.source.launch_iterm()
        return {'ok': True}

    # ------------------------------------------------- diagnostics (WP7)

    def _run_probes(self):
        p = self.diag_probes
        return {
            'python_version': p.python_version(),
            'iterm_installed': p.iterm_installed(),
            'claude_token_present': p.claude_token_present(),
            'codex_auth_present': p.codex_auth_present(),
            'quota_config': p.quota_config(),
            'ultrawatch_path': p.ultrawatch_path(),
        }

    def _diagnostics_inputs(self, now):
        probe = self._probe_cache or {}
        sessions = self._snapshot.sessions if self._snapshot else ()
        without_path = sum(1 for s in sessions
                           if not self._paths.get(s.uid))
        kinds = model.agent_kinds(self._agents)
        usage = self._usage_rows(now)
        inputs = diagnostics.DiagnosticsInputs(
            python_version=probe.get(
                'python_version', (sys.version_info.major,
                                   sys.version_info.minor)),
            iterm_installed=probe.get('iterm_installed', False),
            iterm_status=self._iterm_status,
            shell=self.shell,
            sessions_total=len(sessions),
            sessions_without_path=without_path,
            agents_count=len(kinds),
            claude_token_present=probe.get('claude_token_present', False),
            claude_usage_status=usage['claude']['status'],
            codex_auth_present=probe.get('codex_auth_present', False),
            codex_usage_status=usage['codex']['status'],
            tab_colors=self._tab_colors,
            quota_config=probe.get('quota_config'),
            ultrawatch_path=probe.get('ultrawatch_path'),
            ultrawatch_imported=(
                self.store.get('imported_from_ultrawatch') is not None),
            install_progress=dict(self._install_progress),
        )
        if self._demo_diag_preset:
            diagnostics.apply_preset(inputs, self._demo_diag_preset)
        return inputs

    def _refresh_diagnostics(self, now, force=False):
        d = diagnostics.build_diagnostics(self._diagnostics_inputs(now),
                                          now=_r(now))
        fp = state_json(d)
        changed = force or fp != self._diag_fingerprint
        self._diag_fingerprint = fp
        self._diagnostics = d
        if changed:
            self._emit('diagnostics', d)

    def _cmd_diagnostics(self):
        if not self._diag_active:
            self._diag_active = True
            self._probe_cache = self._run_probes()
            self._refresh_diagnostics(self.clock.now())
        return self._diagnostics

    def _cmd_diagnostics_recheck(self):
        self._diag_active = True
        self._probe_cache = self._run_probes()
        self._refresh_diagnostics(self.clock.now(), force=True)
        return self._diagnostics

    def _cmd_colors_install(self):
        if self._install_running:
            raise CommandError('install_in_progress',
                               'a tab-color install is already running', 409)
        self._diag_active = True
        self._install_running = True
        aid = self._next_action_id()
        t = threading.Thread(target=self._run_colors_install, args=(aid,),
                             name='colors-install', daemon=True)
        t.start()
        return {'id': aid}

    def _run_colors_install(self, aid):
        """Runs off the engine thread (installing can take a while); every
        step is handed back through the inbox like a poller event so the
        engine remains the single writer of `_install_progress` (§3.3)."""
        venv_dir = os.path.join(self.home, 'venv')
        ok, detail = True, ''
        try:
            for status, msg in self.colors_installer.install(venv_dir):
                self._inbox.put(('event', 'colors_install',
                                 {'status': status, 'detail': msg}))
                if status == 'error':
                    ok, detail = False, msg
                elif status == 'restart_required':
                    detail = msg
        except Exception as e:  # pragma: no cover - defensive
            ok, detail = False, str(e) or type(e).__name__
            self._inbox.put(('event', 'colors_install',
                             {'status': 'error', 'detail': detail}))
        self._inbox.put(('event', 'colors_install_done',
                         {'id': aid, 'ok': ok, 'detail': detail}))

    def _request_restart(self, delay=1.0):
        if not self._restart_cb:
            return

        def _fire():
            time.sleep(delay)
            self._restart_cb()

        threading.Thread(target=_fire, name='restart-delay',
                         daemon=True).start()

    # --------------------------------------------------------- events

    def _on_event(self, kind, snap):
        now = self.clock.now()
        if kind == 'iterm':
            self._on_iterm(snap, now)
        elif kind == 'screen':
            self._on_screen(snap)
        elif kind == 'paths':
            self._paths.update(dict(snap.paths))
        elif kind == 'colors':
            self._colors = dict(snap.colors)
            self._tab_colors = TAB_COLORS_AVAILABLE
        elif kind == 'colors_status':
            self._tab_colors = snap
        elif kind == 'agents':
            # Keep last-known lsof cwds: a poll only re-resolves the ttys
            # that lack iTerm2's `path` variable, and ultrawatch's
            # replace-the-whole-map behavior made those paths flicker.
            self._tty_cwd.update((t, c) for t, c in snap.tty_cwd if c)
            self._agents = AgentSnapshot(
                ttys=snap.ttys, tty_cwd=tuple(sorted(self._tty_cwd.items())),
                at=snap.at)
        elif kind in ('usage_claude', 'usage_codex'):
            self._on_usage(kind.split('_', 1)[1], snap, now)
        elif kind == 'action':
            aid, akind, ok, detail = snap
            self._emit('action_result', {'id': aid, 'kind': akind, 'ok': ok,
                                         'detail': detail})
        elif kind == 'colors_install':
            self._install_progress = dict(snap)
        elif kind == 'colors_install_done':
            self._install_running = False
            self._emit('action_result', {'id': snap['id'],
                                         'kind': 'colors_install',
                                         'ok': snap['ok'],
                                         'detail': snap['detail']})
            if snap['ok']:
                self._request_restart()

    def _on_iterm(self, snap, now):
        if snap.not_running:
            self._iterm_status, self._iterm_error = base.STATUS_NOT_RUNNING, ''
            return
        if snap.error:
            self._iterm_status = base.iterm_status_from_error(snap.error)
            self._iterm_error = snap.error
            return
        self._iterm_status, self._iterm_error = base.STATUS_OK, ''
        self._snapshot = snap
        transitions = self.tracker.update(
            snap.sessions, model.agent_kinds(self._agents), now)
        live = {s.uid for s in snap.sessions}
        live_ttys = {s.tty for s in snap.sessions}
        self._paths = {u: p for u, p in self._paths.items() if u in live}
        self._tty_cwd = {t: c for t, c in self._tty_cwd.items()
                         if t in live_ttys}
        self.store.touch_labels(
            [u for u in live if self.store.label(u)], now)
        for s in snap.sessions:
            self.transitions.observe(s.uid, now)
        self.transitions.forget(live)
        self.notify.forget(live)
        # ttys without iTerm2's `path` variable get an lsof cwd lookup on
        # every agents poll (so a `cd` there is picked up too).
        self._needs_cwd = frozenset(
            s.tty for s in snap.sessions
            if s.tty and not self._paths.get(s.uid))
        self.driver.set_needs_cwd(self._needs_cwd)
        self._push_live()
        if not transitions:
            return
        window_nos = model.window_numbers(snap.sessions)
        kinds = model.agent_kinds(self._agents)
        by_uid = {s.uid: s for s in snap.sessions}
        batch = []
        for uid, old, new in transitions:
            self.transitions.add(uid, old, new, now)
            s = by_uid[uid]
            title = self._title(s)
            self._emit('transition', {'uid': uid, 'from': old, 'to': new,
                                      'at': _r(now), 'title': title})
            kind_name = model.KIND_NAMES.get(kinds.get(s.tty), 'Session')
            batch.append({'uid': uid, 'to': new, 'title': title,
                          'body': f'{kind_name} · tab '
                                  f'{model.tab_label(s, window_nos)}'})
        for payload in self.notify.decide(
                batch, now, enabled=self.store.get('notify_on_waiting')):
            self._emit('notify', payload)

    def _on_screen(self, snap):
        """A live read: swap that session's text into the last snapshot,
        so the next publish carries it (new screen_hash -> `state` +
        `screens` events) exactly like a full poll would. Debounced
        agent state still comes only from full snapshots."""
        if snap.text is None or not self._snapshot or \
                snap.uid not in self._live:
            return
        sessions = self._snapshot.sessions
        for i, s in enumerate(sessions):
            if s.uid == snap.uid:
                if s.text != snap.text:
                    fresh = dataclasses.replace(s, text=snap.text)
                    self._snapshot = dataclasses.replace(
                        self._snapshot,
                        sessions=sessions[:i] + (fresh,) + sessions[i + 1:])
                return

    def _title(self, s):
        label = self.store.label(s.uid)
        path = model.shorten(model.session_path(s, self._paths, self._agents),
                             self.path_home)
        return model.row_title(s.uid, label, path, s.name)

    def _on_usage(self, which, snap, now):
        self._usage[which] = snap
        if snap.inactive:
            self._usage_good_at[which] = 0
        elif snap.ok and snap.data:
            self._usage_good_at[which] = now
        self._usage_cache = None
        if which == 'claude' and snap.data and self.quota_prompt is None:
            pct = model.extra_usage_pct(snap.data)
            if pct is not None:
                cfg = self.quota_gate.check(pct, now)
                if cfg:
                    email = cfg.get('email') if isinstance(
                        cfg.get('email'), dict) else {}
                    self._quota_cfg = cfg
                    self.quota_prompt = {'pct': pct,
                                         'to': email.get('to', ''),
                                         'month': self.quota_gate.month(now)}
                    self._emit('quota_prompt', dict(self.quota_prompt))

    def _emit(self, etype, data):
        self._pending_events.append((etype, data))

    # --------------------------------------------------- tick/publish

    def _tick(self, now):
        self.transitions.prune(now)
        self._expire_live(now)
        self.store.maybe_save(now)
        usage = self._usage_rows(now)
        sampled = {k: v for k, v in usage.items() if v['status'] == 'ok'}
        self.usage_history.maybe_sample(sampled, now)
        # Diagnostics only start ticking once first requested (a GET
        # /api/diagnostics or a recheck): every existing engine/test that
        # never asks for them never pays for -- or emits -- them.
        if self._diag_active:
            self._refresh_diagnostics(now)

    def _usage_rows(self, now):
        key = (self.store.get('show_dollars'),)
        if (self._usage_cache is None or key != self._usage_cache_key or
                now - self._usage_built_at >= USAGE_REBUILD_SECONDS or
                now < self._usage_built_at):
            self._usage_cache = model.build_usage(
                self._usage['claude'], self._usage['codex'],
                self._usage_good_at, self.store.get('show_dollars'), now)
            self._usage_cache_key = key
            self._usage_built_at = now
        return self._usage_cache

    def build_state(self, now):
        """The full State dict (docs/DESIGN.md §3.5) minus `rev`/`now`."""
        snap = self._snapshot

        def spark_for(uid, state, since):
            return self.transitions.spark(uid, state, since, now)

        sessions = model.build_sessions(
            snap, paths=self._paths, agents_snap=self._agents,
            colors=self._colors, tracker=self.tracker,
            label_for=self.store.label, home=self.path_home,
            my_tty=self.my_tty, spark_for=spark_for)
        for s in sessions:
            s['state_since'] = _r(s['state_since'])
            s['last_change'] = _r(s['last_change'])
        live = {s['uid'] for s in sessions}
        waiting = [u for u in self.tracker.waiting_uids() if u in live]
        usage = json.loads(json.dumps(self._usage_rows(now)))
        for section in usage.values():
            section['at'] = _r(section['at'])
            section['checked_at'] = _r(section['checked_at'])
        return {
            'started': _r(self.started),
            'version': __version__,
            'mode': self.mode,
            'debug_state': bool(self.env_debug_state or
                                self.store.get('debug_state')),
            'iterm': {'status': self._iterm_status,
                      'error': self._iterm_error,
                      'snapshot_at': _r(snap.at) if snap else 0},
            'counts': model.counts(sessions, len(waiting)),
            'waiting_order': waiting,
            'sessions': sessions,
            'screens': {s.uid: s.text for s in snap.sessions} if snap else {},
            'usage': usage,
            'projects': model.build_projects(
                self.store.get('projects'), self.store.get('projects_open'),
                sessions),
            'prefs': self.store.prefs(),
            'capabilities': {'tab_colors': self._tab_colors,
                             'shell': self.shell,
                             'notifications': 'unknown'},
            'quota_prompt': dict(self.quota_prompt) if self.quota_prompt
            else None,
        }

    def _publish(self, now, force=False):
        body = self.build_state(now)
        # Screens are covered by each session's screen_hash, so leave the
        # (large) text out of the change check.
        fingerprint = state_json({k: v for k, v in body.items()
                                  if k != 'screens'})
        changed = force or fingerprint != self._fingerprint
        events = self._pending_events
        self._pending_events = []
        if not changed and not events:
            return False
        out = []
        if changed:
            self._fingerprint = fingerprint
            self._rev += 1
            state = dict(body, rev=self._rev, now=_r(now))
            public = {k: v for k, v in state.items() if k != 'screens'}
            hashes = {s['uid']: s['screen_hash'] for s in state['sessions']}
            changed_screens = {u: state['screens'][u] for u, h in
                               hashes.items()
                               if self._last_hashes.get(u) != h and
                               u in state['screens']}
            self._last_hashes = hashes
            published = PublishedState(rev=self._rev, state=state,
                                       public=public, hashes=hashes)
            out.append(Event('state', self._rev, public))
            if changed_screens:
                out.append(Event('screens', self._rev,
                                 {'rev': self._rev,
                                  'screens': changed_screens}))
        else:
            published = self.published
        for etype, data in events:
            out.append(Event(etype, published.rev, data))
        with self._lock:
            self.published = published
            for sub in list(self._subs):
                for ev in out:
                    sub.offer(ev, self._fresh_events)
        return True

    # ----------------------------------------------------- subscribers

    def _fresh_events(self):
        pub = self.published
        return [Event('state', pub.rev, pub.public),
                Event('screens', pub.rev,
                      {'rev': pub.rev, 'screens': dict(pub.state['screens'])})]

    def hello(self):
        pub = self.published
        return {'version': __version__, 'config': dict(HELLO_CONFIG),
                'state': pub.state}

    def subscribe(self, initial='hello', maxsize=SUBSCRIBER_QUEUE_SIZE):
        """Register a consumer. initial='hello' queues a `hello` event
        (full state incl. screens) first; 'state' queues a fresh `state` +
        full `screens` (for a reconnect with Last-Event-ID); None queues
        nothing. Registration and the initial event are atomic with
        respect to publishing, so no update is missed."""
        sub = Subscription(maxsize=maxsize)
        with self._lock:
            if initial == 'hello':
                sub.offer(Event('hello', self.published.rev, self.hello()),
                          self._fresh_events)
            elif initial == 'state':
                for ev in self._fresh_events():
                    sub.offer(ev, self._fresh_events)
            self._subs.add(sub)
        return sub

    def unsubscribe(self, sub):
        with self._lock:
            self._subs.discard(sub)
        sub.close()

    @property
    def subscriber_count(self):
        with self._lock:
            return len(self._subs)
