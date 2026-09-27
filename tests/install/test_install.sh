#!/usr/bin/env bash
# Shell-level test harness for install.sh (docs/DESIGN.md §7 WP10 row).
#
# Runs entirely inside a temp --prefix and a temp --from-local staging
# dir: it never touches the real ~/Applications, the real
# ~/Library/Application Support/Everwatch, or the real ~/.local/bin, and
# never launches Everwatch.app (hard rules). `make test-install` runs this.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTALL_SH="$ROOT/install.sh"

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

echo "==> bash -n install.sh"
bash -n "$INSTALL_SH"
echo "  ok - install.sh parses"

# ---------------------------------------------------------------------------
# `--help` must work piped from curl (the documented one-liner), where $0 is
# literally "bash", not this file's path -- usage() used to `sed` its own
# source off "$0" and blew up with "sed: bash: No such file or directory"
# (exit 1) in exactly that case. Regression test for that bug.
# ---------------------------------------------------------------------------
echo
echo "==> cat install.sh | bash -s -- --help (piped: \$0 is \"bash\", not a path)"
set +e
HELP_OUT="$(cat "$INSTALL_SH" | bash -s -- --help)"
HELP_RC=$?
set -e
printf '%s\n' "$HELP_OUT"
echo
echo "==> checks (piped --help)"
check "piped --help exited 0" "[ '$HELP_RC' -eq 0 ]"
for flag in --browser-only --with-colors --prefix --version --from-local \
            --uninstall --purge --yes --no-open --help; do
  check "piped --help lists $flag" \
    "printf '%s' \"\$HELP_OUT\" | grep -qF -- '$flag'"
done

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stage.XXXXXX")"
PREFIX="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefix.XXXXXX")"
cleanup() { rm -rf "$STAGE" "$PREFIX"; }
trap cleanup EXIT

echo "==> staging a local 'release' tree at $STAGE"
cp -R "$ROOT/everwatch" "$STAGE/everwatch"
find "$STAGE/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
printf '0.0.0-test\n' > "$STAGE/VERSION"

INSTALL_FLAGS=""
HAVE_SWIFT=0
if command -v swiftc >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1; then
  HAVE_SWIFT=1
  echo "==> scripts/build_app.sh --dev (a real Everwatch.app to install, never launched)"
  "$ROOT/scripts/build_app.sh" --dev >/dev/null
  mkdir -p "$STAGE/build"
  cp -R "$ROOT/build/Everwatch.app" "$STAGE/build/Everwatch.app"
else
  echo "==> swiftc/CLT unavailable here; testing --browser-only instead"
  INSTALL_FLAGS="--browser-only"
fi

echo "==> install.sh --from-local $STAGE --prefix $PREFIX --yes --no-open $INSTALL_FLAGS"
INSTALL_OUT="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-install-out.XXXXXX")"
# shellcheck disable=SC2086 -- INSTALL_FLAGS is a single, known-safe flag or empty.
bash "$INSTALL_SH" --from-local "$STAGE" --prefix "$PREFIX" --yes --no-open $INSTALL_FLAGS \
  | tee "$INSTALL_OUT"

echo
echo "==> resulting tree"
find "$PREFIX" | sort

echo
echo "==> checks (post-install)"
check "runtime/current symlink exists" \
  "[ -L '$PREFIX/Library/Application Support/Everwatch/runtime/current' ]"
check "everwatch package is present in the installed runtime" \
  "[ -f '$PREFIX/Library/Application Support/Everwatch/runtime/current/everwatch/__init__.py' ]"
check "VERSION file matches the staged version" \
  "grep -qx '0.0.0-test' '$PREFIX/Library/Application Support/Everwatch/runtime/current/VERSION'"
check "CLI wrapper was linked and is executable" \
  "[ -x '$PREFIX/.local/bin/everwatch' ]"
check "CLI wrapper reports a version" \
  "'$PREFIX/.local/bin/everwatch' --version | grep -q everwatch"
if [ "$HAVE_SWIFT" = "1" ]; then
  check "Everwatch.app was installed" "[ -d '$PREFIX/Applications/Everwatch.app' ]"
  # The Automation pane lists the *controlling* app (Everwatch) with a
  # toggle for the *target* (iTerm2) -- pin the corrected direction and
  # make sure the old, inverted phrasing ("enable Everwatch under iTerm2")
  # can't silently come back.
  check "final hint says to find Everwatch, then turn on iTerm2 (correct direction)" \
    "grep -q 'find Everwatch in that list and turn on iTerm2' '$INSTALL_OUT'"
  check "final hint does NOT say the inverted \"enable Everwatch under iTerm2\"" \
    "! grep -q 'enable Everwatch under iTerm2' '$INSTALL_OUT'"
else
  check "Everwatch.app was NOT installed (browser-only)" \
    "[ ! -d '$PREFIX/Applications/Everwatch.app' ]"
fi
rm -f "$INSTALL_OUT"

echo
echo "==> install.sh --uninstall --prefix $PREFIX --yes"
UNINSTALL_OUT="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-uninstall-out.XXXXXX")"
bash "$INSTALL_SH" --uninstall --prefix "$PREFIX" --yes | tee "$UNINSTALL_OUT"

echo
echo "==> resulting tree (after uninstall)"
find "$PREFIX" | sort

echo
echo "==> checks (post-uninstall)"
check "Everwatch.app was removed" "[ ! -d '$PREFIX/Applications/Everwatch.app' ]"
check "CLI wrapper was removed" "[ ! -e '$PREFIX/.local/bin/everwatch' ]"
check "runtime was removed" "[ ! -e '$PREFIX/Library/Application Support/Everwatch/runtime' ]"
check "EVERWATCH_HOME directory itself still exists (state.json is kept, not --purge)" \
  "[ -d '$PREFIX/Library/Application Support/Everwatch' ]"
# The old message told the user to run "everwatch uninstall --purge" "before
# removing the CLI link" -- but the CLI link is already gone by the time
# anyone reads this (checked above). The new message must be actionable
# without it: name the kept path and either the exact by-hand commands or
# install.sh's own --uninstall --purge (which doesn't need the CLI link).
check "kept-state message names the exact EVERWATCH_HOME path" \
  "grep -qF '$PREFIX/Library/Application Support/Everwatch' '$UNINSTALL_OUT'"
check "kept-state message gives the exact tccutil command" \
  "grep -q 'tccutil reset AppleEvents' '$UNINSTALL_OUT'"
check "kept-state message does NOT reference the CLI link that's already gone" \
  "! grep -q 'before removing the CLI link' '$UNINSTALL_OUT'"
rm -f "$UNINSTALL_OUT"

# ---------------------------------------------------------------------------
# --uninstall --purge: install.sh's own equivalent of `everwatch uninstall
# --purge`, run in exactly the scenario the old message couldn't handle --
# the CLI link is already gone (removed by the plain --uninstall above).
# Fakes tccutil via EVERWATCH_TCCUTIL_BIN so this never touches the real
# per-user TCC database (docs/DESIGN.md hard rule #2).
# ---------------------------------------------------------------------------
BUNDLE_ID="$(sed -nE 's/^BUNDLE_ID="([^"]+)"/\1/p' "$INSTALL_SH" | head -n1)"
FAKE_TCCUTIL_LOG="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-tccutil-log.XXXXXX")"
export FAKE_TCCUTIL_LOG
FAKE_TCCUTIL_BIN="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-tccutil-bin.XXXXXX")"
cat > "$FAKE_TCCUTIL_BIN" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_TCCUTIL_LOG"
STUB
chmod +x "$FAKE_TCCUTIL_BIN"

echo
echo "==> install.sh --uninstall --purge --prefix $PREFIX --yes (CLI link already gone)"
check "CLI link is indeed already gone before --purge runs" \
  "[ ! -e '$PREFIX/.local/bin/everwatch' ]"
PURGE_OUT="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-purge-out.XXXXXX")"
EVERWATCH_TCCUTIL_BIN="$FAKE_TCCUTIL_BIN" \
  bash "$INSTALL_SH" --uninstall --purge --prefix "$PREFIX" --yes | tee "$PURGE_OUT"

echo
echo "==> checks (post-purge)"
check "EVERWATCH_HOME was removed entirely (state.json purged too)" \
  "[ ! -e '$PREFIX/Library/Application Support/Everwatch' ]"
check "tccutil reset was invoked with the right subcommand and bundle id" \
  "grep -qx \"reset AppleEvents $BUNDLE_ID\" '$FAKE_TCCUTIL_LOG'"
check "purge output confirms the Automation grant was reset" \
  "grep -q 'Resetting the Automation permission grant' '$PURGE_OUT'"
rm -f "$PURGE_OUT" "$FAKE_TCCUTIL_LOG" "$FAKE_TCCUTIL_BIN"

# ---------------------------------------------------------------------------
# --uninstall --purge on a machine where Everwatch.app never ran: no
# Automation grant exists yet, so tccutil reports "No such bundle
# identifier ... (OSStatus error -10814.)" on stderr with a non-zero exit.
# Regression test: install.sh runs under `set -e`, so this used to abort
# before "Everwatch uninstalled" and exit non-zero. It must now finish
# uninstalling with a calm one-liner instead of tccutil's raw stderr.
# ---------------------------------------------------------------------------
STAGE2="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stage2.XXXXXX")"
PREFIX2="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefix2.XXXXXX")"
cp -R "$ROOT/everwatch" "$STAGE2/everwatch"
find "$STAGE2/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$ROOT/LICENSE" "$STAGE2/LICENSE"
printf '0.0.0-test\n' > "$STAGE2/VERSION"
bash "$INSTALL_SH" --from-local "$STAGE2" --prefix "$PREFIX2" --yes --no-open \
  --browser-only >/dev/null

NO_BUNDLE_TCCUTIL_BIN="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-tccutil-nobundle.XXXXXX")"
cat > "$NO_BUNDLE_TCCUTIL_BIN" <<'STUB'
#!/usr/bin/env bash
printf 'tccutil: No such bundle identifier "io.github.burnsbert.everwatch": The operation couldn'"'"'t be completed. (OSStatus error -10814.)\n' >&2
exit 1
STUB
chmod +x "$NO_BUNDLE_TCCUTIL_BIN"

echo
echo "==> install.sh --uninstall --purge (no prior Automation grant -- was: aborts under set -e)"
set +e
NOBUNDLE_OUT="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-nobundle-out.XXXXXX")"
EVERWATCH_TCCUTIL_BIN="$NO_BUNDLE_TCCUTIL_BIN" \
  bash "$INSTALL_SH" --uninstall --purge --prefix "$PREFIX2" --yes \
  >"$NOBUNDLE_OUT" 2>&1
NOBUNDLE_RC=$?
set -e
cat "$NOBUNDLE_OUT"

echo
echo "==> checks (no prior Automation grant)"
check "exits 0 instead of aborting under set -e (this was the bug: FAIL before the fix)" \
  "[ '$NOBUNDLE_RC' -eq 0 ]"
check "prints the calm one-liner, not tccutil's raw stderr" \
  "grep -q 'No Automation grant to reset' '$NOBUNDLE_OUT'"
check "does NOT leak tccutil's raw OSStatus stderr" \
  "! grep -q 'OSStatus' '$NOBUNDLE_OUT'"
check "still finishes the uninstall" \
  "grep -q 'Everwatch uninstalled' '$NOBUNDLE_OUT'"
rm -f "$NOBUNDLE_OUT" "$NO_BUNDLE_TCCUTIL_BIN"

# ---------------------------------------------------------------------------
# --uninstall --purge where tccutil fails for some other, non -10814 reason:
# must warn with the manual command but still finish successfully.
# ---------------------------------------------------------------------------
GENERIC_FAIL_TCCUTIL_BIN="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-tccutil-genericfail.XXXXXX")"
cat > "$GENERIC_FAIL_TCCUTIL_BIN" <<'STUB'
#!/usr/bin/env bash
printf 'tccutil: something else went wrong\n' >&2
exit 1
STUB
chmod +x "$GENERIC_FAIL_TCCUTIL_BIN"

# Re-stage a fresh install to purge again (the previous --purge already
# removed EVERWATCH_HOME entirely, so there's nothing left to purge).
bash "$INSTALL_SH" --from-local "$STAGE2" --prefix "$PREFIX2" --yes --no-open \
  --browser-only >/dev/null

echo
echo "==> install.sh --uninstall --purge (tccutil fails for an unrelated reason)"
set +e
GENERICFAIL_OUT="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-genericfail-out.XXXXXX")"
EVERWATCH_TCCUTIL_BIN="$GENERIC_FAIL_TCCUTIL_BIN" \
  bash "$INSTALL_SH" --uninstall --purge --prefix "$PREFIX2" --yes \
  >"$GENERICFAIL_OUT" 2>&1
GENERICFAIL_RC=$?
set -e
cat "$GENERICFAIL_OUT"

echo
echo "==> checks (tccutil generic failure)"
check "exits 0 instead of aborting under set -e" \
  "[ '$GENERICFAIL_RC' -eq 0 ]"
check "warns with the manual reset command" \
  "grep -q 'tccutil reset AppleEvents' '$GENERICFAIL_OUT'"
check "still finishes the uninstall" \
  "grep -q 'Everwatch uninstalled' '$GENERICFAIL_OUT'"
rm -f "$GENERICFAIL_OUT" "$GENERIC_FAIL_TCCUTIL_BIN"
rm -rf "$STAGE2" "$PREFIX2"

# ---------------------------------------------------------------------------
# usage()'s promise: never launches Everwatch.app except through the final
# "Open Everwatch now?" prompt, which is skipped only by --no-open or when
# there's truly no terminal at all (even with --yes). Regression test for
# the bug this replaces: prompt_open() used to gate on stdin being a TTY,
# so it never opened under the documented `curl ... | bash` one-liner
# (stdin there is curl's pipe, not a terminal, even though a real terminal
# is attached to the shell running it).
#
# EVERWATCH_TTY overrides which path prompt_open treats as "the terminal",
# so both ends of that gate are testable without a real pty:
#   - EVERWATCH_TTY=/nonexistent simulates truly having no terminal at all
#     (cron/launchd/CI) -- open must never be called, even with --yes.
#   - EVERWATCH_TTY=<a plain file already holding "y\n"> simulates a real
#     terminal that answered "y" -- open must be called (prompt_open only
#     ever *reads* from it, never writes, so the fed answer survives).
#
# Uses a fake Everwatch.app (a plain directory is enough: shell_build_of
# tolerates a missing Info.plist) so this doesn't depend on swiftc/Command
# Line Tools being available.
# ---------------------------------------------------------------------------
STAGE3="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stage3.XXXXXX")"
cp -R "$ROOT/everwatch" "$STAGE3/everwatch"
find "$STAGE3/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$ROOT/LICENSE" "$STAGE3/LICENSE"
printf '0.0.0-test\n' > "$STAGE3/VERSION"
mkdir -p "$STAGE3/Everwatch.app/Contents"

FAKE_OPEN_BIN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-openbin.XXXXXX")"
FAKE_OPEN_LOG="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-open-log.XXXXXX")"
export FAKE_OPEN_LOG
cat > "$FAKE_OPEN_BIN_DIR/open" <<'STUB'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >> "$FAKE_OPEN_LOG"
STUB
chmod +x "$FAKE_OPEN_BIN_DIR/open"

PREFIX3="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefix3.XXXXXX")"
echo
echo "==> install.sh --from-local $STAGE3 --prefix $PREFIX3 --yes (EVERWATCH_TTY=/nonexistent: no terminal at all, must never call open)"
PATH="$FAKE_OPEN_BIN_DIR:$PATH" EVERWATCH_TTY=/nonexistent \
  bash "$INSTALL_SH" --from-local "$STAGE3" --prefix "$PREFIX3" --yes >/dev/null

echo
echo "==> checks (--yes, no terminal at all)"
check "the app was installed (so open_everwatch would have had something to open)" \
  "[ -d '$PREFIX3/Applications/Everwatch.app' ]"
check "stub open was never called (no terminal at all, even with --yes)" \
  "[ ! -s '$FAKE_OPEN_LOG' ]"
rm -rf "$PREFIX3"

FAKE_TTY="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-faketty.XXXXXX")"
printf 'y\n' > "$FAKE_TTY"
PREFIX3B="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefix3b.XXXXXX")"
echo
echo "==> install.sh --from-local $STAGE3 --prefix $PREFIX3B (EVERWATCH_TTY=a fake terminal fed \"y\", no --yes: must call open -- this is the curl|bash one-liner's shape)"
PATH="$FAKE_OPEN_BIN_DIR:$PATH" EVERWATCH_TTY="$FAKE_TTY" \
  bash "$INSTALL_SH" --from-local "$STAGE3" --prefix "$PREFIX3B" >/dev/null

echo
echo "==> checks (a real terminal answered \"y\")"
check "the app was installed" "[ -d '$PREFIX3B/Applications/Everwatch.app' ]"
check "stub open WAS called (a real terminal answered \"y\")" \
  "[ -s '$FAKE_OPEN_LOG' ] && grep -q 'Everwatch.app' '$FAKE_OPEN_LOG'"

rm -rf "$STAGE3" "$PREFIX3B" "$FAKE_OPEN_BIN_DIR"
rm -f "$FAKE_OPEN_LOG" "$FAKE_TTY"

# ---------------------------------------------------------------------------
# BLOCKER regression: a --prefix install must be self-consistent end to end.
# everwatch/cli.py's uninstall/update/doctor/--version all resolve the app
# dir and bin dir from EVERWATCH_APP_DIR/EVERWATCH_BIN_DIR, defaulting to the
# real $HOME otherwise -- so the CLI wrapper install.sh links for a --prefix
# install must export all three (EVERWATCH_HOME too) for its own `everwatch
# uninstall` to touch the prefix instead of the real $HOME.
#
# Simulates "the real $HOME" with a separate sentinel temp dir (never the
# actual user's real $HOME) holding a fake ~/Applications/Everwatch.app,
# ~/.local/bin/everwatch, and state.json, then runs the *installed prefix
# wrapper's own* `everwatch uninstall` with HOME pointed at that sentinel --
# exactly how a real prefix install's wrapper runs under a real shell,
# where $HOME is whatever the invoking user's real $HOME is. Asserts the
# sentinel is left completely untouched and the prefix copy is removed.
# ---------------------------------------------------------------------------
STAGE5="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stage5.XXXXXX")"
PREFIX5="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefix5.XXXXXX")"
SENTINEL_HOME="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-sentinel-home.XXXXXX")"
cp -R "$ROOT/everwatch" "$STAGE5/everwatch"
find "$STAGE5/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$ROOT/LICENSE" "$STAGE5/LICENSE"
printf '0.0.0-test\n' > "$STAGE5/VERSION"

mkdir -p "$SENTINEL_HOME/Applications/Everwatch.app/Contents"
printf 'sentinel\n' > "$SENTINEL_HOME/Applications/Everwatch.app/Contents/marker"
mkdir -p "$SENTINEL_HOME/.local/bin"
cat > "$SENTINEL_HOME/.local/bin/everwatch" <<'STUB'
#!/usr/bin/env bash
echo "sentinel everwatch -- should never run"
STUB
chmod +x "$SENTINEL_HOME/.local/bin/everwatch"
mkdir -p "$SENTINEL_HOME/Library/Application Support/Everwatch"
printf '{}' > "$SENTINEL_HOME/Library/Application Support/Everwatch/state.json"

echo
echo "==> install.sh --from-local $STAGE5 --prefix $PREFIX5 --yes --no-open --browser-only (HOME=sentinel, never touched by the install itself)"
HOME="$SENTINEL_HOME" bash "$INSTALL_SH" --from-local "$STAGE5" --prefix "$PREFIX5" \
  --yes --no-open --browser-only >/dev/null

echo
echo "==> $PREFIX5/.local/bin/everwatch uninstall --yes (the installed prefix wrapper's own uninstall; HOME=sentinel)"
HOME="$SENTINEL_HOME" "$PREFIX5/.local/bin/everwatch" uninstall --yes

echo
echo "==> checks (prefix wrapper's own uninstall is self-consistent)"
check "the sentinel Everwatch.app was NOT touched (was: removed -- the wrapper defaulted to the real \$HOME)" \
  "[ -f '$SENTINEL_HOME/Applications/Everwatch.app/Contents/marker' ]"
check "the sentinel CLI link was NOT touched" \
  "[ -x '$SENTINEL_HOME/.local/bin/everwatch' ] && grep -q 'sentinel everwatch' '$SENTINEL_HOME/.local/bin/everwatch'"
check "the sentinel state.json was NOT touched" \
  "[ -f '$SENTINEL_HOME/Library/Application Support/Everwatch/state.json' ]"
check "the prefix's runtime was removed" \
  "[ ! -e '$PREFIX5/Library/Application Support/Everwatch/runtime' ]"
check "the prefix's own CLI wrapper removed itself" \
  "[ ! -e '$PREFIX5/.local/bin/everwatch' ]"
rm -rf "$STAGE5" "$PREFIX5" "$SENTINEL_HOME"

# ---------------------------------------------------------------------------
# Update-while-running (the real bug this covers, docs/DESIGN.md §4.1's
# Update row): a running Everwatch.app must be quit gracefully before its
# files are replaced, and relaunched once the update finishes -- otherwise
# the already-running process (and its Python backend child) keeps serving
# the *old* code even though install.sh just swapped every file out from
# under it, and a bare `everwatch` just re-activates the stale instance.
#
# EVERWATCH_PGREP_BIN/EVERWATCH_OSASCRIPT_BIN are state-driven stubs --
# never a real pgrep/osascript, and never anything that could reach the
# user's actual running Everwatch.app (hard rule). The pgrep stub just
# reads a "running"/"not-running" state file; the osascript stub logs the
# quit call (recording, at that exact moment, whether the runtime's
# VERSION file was still the *old* one -- the "quit happened before files
# were replaced" check) and, only when FAKE_QUIT_SUCCEEDS=1, flips the
# state file so wait_for_quit sees the app exit. The stub `open` (already
# used above) appends to the same shared event log, so ordering between
# "quit" and "open" is checkable with plain line numbers.
# ---------------------------------------------------------------------------
STAGE_OLD="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stageold.XXXXXX")"
STAGE_NEW="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-stagenew.XXXXXX")"
for s in "$STAGE_OLD" "$STAGE_NEW"; do
  cp -R "$ROOT/everwatch" "$s/everwatch"
  find "$s/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  cp "$ROOT/LICENSE" "$s/LICENSE"
  mkdir -p "$s/Everwatch.app/Contents"
done
printf '0.0.0-old\n' > "$STAGE_OLD/VERSION"
printf '0.0.1-new\n' > "$STAGE_NEW/VERSION"

make_fake_pgrep() {
  local bin
  bin="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-pgrep-bin.XXXXXX")"
  cat > "$bin" <<'STUB'
#!/usr/bin/env bash
state="$(cat "$FAKE_PGREP_STATE" 2>/dev/null || echo running)"
[ "$state" = "running" ]
STUB
  chmod +x "$bin"
  printf '%s' "$bin"
}

make_fake_osascript() {
  local bin
  bin="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-osascript-bin.XXXXXX")"
  cat > "$bin" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_EVENT_LOG"
case "$*" in
  *"to quit"*)
    if [ "$(cat "$FAKE_RUNTIME_VERSION_FILE" 2>/dev/null)" = "$FAKE_OLD_VERSION" ]; then
      printf 'quit-before-replace\n' >> "$FAKE_EVENT_LOG"
    else
      printf 'quit-after-replace\n' >> "$FAKE_EVENT_LOG"
    fi
    if [ "${FAKE_QUIT_SUCCEEDS:-1}" = "1" ]; then
      printf 'not-running\n' > "$FAKE_PGREP_STATE"
    fi
    ;;
esac
STUB
  chmod +x "$bin"
  printf '%s' "$bin"
}

make_fake_osascript_unexpected() {
  # For the "not running" scenario: osascript must never be invoked at
  # all, so a call here is itself a bug -- log it loudly instead of
  # silently no-op'ing, so the test can assert the log stays empty.
  local bin
  bin="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-osascript-unexpected.XXXXXX")"
  cat > "$bin" <<'STUB'
#!/usr/bin/env bash
printf 'UNEXPECTED osascript call: %s\n' "$*" >> "$FAKE_EVENT_LOG"
STUB
  chmod +x "$bin"
  printf '%s' "$bin"
}

FAKE_PGREP_BIN="$(make_fake_pgrep)"

# --- (a) running, quits cleanly: quit before replace, relaunch after -------
PREFIX_A="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefixA.XXXXXX")"
bash "$INSTALL_SH" --from-local "$STAGE_OLD" --prefix "$PREFIX_A" --yes --no-open >/dev/null
check "(a) setup: Everwatch.app installed" "[ -d '$PREFIX_A/Applications/Everwatch.app' ]"

FAKE_PGREP_STATE_A="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-pgrep-state-a.XXXXXX")"
printf 'running\n' > "$FAKE_PGREP_STATE_A"
FAKE_EVENT_LOG_A="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-event-log-a.XXXXXX")"
: > "$FAKE_EVENT_LOG_A"
FAKE_OSASCRIPT_BIN_A="$(make_fake_osascript)"
FAKE_OPEN_DIR_A="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-openbin-a.XXXXXX")"
cat > "$FAKE_OPEN_DIR_A/open" <<'STUB'
#!/usr/bin/env bash
printf 'open %s\n' "$*" >> "$FAKE_EVENT_LOG"
STUB
chmod +x "$FAKE_OPEN_DIR_A/open"

echo
echo "==> install.sh --from-local (new version) --prefix $PREFIX_A --yes (Everwatch.app 'running')"
set +e
OUT_A="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-out-a.XXXXXX")"
FAKE_PGREP_STATE="$FAKE_PGREP_STATE_A" FAKE_EVENT_LOG="$FAKE_EVENT_LOG_A" \
  FAKE_RUNTIME_VERSION_FILE="$PREFIX_A/Library/Application Support/Everwatch/runtime/current/VERSION" \
  FAKE_OLD_VERSION="0.0.0-old" FAKE_QUIT_SUCCEEDS=1 \
  EVERWATCH_PGREP_BIN="$FAKE_PGREP_BIN" EVERWATCH_OSASCRIPT_BIN="$FAKE_OSASCRIPT_BIN_A" \
  PATH="$FAKE_OPEN_DIR_A:$PATH" \
  bash "$INSTALL_SH" --from-local "$STAGE_NEW" --prefix "$PREFIX_A" --yes \
  >"$OUT_A" 2>&1
RC_A=$?
set -e
cat "$OUT_A"

echo
echo "==> checks (a) running -> quits, updates, relaunches"
check "exits 0" "[ '$RC_A' -eq 0 ]"
check "quit was recorded" "grep -q 'to quit' '$FAKE_EVENT_LOG_A'"
check "quit happened before the runtime's files were replaced" \
  "grep -q 'quit-before-replace' '$FAKE_EVENT_LOG_A'"
check "runtime was actually updated to the new version" \
  "grep -qx '0.0.1-new' '$PREFIX_A/Library/Application Support/Everwatch/runtime/current/VERSION'"
check "open was recorded after the quit (relaunch happened, in order)" \
  "awk '/to quit/{q=NR} /^open /{o=NR} END{exit !(q && o && q<o)}' '$FAKE_EVENT_LOG_A'"
check "output says Everwatch is being relaunched" \
  "grep -qF 'Relaunching Everwatch 0.0.1-new' '$OUT_A'"
check "output makes clear the new version is now running" \
  "grep -qF 'Everwatch 0.0.1-new is running' '$OUT_A'"
rm -rf "$PREFIX_A" "$FAKE_OPEN_DIR_A"
rm -f "$FAKE_PGREP_STATE_A" "$FAKE_EVENT_LOG_A" "$FAKE_OSASCRIPT_BIN_A" "$OUT_A"

# --- (b) not running: no quit, no relaunch ---------------------------------
PREFIX_B="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefixB.XXXXXX")"
bash "$INSTALL_SH" --from-local "$STAGE_OLD" --prefix "$PREFIX_B" --yes --no-open >/dev/null

FAKE_PGREP_STATE_B="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-pgrep-state-b.XXXXXX")"
printf 'not-running\n' > "$FAKE_PGREP_STATE_B"
FAKE_EVENT_LOG_B="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-event-log-b.XXXXXX")"
: > "$FAKE_EVENT_LOG_B"
FAKE_OSASCRIPT_BIN_B="$(make_fake_osascript_unexpected)"

echo
echo "==> install.sh --from-local (new version) --prefix $PREFIX_B --yes --no-open (Everwatch.app 'not running')"
FAKE_PGREP_STATE="$FAKE_PGREP_STATE_B" FAKE_EVENT_LOG="$FAKE_EVENT_LOG_B" \
  EVERWATCH_PGREP_BIN="$FAKE_PGREP_BIN" EVERWATCH_OSASCRIPT_BIN="$FAKE_OSASCRIPT_BIN_B" \
  bash "$INSTALL_SH" --from-local "$STAGE_NEW" --prefix "$PREFIX_B" --yes --no-open

echo
echo "==> checks (b) not running -> no quit, no relaunch"
check "osascript was never invoked (no quit attempted)" "[ ! -s '$FAKE_EVENT_LOG_B' ]"
rm -rf "$PREFIX_B"
rm -f "$FAKE_PGREP_STATE_B" "$FAKE_EVENT_LOG_B" "$FAKE_OSASCRIPT_BIN_B"

# --- (c) running + --no-open: quit happens, no relaunch, told how to start -
PREFIX_C="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefixC.XXXXXX")"
bash "$INSTALL_SH" --from-local "$STAGE_OLD" --prefix "$PREFIX_C" --yes --no-open >/dev/null

FAKE_PGREP_STATE_C="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-pgrep-state-c.XXXXXX")"
printf 'running\n' > "$FAKE_PGREP_STATE_C"
FAKE_EVENT_LOG_C="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-event-log-c.XXXXXX")"
: > "$FAKE_EVENT_LOG_C"
FAKE_OSASCRIPT_BIN_C="$(make_fake_osascript)"

echo
echo "==> install.sh --from-local (new version) --prefix $PREFIX_C --yes --no-open (Everwatch.app 'running')"
OUT_C="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-out-c.XXXXXX")"
FAKE_PGREP_STATE="$FAKE_PGREP_STATE_C" FAKE_EVENT_LOG="$FAKE_EVENT_LOG_C" \
  FAKE_RUNTIME_VERSION_FILE="$PREFIX_C/Library/Application Support/Everwatch/runtime/current/VERSION" \
  FAKE_OLD_VERSION="0.0.0-old" FAKE_QUIT_SUCCEEDS=1 \
  EVERWATCH_PGREP_BIN="$FAKE_PGREP_BIN" EVERWATCH_OSASCRIPT_BIN="$FAKE_OSASCRIPT_BIN_C" \
  bash "$INSTALL_SH" --from-local "$STAGE_NEW" --prefix "$PREFIX_C" --yes --no-open \
  >"$OUT_C" 2>&1
cat "$OUT_C"

echo
echo "==> checks (c) running + --no-open -> quit happens, no relaunch"
check "quit was recorded" "grep -q 'to quit' '$FAKE_EVENT_LOG_C'"
check "open was NOT recorded (no relaunch with --no-open)" "! grep -q '^open ' '$FAKE_EVENT_LOG_C'"
check "output tells the user how to start Everwatch themselves" \
  "grep -qF 'not reopened (--no-open)' '$OUT_C' && grep -qF 'Run \"everwatch\"' '$OUT_C'"
rm -rf "$PREFIX_C"
rm -f "$FAKE_PGREP_STATE_C" "$FAKE_EVENT_LOG_C" "$FAKE_OSASCRIPT_BIN_C" "$OUT_C"

# --- (d) refuses to quit: warns, install still completes, no relaunch ------
PREFIX_D="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-test-prefixD.XXXXXX")"
bash "$INSTALL_SH" --from-local "$STAGE_OLD" --prefix "$PREFIX_D" --yes --no-open >/dev/null

FAKE_PGREP_STATE_D="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-pgrep-state-d.XXXXXX")"
printf 'running\n' > "$FAKE_PGREP_STATE_D"
FAKE_EVENT_LOG_D="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-event-log-d.XXXXXX")"
: > "$FAKE_EVENT_LOG_D"
FAKE_OSASCRIPT_BIN_D="$(make_fake_osascript)"

echo
echo "==> install.sh --from-local (new version) --prefix $PREFIX_D --yes (Everwatch.app refuses to quit)"
OUT_D="$(mktemp "${TMPDIR:-/tmp}/everwatch-test-out-d.XXXXXX")"
FAKE_PGREP_STATE="$FAKE_PGREP_STATE_D" FAKE_EVENT_LOG="$FAKE_EVENT_LOG_D" \
  FAKE_RUNTIME_VERSION_FILE="$PREFIX_D/Library/Application Support/Everwatch/runtime/current/VERSION" \
  FAKE_OLD_VERSION="0.0.0-old" FAKE_QUIT_SUCCEEDS=0 \
  EVERWATCH_QUIT_POLL_TRIES=2 EVERWATCH_QUIT_POLL_INTERVAL=0.05 \
  EVERWATCH_PGREP_BIN="$FAKE_PGREP_BIN" EVERWATCH_OSASCRIPT_BIN="$FAKE_OSASCRIPT_BIN_D" \
  bash "$INSTALL_SH" --from-local "$STAGE_NEW" --prefix "$PREFIX_D" --yes \
  >"$OUT_D" 2>&1
RC_D=$?
cat "$OUT_D"

echo
echo "==> checks (d) refuses to quit -> warns, install still completes"
check "exits 0 (install still completes)" "[ '$RC_D' -eq 0 ]"
check "quit was attempted" "grep -q 'to quit' '$FAKE_EVENT_LOG_D'"
check "runtime was still updated to the new version despite the refusal" \
  "grep -qx '0.0.1-new' '$PREFIX_D/Library/Application Support/Everwatch/runtime/current/VERSION'"
check "open was NOT recorded (no relaunch attempted against a still-running instance)" \
  "! grep -q '^open ' '$FAKE_EVENT_LOG_D'"
check "output warns that Everwatch didn't quit in time" \
  "grep -qF \"didn't quit in time\" '$OUT_D'"
check "output tells the user to quit by hand and relaunch" \
  "grep -qF 'Quit it by hand' '$OUT_D' && grep -qF 'run \"everwatch\"' '$OUT_D'"
rm -rf "$PREFIX_D"
rm -f "$FAKE_PGREP_STATE_D" "$FAKE_EVENT_LOG_D" "$FAKE_OSASCRIPT_BIN_D" "$OUT_D"

rm -rf "$STAGE_OLD" "$STAGE_NEW"
rm -f "$FAKE_PGREP_BIN"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
