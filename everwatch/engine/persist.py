"""Persistent user state: labels and preferences in state.json.

Ported from ultrawatch_lib/persist.py and upgraded to schema v2
(docs/DESIGN.md §3.7, P-70, P-71). Writes are atomic (tempfile +
os.replace), debounced so rapid changes (typing a label) don't hammer the
disk, and best-effort (a failed save never crashes the engine).

Schema v2 = the v1 keys (minus `bell`) plus theme, sound_on_attention,
dock_bounce, notify_on_waiting, grid_all, usage_collapsed, hotkey_show,
hotkey_next, show_hints, compact, onboarding_done, debug_state,
show_row_activity, agents_only, and imported_from_ultrawatch. Unknown keys are
preserved; invalid values are normalized to their defaults.

**Sound is never turned on by migration.** A v1 `bell` (Everwatch's own
early files or an imported ultrawatch state) is dropped; importing only
records whether it *was* on, so onboarding can say so.
"""
import copy
import json
import os
import tempfile
import time

from everwatch.engine import config

SCHEMA_VERSION = 2

VIEWS = ('split', 'list', 'grid')
SORTS = ('natural', 'attention', 'agents', 'activity', 'path')
THEMES = ('system', 'dark', 'light')
SESSION_FONTS = ('system', 'sans', 'mono')
SESSION_FONT_SIZES = (12, 13, 14, 15, 16, 18)
SPLIT_MIN, SPLIT_MAX = 0.2, 0.8
HOTKEY_MAX_LEN = 40

DEFAULTS = {
    'version': SCHEMA_VERSION,
    'labels': {},          # uid -> {'label': str, 'last_seen': epoch}
    'view': 'split',       # split | list | grid
    'sort': 'natural',     # natural | attention | agents | activity | path
    'show_dollars': False,
    'split_ratio': 0.42,   # left pane share of the split view
    'projects': ['', '', '', '', ''],  # 5 fixed numbered slots
    'projects_open': False,
    # --- v2 ---
    'theme': 'system',
    'session_font': 'system',
    'session_font_size': 15,
    'sound_on_attention': False,
    'dock_bounce': False,
    'show_dock_badge': False,  # optional waiting-count badge on the macOS Dock icon
    'notify_on_waiting': False,
    'grid_all': False,
    'usage_collapsed': False,
    'hotkey_show': 'opt+cmd+e',
    'hotkey_next': 'opt+cmd+j',
    'show_hints': True,
    'compact': {'agents_only': True},
    'onboarding_done': False,
    'debug_state': False,  # Settings "Show matched rule" (P-18)
    'show_row_activity': False,  # Settings "Show activity strip on sessions"
    'agents_only': False,  # toolbar "AI sessions only" (main window list)
    'imported_from_ultrawatch': None,  # {'at', 'path', 'bell_was_on'}
}

# Keys PATCH /api/prefs may change (docs/DESIGN.md §3.5 `Prefs`), plus
# projects_open (the `p` toggle has no endpoint of its own).
PREF_KEYS = ('view', 'sort', 'split_ratio', 'show_dollars',
             'sound_on_attention', 'dock_bounce', 'show_dock_badge', 'notify_on_waiting',
             'theme', 'session_font', 'session_font_size', 'grid_all', 'usage_collapsed', 'hotkey_show',
             'hotkey_next', 'show_hints', 'compact', 'onboarding_done',
             'debug_state', 'show_row_activity', 'agents_only',
             'projects_open')

_BOOL_KEYS = ('show_dollars', 'projects_open', 'sound_on_attention',
              'dock_bounce', 'show_dock_badge', 'notify_on_waiting', 'grid_all',
              'usage_collapsed', 'show_hints', 'onboarding_done',
              'debug_state', 'show_row_activity', 'agents_only')
_ENUM_KEYS = {'view': VIEWS, 'sort': SORTS, 'theme': THEMES,
              'session_font': SESSION_FONTS, 'session_font_size': SESSION_FONT_SIZES}

# What an ultrawatch v1 state contributes on import (§3.7). `bell` is
# deliberately absent.
ULTRAWATCH_IMPORT_KEYS = ('view', 'sort', 'split_ratio', 'show_dollars',
                          'projects_open')

PROJECT_SLOTS = 5

SAVE_DEBOUNCE = 2.0

_INVALID = object()


def _normalize_value(key, value):
    """Return a valid value for `key`, or _INVALID."""
    if key in _BOOL_KEYS:
        return value if isinstance(value, bool) else _INVALID
    if key in _ENUM_KEYS:
        return value if value in _ENUM_KEYS[key] else _INVALID
    if key == 'split_ratio':
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return _INVALID
        if value != value:  # NaN
            return _INVALID
        return round(max(SPLIT_MIN, min(SPLIT_MAX, float(value))), 2)
    if key in ('hotkey_show', 'hotkey_next'):
        if not isinstance(value, str) or len(value) > HOTKEY_MAX_LEN:
            return _INVALID
        return value
    if key == 'compact':
        if not isinstance(value, dict):
            return _INVALID
        agents_only = value.get('agents_only', True)
        if not isinstance(agents_only, bool):
            return _INVALID
        return {'agents_only': agents_only}
    if key == 'imported_from_ultrawatch':
        return value if value is None or isinstance(value, dict) else _INVALID
    return value


def normalize_prefs_patch(patch):
    """Validate a partial Prefs update (PATCH /api/prefs).

    Returns (clean, rejected): `clean` holds normalized values (numbers
    clamped), `rejected` lists keys that are unknown or invalid."""
    clean, rejected = {}, []
    if not isinstance(patch, dict):
        return clean, ['<body>']
    for key, value in patch.items():
        if key not in PREF_KEYS:
            rejected.append(key)
            continue
        norm = _normalize_value(key, value)
        if norm is _INVALID:
            rejected.append(key)
        else:
            clean[key] = norm
    return clean, sorted(rejected)


def migrate(data):
    """Upgrade a loaded dict (v1 or v2) to the v2 layout in place-safe
    fashion; returns a new dict. Never turns sound on."""
    data = dict(data)
    data.pop('bell', None)          # v1 only; never becomes sound-on
    data['version'] = SCHEMA_VERSION
    return data


def ultrawatch_state_candidates(environ=None, home=None):
    """Where ultrawatch keeps state.json, most specific first."""
    environ = os.environ if environ is None else environ
    home = home or config.HOME
    out = []
    xdg = environ.get('XDG_CONFIG_HOME')
    if xdg:
        out.append(os.path.join(xdg, 'ultrawatch', 'state.json'))
    default = os.path.join(home, '.config', 'ultrawatch', 'state.json')
    if default not in out:
        out.append(default)
    return out


def find_ultrawatch_state(environ=None, home=None):
    for path in ultrawatch_state_candidates(environ, home):
        if os.path.isfile(path):
            return path
    return None


class StateStore:
    def __init__(self, path=None, now=None):
        self.path = path or config.STATE_PATH
        self._dirty_at = None
        now = now if now is not None else time.time()
        self.state = copy.deepcopy(DEFAULTS)
        loaded = self._load()
        if loaded:
            loaded = migrate(loaded)
            for key, value in loaded.items():
                if key in DEFAULTS and key not in ('labels', 'projects',
                                                   'version'):
                    norm = _normalize_value(key, value)
                    if norm is not _INVALID:
                        self.state[key] = norm
                elif key not in DEFAULTS:
                    self.state[key] = value  # unknown: preserve
            if 'labels' in loaded:
                self.state['labels'] = loaded['labels']
            if 'projects' in loaded:
                self.state['projects'] = loaded['projects']
        self._gc_labels(now)
        self._normalize_projects()

    def _load(self):
        try:
            with open(self.path, encoding='utf-8') as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
        except Exception:
            return None

    def _gc_labels(self, now):
        cutoff = now - config.LABEL_GC_DAYS * 86400
        labels = self.state.get('labels')
        if not isinstance(labels, dict):
            self.state['labels'] = {}
            return
        for uid in list(labels):
            entry = labels[uid]
            if (not isinstance(entry, dict) or not entry.get('label') or
                    not isinstance(entry.get('last_seen', 0), (int, float)) or
                    entry.get('last_seen', 0) < cutoff):
                del labels[uid]

    def _normalize_projects(self):
        projects = self.state.get('projects')
        if not isinstance(projects, list):
            self.state['projects'] = list(DEFAULTS['projects'])
            return
        projects = [p if isinstance(p, str) else '' for p in projects]
        projects = projects[:PROJECT_SLOTS]
        projects += [''] * (PROJECT_SLOTS - len(projects))
        self.state['projects'] = projects

    # ---- accessors ----

    def get(self, key):
        return self.state.get(key, DEFAULTS.get(key))

    def set(self, key, value, now=None):
        if self.state.get(key) == value:
            return
        self.state[key] = value
        self._dirty_at = now if now is not None else time.time()

    def prefs(self):
        """The Prefs object (docs/DESIGN.md §3.5), a fresh dict."""
        return {k: copy.deepcopy(self.get(k)) for k in PREF_KEYS
                if k != 'projects_open'}

    def update_prefs(self, patch, now=None):
        """Apply a validated partial update. Returns (prefs, rejected)."""
        clean, rejected = normalize_prefs_patch(patch)
        for key, value in clean.items():
            self.set(key, value, now=now)
        return self.prefs(), rejected

    def label(self, uid):
        entry = self.state['labels'].get(uid)
        return entry.get('label', '') if isinstance(entry, dict) else ''

    def set_label(self, uid, label, now=None):
        now = now if now is not None else time.time()
        if label:
            self.state['labels'][uid] = {'label': label,
                                         'last_seen': int(now)}
        else:
            self.state['labels'].pop(uid, None)
        self._dirty_at = now

    def project(self, index):
        """1-based slot text (1-5), '' if empty or out of range."""
        projects = self.state.get('projects') or []
        if 1 <= index <= len(projects):
            return projects[index - 1]
        return ''

    def set_project(self, index, text, now=None):
        if not 1 <= index <= PROJECT_SLOTS:
            return
        if self.state['projects'][index - 1] == text:
            return
        self.state['projects'][index - 1] = text
        self._dirty_at = now if now is not None else time.time()

    def clear_projects(self, now=None):
        self.state['projects'] = [''] * PROJECT_SLOTS
        self._dirty_at = now if now is not None else time.time()

    def touch_labels(self, uids, now=None):
        """Refresh last_seen for labeled sessions that are still alive."""
        now = now if now is not None else time.time()
        for uid in uids:
            entry = self.state['labels'].get(uid)
            if isinstance(entry, dict):
                entry['last_seen'] = int(now)

    # ---- ultrawatch import (§3.7, offered once in onboarding) ----

    def import_ultrawatch(self, path=None, now=None):
        """Import labels, projects, and a few prefs from an ultrawatch
        state.json. The ultrawatch file is only read. Existing Everwatch
        labels and non-empty project slots win over imported ones.

        Returns {'imported': {'labels': n, 'projects': n, 'prefs': [..]},
        'bell_was_on': bool, 'path': str|None}. `bell` is never imported
        as sound-on."""
        now = now if now is not None else time.time()
        path = path or find_ultrawatch_state()
        result = {'imported': {'labels': 0, 'projects': 0, 'prefs': []},
                  'bell_was_on': False, 'path': path}
        if not path:
            return result
        try:
            with open(path, encoding='utf-8') as f:
                data = json.load(f)
        except Exception:
            data = None
        if not isinstance(data, dict):
            return result

        cutoff = now - config.LABEL_GC_DAYS * 86400
        labels = data.get('labels')
        if isinstance(labels, dict):
            for uid, entry in labels.items():
                if (not isinstance(entry, dict) or
                        not isinstance(entry.get('label'), str) or
                        not entry['label'] or uid in self.state['labels']):
                    continue
                last_seen = entry.get('last_seen', 0)
                if not isinstance(last_seen, (int, float)) or \
                        last_seen < cutoff:
                    continue
                self.state['labels'][uid] = {'label': entry['label'],
                                             'last_seen': int(last_seen)}
                result['imported']['labels'] += 1

        projects = data.get('projects')
        if isinstance(projects, list):
            for i, name in enumerate(projects[:PROJECT_SLOTS]):
                if isinstance(name, str) and name and \
                        not self.state['projects'][i]:
                    self.state['projects'][i] = name
                    result['imported']['projects'] += 1

        for key in ULTRAWATCH_IMPORT_KEYS:
            if key not in data:
                continue
            norm = _normalize_value(key, data[key])
            if norm is _INVALID:
                continue
            self.state[key] = norm
            result['imported']['prefs'].append(key)

        result['bell_was_on'] = data.get('bell') is True
        self.state['imported_from_ultrawatch'] = {
            'at': int(now), 'path': path,
            'bell_was_on': result['bell_was_on']}
        self._dirty_at = now
        return result

    # ---- saving ----

    def maybe_save(self, now=None):
        """Save if dirty and the debounce window has passed."""
        now = now if now is not None else time.time()
        if self._dirty_at is not None and now - self._dirty_at >= SAVE_DEBOUNCE:
            self.save()

    @property
    def dirty(self):
        return self._dirty_at is not None

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            fd, tmp = tempfile.mkstemp(
                dir=os.path.dirname(self.path), prefix='.state-')
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as f:
                    json.dump(self.state, f, indent=2)
                os.replace(tmp, self.path)
            except Exception:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
            self._dirty_at = None
        except Exception:
            pass  # persistence is best-effort; never crash the engine
