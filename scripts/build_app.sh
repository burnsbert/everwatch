#!/usr/bin/env bash
# Build the Everwatch.app shell with swiftc (no SwiftPM; see docs/DESIGN.md §5.4).
#
#   scripts/build_app.sh             release: universal (arm64 + x86_64), -O, ad-hoc signed
#   scripts/build_app.sh --dev       native arch only, debug, ad-hoc signed (fast)
#   scripts/build_app.sh --tests     build/shell-tests (Swift Testing over Sources/Core and
#                                    App/SilentResponders.swift, App/StatusGlyph.swift) plus a
#                                    native compile check of Sources/App (never launched)
#   scripts/build_app.sh --coverage  build instrumented tests, run them, print Core line coverage
#
# Output: build/Everwatch.app, build/shell-tests. Nothing here launches the app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_DIR="$ROOT/shell"
BUILD="$ROOT/build"
OBJ="$BUILD/obj"
BUNDLE_ID="io.github.burnsbert.everwatch"
MIN_MACOS="13.0"

MODE="release"
case "${1:-}" in
  "" ) ;;
  --release ) MODE="release" ;;
  --dev ) MODE="dev" ;;
  --tests ) MODE="tests" ;;
  --coverage ) MODE="coverage" ;;
  -h|--help ) sed -n '2,11p' "$0"; exit 0 ;;
  * ) echo "unknown option: $1" >&2; exit 2 ;;
esac

command -v swiftc >/dev/null || { echo "swiftc not found; install the Command Line Tools: xcode-select --install" >&2; exit 1; }

CORE_SOURCES=("$SHELL_DIR"/Sources/Core/*.swift)
APP_SOURCES=("$SHELL_DIR"/Sources/App/*.swift)
TEST_SOURCES=("$SHELL_DIR"/Tests/*.swift)
# App files the tests also compile. SilentResponders.swift is only
# inspected (runtime method lookup), never instantiated. StatusGlyph.swift
# is a pure drawing helper (no windows), so its tests call it directly.
TESTED_APP_SOURCES=("$SHELL_DIR"/Sources/App/SilentResponders.swift "$SHELL_DIR"/Sources/App/StatusGlyph.swift)
SWIFT_FLAGS=(-swift-version 5)

mkdir -p "$BUILD" "$OBJ"

# --- Swift Testing via swiftc (CLT has Testing.framework but no XCTest) -------
DEV_DIR="$(xcode-select -p 2>/dev/null || true)"
TEST_FW="$DEV_DIR/Library/Developer/Frameworks"
TEST_LIB="$DEV_DIR/Library/Developer/usr/lib"
TEST_PLUGINS="$DEV_DIR/usr/lib/swift/host/plugins/testing"

check_testing() {
  if [[ ! -d "$TEST_FW/Testing.framework" ]]; then
    echo "Testing.framework not found under $TEST_FW." >&2
    echo "Swift tests need the Command Line Tools' Swift Testing (see docs/DESIGN.md §5.4)." >&2
    exit 3
  fi
  # The runner uses Testing.__swiftPMEntryPoint (underscored SPI). Fail clearly if it disappears.
  if ! grep -qs "__swiftPMEntryPoint" "$TEST_FW"/Testing.framework/Modules/Testing.swiftmodule/*.swiftinterface; then
    echo "Testing.__swiftPMEntryPoint not found in this toolchain's Testing module;" >&2
    echo "shell/Tests/Runner.swift needs updating for this toolchain (docs/DESIGN.md §8)." >&2
    exit 3
  fi
}

build_tests() {  # $1 = output path, remaining = extra swiftc flags
  local out="$1"; shift
  check_testing
  swiftc "${SWIFT_FLAGS[@]}" -parse-as-library -Onone "$@" \
    -F "$TEST_FW" -I "$TEST_FW" -plugin-path "$TEST_PLUGINS" \
    -Xlinker -rpath -Xlinker "$TEST_FW" -Xlinker -rpath -Xlinker "$TEST_LIB" \
    -framework Testing \
    -module-cache-path "$OBJ/module-cache" \
    "${CORE_SOURCES[@]}" "${TESTED_APP_SOURCES[@]}" "${TEST_SOURCES[@]}" -o "$out"
}

compile_app() {  # $1 = target triple ("" = native), $2 = output, $3.. = extra flags
  local target="$1" out="$2"; shift 2
  local target_flags=()
  [[ -n "$target" ]] && target_flags=(-target "$target")
  swiftc "${SWIFT_FLAGS[@]}" ${target_flags[@]+"${target_flags[@]}"} "$@" \
    -module-name Everwatch -module-cache-path "$OBJ/module-cache" \
    "${CORE_SOURCES[@]}" "${APP_SOURCES[@]}" -o "$out"
}

if [[ "$MODE" == "tests" ]]; then
  echo "==> building build/shell-tests"
  build_tests "$BUILD/shell-tests"
  echo "==> compile check: Sources/App (native, not bundled, not launched)"
  compile_app "" "$OBJ/Everwatch-check" -Onone
  echo "built $BUILD/shell-tests (run it: build/shell-tests)"
  exit 0
fi

if [[ "$MODE" == "coverage" ]]; then
  LLVM_PROFDATA="$(xcrun --find llvm-profdata)"
  LLVM_COV="$(xcrun --find llvm-cov)"
  COV="$BUILD/coverage"
  rm -rf "$COV"; mkdir -p "$COV"
  echo "==> building instrumented tests"
  build_tests "$COV/shell-tests-cov" -profile-generate -profile-coverage-mapping
  echo "==> running instrumented tests"
  EVERWATCH_NO_SOUND=1 LLVM_PROFILE_FILE="$COV/tests.profraw" "$COV/shell-tests-cov" > "$COV/test-output.txt" 2>&1 \
    || { tail -20 "$COV/test-output.txt"; echo "tests failed" >&2; exit 1; }
  tail -1 "$COV/test-output.txt"
  "$LLVM_PROFDATA" merge -sparse "$COV/tests.profraw" -o "$COV/tests.profdata"
  "$LLVM_COV" report "$COV/shell-tests-cov" -instr-profile="$COV/tests.profdata" "${CORE_SOURCES[@]}"
  exit 0
fi

# --- App bundle ---------------------------------------------------------------
ICON="$SHELL_DIR/AppIcon.icns"
if [[ ! -f "$ICON" ]]; then
  echo "==> generating app icon"
  "$ROOT/scripts/make_icon.sh"
fi

APP="$BUILD/Everwatch.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

if [[ "$MODE" == "release" ]]; then
  echo "==> compiling arm64"
  compile_app "arm64-apple-macos$MIN_MACOS" "$OBJ/Everwatch-arm64" -O
  echo "==> compiling x86_64"
  compile_app "x86_64-apple-macos$MIN_MACOS" "$OBJ/Everwatch-x86_64" -O
  lipo -create "$OBJ/Everwatch-arm64" "$OBJ/Everwatch-x86_64" -output "$APP/Contents/MacOS/Everwatch"
else
  echo "==> compiling native (dev)"
  compile_app "$(uname -m)-apple-macos$MIN_MACOS" "$OBJ/Everwatch-dev" -Onone -g
  cp "$OBJ/Everwatch-dev" "$APP/Contents/MacOS/Everwatch"
fi

cp "$SHELL_DIR/Info.plist" "$APP/Contents/Info.plist"
cp "$ICON" "$APP/Contents/Resources/AppIcon.icns"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
echo "built $APP ($MODE)"
