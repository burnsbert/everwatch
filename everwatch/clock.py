"""Injected time sources (docs/DESIGN.md §3.3).

Everything in the engine that needs "now" asks a Clock instead of calling
time.time() directly, so demo mode and tests can run on virtual time and
produce byte-identical output.

- SystemClock: wall time (real runs).
- FixedClock: frozen at one instant (`--clock fixed:<iso>`), used by the
  e2e suite and README screenshots.
- VirtualClock: starts at an instant and only moves when told to
  (`advance`/`set`). Tests and the demo warm-up use it.
- OffsetClock: starts at an instant and then advances with real
  (monotonic) time, so a demo started "at" a given moment stays live.
"""
import time
from datetime import datetime, timezone


class SystemClock:
    kind = 'system'

    def now(self):
        return time.time()


class FixedClock:
    kind = 'fixed'

    def __init__(self, at):
        self._at = float(at)

    def now(self):
        return self._at


class VirtualClock:
    kind = 'virtual'

    def __init__(self, at=0.0):
        self._at = float(at)

    def now(self):
        return self._at

    def set(self, at):
        self._at = float(at)

    def advance(self, seconds):
        self._at += float(seconds)
        return self._at


class OffsetClock:
    kind = 'offset'

    def __init__(self, at, monotonic=time.monotonic):
        self._at = float(at)
        self._monotonic = monotonic
        self._m0 = monotonic()

    def now(self):
        return self._at + (self._monotonic() - self._m0)


def parse_iso_epoch(text):
    """ISO 8601 (with offset, or 'Z') -> epoch seconds. Naive times are
    taken as UTC so the result never depends on the machine's zone."""
    text = text.strip()
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        from everwatch.engine.timefmt import parse_iso
        dt = parse_iso(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def parse_clock(spec):
    """CLI clock spec -> Clock.

    ''/None/'system'      -> SystemClock
    'fixed:<iso>'         -> FixedClock (frozen)
    'start:<iso>'         -> OffsetClock (starts there, then runs)
    'virtual:<iso>'       -> VirtualClock (moves only when advanced)
    Raises ValueError on anything else.
    """
    if not spec or spec == 'system':
        return SystemClock()
    kind, sep, rest = spec.partition(':')
    if not sep or not rest:
        raise ValueError(f'bad clock spec: {spec!r}')
    at = parse_iso_epoch(rest)
    if kind == 'fixed':
        return FixedClock(at)
    if kind == 'start':
        return OffsetClock(at)
    if kind == 'virtual':
        return VirtualClock(at)
    raise ValueError(f'bad clock spec: {spec!r}')
