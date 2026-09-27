"""diagnostics.py: the 13 onboarding/diagnostics checks, `Probes` /
`FakeProbes`, and the demo presets (docs/DESIGN.md §4.2, §7 WP7 row)."""
import os
import tempfile
import unittest
from unittest import mock

from everwatch import diagnostics as D
from everwatch.sources import base


def _ids(result):
    return [c['id'] for c in result['checks']]


class TestPythonVersion(unittest.TestCase):
    def test_ok_when_new_enough(self):
        c = D.check_python_version((3, 11))
        self.assertEqual(c['status'], D.STATUS_OK)
        self.assertIsNone(c['action'])

    def test_error_when_too_old(self):
        c = D.check_python_version((3, 8))
        self.assertEqual(c['status'], D.STATUS_ERROR)
        self.assertEqual(c['action']['kind'], 'command')
        self.assertIn('brew install python', c['action']['command'])

    def test_boundary_3_9_is_ok(self):
        self.assertEqual(D.check_python_version((3, 9))['status'], D.STATUS_OK)


class TestItermInstalled(unittest.TestCase):
    def test_installed(self):
        self.assertEqual(D.check_iterm_installed(True)['status'], D.STATUS_OK)

    def test_not_installed_offers_download_link(self):
        c = D.check_iterm_installed(False)
        self.assertEqual(c['status'], D.STATUS_ERROR)
        self.assertEqual(c['action'], {'kind': 'link', 'label': 'Get iTerm2',
                                       'url': D.ITERM_DOWNLOAD_URL})


class TestItermRunning(unittest.TestCase):
    def test_ok(self):
        self.assertEqual(
            D.check_iterm_running(base.STATUS_OK)['status'], D.STATUS_OK)

    def test_connecting_is_info(self):
        self.assertEqual(
            D.check_iterm_running(base.STATUS_CONNECTING)['status'],
            D.STATUS_INFO)

    def test_not_running_offers_launch_endpoint(self):
        c = D.check_iterm_running(base.STATUS_NOT_RUNNING)
        self.assertEqual(c['status'], D.STATUS_WARN)
        self.assertEqual(c['action'],
                        {'kind': 'endpoint', 'label': 'Launch iTerm2',
                         'method': 'POST', 'path': '/api/iterm/launch'})

    def test_other_errors_still_treated_as_running(self):  # parity: P-08
        for status in (base.STATUS_PERMISSION_DENIED, base.STATUS_TIMEOUT,
                      base.STATUS_ERROR):
            with self.subTest(status=status):
                self.assertEqual(D.check_iterm_running(status)['status'],
                                 D.STATUS_OK)


class TestAutomation(unittest.TestCase):
    def test_denied_is_error_with_shell_bridge_action(self):
        c = D.check_automation(base.STATUS_PERMISSION_DENIED, True)
        self.assertEqual(c['status'], D.STATUS_ERROR)
        self.assertEqual(c['action']['kind'], 'open_system_settings')
        self.assertEqual(c['action']['pane'], 'automation')
        self.assertIn(D.TCCUTIL_RESET_CMD, c['detail'])

    def test_denied_detail_is_plain_language_not_jargon(self):  # parity: T024
        # "send Apple Events" is AppleScript/osascript jargon; the wording
        # should read like the web copy (lib/diagnostics_ui.mjs's own
        # denied-state detail: "control iTerm2").
        c = D.check_automation(base.STATUS_PERMISSION_DENIED, True)
        self.assertNotIn('Apple Events', c['detail'])
        self.assertIn('permission to control iTerm2', c['detail'])

    def test_denied_in_browser_mode_is_a_plain_link(self):
        c = D.check_automation(base.STATUS_PERMISSION_DENIED, False)
        self.assertEqual(c['action'], {'kind': 'link', 'label':
                                       'Open System Settings',
                                       'url': D.AUTOMATION_SETTINGS_URL})

    def test_ok_status(self):
        c = D.check_automation(base.STATUS_OK, True)
        self.assertEqual(c['status'], D.STATUS_OK)
        self.assertIsNone(c['action'])

    def test_unknown_otherwise_offers_connect_endpoint(self):
        c = D.check_automation(base.STATUS_NOT_RUNNING, True)
        self.assertEqual(c['status'], D.STATUS_UNKNOWN)
        self.assertEqual(c['action']['path'], '/api/refresh')
        self.assertIn('live OS permission status', c['detail'])

    def test_unknown_browser_mode_detail_differs(self):
        c = D.check_automation(base.STATUS_CONNECTING, False)
        self.assertIn('Browser mode', c['detail'])


class TestShellIntegration(unittest.TestCase):
    def test_no_sessions_is_info(self):
        c = D.check_shell_integration(0, 0)
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertIsNone(c['action'])

    def test_all_have_paths_is_ok(self):
        self.assertEqual(D.check_shell_integration(3, 0)['status'],
                         D.STATUS_OK)

    def test_some_missing_is_info_with_link(self):
        c = D.check_shell_integration(4, 1)
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertIn('1 of 4', c['detail'])
        self.assertEqual(c['action']['url'], D.SHELL_INTEGRATION_URL)


class TestAgentsDetected(unittest.TestCase):
    def test_zero_is_info(self):
        self.assertEqual(D.check_agents_detected(0)['status'], D.STATUS_INFO)

    def test_some_is_ok(self):
        c = D.check_agents_detected(2)
        self.assertEqual(c['status'], D.STATUS_OK)
        self.assertIn('2', c['detail'])


class TestUsageChecks(unittest.TestCase):
    def test_claude_no_token_is_info(self):
        c = D.check_claude_usage(False, 'inactive')
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertIn('claude', c['detail'])

    def test_claude_ok(self):
        self.assertEqual(
            D.check_claude_usage(True, 'ok')['status'], D.STATUS_OK)

    def test_claude_stale_is_warn(self):
        self.assertEqual(
            D.check_claude_usage(True, 'stale')['status'], D.STATUS_WARN)

    def test_claude_failing_is_error_with_http_status(self):
        c = D.check_claude_usage(True, 'failing', 429)
        self.assertEqual(c['status'], D.STATUS_ERROR)
        self.assertIn('429', c['detail'])

    def test_claude_inactive_with_token_is_info(self):
        c = D.check_claude_usage(True, 'inactive')
        self.assertEqual(c['status'], D.STATUS_INFO)

    def test_codex_mirrors_claude(self):
        c = D.check_codex_usage(False, 'inactive')
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertIn('codex', c['detail'])
        self.assertEqual(D.check_codex_usage(True, 'ok')['status'], D.STATUS_OK)


class TestTabColors(unittest.TestCase):
    def test_available(self):
        self.assertEqual(D.check_tab_colors('available')['status'],
                         D.STATUS_OK)

    def test_not_installed_offers_install_endpoint(self):
        c = D.check_tab_colors('not_installed')
        self.assertEqual(c['status'], D.STATUS_WARN)
        self.assertEqual(c['action']['path'], '/api/colors/install')

    def test_api_disabled_offers_recheck(self):
        c = D.check_tab_colors('api_disabled')
        self.assertEqual(c['status'], D.STATUS_WARN)
        self.assertEqual(c['action']['path'], '/api/diagnostics/recheck')
        self.assertIn('Enable Python API', c['detail'])

    def test_error_offers_recheck(self):
        c = D.check_tab_colors('error')
        self.assertEqual(c['status'], D.STATUS_WARN)

    def test_unknown_offers_install(self):
        c = D.check_tab_colors('unknown')
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertEqual(c['action']['path'], '/api/colors/install')


class TestNotificationsAndHotkeys(unittest.TestCase):
    def test_notifications_always_unknown(self):
        for shell in (True, False):
            c = D.check_notifications(shell)
            self.assertEqual(c['status'], D.STATUS_UNKNOWN)
        self.assertIn('reported by the app', D.check_notifications(True)['detail'])
        self.assertIn('browser mode', D.check_notifications(False)['detail'])

    def test_hotkeys_always_unknown(self):
        self.assertEqual(D.check_hotkeys(True)['status'], D.STATUS_UNKNOWN)
        self.assertEqual(D.check_hotkeys(False)['status'], D.STATUS_UNKNOWN)


class TestQuotaEmail(unittest.TestCase):
    def test_not_configured(self):
        c = D.check_quota_email(None)
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertEqual(c['action']['kind'], 'copy')

    def test_configured_but_disabled(self):
        c = D.check_quota_email({'enabled': False})
        self.assertEqual(c['status'], D.STATUS_INFO)

    def test_enabled(self):
        c = D.check_quota_email({'enabled': True, 'threshold_percent': 85})
        self.assertEqual(c['status'], D.STATUS_OK)
        self.assertIn('85%', c['detail'])

    def test_enabled_default_threshold(self):
        c = D.check_quota_email({'enabled': True})
        self.assertIn('90%', c['detail'])


class TestUltrawatchImport(unittest.TestCase):
    def test_no_file(self):
        c = D.check_ultrawatch_import(None, False)
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertIsNone(c['action'])

    def test_found_not_imported(self):
        c = D.check_ultrawatch_import('/x/state.json', False)
        self.assertEqual(c['status'], D.STATUS_INFO)
        self.assertEqual(c['action']['path'], '/api/import/ultrawatch')

    def test_already_imported(self):
        c = D.check_ultrawatch_import('/x/state.json', True)
        self.assertEqual(c['status'], D.STATUS_OK)


class TestBuildDiagnostics(unittest.TestCase):
    def test_all_thirteen_checks_present_in_order(self):
        result = D.build_diagnostics(D.DiagnosticsInputs(), now=123.0)
        self.assertEqual(_ids(result), list(D.CHECK_ORDER))
        self.assertEqual(result['generated_at'], 123.0)
        self.assertEqual(len(result['checks']), 13)

    def test_install_progress_overrides_tab_colors_check(self):
        inputs = D.DiagnosticsInputs(tab_colors='available',
                                     install_progress={'status': 'installing',
                                                        'detail': 'Working…'})
        result = D.build_diagnostics(inputs)
        row = next(c for c in result['checks'] if c['id'] == 'tab_colors')
        self.assertEqual(row['status'], D.STATUS_INFO)
        self.assertEqual(row['detail'], 'Working…')

    def test_install_progress_error(self):
        inputs = D.DiagnosticsInputs(
            install_progress={'status': 'error', 'detail': 'boom'})
        row = next(c for c in D.build_diagnostics(inputs)['checks']
                  if c['id'] == 'tab_colors')
        self.assertEqual(row['status'], D.STATUS_ERROR)
        self.assertEqual(row['action']['path'], '/api/colors/install')

    def test_install_progress_restart_required(self):
        inputs = D.DiagnosticsInputs(
            install_progress={'status': 'restart_required',
                              'detail': 'Restart please.'})
        row = next(c for c in D.build_diagnostics(inputs)['checks']
                  if c['id'] == 'tab_colors')
        self.assertEqual(row['status'], D.STATUS_WARN)


class TestSummary(unittest.TestCase):
    def test_counts_by_status(self):
        result = D.build_diagnostics(D.DiagnosticsInputs())
        counts = D.summary(result)
        self.assertEqual(sum(counts.values()), 13)
        self.assertGreaterEqual(counts[D.STATUS_INFO], 1)


class TestProbes(unittest.TestCase):
    def test_python_version_matches_running_interpreter(self):
        import sys
        self.assertEqual(D.Probes().python_version(),
                         (sys.version_info.major, sys.version_info.minor))

    def test_iterm_installed_true_when_app_dir_exists(self):
        probes = D.Probes()
        with mock.patch('os.path.isdir', return_value=True), \
                mock.patch.object(probes, '_runner') as runner:
            self.assertTrue(probes.iterm_installed())
            runner.assert_not_called()

    def test_iterm_installed_falls_back_to_mdfind(self):
        def fake_runner(argv, **kw):
            self.assertEqual(argv[0], 'mdfind')
            return mock.Mock(stdout='/Applications/iTerm.app\n')

        with mock.patch('os.path.isdir', return_value=False):
            probes = D.Probes(runner=fake_runner)
            self.assertTrue(probes.iterm_installed())

    def test_iterm_installed_false_when_mdfind_finds_nothing(self):
        with mock.patch('os.path.isdir', return_value=False):
            probes = D.Probes(runner=lambda *a, **k: mock.Mock(stdout=''))
            self.assertFalse(probes.iterm_installed())

    def test_iterm_installed_false_when_runner_raises(self):
        def boom(*a, **k):
            raise OSError('no mdfind')

        with mock.patch('os.path.isdir', return_value=False):
            self.assertFalse(D.Probes(runner=boom).iterm_installed())

    def test_claude_token_present_delegates_to_usage_claude(self):
        with mock.patch('everwatch.engine.usage_claude.get_oauth_token',
                        return_value='tok'):
            self.assertTrue(D.Probes().claude_token_present())
        with mock.patch('everwatch.engine.usage_claude.get_oauth_token',
                        return_value=None):
            self.assertFalse(D.Probes().claude_token_present())

    def test_codex_auth_present_checks_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch('everwatch.diagnostics.config.HOME', tmp):
                self.assertFalse(D.Probes().codex_auth_present())
                os.makedirs(os.path.join(tmp, '.codex'))
                with open(os.path.join(tmp, '.codex', 'auth.json'), 'w') as f:
                    f.write('{}')
                self.assertTrue(D.Probes().codex_auth_present())

    def test_quota_config_delegates_to_notifier(self):
        with mock.patch('everwatch.engine.notifier.load_config',
                        return_value={'enabled': True}):
            self.assertEqual(D.Probes().quota_config(), {'enabled': True})

    def test_ultrawatch_path_delegates_to_persist(self):
        with mock.patch('everwatch.engine.persist.find_ultrawatch_state',
                        return_value='/x/state.json'):
            self.assertEqual(D.Probes().ultrawatch_path(), '/x/state.json')

    def test_snapshot_calls_every_probe(self):
        probes = D.FakeProbes(python_version=(3, 12), iterm_installed=False,
                              claude_token_present=True,
                              codex_auth_present=True,
                              quota_config={'enabled': True},
                              ultrawatch_path='/p')
        self.assertEqual(probes.snapshot(), {
            'python_version': (3, 12), 'iterm_installed': False,
            'claude_token_present': True, 'codex_auth_present': True,
            'quota_config': {'enabled': True}, 'ultrawatch_path': '/p'})


class TestFakeProbesNeverTouchesRealIO(unittest.TestCase):
    def test_runner_would_raise_if_ever_invoked(self):
        probes = D.FakeProbes()
        with self.assertRaises(AssertionError):
            probes._runner(['mdfind'])


class TestDemoPresets(unittest.TestCase):
    def test_preset_names_sorted_and_nonempty(self):
        names = D.preset_names()
        self.assertEqual(names, sorted(names))
        self.assertIn('all_ok', names)
        self.assertIn('permission_denied', names)

    def test_apply_preset_overrides_fields(self):
        inputs = D.DiagnosticsInputs()
        D.apply_preset(inputs, 'permission_denied')
        self.assertEqual(inputs.iterm_status, base.STATUS_PERMISSION_DENIED)

    def test_unknown_preset_raises_keyerror(self):
        with self.assertRaises(KeyError):
            D.apply_preset(D.DiagnosticsInputs(), 'nonsense')

    def test_every_preset_produces_valid_diagnostics(self):
        for name in D.preset_names():
            inputs = D.DiagnosticsInputs()
            D.apply_preset(inputs, name)
            result = D.build_diagnostics(inputs)
            self.assertEqual(len(result['checks']), 13)

    def test_all_ok_preset_has_no_errors(self):
        inputs = D.DiagnosticsInputs()
        D.apply_preset(inputs, 'all_ok')
        result = D.build_diagnostics(inputs)
        self.assertEqual(D.summary(result)[D.STATUS_ERROR], 0)

    def test_permission_denied_preset_has_an_error(self):
        inputs = D.DiagnosticsInputs()
        D.apply_preset(inputs, 'permission_denied')
        result = D.build_diagnostics(inputs)
        self.assertGreaterEqual(D.summary(result)[D.STATUS_ERROR], 1)


if __name__ == '__main__':
    unittest.main()
