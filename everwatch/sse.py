"""Server-Sent Events framing (docs/DESIGN.md §3.3, §3.5).

Pure text formatting with no I/O, so it's unit-testable without a
socket. `server.py` writes `format_event(...)` straight to the response
stream and sends a `ping` whenever a subscription's `get(timeout=...)`
returns `None` (docs/build/wp2-handoff.md: "the engine doesn't send
ping; WP3 should").
"""
import json

#: Sent once, on the first frame of a stream, so a reconnecting
#: EventSource waits a sane amount before retrying if the connection
#: drops without an explicit error.
RETRY_MS = 3000

#: How long an SSE handler waits on `Subscription.get()` before it
#: decides the connection is idle and sends a `ping` keepalive.
PING_SECONDS = 15.0


def format_event(event_type, data, event_id=None, retry=None):
    """One SSE frame: optional `retry:`/`id:` lines, `event:`, one or
    more `data:` lines (JSON, split on '\\n' so a multi-line payload
    stays valid SSE), then the blank line that terminates the event."""
    lines = []
    if retry is not None:
        lines.append(f'retry: {int(retry)}')
    if event_id is not None:
        lines.append(f'id: {event_id}')
    lines.append(f'event: {event_type}')
    payload = json.dumps(data, sort_keys=True, ensure_ascii=False)
    for line in payload.split('\n'):
        lines.append(f'data: {line}')
    lines.append('')
    return '\n'.join(lines) + '\n'


def iter_events(lines):
    """Parse a raw SSE byte/text stream (an iterable of lines, each
    ending in '\\n' or not) into `{event, id, data}` dicts, one per
    blank-line-terminated frame. `data` is joined back with '\\n' and
    JSON-decoded when possible. Used by tests to assert on what the
    server actually wrote."""
    event_type = None
    event_id = None
    data_lines = []

    def _flush():
        if event_type is None and not data_lines:
            return None
        raw = '\n'.join(data_lines)
        try:
            data = json.loads(raw) if raw else None
        except ValueError:
            data = raw
        return {'event': event_type or 'message', 'id': event_id,
                'data': data}

    for line in lines:
        line = line.decode('utf-8') if isinstance(line, bytes) else line
        line = line.rstrip('\n').rstrip('\r')
        if line == '':
            ev = _flush()
            if ev is not None:
                yield ev
            event_type = None
            event_id = None
            data_lines = []
            continue
        if line.startswith('retry:'):
            continue
        if line.startswith('event:'):
            event_type = line[len('event:'):].strip()
        elif line.startswith('id:'):
            event_id = line[len('id:'):].strip()
        elif line.startswith('data:'):
            data_lines.append(line[len('data:'):].lstrip(' '))
    ev = _flush()
    if ev is not None:
        yield ev
