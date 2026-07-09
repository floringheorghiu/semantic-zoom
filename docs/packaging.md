# Packaging (macOS, Phase 1)

Build the app and disk image:

```bash
npm run dmg     # = CI=true tauri build
```

Output: `src-tauri/target/release/bundle/dmg/semantic-zoom_<version>_aarch64.dmg`
(and the `.app` under `.../bundle/macos/`). Ad-hoc signing is acceptable for
Phase 1.

## Why `npm run dmg` instead of `npm run tauri build`

Tauri's `bundle_dmg.sh` runs a Finder-prettifying **AppleScript** (`osascript`
→ `tell application "Finder"`) to lay out the disk-image window (icon positions,
background). That step:

- requires a logged-in GUI session **and** Automation permission for the
  invoking terminal to control Finder (System Settings → Privacy & Security →
  Automation), and
- runs under `set -e`, so if it fails the whole `tauri build` aborts with
  `error running bundle_dmg.sh` **after** the `.app` has already built.

Setting `CI=true` makes Tauri skip that cosmetic AppleScript. The produced DMG
is functionally identical for installation — it contains `semantic-zoom.app`
and the `Applications` drag-target symlink — it just isn't given a custom window
background/icon layout. `hdiutil verify` passes.

If a previous failed run left a volume mounted, detach it before retrying:

```bash
hdiutil detach /Volumes/semantic-zoom -force
rm -f src-tauri/target/release/bundle/macos/rw.*.dmg
```

## Optional: the styled DMG

If you want the custom window layout, run `npm run tauri build` from a normal
desktop Terminal and grant it Automation control of Finder when macOS prompts
(or pre-grant it under Privacy & Security → Automation → Terminal → Finder).
