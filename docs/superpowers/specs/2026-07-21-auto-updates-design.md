# Auto-Updates & Support Link — Design

Date: 2026-07-21. Status: approved in brainstorm session "Semantic Zoom - Updates tab".

## Purpose

Give the app a real, working auto-updater instead of the current fully
manual DMG build/share process. Surface it in three places: a Sparkle-style
"update available" dialog (release notes, Skip/Remind-Later/Install) shown
on both manual and automatic checks, a new **Updates** tab in Settings
(version, changelog, manual check, auto-update toggles, "Buy Me a Coffee"
support link), and a lightweight notice on the empty-state screen when an
update is already known to be available.

## Current state (why this is greenfield)

- No updater plugin anywhere: not in `src-tauri/Cargo.toml`, not in
  `package.json`, no `updater` block in `tauri.conf.json`.
- No `.github/` directory — no CI, no release automation. Releases today
  are built by hand via `npm run build:dmg`.
- No signing keys, no `CHANGELOG.md`.
- App version lives in `package.json` (`0.8.0`, mirrored in
  `tauri.conf.json`) and is injected into the frontend at build time via
  Vite's `define: { __APP_VERSION__ }`. `src-tauri/Cargo.toml`'s crate
  version (`0.1.0`) is a separate, currently-unsynced number — irrelevant
  to the updater (it doesn't read the crate version), left alone here.
- Settings tabs follow an established pattern: `data-tab` button +
  `data-tab` section in `settings.html`, generic show/hide in
  `src/native/settings/tabs.ts`, and a co-located `init*Tab()` module per
  tab (`general-tab.ts`, `inference-tab.ts`, `prompt-tab.ts`) wired from
  `src/native/settings-form.ts`. A new `updates-tab.ts` follows this shape
  exactly.
- Settings persistence for provider/prompt config already goes through a
  Rust-owned JSON file (`ConfigStore` in `src-tauri/src/commands/
  provider_config.rs`) with a precedent for adding a new sub-structure
  (`prompt_templates`) plus matching `get_*`/`set_*` commands. New update
  preferences follow the same mechanical pattern.
- The empty-state screen (`src/ui/empty-state.ts`) is Tauri-free and
  store-free by design — `main.ts` drives it imperatively. It already
  threads an optional `version` prop into its footer, and its
  `EmptyStateOptions` interface has a documented precedent for additive
  optional fields. No existing modal/dialog UI component exists in the
  main window yet — the update-found dialog is a new pattern, though
  `tauri-plugin-dialog` is already installed for the simpler native
  restart-confirmation prompt.

## Update engine — `tauri-plugin-updater`

Add the Rust crate (`tauri-plugin-updater`) and its JS binding
(`@tauri-apps/plugin-updater`). Register the plugin in `src-tauri/src/
lib.rs` alongside the existing plugin registrations, and add a
`plugin.updater` block to `tauri.conf.json`:

- `endpoints`: `["https://github.com/floringheorghiu/semantic-zoom/releases/latest/download/latest.json"]`
- `pubkey`: the public half of a signing keypair generated once via
  `tauri signer generate` (private key + password become GitHub Actions
  secrets, never committed; public key is safe to commit).

Grant the updater plugin's permissions in the main window's capabilities
file (parallel to the existing `src-tauri/capabilities/settings.json`
pattern), since both the Updates tab (settings webview) and the main
window (update dialog + empty-state banner) need to call it.

## Release pipeline — GitHub Actions

New `.github/workflows/release.yml`, triggered on push of a `v*` tag:

1. Build the DMG (reuse `npm run build:dmg`).
2. Sign the update artifact with `tauri signer sign`, using the private
   key + password secrets.
3. Generate `latest.json` (version, pub date, release notes, per-platform
   download URL + signature).
4. Publish the signed DMG and `latest.json` to a GitHub Release for that
   tag (create the release if it doesn't exist, or attach to one already
   drafted).

This becomes the new "how do I ship a release" path. Cutting a release is:
bump `package.json`/`tauri.conf.json` version, tag, push tag, let the
workflow do the rest.

## Settings persistence — two booleans plus a skipped version

Add an `UpdatePrefs` struct to `ConfigStore` in `provider_config.rs`,
`#[serde(default)]` so existing config files deserialize cleanly:

```
update_prefs: {
  auto_check: bool,               // default true
  auto_install: bool,             // default true
  skipped_version: Option<string> // default None
}
```

`skipped_version` is written by the update-found dialog's "Skip This
Version" action and read by the automatic-check path (see below). Add
`get_update_prefs` / `set_update_prefs` `#[tauri::command]` functions
mirroring `get_prompt_templates` / `set_prompt_templates`, registered in
`src-tauri/src/lib.rs`'s `invoke_handler`.

## The update-found dialog

Reference: macOS Sparkle-style "Software Update" dialogs (e.g. Typora's) —
app icon, "A new version of X is available!" headline, current vs.
available version line, a scrollable release-notes panel (can show more
than just the latest version's notes), an "Automatically download and
install updates in the future" checkbox, and three actions: **Skip This
Version**, **Remind Me Later**, **Install Update**.

Implemented as a new `src/ui/update-dialog.ts` module (native `<dialog>`
element in the main window, Tauri-free/store-free like `empty-state.ts` —
`main.ts` drives it imperatively with the check result and prefs), plus
`src/styles/update-dialog.css`. Not a new Tauri window — an in-page modal
overlay, consistent with the app's existing "one main webview, one
settings webview" split.

- **Shown by**: both the Updates tab's "Check for Updates now" button and
  an automatic background `check()` (startup + periodic), whenever an
  update is found — this is the single, unified "update found" UI; the
  Updates tab's check button no longer shows its own inline result.
- **Release notes**: every GitHub release between the installed version
  and the latest (fetched via the GitHub REST API), each rendered under
  its own version heading, matching the reference's stacked-notes layout.
- **The checkbox** is two-way bound to the same `auto_install` pref shown
  in the Updates tab — checking it here updates the same stored value.
- **Skip This Version** — persists `skipped_version` = the latest
  version's tag via `set_update_prefs`, closes the dialog. An automatic
  check that finds this exact version again will not reopen the dialog.
  A manual "Check for Updates now" always shows the dialog regardless of
  `skipped_version` — skipping only silences unattended nagging, it never
  hides the update from someone who explicitly asks.
- **Remind Me Later** — closes the dialog with no persisted state change;
  the next check (automatic or manual) prompts again normally.
- **Install Update** — downloads and installs via the updater plugin, then
  uses `tauri-plugin-dialog` for the final native restart-confirmation
  prompt once the install completes.

### Download progress

Reference: Typora's "Updating X" progress dialog — same window, header
switches to "Updating Semantic Zoom", app icon stays, release notes swap
out for a "Downloading update…" label, a determinate progress bar, a
byte-count line ("11.0 MB of 14.4 MB"), and a **Cancel** button in place
of the three prior actions.

The updater plugin's `downloadAndInstall()` takes a progress callback
firing `Started` (total `contentLength`), `Progress` (per-chunk bytes),
and `Finished` events — enough to drive the bar and byte-count text
directly, no polling needed. **Cancel** dismisses the dialog and abandons
the in-flight download; the plugin has no partial-resume, so a cancelled
download simply starts over in full on the next attempt (manual recheck,
or the next automatic check picking the same version back up). Reusing
one dialog element for both the found-update and downloading states keeps
this a single continuous piece of UI rather than a hand-off between two.

## Updates tab (Settings window)

New `data-tab="updates"` button + `section[data-tab="updates"]` in
`settings.html`, new `src/native/settings/updates-tab.ts` (+
`updates-tab.test.ts`) wired from `settings-form.ts`, following
`inference-tab.ts`'s shape. Contents:

- **Current version** — read via `getVersion()` from `@tauri-apps/api/app`.
- **Toggles** (labels/hint per the approved microcopy):
  - "Automatically check for updates." — gates whether the app runs a
    background `check()` on startup / periodically.
  - "Automatically download and install updates." — same stored value as
    the update-found dialog's checkbox; gates whether a found update
    installs itself in the background once auto-check finds one, versus
    only surfacing the dialog/banner for the user to trigger manually.
  - Hint: "The updates are downloaded in the background. The app will ask
    to restart to apply the update."
- **"Check for Updates now"** button — calls the updater plugin's
  `check()`; if an update is found, opens the same update-found dialog
  described above (ignoring `skipped_version`, per the rule above); if not,
  shows a brief inline "You're up to date" state.
- **Changelog** — fetched at runtime from the latest GitHub release's
  notes body via the GitHub REST API (`GET /repos/floringheorghiu/
  semantic-zoom/releases/latest`), rendered as plain text/light markdown.
  No maintained `CHANGELOG.md` — the release notes written when cutting a
  release are the single source.
- **Support section** — "Buy Me a Coffee" block linking to
  `https://buymeacoffee.com/fgheorghiu`, with copy adapted from the
  approved example ("We're now accepting support via Buy Me a Coffee —
  your one-time or recurring contribution helps keep this project going.
  If you're able, we'd appreciate it.").

## Empty-state banner (Feature B)

Extend `EmptyStateOptions` with an optional field:

```
updateAvailable?: { version: string; onOpenDialog: () => void }
```

Rendered as a small, passive banner near the existing version chip in the
footer, with an "Update" button, following the same additive-optional-
field precedent already used for `onClearRecent`/`version`. The banner is
secondary to the dialog: it never installs directly — clicking it just
opens the same update-found dialog, so there's one install path in the
whole app, not two.

`main.ts` runs a background `check()` on startup (gated by the
`auto_check` pref) before mounting the empty state. If an update is found
and isn't the user's `skipped_version`, the dialog opens immediately
(unattended-friendly per the auto-install pref) and `updateAvailable` is
also passed to the empty state so the banner is present if the dialog gets
dismissed via Remind Me Later.

## Toggle defaults & behavior summary

Both toggles default **on**: the app checks for updates automatically and,
once found (and not the skipped version), shows the update-found dialog —
installing automatically in the background if "auto-install" is on, only
ever interrupting the user to ask for a restart once ready. Turning off
"automatically download and install" still checks and shows the dialog on
find, but leaves the actual install to the user clicking "Install Update".
Turning off "automatically check" as well makes update discovery fully
manual via "Check for Updates now" (which always shows the dialog on
find, ignoring any previously skipped version).

## Delivery — two PRs

1. **Update engine + release pipeline** — updater plugin, signing keys,
   `tauri.conf.json` config, capabilities grant, GitHub Actions workflow.
   No user-visible UI yet; verified by cutting a real tagged release and
   confirming `latest.json` publishes correctly.
2. **Updates tab + update-found dialog + empty-state banner** — settings
   persistence (`UpdatePrefs` + commands), the update-dialog module, Updates
   tab UI, empty-state banner, wiring `main.ts`'s startup check. Ends with
   the user's manual WebKit pass (background sessions cannot run it), per
   standing practice.

<!-- semantic-zoom:payload:v1
{"version":1,"docHash":"ba2f14e87e822ed5406ff81befc5f363892ad69672e7b7b74dd818c44934f5d2","meta":{"M1":{"id":"M1","level":-2,"title":"A real auto-updater, a native-feeling update dialog, and a way to say thanks","body":"**Accomplished:**\n- A ratified design for turning the app's manual DMG-sharing process into a real, signed auto-updater built on Tauri's official updater plugin and a GitHub Actions release pipeline.\n- After seeing a reference screenshot of Typora's native-style update dialogs, the design grew a proper Sparkle-style \"update found\" dialog (release notes, Skip/Remind-Later/Install) and a matching download-progress view, both shown on manual and automatic checks alike, replacing the earlier plan of just an inline result and a passive banner.\n- Three touchpoints total: the update-found/progress dialog, an Updates tab in Settings (version, changelog, check-now button, auto-update toggles, and a Buy Me a Coffee link), and a small passive \"update available\" banner on the empty-state screen that opens the same dialog.\n\n**Blockers:**\n- None noted — this is greenfield infrastructure (no updater plugin, no CI, no signing keys exist yet), so there's nothing to untangle, only to build.\n\n**Next steps:**\n- Ship it as two independent pull requests: first the invisible plumbing (updater plugin, signing keys, release workflow), verified by actually cutting a release; then the user-facing pieces (update dialog with progress view, Updates tab, empty-state banner, and the persisted preferences behind them).","children":["S-eaeded3f-0","S-90fb9302-0","S-473002bd-0","S-1046e603-0","S-5a065364-0","S-dd7eff10-0","S-fded9a9d-0","S-3e809dc0-0","S-d410ae37-0","S-694f1b7b-0","S-fddfdb6d-0"]}},"sections":{"S-eaeded3f-0":{"id":"S-eaeded3f-0","level":-1,"parent":"M1","children":["P-eaeded3f-0","P-effba803-0","P-b8abb050-0","P-6152ea14-0"],"title":"What this design is for","body":"Right now, shipping a new build means manually making a DMG and sharing it by hand. This design replaces that with a proper self-updating app, surfaced through a real update dialog, a settings tab, and a quiet reminder on the welcome screen — plus a way for people to support the project financially."},"S-90fb9302-0":{"id":"S-90fb9302-0","level":-1,"parent":"M1","children":["P-90fb9302-0","P-cec3592f-0"],"title":"Starting from nothing — and what already fits the shape","body":"None of the update machinery exists yet: no updater plugin, no automated release process, no signing keys, no changelog file, and no modal-dialog pattern in the main window. But the surrounding app already has the right shapes to build on — a settings-tab pattern that's trivial to extend, a settings-storage precedent for adding new preferences, and an empty-state screen already designed to grow new optional pieces without breaking anything."},"S-473002bd-0":{"id":"S-473002bd-0","level":-1,"parent":"M1","children":["P-473002bd-0","P-e56f262d-0","P-4c4087f8-0","P-59e2dcb0-0"],"title":"The engine that checks for and installs updates","body":"The app gains Tauri's official updater plugin, told where to look for new versions (a file GitHub publishes with each release) and given a public key so it can verify that what it downloads was really signed by the developer, not tampered with."},"S-1046e603-0":{"id":"S-1046e603-0","level":-1,"parent":"M1","children":["P-1046e603-0","P-2e4b8866-0","P-9fe44532-0","P-6ebd8222-0"],"title":"How a new version actually gets published","body":"Publishing a release becomes automatic: pushing a version tag triggers a workflow that builds the app, signs it, writes a small manifest describing the new version, and uploads everything to a GitHub release. From then on, cutting a release is just a version bump and a tag push."},"S-5a065364-0":{"id":"S-5a065364-0","level":-1,"parent":"M1","children":["P-5a065364-0","P-92e17d72-0","P-692d2577-0","P-dbd1c16e-0"],"title":"Remembering the user's update preferences","body":"Three things get saved the same way the app already saves its other settings: whether to check for updates automatically, whether to install them automatically once found, and — new after seeing the dialog reference — which version (if any) the user chose to skip, so a dismissed update doesn't keep nagging."},"S-dd7eff10-0":{"id":"S-dd7eff10-0","level":-1,"parent":"M1","children":["P-dd7eff10-0","P-ebd2f6fe-0","P-0999f9ed-0","P-5917cf60-0"],"title":"The update-found dialog, styled after familiar Mac apps","body":"Inspired by a screenshot of Typora's own update prompt, this is a proper native-feeling dialog: app icon, headline, version comparison, scrollable release notes for every version between what's installed and what's newest, an auto-install checkbox, and three choices — skip this version for good, be reminded later, or install now. It's the single place this whole feature funnels through, whether the check was manual or automatic."},"S-fded9a9d-0":{"id":"S-fded9a9d-0","level":-1,"parent":"M1","children":["P-fded9a9d-0","P-514f0664-0","P-2b9c838c-0"],"title":"Watching the update download","body":"Once someone clicks Install, the same dialog window switches to a download view — again modeled on a real reference screenshot — swapping the release notes for a progress bar and a running byte count, with a Cancel button in case someone changes their mind. Cancelling just means starting the download over next time; there's no partial-resume to build."},"S-3e809dc0-0":{"id":"S-3e809dc0-0","level":-1,"parent":"M1","children":["P-3e809dc0-0","P-1d70d2d2-0","P-3bf140ce-0"],"title":"The new Updates tab in Settings","body":"A new tab shows the app's current version, the two auto-update toggles with explanatory hint text, a button to check for updates right now (which opens the same dialog described above if something's found), the release notes for the latest version pulled live from GitHub, and a short note pointing people to Buy Me a Coffee if they'd like to support the project."},"S-d410ae37-0":{"id":"S-d410ae37-0","level":-1,"parent":"M1","children":["P-d410ae37-0","P-92b487d7-0","P-fd7703ce-0","P-66174d10-0","P-a5181812-0"],"title":"Letting people know from the empty-state screen","body":"When no document is open, the app already shows a simple welcome screen with its version number in the corner. This design adds a small, low-key banner there when an update has already been found, with a button that opens the same dialog rather than installing on its own — so there's only ever one path to actually installing an update."},"S-694f1b7b-0":{"id":"S-694f1b7b-0","level":-1,"parent":"M1","children":["P-694f1b7b-0","P-897ee770-0"],"title":"What happens by default, and what turning things off changes","body":"Out of the box, the app quietly checks for and installs updates on its own, only interrupting to ask for a restart once one's ready. Turning off auto-install still shows the dialog but leaves installing to a manual click; turning off auto-check as well makes the whole thing fully manual, though a manual check always shows the dialog even for a version someone previously chose to skip."},"S-fddfdb6d-0":{"id":"S-fddfdb6d-0","level":-1,"parent":"M1","children":["P-fddfdb6d-0","P-523a9ab7-0"],"title":"Shipping it in two pieces","body":"The invisible plumbing — the updater plugin, signing, and release automation — ships first and gets proven by actually cutting a real release. The visible half — the update-found dialog with its progress view, the Updates tab, and the empty-state banner — follows once that foundation is confirmed working."}},"paragraphs":{"P-eaeded3f-0":{"id":"P-eaeded3f-0","level":0,"parent":"S-eaeded3f-0","kind":"heading","span":{"start":0,"end":40},"html":"<h1>Auto-Updates &amp; Support Link — Design</h1>"},"P-effba803-0":{"id":"P-effba803-0","level":0,"parent":"S-eaeded3f-0","kind":"prose","span":{"start":42,"end":129},"html":"<p>Date: 2026-07-21. Status: approved in brainstorm session &quot;Semantic Zoom - Updates tab&quot;.</p>"},"P-b8abb050-0":{"id":"P-b8abb050-0","level":0,"parent":"S-eaeded3f-0","kind":"heading","span":{"start":131,"end":141},"html":"<h2>Purpose</h2>"},"P-6152ea14-0":{"id":"P-6152ea14-0","level":0,"parent":"S-eaeded3f-0","kind":"prose","span":{"start":143,"end":624},"html":"<p>Give the app a real, working auto-updater instead of the current fully\nmanual DMG build/share process. Surface it in three places: a Sparkle-style\n&quot;update available&quot; dialog (release notes, Skip/Remind-Later/Install) shown\non both manual and automatic checks, a new <strong>Updates</strong> tab in Settings\n(version, changelog, manual check, auto-update toggles, &quot;Buy Me a Coffee&quot;\nsupport link), and a lightweight notice on the empty-state screen when an\nupdate is already known to be available.</p>"},"P-90fb9302-0":{"id":"P-90fb9302-0","level":0,"parent":"S-90fb9302-0","kind":"heading","span":{"start":626,"end":667},"html":"<h2>Current state (why this is greenfield)</h2>"},"P-cec3592f-0":{"id":"P-cec3592f-0","level":0,"parent":"S-90fb9302-0","kind":"list","span":{"start":669,"end":2516},"html":"<ul>\n<li>No updater plugin anywhere: not in <code>src-tauri/Cargo.toml</code>, not in\n<code>package.json</code>, no <code>updater</code> block in <code>tauri.conf.json</code>.</li>\n<li>No <code>.github/</code> directory — no CI, no release automation. Releases today\nare built by hand via <code>npm run build:dmg</code>.</li>\n<li>No signing keys, no <code>CHANGELOG.md</code>.</li>\n<li>App version lives in <code>package.json</code> (<code>0.8.0</code>, mirrored in\n<code>tauri.conf.json</code>) and is injected into the frontend at build time via\nVite&#39;s <code>define: { __APP_VERSION__ }</code>. <code>src-tauri/Cargo.toml</code>&#39;s crate\nversion (<code>0.1.0</code>) is a separate, currently-unsynced number — irrelevant\nto the updater (it doesn&#39;t read the crate version), left alone here.</li>\n<li>Settings tabs follow an established pattern: <code>data-tab</code> button +\n<code>data-tab</code> section in <code>settings.html</code>, generic show/hide in\n<code>src/native/settings/tabs.ts</code>, and a co-located <code>init*Tab()</code> module per\ntab (<code>general-tab.ts</code>, <code>inference-tab.ts</code>, <code>prompt-tab.ts</code>) wired from\n<code>src/native/settings-form.ts</code>. A new <code>updates-tab.ts</code> follows this shape\nexactly.</li>\n<li>Settings persistence for provider/prompt config already goes through a\nRust-owned JSON file (<code>ConfigStore</code> in <code>src-tauri/src/commands/ provider_config.rs</code>) with a precedent for adding a new sub-structure\n(<code>prompt_templates</code>) plus matching <code>get_*</code>/<code>set_*</code> commands. New update\npreferences follow the same mechanical pattern.</li>\n<li>The empty-state screen (<code>src/ui/empty-state.ts</code>) is Tauri-free and\nstore-free by design — <code>main.ts</code> drives it imperatively. It already\nthreads an optional <code>version</code> prop into its footer, and its\n<code>EmptyStateOptions</code> interface has a documented precedent for additive\noptional fields. No existing modal/dialog UI component exists in the\nmain window yet — the update-found dialog is a new pattern, though\n<code>tauri-plugin-dialog</code> is already installed for the simpler native\nrestart-confirmation prompt.</li>\n</ul>"},"P-473002bd-0":{"id":"P-473002bd-0","level":0,"parent":"S-473002bd-0","kind":"heading","span":{"start":2518,"end":2561},"html":"<h2>Update engine — <code>tauri-plugin-updater</code></h2>"},"P-e56f262d-0":{"id":"P-e56f262d-0","level":0,"parent":"S-473002bd-0","kind":"prose","span":{"start":2563,"end":2804},"html":"<p>Add the Rust crate (<code>tauri-plugin-updater</code>) and its JS binding\n(<code>@tauri-apps/plugin-updater</code>). Register the plugin in <code>src-tauri/src/ lib.rs</code> alongside the existing plugin registrations, and add a\n<code>plugin.updater</code> block to <code>tauri.conf.json</code>:</p>"},"P-4c4087f8-0":{"id":"P-4c4087f8-0","level":0,"parent":"S-473002bd-0","kind":"list","span":{"start":2806,"end":3111},"html":"<ul>\n<li><code>endpoints</code>: <code>[&quot;https://github.com/floringheorghiu/semantic-zoom/releases/latest/download/latest.json&quot;]</code></li>\n<li><code>pubkey</code>: the public half of a signing keypair generated once via\n<code>tauri signer generate</code> (private key + password become GitHub Actions\nsecrets, never committed; public key is safe to commit).</li>\n</ul>"},"P-59e2dcb0-0":{"id":"P-59e2dcb0-0","level":0,"parent":"S-473002bd-0","kind":"prose","span":{"start":3113,"end":3385},"html":"<p>Grant the updater plugin&#39;s permissions in the main window&#39;s capabilities\nfile (parallel to the existing <code>src-tauri/capabilities/settings.json</code>\npattern), since both the Updates tab (settings webview) and the main\nwindow (update dialog + empty-state banner) need to call it.</p>"},"P-1046e603-0":{"id":"P-1046e603-0","level":0,"parent":"S-1046e603-0","kind":"heading","span":{"start":3387,"end":3425},"html":"<h2>Release pipeline — GitHub Actions</h2>"},"P-2e4b8866-0":{"id":"P-2e4b8866-0","level":0,"parent":"S-1046e603-0","kind":"prose","span":{"start":3427,"end":3496},"html":"<p>New <code>.github/workflows/release.yml</code>, triggered on push of a <code>v*</code> tag:</p>"},"P-9fe44532-0":{"id":"P-9fe44532-0","level":0,"parent":"S-1046e603-0","kind":"list","span":{"start":3498,"end":3905},"html":"<ol>\n<li>Build the DMG (reuse <code>npm run build:dmg</code>).</li>\n<li>Sign the update artifact with <code>tauri signer sign</code>, using the private\nkey + password secrets.</li>\n<li>Generate <code>latest.json</code> (version, pub date, release notes, per-platform\ndownload URL + signature).</li>\n<li>Publish the signed DMG and <code>latest.json</code> to a GitHub Release for that\ntag (create the release if it doesn&#39;t exist, or attach to one already\ndrafted).</li>\n</ol>"},"P-6ebd8222-0":{"id":"P-6ebd8222-0","level":0,"parent":"S-1046e603-0","kind":"prose","span":{"start":3907,"end":4073},"html":"<p>This becomes the new &quot;how do I ship a release&quot; path. Cutting a release is:\nbump <code>package.json</code>/<code>tauri.conf.json</code> version, tag, push tag, let the\nworkflow do the rest.</p>"},"P-5a065364-0":{"id":"P-5a065364-0","level":0,"parent":"S-5a065364-0","kind":"heading","span":{"start":4075,"end":4138},"html":"<h2>Settings persistence — two booleans plus a skipped version</h2>"},"P-92e17d72-0":{"id":"P-92e17d72-0","level":0,"parent":"S-5a065364-0","kind":"prose","span":{"start":4140,"end":4275},"html":"<p>Add an <code>UpdatePrefs</code> struct to <code>ConfigStore</code> in <code>provider_config.rs</code>,\n<code>#[serde(default)]</code> so existing config files deserialize cleanly:</p>"},"P-692d2577-0":{"id":"P-692d2577-0","level":0,"parent":"S-5a065364-0","kind":"code","span":{"start":4277,"end":4452},"html":"<pre><code>update_prefs: {\n  auto_check: bool,               // default true\n  auto_install: bool,             // default true\n  skipped_version: Option&lt;string&gt; // default None\n}\n</code></pre>"},"P-dbd1c16e-0":{"id":"P-dbd1c16e-0","level":0,"parent":"S-5a065364-0","kind":"prose","span":{"start":4454,"end":4778},"html":"<p><code>skipped_version</code> is written by the update-found dialog&#39;s &quot;Skip This\nVersion&quot; action and read by the automatic-check path (see below). Add\n<code>get_update_prefs</code> / <code>set_update_prefs</code> <code>#[tauri::command]</code> functions\nmirroring <code>get_prompt_templates</code> / <code>set_prompt_templates</code>, registered in\n<code>src-tauri/src/lib.rs</code>&#39;s <code>invoke_handler</code>.</p>"},"P-dd7eff10-0":{"id":"P-dd7eff10-0","level":0,"parent":"S-dd7eff10-0","kind":"heading","span":{"start":4780,"end":4806},"html":"<h2>The update-found dialog</h2>"},"P-ebd2f6fe-0":{"id":"P-ebd2f6fe-0","level":0,"parent":"S-dd7eff10-0","kind":"prose","span":{"start":4808,"end":5217},"html":"<p>Reference: macOS Sparkle-style &quot;Software Update&quot; dialogs (e.g. Typora&#39;s) —\napp icon, &quot;A new version of X is available!&quot; headline, current vs.\navailable version line, a scrollable release-notes panel (can show more\nthan just the latest version&#39;s notes), an &quot;Automatically download and\ninstall updates in the future&quot; checkbox, and three actions: <strong>Skip This\nVersion</strong>, <strong>Remind Me Later</strong>, <strong>Install Update</strong>.</p>"},"P-0999f9ed-0":{"id":"P-0999f9ed-0","level":0,"parent":"S-dd7eff10-0","kind":"prose","span":{"start":5219,"end":5607},"html":"<p>Implemented as a new <code>src/ui/update-dialog.ts</code> module (native <code>&lt;dialog&gt;</code>\nelement in the main window, Tauri-free/store-free like <code>empty-state.ts</code> —\n<code>main.ts</code> drives it imperatively with the check result and prefs), plus\n<code>src/styles/update-dialog.css</code>. Not a new Tauri window — an in-page modal\noverlay, consistent with the app&#39;s existing &quot;one main webview, one\nsettings webview&quot; split.</p>"},"P-5917cf60-0":{"id":"P-5917cf60-0","level":0,"parent":"S-dd7eff10-0","kind":"list","span":{"start":5609,"end":6996},"html":"<ul>\n<li><strong>Shown by</strong>: both the Updates tab&#39;s &quot;Check for Updates now&quot; button and\nan automatic background <code>check()</code> (startup + periodic), whenever an\nupdate is found — this is the single, unified &quot;update found&quot; UI; the\nUpdates tab&#39;s check button no longer shows its own inline result.</li>\n<li><strong>Release notes</strong>: every GitHub release between the installed version\nand the latest (fetched via the GitHub REST API), each rendered under\nits own version heading, matching the reference&#39;s stacked-notes layout.</li>\n<li><strong>The checkbox</strong> is two-way bound to the same <code>auto_install</code> pref shown\nin the Updates tab — checking it here updates the same stored value.</li>\n<li><strong>Skip This Version</strong> — persists <code>skipped_version</code> = the latest\nversion&#39;s tag via <code>set_update_prefs</code>, closes the dialog. An automatic\ncheck that finds this exact version again will not reopen the dialog.\nA manual &quot;Check for Updates now&quot; always shows the dialog regardless of\n<code>skipped_version</code> — skipping only silences unattended nagging, it never\nhides the update from someone who explicitly asks.</li>\n<li><strong>Remind Me Later</strong> — closes the dialog with no persisted state change;\nthe next check (automatic or manual) prompts again normally.</li>\n<li><strong>Install Update</strong> — downloads and installs via the updater plugin, then\nuses <code>tauri-plugin-dialog</code> for the final native restart-confirmation\nprompt once the install completes.</li>\n</ul>"},"P-fded9a9d-0":{"id":"P-fded9a9d-0","level":0,"parent":"S-fded9a9d-0","kind":"heading","span":{"start":6998,"end":7019},"html":"<h3>Download progress</h3>"},"P-514f0664-0":{"id":"P-514f0664-0","level":0,"parent":"S-fded9a9d-0","kind":"prose","span":{"start":7021,"end":7338},"html":"<p>Reference: Typora&#39;s &quot;Updating X&quot; progress dialog — same window, header\nswitches to &quot;Updating Semantic Zoom&quot;, app icon stays, release notes swap\nout for a &quot;Downloading update…&quot; label, a determinate progress bar, a\nbyte-count line (&quot;11.0 MB of 14.4 MB&quot;), and a <strong>Cancel</strong> button in place\nof the three prior actions.</p>"},"P-2b9c838c-0":{"id":"P-2b9c838c-0","level":0,"parent":"S-fded9a9d-0","kind":"prose","span":{"start":7340,"end":7989},"html":"<p>The updater plugin&#39;s <code>downloadAndInstall()</code> takes a progress callback\nfiring <code>Started</code> (total <code>contentLength</code>), <code>Progress</code> (per-chunk bytes),\nand <code>Finished</code> events — enough to drive the bar and byte-count text\ndirectly, no polling needed. <strong>Cancel</strong> dismisses the dialog and abandons\nthe in-flight download; the plugin has no partial-resume, so a cancelled\ndownload simply starts over in full on the next attempt (manual recheck,\nor the next automatic check picking the same version back up). Reusing\none dialog element for both the found-update and downloading states keeps\nthis a single continuous piece of UI rather than a hand-off between two.</p>"},"P-3e809dc0-0":{"id":"P-3e809dc0-0","level":0,"parent":"S-3e809dc0-0","kind":"heading","span":{"start":7991,"end":8023},"html":"<h2>Updates tab (Settings window)</h2>"},"P-1d70d2d2-0":{"id":"P-1d70d2d2-0","level":0,"parent":"S-3e809dc0-0","kind":"prose","span":{"start":8025,"end":8254},"html":"<p>New <code>data-tab=&quot;updates&quot;</code> button + <code>section[data-tab=&quot;updates&quot;]</code> in\n<code>settings.html</code>, new <code>src/native/settings/updates-tab.ts</code> (+\n<code>updates-tab.test.ts</code>) wired from <code>settings-form.ts</code>, following\n<code>inference-tab.ts</code>&#39;s shape. Contents:</p>"},"P-3bf140ce-0":{"id":"P-3bf140ce-0","level":0,"parent":"S-3e809dc0-0","kind":"list","span":{"start":8256,"end":9814},"html":"<ul>\n<li><strong>Current version</strong> — read via <code>getVersion()</code> from <code>@tauri-apps/api/app</code>.</li>\n<li><strong>Toggles</strong> (labels/hint per the approved microcopy):<ul>\n<li>&quot;Automatically check for updates.&quot; — gates whether the app runs a\nbackground <code>check()</code> on startup / periodically.</li>\n<li>&quot;Automatically download and install updates.&quot; — same stored value as\nthe update-found dialog&#39;s checkbox; gates whether a found update\ninstalls itself in the background once auto-check finds one, versus\nonly surfacing the dialog/banner for the user to trigger manually.</li>\n<li>Hint: &quot;The updates are downloaded in the background. The app will ask\nto restart to apply the update.&quot;</li>\n</ul>\n</li>\n<li><strong>&quot;Check for Updates now&quot;</strong> button — calls the updater plugin&#39;s\n<code>check()</code>; if an update is found, opens the same update-found dialog\ndescribed above (ignoring <code>skipped_version</code>, per the rule above); if not,\nshows a brief inline &quot;You&#39;re up to date&quot; state.</li>\n<li><strong>Changelog</strong> — fetched at runtime from the latest GitHub release&#39;s\nnotes body via the GitHub REST API (<code>GET /repos/floringheorghiu/ semantic-zoom/releases/latest</code>), rendered as plain text/light markdown.\nNo maintained <code>CHANGELOG.md</code> — the release notes written when cutting a\nrelease are the single source.</li>\n<li><strong>Support section</strong> — &quot;Buy Me a Coffee&quot; block linking to\n<code>https://buymeacoffee.com/fgheorghiu</code>, with copy adapted from the\napproved example (&quot;We&#39;re now accepting support via Buy Me a Coffee —\nyour one-time or recurring contribution helps keep this project going.\nIf you&#39;re able, we&#39;d appreciate it.&quot;).</li>\n</ul>"},"P-d410ae37-0":{"id":"P-d410ae37-0","level":0,"parent":"S-d410ae37-0","kind":"heading","span":{"start":9816,"end":9849},"html":"<h2>Empty-state banner (Feature B)</h2>"},"P-92b487d7-0":{"id":"P-92b487d7-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":9851,"end":9901},"html":"<p>Extend <code>EmptyStateOptions</code> with an optional field:</p>"},"P-fd7703ce-0":{"id":"P-fd7703ce-0","level":0,"parent":"S-d410ae37-0","kind":"code","span":{"start":9903,"end":9974},"html":"<pre><code>updateAvailable?: { version: string; onOpenDialog: () =&gt; void }\n</code></pre>"},"P-66174d10-0":{"id":"P-66174d10-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":9976,"end":10358},"html":"<p>Rendered as a small, passive banner near the existing version chip in the\nfooter, with an &quot;Update&quot; button, following the same additive-optional-\nfield precedent already used for <code>onClearRecent</code>/<code>version</code>. The banner is\nsecondary to the dialog: it never installs directly — clicking it just\nopens the same update-found dialog, so there&#39;s one install path in the\nwhole app, not two.</p>"},"P-a5181812-0":{"id":"P-a5181812-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":10360,"end":10744},"html":"<p><code>main.ts</code> runs a background <code>check()</code> on startup (gated by the\n<code>auto_check</code> pref) before mounting the empty state. If an update is found\nand isn&#39;t the user&#39;s <code>skipped_version</code>, the dialog opens immediately\n(unattended-friendly per the auto-install pref) and <code>updateAvailable</code> is\nalso passed to the empty state so the banner is present if the dialog gets\ndismissed via Remind Me Later.</p>"},"P-694f1b7b-0":{"id":"P-694f1b7b-0","level":0,"parent":"S-694f1b7b-0","kind":"heading","span":{"start":10746,"end":10783},"html":"<h2>Toggle defaults &amp; behavior summary</h2>"},"P-897ee770-0":{"id":"P-897ee770-0","level":0,"parent":"S-694f1b7b-0","kind":"prose","span":{"start":10785,"end":11417},"html":"<p>Both toggles default <strong>on</strong>: the app checks for updates automatically and,\nonce found (and not the skipped version), shows the update-found dialog —\ninstalling automatically in the background if &quot;auto-install&quot; is on, only\never interrupting the user to ask for a restart once ready. Turning off\n&quot;automatically download and install&quot; still checks and shows the dialog on\nfind, but leaves the actual install to the user clicking &quot;Install Update&quot;.\nTurning off &quot;automatically check&quot; as well makes update discovery fully\nmanual via &quot;Check for Updates now&quot; (which always shows the dialog on\nfind, ignoring any previously skipped version).</p>"},"P-fddfdb6d-0":{"id":"P-fddfdb6d-0","level":0,"parent":"S-fddfdb6d-0","kind":"heading","span":{"start":11419,"end":11442},"html":"<h2>Delivery — two PRs</h2>"},"P-523a9ab7-0":{"id":"P-523a9ab7-0","level":0,"parent":"S-fddfdb6d-0","kind":"list","span":{"start":11444,"end":12036},"html":"<ol>\n<li><strong>Update engine + release pipeline</strong> — updater plugin, signing keys,\n<code>tauri.conf.json</code> config, capabilities grant, GitHub Actions workflow.\nNo user-visible UI yet; verified by cutting a real tagged release and\nconfirming <code>latest.json</code> publishes correctly.</li>\n<li><strong>Updates tab + update-found dialog + empty-state banner</strong> — settings\npersistence (<code>UpdatePrefs</code> + commands), the update-dialog module, Updates\ntab UI, empty-state banner, wiring <code>main.ts</code>&#39;s startup check. Ends with\nthe user&#39;s manual WebKit pass (background sessions cannot run it), per\nstanding practice.</li>\n</ol>"}},"order":{"meta":["M1"],"sections":["S-eaeded3f-0","S-90fb9302-0","S-473002bd-0","S-1046e603-0","S-5a065364-0","S-dd7eff10-0","S-fded9a9d-0","S-3e809dc0-0","S-d410ae37-0","S-694f1b7b-0","S-fddfdb6d-0"],"paragraphs":["P-eaeded3f-0","P-effba803-0","P-b8abb050-0","P-6152ea14-0","P-90fb9302-0","P-cec3592f-0","P-473002bd-0","P-e56f262d-0","P-4c4087f8-0","P-59e2dcb0-0","P-1046e603-0","P-2e4b8866-0","P-9fe44532-0","P-6ebd8222-0","P-5a065364-0","P-92e17d72-0","P-692d2577-0","P-dbd1c16e-0","P-dd7eff10-0","P-ebd2f6fe-0","P-0999f9ed-0","P-5917cf60-0","P-fded9a9d-0","P-514f0664-0","P-2b9c838c-0","P-3e809dc0-0","P-1d70d2d2-0","P-3bf140ce-0","P-d410ae37-0","P-92b487d7-0","P-fd7703ce-0","P-66174d10-0","P-a5181812-0","P-694f1b7b-0","P-897ee770-0","P-fddfdb6d-0","P-523a9ab7-0"]}}
-->
