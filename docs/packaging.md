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

Layout itself (background image + icon positions) is declarative —
`bundle.macOS.dmg` in `tauri.conf.json`:

```json
"dmg": {
  "background": "dmg-background.png",
  "windowSize": { "width": 660, "height": 400 },
  "appPosition": { "x": 180, "y": 170 },
  "applicationFolderPosition": { "x": 480, "y": 170 }
}
```

`background` is relative to `src-tauri/`. Provide the image at 2x the window
size (1320×800 here) so it's crisp on retina displays — Finder scales it down
to `windowSize`.

**`.VolumeIcon.icns` hiding and the AppleScript step are the same fix.**
`bundle_dmg.sh` copies the volume icon unconditionally whenever `icon` is set,
but never explicitly marks it invisible — only the AppleScript pass does that
(as part of its `HIDING_CLAUSE`). Skip the AppleScript (`npm run dmg`,
`CI=true`) and the `.icns` sits there as a plain visible file in the installer
window; run the full `npm run tauri build` and it's correctly hidden.

**Known-unverified on this dev machine (macOS "26" / Darwin 25.5.0):** the
AppleScript pass successfully creates `.DS_Store` + copies the background PNG
into `.background/`, and icon POSITIONS land exactly where configured — but
the background picture itself did not visually render in Finder during
testing, even after ruling out stale per-volume Finder view-state caching
(this session had accumulated 8 stray mounts of a volume all named
`semantic-zoom`; detaching all of them, restarting Finder, and mounting fresh
didn't change the result). Whether this is an OS-version-specific
Finder/AppleScript incompatibility (this technique — `create-dmg`'s
`bundle_dmg.sh`, vendored by Tauri — predates recent macOS releases) or
something else wasn't isolated further. If you hit the same thing, that's the
starting point — the config and generated asset are confirmed correct, so
look at the AppleScript's background-setting step specifically
(`template.applescript` inside the vendored `bundle_dmg.sh`).
