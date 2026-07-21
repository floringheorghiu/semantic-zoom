# Auto-Updates & Support Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the app's fully-manual DMG-sharing process with a real, signed auto-updater (Tauri's official updater plugin + a GitHub Actions release pipeline), surfaced through a Sparkle-style update dialog, a new Updates settings tab, and a passive empty-state banner.

**Architecture:** Rust gains `tauri-plugin-updater` + `tauri-plugin-process` and three new settings-storage fields (`UpdatePrefs`) alongside the existing `provider-config.json`. TypeScript gains one new Tauri-free UI module (`update-dialog.ts`, mounted independently in both the main window and the settings window) and one new Tauri-touching data module (`github-releases.ts`, fetch-based, no new Rust command). `main.ts` and `updates-tab.ts` each drive their own instance of the dialog imperatively — there is no cross-window shared dialog instance, only a shared dialog *component*.

**Tech Stack:** Tauri v2 (Rust + `tauri-plugin-updater` 2.x, `tauri-plugin-process` 2.x), vanilla TypeScript, Vitest + jsdom, GitHub Actions + GitHub CLI (`gh`).

## Global Constraints

- **No Apple notarization in this plan** (user confirmed 2026-07-21) — the app ships exactly as unsigned as it does today. Only the free, self-generated Tauri update-signature (Ed25519 keypair via `tauri signer generate`) is wired up. Do not add `codesign`/`notarytool`/`APPLE_*` secrets.
- **IDs are content-addressed (D6)** — not touched by this plan; no new document/section/paragraph IDs are introduced.
- **Animate `opacity` only** — the update dialog and its progress bar use plain CSS (no layout-affecting transitions); if any transition is added, it must be `opacity` only per D1.
- **`main.ts` owns all lifecycles; components dispatch/subscribe, never hold private state accessed from outside** — `update-dialog.ts` follows the existing `mountX(root, opts) → handle` pattern (see `mountStatusBadge`, `mountThemeSwitcher`), not a singleton.
- **`no-restricted-imports`: no `@tauri-apps/*` under `src/engine/**` or `src/ui/**`.** `update-dialog.ts` lives under `src/ui/` and must stay Tauri-free — all data (version, notes, progress bytes) is passed in as plain options; `main.ts` and `updates-tab.ts` own the actual `@tauri-apps/plugin-updater` calls.
- **Rust settings persistence follows the existing `ConfigStore`/`PromptTemplates` pattern exactly**: `#[serde(default)]`, `skip_serializing_if` on the default value, commands take/return the whole sub-struct, never partial fields.
- **Toggle microcopy is fixed, verbatim** (user-approved):
  - "Automatically check for updates."
  - "Automatically download and install updates."
  - Hint: "The updates are downloaded in the background. The app will ask to restart to apply the update."
  - CTA: "Check for Updates now"
- **Buy Me a Coffee URL is fixed**: `https://buymeacoffee.com/fgheorghiu`.
- Every task that touches Rust ends with `cd src-tauri && cargo test`; every task that touches TypeScript ends with `npm test` (Vitest) and, where the task touches `settings-form.ts`/`main.ts` wiring, `npm run build` (tsc + vite build) as a compile sanity check.

---

## PR 1 — Update engine + release pipeline (no user-visible UI)

### Task 1: Add updater + process plugin dependencies, register them, grant capabilities

No behavior change yet — this task only makes the plugins compile and load. Verified by a clean build, not a new test (there is nothing testable yet).

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Modify: `src-tauri/src/lib.rs:14-46`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/capabilities/settings.json`

**Interfaces:**
- Produces: the `tauri_plugin_updater` and `tauri_plugin_process` Rust crates registered in the app builder, and the `@tauri-apps/plugin-updater` / `@tauri-apps/plugin-process` JS packages available to import from any TS module in later tasks.

- [ ] **Step 1: Add the Rust dependencies**

Edit `src-tauri/Cargo.toml`, in the `[dependencies]` block (after the existing `tauri-plugin-dialog = "2.7.1"` line):

```toml
tauri-plugin-updater = "2"
tauri-plugin-process = "2"
```

- [ ] **Step 2: Add the JS dependencies**

```bash
npm install @tauri-apps/plugin-updater@^2 @tauri-apps/plugin-process@^2
```

- [ ] **Step 3: Register both plugins in the Tauri builder**

In `src-tauri/src/lib.rs`, add the two plugins next to the existing ones (line 14-16 currently reads):

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
```

Change to:

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
```

- [ ] **Step 4: Grant permissions in both windows' capabilities**

Both windows independently mount their own instance of the update dialog (main window: automatic checks + empty-state banner; settings window: the Updates tab's manual check), so both need the updater and restart permissions. Edit `src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:menu:default",
    "core:window:default",
    "core:window:allow-start-dragging",
    "opener:default",
    "dialog:default",
    "updater:default",
    "process:allow-restart"
  ]
}
```

Edit `src-tauri/capabilities/settings.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "settings",
  "description": "Capability for the Settings window (§8.3) — includes updater:default/process:allow-restart because the Updates tab hosts its own update-dialog instance for manual checks.",
  "windows": ["settings"],
  "permissions": [
    "core:default",
    "updater:default",
    "process:allow-restart"
  ]
}
```

- [ ] **Step 5: Verify it compiles**

```bash
cd src-tauri && cargo check
```
Expected: compiles cleanly (may take a while the first time as the two new crates and their dependencies build).

```bash
npm run build
```
Expected: `tsc` + `vite build` succeed with no errors (nothing imports the new JS packages yet, so this just confirms `npm install` resolved cleanly).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock package.json package-lock.json src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/capabilities/settings.json
git commit -m "Add tauri-plugin-updater and tauri-plugin-process, grant capabilities"
```

---

### Task 2: Generate the signing keypair and configure `tauri.conf.json`

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: a real Ed25519 public key embedded in `tauri.conf.json` at `plugin.updater.pubkey`, and the matching private key + password held only as GitHub Actions secrets (Task 3 consumes them).

- [ ] **Step 1: Generate the keypair**

```bash
npx tauri signer generate -w ~/.tauri/semantic-zoom-updater.key
```

This prompts for a password (used to encrypt the private key file) and prints the **public key** to stdout. Two files are written: `~/.tauri/semantic-zoom-updater.key` (private, encrypted) and `~/.tauri/semantic-zoom-updater.key.pub` (public — same value as printed to stdout). Neither of these paths is inside the repo; **do not** copy the private key file into the project.

- [ ] **Step 2: Add the `updater` block to `tauri.conf.json`**

Add a new top-level `"plugin"` key (sibling of `"bundle"`) with the public key from Step 1 pasted in verbatim:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "semantic-zoom",
  "version": "0.8.0",
  "identifier": "com.floringheorghiu.semantic-zoom",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [
      {
        "title": "Semantic Zoom",
        "width": 980,
        "height": 760,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true,
        "transparent": false,
        "resizable": true,
        "maximizable": true,
        "minimizable": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "resources": ["resources/help.md"],
    "macOS": {
      "minimumSystemVersion": "12.0",
      "dmg": {
        "windowSize": { "width": 660, "height": 400 },
        "appPosition": { "x": 180, "y": 170 },
        "applicationFolderPosition": { "x": 480, "y": 170 }
      }
    },
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  },
  "plugin": {
    "updater": {
      "endpoints": [
        "https://github.com/floringheorghiu/semantic-zoom/releases/latest/download/latest.json"
      ],
      "pubkey": "PASTE_THE_GENERATED_PUBLIC_KEY_HERE"
    }
  }
}
```

- [ ] **Step 2.5: Sanity-check the JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json','utf8')); console.log('valid JSON')"
```
Expected: `valid JSON`.

- [ ] **Step 3: Verify the app still builds with the real config**

```bash
cd src-tauri && cargo check
```
Expected: compiles cleanly — an invalid/missing pubkey format would fail here.

- [ ] **Step 4: Store the private key + password as GitHub Actions secrets**

In the repo's GitHub settings → Secrets and variables → Actions, add:
- `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `~/.tauri/semantic-zoom-updater.key`.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen in Step 1.

This is a manual step in the GitHub UI (or `gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/semantic-zoom-updater.key` / `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) — nothing to commit for it.

- [ ] **Step 5: Commit the config (never the key files)**

```bash
git status  # confirm ~/.tauri/* is NOT in this list — it's outside the repo, but double-check
git add src-tauri/tauri.conf.json
git commit -m "Configure the Tauri updater plugin (endpoint + signing pubkey)"
```

---

### Task 3: GitHub Actions release workflow

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `scripts/generate-latest-json.mjs`

**Interfaces:**
- Consumes: `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secrets (Task 2), the `npm run build:dmg` script (existing, `package.json:16`).
- Produces: on every `v*` tag push, a GitHub Release containing the signed DMG, the signed `.app.tar.gz` update artifact, and a `latest.json` manifest the updater plugin's `endpoints` (Task 2) can fetch.

- [ ] **Step 1: Write the manifest-generator script**

Create `scripts/generate-latest-json.mjs`:

```js
#!/usr/bin/env node
// generate-latest-json.mjs — assembles latest.json (the Tauri updater's
// manifest format) from the just-built, just-signed macOS update artifact
// plus the GitHub release notes for this tag. Run in CI (release.yml)
// AFTER `gh release create` has published the release (so its notes exist)
// and AFTER `npm run build:dmg` has produced the signed .app.tar.gz.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const tag = process.argv[2];
if (!tag) {
  console.error('usage: generate-latest-json.mjs <tag>');
  process.exit(1);
}
const version = tag.replace(/^v/, '');

const macosDir = 'src-tauri/target/release/bundle/macos';
const files = readdirSync(macosDir);
const tarballName = files.find((f) => f.endsWith('.app.tar.gz'));
const sigName = files.find((f) => f.endsWith('.app.tar.gz.sig'));
if (!tarballName || !sigName) {
  console.error(`generate-latest-json: no .app.tar.gz/.sig found in ${macosDir}`);
  process.exit(1);
}
const signature = readFileSync(`${macosDir}/${sigName}`, 'utf8').trim();

const notes = execSync(`gh release view "${tag}" --json body -q .body`, { encoding: 'utf8' });
const arch = execSync('uname -m', { encoding: 'utf8' }).trim() === 'arm64' ? 'aarch64' : 'x86_64';
const platformKey = `darwin-${arch}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    [platformKey]: {
      signature,
      url: `https://github.com/floringheorghiu/semantic-zoom/releases/download/${tag}/${tarballName}`,
    },
  },
};

writeFileSync('latest.json', JSON.stringify(manifest, null, 2));
console.log(`generate-latest-json: wrote latest.json for ${platformKey} ${version}`);
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - "v*"

jobs:
  release:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: dtolnay/rust-toolchain@stable

      - name: Install frontend dependencies
        run: npm ci

      # Reuses the same script a human runs locally today (tauri build +
      # finalize-dmg.sh's Finder icon-size polish) — the signing env vars
      # make `tauri build` also emit the signed .app.tar.gz update artifact
      # alongside the .dmg installer, with no extra flags needed.
      - name: Build, sign, and finalize the DMG
        env:
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        run: npm run build:dmg

      - name: Create GitHub release (auto-generated notes from merged PRs)
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "${{ github.ref_name }}" --title "${{ github.ref_name }}" --generate-notes

      - name: Generate latest.json from the signed artifact + release notes
        env:
          GH_TOKEN: ${{ github.token }}
        run: node scripts/generate-latest-json.mjs "${{ github.ref_name }}"

      - name: Upload release artifacts
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          DMG="$(ls src-tauri/target/release/bundle/dmg/*.dmg)"
          TARBALL="$(ls src-tauri/target/release/bundle/macos/*.app.tar.gz)"
          SIG="$(ls src-tauri/target/release/bundle/macos/*.app.tar.gz.sig)"
          gh release upload "${{ github.ref_name }}" "$DMG" "$TARBALL" "$SIG" latest.json --clobber
```

**Known risk to watch on the first real run:** `finalize-dmg.sh` drives Finder via `osascript` (icon-view sizing) — this has historically been the flakiest part of the *local* release process (see the project's DMG-flakiness history) and has never been run unattended in CI before. If it hangs or fails on `macos-latest` runners, the fallback is to drop the `finalize-dmg.sh` call from the CI path (run plain `tauri build` for CI, keep `npm run build:dmg` for local/manual releases) — the updater itself never looks at DMG Finder-window cosmetics, only the `.app.tar.gz` artifact.

- [ ] **Step 3: Verify the workflow YAML is well-formed**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('valid YAML')"
```
Expected: `valid YAML`. (If `pyyaml` isn't available, `node -e "require('js-yaml')"` isn't installed either — a quick manual read-through of indentation is an acceptable substitute; don't add a new dependency just for this check.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml scripts/generate-latest-json.mjs
git commit -m "Add GitHub Actions release workflow (build, sign, publish, latest.json)"
```

- [ ] **Step 5: Real verification (cannot be automated — do this before calling PR 1 done)**

Bump the version in `package.json` and `src-tauri/tauri.conf.json` to a throwaway pre-release value (e.g. `0.8.1-test.0`), commit, tag it (`git tag v0.8.1-test.0`), push the tag, and watch the Actions run. Confirm: the release is created, `latest.json` is attached and has a `darwin-aarch64` (or `-x86_64`) entry with a non-empty `signature`, and the `.dmg`/`.app.tar.gz` download links resolve. Delete the test tag/release afterward (`gh release delete v0.8.1-test.0`, `git tag -d v0.8.1-test.0 && git push origin :v0.8.1-test.0`) and revert the throwaway version bump.

---

## PR 2 — Update dialog, Updates tab, empty-state banner

### Task 4: `UpdatePrefs` settings persistence

**Files:**
- Modify: `src-tauri/src/commands/provider_config.rs`

**Interfaces:**
- Produces: `pub struct UpdatePrefs { pub auto_check: bool, pub auto_install: bool, pub skipped_version: Option<String> }` (serde `camelCase`), `get_update_prefs(app) -> Result<UpdatePrefs, String>`, `set_update_prefs(app, prefs: UpdatePrefs) -> Result<(), String>`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block in `src-tauri/src/commands/provider_config.rs` (after `prompt_templates_round_trip`):

```rust
    #[test]
    fn update_prefs_default_when_never_written() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "update-prefs-default"
        ));
        let _ = fs::remove_dir_all(&dir);

        let store = read_store(&dir);
        assert_eq!(store.update_prefs, UpdatePrefs::default());
        assert!(store.update_prefs.auto_check);
        assert!(store.update_prefs.auto_install);
        assert_eq!(store.update_prefs.skipped_version, None);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn update_prefs_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "update-prefs-roundtrip"
        ));
        let _ = fs::remove_dir_all(&dir);

        let prefs = UpdatePrefs {
            auto_check: false,
            auto_install: true,
            skipped_version: Some("0.9.0".to_string()),
        };
        let mut store = read_store(&dir);
        store.update_prefs = prefs.clone();
        fs::create_dir_all(&dir).unwrap();
        let json = serde_json::to_string_pretty(&store).unwrap();
        fs::write(dir.join(CONFIG_FILE), json).unwrap();

        let reread = read_store(&dir);
        assert_eq!(reread.update_prefs, prefs);

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pre_update_prefs_config_file_reads_clean() {
        let dir = std::env::temp_dir().join(format!(
            "szoom-provider-config-test-{}-{}",
            std::process::id(),
            "pre-update-prefs"
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // A file written before `update_prefs` existed: no `updatePrefs` key.
        fs::write(
            dir.join(CONFIG_FILE),
            r#"{"kind":"remote","base_url":"https://api.cerebras.ai/v1","model":"llama3.1-8b"}"#,
        )
        .unwrap();

        let store = read_store(&dir);
        assert_eq!(store.update_prefs, UpdatePrefs::default());

        fs::remove_dir_all(&dir).ok();
    }
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd src-tauri && cargo test update_prefs
```
Expected: FAIL — `UpdatePrefs` is not defined, `ConfigStore` has no field `update_prefs`.

- [ ] **Step 3: Add the `UpdatePrefs` struct**

Add above the `PromptTemplates` struct (after `CustomTemplate`, before line 145's `PromptTemplates` doc comment):

```rust
fn default_true() -> bool {
    true
}

/// Non-secret update preferences. `skipped_version` is written by the
/// update-found dialog's "Skip This Version" action; only the automatic
/// (main-window, startup) check path reads it — a manual "Check for
/// Updates now" always shows the dialog regardless.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrefs {
    #[serde(default = "default_true")]
    pub auto_check: bool,
    #[serde(default = "default_true")]
    pub auto_install: bool,
    #[serde(default)]
    pub skipped_version: Option<String>,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        UpdatePrefs {
            auto_check: true,
            auto_install: true,
            skipped_version: None,
        }
    }
}

fn is_default_update_prefs(p: &UpdatePrefs) -> bool {
    *p == UpdatePrefs::default()
}
```

- [ ] **Step 4: Add the field to `ConfigStore`**

Edit the `ConfigStore` struct (currently lines 176-186):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct ConfigStore {
    #[serde(flatten)]
    active: ProviderConfig,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    saved: HashMap<ProviderKind, ProviderConfig>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    saved_providers: HashMap<Provider, ProviderConfig>,
    #[serde(default, skip_serializing_if = "is_default_templates")]
    prompt_templates: PromptTemplates,
    #[serde(default, skip_serializing_if = "is_default_update_prefs")]
    update_prefs: UpdatePrefs,
}
```

And its `Default` impl (currently lines 188-197):

```rust
impl Default for ConfigStore {
    fn default() -> Self {
        ConfigStore {
            active: ProviderConfig::default(),
            saved: HashMap::new(),
            saved_providers: HashMap::new(),
            prompt_templates: PromptTemplates::default(),
            update_prefs: UpdatePrefs::default(),
        }
    }
}
```

- [ ] **Step 5: Add the two commands**

Add after `set_prompt_templates` (end of that function, before the `#[cfg(test)]` block):

```rust
#[tauri::command]
pub fn get_update_prefs(app: tauri::AppHandle) -> Result<UpdatePrefs, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(read_store(&dir).update_prefs)
}

#[tauri::command]
pub fn set_update_prefs(app: tauri::AppHandle, prefs: UpdatePrefs) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut store = read_store(&dir);
    store.update_prefs = prefs;
    let path = dir.join(CONFIG_FILE);
    let json = serde_json::to_string_pretty(&store).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
```

- [ ] **Step 6: Register the commands**

In `src-tauri/src/lib.rs`, add to `invoke_handler(tauri::generate_handler![...])` (after `commands::provider_config::set_prompt_templates,`):

```rust
            commands::provider_config::get_update_prefs,
            commands::provider_config::set_update_prefs,
```

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
cd src-tauri && cargo test update_prefs
```
Expected: 3 passed (`update_prefs_default_when_never_written`, `update_prefs_round_trip`, `pre_update_prefs_config_file_reads_clean`).

```bash
cd src-tauri && cargo test
```
Expected: full suite still passes (no regressions in the existing `provider_config` tests).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/commands/provider_config.rs src-tauri/src/lib.rs
git commit -m "Add UpdatePrefs settings persistence (get_update_prefs/set_update_prefs)"
```

---

### Task 5: `request_update_check` command (settings window → main window signal)

The Updates tab's "Check for Updates now" button runs in the settings *window*, but per Task 4's design each window hosts its own dialog instance — so this command is NOT needed for the dialog to appear (Task 10 has the settings tab drive its own local check + dialog directly). It exists for one specific reason: keeping the **main window's** empty-state banner in sync if a manual check from Settings finds an update while the main window is sitting on the empty state. Skipping it would mean the empty-state banner only ever reflects the *last automatic* check, not a manual one triggered from Settings.

**Files:**
- Modify: `src-tauri/src/commands/window.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Produces: `request_update_check(app) -> Result<(), String>` — emits a `"update://check-requested"` event to the `"main"` window if it exists (no-op otherwise). Task 13 wires `main.ts` to `listen('update://check-requested', ...)`.

- [ ] **Step 1: Add the command**

Edit `src-tauri/src/commands/window.rs`:

```rust
// window.rs — Settings window lifecycle (§8.3). A second native Tauri
// window bundling only settings.html / src/native/settings-form.ts — it
// never loads the document viewport, store, or engine modules, so it has
// nothing to leak even by accident.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
pub fn open_settings_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        return w.set_focus().map_err(|e| e.to_string());
    }
    WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Settings")
        .inner_size(460.0, 610.0)
        .resizable(false)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Lets the settings window's manual "Check for Updates now" keep the main
/// window's empty-state banner in sync — the dialog itself is NOT shared
/// across windows (each window mounts its own instance), this only nudges
/// the main window to also re-run its own check so its banner state is
/// current. A no-op if the main window doesn't exist (shouldn't happen in
/// practice — there's always exactly one main window).
#[tauri::command]
pub fn request_update_check(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.emit("update://check-requested", ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}
```

- [ ] **Step 2: Register the command**

In `src-tauri/src/lib.rs`, add after `commands::window::open_settings_window,`:

```rust
            commands::window::request_update_check,
```

- [ ] **Step 3: Verify it compiles**

```bash
cd src-tauri && cargo check
```
Expected: compiles cleanly.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/window.rs src-tauri/src/lib.rs
git commit -m "Add request_update_check command (settings → main window sync signal)"
```

---

### Task 6: `github-releases.ts` — fetch + version-compare helper

**Files:**
- Create: `src/native/github-releases.ts`
- Test: `src/native/github-releases.test.ts`

**Interfaces:**
- Produces:
  - `export interface ReleaseNote { version: string; notesMarkdown: string }`
  - `export function compareVersions(a: string, b: string): number` (like `Array.prototype.sort` comparators: negative if `a < b`, 0 if equal, positive if `a > b`; numeric per-segment on `x.y.z`, non-numeric trailing text ignored)
  - `export async function fetchReleasesSince(currentVersion: string): Promise<ReleaseNote[]>` — every GitHub release with a tag version strictly greater than `currentVersion`, newest first, `v` prefix stripped from tag names.
- Consumes: nothing (plain `fetch()` against `https://api.github.com`).

- [ ] **Step 1: Write the failing tests**

Create `src/native/github-releases.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, fetchReleasesSince } from './github-releases';

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.9.0', '0.9.0')).toBe(0);
  });

  it('treats a missing patch segment as 0', () => {
    expect(compareVersions('0.9', '0.9.0')).toBe(0);
    expect(compareVersions('0.9.1', '0.9')).toBeGreaterThan(0);
  });
});

describe('fetchReleasesSince', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns releases newer than currentVersion, newest first, v-prefix stripped', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        { tag_name: 'v0.10.0', body: 'Fixed things.' },
        { tag_name: 'v0.9.0', body: 'Added stuff.' },
        { tag_name: 'v0.8.0', body: 'Old release.' },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);

    const releases = await fetchReleasesSince('0.8.0');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/floringheorghiu/semantic-zoom/releases',
    );
    expect(releases).toEqual([
      { version: '0.10.0', notesMarkdown: 'Fixed things.' },
      { version: '0.9.0', notesMarkdown: 'Added stuff.' },
    ]);
  });

  it('returns an empty list when the fetch fails, rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => [] }));
    await expect(fetchReleasesSince('0.8.0')).resolves.toEqual([]);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test -- github-releases
```
Expected: FAIL — `src/native/github-releases.ts` doesn't exist.

- [ ] **Step 3: Implement**

Create `src/native/github-releases.ts`:

```ts
// github-releases.ts — fetch-based GitHub Releases access for the update
// dialog's stacked release-notes list and the Updates tab's changelog
// panel. Deliberately Tauri-free (plain fetch, no @tauri-apps/* import) so
// it's importable from anywhere without touching the no-restricted-imports
// boundary — the actual update *detection*/*install* goes through
// @tauri-apps/plugin-updater separately (main.ts / updates-tab.ts own
// that), this module only supplies the human-readable notes text.

const REPO = 'floringheorghiu/semantic-zoom';

export interface ReleaseNote {
  version: string;
  notesMarkdown: string;
}

interface GitHubRelease {
  tag_name: string;
  body: string | null;
}

/** Numeric per-segment compare on `x.y.z` tags (missing segments = 0). Not
    full semver (no pre-release/build metadata handling) — this app's tags
    are plain `vMAJOR.MINOR.PATCH`, so that's all this needs to get right. */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.').map((n) => parseInt(n, 10) || 0);
  const bs = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Every published release newer than `currentVersion`, newest first.
    Returns an empty list on any fetch/parse failure rather than throwing —
    a changelog panel that fails to load is a degraded UI, not a crash. */
export async function fetchReleasesSince(currentVersion: string): Promise<ReleaseNote[]> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`);
    if (!res.ok) return [];
    const releases = (await res.json()) as GitHubRelease[];
    return releases
      .map((r) => ({ version: r.tag_name.replace(/^v/, ''), notesMarkdown: r.body ?? '' }))
      .filter((r) => compareVersions(r.version, currentVersion) > 0)
      .sort((a, b) => compareVersions(b.version, a.version));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: Run to confirm it passes**

```bash
npm test -- github-releases
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/native/github-releases.ts src/native/github-releases.test.ts
git commit -m "Add github-releases.ts: fetch + version-compare for the update UI"
```

---

### Task 7: `update-dialog.ts` — found-update view

**Files:**
- Create: `src/ui/update-dialog.ts`
- Create: `src/styles/update-dialog.css`
- Test: `src/ui/update-dialog.test.ts`

**Interfaces:**
- Consumes: `ReleaseNote` from `../native/github-releases` (type only — this module stays Tauri-free, `github-releases.ts` itself has no Tauri import either, so this is a safe type-only dependency).
- Produces:
  - `export interface FoundUpdateOptions { currentVersion: string; latestVersion: string; releaseNotes: ReleaseNote[]; autoInstall: boolean; onAutoInstallChange: (value: boolean) => void; onSkip: () => void; onRemindLater: () => void; onInstall: () => void }`
  - `export interface UpdateDialogHandle { showFound: (opts: FoundUpdateOptions) => void; showProgress: (opts: DownloadProgressOptions) => void; updateProgress: (downloadedBytes: number, totalBytes: number) => void; close: () => void }` (the `DownloadProgressOptions`/`updateProgress` half is added in Task 8 — this task defines the interface shape but only implements `showFound`/`close`)
  - `export function mountUpdateDialog(root: HTMLElement): UpdateDialogHandle`

- [ ] **Step 1: Write the failing tests**

Create `src/ui/update-dialog.test.ts`:

```ts
import { test, expect, vi } from 'vitest';
import { mountUpdateDialog } from './update-dialog';

function foundOpts(overrides: Partial<Parameters<ReturnType<typeof mountUpdateDialog>['showFound']>[0]> = {}) {
  return {
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    releaseNotes: [{ version: '0.9.0', notesMarkdown: 'Fixed things.' }],
    autoInstall: true,
    onAutoInstallChange: vi.fn(),
    onSkip: vi.fn(),
    onRemindLater: vi.fn(),
    onInstall: vi.fn(),
    ...overrides,
  };
}

test('showFound renders the headline, version line, and release notes', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(foundOpts());

  expect(root.querySelector('.update-dialog__headline')?.textContent).toContain('Semantic Zoom');
  expect(root.querySelector('.update-dialog__version-line')?.textContent).toContain('0.8.0');
  expect(root.querySelector('.update-dialog__version-line')?.textContent).toContain('0.9.0');
  expect(root.querySelector('.update-dialog__notes')?.textContent).toContain('Fixed things.');
});

test('the auto-install checkbox reflects the given state and reports changes', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onAutoInstallChange = vi.fn();
  handle.showFound(foundOpts({ autoInstall: false, onAutoInstallChange }));

  const checkbox = root.querySelector<HTMLInputElement>('.update-dialog__auto-install');
  expect(checkbox?.checked).toBe(false);

  checkbox!.checked = true;
  checkbox!.dispatchEvent(new Event('change'));
  expect(onAutoInstallChange).toHaveBeenCalledWith(true);
});

test('Skip This Version calls onSkip and closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onSkip = vi.fn();
  handle.showFound(foundOpts({ onSkip }));

  root.querySelector<HTMLButtonElement>('.update-dialog__skip')!.click();
  expect(onSkip).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('Remind Me Later calls onRemindLater and closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onRemindLater = vi.fn();
  handle.showFound(foundOpts({ onRemindLater }));

  root.querySelector<HTMLButtonElement>('.update-dialog__remind-later')!.click();
  expect(onRemindLater).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('Install Update calls onInstall and leaves the dialog open (caller switches to progress)', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onInstall = vi.fn();
  handle.showFound(foundOpts({ onInstall }));

  root.querySelector<HTMLButtonElement>('.update-dialog__install')!.click();
  expect(onInstall).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBe(true);
});

test('close() closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(foundOpts());
  expect(root.querySelector('dialog')?.open).toBe(true);

  handle.close();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('renders one heading per release when there are several unreleased-to-the-user versions', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound(
    foundOpts({
      releaseNotes: [
        { version: '0.9.0', notesMarkdown: 'Newest.' },
        { version: '0.8.1', notesMarkdown: 'Older.' },
      ],
    }),
  );

  const headings = root.querySelectorAll('.update-dialog__notes-version');
  expect(headings).toHaveLength(2);
  expect(headings[0].textContent).toBe('0.9.0');
  expect(headings[1].textContent).toBe('0.8.1');
});
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npm test -- update-dialog
```
Expected: FAIL — `src/ui/update-dialog.ts` doesn't exist.

- [ ] **Step 3: Implement `showFound` and `close`**

Create `src/ui/update-dialog.ts`:

```ts
// update-dialog.ts — the Sparkle/Typora-style "update found" + download-
// progress dialog. Mounted independently by BOTH main.ts (main window:
// automatic checks) and updates-tab.ts (settings window: manual checks) —
// there is no cross-window shared instance, just a shared component.
// Tauri-free by design (no-restricted-imports, src/ui/**): all data comes
// in as plain options, all actions go out as plain callbacks. Follows the
// mountX(root, opts) -> handle pattern (mountStatusBadge, mountThemeSwitcher),
// not empty-state.ts's mount-per-state-change pattern, because this dialog
// needs live updates during a download (Task 8).
import type { ReleaseNote } from '../native/github-releases';

export interface FoundUpdateOptions {
  currentVersion: string;
  latestVersion: string;
  /** Every release newer than currentVersion, newest first. */
  releaseNotes: ReleaseNote[];
  autoInstall: boolean;
  onAutoInstallChange: (value: boolean) => void;
  onSkip: () => void;
  onRemindLater: () => void;
  onInstall: () => void;
}

export interface DownloadProgressOptions {
  downloadedBytes: number;
  totalBytes: number;
  onCancel: () => void;
}

export interface UpdateDialogHandle {
  showFound: (opts: FoundUpdateOptions) => void;
  showProgress: (opts: DownloadProgressOptions) => void;
  updateProgress: (downloadedBytes: number, totalBytes: number) => void;
  close: () => void;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Mount the (initially empty, closed) dialog shell into `root`. Call
    showFound/showProgress to populate and open it. */
export function mountUpdateDialog(root: HTMLElement): UpdateDialogHandle {
  const dialog = document.createElement('dialog');
  dialog.className = 'update-dialog';
  root.appendChild(dialog);

  let onCancelCallback: (() => void) | null = null;

  function renderFound(opts: FoundUpdateOptions): void {
    dialog.replaceChildren();

    const icon = document.createElement('div');
    icon.className = 'update-dialog__icon';
    dialog.appendChild(icon);

    const headline = document.createElement('h2');
    headline.className = 'update-dialog__headline';
    headline.textContent = 'A new version of Semantic Zoom is available!';
    dialog.appendChild(headline);

    const versionLine = document.createElement('p');
    versionLine.className = 'update-dialog__version-line';
    versionLine.textContent = `Semantic Zoom ${opts.latestVersion} is now available — you have ${opts.currentVersion}.`;
    dialog.appendChild(versionLine);

    const notesLabel = document.createElement('p');
    notesLabel.className = 'update-dialog__notes-label';
    notesLabel.textContent = 'Release Notes:';
    dialog.appendChild(notesLabel);

    const notes = document.createElement('div');
    notes.className = 'update-dialog__notes';
    for (const release of opts.releaseNotes) {
      const versionHeading = document.createElement('h3');
      versionHeading.className = 'update-dialog__notes-version';
      versionHeading.textContent = release.version;
      notes.appendChild(versionHeading);

      const body = document.createElement('p');
      body.textContent = release.notesMarkdown;
      notes.appendChild(body);
    }
    dialog.appendChild(notes);

    const checkboxLabel = document.createElement('label');
    checkboxLabel.className = 'update-dialog__checkbox-field';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'update-dialog__auto-install';
    checkbox.checked = opts.autoInstall;
    checkbox.addEventListener('change', () => opts.onAutoInstallChange(checkbox.checked));
    checkboxLabel.appendChild(checkbox);
    checkboxLabel.appendChild(document.createTextNode('Automatically download and install updates in the future'));
    dialog.appendChild(checkboxLabel);

    const actions = document.createElement('div');
    actions.className = 'update-dialog__actions';

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'update-dialog__skip';
    skip.textContent = 'Skip This Version';
    skip.addEventListener('click', () => {
      opts.onSkip();
      dialog.close();
    });
    actions.appendChild(skip);

    const remindLater = document.createElement('button');
    remindLater.type = 'button';
    remindLater.className = 'update-dialog__remind-later';
    remindLater.textContent = 'Remind Me Later';
    remindLater.addEventListener('click', () => {
      opts.onRemindLater();
      dialog.close();
    });
    actions.appendChild(remindLater);

    const install = document.createElement('button');
    install.type = 'button';
    install.className = 'update-dialog__install';
    install.textContent = 'Install Update';
    install.addEventListener('click', () => opts.onInstall());
    actions.appendChild(install);

    dialog.appendChild(actions);

    if (!dialog.open) dialog.showModal();
  }

  function renderProgress(opts: DownloadProgressOptions): void {
    dialog.replaceChildren();
    onCancelCallback = opts.onCancel;

    const icon = document.createElement('div');
    icon.className = 'update-dialog__icon';
    dialog.appendChild(icon);

    const headline = document.createElement('h2');
    headline.className = 'update-dialog__headline';
    headline.textContent = 'Updating Semantic Zoom';
    dialog.appendChild(headline);

    const label = document.createElement('p');
    label.className = 'update-dialog__progress-label';
    label.textContent = 'Downloading update…';
    dialog.appendChild(label);

    const track = document.createElement('div');
    track.className = 'update-dialog__progress-track';
    const bar = document.createElement('div');
    bar.className = 'update-dialog__progress-bar';
    track.appendChild(bar);
    dialog.appendChild(track);

    const byteCount = document.createElement('p');
    byteCount.className = 'update-dialog__progress-bytes';
    dialog.appendChild(byteCount);

    const actions = document.createElement('div');
    actions.className = 'update-dialog__actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'update-dialog__cancel';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      onCancelCallback?.();
      dialog.close();
    });
    actions.appendChild(cancel);
    dialog.appendChild(actions);

    if (!dialog.open) dialog.showModal();
    applyProgress(opts.downloadedBytes, opts.totalBytes);
  }

  function applyProgress(downloadedBytes: number, totalBytes: number): void {
    const bar = dialog.querySelector<HTMLElement>('.update-dialog__progress-bar');
    const byteCount = dialog.querySelector<HTMLElement>('.update-dialog__progress-bytes');
    if (!bar || !byteCount) return; // showProgress hasn't been called yet
    const pct = totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0;
    bar.style.width = `${pct}%`;
    byteCount.textContent = `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`;
  }

  return {
    showFound: renderFound,
    showProgress: renderProgress,
    updateProgress: applyProgress,
    close: () => dialog.close(),
  };
}
```

- [ ] **Step 4: Add a minimal stylesheet (import wired in Task 13)**

Create `src/styles/update-dialog.css`:

```css
/* update-dialog.css — the Sparkle/Typora-style update-found + download-
   progress dialog (src/ui/update-dialog.ts). Reuses the app's token system
   (tokens.css) so it looks native to the rest of the app. */

.update-dialog {
  width: min(420px, 90vw);
  padding: 20px;
  border: none;
  border-radius: var(--sz-radius-card);
  background: var(--sz-bg);
  color: var(--sz-ink);
  font: 13px/1.5 var(--sz-font);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.update-dialog::backdrop {
  background: rgba(0, 0, 0, 0.4);
}

.update-dialog__icon {
  width: 48px;
  height: 48px;
  margin-bottom: 12px;
  border-radius: 10px;
  background: var(--sz-accent);
}

.update-dialog__headline {
  margin: 0 0 6px;
  font: 700 15px/1.3 var(--sz-font);
}

.update-dialog__version-line,
.update-dialog__notes-label,
.update-dialog__progress-label {
  margin: 0 0 8px;
  color: var(--sz-muted);
}

.update-dialog__notes {
  max-height: 220px;
  overflow-y: auto;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--sz-border);
  border-radius: 8px;
  background: var(--sz-track);
}

.update-dialog__notes-version {
  margin: 12px 0 4px;
  font: 700 13px/1.3 var(--sz-font);
}

.update-dialog__notes-version:first-child {
  margin-top: 0;
}

.update-dialog__checkbox-field {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
  cursor: pointer;
}

.update-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.update-dialog__actions button {
  font: 600 12.5px/1 var(--sz-font);
  padding: 8px 16px;
  border-radius: var(--sz-radius-pill);
  border: 1px solid transparent;
  cursor: pointer;
}

.update-dialog__install,
.update-dialog__cancel {
  background: var(--sz-btn-bg);
  border-color: var(--sz-btn-border);
  color: var(--sz-ink);
}

.update-dialog__skip {
  margin-right: auto;
  background: transparent;
  color: var(--sz-muted);
}

.update-dialog__remind-later {
  background: var(--sz-accent);
  color: #fff;
}

.update-dialog__progress-track {
  height: 6px;
  margin-bottom: 8px;
  border-radius: 3px;
  background: var(--sz-track);
  overflow: hidden;
}

.update-dialog__progress-bar {
  height: 100%;
  width: 0%;
  background: var(--sz-accent);
}

.update-dialog__progress-bytes {
  margin: 0 0 16px;
  font-size: 12px;
  color: var(--sz-muted);
}
```

- [ ] **Step 5: Run to confirm the tests pass**

```bash
npm test -- update-dialog
```
Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/update-dialog.ts src/ui/update-dialog.test.ts src/styles/update-dialog.css
git commit -m "Add update-dialog.ts: found-update view (release notes, Skip/Remind/Install)"
```

---

### Task 8: `update-dialog.ts` — download progress view

The interface and CSS for this were already defined in Task 7 (`showProgress`/`updateProgress`/`.update-dialog__progress-*` classes); this task is purely test coverage confirming the behavior, since it turned out simpler to implement both views in one file pass. Skipping straight to verification keeps this task honest about what's actually new.

**Files:**
- Test: `src/ui/update-dialog.test.ts` (add to the existing file from Task 7)

**Interfaces:**
- Consumes: `mountUpdateDialog` from Task 7 (already exports `showProgress`/`updateProgress`).

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/update-dialog.test.ts`:

```ts
test('showProgress renders the download view with the given byte counts', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showProgress({ downloadedBytes: 11_000_000, totalBytes: 14_400_000, onCancel: vi.fn() });

  expect(root.querySelector('.update-dialog__headline')?.textContent).toBe('Updating Semantic Zoom');
  expect(root.querySelector('.update-dialog__progress-bytes')?.textContent).toBe('11.0 MB of 14.4 MB');
  const bar = root.querySelector<HTMLElement>('.update-dialog__progress-bar');
  const expectedPct = (11_000_000 / 14_400_000) * 100;
  expect(bar?.style.width).toBe(`${expectedPct}%`);
});

test('updateProgress updates the bar width and byte-count text in place', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showProgress({ downloadedBytes: 0, totalBytes: 10_000_000, onCancel: vi.fn() });

  handle.updateProgress(5_000_000, 10_000_000);

  expect(root.querySelector('.update-dialog__progress-bytes')?.textContent).toBe('5.0 MB of 10.0 MB');
  expect(root.querySelector<HTMLElement>('.update-dialog__progress-bar')?.style.width).toBe('50%');
});

test('Cancel calls onCancel and closes the dialog', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  const onCancel = vi.fn();
  handle.showProgress({ downloadedBytes: 0, totalBytes: 10_000_000, onCancel });

  root.querySelector<HTMLButtonElement>('.update-dialog__cancel')!.click();
  expect(onCancel).toHaveBeenCalledOnce();
  expect(root.querySelector('dialog')?.open).toBeFalsy();
});

test('switching from the found view to the progress view reuses the same dialog element (Install -> download hand-off)', () => {
  const root = document.createElement('div');
  const handle = mountUpdateDialog(root);
  handle.showFound({
    currentVersion: '0.8.0',
    latestVersion: '0.9.0',
    releaseNotes: [],
    autoInstall: false,
    onAutoInstallChange: vi.fn(),
    onSkip: vi.fn(),
    onRemindLater: vi.fn(),
    onInstall: vi.fn(),
  });
  const dialogEl = root.querySelector('dialog');

  handle.showProgress({ downloadedBytes: 0, totalBytes: 1000, onCancel: vi.fn() });

  expect(root.querySelectorAll('dialog')).toHaveLength(1);
  expect(root.querySelector('dialog')).toBe(dialogEl);
  expect(root.querySelector('.update-dialog__install')).toBeNull();
  expect(root.querySelector('.update-dialog__progress-bar')).not.toBeNull();
});
```

- [ ] **Step 2: Run to confirm they pass**

```bash
npm test -- update-dialog
```
Expected: all tests (Task 7's 7 + these 4) pass — Task 7's implementation already covers this behavior, so nothing new to write in `update-dialog.ts` itself. If any fail, it means Task 7's `renderProgress`/`applyProgress` has a bug; fix it there, not by weakening these tests.

- [ ] **Step 3: Commit**

```bash
git add src/ui/update-dialog.test.ts
git commit -m "Add download-progress test coverage for update-dialog.ts"
```

---

### Task 9: `settings.html` + `updates-tab.ts` — version, toggles, check-now, changelog, support link

**Files:**
- Modify: `settings.html`
- Create: `src/native/settings/updates-tab.ts`
- Test: `src/native/settings/updates-tab.test.ts`
- Modify: `src/native/settings-form.ts`
- Modify: `src/styles/settings.css`

**Interfaces:**
- Consumes: `get_update_prefs`/`set_update_prefs` (Task 4), `request_update_check` (Task 5), `fetchReleasesSince`/`compareVersions` (Task 6), `mountUpdateDialog` (Tasks 7-8), `@tauri-apps/plugin-updater`'s `check()`, `@tauri-apps/plugin-process`'s `relaunch()`, `@tauri-apps/plugin-dialog`'s `ask()`, `@tauri-apps/api/app`'s `getVersion()`.
- Produces: `export function initUpdatesTab(): void`.

- [ ] **Step 1: Add the tab markup**

Edit `settings.html` — add the tab button (after the existing `prompt` tab button, line 13):

```html
      <button role="tab" data-tab="updates" aria-selected="false">Updates</button>
```

Add the tab section (after the existing `data-tab="prompt"` section, before `</body>`):

```html
    <section data-tab="updates" hidden>
      <div class="field">
        <span class="field__label">Current version</span>
        <p class="field__hint" id="updates-current-version">—</p>
      </div>
      <div class="row">
        <button id="updates-check-now" type="button">Check for Updates now</button>
      </div>
      <div id="updates-status-line" role="status"></div>
      <label class="checkbox-field">
        <input type="checkbox" id="updates-auto-check" /> Automatically check for updates.
      </label>
      <label class="checkbox-field">
        <input type="checkbox" id="updates-auto-install" /> Automatically download and install updates.
      </label>
      <p class="field__hint">The updates are downloaded in the background. The app will ask to restart to apply the update.</p>
      <div class="field">
        <span class="field__label">Changelog</span>
        <div id="updates-changelog"></div>
      </div>
      <div id="updates-coffee">
        <p>We're now accepting support via Buy Me a Coffee — your one-time or recurring contribution helps keep this project going. If you're able, we'd appreciate it.</p>
        <a id="updates-coffee-link" href="https://buymeacoffee.com/fgheorghiu" target="_blank" rel="noreferrer">Buy Me a Coffee</a>
      </div>
      <div id="updates-dialog-mount"></div>
    </section>
```

`#updates-dialog-mount` is a plain, empty `<div>` — `mountUpdateDialog` (Task 7) creates and appends its own `<dialog>` element into it; nothing here needs to pre-declare a `<dialog>` tag.

- [ ] **Step 2: Write the failing tests**

Create `src/native/settings/updates-tab.test.ts`:

```ts
// updates-tab.test.ts — mocks @tauri-apps/api/core's invoke and
// @tauri-apps/plugin-updater's check, same pattern as inference-tab and
// prompt-tab: this is about the tab's state machine, not the real bridge.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const getVersionMock = vi.fn().mockResolvedValue('0.8.0');
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: () => getVersionMock(),
}));

const checkMock = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: (...args: unknown[]) => checkMock(...args),
}));

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: vi.fn().mockResolvedValue(false),
}));

const fetchReleasesSinceMock = vi.fn().mockResolvedValue([]);
vi.mock('../github-releases', () => ({
  fetchReleasesSince: (...args: unknown[]) => fetchReleasesSinceMock(...args),
  compareVersions: (a: string, b: string) => {
    const as = a.split('.').map(Number);
    const bs = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((as[i] ?? 0) !== (bs[i] ?? 0)) return (as[i] ?? 0) - (bs[i] ?? 0);
    return 0;
  },
}));

import { initUpdatesTab } from './updates-tab';

function setDom(): void {
  document.body.innerHTML = `
    <p id="updates-current-version">—</p>
    <button id="updates-check-now" type="button"></button>
    <div id="updates-status-line"></div>
    <input type="checkbox" id="updates-auto-check" />
    <input type="checkbox" id="updates-auto-install" />
    <div id="updates-changelog"></div>
    <div id="updates-dialog-mount"></div>
  `;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === 'get_update_prefs') {
      return Promise.resolve({ autoCheck: true, autoInstall: false, skippedVersion: null });
    }
    return Promise.resolve(undefined);
  });
  checkMock.mockReset().mockResolvedValue(null);
  fetchReleasesSinceMock.mockReset().mockResolvedValue([]);
  setDom();
});

describe('initUpdatesTab', () => {
  it('shows the current app version', async () => {
    initUpdatesTab();
    await vi.waitFor(() => {
      expect(document.getElementById('updates-current-version')?.textContent).toBe('0.8.0');
    });
  });

  it('loads the saved toggle state into the checkboxes', async () => {
    initUpdatesTab();
    await vi.waitFor(() => {
      expect((document.getElementById('updates-auto-check') as HTMLInputElement).checked).toBe(true);
      expect((document.getElementById('updates-auto-install') as HTMLInputElement).checked).toBe(false);
    });
  });

  it('persists a toggle change via set_update_prefs', async () => {
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    const autoInstall = document.getElementById('updates-auto-install') as HTMLInputElement;
    autoInstall.checked = true;
    autoInstall.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_update_prefs', {
        prefs: { autoCheck: true, autoInstall: true, skippedVersion: null },
      });
    });
  });

  it('"Check for Updates now" with no update available shows an up-to-date message', async () => {
    checkMock.mockResolvedValue(null);
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    document.getElementById('updates-check-now')!.click();

    await vi.waitFor(() => {
      expect(document.getElementById('updates-status-line')?.textContent).toContain('up to date');
    });
  });

  it('"Check for Updates now" with an update available opens the dialog and syncs the main window', async () => {
    checkMock.mockResolvedValue({ version: '0.9.0', downloadAndInstall: vi.fn() });
    fetchReleasesSinceMock.mockResolvedValue([{ version: '0.9.0', notesMarkdown: 'Fixed things.' }]);
    initUpdatesTab();
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('get_update_prefs'));

    document.getElementById('updates-check-now')!.click();

    await vi.waitFor(() => {
      expect(document.getElementById('updates-dialog-mount')?.querySelector('dialog')?.open).toBe(true);
      expect(invokeMock).toHaveBeenCalledWith('request_update_check');
    });
  });

  it('renders one changelog entry per fetched release', async () => {
    fetchReleasesSinceMock.mockResolvedValue([
      { version: '0.9.0', notesMarkdown: 'Fixed things.' },
      { version: '0.8.1', notesMarkdown: 'Older fix.' },
    ]);
    initUpdatesTab();

    await vi.waitFor(() => {
      const entries = document.querySelectorAll('#updates-changelog .updates-changelog__entry');
      expect(entries).toHaveLength(2);
      expect(entries[0].textContent).toContain('0.9.0');
      expect(entries[0].textContent).toContain('Fixed things.');
    });
  });
});
```

- [ ] **Step 3: Run to confirm it fails**

```bash
npm test -- updates-tab
```
Expected: FAIL — `src/native/settings/updates-tab.ts` doesn't exist.

- [ ] **Step 4: Implement**

Create `src/native/settings/updates-tab.ts`:

```ts
// updates-tab.ts — Updates tab (version, toggles, manual check, changelog,
// Buy Me a Coffee). This tab OWNS its own update-dialog.ts instance (see
// that module's header comment: no cross-window shared instance). Manual
// checks here always ignore skippedVersion — only the automatic,
// main-window startup check honors it.
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check as checkForUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { ask } from '@tauri-apps/plugin-dialog';
import { mountUpdateDialog } from '../../ui/update-dialog';
import { fetchReleasesSince } from '../github-releases';

interface UpdatePrefs {
  autoCheck: boolean;
  autoInstall: boolean;
  skippedVersion: string | null;
}

export function initUpdatesTab(): void {
  function el<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (!found) throw new Error(`updates-tab: missing #${id}`);
    return found as T;
  }

  const currentVersionEl = el<HTMLElement>('updates-current-version');
  const checkNowButton = el<HTMLButtonElement>('updates-check-now');
  const statusLine = el<HTMLElement>('updates-status-line');
  const autoCheckBox = el<HTMLInputElement>('updates-auto-check');
  const autoInstallBox = el<HTMLInputElement>('updates-auto-install');
  const changelogEl = el<HTMLElement>('updates-changelog');
  const dialogMount = el<HTMLElement>('updates-dialog-mount');

  const dialog = mountUpdateDialog(dialogMount);

  let prefs: UpdatePrefs = { autoCheck: true, autoInstall: true, skippedVersion: null };
  let appVersion = '';

  async function savePrefs(): Promise<void> {
    await invoke('set_update_prefs', { prefs });
  }

  autoCheckBox.addEventListener('change', () => {
    prefs = { ...prefs, autoCheck: autoCheckBox.checked };
    void savePrefs();
  });

  autoInstallBox.addEventListener('change', () => {
    prefs = { ...prefs, autoInstall: autoInstallBox.checked };
    void savePrefs();
  });

  async function runInstall(update: Awaited<ReturnType<typeof checkForUpdate>>): Promise<void> {
    if (!update) return;
    let downloaded = 0;
    let total = 0;
    dialog.showProgress({ downloadedBytes: 0, totalBytes: 0, onCancel: () => {} });
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        dialog.updateProgress(downloaded, total);
      }
    });
    dialog.close();
    const shouldRestart = await ask('Restart Semantic Zoom now to finish updating?', {
      title: 'Update Installed',
    });
    if (shouldRestart) await relaunch();
  }

  async function handleCheckNow(): Promise<void> {
    statusLine.textContent = 'Checking…';
    const update = await checkForUpdate();
    // Keep the main window's empty-state banner in sync with this manual
    // check, whether or not an update was found.
    void invoke('request_update_check');

    if (!update) {
      statusLine.textContent = "You're up to date.";
      return;
    }
    statusLine.textContent = '';

    const releaseNotes = await fetchReleasesSince(appVersion);
    dialog.showFound({
      currentVersion: appVersion,
      latestVersion: update.version,
      releaseNotes: releaseNotes.length > 0 ? releaseNotes : [{ version: update.version, notesMarkdown: update.body ?? '' }],
      autoInstall: prefs.autoInstall,
      onAutoInstallChange: (value) => {
        prefs = { ...prefs, autoInstall: value };
        autoInstallBox.checked = value;
        void savePrefs();
      },
      onSkip: () => {
        prefs = { ...prefs, skippedVersion: update.version };
        void savePrefs();
      },
      onRemindLater: () => {},
      onInstall: () => void runInstall(update),
    });
  }

  checkNowButton.addEventListener('click', () => {
    void handleCheckNow();
  });

  function renderChangelog(releases: Awaited<ReturnType<typeof fetchReleasesSince>>): void {
    changelogEl.replaceChildren();
    for (const release of releases) {
      const entry = document.createElement('div');
      entry.className = 'updates-changelog__entry';

      const heading = document.createElement('h4');
      heading.textContent = release.version;
      entry.appendChild(heading);

      const body = document.createElement('p');
      body.textContent = release.notesMarkdown;
      entry.appendChild(body);

      changelogEl.appendChild(entry);
    }
  }

  async function load(): Promise<void> {
    appVersion = await getVersion();
    currentVersionEl.textContent = appVersion;

    prefs = await invoke<UpdatePrefs>('get_update_prefs');
    autoCheckBox.checked = prefs.autoCheck;
    autoInstallBox.checked = prefs.autoInstall;

    const releases = await fetchReleasesSince(appVersion);
    renderChangelog(releases);
  }

  void load();
}
```

- [ ] **Step 5: Wire it into `settings-form.ts`**

Edit `src/native/settings-form.ts`:

```ts
// settings-form.ts — settings window entry: theme/accent sync + tab wiring.
import { initTheme } from '../state/theme';
import { initAccent } from '../state/accent';
import { initAnchorVisibility } from '../state/anchor-visibility';
import { initDensity } from '../state/density';
import { initTabs } from './settings/tabs';
import { initInferenceTab } from './settings/inference-tab';
import { initGeneralTab } from './settings/general-tab';
import { initPromptTab } from './settings/prompt-tab';
import { initUpdatesTab } from './settings/updates-tab';

// Shares the main window's token system (accent/theme palette) instead of a
// parallel one, so a choice made here looks identical everywhere else. Pure
// CSS — no JS module graph crosses in from viewport/store/engine (D9/D10
// isolation is a JS-secrets concern, not a styling one).
import '../styles/tokens.css';
import '../styles/settings.css';
import '../styles/update-dialog.css';

// `settings.html` loads this script as `type="module" defer`, so the DOM
// (including the static `#theme-group` markup) is already fully parsed
// before any of this runs. `initGeneralTab()` builds the theme radios and
// accent swatches and returns the callbacks that reflect an external pref
// change into them; call it first and hand each callback straight to its
// state module's init function.
const { reflectTheme, reflectAccent, reflectDensity } = initGeneralTab();
initTheme(reflectTheme);
initAccent(reflectAccent);
initDensity(reflectDensity);
initAnchorVisibility();
initTabs(document.body);
initInferenceTab();
void initPromptTab();
initUpdatesTab();
```

- [ ] **Step 6: Add styling for the new elements**

Append to `src/styles/settings.css`:

```css
/* ---------- Updates tab ---------- */

#updates-changelog {
  max-height: 200px;
  overflow-y: auto;
  padding: 10px 12px;
  border: 1px solid var(--sz-border);
  border-radius: 8px;
  background: var(--sz-track);
}

.updates-changelog__entry h4 {
  margin: 12px 0 4px;
  font: 700 12.5px/1.3 var(--sz-font);
}

.updates-changelog__entry:first-child h4 {
  margin-top: 0;
}

.updates-changelog__entry p {
  margin: 0;
  font-size: 12px;
  color: var(--sz-muted);
}

#updates-coffee {
  padding-top: 12px;
  border-top: 1px solid var(--sz-hairline);
}

#updates-coffee p {
  margin: 0 0 8px;
  font-size: 12px;
  color: var(--sz-muted);
}

#updates-coffee-link {
  display: inline-block;
  padding: 8px 16px;
  border-radius: var(--sz-radius-pill);
  background: var(--sz-accent);
  color: #fff;
  font: 600 12.5px/1 var(--sz-font);
  text-decoration: none;
}

#updates-coffee-link:hover {
  opacity: 0.9;
}
```

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
npm test -- updates-tab
```
Expected: all tests pass.

- [ ] **Step 8: Full sanity build**

```bash
npm run build
```
Expected: `tsc` + `vite build` succeed (this is the first task that actually imports the new packages — a type error in the `@tauri-apps/plugin-updater`/`@tauri-apps/plugin-process` usage would surface here).

- [ ] **Step 9: Commit**

```bash
git add settings.html src/native/settings/updates-tab.ts src/native/settings/updates-tab.test.ts src/native/settings-form.ts src/styles/settings.css
git commit -m "Add Updates settings tab (version, toggles, check-now, changelog, coffee link)"
```

---

### Task 10: Empty-state banner

**Files:**
- Modify: `src/ui/empty-state.ts`
- Modify: `src/ui/empty-state.test.ts`
- Modify: `src/styles/empty-state.css`

**Interfaces:**
- Produces: `EmptyStateOptions` gains `updateAvailable?: { version: string; onOpenDialog: () => void }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/ui/empty-state.test.ts` (after the existing "omits the version chip" test):

```ts
test('renders an update banner when updateAvailable is given', () => {
  const root = document.createElement('div');
  const onOpenDialog = vi.fn();
  mountEmptyState(root, {
    recentFiles: [],
    ...noopHandlers,
    version: '0.8.0',
    updateAvailable: { version: '0.9.0', onOpenDialog },
  });

  const banner = root.querySelector('.empty-state__update-banner');
  expect(banner).not.toBeNull();
  expect(banner?.textContent).toContain('0.9.0');

  root.querySelector<HTMLButtonElement>('.empty-state__update-banner-action')!.click();
  expect(onOpenDialog).toHaveBeenCalledOnce();
});

test('omits the update banner when no update is available', () => {
  const root = document.createElement('div');
  mountEmptyState(root, { recentFiles: [], ...noopHandlers, version: '0.8.0' });
  expect(root.querySelector('.empty-state__update-banner')).toBeNull();
});
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npm test -- empty-state
```
Expected: FAIL — no `.empty-state__update-banner` is rendered yet.

- [ ] **Step 3: Implement**

Edit `src/ui/empty-state.ts` — extend the options interface (lines 12-21):

```ts
export interface EmptyStateOptions {
  recentFiles: RecentFile[];
  onOpen: () => void;
  onSelectRecent: (path: string) => void;
  onSettings: () => void;
  /** "Clear history" affordance (Figma 306:174); omitted → link not shown. */
  onClearRecent?: () => void;
  /** App version shown at the end of the footer (e.g. "0.3.0"); omitted → no version chip. */
  version?: string;
  /** A known-available update; omitted → no banner. Clicking the banner's
      button never installs directly — it opens the same update-dialog.ts
      component main.ts already drives, so there's one install path. */
  updateAvailable?: { version: string; onOpenDialog: () => void };
}
```

Add a builder function (after `buildFooter`, before `mountEmptyState`):

```ts
function buildUpdateBanner(update: { version: string; onOpenDialog: () => void }): HTMLElement {
  const banner = document.createElement('div');
  banner.className = 'empty-state__update-banner';

  const text = document.createElement('span');
  text.textContent = `Version ${update.version} is available.`;
  banner.appendChild(text);

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'empty-state__update-banner-action';
  action.textContent = 'Update';
  action.addEventListener('click', () => update.onOpenDialog());
  banner.appendChild(action);

  return banner;
}
```

Wire it into `mountEmptyState`, right before the footer is appended (currently `container.appendChild(buildFooter(opts.version));`):

```ts
  if (opts.updateAvailable) {
    container.appendChild(buildUpdateBanner(opts.updateAvailable));
  }
  container.appendChild(buildFooter(opts.version));
```

- [ ] **Step 4: Add banner styling**

Append to `src/styles/empty-state.css`:

```css
.empty-state__update-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  margin: 0 auto;
  border-radius: var(--sz-radius-pill);
  background: var(--sz-key-bg);
  border: 1px solid var(--sz-seg-border);
  font-size: 12px;
  color: var(--sz-ink);
}

.empty-state__update-banner-action {
  padding: 4px 12px;
  border-radius: var(--sz-radius-pill);
  border: none;
  background: var(--sz-accent);
  color: #fff;
  font: 600 11.5px/1 var(--sz-font);
  cursor: pointer;
}

.empty-state__update-banner-action:hover {
  opacity: 0.9;
}
```

- [ ] **Step 5: Run to confirm the tests pass**

```bash
npm test -- empty-state
```
Expected: all tests pass, including the two new ones.

- [ ] **Step 6: Commit**

```bash
git add src/ui/empty-state.ts src/ui/empty-state.test.ts src/styles/empty-state.css
git commit -m "Add empty-state update banner (passive — opens the shared update dialog)"
```

---

### Task 11: `main.ts` wiring — startup check, dialog, auto-install, restart

This is the integration task: it has no new tests of its own (the pieces it wires are already tested in isolation in Tasks 6-10); its "done when" is the build + a real manual run.

**Files:**
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: everything from Tasks 4-10 (`get_update_prefs`, `request_update_check`, `mountUpdateDialog`, `fetchReleasesSince`, the extended `EmptyStateOptions`, `@tauri-apps/plugin-updater`'s `check()`, `@tauri-apps/plugin-process`'s `relaunch()`, `@tauri-apps/plugin-dialog`'s `ask()`).

- [ ] **Step 1: Add imports**

In `src/main.ts`, add near the other `@tauri-apps/*` imports (after line 6, `import { ask, open } from '@tauri-apps/plugin-dialog';`):

```ts
import { check as checkForUpdate, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
```

Add near the other `ui/` imports (after line 27, `import { mountEmptyState } from './ui/empty-state';`):

```ts
import { mountUpdateDialog, type UpdateDialogHandle } from './ui/update-dialog';
```

Add near the other `native/`-adjacent imports (a reasonable spot is right after the `invoke`/`listen` imports, or grouped with the empty-state import — place it after line 27's new import):

```ts
import { fetchReleasesSince } from './native/github-releases';
```

Add the stylesheet import next to the other `styles/*` imports (after line 68, `import './styles/empty-state.css';`):

```ts
import './styles/update-dialog.css';
```

- [ ] **Step 2: Add module-level state and the dialog mount point**

Near the other module-level `let` declarations that hold mounted-component handles (find `emptyStateTeardown`'s declaration and add alongside it):

```ts
let updateDialog: UpdateDialogHandle | null = null;
```

- [ ] **Step 3: Add the update-check logic**

Add this block of functions after `hideEmptyState()` (i.e. after the function ending around line 1127 in the current file):

```ts
/**
 * The shared "found an update" flow: fetches the stacked release notes and
 * opens the dialog. `manual` is true only for the settings-tab-triggered
 * (via the `update://check-requested` event) path — kept here in case a
 * future refinement needs to vary found-dialog copy by trigger source;
 * currently both paths render identically.
 */
async function presentFoundUpdate(update: Update, autoInstall: boolean): Promise<void> {
  const currentVersion = __APP_VERSION__;
  const releaseNotes = await fetchReleasesSince(currentVersion);
  updateDialog?.showFound({
    currentVersion,
    latestVersion: update.version,
    releaseNotes: releaseNotes.length > 0 ? releaseNotes : [{ version: update.version, notesMarkdown: update.body ?? '' }],
    autoInstall,
    onAutoInstallChange: (value) => {
      void invoke('set_update_prefs', {
        prefs: { autoCheck: true, autoInstall: value, skippedVersion: null },
      });
    },
    onSkip: () => {
      void invoke('get_update_prefs').then((prefs) =>
        invoke('set_update_prefs', { prefs: { ...(prefs as object), skippedVersion: update.version } }),
      );
    },
    onRemindLater: () => {},
    onInstall: () => void installUpdate(update),
  });
}

async function installUpdate(update: Update): Promise<void> {
  let downloaded = 0;
  let total = 0;
  updateDialog?.showProgress({ downloadedBytes: 0, totalBytes: 0, onCancel: () => {} });
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0;
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength;
      updateDialog?.updateProgress(downloaded, total);
    }
  });
  updateDialog?.close();
  const shouldRestart = await ask('Restart Semantic Zoom now to finish updating?', {
    title: 'Update Installed',
  });
  if (shouldRestart) await relaunch();
}

/**
 * Runs on startup (gated by auto_check) and whenever the settings window's
 * "Check for Updates now" fires `update://check-requested`. `manual: true`
 * ignores skippedVersion (ask-me-explicitly always wins); the automatic
 * startup path honors it. When auto-install is on AND this is the
 * unattended startup path, install proceeds straight to the progress view
 * without showing the found-dialog first — the toggle's promise is "only
 * ever interrupting the user to ask for a restart."
 */
async function runUpdateCheck(manual: boolean): Promise<void> {
  const prefs = await invoke<{ autoCheck: boolean; autoInstall: boolean; skippedVersion: string | null }>(
    'get_update_prefs',
  );
  const update = await checkForUpdate();
  if (!update) return;
  if (!manual && update.version === prefs.skippedVersion) return;

  if (!manual && prefs.autoInstall) {
    void installUpdate(update);
    return;
  }

  await presentFoundUpdate(update, prefs.autoInstall);
  showEmptyState(); // refresh the banner too, in case the dialog gets Remind-Me-Later'd
}
```

- [ ] **Step 4: Thread `updateAvailable` into `showEmptyState`**

`showEmptyState()` currently mounts the empty state without update info. Track the last-known available update alongside the other module-level state:

```ts
let lastKnownUpdate: Update | null = null;
```

Edit `runUpdateCheck` to set it right after `const update = await checkForUpdate();`:

```ts
  const update = await checkForUpdate();
  lastKnownUpdate = update;
```

Edit `showEmptyState()`'s `mountEmptyState(...)` call (currently ending with `version: __APP_VERSION__,`) to add:

```ts
    version: __APP_VERSION__,
    updateAvailable: lastKnownUpdate
      ? { version: lastKnownUpdate.version, onOpenDialog: () => void presentFoundUpdate(lastKnownUpdate!, false) }
      : undefined,
```

- [ ] **Step 5: Wire the startup check and the cross-window signal**

In the `window.addEventListener('DOMContentLoaded', () => { ... })` block, add near the end (after `mountContentMapOnce();` and before `showEmptyState();`):

```ts
  updateDialog = mountUpdateDialog(document.body);
```

After `showEmptyState();` in that same block, add:

```ts
  void runUpdateCheck(false);
```

Add a listener alongside the existing `doc://changed` listener (right after it, still inside `DOMContentLoaded`):

```ts
  void listen('update://check-requested', () => {
    void runUpdateCheck(true);
  });
```

- [ ] **Step 6: Full sanity build**

```bash
npm run build
```
Expected: `tsc` + `vite build` succeed.

```bash
npm test
```
Expected: full existing suite still passes (this task adds no new tests, but a wiring mistake — e.g. a typo in a callback — would show up as a regression in `empty-state.test.ts`'s existing assertions if it broke `mountEmptyState`'s call shape).

- [ ] **Step 7: Commit**

```bash
git add src/main.ts
git commit -m "Wire the auto-updater into main.ts: startup check, dialog, auto-install, restart"
```

---

### Task 12: Manual verification (cannot be automated — do this before calling PR 2 done)

Per standing practice (background sessions cannot run the WebKit pass — this needs the user).

- [ ] Run the real app (`npm run tauri dev` or a local `npm run build:dmg` install) with the empty-state screen showing.
- [ ] Temporarily point `tauri.conf.json`'s `plugin.updater.endpoints` at a throwaway `latest.json` (e.g. a Gist or a second GitHub Release) advertising a version newer than the running build, to force the "update found" path without needing a real tagged release.
- [ ] Confirm: the update-found dialog appears unprompted on startup (with `auto_install` off), showing the release notes, with working Skip / Remind Me Later / Install buttons.
- [ ] Confirm: clicking Install shows the download-progress view with a moving bar and byte counts, then prompts for restart.
- [ ] Confirm: opening Settings → Updates tab shows the right current version, changelog, and that "Check for Updates now" opens the same dialog style.
- [ ] Confirm: toggling either checkbox in the Settings tab persists across a Settings-window close/reopen (reads `get_update_prefs` correctly).
- [ ] Confirm: with the empty-state banner visible (after a Remind Me Later), clicking its "Update" button reopens the dialog.
- [ ] Revert the temporary `tauri.conf.json` endpoint change once verified.
- [ ] Report the pass/fail of each item back — do not mark this plan complete without this feedback.

---

## Self-Review Notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-07-21-auto-updates-design.md` maps to a task — update engine (Task 1), signing/release pipeline (Tasks 2-3), `UpdatePrefs` (Task 4), the update-found dialog (Tasks 7-8), download progress (Task 8), Updates tab (Task 9), empty-state banner (Task 10), toggle defaults/behavior (Tasks 4, 9, 11), manual WebKit pass (Task 12). The one addition beyond the spec's literal text — `request_update_check` (Task 5) and `tauri-plugin-process` (Task 1) — are implementation-necessary consequences of the approved design (cross-window banner sync; the restart-confirmation flow the spec's own hint copy promises) called out explicitly in each task's rationale, not silent scope changes.
- **Placeholder scan:** no TBD/TODO/"add error handling" language; every code step has complete, runnable code.
- **Type consistency:** `UpdatePrefs` (Rust `autoCheck`/`autoInstall`/`skippedVersion` camelCase via serde) matches the TS `UpdatePrefs` interface field-for-field across Tasks 4, 9, and 11. `UpdateDialogHandle`/`FoundUpdateOptions`/`DownloadProgressOptions` defined once in Task 7 and reused verbatim (same field names) in Tasks 9 and 11.
