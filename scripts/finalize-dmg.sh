#!/bin/bash
# finalize-dmg.sh — post-build DMG window polish that tauri.conf can't express.
#
# Tauri's dmg config has no icon-size option, so this script re-opens the
# freshly bundled dmg and sets a 128px icon size (plus re-asserting the two
# icon positions) via Finder. The double open/close cycle is REQUIRED on
# macOS Tahoe: Finder only flushes icon-view options to the volume's
# .DS_Store on the second cycle (learned the hard way across four releases
# of background-image repair — see the project memory on dmg flakiness).
#
# The former custom background image was dropped deliberately (2026-07-17):
# it needed a manual repair on every single release. Plain window + big
# icons is the stable design.
#
# Usage: bash scripts/finalize-dmg.sh   (after `npm run tauri build`)
set -euo pipefail

DMG_DIR="$(cd "$(dirname "$0")/.." && pwd)/src-tauri/target/release/bundle/dmg"
DMG="$(ls -t "$DMG_DIR"/semantic-zoom_*.dmg 2>/dev/null | head -1)"
[ -n "$DMG" ] || { echo "finalize-dmg: no dmg found in $DMG_DIR" >&2; exit 1; }
echo "finalize-dmg: $DMG"

cd "$DMG_DIR"
rm -f rw-finalize.dmg
hdiutil convert "$DMG" -format UDRW -o rw-finalize.dmg -quiet
MOUNT="$(hdiutil attach rw-finalize.dmg -nobrowse | grep Volumes | awk -F'\t' '{print $NF}')"
VOLNAME="$(basename "$MOUNT")"

osascript <<EOF
tell application "Finder"
  tell disk "$VOLNAME"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {200, 200, 860, 600}
    set opts to icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set position of item "semantic-zoom.app" of container window to {180, 170}
    set position of item "Applications" of container window to {480, 170}
    delay 2
    close
    delay 3
    open
    delay 2
    close
    delay 4
  end tell
end tell
EOF

# Read-back verification. Background-picture reads throw AppleEvent -10000
# on Tahoe, but scalar icon-view reads have been reliable; if this ever
# starts throwing too, fail loudly rather than shipping unverified.
SIZE="$(osascript -e "tell application \"Finder\" to get icon size of icon view options of container window of disk \"$VOLNAME\"")"
if [ "$SIZE" != "128" ]; then
  echo "finalize-dmg: icon size read back as '$SIZE', expected 128" >&2
  hdiutil detach "$MOUNT" -quiet || true
  exit 1
fi
echo "finalize-dmg: icon size verified at 128"

hdiutil detach "$MOUNT" -quiet
rm "$DMG"
hdiutil convert rw-finalize.dmg -format UDZO -imagekey zlib-level=9 -o "$DMG" -quiet
rm rw-finalize.dmg
echo "finalize-dmg: done — $DMG"
