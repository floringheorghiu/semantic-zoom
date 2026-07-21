# Auto-Updates & Support Link — Design

Date: 2026-07-21. Status: approved in brainstorm session "Semantic Zoom - Updates tab".

## Purpose

Give the app a real, working auto-updater instead of the current fully
manual DMG build/share process, and surface it in two places: a new
**Updates** tab in Settings (version, changelog, manual check, auto-update
toggles, "Buy Me a Coffee" support link) and a lightweight notice on the
empty-state screen when an update is already known to be available.

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
  optional fields.
- `tauri-plugin-dialog` is already installed and used elsewhere (the
  restart-confirmation dialog can reuse this, no new dialog pattern).

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
pattern), since both the Updates tab (settings webview) and the
empty-state banner (main webview) need to call it.

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

## Settings persistence — two new booleans

Add an `UpdatePrefs` struct to `ConfigStore` in `provider_config.rs`,
`#[serde(default)]` so existing config files deserialize cleanly with both
defaulting to `true`:

```
update_prefs: {
  auto_check: bool,    // default true
  auto_install: bool,  // default true
}
```

Add `get_update_prefs` / `set_update_prefs` `#[tauri::command]` functions
mirroring `get_prompt_templates` / `set_prompt_templates`, registered in
`src-tauri/src/lib.rs`'s `invoke_handler`.

## Updates tab (Settings window)

New `data-tab="updates"` button + `section[data-tab="updates"]` in
`settings.html`, new `src/native/settings/updates-tab.ts` (+
`updates-tab.test.ts`) wired from `settings-form.ts`, following
`inference-tab.ts`'s shape. Contents:

- **Current version** — read via `getVersion()` from `@tauri-apps/api/app`.
- **Toggles** (labels/hint per the approved microcopy):
  - "Automatically check for updates." — gates whether the app runs a
    background `check()` on startup / periodically.
  - "Automatically download and install updates." — gates whether a found
    update installs itself in the background once auto-check finds one,
    versus only surfacing the banner/tab notice for the user to trigger
    manually.
  - Hint: "The updates are downloaded in the background. The app will ask
    to restart to apply the update."
- **"Check for Updates now"** button — calls the updater plugin's
  `check()` directly, shows result inline (up to date / update found →
  download+install flow / error).
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
updateAvailable?: { version: string; onInstall: () => void }
```

Rendered as a small banner near the existing version chip in the footer,
with an "Update" button, following the same additive-optional-field
precedent already used for `onClearRecent`/`version`.

`main.ts` runs a background `check()` on startup (gated by the
`auto_check` pref) before mounting the empty state, and passes the result
in as `updateAvailable` when one is found. Clicking "Update" — or
auto-install firing on its own when the `auto_install` pref is on —
downloads and installs via the updater plugin, then uses the existing
`tauri-plugin-dialog` to prompt for a restart to apply it.

## Toggle defaults & behavior summary

Both toggles default **on**: the app checks for updates automatically and
installs them automatically in the background, only ever interrupting the
user to ask for a restart. Turning off "automatically download and
install" still checks and notifies (Updates tab + empty-state banner) but
leaves the download/install step to a manual "Update" click. Turning off
"automatically check" as well makes update discovery fully manual via
"Check for Updates now".

## Delivery — two PRs

1. **Update engine + release pipeline** — updater plugin, signing keys,
   `tauri.conf.json` config, capabilities grant, GitHub Actions workflow.
   No user-visible UI yet; verified by cutting a real tagged release and
   confirming `latest.json` publishes correctly.
2. **Updates tab + empty-state banner** — settings persistence
   (`UpdatePrefs` + commands), Updates tab UI, empty-state banner, wiring
   `main.ts`'s startup check. Ends with the user's manual WebKit pass
   (background sessions cannot run it), per standing practice.

<!-- semantic-zoom:payload:v1
{"version":1,"docHash":"ca36a5ae1807d93fbd16ed316af34981aea4d80037d9d96970a387ad46c068a8","meta":{"M1":{"id":"M1","level":-2,"title":"A real auto-updater, plus a way to say thanks","body":"**Accomplished:**\n- A ratified design for turning the app's manual DMG-sharing process into a real, signed auto-updater built on Tauri's official updater plugin and a GitHub Actions release pipeline.\n- Two visible touchpoints: an Updates tab in Settings (version, changelog, check-now button, auto-update toggles, and a Buy Me a Coffee link) and a small \"update available\" banner on the empty-state screen.\n\n**Blockers:**\n- None noted — this is greenfield infrastructure (no updater plugin, no CI, no signing keys exist yet), so there's nothing to untangle, only to build.\n\n**Next steps:**\n- Ship it as two independent pull requests: first the invisible plumbing (updater plugin, signing keys, release workflow), verified by actually cutting a release; then the user-facing pieces (Updates tab, empty-state banner, the two preference toggles).","children":["S-eaeded3f-0","S-90fb9302-0","S-473002bd-0","S-1046e603-0","S-b7829ec1-0","S-3e809dc0-0","S-d410ae37-0","S-694f1b7b-0","S-fddfdb6d-0"]}},"sections":{"S-eaeded3f-0":{"id":"S-eaeded3f-0","level":-1,"parent":"M1","children":["P-eaeded3f-0","P-effba803-0","P-b8abb050-0","P-7c18373c-0"],"title":"What this design is for","body":"Right now, shipping a new build means manually making a DMG and sharing it by hand. This design replaces that with a proper self-updating app, and adds two small but meaningful extras while doing it: a place to see what's changed and a way for people to support the project financially."},"S-90fb9302-0":{"id":"S-90fb9302-0","level":-1,"parent":"M1","children":["P-90fb9302-0","P-f3e089f8-0"],"title":"Starting from nothing — and what already fits the shape","body":"None of the update machinery exists yet: no updater plugin, no automated release process, no signing keys, no changelog file. But the surrounding app already has the right shapes to build on — a settings-tab pattern that's trivial to extend, a settings-storage precedent for adding new preferences, and an empty-state screen already designed to grow new optional pieces without breaking anything."},"S-473002bd-0":{"id":"S-473002bd-0","level":-1,"parent":"M1","children":["P-473002bd-0","P-e56f262d-0","P-4c4087f8-0","P-74c3d60a-0"],"title":"The engine that checks for and installs updates","body":"The app gains Tauri's official updater plugin, told where to look for new versions (a file GitHub publishes with each release) and given a public key so it can verify that what it downloads was really signed by the developer, not tampered with."},"S-1046e603-0":{"id":"S-1046e603-0","level":-1,"parent":"M1","children":["P-1046e603-0","P-2e4b8866-0","P-9fe44532-0","P-6ebd8222-0"],"title":"How a new version actually gets published","body":"Publishing a release becomes automatic: pushing a version tag triggers a workflow that builds the app, signs it, writes a small manifest describing the new version, and uploads everything to a GitHub release. From then on, cutting a release is just a version bump and a tag push."},"S-b7829ec1-0":{"id":"S-b7829ec1-0","level":-1,"parent":"M1","children":["P-b7829ec1-0","P-d243a8d8-0","P-5bdc3aaf-0","P-664218bc-0"],"title":"Remembering the user's update preferences","body":"Two new on/off preferences — whether to check for updates automatically, and whether to install them automatically once found — get saved the same way the app already saves its other settings, so there's nothing new to learn about how storage works here."},"S-3e809dc0-0":{"id":"S-3e809dc0-0","level":-1,"parent":"M1","children":["P-3e809dc0-0","P-1d70d2d2-0","P-5ef53d7d-0"],"title":"The new Updates tab in Settings","body":"A new tab shows the app's current version, the two auto-update toggles with explanatory hint text, a button to check for updates right now, the release notes for the latest version pulled live from GitHub, and a short note pointing people to Buy Me a Coffee if they'd like to support the project."},"S-d410ae37-0":{"id":"S-d410ae37-0","level":-1,"parent":"M1","children":["P-d410ae37-0","P-92b487d7-0","P-07976b8a-0","P-0cbd3d4e-0","P-1a24a957-0"],"title":"Letting people know from the empty-state screen","body":"When no document is open, the app already shows a simple welcome screen with its version number in the corner. This design adds a small banner there when an update has already been found, with a button to install it — so people notice the update without having to think to check Settings."},"S-694f1b7b-0":{"id":"S-694f1b7b-0","level":-1,"parent":"M1","children":["P-694f1b7b-0","P-49e2d68c-0"],"title":"What happens by default, and what turning things off changes","body":"Out of the box, the app quietly checks for and installs updates on its own, only interrupting to ask for a restart once one's ready. Turning off auto-install keeps the checking but leaves installing to a manual click; turning off auto-check as well makes the whole thing fully manual."},"S-fddfdb6d-0":{"id":"S-fddfdb6d-0","level":-1,"parent":"M1","children":["P-fddfdb6d-0","P-c64efc51-0"],"title":"Shipping it in two pieces","body":"The invisible plumbing — the updater plugin, signing, and release automation — ships first and gets proven by actually cutting a real release. The visible half — the Updates tab and the empty-state banner — follows once that foundation is confirmed working."}},"paragraphs":{"P-eaeded3f-0":{"id":"P-eaeded3f-0","level":0,"parent":"S-eaeded3f-0","kind":"heading","span":{"start":0,"end":40},"html":"<h1>Auto-Updates &amp; Support Link — Design</h1>"},"P-effba803-0":{"id":"P-effba803-0","level":0,"parent":"S-eaeded3f-0","kind":"prose","span":{"start":42,"end":129},"html":"<p>Date: 2026-07-21. Status: approved in brainstorm session &quot;Semantic Zoom - Updates tab&quot;.</p>"},"P-b8abb050-0":{"id":"P-b8abb050-0","level":0,"parent":"S-eaeded3f-0","kind":"heading","span":{"start":131,"end":141},"html":"<h2>Purpose</h2>"},"P-7c18373c-0":{"id":"P-7c18373c-0","level":0,"parent":"S-eaeded3f-0","kind":"prose","span":{"start":143,"end":497},"html":"<p>Give the app a real, working auto-updater instead of the current fully\nmanual DMG build/share process, and surface it in two places: a new\n<strong>Updates</strong> tab in Settings (version, changelog, manual check, auto-update\ntoggles, &quot;Buy Me a Coffee&quot; support link) and a lightweight notice on the\nempty-state screen when an update is already known to be available.</p>"},"P-90fb9302-0":{"id":"P-90fb9302-0","level":0,"parent":"S-90fb9302-0","kind":"heading","span":{"start":499,"end":540},"html":"<h2>Current state (why this is greenfield)</h2>"},"P-f3e089f8-0":{"id":"P-f3e089f8-0","level":0,"parent":"S-90fb9302-0","kind":"list","span":{"start":542,"end":2306},"html":"<ul>\n<li>No updater plugin anywhere: not in <code>src-tauri/Cargo.toml</code>, not in\n<code>package.json</code>, no <code>updater</code> block in <code>tauri.conf.json</code>.</li>\n<li>No <code>.github/</code> directory — no CI, no release automation. Releases today\nare built by hand via <code>npm run build:dmg</code>.</li>\n<li>No signing keys, no <code>CHANGELOG.md</code>.</li>\n<li>App version lives in <code>package.json</code> (<code>0.8.0</code>, mirrored in\n<code>tauri.conf.json</code>) and is injected into the frontend at build time via\nVite&#39;s <code>define: { __APP_VERSION__ }</code>. <code>src-tauri/Cargo.toml</code>&#39;s crate\nversion (<code>0.1.0</code>) is a separate, currently-unsynced number — irrelevant\nto the updater (it doesn&#39;t read the crate version), left alone here.</li>\n<li>Settings tabs follow an established pattern: <code>data-tab</code> button +\n<code>data-tab</code> section in <code>settings.html</code>, generic show/hide in\n<code>src/native/settings/tabs.ts</code>, and a co-located <code>init*Tab()</code> module per\ntab (<code>general-tab.ts</code>, <code>inference-tab.ts</code>, <code>prompt-tab.ts</code>) wired from\n<code>src/native/settings-form.ts</code>. A new <code>updates-tab.ts</code> follows this shape\nexactly.</li>\n<li>Settings persistence for provider/prompt config already goes through a\nRust-owned JSON file (<code>ConfigStore</code> in <code>src-tauri/src/commands/ provider_config.rs</code>) with a precedent for adding a new sub-structure\n(<code>prompt_templates</code>) plus matching <code>get_*</code>/<code>set_*</code> commands. New update\npreferences follow the same mechanical pattern.</li>\n<li>The empty-state screen (<code>src/ui/empty-state.ts</code>) is Tauri-free and\nstore-free by design — <code>main.ts</code> drives it imperatively. It already\nthreads an optional <code>version</code> prop into its footer, and its\n<code>EmptyStateOptions</code> interface has a documented precedent for additive\noptional fields.</li>\n<li><code>tauri-plugin-dialog</code> is already installed and used elsewhere (the\nrestart-confirmation dialog can reuse this, no new dialog pattern).</li>\n</ul>"},"P-473002bd-0":{"id":"P-473002bd-0","level":0,"parent":"S-473002bd-0","kind":"heading","span":{"start":2308,"end":2351},"html":"<h2>Update engine — <code>tauri-plugin-updater</code></h2>"},"P-e56f262d-0":{"id":"P-e56f262d-0","level":0,"parent":"S-473002bd-0","kind":"prose","span":{"start":2353,"end":2594},"html":"<p>Add the Rust crate (<code>tauri-plugin-updater</code>) and its JS binding\n(<code>@tauri-apps/plugin-updater</code>). Register the plugin in <code>src-tauri/src/ lib.rs</code> alongside the existing plugin registrations, and add a\n<code>plugin.updater</code> block to <code>tauri.conf.json</code>:</p>"},"P-4c4087f8-0":{"id":"P-4c4087f8-0","level":0,"parent":"S-473002bd-0","kind":"list","span":{"start":2596,"end":2901},"html":"<ul>\n<li><code>endpoints</code>: <code>[&quot;https://github.com/floringheorghiu/semantic-zoom/releases/latest/download/latest.json&quot;]</code></li>\n<li><code>pubkey</code>: the public half of a signing keypair generated once via\n<code>tauri signer generate</code> (private key + password become GitHub Actions\nsecrets, never committed; public key is safe to commit).</li>\n</ul>"},"P-74c3d60a-0":{"id":"P-74c3d60a-0","level":0,"parent":"S-473002bd-0","kind":"prose","span":{"start":2903,"end":3160},"html":"<p>Grant the updater plugin&#39;s permissions in the main window&#39;s capabilities\nfile (parallel to the existing <code>src-tauri/capabilities/settings.json</code>\npattern), since both the Updates tab (settings webview) and the\nempty-state banner (main webview) need to call it.</p>"},"P-1046e603-0":{"id":"P-1046e603-0","level":0,"parent":"S-1046e603-0","kind":"heading","span":{"start":3162,"end":3200},"html":"<h2>Release pipeline — GitHub Actions</h2>"},"P-2e4b8866-0":{"id":"P-2e4b8866-0","level":0,"parent":"S-1046e603-0","kind":"prose","span":{"start":3202,"end":3271},"html":"<p>New <code>.github/workflows/release.yml</code>, triggered on push of a <code>v*</code> tag:</p>"},"P-9fe44532-0":{"id":"P-9fe44532-0","level":0,"parent":"S-1046e603-0","kind":"list","span":{"start":3273,"end":3680},"html":"<ol>\n<li>Build the DMG (reuse <code>npm run build:dmg</code>).</li>\n<li>Sign the update artifact with <code>tauri signer sign</code>, using the private\nkey + password secrets.</li>\n<li>Generate <code>latest.json</code> (version, pub date, release notes, per-platform\ndownload URL + signature).</li>\n<li>Publish the signed DMG and <code>latest.json</code> to a GitHub Release for that\ntag (create the release if it doesn&#39;t exist, or attach to one already\ndrafted).</li>\n</ol>"},"P-6ebd8222-0":{"id":"P-6ebd8222-0","level":0,"parent":"S-1046e603-0","kind":"prose","span":{"start":3682,"end":3848},"html":"<p>This becomes the new &quot;how do I ship a release&quot; path. Cutting a release is:\nbump <code>package.json</code>/<code>tauri.conf.json</code> version, tag, push tag, let the\nworkflow do the rest.</p>"},"P-b7829ec1-0":{"id":"P-b7829ec1-0","level":0,"parent":"S-b7829ec1-0","kind":"heading","span":{"start":3850,"end":3894},"html":"<h2>Settings persistence — two new booleans</h2>"},"P-d243a8d8-0":{"id":"P-d243a8d8-0","level":0,"parent":"S-b7829ec1-0","kind":"prose","span":{"start":3896,"end":4062},"html":"<p>Add an <code>UpdatePrefs</code> struct to <code>ConfigStore</code> in <code>provider_config.rs</code>,\n<code>#[serde(default)]</code> so existing config files deserialize cleanly with both\ndefaulting to <code>true</code>:</p>"},"P-5bdc3aaf-0":{"id":"P-5bdc3aaf-0","level":0,"parent":"S-b7829ec1-0","kind":"code","span":{"start":4064,"end":4167},"html":"<pre><code>update_prefs: {\n  auto_check: bool,    // default true\n  auto_install: bool,  // default true\n}\n</code></pre>"},"P-664218bc-0":{"id":"P-664218bc-0","level":0,"parent":"S-b7829ec1-0","kind":"prose","span":{"start":4169,"end":4358},"html":"<p>Add <code>get_update_prefs</code> / <code>set_update_prefs</code> <code>#[tauri::command]</code> functions\nmirroring <code>get_prompt_templates</code> / <code>set_prompt_templates</code>, registered in\n<code>src-tauri/src/lib.rs</code>&#39;s <code>invoke_handler</code>.</p>"},"P-3e809dc0-0":{"id":"P-3e809dc0-0","level":0,"parent":"S-3e809dc0-0","kind":"heading","span":{"start":4360,"end":4392},"html":"<h2>Updates tab (Settings window)</h2>"},"P-1d70d2d2-0":{"id":"P-1d70d2d2-0","level":0,"parent":"S-3e809dc0-0","kind":"prose","span":{"start":4394,"end":4623},"html":"<p>New <code>data-tab=&quot;updates&quot;</code> button + <code>section[data-tab=&quot;updates&quot;]</code> in\n<code>settings.html</code>, new <code>src/native/settings/updates-tab.ts</code> (+\n<code>updates-tab.test.ts</code>) wired from <code>settings-form.ts</code>, following\n<code>inference-tab.ts</code>&#39;s shape. Contents:</p>"},"P-5ef53d7d-0":{"id":"P-5ef53d7d-0","level":0,"parent":"S-3e809dc0-0","kind":"list","span":{"start":4625,"end":6040},"html":"<ul>\n<li><strong>Current version</strong> — read via <code>getVersion()</code> from <code>@tauri-apps/api/app</code>.</li>\n<li><strong>Toggles</strong> (labels/hint per the approved microcopy):<ul>\n<li>&quot;Automatically check for updates.&quot; — gates whether the app runs a\nbackground <code>check()</code> on startup / periodically.</li>\n<li>&quot;Automatically download and install updates.&quot; — gates whether a found\nupdate installs itself in the background once auto-check finds one,\nversus only surfacing the banner/tab notice for the user to trigger\nmanually.</li>\n<li>Hint: &quot;The updates are downloaded in the background. The app will ask\nto restart to apply the update.&quot;</li>\n</ul>\n</li>\n<li><strong>&quot;Check for Updates now&quot;</strong> button — calls the updater plugin&#39;s\n<code>check()</code> directly, shows result inline (up to date / update found →\ndownload+install flow / error).</li>\n<li><strong>Changelog</strong> — fetched at runtime from the latest GitHub release&#39;s\nnotes body via the GitHub REST API (<code>GET /repos/floringheorghiu/ semantic-zoom/releases/latest</code>), rendered as plain text/light markdown.\nNo maintained <code>CHANGELOG.md</code> — the release notes written when cutting a\nrelease are the single source.</li>\n<li><strong>Support section</strong> — &quot;Buy Me a Coffee&quot; block linking to\n<code>https://buymeacoffee.com/fgheorghiu</code>, with copy adapted from the\napproved example (&quot;We&#39;re now accepting support via Buy Me a Coffee —\nyour one-time or recurring contribution helps keep this project going.\nIf you&#39;re able, we&#39;d appreciate it.&quot;).</li>\n</ul>"},"P-d410ae37-0":{"id":"P-d410ae37-0","level":0,"parent":"S-d410ae37-0","kind":"heading","span":{"start":6042,"end":6075},"html":"<h2>Empty-state banner (Feature B)</h2>"},"P-92b487d7-0":{"id":"P-92b487d7-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":6077,"end":6127},"html":"<p>Extend <code>EmptyStateOptions</code> with an optional field:</p>"},"P-07976b8a-0":{"id":"P-07976b8a-0","level":0,"parent":"S-d410ae37-0","kind":"code","span":{"start":6129,"end":6197},"html":"<pre><code>updateAvailable?: { version: string; onInstall: () =&gt; void }\n</code></pre>"},"P-0cbd3d4e-0":{"id":"P-0cbd3d4e-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":6199,"end":6393},"html":"<p>Rendered as a small banner near the existing version chip in the footer,\nwith an &quot;Update&quot; button, following the same additive-optional-field\nprecedent already used for <code>onClearRecent</code>/<code>version</code>.</p>"},"P-1a24a957-0":{"id":"P-1a24a957-0","level":0,"parent":"S-d410ae37-0","kind":"prose","span":{"start":6395,"end":6798},"html":"<p><code>main.ts</code> runs a background <code>check()</code> on startup (gated by the\n<code>auto_check</code> pref) before mounting the empty state, and passes the result\nin as <code>updateAvailable</code> when one is found. Clicking &quot;Update&quot; — or\nauto-install firing on its own when the <code>auto_install</code> pref is on —\ndownloads and installs via the updater plugin, then uses the existing\n<code>tauri-plugin-dialog</code> to prompt for a restart to apply it.</p>"},"P-694f1b7b-0":{"id":"P-694f1b7b-0","level":0,"parent":"S-694f1b7b-0","kind":"heading","span":{"start":6800,"end":6837},"html":"<h2>Toggle defaults &amp; behavior summary</h2>"},"P-49e2d68c-0":{"id":"P-49e2d68c-0","level":0,"parent":"S-694f1b7b-0","kind":"prose","span":{"start":6839,"end":7295},"html":"<p>Both toggles default <strong>on</strong>: the app checks for updates automatically and\ninstalls them automatically in the background, only ever interrupting the\nuser to ask for a restart. Turning off &quot;automatically download and\ninstall&quot; still checks and notifies (Updates tab + empty-state banner) but\nleaves the download/install step to a manual &quot;Update&quot; click. Turning off\n&quot;automatically check&quot; as well makes update discovery fully manual via\n&quot;Check for Updates now&quot;.</p>"},"P-fddfdb6d-0":{"id":"P-fddfdb6d-0","level":0,"parent":"S-fddfdb6d-0","kind":"heading","span":{"start":7297,"end":7320},"html":"<h2>Delivery — two PRs</h2>"},"P-c64efc51-0":{"id":"P-c64efc51-0","level":0,"parent":"S-fddfdb6d-0","kind":"list","span":{"start":7322,"end":7863},"html":"<ol>\n<li><strong>Update engine + release pipeline</strong> — updater plugin, signing keys,\n<code>tauri.conf.json</code> config, capabilities grant, GitHub Actions workflow.\nNo user-visible UI yet; verified by cutting a real tagged release and\nconfirming <code>latest.json</code> publishes correctly.</li>\n<li><strong>Updates tab + empty-state banner</strong> — settings persistence\n(<code>UpdatePrefs</code> + commands), Updates tab UI, empty-state banner, wiring\n<code>main.ts</code>&#39;s startup check. Ends with the user&#39;s manual WebKit pass\n(background sessions cannot run it), per standing practice.</li>\n</ol>"}},"order":{"meta":["M1"],"sections":["S-eaeded3f-0","S-90fb9302-0","S-473002bd-0","S-1046e603-0","S-b7829ec1-0","S-3e809dc0-0","S-d410ae37-0","S-694f1b7b-0","S-fddfdb6d-0"],"paragraphs":["P-eaeded3f-0","P-effba803-0","P-b8abb050-0","P-7c18373c-0","P-90fb9302-0","P-f3e089f8-0","P-473002bd-0","P-e56f262d-0","P-4c4087f8-0","P-74c3d60a-0","P-1046e603-0","P-2e4b8866-0","P-9fe44532-0","P-6ebd8222-0","P-b7829ec1-0","P-d243a8d8-0","P-5bdc3aaf-0","P-664218bc-0","P-3e809dc0-0","P-1d70d2d2-0","P-5ef53d7d-0","P-d410ae37-0","P-92b487d7-0","P-07976b8a-0","P-0cbd3d4e-0","P-1a24a957-0","P-694f1b7b-0","P-49e2d68c-0","P-fddfdb6d-0","P-c64efc51-0"]}}
-->
