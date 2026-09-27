"""server.py: routing, auth/CSRF checks, static files, and every §3.5
endpoint against a FakeSource-backed engine, over a real loopback
socket (docs/DESIGN.md §3.5, §3.8, §7 WP3 row)."""
import json
import os
import tempfile
import time
import unittest

from everwatch import diagnostics as D
from everwatch.sources.fake import FakeSource
from tests.py.engine_helpers import sess, snap
from tests.py.server_helpers import ServerFixture


def _find_event(sub, event_type, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        ev = sub.get(timeout=0.1)
        if ev is not None and ev.type == event_type:
            return ev
    return None


class TestAuthAndCSRF(unittest.TestCase):
    def setUp(self):
        self.fx = ServerFixture(self)

    def test_missing_token_is_401(self):
        status, _h, body = self.fx.request('GET', '/api/state', token=False)
        self.assertEqual(status, 401)
        self.assertEqual(body['error'], 'unauthorized')

    def test_wrong_token_is_403(self):
        status, _h, body = self.fx.request(
            'GET', '/api/state', headers={'X-Everwatch-Token': 'nope'},
            token=False)
        self.assertEqual(status, 403)
        self.assertEqual(body['error'], 'forbidden')

    def test_bad_host_is_403(self):
        status, _h, body = self.fx.request(
            'GET', '/api/state', headers={'Host': 'evil.example.com:80'})
        self.assertEqual(status, 403)
        self.assertEqual(body['error'], 'bad_host')

    def test_cross_origin_is_403(self):
        status, _h, body = self.fx.request(
            'GET', '/api/state',
            headers={'Origin': 'http://evil.example.com'})
        self.assertEqual(status, 403)
        self.assertEqual(body['error'], 'bad_origin')

    def test_same_origin_passes(self):
        status, _h, _body = self.fx.request(
            'GET', '/api/state',
            headers={'Origin': f'http://127.0.0.1:{self.fx.port}'})
        self.assertEqual(status, 200)

    def test_wrong_content_type_on_mutating_request_is_403(self):
        status, _h, body = self.fx.request(
            'POST', '/api/refresh', body={}, content_type=False,
            headers={'Content-Type': 'text/plain'})
        self.assertEqual(status, 403)
        self.assertEqual(body['error'], 'bad_content_type')

    def test_missing_content_type_on_mutating_request_is_403(self):
        conn = self.fx.connect()
        conn.request('POST', '/api/refresh', body=b'{}',
                    headers={'X-Everwatch-Token': self.fx.token})
        resp = conn.getresponse()
        body = json.loads(resp.read())
        conn.close()
        self.assertEqual(resp.status, 403)
        self.assertEqual(body['error'], 'bad_content_type')

    def test_body_too_large_is_413(self):
        conn = self.fx.connect()
        big = json.dumps({'label': 'x' * 200000}).encode('utf-8')
        conn.request('PUT', '/api/sessions/A/label', body=big,
                    headers={'X-Everwatch-Token': self.fx.token,
                             'Content-Type': 'application/json'})
        resp = conn.getresponse()
        body = json.loads(resp.read())
        conn.close()
        self.assertEqual(resp.status, 413)
        self.assertEqual(body['error'], 'payload_too_large')

    def test_bad_json_body_is_400(self):
        conn = self.fx.connect()
        conn.request('POST', '/api/refresh', body=b'{not json',
                    headers={'X-Everwatch-Token': self.fx.token,
                             'Content-Type': 'application/json'})
        resp = conn.getresponse()
        body = json.loads(resp.read())
        conn.close()
        self.assertEqual(resp.status, 400)
        self.assertEqual(body['error'], 'bad_json')

    def test_events_endpoint_uses_query_token_not_header(self):
        # A correct header token doesn't help /api/events; it needs ?token=.
        status, _h, _body = self.fx.request(
            'GET', '/api/events', token=False,
            headers={'X-Everwatch-Token': self.fx.token})
        self.assertEqual(status, 401)


class TestSecurityHeaders(unittest.TestCase):
    def setUp(self):
        self.fx = ServerFixture(self)

    def test_api_response_has_csp_nosniff_and_no_store(self):
        status, headers, _body = self.fx.request('GET', '/api/state')
        self.assertEqual(status, 200)
        self.assertIn("default-src 'self'", headers['Content-Security-Policy'])
        self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertNotIn('Access-Control-Allow-Origin', headers)


class TestStaticFiles(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        with open(os.path.join(self.tmp.name, 'index.html'), 'w') as f:
            f.write('<html>hi</html>')
        os.makedirs(os.path.join(self.tmp.name, 'css'))
        with open(os.path.join(self.tmp.name, 'css', 'app.css'), 'w') as f:
            f.write('body{}')
        self.fx = ServerFixture(self, web_dir=self.tmp.name)

    def test_root_serves_index_html_without_a_token(self):
        status, headers, body = self.fx.request('GET', '/', token=False)
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])
        self.assertIn(b'hi', body if isinstance(body, bytes) else b'')

    def test_nested_asset_is_served(self):
        status, headers, _body = self.fx.request('GET', '/css/app.css',
                                                  token=False)
        self.assertEqual(status, 200)
        self.assertIn('text/css', headers['Content-Type'])

    def test_missing_file_is_404(self):
        status, _h, _body = self.fx.request('GET', '/nope.js', token=False)
        self.assertEqual(status, 404)

    def test_path_traversal_is_blocked(self):
        status, _h, _body = self.fx.request(
            'GET', '/../../../../etc/passwd', token=False)
        self.assertIn(status, (400, 404))

    def test_static_paths_ignore_bad_host_check_is_still_enforced(self):
        status, _h, _body = self.fx.request(
            'GET', '/', token=False,
            headers={'Host': 'evil.example.com:1'})
        self.assertEqual(status, 403)


class TestMissingWebDir(unittest.TestCase):
    def test_placeholder_page_when_web_dir_absent(self):
        fx = ServerFixture(self, web_dir='/no/such/dir')
        status, headers, _body = fx.request('GET', '/', token=False)
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])


class TestEndpoints(unittest.TestCase):
    def setUp(self):
        self.src = FakeSource()
        self.src.set('fetch_snapshot', snap(
            sess('A', tty='/dev/ttys001', text='$ '),
            sess('B', tty='/dev/ttys002', window=2, tab=1)))
        # diag_probes=FakeProbes(): diagnostics endpoints must never reach
        # the real keychain/mdfind, even indirectly, from a test process.
        self.fx = ServerFixture(self, source=self.src,
                                diag_probes=D.FakeProbes())
        # Populate the tracker with a real snapshot before exercising
        # session-scoped commands (goto/visit/label/color all 404 on an
        # unknown uid, per WP2's CommandError contract).
        self.fx.fixture.step()

    def test_get_state_returns_full_state(self):
        status, _h, body = self.fx.request('GET', '/api/state')
        self.assertEqual(status, 200)
        self.assertEqual(len(body['sessions']), 2)
        self.assertIn('screens', body)

    def test_get_screen(self):
        status, _h, body = self.fx.request('GET', '/api/sessions/A/screen')
        self.assertEqual(status, 200)
        self.assertEqual(body['uid'], 'A')
        self.assertIn('screen_hash', body)

    def test_get_screen_unknown_uid_is_404(self):
        status, _h, body = self.fx.request('GET', '/api/sessions/ZZ/screen')
        self.assertEqual(status, 404)
        self.assertEqual(body['error'], 'unknown_session')

    def test_goto_known_session(self):  # parity: P-09
        status, _h, body = self.fx.request(
            'POST', '/api/sessions/A/goto', body={})
        self.assertEqual(status, 200)
        self.assertIn('id', body)

    def test_goto_unknown_session_is_404(self):
        status, _h, body = self.fx.request(
            'POST', '/api/sessions/ZZ/goto', body={})
        self.assertEqual(status, 404)
        self.assertEqual(body['error'], 'unknown_session')

    def test_visit(self):
        status, _h, body = self.fx.request(
            'POST', '/api/sessions/A/visit', body={})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})

    def test_set_label(self):
        status, _h, body = self.fx.request(
            'PUT', '/api/sessions/A/label', body={'label': 'deploy'})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})
        status, _h, state = self.fx.request('GET', '/api/state')
        row = next(s for s in state['sessions'] if s['uid'] == 'A')
        self.assertEqual(row['label'], 'deploy')

    def test_set_label_bad_type_is_400(self):
        status, _h, body = self.fx.request(
            'PUT', '/api/sessions/A/label', body={'label': 5})
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'invalid_label')

    def test_set_color_unavailable_is_409(self):
        # capabilities.tab_colors starts 'unknown', so this actually
        # succeeds (WP2 deviation #3); force it unavailable first.
        self.src.set('fetch_colors', None)
        # Directly flip the engine's cached status the way a poller would.
        self.fx.engine._tab_colors = 'not_installed'
        status, _h, body = self.fx.request(
            'PUT', '/api/sessions/A/color', body={'slot': 1})
        self.assertEqual(status, 409)
        self.assertEqual(body['error'], 'tab_colors_unavailable')

    def test_set_color_invalid_slot_is_400(self):
        status, _h, body = self.fx.request(
            'PUT', '/api/sessions/A/color', body={'slot': 9})
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'invalid_slot')

    def test_new_tab(self):
        status, _h, body = self.fx.request('POST', '/api/tabs/new', body={})
        self.assertEqual(status, 200)
        self.assertIn('id', body)

    def test_close_tab_requires_confirm(self):  # parity: P-09
        status, _h, body = self.fx.request(
            'POST', '/api/tabs/2/1/close', body={})
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'confirm_required')

    def test_close_tab_with_confirm(self):  # parity: P-09
        status, _h, body = self.fx.request(
            'POST', '/api/tabs/2/1/close', body={'confirm': True})
        self.assertEqual(status, 200)
        self.assertIn('id', body)

    def test_refresh(self):  # parity: P-10
        status, _h, body = self.fx.request('POST', '/api/refresh', body={})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})

    def test_set_prefs(self):
        status, _h, body = self.fx.request(
            'PATCH', '/api/prefs', body={'show_dollars': True})
        self.assertEqual(status, 200)
        self.assertTrue(body['show_dollars'])

    def test_set_prefs_invalid_is_400(self):
        status, _h, body = self.fx.request(
            'PATCH', '/api/prefs', body={'view': 'nonsense'})
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'invalid_prefs')

    def test_set_project(self):
        status, _h, body = self.fx.request(
            'PUT', '/api/projects/1', body={'name': 'API'})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})

    def test_clear_projects(self):
        status, _h, body = self.fx.request('DELETE', '/api/projects',
                                           body={})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})

    def test_history(self):
        status, _h, body = self.fx.request('GET', '/api/history?uid=A')
        self.assertEqual(status, 200)
        self.assertIn('transitions', body)
        self.assertIn('stats', body)

    def test_history_without_uid(self):
        status, _h, body = self.fx.request('GET', '/api/history')
        self.assertEqual(status, 200)
        self.assertIn('transitions', body)
        self.assertNotIn('stats', body)

    def test_usage_history(self):
        status, _h, body = self.fx.request('GET', '/api/usage/history')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'samples': []})

    def test_get_diagnostics(self):
        status, _h, body = self.fx.request('GET', '/api/diagnostics')
        self.assertEqual(status, 200)
        self.assertEqual(len(body['checks']), 13)

    def test_diagnostics_recheck(self):
        status, _h, body = self.fx.request(
            'POST', '/api/diagnostics/recheck', body={})
        self.assertEqual(status, 200)
        self.assertEqual(len(body['checks']), 13)

    def test_diagnostics_sse_event_on_first_request(self):
        sub = self.fx.engine.subscribe(initial=None)
        status, _h, _body = self.fx.request('GET', '/api/diagnostics')
        self.assertEqual(status, 200)
        ev = _find_event(sub, 'diagnostics')
        self.assertIsNotNone(ev)

    def test_colors_install_returns_id_and_streams_progress(self):
        status, _h, body = self.fx.request(
            'POST', '/api/colors/install', body={})
        self.assertEqual(status, 200)
        self.assertIn('id', body)

    def test_colors_install_already_running_is_409(self):
        self.fx.engine._install_running = True
        status, _h, body = self.fx.request(
            'POST', '/api/colors/install', body={})
        self.assertEqual(status, 409)
        self.assertEqual(body['error'], 'install_in_progress')

    def test_quota_skip_without_prompt_is_409(self):
        status, _h, body = self.fx.request('POST', '/api/quota/skip',
                                           body={})
        self.assertEqual(status, 409)
        self.assertEqual(body['error'], 'no_quota_prompt')

    def test_quota_draft_opens_gmail_url_and_marks_month(self):
        # Bypass the usage-poll timing to set up a pending prompt
        # directly, the same shape engine_loop._on_usage would build.
        self.fx.engine.quota_prompt = {'pct': 92, 'to': 'boss@example.com',
                                       'month': '2026-09'}
        self.fx.engine._quota_cfg = {
            'enabled': True,
            'email': {'to': 'boss@example.com', 'subject': 'S', 'body': 'B'}}
        status, _h, body = self.fx.request('POST', '/api/quota/draft',
                                           body={})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True, 'opened': True})
        self.assertIn('mail.google.com', self.src.calls_to('open_url')[0][1][0])
        status, _h, state = self.fx.request('GET', '/api/state')
        self.assertIsNone(state['quota_prompt'])

    def test_import_ultrawatch_no_file(self):
        status, _h, body = self.fx.request(
            'POST', '/api/import/ultrawatch', body={})
        self.assertEqual(status, 200)
        self.assertIn('imported', body)

    def test_launch_iterm(self):
        status, _h, body = self.fx.request('POST', '/api/iterm/launch',
                                           body={})
        self.assertEqual(status, 200)
        self.assertEqual(body, {'ok': True})

    def test_unknown_api_route_is_404(self):
        status, _h, body = self.fx.request('GET', '/api/nope')
        self.assertEqual(status, 404)
        self.assertEqual(body['error'], 'not_found')

    def test_wrong_method_on_known_route_is_405(self):
        status, _h, body = self.fx.request('DELETE', '/api/state', body={})
        self.assertEqual(status, 405)
        self.assertEqual(body['error'], 'method_not_allowed')


class TestServerEdgeCases(unittest.TestCase):
    def setUp(self):
        self.fx = ServerFixture(self)

    def test_post_to_static_path_is_405(self):
        status, _h, body = self.fx.request('POST', '/', body={},
                                           token=False)
        self.assertEqual(status, 405)
        self.assertEqual(body['error'], 'method_not_allowed')

    def test_missing_file_404_when_web_dir_absent(self):
        fx = ServerFixture(self, web_dir='/no/such/dir')
        status, _h, _body = fx.request('GET', '/nope.js', token=False)
        self.assertEqual(status, 404)

    def test_head_request_on_static_root(self):
        status, headers, body = self.fx.request('HEAD', '/', token=False)
        self.assertEqual(status, 200)
        self.assertIn('text/html', headers['Content-Type'])
        self.assertIsNone(body)  # HEAD has no body

    def test_bad_content_length_header_is_400(self):
        sock = self.fx.raw_socket()
        self.addCleanup(sock.close)
        req = (f'POST /api/refresh HTTP/1.1\r\n'
              f'Host: 127.0.0.1:{self.fx.port}\r\n'
              f'X-Everwatch-Token: {self.fx.token}\r\n'
              'Content-Type: application/json\r\n'
              'Content-Length: notanumber\r\n'
              'Connection: close\r\n\r\n')
        sock.sendall(req.encode('ascii'))
        sock.settimeout(3.0)
        data = b''
        while b'\r\n\r\n' not in data:
            data += sock.recv(4096)
        self.assertIn(b'400', data.splitlines()[0])

    def test_empty_mutating_body_defaults_to_empty_object(self):
        conn = self.fx.connect()
        conn.request('POST', '/api/refresh', body=b'',
                    headers={'X-Everwatch-Token': self.fx.token,
                             'Content-Type': 'application/json',
                             'Content-Length': '0'})
        resp = conn.getresponse()
        body = json.loads(resp.read())
        conn.close()
        self.assertEqual(resp.status, 200)
        self.assertEqual(body, {'ok': True})

    def test_non_object_json_body_is_400(self):
        status, _h, body = self.fx.request('POST', '/api/refresh', body=[1, 2])
        self.assertEqual(status, 400)
        self.assertEqual(body['error'], 'bad_json')


class TestDispatchBrokenPipe(unittest.TestCase):
    def test_dispatch_swallows_broken_pipe_from_the_route_handler(self):
        from everwatch import server as server_mod

        class FakeSelf:
            path = '/'
            headers = {'Host': '127.0.0.1:1234'}
            server = type('S', (), {'server_address': ('127.0.0.1', 1234),
                                    'web_dir': None})()

            def _serve_static(self, path, head=False):
                raise BrokenPipeError()

        server_mod.Handler._dispatch(FakeSelf(), 'GET')  # must not raise


class TestHandleError(unittest.TestCase):
    def test_reset_and_broken_pipe_are_swallowed(self):
        fx = ServerFixture(self)
        for exc_cls in (ConnectionResetError, BrokenPipeError):
            try:
                raise exc_cls('boom')
            except exc_cls:
                fx.server.handle_error(None, ('127.0.0.1', 0))  # no raise

    def test_other_exceptions_reach_the_base_handler(self):
        from unittest import mock

        fx = ServerFixture(self)
        with mock.patch.object(fx.server.__class__.__mro__[1], 'handle_error'
                              ) as base:
            try:
                raise RuntimeError('boom')
            except RuntimeError:
                fx.server.handle_error(None, ('127.0.0.1', 0))
        base.assert_called_once()


if __name__ == '__main__':
    unittest.main()
