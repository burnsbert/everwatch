"""Onboarding/diagnostics checks 1-13 (docs/DESIGN.md §4.2, §7 WP7 row).

Every check is a small pure function: given already-known facts (mostly
things the engine already tracks, plus a handful of one-shot local
probes it can't derive from its own state), it returns one `Check`:

    {id, title, status: ok|warn|error|info|unknown, detail, action}

`action` is `None` or `{kind, label, ...}` where `kind` is one of:
    'link'                 -- extra: url
    'command'               -- extra: command (a copyable shell command)
    'endpoint'              -- extra: method, path (call this API endpoint)
    'open_system_settings'  -- extra: pane ('automation'|'notifications');
                               the web forwards this as a bridge message
    'request_notifications' -- the web sends the `requestNotifications`
                               bridge message
    'copy'                  -- extra: text (e.g. an example config)

The handful of facts the engine can't compute from its own state (python
version, whether iTerm2.app is installed, whether a Claude/Codex token
exists, the quota-email config, an ultrawatch state.json path) come from
`Probes`, whose default implementations do real (but read-only, no
osascript) I/O. Tests always inject a `Probes` built from `FakeProbes`
so no test ever touches the keychain, the filesystem outside its own
temp dir, or spawns `mdfind` (docs/DESIGN.md hard rule #2).

Two facts are permanently `unknown` on the backend and are labelled
accordingly: Automation-permission detail (beyond what an osascript
error code already reveals), Notifications, and Hotkeys are all only
known to the Swift shell (`nativeStatus`, shell/README.md), which has no
channel back into this backend process -- the web merges the shell's
live `nativeStatus` with this module's output client-side.
"""
import os
import subprocess
import sys
from dataclasses import dataclass, field

from everwatch.engine import config
from everwatch.sources import base

STATUS_OK = 'ok'
STATUS_WARN = 'warn'
STATUS_ERROR = 'error'
STATUS_INFO = 'info'
STATUS_UNKNOWN = 'unknown'

MIN_PYTHON = (3, 9)

ITERM_DOWNLOAD_URL = 'https://iterm2.com/downloads.html'
SHELL_INTEGRATION_URL = 'https://iterm2.com/documentation-shell-integration.html'
AUTOMATION_SETTINGS_URL = \
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation'
NOTIFICATIONS_SETTINGS_URL = \
    'x-apple.systempreferences:com.apple.preference.notifications'
BUNDLE_ID = 'io.github.burnsbert.everwatch'
TCCUTIL_RESET_CMD = f'tccutil reset AppleEvents {BUNDLE_ID}'

QUOTA_EMAIL_EXAMPLE = (
    '{\n'
    '  "enabled": true,\n'
    '  "threshold_percent": 90,\n'
    '  "email": {"to": "you@example.com", "subject": "Claude quota",\n'
    '            "body": "Approaching the monthly limit."}\n'
    '}'
)


def _check(cid, title, status, detail, action=None):
    return {'id': cid, 'title': title, 'status': status, 'detail': detail,
           'action': action}


def _link(label, url):
    return {'kind': 'link', 'label': label, 'url': url}


def _command(label, command):
    return {'kind': 'command', 'label': label, 'command': command}


def _endpoint(label, method, path):
    return {'kind': 'endpoint', 'label': label, 'method': method,
           'path': path}


def _open_settings(label, pane, shell):
    """In shell mode the web asks the native app to open the pane
    (`openSystemSettings{pane}`, shell/README.md); in browser mode there
    is no bridge, so it's a plain link the browser can still follow."""
    if shell:
        return {'kind': 'open_system_settings', 'label': label, 'pane': pane}
    url = (AUTOMATION_SETTINGS_URL if pane == 'automation'
          else NOTIFICATIONS_SETTINGS_URL)
    return _link(label, url)


# ------------------------------------------------------------- checks

def check_python_version(version_info):
    major, minor = version_info[0], version_info[1]
    ok = (major, minor) >= MIN_PYTHON
    if ok:
        return _check('python_version', 'Python 3.9+', STATUS_OK,
                      f'Python {major}.{minor} is running Everwatch.')
    return _check(
        'python_version', 'Python 3.9+', STATUS_ERROR,
        f'Python {major}.{minor} is too old (Everwatch needs 3.9+).',
        _command('Copy install command',
                 'brew install python  # or: xcode-select --install'))


def check_iterm_installed(installed):
    if installed:
        return _check('iterm_installed', 'iTerm2 installed', STATUS_OK,
                      'iTerm2 is installed.')
    return _check('iterm_installed', 'iTerm2 installed', STATUS_ERROR,
                 "iTerm2 wasn't found on this Mac.",
                 _link('Get iTerm2', ITERM_DOWNLOAD_URL))


def check_iterm_running(iterm_status):
    if iterm_status == base.STATUS_NOT_RUNNING:
        return _check(
            'iterm_running', 'iTerm2 running', STATUS_WARN,
            "iTerm2 isn't running. Everwatch keeps polling and recovers "
            'on its own once it starts.',
            _endpoint('Launch iTerm2', 'POST', '/api/iterm/launch'))
    if iterm_status == base.STATUS_CONNECTING:
        return _check('iterm_running', 'iTerm2 running', STATUS_INFO,
                      'Connecting to iTerm2…')
    return _check('iterm_running', 'iTerm2 running', STATUS_OK,
                 'iTerm2 is running.')


def check_automation(iterm_status, shell):
    """Automation -> iTerm2 (check 4). The backend only learns this from
    an osascript error code (`-1743`/`-1744` in P-08's mapping); the
    Swift shell can ask macOS directly without prompting
    (`AEDeterminePermissionToAutomateTarget`) and reports the live result
    to the web as `nativeStatus.automation`, which this backend never
    sees (shell/README.md). This check reflects only the last osascript
    attempt."""
    settings_action = _open_settings('Open System Settings', 'automation',
                                     shell)
    if iterm_status == base.STATUS_PERMISSION_DENIED:
        return _check(
            'automation', 'Automation → iTerm2', STATUS_ERROR,
            'Everwatch needs permission to control iTerm2. '
            'Open System Settings → Privacy & Security → Automation, '
            'find Everwatch, and enable iTerm2. Still stuck? '
            f'`{TCCUTIL_RESET_CMD}` clears a stale grant.',
            settings_action)
    if iterm_status == base.STATUS_OK:
        return _check('automation', 'Automation → iTerm2', STATUS_OK,
                      'Everwatch can already control iTerm2.')
    detail = ('Automation permission is not yet known -- it is granted '
             'the first time Everwatch successfully queries iTerm2.')
    if shell:
        detail += ' The app reports the live OS permission status.'
    else:
        detail += (' Browser mode cannot ask macOS without triggering '
                   'the permission prompt itself.')
    return _check('automation', 'Automation → iTerm2', STATUS_UNKNOWN,
                 detail, _endpoint('Connect to iTerm2', 'POST', '/api/refresh'))


def check_shell_integration(sessions_total, sessions_without_path):
    if sessions_total == 0:
        return _check('shell_integration', 'Shell integration', STATUS_INFO,
                      'No sessions to check yet.')
    if sessions_without_path == 0:
        return _check('shell_integration', 'Shell integration', STATUS_OK,
                      'Every session reports its working directory.')
    return _check(
        'shell_integration', 'Shell integration', STATUS_INFO,
        f'{sessions_without_path} of {sessions_total} session(s) have no '
        "shell integration; Everwatch falls back to `lsof` for those.",
        _link('Install Shell Integration', SHELL_INTEGRATION_URL))


def check_agents_detected(agents_count):
    if agents_count > 0:
        return _check('agents_detected', 'Agents detected', STATUS_OK,
                      f'{agents_count} agent session(s) running.')
    return _check(
        'agents_detected', 'Agents detected', STATUS_INFO,
        'No Claude Code or Codex running -- start one to see states '
        'and usage.')


def _usage_check(cid, title, token_present, status, http_status, agent_cmd):
    if not token_present:
        return _check(cid, title, STATUS_INFO,
                     f'Sign in with `{agent_cmd}` to see limits.')
    if status == 'ok':
        return _check(cid, title, STATUS_OK, 'Usage data is current.')
    if status == 'stale':
        return _check(cid, title, STATUS_WARN,
                     'The last refresh failed; showing the most recent '
                     'good data.')
    if status == 'failing':
        detail = 'The usage API request failed.'
        if http_status:
            detail += f' (HTTP {http_status})'
        return _check(cid, title, STATUS_ERROR, detail)
    return _check(cid, title, STATUS_INFO, 'No session is running.')


def check_claude_usage(token_present, status, http_status=None):
    return _usage_check('claude_usage', 'Claude usage', token_present,
                        status, http_status, 'claude')


def check_codex_usage(auth_present, status, http_status=None):
    return _usage_check('codex_usage', 'Codex usage', auth_present, status,
                        http_status, 'codex')


def check_tab_colors(capability):
    install_action = _endpoint('Enable tab colors', 'POST',
                               '/api/colors/install')
    recheck_action = _endpoint('Check again', 'POST',
                               '/api/diagnostics/recheck')
    if capability == 'available':
        return _check('tab_colors', 'Tab colors', STATUS_OK,
                      'Tab colors are working.')
    if capability == 'not_installed':
        return _check(
            'tab_colors', 'Tab colors', STATUS_WARN,
            'The optional `iterm2` Python package is not installed.',
            install_action)
    if capability == 'api_disabled':
        return _check(
            'tab_colors', 'Tab colors', STATUS_WARN,
            "iTerm2's Python API is switched off. Enable it in "
            'iTerm2 → Settings → General → Magic → "Enable Python API", '
            'then check again. (iTerm2 shows a one-time "allow '
            'connection" dialog on first connect.)', recheck_action)
    if capability == 'error':
        return _check('tab_colors', 'Tab colors', STATUS_WARN,
                      'Tab colors are temporarily unavailable.',
                      recheck_action)
    return _check('tab_colors', 'Tab colors', STATUS_INFO,
                 'Not checked yet.', install_action)


def check_notifications(shell):
    """The backend has no channel from the shell (shell/README.md's
    `nativeStatus` goes shell -> web only), so this is always
    `unknown` here; the web merges it with the app's live status."""
    detail = ('reported by the app' if shell else
             "Notifications aren't available in browser mode.")
    return _check('notifications', 'Notifications', STATUS_UNKNOWN, detail)


def check_hotkeys(shell):
    """Same blind spot as check_notifications -- see its docstring."""
    detail = ('reported by the app' if shell else
             "Hotkeys aren't available in browser mode.")
    return _check('hotkeys', 'Hotkeys', STATUS_UNKNOWN, detail)


def check_quota_email(quota_config):
    example_action = {'kind': 'copy', 'label': 'Copy example config',
                      'text': QUOTA_EMAIL_EXAMPLE}
    if not isinstance(quota_config, dict):
        return _check('quota_email', 'Quota email', STATUS_INFO,
                     'Quota email alerts are not configured.',
                     example_action)
    if quota_config.get('enabled') is not True:
        return _check('quota_email', 'Quota email', STATUS_INFO,
                     'Quota email alerts are configured but disabled.',
                     example_action)
    threshold = quota_config.get('threshold_percent', 90)
    return _check('quota_email', 'Quota email', STATUS_OK,
                 f'Enabled at {threshold}% of the monthly limit.')


def check_ultrawatch_import(path, already_imported):
    if not path:
        return _check('ultrawatch_import', 'ultrawatch import', STATUS_INFO,
                     'No ultrawatch state.json was found.')
    if already_imported:
        return _check('ultrawatch_import', 'ultrawatch import', STATUS_OK,
                     'Already imported from ultrawatch.')
    return _check(
        'ultrawatch_import', 'ultrawatch import', STATUS_INFO,
        f'Found an ultrawatch state at {path}.',
        _endpoint('Import labels & projects', 'POST',
                 '/api/import/ultrawatch'))


CHECK_ORDER = (
    'python_version', 'iterm_installed', 'iterm_running', 'automation',
    'shell_integration', 'agents_detected', 'claude_usage', 'codex_usage',
    'tab_colors', 'notifications', 'hotkeys', 'quota_email',
    'ultrawatch_import',
)


@dataclass
class DiagnosticsInputs:
    """Everything `build_diagnostics` needs. The engine builds one of
    these each time diagnostics are (re)computed, mixing its own live
    state with the last probe run (see `Probes` below)."""

    python_version: tuple = (sys.version_info.major, sys.version_info.minor)
    iterm_installed: bool = False
    iterm_status: str = base.STATUS_CONNECTING
    shell: bool = False
    sessions_total: int = 0
    sessions_without_path: int = 0
    agents_count: int = 0
    claude_token_present: bool = False
    claude_usage_status: str = 'inactive'
    claude_http_status: int = None
    codex_auth_present: bool = False
    codex_usage_status: str = 'inactive'
    codex_http_status: int = None
    tab_colors: str = 'unknown'
    quota_config: dict = None
    ultrawatch_path: str = None
    ultrawatch_imported: bool = False
    install_progress: dict = field(default_factory=dict)


def build_diagnostics(inputs, now=0.0):
    """`{checks: [Check, ...], generated_at}` (docs/DESIGN.md §3.5
    `Diagnostics`). If a tab-color install is in progress (or just
    finished), its progress replaces check 9's status/detail so the web
    doesn't need a separate channel for install progress."""
    checks = [
        check_python_version(inputs.python_version),
        check_iterm_installed(inputs.iterm_installed),
        check_iterm_running(inputs.iterm_status),
        check_automation(inputs.iterm_status, inputs.shell),
        check_shell_integration(inputs.sessions_total,
                                inputs.sessions_without_path),
        check_agents_detected(inputs.agents_count),
        check_claude_usage(inputs.claude_token_present,
                           inputs.claude_usage_status,
                           inputs.claude_http_status),
        check_codex_usage(inputs.codex_auth_present,
                          inputs.codex_usage_status,
                          inputs.codex_http_status),
        _tab_colors_check(inputs),
        check_notifications(inputs.shell),
        check_hotkeys(inputs.shell),
        check_quota_email(inputs.quota_config),
        check_ultrawatch_import(inputs.ultrawatch_path,
                                inputs.ultrawatch_imported),
    ]
    return {'checks': checks, 'generated_at': now}


def _tab_colors_check(inputs):
    progress = inputs.install_progress or {}
    status = progress.get('status')
    if status == 'installing':
        return _check('tab_colors', 'Tab colors', STATUS_INFO,
                      progress.get('detail', 'Installing…'))
    if status == 'error':
        return _check('tab_colors', 'Tab colors', STATUS_ERROR,
                      progress.get('detail', 'Install failed.'),
                      _endpoint('Try again', 'POST', '/api/colors/install'))
    if status == 'restart_required':
        return _check('tab_colors', 'Tab colors', STATUS_WARN,
                      progress.get('detail', 'Restart required.'))
    return check_tab_colors(inputs.tab_colors)


def summary(diagnostics):
    """`{ok, warn, error, info, unknown}` counts, handy for a wizard's
    "N issues" badge and for `doctor`'s exit code."""
    counts = {STATUS_OK: 0, STATUS_WARN: 0, STATUS_ERROR: 0,
             STATUS_INFO: 0, STATUS_UNKNOWN: 0}
    for check in diagnostics['checks']:
        counts[check['status']] = counts.get(check['status'], 0) + 1
    return counts


# ------------------------------------------------------------- probes

class Probes:
    """Injectable one-shot I/O the engine can't derive from its own
    live state. Every method is read-only. `runner` is only used by
    `iterm_installed`'s `mdfind` fallback (docs/DESIGN.md §4.1); pass a
    fake in tests so nothing ever spawns a real process."""

    def __init__(self, runner=None):
        self._runner = runner or subprocess.run

    def python_version(self):
        return (sys.version_info.major, sys.version_info.minor)

    def iterm_installed(self):
        for path in ('/Applications/iTerm.app',
                     os.path.expanduser('~/Applications/iTerm.app')):
            if os.path.isdir(path):
                return True
        try:
            result = self._runner(
                ['mdfind', 'kMDItemCFBundleIdentifier == '
                 '"com.googlecode.iterm2"'],
                capture_output=True, text=True, timeout=5)
        except Exception:
            return False
        return bool((result.stdout or '').strip())

    def claude_token_present(self):
        from everwatch.engine.usage_claude import get_oauth_token
        return get_oauth_token() is not None

    def codex_auth_present(self):
        return os.path.isfile(os.path.join(config.HOME, '.codex',
                                           'auth.json'))

    def quota_config(self):
        from everwatch.engine import notifier
        return notifier.load_config()

    def ultrawatch_path(self):
        from everwatch.engine import persist
        return persist.find_ultrawatch_state()

    def snapshot(self):
        """Every probed fact at once, as a plain dict (what the engine
        caches between rechecks)."""
        return {
            'python_version': self.python_version(),
            'iterm_installed': self.iterm_installed(),
            'claude_token_present': self.claude_token_present(),
            'codex_auth_present': self.codex_auth_present(),
            'quota_config': self.quota_config(),
            'ultrawatch_path': self.ultrawatch_path(),
        }


class FakeProbes(Probes):
    """A scriptable `Probes` for tests and CLI demo presets: every
    method returns a fixed, injected value and touches nothing real."""

    def __init__(self, python_version=(3, 11), iterm_installed=True,
                claude_token_present=False, codex_auth_present=False,
                quota_config=None, ultrawatch_path=None):
        super().__init__(runner=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError('FakeProbes: unexpected real subprocess call')))
        self._python_version = python_version
        self._iterm_installed = iterm_installed
        self._claude_token_present = claude_token_present
        self._codex_auth_present = codex_auth_present
        self._quota_config = quota_config
        self._ultrawatch_path = ultrawatch_path

    def python_version(self):
        return self._python_version

    def iterm_installed(self):
        return self._iterm_installed

    def claude_token_present(self):
        return self._claude_token_present

    def codex_auth_present(self):
        return self._codex_auth_present

    def quota_config(self):
        return self._quota_config

    def ultrawatch_path(self):
        return self._ultrawatch_path


# ------------------------------------------------------ demo presets

#: `--demo-diagnostics <preset>` (serve/doctor): named `DiagnosticsInputs`
#: overrides layered onto the live demo engine's own facts, so the UI
#: engineer can drive every onboarding/Settings state deterministically.
DEMO_PRESETS = {
    'all_ok': dict(
        iterm_installed=True, iterm_status=base.STATUS_OK, shell=True,
        claude_token_present=True, claude_usage_status='ok',
        codex_auth_present=True, codex_usage_status='ok',
        tab_colors='available',
        quota_config={'enabled': True, 'threshold_percent': 90}),
    'first_run': dict(
        iterm_installed=True, iterm_status=base.STATUS_CONNECTING,
        shell=True, claude_token_present=False, codex_auth_present=False,
        tab_colors='unknown', quota_config=None, ultrawatch_path=None),
    'permission_denied': dict(
        iterm_installed=True, iterm_status=base.STATUS_PERMISSION_DENIED,
        shell=True, tab_colors='unknown'),
    'not_running': dict(
        iterm_installed=True, iterm_status=base.STATUS_NOT_RUNNING,
        shell=True, tab_colors='unknown'),
    'no_colors': dict(
        iterm_installed=True, iterm_status=base.STATUS_OK, shell=True,
        tab_colors='not_installed'),
    'no_python_api': dict(
        iterm_installed=True, iterm_status=base.STATUS_OK, shell=True,
        tab_colors='api_disabled'),
    'no_iterm': dict(iterm_installed=False,
                     iterm_status=base.STATUS_NOT_RUNNING, shell=True),
}


def preset_names():
    return sorted(DEMO_PRESETS)


def apply_preset(inputs, name):
    """Return a copy of `inputs` with a demo preset's fields overlaid.
    Raises KeyError for an unknown preset name (the CLI turns that into
    a clean argparse error)."""
    overrides = DEMO_PRESETS[name]
    for key, value in overrides.items():
        setattr(inputs, key, value)
    return inputs
