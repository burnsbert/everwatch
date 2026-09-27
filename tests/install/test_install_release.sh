#!/usr/bin/env bash
# Offline end-to-end test of install.sh's REAL release path (the curl
# one-liner's default: no --from-local, no --version). Everything else in
# tests/install/ exercises --from-local, which never touches
# fetch_latest_release()/fetch_release_assets() -- that gap is what let a
# broken download URL ship in v0.1.0 (docs/DESIGN.md §7 WP10 row).
#
# Builds a release tree shaped like scripts/release.sh's dist/ output
# (everwatch-<ver>.tar.gz, Everwatch-<ver>.zip, SHA256SUMS), serves it plus
# a fake `releases/latest` GitHub API response from a local
# `python3 -m http.server` on 127.0.0.1 (an ephemeral port; never real
# GitHub), and points install.sh at it via EVERWATCH_API_BASE /
# EVERWATCH_DL_BASE. Runs under LANG/LC_ALL=en_US.UTF-8 -- the locale that
# broke the unbraced "$REPO" expansion (followed by an ellipsis) that this
# same bug report flagged.
#
# Never touches the real ~/Applications, ~/Library/Application Support/
# Everwatch, or ~/.local/bin, and never launches Everwatch.app.
#
# Usage: test_install_release.sh [INSTALL_SH]
#   INSTALL_SH defaults to the real install.sh; a caller may point this at
#   an alternate copy to demonstrate fail -> pass against a known-bad one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="${1:-$ROOT/install.sh}"
[ -f "$INSTALL_SH" ] || { echo "no such file: $INSTALL_SH" >&2; exit 1; }

pass=0
fail=0

check() {  # $1 = description, $2 = shell condition (eval'd)
  if eval "$2"; then
    printf '  ok - %s\n' "$1"
    pass=$((pass + 1))
  else
    printf '  FAIL - %s (%s)\n' "$1" "$2"
    fail=$((fail + 1))
  fi
}

VER="9.9.9"
TAG="v$VER"
BAD_VER="9.9.9-badsha"
BAD_TAG="v$BAD_VER"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-release.XXXXXX")"
SERVER_PID=""
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" >/dev/null 2>&1 || true
  [ -n "$SERVER_PID" ] && wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Build a release tree the same shape as scripts/release.sh's dist/, for
# both the good version and a second one whose SHA256SUMS is deliberately
# wrong (the negative test).
# ---------------------------------------------------------------------------
HAVE_SWIFT=0
if command -v swiftc >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then
  HAVE_SWIFT=1
  echo "==> scripts/build_app.sh --dev (a real Everwatch.app to package, never launched)"
  "$ROOT/scripts/build_app.sh" --dev >/dev/null
fi

build_release() {  # $1 = version, $2 = dest dir (created)
  local ver="$1" dest="$2" stage="$WORK/stage-$1"
  mkdir -p "$stage" "$dest"
  cp -R "$ROOT/everwatch" "$stage/everwatch"
  find "$stage/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  cp "$ROOT/LICENSE" "$stage/LICENSE"
  printf '%s\n' "$ver" > "$stage/VERSION"
  ( cd "$stage" && tar -czf "$dest/everwatch-$ver.tar.gz" everwatch LICENSE VERSION )
  if [ "$HAVE_SWIFT" = "1" ]; then
    ( cd "$ROOT/build" && ditto -c -k --keepParent Everwatch.app "$dest/Everwatch-$ver.zip" )
  fi
  local assets="everwatch-$ver.tar.gz"
  [ -f "$dest/Everwatch-$ver.zip" ] && assets="$assets Everwatch-$ver.zip"
  # shellcheck disable=SC2086 -- $assets is a small, known-safe filename list.
  ( cd "$dest" && shasum -a 256 $assets > SHA256SUMS )
}

echo "==> staging a release tree shaped like scripts/release.sh's dist/"
build_release "$VER" "$WORK/dist-good"
build_release "$BAD_VER" "$WORK/dist-bad"
# Corrupt the bad release's recorded sha256 for the tarball -- install.sh
# must abort instead of installing it.
sed -i.bak -E 's/^[0-9a-f]{64}/0000000000000000000000000000000000000000000000000000000000000000/' \
  "$WORK/dist-bad/SHA256SUMS"
rm -f "$WORK/dist-bad/SHA256SUMS.bak"

# ---------------------------------------------------------------------------
# Serve it: releases/latest (fake GitHub API JSON) and
# releases/download/<tag>/<asset> (the download tree), both under one
# static file root so EVERWATCH_API_BASE and EVERWATCH_DL_BASE can share a
# single `python3 -m http.server`.
# ---------------------------------------------------------------------------
SERVE_ROOT="$WORK/serve"
mkdir -p "$SERVE_ROOT/releases/download/$TAG" "$SERVE_ROOT/releases/download/$BAD_TAG"
cp "$WORK/dist-good/"* "$SERVE_ROOT/releases/download/$TAG/"
cp "$WORK/dist-bad/"* "$SERVE_ROOT/releases/download/$BAD_TAG/"
printf '{"tag_name": "%s", "name": "Everwatch %s"}\n' "$TAG" "$VER" > "$SERVE_ROOT/releases/latest"

LOG="$WORK/http.log"
echo "==> starting python3 -m http.server (127.0.0.1, ephemeral port)"
python3 -u -m http.server 0 --bind 127.0.0.1 --directory "$SERVE_ROOT" > "$LOG" 2>&1 &
SERVER_PID=$!
PORT=""
for _ in $(seq 1 50); do
  if grep -q "Serving HTTP" "$LOG" 2>/dev/null; then
    PORT="$(sed -nE 's/.*port ([0-9]+).*/\1/p' "$LOG" | head -n1)"
    break
  fi
  sleep 0.1
done
[ -n "$PORT" ] || { echo "http.server never came up:"; cat "$LOG"; exit 1; }
BASE="http://127.0.0.1:$PORT"
echo "  serving $SERVE_ROOT on $BASE"

API_BASE="$BASE"
DL_BASE="$BASE/releases/download"

# ---------------------------------------------------------------------------
# The real path: no --from-local, no --version -- fetch_latest_release()
# resolves "latest" -> the tag -> the download tree, exactly like the curl
# one-liner.
# ---------------------------------------------------------------------------
PREFIX1="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-relprefix.XXXXXX")"
OUT1="$WORK/install-latest.log"
echo
echo "==> install.sh (latest-release path) --prefix $PREFIX1 --yes --no-open"
set +e
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  EVERWATCH_API_BASE="$API_BASE" EVERWATCH_DL_BASE="$DL_BASE" \
  bash "$INSTALL_SH" --prefix "$PREFIX1" --yes --no-open >"$OUT1" 2>&1
RC1=$?
set -e
cat "$OUT1"
echo
echo "==> checks (latest-release path)"
check "install.sh exited 0" "[ '$RC1' -eq 0 ]"
check "reported the resolved version without a leading v" "grep -q 'version $VER' '$OUT1'"
check "did NOT resolve to a v-prefixed version" "! grep -q 'version $TAG' '$OUT1'"
check "runtime/current symlink exists" \
  "[ -L '$PREFIX1/Library/Application Support/Everwatch/runtime/current' ]"
check "everwatch package is present in the installed runtime" \
  "[ -f '$PREFIX1/Library/Application Support/Everwatch/runtime/current/everwatch/__init__.py' ]"
check "VERSION file matches the released version" \
  "grep -qx '$VER' '$PREFIX1/Library/Application Support/Everwatch/runtime/current/VERSION'"
check "CLI wrapper was linked and is executable" \
  "[ -x '$PREFIX1/.local/bin/everwatch' ]"
check "CLI wrapper reports a version" \
  "'$PREFIX1/.local/bin/everwatch' --version | grep -q everwatch"
if [ "$HAVE_SWIFT" = "1" ]; then
  check "Everwatch.app was installed under the prefix" \
    "[ -d '$PREFIX1/Applications/Everwatch.app' ]"
fi

# ---------------------------------------------------------------------------
# --version accepts both "X.Y.Z" and "vX.Y.Z", and resolves to the same
# tag/download tree as the latest-release path above.
# ---------------------------------------------------------------------------
PREFIX2="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-relprefix.XXXXXX")"
OUT2="$WORK/install-version-v.log"
echo
echo "==> install.sh --version $TAG --prefix $PREFIX2 --yes --no-open"
set +e
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  EVERWATCH_API_BASE="$API_BASE" EVERWATCH_DL_BASE="$DL_BASE" \
  bash "$INSTALL_SH" --version "$TAG" --prefix "$PREFIX2" --yes --no-open >"$OUT2" 2>&1
RC2=$?
set -e
cat "$OUT2"
echo
echo "==> checks (--version $TAG, the leading-v form)"
check "install.sh exited 0" "[ '$RC2' -eq 0 ]"
check "runtime/current symlink exists" \
  "[ -L '$PREFIX2/Library/Application Support/Everwatch/runtime/current' ]"
check "VERSION file has no leading v" \
  "grep -qx '$VER' '$PREFIX2/Library/Application Support/Everwatch/runtime/current/VERSION'"

# ---------------------------------------------------------------------------
# Negative: a SHA256SUMS mismatch must abort the install, not silently
# proceed.
# ---------------------------------------------------------------------------
PREFIX3="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-relprefix.XXXXXX")"
OUT3="$WORK/install-badsha.log"
echo
echo "==> install.sh --version $BAD_VER --prefix $PREFIX3 --yes --no-open (expect abort: sha256 mismatch)"
set +e
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 \
  EVERWATCH_API_BASE="$API_BASE" EVERWATCH_DL_BASE="$DL_BASE" \
  bash "$INSTALL_SH" --version "$BAD_VER" --prefix "$PREFIX3" --yes --no-open >"$OUT3" 2>&1
RC3=$?
set -e
cat "$OUT3"
echo
echo "==> checks (sha256 mismatch)"
check "install.sh exited non-zero" "[ '$RC3' -ne 0 ]"
check "reported a sha256 mismatch" "grep -q 'sha256 mismatch' '$OUT3'"
check "nothing was installed under the prefix" \
  "[ ! -e '$PREFIX3/Library/Application Support/Everwatch/runtime/current' ]"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
