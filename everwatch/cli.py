"""The `everwatch` command (docs/DESIGN.md §3.1, §4.1, §7 WP3 row).

`main()` never calls `subprocess`, never spawns a child process, and
never touches a real display or browser: everything that would (opening
a browser, installing signal handlers) is a thin, mockable call so
tests can drive the whole CLI in-process. Signal handlers are skipped
outside the main thread, which is what lets tests run `main()` on a
background thread against an `os.pipe()` standing in for the shell's
parent pipe (docs/DESIGN.md §3.1 handshake).
"""
import argparse
import json
import os
import plistlib
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.request
import webbrowser

from everwatch import __version__, diagnostics, installer, logs
from everwatch.clock import SystemClock, parse_clock
from everwatch.engine_loop import Engine, wait_for_first_results
from everwatch.server import make_server
from everwatch.sources.demo import build_demo_engine
from everwatch.sources.real import RealSource

READY_PREFIX = 'EVERWATCH_READY'

STATUS_GLYPHS = {'ok': '✓', 'warn': '⚠', 'error': '✗',
                 'info': 'ℹ', 'unknown': '?'}

# sysexits.h EX_TEMPFAIL: the backend exits with this code (instead of the
# normal 0) after a requested restart -- currently only the tab-colors
# installer, once it finishes successfully (docs/build/wp7-handoff.md).
# shell/Sources/Core/BackendConfig.swift's `BackendExitCode.tempFail` must
# stay in sync with this: the Swift supervisor restarts immediately on
# this code without counting it toward its crash backoff.
EX_TEMPFAIL = 75

# docs/DESIGN.md §4.3 / shell/Info.plist CFBundleIdentifier.
BUNDLE_ID = 'io.github.burnsbert.everwatch'

# `everwatch update` downloads this and execs it with --yes (docs/DESIGN.md
# §4.1's "Update" row). Kept as a module-level constant so tests can assert
# it without needing a real network call.
INSTALL_SCRIPT_URL = ('https://raw.githubusercontent.com/burnsbert/'
                      'everwatch/main/install.sh')


def _print_checking():
    """`doctor`/`state`'s one real (non-demo) pass can take a moment
    (iTerm2 launching, a slow `security`/keychain prompt, ...); a single
    line on stderr (never stdout, which `--json` callers parse) so the
    command doesn't look hung."""
    sys.stderr.write('Checking…\n')
    sys.stderr.flush()


def _resolve_token(args):
    return (args.token or os.environ.get('EVERWATCH_TOKEN') or
            secrets.token_urlsafe(32))


# --- install-layout paths (install.sh's own layout, docs/DESIGN.md §4.1) ---
# Every one of these honors an env var override so `everwatch update`/
# `uninstall` tests never touch the real ~/Applications, the real
# ~/Library/Application Support/Everwatch, or the real ~/.local/bin (same
# override pattern EVERWATCH_HOME already uses everywhere else in this
# package) -- install.sh's own tests use --prefix for the same reason.
def _everwatch_home():
    return os.environ.get('EVERWATCH_HOME') or os.path.expanduser(
        '~/Library/Application Support/Everwatch')


def _app_dir():
    return os.environ.get('EVERWATCH_APP_DIR') or os.path.expanduser(
        '~/Applications')


def _bin_dir():
    return os.environ.get('EVERWATCH_BIN_DIR') or os.path.expanduser(
        '~/.local/bin')


def _shell_version_string():
    """`CFBundleShortVersionString (build CFBundleVersion)` read straight
    from the installed app's Info.plist with plistlib (no subprocess), or
    None if no app is installed. Used by `--version` and left for `everwatch
    doctor`/About-panel-style tooling to reuse."""
    plist_path = os.path.join(_app_dir(), 'Everwatch.app', 'Contents',
                              'Info.plist')
    try:
        with open(plist_path, 'rb') as f:
            data = plistlib.load(f)
    except (OSError, ValueError):
        return None
    short = data.get('CFBundleShortVersionString')
    build = data.get('CFBundleVersion')
    if not short:
        return None
    return f'{short} (build {build})' if build else str(short)


def _runtime_version_string():
    """The version recorded in `$EVERWATCH_HOME/runtime/current/VERSION`
    (written by install.sh), or None if there's no installed runtime (e.g.
    running from a checkout)."""
    version_path = os.path.join(_everwatch_home(), 'runtime', 'current',
                                'VERSION')
    try:
        with open(version_path, 'r') as f:
            return f.read().strip() or None
    except OSError:
        return None


def _version_string():
    lines = [f'everwatch {__version__}']
    runtime = _runtime_version_string()
    if runtime and runtime != __version__:
        lines.append(f'runtime: {runtime}')
    shell = _shell_version_string()
    if shell:
        lines.append(f'shell: {shell}')
    return '\n'.join(lines)


class _VersionAction(argparse.Action):
    """Like argparse's built-in `action='version'`, but the text is built
    fresh at parse time from `_version_string()` so `--version` can show the
    installed runtime/shell versions too (docs/DESIGN.md §7 P-77 row),
    instead of a fixed string baked in when the parser was built."""

    def __init__(self, option_strings, dest=argparse.SUPPRESS,
                nargs=0, **kwargs):
        super().__init__(option_strings, dest, nargs=nargs, **kwargs)

    def __call__(self, parser, namespace, values, option_string=None):
        sys.stdout.write(_version_string() + '\n')
        parser.exit()


def _confirm(stdin, stdout, prompt):
    """Reads one line from `stdin`; true only for an explicit y/yes, so a
    non-interactive or empty answer never confirms a destructive action."""
    stdout.write(prompt)
    if hasattr(stdout, 'flush'):
        stdout.flush()
    try:
        line = stdin.readline()
    except (OSError, ValueError):
        line = ''
    return line.strip().lower() in ('y', 'yes')


def _diag_kwargs(args):
    """Demo runs use fake, no-I/O diagnostics probes (the `all_ok`
    preset by default). `--demo-diagnostics <preset>` selects another
    scripted state without touching iTerm2, the keychain, or the network."""
    preset = getattr(args, 'demo_diagnostics', None)
    if not preset and not getattr(args, 'demo', False):
        return {}
    return {'diag_probes': diagnostics.FakeProbes(),
           'demo_diag_preset': preset or 'all_ok'}


def _selftest_runner(argv, timeout=None):
    """The `--selftest` colors installer's runner: every venv/pip step
    "succeeds" without spawning anything."""
    return 0, '', ''


def _selftest_kwargs(args):
    """`serve --selftest` (Everwatch.app's EVERWATCH_SELFTEST mode,
    scripts/shell_selftest.sh): demo data with nothing real behind it --
    fake diagnostics probes (no keychain, mdfind, or file probes) and a
    tab-colors installer whose venv/pip steps are no-ops, so
    `POST /api/colors/install` exercises the real exit-75 restart path
    without creating a venv or touching the network."""
    return {'diag_probes': diagnostics.FakeProbes(),
            'demo_diag_preset': args.demo_diagnostics or 'all_ok',
            'colors_installer': installer.ColorsInstaller(
                runner=_selftest_runner)}


def build_engine(args):
    """A ready-to-serve Engine: DemoSource (`--demo`/`--selftest`) or
    RealSource."""
    selftest = getattr(args, 'selftest', False)
    if args.demo or selftest:
        clock = parse_clock(args.clock) if args.clock else None
        kwargs = _selftest_kwargs(args) if selftest else _diag_kwargs(args)
        return build_demo_engine(seed=args.seed, clock=clock, **kwargs)
    clock = parse_clock(args.clock) if args.clock else SystemClock()
    return Engine(RealSource(), clock, **_diag_kwargs(args))


def _open_url(port, token):
    webbrowser.open(f'http://127.0.0.1:{port}/#t={token}')


def _launch_app():
    """Real `open -a` call that launches the installed Everwatch.app --
    used only by `cmd_app` outside tests. Every test patches this
    function directly instead (docs/DESIGN.md hard rule #2), the same
    pattern `_tccutil_reset`/`_download_install_script` already use for
    their own real-I/O call."""
    subprocess.run(['open', '-a',
                    os.path.join(_app_dir(), 'Everwatch.app')])


def _install_signal_handlers(stop_event):
    """Only meaningful in the main thread of a real process; tests run
    `main()` on a worker thread, where `signal.signal` would raise, so
    they rely on the parent-pipe watcher (or calling `stop_event.set()`
    directly) instead."""
    if threading.current_thread() is not threading.main_thread():
        return

    def _handle(signum, frame):
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _handle)
        except (ValueError, OSError):  # pragma: no cover - exotic platforms
            pass


def _watch_parent_pipe(stdin, stop_event):
    def _watch():
        try:
            while stdin.read(1):
                pass
        except (ValueError, OSError):
            pass
        stop_event.set()

    t = threading.Thread(target=_watch, name='parent-pipe', daemon=True)
    t.start()
    return t


def _run_server(engine, *, host, port, token, stdin, stdout, parent_pipe,
                open_browser, ping_seconds=None, sse_maxsize=None,
                stop_event=None):
    kwargs = {}
    if ping_seconds is not None:
        kwargs['ping_seconds'] = ping_seconds
    if sse_maxsize is not None:
        kwargs['sse_maxsize'] = sse_maxsize
    server = make_server(engine, token, host=host, port=port, **kwargs)
    actual_port = server.server_address[1]

    # Injectable so tests can trigger (or fake a KeyboardInterrupt from)
    # the wait below without needing a real signal or parent pipe.
    stop_event = stop_event if stop_event is not None else threading.Event()
    # A successful `colors install` (docs/DESIGN.md §4.2 check 9) needs
    # the backend to restart on the venv's python. The simplest robust
    # trigger: exit gracefully: a real launch is either supervised by
    # the shell (which restarts on any exit with backoff, and
    # PythonLocator now finds $EVERWATCH_HOME/venv/bin/python3 first --
    # shell/README.md), or is `everwatch open`/`demo`, whose
    # `_serve_until_stopped` loop restarts this same process in-place on
    # this exact exit code (browser mode has no supervisor of its own).
    # `everwatch serve` run bare in a terminal is the one case still
    # left to the user re-running it by hand. Tests that never install
    # colors never call this.
    restart_trigger = getattr(stop_event, 'set', None)
    if restart_trigger is not None:
        engine.set_restart_callback(restart_trigger)
    _install_signal_handlers(stop_event)
    if parent_pipe:
        _watch_parent_pipe(stdin, stop_event)

    stdout.write(f'{READY_PREFIX} {actual_port}\n')
    stdout.flush()
    logger, handler = logs.setup(redirect_stdio=True)

    engine.start()
    serve_thread = threading.Thread(target=server.serve_forever,
                                    name='http', daemon=True)
    serve_thread.start()
    if open_browser:
        try:
            _open_url(actual_port, token)
        except Exception:  # pragma: no cover - best-effort convenience
            logger.exception('failed to open browser')

    try:
        stop_event.wait()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
        engine.stop()
        logs.teardown(handler)
    # A tab-colors install's restart (docs/DESIGN.md §4.2 check 9) needs
    # to be distinguishable, on exit, from a real crash: the shell's
    # BackendSupervisor otherwise has no way to tell "restart immediately,
    # this was requested" from "count this toward the crash backoff"
    # (shell/README.md). `_install_progress` still shows the last colors
    # install's outcome here even though `engine.stop()` already ran, so
    # this needs no extra plumbing through the restart callback itself.
    restart_requested = engine._install_progress.get('status') == \
        'restart_required'
    return (EX_TEMPFAIL if restart_requested else 0), actual_port


def _serve_until_stopped(engine_factory, *, host, port, token, stdin,
                         stdout, open_browser):
    """Runs `_run_server` in a loop, restarting in-process whenever it
    exits `EX_TEMPFAIL` (the tab-colors installer's restart request --
    docs/build/wp7-handoff.md, `_run_server`'s own comment above). `open`/
    `demo` have no supervisor to do this the way the native shell's
    BackendSupervisor does for `serve` (which is untouched by this: the
    shell needs to actually see that exit code itself, e.g. to relaunch
    on the venv's python), so without this loop a browser-mode "Enable
    tab colors" would kill the server for good -- the user saw a `goto`
    failure and a stale page. Rebinds to the very first actual port and
    reuses the same token on every restart, so the browser tab's
    already-open SSE connection (everwatch/web/js/sse.mjs's reconnect
    backoff) just reconnects instead of needing a new URL. Only the very
    first pass opens a browser tab -- restarts are silent to the user
    beyond the SSE blip."""
    actual_port = port
    first_pass = True
    while True:
        engine = engine_factory()
        code, actual_port = _run_server(
            engine, host=host, port=actual_port, token=token, stdin=stdin,
            stdout=stdout, parent_pipe=False,
            open_browser=open_browser and first_pass)
        if code != EX_TEMPFAIL:
            return code
        first_pass = False
        stdout.write('Restarting to enable tab colors…\n')
        stdout.flush()


def cmd_serve(args, stdin, stdout):
    # `serve` is the backend-only entry point the shell (and tests, and
    # `make golden`) spawn; it never opens a browser on its own. Only
    # `open` and `demo` do that. `--no-open` is still accepted (and still
    # a no-op here) so an existing `everwatch serve --no-open` invocation
    # keeps working unchanged.
    token = _resolve_token(args)
    engine = build_engine(args)
    code, _port = _run_server(
        engine, host='127.0.0.1', port=args.port, token=token, stdin=stdin,
        stdout=stdout, parent_pipe=args.parent_pipe, open_browser=False)
    return code


def cmd_open(args, stdin, stdout):
    token = _resolve_token(args)
    return _serve_until_stopped(
        lambda: build_engine(args), host='127.0.0.1', port=args.port,
        token=token, stdin=stdin, stdout=stdout, open_browser=True)


def cmd_demo(args, stdin, stdout):
    args.demo = True
    token = _resolve_token(args)
    return _serve_until_stopped(
        lambda: build_engine(args), host='127.0.0.1', port=args.port,
        token=token, stdin=stdin, stdout=stdout,
        open_browser=not getattr(args, 'no_open', False))


def cmd_app(args, stdin, stdout):
    """Bare `everwatch` (and its explicit `everwatch app` alias): the
    friendliest way to start Everwatch -- "everwatch should just open
    it" was the literal complaint this fixes. Launches the installed
    native app; falls back to exactly what `everwatch open` does (serve
    the backend and open a browser tab) when there's no native app to
    launch (a --browser-only install, or one where Everwatch.app was
    removed by hand). `--demo` always opens the sample browser UI."""
    if args.demo:
        return cmd_demo(args, stdin, stdout)
    if os.path.isdir(os.path.join(_app_dir(), 'Everwatch.app')):
        _launch_app()
        return 0
    return cmd_open(args, stdin, stdout)


def cmd_state(args, stdin, stdout):
    if args.demo:
        clock = parse_clock(args.clock) if args.clock else None
        engine = build_demo_engine(seed=args.seed, clock=clock)
    else:
        # Real mode: start the engine's pollers for real and wait for
        # their first results (same readiness wait `doctor` uses below),
        # so this doesn't just dump the cold-start "connecting"/empty
        # defaults `Engine.__init__` publishes before anything has
        # actually polled iTerm2.
        clock = parse_clock(args.clock) if args.clock else SystemClock()
        engine = Engine(RealSource(), clock)
        engine.start()
        wait_for_first_results(engine, on_waiting=_print_checking)
    stdout.write(engine.published.to_json(include_screens=True, indent=2))
    stdout.write('\n')
    engine.stop()
    return 0


def doctor_table(result):
    """A clean terminal table for `result` (`Diagnostics`, `diagnostics.
    build_diagnostics`'s shape): one glyph + title line per check, its
    detail indented below, and the action's label (if any) as a hint --
    `doctor` never executes an action itself, it only shows what the
    web/onboarding wizard would offer."""
    lines = []
    for check in result['checks']:
        glyph = STATUS_GLYPHS.get(check['status'], '?')
        lines.append(f"{glyph} {check['title']}")
        lines.append(f"    {check['detail']}")
        action = check.get('action')
        if action:
            lines.append(f"    -> {action['label']}")
    return '\n'.join(lines) + '\n'


def cmd_doctor(args, stdin, stdout):
    """Prints the same 13 checks as onboarding/Settings → Diagnostics
    (docs/DESIGN.md §4.2) as a terminal table, `--json` for machine
    consumption. Exit code 1 if any check is `error`, else 0.

    Without `--demo`, this starts the engine's real pollers (iTerm2
    snapshot/paths/agents/usage -- exactly what `everwatch state` already
    does) and waits (up to `engine_loop.DIAG_READY_TIMEOUT` seconds,
    printing a "Checking…" line to stderr if it takes a moment) for a
    first result from each of them, plus the diagnostics probes (a
    Keychain read for the Claude token, a `.codex/auth.json` stat, an
    `mdfind` for iTerm2 if it isn't in /Applications, and the
    quota-email/ultrawatch config files), before computing the checks --
    otherwise every check would just show its cold-start "not yet known"
    default. No osascript beyond that first real pass, and never a
    `pip`/`venv` install."""
    if args.demo:
        clock = parse_clock(args.clock) if args.clock else None
        engine = build_demo_engine(seed=args.seed, clock=clock,
                                   **_diag_kwargs(args))
    else:
        clock = parse_clock(args.clock) if args.clock else SystemClock()
        engine = Engine(RealSource(), clock, **_diag_kwargs(args))
        engine.start()
        wait_for_first_results(engine, on_waiting=_print_checking)
    result = engine.call('diagnostics')
    engine.stop()
    if args.json:
        stdout.write(json.dumps(result, sort_keys=True) + '\n')
    else:
        stdout.write(doctor_table(result))
    return 1 if diagnostics.summary(result)[diagnostics.STATUS_ERROR] else 0


def _download_install_script(url):
    """Real network fetch used only by `cmd_update` outside tests -- the
    real-I/O guard (tests/py/__init__.py) forbids `urllib.request.urlopen`
    unmocked, so every test patches this function directly instead
    (docs/DESIGN.md hard rule #2)."""
    with urllib.request.urlopen(url, timeout=15) as resp:  # noqa: S310
        return resp.read()


def _exec_install_script(script_bytes, extra_args):
    """Writes `script_bytes` to a private temp file and runs it with bash
    plus `extra_args`. Real subprocess, used only by `cmd_update` outside
    tests; every test patches this function directly instead."""
    fd, path = tempfile.mkstemp(suffix='.sh', prefix='everwatch-update-')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(script_bytes)
        os.chmod(path, 0o700)
        result = subprocess.run(['bash', path] + list(extra_args))
        return result.returncode
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def cmd_update(args, stdin, stdout):
    """Re-runs the installer for the latest release (docs/DESIGN.md §4.1's
    Update row): downloads install.sh to a private temp file and execs it
    with --yes (plus --no-open, if asked). A runtime-only update leaves
    Everwatch.app untouched, so the Automation grant survives; install.sh
    itself decides that (§4.3).

    A --prefix install's CLI wrapper exports EVERWATCH_PREFIX (install.sh's
    install_cli_link); forwarded here so `everwatch update` re-installs into
    the same prefix instead of install.sh silently falling back to the real
    $HOME."""
    if not args.yes and not _confirm(
            stdin, stdout, 'Download and install the latest release now? '
                          '[y/N] '):
        stdout.write('Update cancelled.\n')
        return 0
    stdout.write('Fetching the latest installer…\n')
    try:
        script = _download_install_script(INSTALL_SCRIPT_URL)
    except Exception as e:  # noqa: BLE001 - report, don't crash the CLI
        stdout.write(f'Could not download the installer: {e}\n')
        return 1
    extra_args = ['--yes']
    if args.no_open:
        extra_args.append('--no-open')
    prefix = os.environ.get('EVERWATCH_PREFIX')
    if prefix:
        extra_args.extend(['--prefix', prefix])
    return _exec_install_script(script, extra_args)


def _tccutil_reset(bundle_id, stdout):
    """Real subprocess call, user-level (no sudo): resets the Automation
    grant so `--purge` leaves no phantom permission row (docs/DESIGN.md
    §4.1's Uninstall row). Never raises and never aborts the uninstall:
    on a machine where Everwatch.app never ran there's no grant to reset
    yet, and tccutil reports that with a non-zero exit and "No such
    bundle identifier ... (OSStatus error -10814.)" on stderr -- expected,
    not a failure. Only reached from `cmd_uninstall(purge=True)`; every
    test patches this function directly, or patches `subprocess.run` to
    exercise it for real, instead of letting it run for real (docs/DESIGN.md
    hard rule #2 -- never run tccutil for real in tests)."""
    result = subprocess.run(['tccutil', 'reset', 'AppleEvents', bundle_id],
                            capture_output=True, text=True)
    if result.returncode == 0:
        stdout.write('Automation grant reset.\n')
        return
    output = (result.stdout or '') + (result.stderr or '')
    if re.search(r'no such bundle identifier|-10814', output, re.IGNORECASE):
        stdout.write(
            'No Automation grant to reset (Everwatch never asked for one).\n')
        return
    stdout.write("Couldn't reset the Automation grant automatically:\n")
    if output.strip():
        stdout.write(output if output.endswith('\n') else output + '\n')
    stdout.write(
        f'Reset it by hand with: tccutil reset AppleEvents "{bundle_id}"\n')


def _remove_path(path):
    """Removes a file, symlink, or directory tree at `path` if it exists
    (as itself or as a dangling symlink); returns whether anything was
    removed. Used by `cmd_uninstall`, which only ever points this at paths
    under `_app_dir()`/`_bin_dir()`/`_everwatch_home()`."""
    if os.path.islink(path) or os.path.isfile(path):
        os.remove(path)
        return True
    if os.path.isdir(path):
        shutil.rmtree(path)
        return True
    return False


def cmd_uninstall(args, stdin, stdout):
    """Removes the app, runtime, venv, and CLI link (docs/DESIGN.md §4.1's
    Uninstall row). Keeps state.json unless --purge, which also removes
    the rest of EVERWATCH_HOME and resets the Automation grant."""
    prompt = 'Uninstall Everwatch'
    if args.purge:
        prompt += ' and delete all its saved settings'
    prompt += '? [y/N] '
    if not args.yes and not _confirm(stdin, stdout, prompt):
        stdout.write('Uninstall cancelled.\n')
        return 0

    home = _everwatch_home()
    removed = []

    app_path = os.path.join(_app_dir(), 'Everwatch.app')
    if _remove_path(app_path):
        removed.append(app_path)

    link_path = os.path.join(_bin_dir(), 'everwatch')
    if _remove_path(link_path):
        removed.append(link_path)

    if args.purge:
        if _remove_path(home):
            removed.append(home)
    else:
        for sub in ('runtime', 'venv'):
            sub_path = os.path.join(home, sub)
            if _remove_path(sub_path):
                removed.append(sub_path)

    for path in removed:
        stdout.write(f'removed {path}\n')
    if not removed:
        stdout.write('Nothing to remove.\n')
    if not args.purge:
        stdout.write(f'state.json was kept at {home}.\n')

    if args.purge:
        stdout.write('Resetting the Automation permission grant…\n')
        _tccutil_reset(BUNDLE_ID, stdout)

    stdout.write('Everwatch uninstalled.\n')
    return 0


def build_parser():
    parser = argparse.ArgumentParser(
        prog='everwatch',
        description='With no command, everwatch just opens the '
                    "installed Everwatch.app (same as `everwatch app`), "
                    "falling back to `everwatch open`'s browser mode if "
                    "it isn't installed.")
    parser.add_argument('--version', action=_VersionAction,
                        help="show the CLI's version, plus the installed "
                             'runtime and shell versions if present')
    sub = parser.add_subparsers(dest='command')

    serve = sub.add_parser('serve', help='run the backend server')
    serve.add_argument('--port', type=int, default=0)
    serve.add_argument('--demo', action='store_true')
    serve.add_argument('--seed', type=int, default=1)
    serve.add_argument('--clock', default='')
    serve.add_argument('--token', default=None)
    serve.add_argument('--parent-pipe', action='store_true')
    serve.add_argument('--no-open', action='store_true')
    serve.add_argument('--demo-diagnostics', default=None,
                       choices=diagnostics.preset_names(),
                       help='force a diagnostics preset (docs/DESIGN.md §4.2)')
    serve.add_argument('--selftest', action='store_true',
                       help='demo data with every probe and installer faked '
                            "(Everwatch.app's headless self-test)")
    serve.set_defaults(func=cmd_serve)

    open_p = sub.add_parser('open', help='run the server and open a browser')
    open_p.add_argument('--port', type=int, default=0)
    open_p.add_argument('--demo', action='store_true')
    open_p.add_argument('--seed', type=int, default=1)
    open_p.add_argument('--clock', default='')
    open_p.add_argument('--token', default=None)
    open_p.set_defaults(func=cmd_open)

    demo = sub.add_parser('demo', help='serve --demo, then open a browser')
    demo.add_argument('--port', type=int, default=0)
    demo.add_argument('--seed', type=int, default=1)
    demo.add_argument('--clock', default='')
    demo.add_argument('--token', default=None)
    demo.add_argument('--no-open', action='store_true')
    demo.set_defaults(func=cmd_demo)

    app = sub.add_parser(
        'app', help='open the installed Everwatch.app (default when no '
                    "command is given); --demo opens sample sessions in "
                    "a browser")
    app.add_argument('--port', type=int, default=0)
    app.add_argument('--demo', action='store_true')
    app.add_argument('--seed', type=int, default=1)
    app.add_argument('--clock', default='')
    app.add_argument('--token', default=None)
    app.set_defaults(func=cmd_app)

    state = sub.add_parser('state', help='dump the current state as JSON')
    state.add_argument('--demo', action='store_true')
    state.add_argument('--seed', type=int, default=1)
    state.add_argument('--clock', default='')
    state.set_defaults(func=cmd_state)

    doctor = sub.add_parser(
        'doctor', help='print the onboarding/diagnostics checks')
    doctor.add_argument('--demo', action='store_true')
    doctor.add_argument('--seed', type=int, default=1)
    doctor.add_argument('--clock', default='')
    doctor.add_argument('--json', action='store_true')
    doctor.add_argument('--demo-diagnostics', default=None,
                        choices=diagnostics.preset_names(),
                        help='force a diagnostics preset '
                             '(docs/DESIGN.md §4.2)')
    doctor.set_defaults(func=cmd_doctor)

    update = sub.add_parser(
        'update', help='download and install the latest release')
    update.add_argument('--yes', action='store_true')
    update.add_argument('--no-open', action='store_true')
    update.set_defaults(func=cmd_update)

    uninstall = sub.add_parser('uninstall', help='remove Everwatch')
    uninstall.add_argument('--purge', action='store_true',
                           help='also delete state.json and reset the '
                                'Automation permission grant')
    uninstall.add_argument('--yes', action='store_true')
    uninstall.set_defaults(func=cmd_uninstall)

    return parser


def main(argv=None, stdin=None, stdout=None):
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    argv = sys.argv[1:] if argv is None else argv
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, 'func', None) is None:
        # Bare `everwatch`: the friendliest thing to do is just open the
        # app (see cmd_app's docstring) -- `--help`/`-h` are still what
        # print argparse's usage text; those exit inside parse_args above
        # and never reach here.
        args = parser.parse_args(['app'] + list(argv))
    return args.func(args, stdin=stdin, stdout=stdout)


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
