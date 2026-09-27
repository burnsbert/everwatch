import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeNativeStatus, findCheck, summarize, severityRank, STATUS_LABEL,
} from '../../everwatch/web/js/lib/diagnostics_ui.mjs';

function checks(overrides = {}) {
  const base = [
    { id: 'python_version', title: 'Python 3.9+', status: 'ok', detail: 'Python 3.11 is running Everwatch.', action: null },
    { id: 'automation', title: 'Automation → iTerm2', status: 'unknown', detail: 'not yet known', action: { kind: 'endpoint', label: 'Connect to iTerm2', method: 'POST', path: '/api/refresh' } },
    { id: 'notifications', title: 'Notifications', status: 'unknown', detail: 'reported by the app', action: null },
    { id: 'hotkeys', title: 'Hotkeys', status: 'unknown', detail: 'reported by the app', action: null },
  ];
  return base.map((c) => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c));
}

test('mergeNativeStatus: non-array input is total (returns [])', () => {
  assert.deepEqual(mergeNativeStatus(null, {}, true), []);
  assert.deepEqual(mergeNativeStatus(undefined, {}, true), []);
});

test('mergeNativeStatus: browser mode never overlays (no bridge to trust)', () => {
  const merged = mergeNativeStatus(checks(), { automation: 'denied', notifications: 'denied', hotkeys: { show: 'ok', next: 'ok' } }, false);
  assert.equal(findCheck(merged, 'automation').status, 'unknown');
  assert.equal(findCheck(merged, 'notifications').status, 'unknown');
  assert.equal(findCheck(merged, 'hotkeys').status, 'unknown');
});

test('mergeNativeStatus: shell mode with no nativeStatus yet leaves backend checks alone', () => {
  const merged = mergeNativeStatus(checks(), { shell: true }, true);
  assert.equal(findCheck(merged, 'automation').status, 'unknown');
  assert.equal(findCheck(merged, 'notifications').status, 'unknown');
  assert.equal(findCheck(merged, 'hotkeys').status, 'unknown');
});

test('mergeNativeStatus: notifications — authorized/denied/not_determined', () => {
  for (const [native, want, actionKind] of [
    ['authorized', 'ok', null],
    ['denied', 'warn', 'open_system_settings'],
    ['not_determined', 'info', 'request_notifications'],
  ]) {
    const merged = mergeNativeStatus(checks(), { notifications: native }, true);
    const c = findCheck(merged, 'notifications');
    assert.equal(c.status, want, native);
    assert.equal(c.action?.kind ?? null, actionKind, native);
  }
});

test('mergeNativeStatus: automation — the shell result wins over the backend unknown', () => {
  const grantedMerged = mergeNativeStatus(checks(), { automation: 'granted' }, true);
  assert.equal(findCheck(grantedMerged, 'automation').status, 'ok');

  const deniedMerged = mergeNativeStatus(checks(), { automation: 'denied' }, true);
  const denied = findCheck(deniedMerged, 'automation');
  assert.equal(denied.status, 'error');
  assert.equal(denied.action.kind, 'open_system_settings');
  assert.equal(denied.action.pane, 'automation');

  const notRunningMerged = mergeNativeStatus(checks(), { automation: 'not_running' }, true);
  assert.equal(findCheck(notRunningMerged, 'automation').status, 'warn');

  const notDeterminedMerged = mergeNativeStatus(checks(), { automation: 'not_determined' }, true);
  const notDetermined = findCheck(notDeterminedMerged, 'automation');
  assert.equal(notDetermined.status, 'unknown');
  assert.equal(notDetermined.action.path, '/api/refresh');
});

// The backend's osascript child is what actually sends Apple Events to
// iTerm2, so its result is ground truth once it has one. The shell's
// AEDeterminePermissionToAutomateTarget probe only fills in while the
// backend hasn't tried yet (backend `unknown`). Every backend × shell pair:
const NATIVE_AUTOMATION = ['granted', 'denied', 'not_running', 'not_determined', 'unknown', undefined];

test('mergeNativeStatus: automation — a backend ok is never downgraded by the shell probe', () => {
  const backendOk = { automation: { status: 'ok', detail: 'Everwatch can already control iTerm2.', action: null } };
  for (const native of NATIVE_AUTOMATION) {
    const c = findCheck(mergeNativeStatus(checks(backendOk), { automation: native }, true), 'automation');
    assert.equal(c.status, 'ok', `backend ok + shell ${native}`);
    assert.equal(c.action, null, `backend ok + shell ${native}`);
  }
});

test('mergeNativeStatus: automation — backend ok + shell not_determined (the stale-probe report) → ok', () => {
  const backendOk = { automation: { status: 'ok', detail: 'Everwatch can already control iTerm2.', action: null } };
  const c = findCheck(mergeNativeStatus(checks(backendOk), { automation: 'not_determined' }, true), 'automation');
  assert.equal(c.status, 'ok');
  assert.equal(c.detail, 'Everwatch can already control iTerm2.');
});

test('mergeNativeStatus: automation — a backend -1743 error stays an error whatever the shell says', () => {
  const backendDenied = {
    automation: {
      status: 'error', detail: 'Everwatch needs permission to control iTerm2.',
      action: { kind: 'open_system_settings', label: 'Open System Settings', pane: 'automation' },
    },
  };
  for (const native of NATIVE_AUTOMATION) {
    const c = findCheck(mergeNativeStatus(checks(backendDenied), { automation: native }, true), 'automation');
    assert.equal(c.status, 'error', `backend error + shell ${native}`);
    assert.equal(c.action.kind, 'open_system_settings', `backend error + shell ${native}`);
    assert.equal(c.action.pane, 'automation', `backend error + shell ${native}`);
  }
});

test('mergeNativeStatus: automation — backend unknown: the shell fills in, or the backend text stays', () => {
  const want = {
    granted: ['ok', null], denied: ['error', 'open_system_settings'], not_running: ['warn', 'endpoint'],
    not_determined: ['unknown', 'endpoint'], unknown: ['unknown', 'endpoint'], undefined: ['unknown', 'endpoint'],
  };
  for (const native of NATIVE_AUTOMATION) {
    const c = findCheck(mergeNativeStatus(checks(), { automation: native }, true), 'automation');
    const [status, actionKind] = want[String(native)];
    assert.equal(c.status, status, `backend unknown + shell ${native}`);
    assert.equal(c.action?.kind ?? null, actionKind, `backend unknown + shell ${native}`);
  }
  // shell unknown/absent → the backend's own detail, untouched
  const passthrough = findCheck(mergeNativeStatus(checks(), { automation: 'unknown' }, true), 'automation');
  assert.equal(passthrough.detail, 'not yet known');
});

test('mergeNativeStatus: automation — browser mode passes every backend status through', () => {
  for (const status of ['ok', 'error', 'unknown']) {
    for (const native of NATIVE_AUTOMATION) {
      const c = findCheck(mergeNativeStatus(checks({ automation: { status } }), { automation: native }, false), 'automation');
      assert.equal(c.status, status, `browser: backend ${status} + shell ${native}`);
    }
  }
});

test('mergeNativeStatus: hotkeys — both ok, one conflict, one error', () => {
  const bothOk = findCheck(mergeNativeStatus(checks(), { hotkeys: { show: 'ok', next: 'ok' } }, true), 'hotkeys');
  assert.equal(bothOk.status, 'ok');

  const oneConflict = findCheck(mergeNativeStatus(checks(), { hotkeys: { show: 'conflict', next: 'ok' } }, true), 'hotkeys');
  assert.equal(oneConflict.status, 'warn');
  assert.match(oneConflict.detail, /Show Everwatch/);

  const oneError = findCheck(mergeNativeStatus(checks(), { hotkeys: { show: 'ok', next: 'error' } }, true), 'hotkeys');
  assert.equal(oneError.status, 'error');

  const oneDisabled = findCheck(mergeNativeStatus(checks(), { hotkeys: { show: 'ok', next: 'disabled' } }, true), 'hotkeys');
  assert.equal(oneDisabled.status, 'info');
  assert.match(oneDisabled.detail, /turned off/);

  // Both empty strings (never configured) — treated the same as "not reported yet".
  const bothEmpty = findCheck(mergeNativeStatus(checks(), { hotkeys: { show: '', next: '' } }, true), 'hotkeys');
  assert.equal(bothEmpty.status, 'unknown');
});

test('findCheck is total for a missing/null checks array', () => {
  assert.equal(findCheck(null, 'automation'), null);
  assert.equal(findCheck(undefined, 'automation'), null);
});

test('mergeNativeStatus: unrelated ids pass through unchanged (identity where possible)', () => {
  const input = checks();
  const merged = mergeNativeStatus(input, { automation: 'granted' }, true);
  const python = findCheck(merged, 'python_version');
  assert.equal(python, input[0]); // untouched id -> same object reference
});

test('summarize counts every status bucket, defaulting missing ones to 0', () => {
  const s = summarize([{ status: 'ok' }, { status: 'ok' }, { status: 'warn' }]);
  assert.deepEqual(s, { ok: 2, warn: 1, error: 0, info: 0, unknown: 0 });
  assert.deepEqual(summarize([]), { ok: 0, warn: 0, error: 0, info: 0, unknown: 0 });
  assert.deepEqual(summarize(undefined), { ok: 0, warn: 0, error: 0, info: 0, unknown: 0 });
});

test('severityRank orders error worst, ok best, and is total for unknown strings', () => {
  assert.ok(severityRank('error') < severityRank('warn'));
  assert.ok(severityRank('warn') < severityRank('unknown'));
  assert.ok(severityRank('unknown') < severityRank('info'));
  assert.ok(severityRank('info') < severityRank('ok'));
  assert.ok(severityRank('bogus') > severityRank('ok'));
});

test('STATUS_LABEL covers every status the backend can emit', () => {
  for (const s of ['ok', 'warn', 'error', 'info', 'unknown']) assert.ok(STATUS_LABEL[s]);
});
