"""The localhost HTTP/SSE server (docs/DESIGN.md §3.1, §3.5, §3.8).

`make_server(engine, token, ...)` returns a bound (but not yet serving)
`ThreadingHTTPServer`. Handler threads only ever read `engine.published`,
call `engine.call(...)` (a bounded wait on the engine thread), or
`engine.subscribe()` for `/api/events` -- they never touch the tracker,
store, or DataSource directly (§3.3).
"""
import http.server
import json
import logging
import mimetypes
import os
import re
import socket
import sys
import urllib.parse

from everwatch import security, sse
from everwatch.engine_loop import SUBSCRIBER_QUEUE_SIZE, CommandError

LOG = logging.getLogger('everwatch.server')

DEFAULT_WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'web')

CSP = ("default-src 'self'; connect-src 'self'; img-src 'self' data:; "
       "style-src 'self'; script-src 'self'; frame-ancestors 'none'")

PLACEHOLDER_HTML = b"""<!doctype html>
<html><head><meta charset="utf-8"><title>Everwatch</title></head>
<body style="font:14px -apple-system,sans-serif;padding:2em">
<h1>Everwatch backend is running</h1>
<p>The web UI assets (everwatch/web/) were not found alongside this
package. The API is still available under /api.</p>
</body></html>
"""


# --------------------------------------------------------------- routes

def _uid(m):
    return urllib.parse.unquote(m.group('uid'))


def h_state(ctx, m, body, query):
    return 200, ctx.server.engine.published.state


def h_screen(ctx, m, body, query):
    screen = ctx.server.engine.published.screen(_uid(m))
    if screen is None:
        raise CommandError('unknown_session', _uid(m), 404)
    return 200, screen


def h_goto(ctx, m, body, query):
    return 200, ctx.server.engine.call('goto', uid=_uid(m))


def h_visit(ctx, m, body, query):
    return 200, ctx.server.engine.call('visit', uid=_uid(m))


def h_send(ctx, m, body, query):
    # W-10: body validated by the engine (everwatch/terminput.py)
    return 200, ctx.server.engine.call('send', uid=_uid(m), body=body)


def h_live_on(ctx, m, body, query):
    return 200, ctx.server.engine.call('live', uid=_uid(m), on=True)


def h_live_off(ctx, m, body, query):
    return 200, ctx.server.engine.call('live', uid=_uid(m), on=False)


def h_set_label(ctx, m, body, query):
    return 200, ctx.server.engine.call('set_label', uid=_uid(m),
                                       label=body.get('label'))


def h_set_color(ctx, m, body, query):
    return 200, ctx.server.engine.call('set_color', uid=_uid(m),
                                       slot=body.get('slot'))


def h_new_tab(ctx, m, body, query):
    return 200, ctx.server.engine.call('new_tab')


def h_close_tab(ctx, m, body, query):
    if body.get('confirm') is not True:
        raise CommandError('confirm_required',
                           'close requires {"confirm": true}', 400)
    return 200, ctx.server.engine.call(
        'close_tab', window_id=int(m.group('window_id')),
        tab_index=int(m.group('tab_index')))


def h_refresh(ctx, m, body, query):
    return 200, ctx.server.engine.call('refresh')


def h_set_prefs(ctx, m, body, query):
    return 200, ctx.server.engine.call('set_prefs', patch=body)


def h_set_project(ctx, m, body, query):
    return 200, ctx.server.engine.call('set_project', n=int(m.group('n')),
                                       name=body.get('name'))


def h_clear_projects(ctx, m, body, query):
    return 200, ctx.server.engine.call('clear_projects')


def _query_one(query, key, default=None):
    values = query.get(key)
    return values[0] if values else default


def h_history(ctx, m, body, query):
    uid = _query_one(query, 'uid')
    minutes = _query_one(query, 'minutes', 60)
    return 200, ctx.server.engine.call('history', uid=uid, minutes=minutes)


def h_usage_history(ctx, m, body, query):
    since = _query_one(query, 'since', 0)
    return 200, ctx.server.engine.call('usage_history', since=since)


def h_quota_draft(ctx, m, body, query):
    return 200, ctx.server.engine.call('quota_draft')


def h_quota_skip(ctx, m, body, query):
    return 200, ctx.server.engine.call('quota_skip')


def h_import_ultrawatch(ctx, m, body, query):
    return 200, ctx.server.engine.call('import_ultrawatch')


def h_launch_iterm(ctx, m, body, query):
    return 200, ctx.server.engine.call('launch_iterm')


def h_diagnostics(ctx, m, body, query):
    return 200, ctx.server.engine.call('diagnostics')


def h_diagnostics_recheck(ctx, m, body, query):
    return 200, ctx.server.engine.call('diagnostics_recheck')


def h_colors_install(ctx, m, body, query):
    return 200, ctx.server.engine.call('colors_install')


ROUTES = [
    ('GET', r'^/api/state$', h_state),
    ('GET', r'^/api/sessions/(?P<uid>[^/]+)/screen$', h_screen),
    ('POST', r'^/api/sessions/(?P<uid>[^/]+)/goto$', h_goto),
    ('POST', r'^/api/sessions/(?P<uid>[^/]+)/visit$', h_visit),
    ('POST', r'^/api/sessions/(?P<uid>[^/]+)/send$', h_send),
    ('POST', r'^/api/sessions/(?P<uid>[^/]+)/live$', h_live_on),
    ('DELETE', r'^/api/sessions/(?P<uid>[^/]+)/live$', h_live_off),
    ('PUT', r'^/api/sessions/(?P<uid>[^/]+)/label$', h_set_label),
    ('PUT', r'^/api/sessions/(?P<uid>[^/]+)/color$', h_set_color),
    ('POST', r'^/api/tabs/new$', h_new_tab),
    ('POST', r'^/api/tabs/(?P<window_id>\d+)/(?P<tab_index>\d+)/close$',
     h_close_tab),
    ('POST', r'^/api/refresh$', h_refresh),
    ('PATCH', r'^/api/prefs$', h_set_prefs),
    ('PUT', r'^/api/projects/(?P<n>\d+)$', h_set_project),
    ('DELETE', r'^/api/projects$', h_clear_projects),
    ('GET', r'^/api/history$', h_history),
    ('GET', r'^/api/usage/history$', h_usage_history),
    ('GET', r'^/api/diagnostics$', h_diagnostics),
    ('POST', r'^/api/diagnostics/recheck$', h_diagnostics_recheck),
    ('POST', r'^/api/quota/draft$', h_quota_draft),
    ('POST', r'^/api/quota/skip$', h_quota_skip),
    ('POST', r'^/api/colors/install$', h_colors_install),
    ('POST', r'^/api/import/ultrawatch$', h_import_ultrawatch),
    ('POST', r'^/api/iterm/launch$', h_launch_iterm),
]
ROUTES = [(method, re.compile(pattern), func) for method, pattern, func in
          ROUTES]

MUTATING_METHODS = ('POST', 'PUT', 'PATCH', 'DELETE')


# --------------------------------------------------------------- server

class EverwatchHTTPServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET

    def __init__(self, address, handler_cls, *, engine, token, web_dir,
                 ping_seconds=sse.PING_SECONDS,
                 sse_maxsize=SUBSCRIBER_QUEUE_SIZE):
        super().__init__(address, handler_cls)
        self.engine = engine
        self.token = token
        self.web_dir = web_dir
        self.ping_seconds = ping_seconds
        self.sse_maxsize = sse_maxsize

    def handle_error(self, request, client_address):
        # A client that disconnects mid-SSE-stream (or resets a
        # keep-alive connection instead of sending FIN) is routine, not
        # a server bug; don't spam stderr/backend.log for it.
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            return
        super().handle_error(request, client_address)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'Everwatch/1'

    def log_message(self, fmt, *args):
        LOG.info('%s - %s', self.address_string(), fmt % args)

    def address_string(self):
        # The stdlib default does a reverse-DNS lookup per request,
        # which is needlessly slow on loopback and pointless besides.
        return self.client_address[0]

    # ------------------------------------------------------- responses

    def _security_headers(self):
        self.send_header('Content-Security-Policy', CSP)
        self.send_header('X-Content-Type-Options', 'nosniff')

    def _send_json(self, status, payload):
        body = json.dumps(payload, sort_keys=True,
                          ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, code, detail=''):
        self._send_json(status, {'error': code, 'detail': detail})

    def _send_bytes(self, status, body, content_type):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    # ----------------------------------------------------------- read

    def _read_body(self):
        length = self.headers.get('Content-Length')
        if length is None:
            return b''
        try:
            length = int(length)
        except ValueError:
            raise security.SecurityError(400, 'bad_content_length', length)
        security.check_body_size(length)
        return self.rfile.read(length) if length > 0 else b''

    # ------------------------------------------------------- dispatch

    def _dispatch(self, method):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            path = parsed.path
            query = urllib.parse.parse_qs(parsed.query)
            port = self.server.server_address[1]
            security.check_host(self.headers.get('Host'), port)
            security.check_origin(self.headers.get('Origin'), port)

            if method == 'GET' and path == '/api/events':
                token = _query_one(query, security.TOKEN_QUERY_PARAM, '')
                security.check_token(self.server.token, token)
                self._handle_events()
                return

            if path.startswith('/api/'):
                token = self.headers.get(security.TOKEN_HEADER, '')
                security.check_token(self.server.token, token)
                body = {}
                if method in MUTATING_METHODS:
                    security.check_content_type(
                        self.headers.get('Content-Type'))
                    raw = self._read_body()
                    if raw:
                        try:
                            body = json.loads(raw.decode('utf-8'))
                        except (ValueError, UnicodeDecodeError):
                            raise security.SecurityError(
                                400, 'bad_json', 'invalid JSON body')
                        if not isinstance(body, dict):
                            raise security.SecurityError(
                                400, 'bad_json', 'body must be an object')
                self._route(method, path, body, query)
                return

            if method not in ('GET', 'HEAD'):
                self._error(405, 'method_not_allowed', method)
                return
            self._serve_static(path, head=method == 'HEAD')
        except security.SecurityError as e:
            self._error(e.status, e.code, e.detail)
        except CommandError as e:
            self._error(e.status, e.code, e.detail)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _route(self, method, path, body, query):
        matched_other_method = False
        for route_method, regex, func in ROUTES:
            match = regex.match(path)
            if not match:
                continue
            if route_method != method:
                matched_other_method = True
                continue
            status, payload = func(self, match, body, query)
            self._send_json(status, payload)
            return
        if matched_other_method:
            self._error(405, 'method_not_allowed', method)
        else:
            self._error(404, 'not_found', path)

    # --------------------------------------------------------- static

    def _serve_static(self, path, head=False):
        web_dir = self.server.web_dir
        rel = path.lstrip('/') or 'index.html'
        if not web_dir or not os.path.isdir(web_dir):
            if rel in ('', 'index.html'):
                self._maybe_head(200, PLACEHOLDER_HTML, 'text/html', head)
            else:
                self._error(404, 'not_found', path)
            return
        safe_rel = os.path.normpath(rel)
        if safe_rel.startswith('..') or os.path.isabs(safe_rel):
            self._error(404, 'not_found', path)
            return
        full = os.path.join(web_dir, safe_rel)
        real_base = os.path.realpath(web_dir)
        real_full = os.path.realpath(full)
        if os.path.commonpath([real_full, real_base]) != real_base or \
                not os.path.isfile(real_full):
            self._error(404, 'not_found', path)
            return
        ctype, _ = mimetypes.guess_type(full)
        with open(full, 'rb') as f:
            data = f.read()
        self._maybe_head(200, data, ctype or 'application/octet-stream', head)

    def _maybe_head(self, status, body, content_type, head):
        if head:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self._security_headers()
            self.end_headers()
        else:
            self._send_bytes(status, body, content_type)

    # ------------------------------------------------------------ SSE

    def _handle_events(self):
        engine = self.server.engine
        last_id = self.headers.get('Last-Event-ID')
        initial = 'state' if last_id else 'hello'
        sub = engine.subscribe(initial=initial, maxsize=self.server.sse_maxsize)
        try:
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'keep-alive')
            self._security_headers()
            self.end_headers()
            first = True
            while True:
                ev = sub.get(timeout=self.server.ping_seconds)
                if ev is None:
                    frame = sse.format_event(
                        'ping', {'now': engine.clock.now()},
                        retry=sse.RETRY_MS if first else None)
                else:
                    frame = sse.format_event(
                        ev.type, ev.data, event_id=ev.id,
                        retry=sse.RETRY_MS if first else None)
                first = False
                self.wfile.write(frame.encode('utf-8'))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            engine.unsubscribe(sub)

    # ---------------------------------------------------------- verbs

    def do_GET(self):
        self._dispatch('GET')

    def do_HEAD(self):
        self._dispatch('HEAD')

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_PATCH(self):
        self._dispatch('PATCH')

    def do_DELETE(self):
        self._dispatch('DELETE')


def make_server(engine, token, host='127.0.0.1', port=0, web_dir=None,
                ping_seconds=sse.PING_SECONDS,
                sse_maxsize=SUBSCRIBER_QUEUE_SIZE):
    """Bind (but don't yet serve) an EverwatchHTTPServer. `web_dir`
    defaults to the packaged `everwatch/web/`; pass a missing/None
    directory to exercise the placeholder page."""
    if web_dir is None:
        web_dir = DEFAULT_WEB_DIR
    return EverwatchHTTPServer((host, port), Handler, engine=engine,
                               token=token, web_dir=web_dir,
                               ping_seconds=ping_seconds,
                               sse_maxsize=sse_maxsize)
