#!/usr/bin/env bash
# Generate shell/AppIcon.icns headlessly: render PNGs with CoreGraphics
# (scripts/make_icon.swift), then pack them with iconutil. No GUI apps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OBJ="$ROOT/build/obj"
ICONSET="$OBJ/AppIcon.iconset"
OUT="$ROOT/shell/AppIcon.icns"

mkdir -p "$OBJ"
rm -rf "$ICONSET"
swiftc -O -module-cache-path "$OBJ/module-cache" "$ROOT/scripts/make_icon.swift" -o "$OBJ/make_icon"
"$OBJ/make_icon" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$OUT"
echo "wrote $OUT"

# README header image: the 128px render, kept in sync with the icon.
cp "$ICONSET/icon_128x128.png" "$ROOT/docs/logo.png"
echo "wrote $ROOT/docs/logo.png"
