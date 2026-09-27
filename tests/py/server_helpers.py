"""Shared HTTP server test harness for WP3 (not a test module itself).

Starts a real `EverwatchHTTPServer` on an ephemeral 127.0.0.1 port
against a FakeSource-backed engine (see engine_helpers.EngineFixture)
and gives tests a small JSON request helper. The real-I/O guard
(tests/py/__init__.py) only allows `socket.create_connection` to
loopback addresses, which is exactly what this harness, and any test
that opens its own raw socket to it, does.
"""
import http.client
import json
import threading
import time

from everwatch import server as server_mod
from tests.py.engine_helpers import EngineFixture

TOKEN = 'test-token-abcdefghijklmnopqrstuvwxyz012345'


class ServerFixture:
    def __init__(self, testcase, engine=None, web_dir=None, token=TOKEN,
                ping_seconds=15.0, sse_maxsize=64, **engine_kw):
        self.testcase = testcase
        if engine is None:
            self.fixture = EngineFixture(testcase, **engine_kw)
            self.engine = self.fixture.engine
        else:
            self.fixture = None
            self.engine = engine
        self.token = token
        self.server = server_mod.make_server(
            self.engine, token, host='127.0.0.1', port=0, web_dir=web_dir,
            ping_seconds=ping_seconds, sse_maxsize=sse_maxsize)
        self.port = self.server.server_address[1]
        # A short poll_interval keeps shutdown() (and so test teardown)
        # fast; socketserver's default (0.5s) would otherwise dominate
        # this suite's runtime across dozens of per-test servers.
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={'poll_interval': 0.02},
            name='test-http', daemon=True)
        self.thread.start()
        testcase.addCleanup(self.close)

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def connect(self, timeout=5):
        return http.client.HTTPConnection('127.0.0.1', self.port,
                                          timeout=timeout)

    def raw_socket(self, timeout=5):
        import socket
        sock = socket.create_connection(('127.0.0.1', self.port),
                                        timeout=timeout)
        return sock

    def request(self, method, path, body=None, headers=None, token=True,
               content_type=True):
        conn = self.connect()
        h = dict(headers or {})
        if token and 'X-Everwatch-Token' not in h:
            h['X-Everwatch-Token'] = self.token
        data = None
        if body is not None:
            if content_type:
                h.setdefault('Content-Type', 'application/json')
            data = json.dumps(body).encode('utf-8')
        conn.request(method, path, body=data, headers=h)
        resp = conn.getresponse()
        raw = resp.read()
        headers_out = dict(resp.getheaders())
        conn.close()
        parsed = None
        if raw:
            try:
                parsed = json.loads(raw.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                parsed = raw
        return resp.status, headers_out, parsed


def wait_until(predicate, timeout=2.0, interval=0.02):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()
