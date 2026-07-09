# Testing the compiled app live — setup checklist

Everything here comes from a real attempt (2026-07-09) to have a Claude Code
background session drive the actual native `semantic-zoom` app: click content-map
bars, screenshot, and compare against the viewport. Most of the setup below
**must happen before the testing session starts** — several of the permissions
involved don't take effect for an already-running process, and the process in
question is the Claude Code session itself, which obviously can't restart
itself mid-task.

## Why this is finicky

A Claude Code background job's shell is a child of the `ClaudeCode.app`
process, not of `Terminal.app`. macOS's permission system (TCC) attributes
responsibility for scripting/automation to that top-level app bundle. If you
grant a permission to "Claude" while the session is already running, the
running process is very likely still operating under the OLD, unauthorized
snapshot — the grant only reliably applies to a *fresh launch*.

Confirm the actual chain if in doubt:

```bash
pid=$$
for i in 1 2 3 4 5; do
  ppid=$(ps -o ppid= -p "$pid" | tr -d ' ')
  echo "pid=$ppid comm=$(ps -o comm= -p "$ppid" 2>/dev/null)"
  pid=$ppid; [ "$pid" = "1" ] && break
done
```

It should bottom out at `.../ClaudeCode.app/Contents/MacOS/claude`.

## 1. Before starting the session

- [ ] **System Settings → Privacy & Security → Screen Recording**: enable for
      "Claude". Without it, `screencapture` can silently fail or return a
      black/empty image even on an unlocked screen.
- [ ] **System Settings → Privacy & Security → Accessibility**: enable for
      "Claude". Required for any `osascript`/System Events UI automation
      (clicking, reading window/element geometry, keystrokes). Without it,
      every `tell application "System Events" to ...` call fails with
      `osascript is not allowed assistive access (-25211)`, and no toggle
      flipped *during* the session fixes it.
- [ ] **Fully quit Claude Code** (Cmd+Q, not just closing the window) **and
      relaunch it**, so the new session's process starts under the granted
      permissions. Then start the testing task in the fresh session.
- [ ] **Unlock the screen and disable auto-lock** for the duration of testing
      (System Settings → Lock Screen → increase "turn display off after" /
      turn off "require password"). A locked screen makes `screencapture`
      return solid black and `System Events` reports `loginwindow` as the
      frontmost process — there is no way to distinguish "no display" from
      "locked display" except by looking at the actual captured pixels.

## 2. Tooling to have ready

- [ ] `cargo`/`rustc` on `PATH` for non-interactive shells. `~/.cargo/bin` is
      often only added to interactive shell rc files — add it to whichever
      profile the background shell actually sources, or just always prefix
      commands with `export PATH="$HOME/.cargo/bin:$PATH"`.
- [ ] **Strongly recommended: `tauri-driver`.** Tauri v2 officially supports
      WebDriver-based E2E testing (`cargo install tauri-driver`, driven from
      Node via `webdriverio` or `selenium-webdriver`). This talks to the
      WKWebView's DOM directly over the W3C WebDriver protocol — no OS-level
      synthetic clicks, so **no Accessibility permission is needed at all**,
      and assertions can read real DOM state (e.g. `.pgroup[data-active]`,
      the rendered section-header text) instead of eyeballing screenshots.
      This is the right tool for exactly the kind of test requested here
      ("does the highlight match the clicked section") — it sidesteps this
      entire permissions problem rather than fighting it.
- [ ] Fallback if WebDriver setup isn't feasible: `brew install cliclick` for
      coordinate-based click simulation. Still requires Accessibility granted
      to the calling process (see above) — it does not avoid the permission
      wall, just avoids AppleScript syntax.

## 3. Clean process state before each run

Stale windows accumulate — e.g. an old build left over from before a code
change, still open and looking "broken" when it's just outdated. Before
testing:

```bash
pgrep -fl semantic-zoom          # list any running instances
pkill -f target/debug/semantic-zoom   # kill stale ones if found
```

Launch the app yourself (`npm run tauri dev` as a backgrounded command you
control, or the WebDriver-launched binary) rather than relying on some
already-open window — that way you know its exact PID, can read its stdout,
and know for certain it reflects the current worktree's code.

## 4. What a properly-set-up session can then do

- Launch the app, wait for the Vite "ready" line and the window to appear.
- Confirm exactly one `semantic-zoom` process via
  `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`.
- Preferred: drive it via `tauri-driver` — click a content-map bar, then
  assert on the resulting DOM (which `.pgroup` carries `data-active`, what
  the visible section header text is) instead of screenshotting and
  eyeballing pixels.
- Fallback: `cliclick`/System Events to click at bar coordinates (derived
  from an initial screenshot), screenshot after each click, and visually
  compare the highlighted bar against the section title shown in the
  viewport.

## Open question from this session

While manually testing `mock-a.md` (101 paragraphs / 20 sections — see
`docs/Implementation_Plan.md` §4.9 and `src/ui/content-map.ts`), the
active-section highlight was reported to "drift" and become inconsistent
after some amount of interaction, though the exact repro steps weren't
pinned down (scrolling speed? clicking multiple bars in quick succession?
switching zoom levels then scrolling? window resize?). Next session with
proper tooling should try to reproduce this precisely — worth first checking
`updateMapFromScroll` / `resolveAnchor` / `markActiveGroup` in `src/main.ts`
and `src/ui/active-group.ts` for a state that isn't reset on every
transition.
