"""sse.py framing (unit) plus the server's SSE handler over a real
loopback socket (docs/DESIGN.md §3.3, §3.5)."""
import json
import socket
import unittest
from unittest import mock

from everwatch import sse
from everwatch.engine_loop import Event
from tests.py.server_helpers import ServerFixture, wait_until


class TestFormatEvent(unittest.TestCase):
    def test_basic_frame_has_event_and_data(self):
        frame = sse.format_event('state', {'rev': 3})
        self.assertIn('event: state\n', frame)
        self.assertIn('data: {"rev": 3}\n', frame)
        self.assertTrue(frame.endswith('\n\n'))

    def test_id_and_retry_lines(self):
        frame = sse.format_event('hello', {}, event_id=7, retry=3000)
        lines = frame.splitlines()
        self.assertEqual(lines[0], 'retry: 3000')
        self.assertEqual(lines[1], 'id: 7')
        self.assertEqual(lines[2], 'event: hello')

    def test_no_id_or_retry_by_default(self):
        frame = sse.format_event('ping', {'now': 1})
        self.assertFalse(frame.startswith('retry:'))
        self.assertFalse(frame.startswith('id:'))
        self.assertTrue(frame.startswith('event: ping\n'))

    def test_multiline_data_stays_valid_sse(self):
        # json.dumps never emits a literal newline (embedded ones are
        # escaped), so force one to prove the framer still splits any
        # '\n' in the serialized payload into multiple `data:` lines
        # per the SSE spec.
        with mock.patch('everwatch.sse.json.dumps', return_value='a\nb'):
            frame = sse.format_event('toast', 'irrelevant')
        data_lines = [l for l in frame.splitlines() if l.startswith('data:')]
        self.assertEqual(data_lines, ['data: a', 'data: b'])


class TestIterEvents(unittest.TestCase):
    def test_round_trips_format_event(self):
        frame = sse.format_event('state', {'rev': 5}, event_id=5)
        events = list(sse.iter_events(frame.splitlines(keepends=True)))
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]['event'], 'state')
        self.assertEqual(events[0]['id'], '5')
        self.assertEqual(events[0]['data'], {'rev': 5})

    def test_multiple_frames(self):
        text = (sse.format_event('hello', {'a': 1}, event_id=1) +
               sse.format_event('ping', {'now': 2}))
        events = list(sse.iter_events(text.splitlines(keepends=True)))
        self.assertEqual([e['event'] for e in events], ['hello', 'ping'])

    def test_retry_line_is_ignored_as_data(self):
        events = list(sse.iter_events(
            ['retry: 3000\n', 'event: x\n', 'data: {}\n', '\n']))
        self.assertEqual(events, [{'event': 'x', 'id': None, 'data': {}}])

    def test_non_json_data_is_kept_as_raw_text(self):
        events = list(sse.iter_events(
            ['event: x\n', 'data: not-json\n', '\n']))
        self.assertEqual(events[0]['data'], 'not-json')

    def test_leading_blank_line_yields_nothing(self):
        events = list(sse.iter_events(
            ['\n', 'event: x\n', 'data: {}\n', '\n']))
        self.assertEqual([e['event'] for e in events], ['x'])

    def test_comment_lines_are_ignored(self):
        events = list(sse.iter_events(
            [': keepalive\n', 'event: x\n', 'data: {}\n', '\n']))
        self.assertEqual([e['event'] for e in events], ['x'])

    def test_unterminated_final_frame_is_still_yielded(self):
        # No trailing blank line -- the stream just ended (or the
        # connection dropped mid-frame).
        events = list(sse.iter_events(['event: x\n', 'data: {}\n']))
        self.assertEqual([e['event'] for e in events], ['x'])


class TestServerSSE(unittest.TestCase):
    """Integration: a real socket against server.Handler._handle_events."""

    def setUp(self):
        self.fx = ServerFixture(self, ping_seconds=0.15)

    def _get_stream(self, headers=None):
        sock = self.fx.raw_socket()
        self.addCleanup(sock.close)
        req = (f'GET /api/events?token={self.fx.token} HTTP/1.1\r\n'
              f'Host: 127.0.0.1:{self.fx.port}\r\n')
        for k, v in (headers or {}).items():
            req += f'{k}: {v}\r\n'
        req += 'Connection: close\r\n\r\n'
        sock.sendall(req.encode('ascii'))
        return sock

    def _read_events(self, sock, min_events=1, timeout=3.0):
        sock.settimeout(timeout)
        buf = b''
        # Skip the HTTP status line + response headers first.
        while b'\r\n\r\n' not in buf:
            buf += sock.recv(4096)
        buf = buf.split(b'\r\n\r\n', 1)[1]
        events = list(sse.iter_events(
            buf.decode('utf-8', 'replace').splitlines(keepends=True)))
        while len(events) < min_events:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            events = list(sse.iter_events(
                buf.decode('utf-8', 'replace').splitlines(keepends=True)))
        return events

    def test_fresh_connection_gets_hello_first(self):  # parity: P-77
        sock = self._get_stream()
        events = self._read_events(sock)
        self.assertEqual(events[0]['event'], 'hello')
        self.assertIn('version', events[0]['data'])
        self.assertIn('state', events[0]['data'])

    def test_last_event_id_gets_state_and_screens(self):
        sock = self._get_stream(headers={'Last-Event-ID': '1'})
        events = self._read_events(sock, min_events=2)
        self.assertEqual(events[0]['event'], 'state')
        self.assertEqual(events[1]['event'], 'screens')

    def test_idle_connection_gets_a_ping(self):
        sock = self._get_stream()
        events = self._read_events(sock, min_events=2, timeout=3.0)
        kinds = [e['event'] for e in events]
        self.assertIn('ping', kinds)
        ping = next(e for e in events if e['event'] == 'ping')
        self.assertIn('now', ping['data'])

    def test_disconnect_unsubscribes(self):
        sock = self._get_stream()
        self._read_events(sock)  # hello
        self.assertEqual(self.fx.engine.subscriber_count, 1)
        sock.close()
        self.assertTrue(wait_until(
            lambda: self.fx.engine.subscriber_count == 0, timeout=3.0))

    def test_missing_token_on_events_is_401(self):
        sock = self.fx.raw_socket()
        self.addCleanup(sock.close)
        req = (f'GET /api/events HTTP/1.1\r\n'
              f'Host: 127.0.0.1:{self.fx.port}\r\n'
              'Connection: close\r\n\r\n')
        sock.sendall(req.encode('ascii'))
        sock.settimeout(3.0)
        data = b''
        while b'\r\n\r\n' not in data:
            data += sock.recv(4096)
        self.assertIn(b'401', data.splitlines()[0])


class TestServerSSEOverflow(unittest.TestCase):
    """Backpressure: a subscriber whose queue overflows still gets a
    coherent fresh state, and the handler doesn't touch the engine
    thread while writing (§3.3)."""

    def setUp(self):
        self.fx = ServerFixture(self)

    def test_overflowed_subscription_streams_a_fresh_state(self):
        from everwatch import server as server_mod
        from tests.py.engine_helpers import sess

        engine = self.fx.engine
        fixture = self.fx.fixture
        # Same overflow mechanism as WP2's own
        # test_overflow_replaces_backlog_with_state_and_full_screens:
        # maxsize=2 (exactly one state + one screens event), then a
        # third publish while nobody has drained the queue.
        fixture.set_sessions(sess('A', text='a'))
        fixture.step()
        sub = engine.subscribe(initial=None, maxsize=2)
        fixture.set_sessions(sess('A', text='a2'))
        fixture.step()  # state + screens: queue is now full (2/2)
        fixture.set_sessions(sess('A', text='a3'))
        fixture.step()  # overflow: backlog replaced with a fresh pair
        self.assertGreaterEqual(sub.overflows, 1)

        written = []

        class FakeWfile:
            def write(self, data):
                written.append(data)
                if len(written) >= 2:
                    raise BrokenPipeError()

            def flush(self):
                pass

        class FakeHeaders(dict):
            def get(self, key, default=None):
                return dict.get(self, key, default)

        class FakeSelf:
            server = type('S', (), {'engine': engine, 'ping_seconds': 15.0,
                                    'sse_maxsize': 2})()
            headers = FakeHeaders()
            wfile = FakeWfile()
            sent = []

            def send_response(self, status):
                self.sent.append(('status', status))

            def send_header(self, k, v):
                self.sent.append(('header', k, v))

            def end_headers(self):
                self.sent.append(('end',))

            def _security_headers(self):
                pass

        fake = FakeSelf()
        # _handle_events would call engine.subscribe() itself; give it
        # our already-overflowed subscription instead.
        engine.subscribe = lambda *a, **kw: sub
        try:
            server_mod.Handler._handle_events(fake)
        finally:
            del engine.subscribe
        self.assertEqual(engine.subscriber_count, 0)  # unsubscribed
        text = b''.join(written).decode('utf-8')
        events = list(sse.iter_events(text.splitlines(keepends=True)))
        self.assertGreaterEqual(len(events), 1)
        self.assertEqual(events[0]['event'], 'state')


if __name__ == '__main__':
    unittest.main()
