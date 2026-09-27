"""Quota-email opt-in notifier (P-68).

Adapted from ultrawatch_lib/notifier.py. Config file and marker paths
are unchanged from ultrawatch (`~/.claude/quota-email/`), so an existing
config keeps working without the user doing anything.

Deviation from ultrawatch: this module only decides *whether* a monthly
quota prompt is due — it never shows a system dialog itself (ultrawatch
used an `osascript display dialog`, which the hard rules in
docs/DESIGN.md forbid from Python/tests). The caller (engine_loop, WP2)
turns a truthy `check_quota()` result into a `quota_prompt` SSE event and
a native notification (P-69); the user's choice in the web UI then hits
`POST /api/quota/draft` or `/skip`, both of which call `mark_notified()`
so the month is marked regardless of which button was picked, exactly as
ultrawatch's dialog did.
"""
import json
import os
import time

CONFIG_PATH = os.path.expanduser('~/.claude/quota-email/config.json')
FLAG_PATH = os.path.expanduser('~/.claude/quota-email/.last-email-sent')


def _current_month(now=None):
    now = time.time() if now is None else now
    return time.strftime('%Y-%m', time.localtime(now))


def load_config():
    try:
        with open(CONFIG_PATH, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def is_enabled(cfg):
    """Email notifications are opt-in, including for legacy configs."""
    return isinstance(cfg, dict) and cfg.get('enabled') is True


def already_notified(now=None):
    try:
        with open(FLAG_PATH, encoding='utf-8') as f:
            return f.read().strip() == _current_month(now)
    except OSError:
        return False


def mark_notified(now=None):
    os.makedirs(os.path.dirname(FLAG_PATH), exist_ok=True)
    with open(FLAG_PATH, 'w', encoding='utf-8') as f:
        f.write(_current_month(now))


def check_quota(pct, now=None):
    """Return the loaded config dict if a quota prompt is due for this
    extra_usage.utilization percentage, else None.

    Call on every Claude usage event whose `extra_usage.is_enabled` is
    set, passing `utilization`. Fires at most once per calendar month:
    this function is read-only and never marks the month itself, so a
    caller that hasn't shown the prompt yet (e.g. it crashed) will see it
    again on the next usage event — only `mark_notified()` silences it.
    """
    cfg = load_config()
    if not is_enabled(cfg):
        return None
    threshold = cfg.get('threshold_percent', 90)
    if pct < threshold:
        return None
    if already_notified(now):
        return None
    return cfg
