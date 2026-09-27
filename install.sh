#!/usr/bin/env bash
# Everwatch installer (docs/DESIGN.md §4.1).
#
#   curl -fsSL https://raw.githubusercontent.com/burnsbert/everwatch/main/install.sh | bash
#
# Never asks for sudo, never plays a sound, never launches Everwatch.app
# except through the final "Open Everwatch now?" prompt -- which runs (even
# for the piped one-liner above, whose own stdin is curl's pipe, not a
# terminal) whenever a real terminal is attached, reading the answer from
# it directly. Skipped only by --no-open, or when there's truly no terminal
# at all (no /dev/tty -- cron, launchd, CI), even with --yes.
#
# The one exception: if Everwatch.app was already running when this script
# started (an update), it's quit gracefully before its files are replaced
# and relaunched automatically once the update finishes -- unless --no-open
# was given, or it wouldn't quit within the timeout, in which case this
# script says so instead of guessing.
#
# Run with --help (works piped too: `... | bash -s -- --help`) for the full
# flag list; usage() below is its single source of truth.
set -euo pipefail

REPO="burnsbert/everwatch"
BUNDLE_ID="io.github.burnsbert.everwatch"
MIN_MACOS_MAJOR=13
# Overridable for tests/install/test_install.sh's offline release-path test,
# which points these at a local `python3 -m http.server` instead of GitHub.
API_BASE="${EVERWATCH_API_BASE:-https://api.github.com/repos/$REPO}"
DL_BASE="${EVERWATCH_DL_BASE:-https://github.com/$REPO/releases/download}"

# ---------------------------------------------------------------------------
# Output helpers: colored when stdout is a TTY (and NO_COLOR isn't set),
# plain text otherwise. Never anything that makes sound.
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_BOLD=$'\033[1m'; C_RED=$'\033[31m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_BLUE=$'\033[34m'; C_RESET=$'\033[0m'
else
  C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_RESET=""
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s\n' "${C_BLUE}==>${C_RESET} ${C_BOLD}$*${C_RESET}"; }
ok()   { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "${C_YELLOW}⚠${C_RESET} $*" >&2; }
err()  { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Argument parsing (manual: this must run under macOS's bash 3.2, which
# lacks getopts long-option support).
# ---------------------------------------------------------------------------
BROWSER_ONLY=0
WITH_COLORS=0
PREFIX=""
REQUESTED_VERSION=""
FROM_LOCAL=""
DO_UNINSTALL=0
DO_PURGE=0
ASSUME_YES=0
NO_OPEN=0

# Single source of truth for both `--help` and the top-of-file summary
# comment (which stays short and points here). A heredoc instead of the
# old `sed -n '2,28p' "$0"` because $0 is literally "bash" -- not this
# file's path -- when the script runs piped from curl (the documented
# one-liner), which made `--help` fail with "sed: bash: No such file or
# directory" instead of printing anything.
usage() {
  cat <<'EOF'
Everwatch installer (docs/DESIGN.md §4.1).

  curl -fsSL https://raw.githubusercontent.com/burnsbert/everwatch/main/install.sh | bash

Never asks for sudo, never plays a sound, never launches Everwatch.app
except through the final "Open Everwatch now?" prompt -- which runs (even
for the piped one-liner above) whenever a real terminal is attached, and
is skipped only by --no-open or when there's truly no terminal at all
(no /dev/tty -- cron, launchd, CI), even with --yes.

If Everwatch.app was already running (an update), it's quit gracefully
before its files are replaced and relaunched automatically when the
update finishes, instead of asking -- unless --no-open was given, or it
wouldn't quit in time.

Flags:
  --browser-only     Skip the native app; use `everwatch open` instead.
  --with-colors      Also set up the optional iTerm2 tab-color integration
                     (creates a private venv and `pip install iterm2`).
  --prefix DIR       Install under DIR instead of the real $HOME. Overrides
                     the app dir, EVERWATCH_HOME, and the CLI bin dir.
                     Intended for testing and advanced setups. (The
                     prefix's Everwatch.app still reads the default
                     runtime unless EVERWATCH_HOME is set.)
  --version X        Install a specific release instead of the latest.
                     X may be given with or without the leading "v"
                     (e.g. "0.1.0" or "v0.1.0").
  --from-local DIR   Use a local checkout or extracted build instead of
                     downloading anything (offline installs, and this
                     script's own tests). DIR must contain an `everwatch/`
                     package; an `Everwatch.app` (or `build/Everwatch.app`)
                     alongside it is used as the prebuilt app if present.
  --uninstall        Remove the app, runtime, venv, and CLI link. Keeps
                     state.json -- add --purge to also remove that and
                     reset the Automation grant (same as
                     `everwatch uninstall --purge`, but works even after
                     the CLI link is already gone).
  --purge            With --uninstall, also delete state.json and reset
                     the Automation permission grant. Ignored otherwise.
  --yes              Never prompt; assume yes.
  --no-open          Don't offer to open Everwatch when finished.
  --help             Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --browser-only) BROWSER_ONLY=1; shift ;;
    --with-colors) WITH_COLORS=1; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a DIR}"; shift 2 ;;
    --prefix=*) PREFIX="${1#*=}"; shift ;;
    --version) REQUESTED_VERSION="${2:?--version needs a value}"; shift 2 ;;
    --version=*) REQUESTED_VERSION="${1#*=}"; shift ;;
    --from-local) FROM_LOCAL="${2:?--from-local needs a DIR}"; shift 2 ;;
    --from-local=*) FROM_LOCAL="${1#*=}"; shift ;;
    --uninstall) DO_UNINSTALL=1; shift ;;
    --purge) DO_PURGE=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --no-open) NO_OPEN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Paths. --prefix overrides all three of the app dir, EVERWATCH_HOME, and
# the CLI bin dir -- it stands in for $HOME (docs/DESIGN.md §4.1). Real
# runs otherwise honor an EVERWATCH_HOME override the same way the shell
# and CLI do (shell/README.md).
# ---------------------------------------------------------------------------
if [ -n "$PREFIX" ]; then
  mkdir -p "$PREFIX"
  APP_DIR="$PREFIX/Applications"
  EVERWATCH_HOME="$PREFIX/Library/Application Support/Everwatch"
  BIN_DIR="$PREFIX/.local/bin"
else
  APP_DIR="$HOME/Applications"
  EVERWATCH_HOME="${EVERWATCH_HOME:-$HOME/Library/Application Support/Everwatch}"
  BIN_DIR="$HOME/.local/bin"
fi
RUNTIME_ROOT="$EVERWATCH_HOME/runtime"

# Whether a runtime was already installed here before this run -- an update,
# not a first-time install. Read before install_runtime touches anything;
# used only to decide whether the "restart any old browser-mode session"
# hint below is worth printing.
PRIOR_INSTALL=0
[ -e "$RUNTIME_ROOT/current" ] && PRIOR_INSTALL=1

# ---------------------------------------------------------------------------
# Uninstall path (install.sh --uninstall[--purge] mirrors
# `everwatch uninstall [--purge]` -- docs/DESIGN.md §4.1's Uninstall row --
# so --purge still works even after the CLI link it would otherwise need is
# already gone).
# ---------------------------------------------------------------------------
run_tccutil_reset() {  # $1 = bundle id
  # Overridable so tests/install/test_install.sh can assert this runs with
  # the right args without ever touching the real per-user TCC database
  # (docs/DESIGN.md hard rule #2 -- same reason everwatch/cli.py's tests
  # patch _tccutil_reset instead of letting it run for real).
  #
  # Must never abort the uninstall (this runs under `set -e`) and must
  # never leak tccutil's raw stderr: on a machine where Everwatch.app
  # never ran, there's no Automation grant to reset yet, and tccutil
  # reports that as "No such bundle identifier ... (OSStatus error
  # -10814.)" on stderr with a non-zero exit -- expected, not a failure.
  local bin="${EVERWATCH_TCCUTIL_BIN:-tccutil}"
  if ! command -v "$bin" >/dev/null 2>&1; then
    warn "tccutil not found; the Automation grant wasn't reset"
    return
  fi
  local out
  if out="$("$bin" reset AppleEvents "$1" 2>&1)"; then
    ok "Automation grant reset."
  elif printf '%s' "$out" | grep -qiE 'no such bundle identifier|-10814'; then
    say "No Automation grant to reset (Everwatch never asked for one)."
  else
    warn "couldn't reset the Automation grant automatically:"
    warn "$out"
    warn "reset it by hand with: tccutil reset AppleEvents \"$1\""
  fi
}

do_uninstall() {
  info "Uninstalling Everwatch"
  local removed_any=0
  if [ -d "$APP_DIR/Everwatch.app" ]; then
    rm -rf "$APP_DIR/Everwatch.app"
    ok "removed $APP_DIR/Everwatch.app"
    removed_any=1
  fi
  if [ -L "$BIN_DIR/everwatch" ] || [ -e "$BIN_DIR/everwatch" ]; then
    rm -f "$BIN_DIR/everwatch"
    ok "removed $BIN_DIR/everwatch"
    removed_any=1
  fi
  if [ "$DO_PURGE" = "1" ]; then
    if [ -e "$EVERWATCH_HOME" ] || [ -L "$EVERWATCH_HOME" ]; then
      rm -rf "$EVERWATCH_HOME"
      ok "removed $EVERWATCH_HOME"
      removed_any=1
    fi
  else
    if [ -e "$RUNTIME_ROOT" ] || [ -L "$RUNTIME_ROOT" ]; then
      rm -rf "$RUNTIME_ROOT"
      ok "removed $RUNTIME_ROOT"
      removed_any=1
    fi
    if [ -d "$EVERWATCH_HOME/venv" ]; then
      rm -rf "$EVERWATCH_HOME/venv"
      ok "removed $EVERWATCH_HOME/venv"
      removed_any=1
    fi
  fi
  if [ "$removed_any" = "0" ]; then
    say "Nothing to remove."
  fi
  if [ "$DO_PURGE" = "1" ]; then
    info "Resetting the Automation permission grant…"
    run_tccutil_reset "$BUNDLE_ID"
    ok "Everwatch uninstalled (state.json was purged)."
  else
    say "state.json (labels, projects, prefs) was kept at \"$EVERWATCH_HOME\"."
    say "To also delete it and reset the Automation permission grant, run this"
    say "same script again with --uninstall --purge (no CLI link needed --"
    say "re-download it first if you no longer have a copy):"
    say "    curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall --purge"
    say "Or by hand:"
    say "    rm -rf \"$EVERWATCH_HOME\""
    say "    tccutil reset AppleEvents \"$BUNDLE_ID\""
    ok "Everwatch uninstalled."
  fi
}

if [ "$DO_UNINSTALL" = "1" ]; then
  do_uninstall
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 1: macOS version + iTerm2 presence (informational; never blocks).
# ---------------------------------------------------------------------------
info "Everwatch installer"

check_macos() {
  local ver major
  ver="$(sw_vers -productVersion 2>/dev/null || echo "0")"
  major="${ver%%.*}"
  if [ "${major:-0}" -lt "$MIN_MACOS_MAJOR" ] 2>/dev/null; then
    warn "macOS $ver detected; Everwatch is built for macOS $MIN_MACOS_MAJOR or later."
  else
    ok "macOS $ver"
  fi
}

check_iterm2() {
  if [ -d "/Applications/iTerm.app" ] || [ -d "$HOME/Applications/iTerm.app" ]; then
    ok "iTerm2 is installed"
    return
  fi
  if command -v mdfind >/dev/null 2>&1; then
    local hit
    hit="$(mdfind "kMDItemCFBundleIdentifier == 'com.googlecode.iterm2'" 2>/dev/null | head -n1 || true)"
    if [ -n "$hit" ]; then
      ok "iTerm2 is installed ($hit)"
      return
    fi
  fi
  warn "iTerm2 wasn't found. Everwatch needs it: https://iterm2.com"
}

check_macos
check_iterm2

# ---------------------------------------------------------------------------
# Step 2: find python3 >= 3.9 without ever triggering the "install Command
# Line Tools" dialog (docs/DESIGN.md §4.1, shell/README.md's PythonLocator
# order, mirrored here so the CLI wrapper picks the same interpreter).
# ---------------------------------------------------------------------------
PYTHON_BIN=""
PYTHON_VER=""

version_ge_39() {  # $1 = "X.Y[.Z]"
  local major minor
  major="$(printf '%s' "$1" | cut -d. -f1)"
  minor="$(printf '%s' "$1" | cut -d. -f2)"
  case "$major" in ''|*[!0-9]*) return 1 ;; esac
  case "$minor" in ''|*[!0-9]*) return 1 ;; esac
  [ "$major" -gt 3 ] && return 0
  [ "$major" -eq 3 ] && [ "$minor" -ge 9 ]
}

python_version() {
  "$1" -c 'import platform; print(platform.python_version())' 2>/dev/null
}

find_python3() {
  local c ver
  for c in "${EVERWATCH_PYTHON:-}" \
           "$EVERWATCH_HOME/venv/bin/python3" \
           "/opt/homebrew/bin/python3" \
           "/usr/local/bin/python3" \
           "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"; do
    [ -n "$c" ] || continue
    [ -x "$c" ] || continue
    ver="$(python_version "$c")"
    [ -n "$ver" ] || continue
    if version_ge_39 "$ver"; then
      PYTHON_BIN="$c"; PYTHON_VER="$ver"
      return 0
    fi
  done
  # /usr/bin/python3 is a stub that opens the "install developer tools"
  # dialog when the Command Line Tools aren't present -- only try it when
  # `xcode-select -p` already succeeds.
  if xcode-select -p >/dev/null 2>&1; then
    c="/usr/bin/python3"
    if [ -x "$c" ]; then
      ver="$(python_version "$c")"
      if [ -n "$ver" ] && version_ge_39 "$ver"; then
        PYTHON_BIN="$c"; PYTHON_VER="$ver"
        return 0
      fi
    fi
  fi
  return 1
}

if ! find_python3; then
  err "No Python 3.9+ found."
  say "  Try:  brew install python"
  say "  or:   xcode-select --install   (then re-run this installer)"
  exit 1
fi
ok "python3 $PYTHON_VER ($PYTHON_BIN)"

# ---------------------------------------------------------------------------
# Step 3+4: resolve a version and its runtime/app sources, either from
# --from-local, a specific --version, or the latest GitHub release (with a
# main-branch source + local swiftc build fallback when no release exists
# yet -- 404 or no assets).
# ---------------------------------------------------------------------------
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/everwatch-install.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

RUNTIME_SRC=""
APP_SRC=""
RESOLVED_VERSION=""

have_curl() { command -v curl >/dev/null 2>&1; }

download() {  # $1 = url, $2 = output path
  have_curl || die "curl is required to download $1"
  curl -fsSL --retry 2 -o "$2" "$1"
}

verify_sha256() {  # $1 = file, $2 = SHA256SUMS file
  local file="$1" sums="$2" base expected actual
  base="$(basename "$file")"
  expected="$(awk -v f="$base" '{n=$2; sub(/^\*/,"",n); if (n==f) print $1}' "$sums" | head -n1)"
  [ -n "$expected" ] || die "no sha256 recorded for $base in SHA256SUMS"
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [ "$expected" = "$actual" ] || die "sha256 mismatch for $base (expected $expected, got $actual)"
  ok "sha256 verified: $base"
}

fetch_release_assets() {  # $1 = version, no leading "v" (asset filenames,
                          # scripts/release.sh's dist/, never have one);
                          # the release *tag* is "v$1" (scripts/release.sh
                          # tags `v$VERSION`), so that's what goes in the
                          # download URL path.
  local ver="$1" tag="v$1"
  info "Downloading everwatch-$ver.tar.gz…"
  download "$DL_BASE/$tag/everwatch-$ver.tar.gz" "$WORK_DIR/everwatch-$ver.tar.gz" \
    || die "release $tag not found (missing asset everwatch-$ver.tar.gz)"
  download "$DL_BASE/$tag/SHA256SUMS" "$WORK_DIR/SHA256SUMS" \
    || die "release $tag is missing SHA256SUMS"
  verify_sha256 "$WORK_DIR/everwatch-$ver.tar.gz" "$WORK_DIR/SHA256SUMS"
  mkdir -p "$WORK_DIR/runtime-src"
  tar -xzf "$WORK_DIR/everwatch-$ver.tar.gz" -C "$WORK_DIR/runtime-src"
  RUNTIME_SRC="$WORK_DIR/runtime-src"

  if [ "$BROWSER_ONLY" != "1" ]; then
    if download "$DL_BASE/$tag/Everwatch-$ver.zip" "$WORK_DIR/Everwatch-$ver.zip" 2>/dev/null; then
      verify_sha256 "$WORK_DIR/Everwatch-$ver.zip" "$WORK_DIR/SHA256SUMS"
      mkdir -p "$WORK_DIR/app-src"
      ditto -x -k "$WORK_DIR/Everwatch-$ver.zip" "$WORK_DIR/app-src"
      APP_SRC="$WORK_DIR/app-src/Everwatch.app"
    else
      warn "release $tag has no prebuilt app; will try to build one with swiftc"
    fi
  fi
}

fetch_source_fallback() {
  info "Building from the main branch source instead (no release available yet)."
  local tarball="$WORK_DIR/source.tar.gz"
  download "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" "$tarball" \
    || die "could not download source from the main branch"
  mkdir -p "$WORK_DIR/source"
  tar -xzf "$tarball" -C "$WORK_DIR/source" --strip-components=1
  RUNTIME_SRC="$WORK_DIR/source"
  RESOLVED_VERSION="$("$PYTHON_BIN" -c \
    "import sys; sys.path.insert(0, '$RUNTIME_SRC'); import everwatch; print(everwatch.__version__)")-src"
  if [ "$BROWSER_ONLY" != "1" ] && command -v swiftc >/dev/null 2>&1 \
      && xcode-select -p >/dev/null 2>&1 \
      && [ -f "$RUNTIME_SRC/scripts/build_app.sh" ]; then
    info "Building Everwatch.app from source with swiftc…"
    ( cd "$RUNTIME_SRC" && bash scripts/build_app.sh --dev >/dev/null )
    APP_SRC="$RUNTIME_SRC/build/Everwatch.app"
  else
    warn "swiftc/Command Line Tools unavailable; continuing in browser-only mode."
    BROWSER_ONLY=1
  fi
}

fetch_latest_release() {
  info "Checking the latest release of ${REPO}…"
  local json http_code tag=""
  json="$WORK_DIR/latest.json"
  http_code="$(curl -fsSL -w '%{http_code}' -o "$json" "$API_BASE/releases/latest" 2>/dev/null || echo "000")"
  if [ "$http_code" = "200" ] && [ -s "$json" ]; then
    tag="$(grep -m1 '"tag_name"' "$json" | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/' || true)"
  fi
  if [ -n "$tag" ]; then
    RESOLVED_VERSION="${tag#v}"
    fetch_release_assets "$RESOLVED_VERSION"
    return
  fi
  warn "No GitHub release found yet for $REPO (API returned $http_code)."
  fetch_source_fallback
}

if [ -n "$FROM_LOCAL" ]; then
  info "Using local build: $FROM_LOCAL"
  [ -d "$FROM_LOCAL" ] || die "--from-local $FROM_LOCAL: not a directory"
  [ -d "$FROM_LOCAL/everwatch" ] || die "--from-local $FROM_LOCAL: no everwatch/ package found"
  RUNTIME_SRC="$FROM_LOCAL"
  if [ -f "$FROM_LOCAL/VERSION" ]; then
    RESOLVED_VERSION="$(cat "$FROM_LOCAL/VERSION")"
  else
    RESOLVED_VERSION="$("$PYTHON_BIN" -c \
      "import sys; sys.path.insert(0, '$FROM_LOCAL'); import everwatch; print(everwatch.__version__)")"
  fi
  if [ "$BROWSER_ONLY" != "1" ]; then
    if [ -d "$FROM_LOCAL/Everwatch.app" ]; then
      APP_SRC="$FROM_LOCAL/Everwatch.app"
    elif [ -d "$FROM_LOCAL/build/Everwatch.app" ]; then
      APP_SRC="$FROM_LOCAL/build/Everwatch.app"
    fi
  fi
elif [ -n "$REQUESTED_VERSION" ]; then
  RESOLVED_VERSION="${REQUESTED_VERSION#v}"  # --version accepts "0.1.0" or "v0.1.0"
  fetch_release_assets "$RESOLVED_VERSION"
else
  fetch_latest_release
fi

[ -n "$RESOLVED_VERSION" ] || die "could not determine a version to install"
ok "version $RESOLVED_VERSION"

# ---------------------------------------------------------------------------
# If Everwatch.app is already running, quit it gracefully before replacing
# any files, and remember to relaunch it once the update finishes. Without
# this, `everwatch update` (which re-runs this script under the hood, see
# everwatch/cli.py's cmd_update) swaps the runtime and/or app files out from
# under the running process, whose already-imported Python backend keeps
# serving the *old* code -- a silent stay-on-the-old-version bug. Detection
# is scoped to this exact $APP_DIR (prefix-aware: a --prefix test install
# can never match, let alone touch, a real ~/Applications/Everwatch.app),
# and both the detection and the quit command are overridable
# (EVERWATCH_PGREP_BIN / EVERWATCH_OSASCRIPT_BIN) so tests never run a real
# pgrep/osascript against the user's actual running Everwatch.app (hard
# rule: this script must never touch it for real). Never uses
# `killall`/`pkill` -- only a graceful Apple Event "quit", same as the Quit
# menu item.
# ---------------------------------------------------------------------------
app_is_running() {
  local bin="${EVERWATCH_PGREP_BIN:-pgrep}"
  command -v "$bin" >/dev/null 2>&1 || return 1
  "$bin" -f "$APP_DIR/Everwatch.app/Contents/MacOS/Everwatch" >/dev/null 2>&1
}

quit_running_app() {
  local bin="${EVERWATCH_OSASCRIPT_BIN:-osascript}"
  command -v "$bin" >/dev/null 2>&1 || return 0
  "$bin" -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
}

wait_for_quit() {
  # Overridable so the refuses-to-quit test doesn't have to wait a real
  # ~10s: EVERWATCH_QUIT_POLL_TRIES x EVERWATCH_QUIT_POLL_INTERVAL.
  local tries="${EVERWATCH_QUIT_POLL_TRIES:-20}"
  local interval="${EVERWATCH_QUIT_POLL_INTERVAL:-0.5}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    app_is_running || return 0
    sleep "$interval"
    i=$((i + 1))
  done
  ! app_is_running
}

APP_WAS_RUNNING=0
QUIT_REFUSED=0
if [ "$BROWSER_ONLY" != "1" ] && [ -d "$APP_DIR/Everwatch.app" ] && app_is_running; then
  APP_WAS_RUNNING=1
  info "Quitting Everwatch to update…"
  quit_running_app
  if ! wait_for_quit; then
    QUIT_REFUSED=1
    warn "Everwatch didn't quit in time; continuing the update anyway."
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 (cont'd): install the runtime to $EVERWATCH_HOME/runtime/<ver>,
# with a `current` symlink (docs/DESIGN.md §3.7, §4.1).
# ---------------------------------------------------------------------------
install_runtime() {
  mkdir -p "$RUNTIME_ROOT"
  if [ -n "${EVERWATCH_DEV_LINK:-}" ]; then
    # `make install-dev`: symlink straight to the checkout so edits are
    # picked up without reinstalling (docs/DESIGN.md §7 WP10 row).
    ln -sfn "$RUNTIME_SRC" "$RUNTIME_ROOT/current"
    ok "runtime symlinked to $RUNTIME_SRC (dev mode)"
    return
  fi
  local target="$RUNTIME_ROOT/$RESOLVED_VERSION"
  rm -rf "$target"
  mkdir -p "$target"
  cp -R "$RUNTIME_SRC/everwatch" "$target/everwatch"
  find "$target" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
  [ -f "$RUNTIME_SRC/LICENSE" ] && cp "$RUNTIME_SRC/LICENSE" "$target/LICENSE"
  [ -f "$RUNTIME_SRC/README.md" ] && cp "$RUNTIME_SRC/README.md" "$target/README.md"
  printf '%s\n' "$RESOLVED_VERSION" > "$target/VERSION"
  ln -sfn "$target" "$RUNTIME_ROOT/current"
  ok "runtime $RESOLVED_VERSION installed at $target"
}

install_runtime

# ---------------------------------------------------------------------------
# Step 5: install Everwatch.app, but only if its shell build changed, so a
# runtime-only update leaves the ad-hoc cdhash (and the Automation grant)
# alone (docs/DESIGN.md §4.3). Falls back to building with swiftc, then to
# browser-only mode.
# ---------------------------------------------------------------------------
shell_build_of() {  # $1 = path to an Everwatch.app
  local plist="$1/Contents/Info.plist"
  [ -f "$plist" ] || return 1
  /usr/bin/plutil -extract CFBundleVersion raw -o - "$plist" 2>/dev/null
}

install_app() {
  if [ "$BROWSER_ONLY" = "1" ]; then
    warn "Browser-only mode: no native app will be installed."
    return
  fi

  if { [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; } \
      && command -v swiftc >/dev/null 2>&1 && xcode-select -p >/dev/null 2>&1 \
      && [ -f "$RUNTIME_SRC/scripts/build_app.sh" ]; then
    info "No prebuilt app available; building with swiftc…"
    ( cd "$RUNTIME_SRC" && bash scripts/build_app.sh >/dev/null )
    APP_SRC="$RUNTIME_SRC/build/Everwatch.app"
  fi

  if [ -z "$APP_SRC" ] || [ ! -d "$APP_SRC" ]; then
    warn "Could not obtain Everwatch.app (no prebuilt app, and swiftc/CLT unavailable)."
    BROWSER_ONLY=1
    return
  fi

  local old_build new_build
  old_build="$(shell_build_of "$APP_DIR/Everwatch.app" 2>/dev/null || true)"
  new_build="$(shell_build_of "$APP_SRC" 2>/dev/null || true)"

  if [ -n "$old_build" ] && [ "$old_build" = "$new_build" ] && [ -d "$APP_DIR/Everwatch.app" ]; then
    ok "Everwatch.app is already up to date (shell build $old_build); left in place so the Automation grant survives."
    return
  fi

  mkdir -p "$APP_DIR"
  rm -rf "$APP_DIR/Everwatch.app"
  cp -R "$APP_SRC" "$APP_DIR/Everwatch.app"
  ok "Everwatch.app installed to $APP_DIR"
  if [ -n "$old_build" ] && [ "$old_build" != "$new_build" ]; then
    warn "The app's shell changed (build $old_build -> $new_build): macOS will ask for the Automation permission once more."
  fi
}

install_app

# ---------------------------------------------------------------------------
# Step 6: link ~/.local/bin/everwatch, a tiny wrapper that runs the CLI
# against this install (shell/README.md's runtime resolution).
# ---------------------------------------------------------------------------
install_cli_link() {
  mkdir -p "$BIN_DIR"
  local wrapper="$BIN_DIR/everwatch"
  # --prefix installs must be self-consistent: everwatch/cli.py's
  # uninstall/update/doctor/--version all resolve the app dir and bin dir
  # from EVERWATCH_APP_DIR/EVERWATCH_BIN_DIR (defaulting to the real $HOME
  # otherwise), so a --prefix wrapper that only exported EVERWATCH_HOME left
  # `everwatch uninstall` (etc.) reaching into the real ~/Applications and
  # ~/.local/bin instead of the prefix copies. EVERWATCH_PREFIX lets
  # `everwatch update` forward --prefix back to this same script. Plain
  # (no --prefix) installs skip all three -- those already match $HOME's
  # own defaults, so the wrapper stays exactly what it's always been.
  local prefix_exports=""
  if [ -n "$PREFIX" ]; then
    prefix_exports="export EVERWATCH_APP_DIR=\"$APP_DIR\"
export EVERWATCH_BIN_DIR=\"$BIN_DIR\"
export EVERWATCH_PREFIX=\"$PREFIX\"
"
  fi
  cat > "$wrapper" <<WRAP
#!/usr/bin/env bash
# Generated by install.sh -- runs the everwatch CLI against this install.
export EVERWATCH_HOME="$EVERWATCH_HOME"
${prefix_exports}export PYTHONPATH="$RUNTIME_ROOT/current\${PYTHONPATH:+:\$PYTHONPATH}"
exec "$PYTHON_BIN" -m everwatch "\$@"
WRAP
  chmod +x "$wrapper"
  ok "linked $wrapper"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      warn "$BIN_DIR isn't on your PATH yet. Add this to your shell profile:"
      say "    export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
}

install_cli_link

# ---------------------------------------------------------------------------
# --with-colors: the optional iTerm2 tab-color integration (a private venv
# + `pip install iterm2`, docs/DESIGN.md §3.1 point 5 and everwatch/
# installer.py's ColorsInstaller, whose two commands this mirrors exactly).
# ---------------------------------------------------------------------------
install_colors() {
  [ "$WITH_COLORS" = "1" ] || return 0
  info "Setting up the tab-color integration…"
  local venv="$EVERWATCH_HOME/venv"
  if ! "$PYTHON_BIN" -m venv "$venv"; then
    warn "could not create the venv; tab colors won't be available"
    return
  fi
  if "$venv/bin/python3" -m pip install -q iterm2; then
    ok "tab colors enabled ($venv)"
  else
    warn "pip install iterm2 failed; tab colors won't be available"
  fi
}

install_colors

# ---------------------------------------------------------------------------
# Step 7: what happens next, then the final open prompt.
# ---------------------------------------------------------------------------
print_next_steps() {
  echo
  info "What happens next"
  if [ "$BROWSER_ONLY" = "1" ]; then
    say "Run \"everwatch open\" to use Everwatch in your default browser."
    say "(no menu bar, native notifications, or global hotkey in this mode)"
  else
    say "The first time Everwatch looks at iTerm2, macOS will show:"
    say "    \"Everwatch\" wants to control \"iTerm2\"."
    say "Click OK."
    say ""
    say "(If it instead names \"Python\"/\"python3\" -- unverified on some"
    say " macOS versions, see docs/PERMISSIONS.md -- toggle iTerm2 under"
    say " whichever app name showed, then confirm with \"everwatch doctor\".)"
    say ""
    say "If you click \"Don't Allow\" by mistake, or want to change it later:"
    say "    open \"x-apple.systempreferences:com.apple.preference.security?Privacy_Automation\""
    say "then find Everwatch in that list and turn on iTerm2."
    echo
    say "Start Everwatch any time by running \"everwatch\", or by opening"
    say "Everwatch from Spotlight or Applications."
  fi
  if [ "$PRIOR_INSTALL" = "1" ]; then
    echo
    say "If you still have an \"everwatch open\" or \"everwatch demo\" session"
    say "running in a terminal from before, restart it to pick up this update."
  fi
}

open_everwatch() {
  if [ "$BROWSER_ONLY" = "1" ] || [ ! -d "$APP_DIR/Everwatch.app" ]; then
    say "Run \"$BIN_DIR/everwatch open\" to start Everwatch in your browser."
  else
    open -a "$APP_DIR/Everwatch.app"
  fi
}

# Runs instead of prompt_open() whenever Everwatch was already open when
# this update started (APP_WAS_RUNNING=1): the user already had it running,
# so there's no "open now?" to ask -- just relaunch it (or explain why not)
# so the update visibly takes effect instead of leaving the old instance
# quietly running the old code.
relaunch_after_update() {
  if [ "$QUIT_REFUSED" = "1" ]; then
    warn "Everwatch is still running the old version. Quit it by hand, then"
    warn "run \"everwatch\" (or reopen it from Applications) to start $RESOLVED_VERSION."
    return
  fi
  if [ "$NO_OPEN" = "1" ]; then
    say "Everwatch was updated but not reopened (--no-open). Run \"everwatch\" to start it."
    return
  fi
  if [ "$BROWSER_ONLY" = "1" ] || [ ! -d "$APP_DIR/Everwatch.app" ]; then
    say "Run \"$BIN_DIR/everwatch open\" to start Everwatch in your browser."
    return
  fi
  info "Relaunching Everwatch ${RESOLVED_VERSION}…"
  open -a "$APP_DIR/Everwatch.app"
  ok "Everwatch $RESOLVED_VERSION is running."
}

# Overridable so tests can simulate "no terminal at all" (a path that can
# never be opened, e.g. /nonexistent) or a fake, already-fed terminal
# (a plain file works fine for this: only its *existence and openability*
# matter for the gate below; a real prompt only ever reads from it, never
# writes to it, so a plain file's contents survive intact) without needing
# a real pty. Defaults to the real controlling terminal.
EVERWATCH_TTY="${EVERWATCH_TTY:-/dev/tty}"

prompt_open() {
  [ "$NO_OPEN" = "1" ] && return
  # Whether a real terminal is attached at all -- true even under the
  # piped one-liner (`curl ... | bash`), whose own stdin is the pipe, not
  # a terminal, but which still has one iff it was itself typed at an
  # interactive shell. False under cron/launchd/CI, where there's no
  # controlling terminal to open /dev/tty against at all -- and that
  # stays true even with --yes (usage()'s promise above).
  if ! : 2>/dev/null <"$EVERWATCH_TTY"; then
    return
  fi
  if [ "$ASSUME_YES" = "1" ]; then
    open_everwatch
    return
  fi
  printf 'Open Everwatch now? [Y/n] '
  local reply=""
  IFS= read -r reply 2>/dev/null <"$EVERWATCH_TTY" || reply=""
  case "$reply" in
    [nN]*) ;;
    *) open_everwatch ;;
  esac
}

print_next_steps
if [ "$APP_WAS_RUNNING" = "1" ]; then
  relaunch_after_update
else
  prompt_open
fi
