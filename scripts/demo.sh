#!/usr/bin/env bash
# Run the browser UI with scripted sessions in a disposable data directory.
# The installed Everwatch.app and its backend are never opened or stopped.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_home="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-demo.XXXXXXXX")"
cleanup() { rm -rf "$demo_home"; }
trap cleanup EXIT

cd "$repo_root"
export EVERWATCH_HOME="$demo_home"
export EVERWATCH_NO_SOUND=1
exec_python="${EVERWATCH_DEMO_PYTHON:-python3}"
"$exec_python" -m everwatch demo --seed 1 \
  --clock fixed:2026-09-25T15:00:00-04:00 "$@"
