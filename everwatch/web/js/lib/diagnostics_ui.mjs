// Pure helpers for Settings → Diagnostics and the onboarding wizard
// (docs/DESIGN.md §4.2, build/wp7-handoff.md). No DOM here — everything is
// testable with plain objects so the merge logic has unit coverage
// independent of the view code.
//
// The backend (`everwatch/diagnostics.py`) reports 13 checks, but two of
// them — `notifications` and `hotkeys` — are permanently `status:"unknown"`
// because only the Swift shell can see the real OS state (shell/README.md's
// `nativeStatus`, shell → web only). `automation` is different: the
// backend's osascript child is the process that actually sends Apple Events
// to iTerm2, so once it has a result (`ok`, or `error` from -1743/-1744)
// that result is ground truth and the shell's
// `AEDeterminePermissionToAutomateTarget` probe never overrides it — the
// probe runs at a different moment (e.g. before the user clicked OK) and
// can be stale (docs/PERMISSIONS.md). The probe only fills in while the
// backend check is still `unknown` (no osascript result yet). This module
// overlays `state.native` onto the backend's checks for exactly those three
// ids, and only in shell mode (browser mode has no bridge, so the backend's
// own text — which already explains that limitation — is left alone).

export const STATUS_OK = 'ok';
export const STATUS_WARN = 'warn';
export const STATUS_ERROR = 'error';
export const STATUS_INFO = 'info';
export const STATUS_UNKNOWN = 'unknown';

/** Worse-first ordering, for a summary badge and for sorting attention. */
const SEVERITY = { error: 0, warn: 1, unknown: 2, info: 3, ok: 4 };
export function severityRank(status) { return SEVERITY[status] ?? 5; }

/** `{ok, warn, error, info, unknown}` counts (mirrors `diagnostics.summary`). */
export function summarize(checks) {
  const counts = { ok: 0, warn: 0, error: 0, info: 0, unknown: 0 };
  for (const c of checks || []) counts[c.status] = (counts[c.status] || 0) + 1;
  return counts;
}

/** Short label for a status pill/dot. */
export const STATUS_LABEL = {
  ok: 'OK', warn: 'Attention', error: 'Problem', info: 'Info', unknown: 'Unknown',
};

function withDetail(check, patch) {
  return { ...check, ...patch };
}

function mergeNotifications(check, native, shell) {
  if (!shell) return check;
  const status = native?.notifications;
  if (status === 'authorized') {
    return withDetail(check, {
      status: STATUS_OK, detail: 'Notifications are allowed (always silent).', action: null,
    });
  }
  if (status === 'denied') {
    return withDetail(check, {
      status: STATUS_WARN,
      detail: 'Notifications are turned off for Everwatch. Everwatch still works fully without '
        + 'them — you’ll rely on the menu bar and window instead of a banner.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'notifications' },
    });
  }
  if (status === 'not_determined') {
    return withDetail(check, {
      status: STATUS_INFO,
      detail: 'Allow notifications to hear about a waiting session while you’re looking '
        + 'elsewhere (always silent — never a sound).',
      action: { kind: 'request_notifications', label: 'Allow notifications' },
    });
  }
  return check; // 'unknown' or not reported yet — keep the backend's own text
}

function mergeHotkeys(check, native, shell) {
  if (!shell) return check;
  const hk = native?.hotkeys;
  if (!hk || (!hk.show && !hk.next)) return check;
  const states = [['Show Everwatch', hk.show], ['Jump to next waiting', hk.next]];
  if (states.every(([, s]) => s === 'ok')) {
    return withDetail(check, { status: STATUS_OK, detail: 'Global hotkeys are active.', action: null });
  }
  const bad = states.filter(([, s]) => s && s !== 'ok');
  const worst = bad.some(([, s]) => s === 'error') ? STATUS_ERROR
    : bad.some(([, s]) => s === 'conflict' || s === 'invalid') ? STATUS_WARN : STATUS_INFO;
  const words = { conflict: 'conflicts with another app', invalid: 'isn’t a valid shortcut', disabled: 'is turned off', error: 'failed to register' };
  const detail = bad.map(([name, s]) => `${name} ${words[s] || s}.`).join(' ') || 'One or more hotkeys need attention.';
  return withDetail(check, { status: worst, detail, action: null });
}

// Precedence (every combination is unit-tested in tests/js):
//   backend ok    → ok, whatever the shell probe says
//   backend error → the backend's error (osascript was refused), whatever
//                   the shell probe says
//   backend anything else (`unknown`: no osascript result yet) → the shell
//                   probe fills in; shell `unknown`/absent → backend text
function mergeAutomation(check, native, shell) {
  if (!shell) return check;
  if (check.status === STATUS_OK || check.status === STATUS_ERROR) return check;
  const status = native?.automation;
  if (!status || status === 'unknown') return check;
  if (status === 'granted') {
    return withDetail(check, { status: STATUS_OK, detail: 'Everwatch can already control iTerm2.', action: null });
  }
  if (status === 'denied') {
    return withDetail(check, {
      status: STATUS_ERROR,
      detail: 'macOS isn’t letting Everwatch control iTerm2 yet. Open System Settings '
        + '→ Privacy & Security → Automation, find Everwatch, and turn on iTerm2. Not in the '
        + 'list? `tccutil reset AppleEvents io.github.burnsbert.everwatch` in Terminal makes macOS ask again.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
    });
  }
  if (status === 'not_running') {
    return withDetail(check, {
      status: STATUS_WARN,
      detail: 'iTerm2 isn’t running. Everwatch keeps polling and recovers on its own once it starts.',
      action: { kind: 'endpoint', label: 'Launch iTerm2', method: 'POST', path: '/api/iterm/launch' },
    });
  }
  // not_determined
  return withDetail(check, {
    status: STATUS_UNKNOWN,
    detail: 'Everwatch hasn’t asked for permission to control iTerm2 yet. Connect once and '
      + 'macOS will ask — click OK.',
    action: { kind: 'endpoint', label: 'Connect to iTerm2', method: 'POST', path: '/api/refresh' },
  });
}

const MERGERS = {
  notifications: mergeNotifications,
  hotkeys: mergeHotkeys,
  automation: mergeAutomation,
};

/**
 * Overlay `state.native` (shell → web `nativeStatus`) onto the backend's 13
 * checks. Pure and total: an empty/missing `checks` array returns `[]`, and
 * every id without a merger (or in browser mode) passes through unchanged.
 */
export function mergeNativeStatus(checks, native, shell) {
  if (!Array.isArray(checks)) return [];
  return checks.map((c) => (MERGERS[c.id] ? MERGERS[c.id](c, native, !!shell) : c));
}

/** Find one merged check by id, or `null`. */
export function findCheck(checks, id) {
  return (checks || []).find((c) => c.id === id) || null;
}
