"""Localhost security checks (docs/DESIGN.md §3.5, §3.8).

Every check here is stateless and side-effect free: given the request's
port and headers, either return normally or raise `SecurityError`, which
carries the HTTP status and JSON `error` code the server should send.
Nothing here touches the network or the filesystem, so it is trivial to
unit test directly (no HTTP server needed).
"""
import hmac
import re

TOKEN_HEADER = 'X-Everwatch-Token'
TOKEN_QUERY_PARAM = 'token'

# 64 KiB is comfortably larger than any real request body (prefs
# patches, labels, project names) while still bounding a hostile client.
MAX_BODY_BYTES = 64 * 1024

_HOST_RE = re.compile(r'^(127\.0\.0\.1|localhost)(?::(\d+))?$', re.IGNORECASE)


class SecurityError(Exception):
    """A request fails a security check. `status` is the HTTP status to
    send; `code` is the JSON body's `error` value."""

    def __init__(self, status, code, detail=''):
        super().__init__(f'{code}: {detail}' if detail else code)
        self.status = status
        self.code = code
        self.detail = detail


def check_host(host_header, port):
    """Host must be 127.0.0.1:<port> or localhost:<port> (blocks DNS
    rebinding). A missing or mismatched Host is a 403."""
    m = _HOST_RE.match((host_header or '').strip())
    if not m or int(m.group(2) or 0) != port:
        raise SecurityError(403, 'bad_host', host_header or '')


def _origin_allowed(origin, port):
    origin = (origin or '').rstrip('/').lower()
    return origin in (f'http://127.0.0.1:{port}', f'http://localhost:{port}')


def check_origin(origin_header, port):
    """If an Origin header is present, it must be this same origin
    (blocks CSRF from other pages/sites). No Origin header is allowed
    (same-origin navigations and EventSource often omit it)."""
    if not origin_header:
        return
    if not _origin_allowed(origin_header, port):
        raise SecurityError(403, 'bad_origin', origin_header)


def check_token(expected, provided):
    """Missing token -> 401 (not authenticated); present but wrong ->
    403 (authenticated request rejected). Compared with
    hmac.compare_digest so response timing doesn't leak the token."""
    if not provided:
        raise SecurityError(401, 'unauthorized', 'missing token')
    if not hmac.compare_digest(str(expected), str(provided)):
        raise SecurityError(403, 'forbidden', 'invalid token')


def check_content_type(content_type):
    """Mutating requests must be `Content-Type: application/json`
    (blocks form-post CSRF). A charset or other parameter after `;` is
    fine; anything else, or a missing header, is a 403."""
    base = (content_type or '').split(';', 1)[0].strip().lower()
    if base != 'application/json':
        raise SecurityError(403, 'bad_content_type', content_type or '')


def check_body_size(length):
    """`length` is the request's Content-Length, or None when absent.
    Oversized bodies are rejected before they're read."""
    if length is not None and length > MAX_BODY_BYTES:
        raise SecurityError(413, 'payload_too_large', str(length))
