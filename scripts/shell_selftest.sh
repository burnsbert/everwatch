#!/usr/bin/env bash
# Headless runtime self-test of Everwatch.app (make test-shell-integration).
#
# Builds the app (dev), makes a throwaway copy with its own bundle id and
# LSBackgroundOnly=true, and runs that copy's binary directly (never via `open`)
# with EVERWATCH_SELFTEST=1. In that mode the app shows nothing (no window,
# Dock icon, menu bar, or status item), never activates, asks for no
# permission, plays no sound, and runs the backend as `serve --demo
# --selftest` (no osascript, keychain, venv, or pip). It prints one JSON report
# line; this script pretty-prints it, checks it, and makes sure no backend
# process is left behind.
#
#   scripts/shell_selftest.sh                 build + run once
#   SELFTEST_SKIP_BUILD=1 scripts/shell_selftest.sh   reuse build/Everwatch.app
#   SELFTEST_KEEP=1 ...                       keep the temp EVERWATCH_HOME
#   SELFTEST_RUNTIME=DIR ...                  runtime dir (default: this checkout)
#
# The separate bundle id (io.github.burnsbert.everwatch.selftest) keeps the
# run's defaults and any TCC rows away from the real app's. LSBackgroundOnly
# (plus LSUIElement) means LaunchServices never registers it as a Dock or
# menu-bar app, not even for the moment before the app sets its activation
# policy to .prohibited, and never later re-applies a different type (with
# LSUIElement alone, one run in three briefly read back as .accessory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="$ROOT/build"
SRC_APP="$BUILD/Everwatch.app"
TEST_APP="$BUILD/selftest/EverwatchSelfTest.app"
TEST_BUNDLE_ID="io.github.burnsbert.everwatch.selftest"
BACKEND_PATTERN="-m everwatch serve --port 0 --parent-pipe --demo --selftest"
APP_TIMEOUT="${EVERWATCH_SELFTEST_TIMEOUT:-30}"
OUTER_TIMEOUT=$(( ${APP_TIMEOUT%.*} + 30 ))
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

PYTHON_BIN="${EVERWATCH_PYTHON:-$(command -v python3 || true)}"
[[ -n "$PYTHON_BIN" && -x "$PYTHON_BIN" ]] || { echo "shell self-test: python3 not found" >&2; exit 2; }

if [[ "${SELFTEST_SKIP_BUILD:-}" != "1" ]]; then
  "$ROOT/scripts/build_app.sh" --dev >&2
fi
[[ -x "$SRC_APP/Contents/MacOS/Everwatch" ]] || { echo "shell self-test: $SRC_APP not built" >&2; exit 2; }

rm -rf "$TEST_APP"
mkdir -p "$(dirname "$TEST_APP")"
ditto "$SRC_APP" "$TEST_APP"
PLIST="$TEST_APP/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$TEST_BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "Everwatch Self-Test" "$PLIST"
plutil -replace LSUIElement -bool true "$PLIST"
plutil -replace LSBackgroundOnly -bool true "$PLIST"
codesign --force --sign - --identifier "$TEST_BUNDLE_ID" "$TEST_APP" 2>/dev/null

WORK="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-selftest.XXXXXX")"
TEST_HOME="$WORK/home"
mkdir -p "$TEST_HOME"
REPORT="$WORK/report.txt"
APP_ERR="$WORK/app-stderr.txt"
APP_PID=""

leftover_backends() {  # pids of self-test backends that are orphaned or ours
  local pid ppid
  for pid in $(pgrep -f -- "$BACKEND_PATTERN" || true); do
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if [[ "$ppid" == "1" || ( -n "$APP_PID" && "$ppid" == "$APP_PID" ) ]]; then echo "$pid"; fi
  done
}

cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then kill -9 "$APP_PID" 2>/dev/null || true; fi
  for pid in $(leftover_backends); do kill -9 "$pid" 2>/dev/null || true; done
  [[ -x "$LSREGISTER" ]] && "$LSREGISTER" -u "$TEST_APP" >/dev/null 2>&1 || true
  if [[ "${SELFTEST_KEEP:-}" == "1" ]]; then echo "kept $WORK" >&2; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

# Minimal, explicit environment: nothing from the caller's shell leaks in.
env -i \
  HOME="$HOME" USER="${USER:-}" LOGNAME="${LOGNAME:-${USER:-}}" TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" LANG="en_US.UTF-8" \
  EVERWATCH_SELFTEST=1 \
  EVERWATCH_SELFTEST_TIMEOUT="$APP_TIMEOUT" \
  EVERWATCH_HOME="$TEST_HOME" \
  EVERWATCH_RUNTIME="${SELFTEST_RUNTIME:-$ROOT}" \
  EVERWATCH_PYTHON="$PYTHON_BIN" \
  EVERWATCH_NO_SOUND=1 \
  "$TEST_APP/Contents/MacOS/Everwatch" >"$REPORT" 2>"$APP_ERR" &
APP_PID=$!

status=""
for (( i = 0; i < OUTER_TIMEOUT * 10; i++ )); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    set +e; wait "$APP_PID"; status=$?; set -e
    break
  fi
  sleep 0.1
done
if [[ -z "$status" ]]; then
  echo "shell self-test: app still running after ${OUTER_TIMEOUT}s; killing it" >&2
  kill -9 "$APP_PID" 2>/dev/null || true
  status=124
fi

# The app waits for its backend to exit before it exits; give a straggler a moment anyway.
leftover=""
for (( i = 0; i < 30; i++ )); do
  leftover="$(leftover_backends | tr '\n' ' ')"
  [[ -z "${leftover// /}" ]] && break
  sleep 0.1
done

set +e
"$PYTHON_BIN" - "$REPORT" "$status" "${leftover// /}" <<'PY'
import json, sys
path, status, leftover = sys.argv[1], int(sys.argv[2]), sys.argv[3]
lines = [l for l in open(path, encoding='utf-8', errors='replace') if l.startswith('{')]
if not lines:
    print(f'shell self-test: no JSON report on stdout (app exit status {status})')
    sys.exit(1)
report = json.loads(lines[-1])
print(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False))
failed = [c['name'] for c in report.get('checks', []) if not c.get('ok')]
problems = []
if status != 0: problems.append(f'app exit status {status}')
if not report.get('ok'): problems.append('report ok=false')
if report.get('failure'): problems.append(f"failure: {report['failure']}")
if failed: problems.append('failed checks: ' + ', '.join(failed))
if report.get('missing'): problems.append('missing checks: ' + ', '.join(report['missing']))
if leftover: problems.append(f'leftover backend pids: {leftover}')
n = len(report.get('checks', []))
if problems:
    print('shell self-test: FAIL (' + '; '.join(problems) + ')')
    sys.exit(1)
print(f'shell self-test: PASS ({n} checks, {report.get("elapsed_s")} s, app exit status {status})')
PY
result=$?
set -e

if [[ $result -ne 0 ]]; then
  echo "--- app stderr (last 40 lines) ---" >&2
  tail -40 "$APP_ERR" >&2 || true
  if [[ -f "$TEST_HOME/logs/backend.log" ]]; then
    echo "--- backend.log (last 40 lines) ---" >&2
    tail -40 "$TEST_HOME/logs/backend.log" >&2 || true
  fi
fi
exit $result
