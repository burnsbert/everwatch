#!/usr/bin/env bash
# Build release artifacts into dist/ (docs/DESIGN.md §4.1, §7 WP10 row).
#
#   scripts/release.sh [VERSION]
#
# Builds:
#   dist/everwatch-<ver>.tar.gz   runtime: everwatch/ (incl. web assets),
#                                 LICENSE, README.md (if present), install.sh
#   dist/Everwatch-<ver>.zip      universal, ad-hoc-signed Everwatch.app
#                                 (ditto -c -k --keepParent, so it unzips
#                                 back to a plain Everwatch.app)
#   dist/SHA256SUMS               sha256 of both archives
#
# This script NEVER publishes anything. It only builds, and prints the
# `gh release create` command a maintainer would run to publish it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
REPO="burnsbert/everwatch"

VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  VERSION="$("${PYTHON:-python3}" -c \
    "import sys; sys.path.insert(0, '$ROOT'); import everwatch; print(everwatch.__version__)")"
fi

echo "==> releasing everwatch $VERSION"
rm -rf "$DIST"
mkdir -p "$DIST"

# --- runtime tarball ---------------------------------------------------------
STAGE="$ROOT/build/release-stage"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/everwatch" "$STAGE/everwatch"
find "$STAGE/everwatch" -name '__pycache__' -type d -exec rm -rf {} + 2>/dev/null || true
cp "$ROOT/LICENSE" "$STAGE/LICENSE"
cp "$ROOT/install.sh" "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"
printf '%s\n' "$VERSION" > "$STAGE/VERSION"
if [ -f "$ROOT/README.md" ]; then
  cp "$ROOT/README.md" "$STAGE/README.md"
fi

TARBALL="$DIST/everwatch-$VERSION.tar.gz"
STAGE_ITEMS="everwatch LICENSE install.sh VERSION"
[ -f "$STAGE/README.md" ] && STAGE_ITEMS="$STAGE_ITEMS README.md"
( cd "$STAGE" && tar -czf "$TARBALL" $STAGE_ITEMS )
echo "built $TARBALL"

# --- universal ad-hoc-signed app zip -----------------------------------------
echo "==> building Everwatch.app"
"$ROOT/scripts/build_app.sh"
ZIP="$DIST/Everwatch-$VERSION.zip"
( cd "$ROOT/build" && ditto -c -k --keepParent Everwatch.app "$ZIP" )
echo "built $ZIP"

# --- checksums ----------------------------------------------------------------
( cd "$DIST" && shasum -a 256 "$(basename "$TARBALL")" "$(basename "$ZIP")" > SHA256SUMS )
echo "built $DIST/SHA256SUMS"

echo
echo "==> Nothing was published. To publish this release, run:"
echo "gh release create v$VERSION \\"
echo "    \"$TARBALL\" \"$ZIP\" \"$DIST/SHA256SUMS\" \\"
echo "    --repo $REPO --title \"Everwatch $VERSION\" --notes \"See docs/DESIGN.md\""
