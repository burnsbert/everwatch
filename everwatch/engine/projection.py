"""Usage-limit pace projections, bars, and severity levels.

Ported verbatim from ultrawatch_lib/projection.py. Pure logic; ``now``
is injectable for testing and is threaded into the time math and the
formatted output strings.
"""
import calendar
from datetime import datetime, timedelta, timezone

from everwatch.engine.timefmt import format_abs_time, next_month_start, parse_iso

WINDOW_HOURS = {
    'five_hour': 5,
    'seven_day': 168,
    'seven_day_sonnet': 168,
}

LIMIT_SHORT_NAMES = {
    'five_hour': 'session',
    'seven_day': 'weekly',
    'seven_day_sonnet': 'sonnet',
}


class Projection(tuple):
    """A projection result. It *is* the ported ``(text, hit)`` tuple, so
    ``text, hit = p`` and equality with a plain 2-tuple keep working, plus
    ``at``: the projected run-out time for a pace warning (an aware UTC
    datetime, whole seconds), or None once the limit is already hit.
    Everwatch addition (docs/design/VISUAL_SPEC.md §4.18.2): the UI shows
    the run-out time in its own format instead of parsing ``text``."""

    def __new__(cls, text, hit, at=None):
        self = super().__new__(cls, (text, hit))
        self.at = None if at is None else (
            at.astimezone(timezone.utc).replace(microsecond=0))
        return self


def limit_projection(key, bucket, now=None):
    """Return a warning string if the limit is hit or on pace to be hit, else None."""
    if not bucket:
        return None
    pct = bucket.get('utilization') or 0
    resets_at = bucket.get('resets_at')
    if not resets_at or pct <= 0:
        return None
    window_h = WINDOW_HOURS.get(key)
    if not window_h:
        return None
    try:
        reset_utc = parse_iso(resets_at)
        now = now or datetime.now(timezone.utc)
        secs_remaining = max(0, (reset_utc - now).total_seconds())
        window_secs = window_h * 3600
        elapsed_secs = window_secs - secs_remaining
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / window_secs) * 100
        name = LIMIT_SHORT_NAMES.get(key, key)
        if pct >= 100:
            return Projection(f'  ⚠ {name} limit hit', True)
        if pct >= elapsed_pct:
            # Project when we'll hit 100% at current rate
            rate = pct / elapsed_secs  # pct per second
            secs_to_100 = (100 - pct) / rate
            hit_time = now + timedelta(seconds=secs_to_100)
            hit_local = hit_time.astimezone()
            return Projection(f'  ⚠ on pace to hit {name} limit '
                              f'{format_abs_time(hit_local, now=now.astimezone())}',
                              False, hit_time)
    except Exception:
        pass
    return None


def monthly_limit_projection(pct, has_limit, now=None):
    """Return a warning string if monthly usage is on pace to hit the cap."""
    if not has_limit or pct <= 0:
        return None
    if pct >= 100:
        return Projection('  ⚠ monthly limit hit', True)
    try:
        now = now or datetime.now()
        days = calendar.monthrange(now.year, now.month)[1]
        month_secs = days * 86400
        elapsed_secs = ((now.day - 1) * 86400 + now.hour * 3600 +
                        now.minute * 60 + now.second)
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / month_secs) * 100
        if pct >= elapsed_pct:
            rate = pct / elapsed_secs
            secs_to_100 = (100 - pct) / rate
            hit_time = now + timedelta(seconds=secs_to_100)
            if hit_time < next_month_start(now):
                return Projection(f'  ⚠ on pace to hit monthly limit '
                                  f'{format_abs_time(hit_time, now=now)}',
                                  False, hit_time)
    except Exception:
        pass
    return None


def codex_limit_projection(label, window, limit_reached=False, now=None):
    """Return a Codex rate-limit warning string if the current pace is risky."""
    if not window:
        return None
    pct = window.get('used_percent') or 0
    reset_at = window.get('reset_at')
    window_secs = window.get('limit_window_seconds')
    if not reset_at or not window_secs or pct <= 0:
        return None
    name = label.replace('CX ', '').replace(' Limit', '').lower()
    if limit_reached or pct >= 100:
        return Projection(f'  ⚠ Codex {name} limit hit', True)
    try:
        reset_utc = datetime.fromtimestamp(reset_at, timezone.utc)
        now = now or datetime.now(timezone.utc)
        secs_remaining = max(0, (reset_utc - now).total_seconds())
        elapsed_secs = window_secs - secs_remaining
        if elapsed_secs <= 0:
            return None
        elapsed_pct = (elapsed_secs / window_secs) * 100
        if pct >= elapsed_pct:
            rate = pct / elapsed_secs
            secs_to_100 = (100 - pct) / rate
            hit_time = now + timedelta(seconds=secs_to_100)
            return Projection(f'  ⚠ on pace to hit Codex {name} limit '
                              f'{format_abs_time(hit_time.astimezone(), now=now.astimezone())}',
                              False, hit_time)
    except Exception:
        pass
    return None


def usage_bar(pct, width=15):
    """Return a text progress bar for the given percentage."""
    pct = max(0, min(100, pct))
    filled = round(pct / 100 * width)
    return '█' * filled + '░' * (width - filled)


def usage_level(pct):
    """Return a severity level name based on usage percentage.

    The UI maps the level ('red', 'yellow', 'green') to a color token.
    """
    if pct >= 80:
        return 'red'
    if pct >= 50:
        return 'yellow'
    return 'green'
