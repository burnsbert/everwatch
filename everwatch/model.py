"""Pure view-model builders: session rows, tab labels, paths, titles,
self/dashboard detection, usage rows, and project slots.

Ported from ultrawatch_lib/ui/app.py (agent_kinds, tab_label,
window_number, session_path, shorten, row_title, build_rows' per-row
fields), ui/title_card.py (is_ultrawatch), ui/usage_footer.py
(build_rows), ui/draw.py (tail_lines, fuzzy_match), and
ui/projects_view.py (PROJECT_COLORS). Sorting and filtering happen in the
web client (web/js/lib/rows.mjs, P-46/P-47); the server sends sessions in
natural (window, tab, pane) order.

Everything here is a pure function of its arguments so it can be tested
without an engine, threads, or I/O.
"""
from datetime import datetime, timezone

from everwatch.engine import heuristics as H
from everwatch.engine import projection, timefmt, usage_claude, usage_codex

KIND_NAMES = {'claude': 'Claude Code', 'codex': 'Codex'}
BADGES = {'claude': 'CC', 'codex': 'CX', 'self': '▶▶▶', 'dashboard': 'UW',
          'plain': '···'}
# Project slot n (1-5) <-> iTerm2 tab color (projects_view.py:8).
PROJECT_COLORS = ('blue', 'purple', 'green', 'red', 'yellow')
DASHBOARD_BANNER = '▛▞ ULTRAWATCH'

CLAUDE_LABELS = (
    ('five_hour', 'CC Session Limit'),
    ('seven_day', 'CC Weekly Limit'),
    ('seven_day_sonnet', 'CC Sonnet Limit'),
)
CLAUDE_FETCH_FAILED = 'usage API fetch failed'
CODEX_FETCH_FAILED = 'Codex usage fetch failed'


# ------------------------------------------------------------ sessions

def agent_kinds(agents_snap):
    """{tty: 'claude'|'codex'}; claude wins when both share a tty (P-07)."""
    kinds = {}
    if agents_snap:
        for tty, agents in agents_snap.ttys:
            if 'claude' in agents:
                kinds[tty] = 'claude'
            elif 'codex' in agents:
                kinds[tty] = 'codex'
    return kinds


def window_numbers(sessions):
    """{window_id: 1-based ordinal} in order of first appearance (P-36)."""
    numbers = {}
    for s in sessions:
        if s.window_id not in numbers:
            numbers[s.window_id] = len(numbers) + 1
    return numbers


def tab_label(s, window_nos):
    """'3' with a single window, '2.3' when several are open (P-36)."""
    if len(window_nos) > 1:
        return f'{window_nos.get(s.window_id, s.window_id)}.{s.tab_index}'
    return str(s.tab_index)


def session_path(s, paths, agents_snap):
    """iTerm2's `path` variable, else the lsof cwd fallback (P-05, P-06)."""
    path = paths.get(s.uid, '')
    if not path and agents_snap:
        for tty, cwd in agents_snap.tty_cwd:
            if tty == s.tty and cwd:
                return cwd
    return path


def shorten(path, home):
    if home and path.startswith(home):
        return '~' + path[len(home):]
    return path


def row_title(uid, label, path, name):
    """Label, else ~-shortened path, else session name, else uid[:8]
    (app.py row_title). Used for toasts and notifications."""
    return label or path or name or uid[:8]


def is_dashboard_text(text):
    """A tab running ultrawatch shows its banner on the first line (P-28)."""
    return DASHBOARD_BANNER in text.split('\n', 1)[0]


def badge_for(kind, is_self, is_dashboard):
    if is_self:
        return BADGES['self']
    if is_dashboard:
        return BADGES['dashboard']
    if kind:
        return BADGES[kind]
    return BADGES['plain']


def project_for_color(color):
    """Project slot (1-5) whose color is `color`, else None."""
    try:
        return PROJECT_COLORS.index(color) + 1
    except ValueError:
        return None


def build_sessions(snapshot, *, paths, agents_snap, colors, tracker,
                   label_for, home, my_tty='', spark_for=None):
    """Session dicts for the State (docs/DESIGN.md §3.5) in natural order.

    label_for(uid) -> str; spark_for(uid, state, state_since) -> str."""
    if not snapshot:
        return []
    sessions = snapshot.sessions
    kinds = agent_kinds(agents_snap)
    window_nos = window_numbers(sessions)
    out = []
    for s in sorted(sessions, key=lambda x: (window_nos[x.window_id],
                                             x.tab_index, x.session_index)):
        kind = kinds.get(s.tty)
        is_self = bool(my_tty) and s.tty == my_tty
        is_dashboard = not is_self and is_dashboard_text(s.text)
        label = label_for(s.uid)
        state, since, rule = tracker.state(s.uid)
        path = shorten(session_path(s, paths, agents_snap), home)
        tab_color = colors.get(s.uid)
        out.append({
            'uid': s.uid,
            'window_id': s.window_id,
            'window_no': window_nos[s.window_id],
            'tab_index': s.tab_index,
            'session_index': s.session_index,
            'tab_label': tab_label(s, window_nos),
            'tty': s.tty,
            'name': s.name,
            'path': path,
            'kind': kind,
            'badge': badge_for(kind, is_self, is_dashboard),
            'is_self': is_self,
            'is_dashboard': is_dashboard,
            'state': state,
            'state_since': since,
            'rule': rule,
            'attention': tracker.has_attention(s.uid),
            'last_change': tracker.last_change(s.uid),
            'label': label,
            'display_name': label or ('everwatch' if is_self else s.name),
            'title': row_title(s.uid, label, path, s.name),
            'tab_color': tab_color,
            'project': project_for_color(tab_color),
            'screen_hash': H.text_hash(s.text),
            'spark': spark_for(s.uid, state, since) if spark_for else '',
        })
    return out


def counts(sessions, waiting_n):
    return {'tabs': len(sessions),
            'agents': sum(1 for s in sessions if s['kind']),
            'waiting': waiting_n}


def build_projects(names, is_open, sessions):
    """Projects sidebar: 5 colored slots, each with the number of live
    sessions whose tab has that slot's color (P-61)."""
    slots = []
    for i, color in enumerate(PROJECT_COLORS):
        slots.append({
            'n': i + 1,
            'name': names[i] if i < len(names) else '',
            'color': color,
            'count': sum(1 for s in sessions if s['tab_color'] == color),
        })
    return {'open': bool(is_open), 'slots': slots}


# ---------------------------------------------------------------- usage

def _projection(proj):
    """`{text, hit, at}`; `at` is the projected run-out time as UTC ISO
    (engine/projection.py `Projection.at`), null when hit or unknown."""
    if not proj:
        return None
    text, hit = proj
    at = getattr(proj, 'at', None)
    return {'text': text.strip().lstrip('⚠').strip(), 'hit': bool(hit),
            'at': at.isoformat() if at is not None and not hit else None}


def _epoch_iso(epoch):
    if not epoch:
        return None
    try:
        return datetime.fromtimestamp(epoch, timezone.utc).isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def section_status(snap):
    """'inactive' | 'ok' | 'stale' | 'failing' for a UsageSnapshot (P-53,
    P-56). `stale` = the last fetch failed but last-good data is shown."""
    if snap is None or snap.inactive:
        return 'inactive'
    if snap.data:
        return 'ok' if snap.ok else 'stale'
    return 'failing' if not snap.ok else 'inactive'


def claude_rows(data, show_dollars, now):
    """Usage rows for Claude Code (usage_footer.build_rows, P-54, P-55,
    P-58). `now` is epoch seconds."""
    if not data:
        return []
    now_utc = datetime.fromtimestamp(now, timezone.utc)
    now_local = datetime.fromtimestamp(now)
    rows = []
    for key, label in CLAUDE_LABELS:
        bucket = data.get(key)
        if not bucket:
            continue
        pct = bucket.get('utilization') or 0
        resets_at = bucket.get('resets_at')
        rows.append({
            'id': f'cc.{key}',
            'label': label,
            'pct': pct,
            'level': projection.usage_level(pct),
            'hit': pct >= 100,
            'reset_at': resets_at,
            'reset_text': timefmt.format_reset_time(resets_at, now=now_utc),
            'dollars': None,
            'projection': _projection(
                projection.limit_projection(key, bucket, now=now_utc)),
        })
    extra = usage_claude.claude_extra_usage_row(data, False, now=now_local)
    if extra:
        info = data.get('extra_usage') or {}
        limit = info.get('monthly_limit')
        dollars = None
        if show_dollars and limit:
            dollars = {
                'used': usage_claude.format_dollar_limit(
                    info.get('used_credits') or 0),
                'limit': usage_claude.format_dollar_limit(limit),
            }
        reset_at, reset_text = None, ''
        if limit:
            nms = timefmt.next_month_start(now_local)
            reset_at = nms.astimezone().isoformat()
            reset_text = timefmt.format_reset_delta(nms, now=now_local)
        rows.append({
            'id': 'cc.monthly' if limit else 'cc.extra',
            'label': extra['label'].strip(),
            'pct': extra['pct'],
            'level': projection.usage_level(extra['pct']),
            'hit': extra['hit'],
            'reset_at': reset_at,
            'reset_text': reset_text,
            'dollars': dollars,
            'projection': _projection(extra['projection']),
        })
    return rows


_CODEX_IDS = {'CX 5h Limit': 'cx.five_hour', 'CX 7d Limit': 'cx.seven_day'}


def codex_rows(data, now):
    """Usage rows for Codex (P-54, P-55)."""
    if not data:
        return []
    now_utc = datetime.fromtimestamp(now, timezone.utc)
    rate_limit = data.get('rate_limit') or {}
    windows = [rate_limit.get('primary_window'),
               rate_limit.get('secondary_window')]
    rows = []
    items = usage_codex.codex_usage_rows(data, now=now_utc)
    live = [w for w in windows if w and w.get('used_percent') is not None]
    for i, item in enumerate(items):
        window = live[i] if i < len(live) else {}
        rows.append({
            'id': _CODEX_IDS.get(item['label'], f'cx.window{i + 1}'),
            'label': item['label'],
            'pct': item['pct'],
            'level': projection.usage_level(item['pct']),
            'hit': item['hit'],
            'reset_at': _epoch_iso(window.get('reset_at')),
            'reset_text': item['reset'],
            'dollars': None,
            'projection': _projection(item['projection']),
        })
    return rows


def build_usage_section(snap, good_at, rows_fn, error_text):
    status = section_status(snap)
    out = {'status': status, 'at': good_at if status != 'inactive' else 0,
           'checked_at': snap.at if snap else 0, 'error': '', 'rows': []}
    if status == 'inactive':
        out['checked_at'] = 0
        return out
    if status == 'failing':
        out['error'] = error_text
        return out
    out['rows'] = rows_fn(snap.data)
    return out


def build_usage(cu, cx, good_at, show_dollars, now):
    """State.usage (docs/DESIGN.md §3.5). good_at = {'claude': t,
    'codex': t}, the time of the last successful fetch of each."""
    return {
        'claude': build_usage_section(
            cu, good_at.get('claude', 0),
            lambda d: claude_rows(d, show_dollars, now),
            CLAUDE_FETCH_FAILED),
        'codex': build_usage_section(
            cx, good_at.get('codex', 0), lambda d: codex_rows(d, now),
            CODEX_FETCH_FAILED),
    }


def extra_usage_pct(data):
    """extra_usage.utilization when extra usage is enabled, else None
    (the quota prompt trigger, P-68)."""
    if not data:
        return None
    extra = data.get('extra_usage')
    if not isinstance(extra, dict) or not extra.get('is_enabled'):
        return None
    return extra.get('utilization') or 0


# ------------------------------------------------ screen text helpers

def _is_chrome(line):
    s = line.strip()
    if not s or s == '❯':
        return True
    if set(s) <= {'─', '━'}:
        return True
    if s.startswith('⏵⏵'):
        return True
    return '% remaining]' in s


def tail_lines(text, n, width=None, strip_chrome=False):
    """Last n non-trailing-blank screen lines, each clipped to width
    (draw.py tail_lines, P-44). strip_chrome drops up to 8 trailing
    agent-CLI chrome lines so tiny previews show real content."""
    lines = [line.rstrip() for line in text.split('\n')]
    while lines and not lines[-1]:
        lines.pop()
    if strip_chrome:
        stripped = 0
        while lines and stripped < 8 and _is_chrome(lines[-1]):
            lines.pop()
            stripped += 1
        while lines and not lines[-1]:
            lines.pop()
    if n <= 0:
        return []
    out = lines[-n:]
    if width is not None:
        out = [line[:max(0, width)] for line in out]
    return out


def fuzzy_match(needle, haystack):
    """Case-insensitive subsequence match (draw.py fuzzy_match, P-46)."""
    if not needle:
        return True
    needle = needle.lower()
    haystack = haystack.lower()
    pos = 0
    for ch in needle:
        pos = haystack.find(ch, pos)
        if pos < 0:
            return False
        pos += 1
    return True
