// The ONLY module allowed to import `@tauri-apps/*` (ESLint boundary).
// It owns all lifecycles and routes Tauri access to the Tauri-free
// engine/ and ui/ modules (spec §6, §3.3).
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

import { buildIndex, type ZoomLevel, type LookupTable, type ResolvedIndex } from './engine/schema';
import type { LoadResultDTO } from './engine/engine-a';
import {
  renderLevel,
  buildGroup,
  mountZoomTransitions,
  scrollCommands$,
  type ZoomTransitionState,
} from './ui/viewport';
import { mountSlider } from './ui/slider';
import { mountCaret } from './ui/caret';
import { nextScale, SCALE_DEFAULT } from './ui/content-scale';
import { mountFocusMask } from './ui/focus-mask';
import { mountStatusBadge, type StatusBadgeHandle } from './ui/status-badge';
import { reconcile, restoreCaret, groupKey } from './state/reload';

// The store: main.ts is the only place (with state/) allowed to feed actions$.
// Components dispatch + subscribe to selectors; only this file wires the bus.
import { actions$, snapshot } from './state/store';
import { caretPlaced, docLoaded, zoomSet } from './state/actions';
import { selectCaret } from './state/selectors';
import type { Subscription } from 'rxjs';

import './styles/tokens.css';
import './styles/base.css';
import './styles/slider.css';
import './styles/focus-mask.css';
import './styles/reading.css';

// --- session state (the RxJS store arrives in Task 2.1; direct wiring for now) ---
let currentLevel: ZoomLevel = 0;
let currentResult: LoadResultDTO | null = null;
let currentTable: LookupTable | null = null;
let currentIndex: ResolvedIndex | null = null;
/** The file currently open — re-invoked on `doc://changed` (silent reload, §5.3). */
let currentPath: string | null = null;
/** k=0 groups from the last render, keyed by sid, for keyed reconciliation (D7). */
let prevGroups = new Map<string, HTMLElement>();
/** True only when Engine-A summaries exist (native docs). Gates −1/−2. */
let summariesAvailable = false;
let sliderTeardown: (() => void) | null = null;
let caretTeardown: (() => void) | null = null;
let focusMaskTeardown: (() => void) | null = null;
let zoomTeardown: (() => void) | null = null;
/** Non-modal status affordance (spec §2.6, §5.3): warning badge + "Updated" pill. */
let statusBadge: StatusBadgeHandle | null = null;

let viewportEl: HTMLElement;
let sliderEl: HTMLElement;
let statusEl: HTMLElement;

/** Levels available given the current document. */
function availableLevels(): ZoomLevel[] {
  return summariesAvailable ? [0, -1, -2] : [0];
}

/** (Re)mount the slider reflecting the active level and disabled detents. */
function mountSliderForState(): void {
  sliderTeardown?.();
  const available = availableLevels();
  const disabledLevels = ([0, -1, -2] as ZoomLevel[]).filter((l) => !available.includes(l));
  sliderTeardown = mountSlider(sliderEl, {
    onChange: requestLevel,
    disabledLevels,
    active: currentLevel,
  });
}

/**
 * Snapshot the transition effect reads at ZOOM_SET time (spec §2.5). `level` is
 * the level currently mounted — the transition's SOURCE. Returns null for
 * raw/untagged docs (no summaries → no cross-level transition).
 */
function getZoomState(): ZoomTransitionState | null {
  if (!currentTable || !currentIndex) return null;
  const s = snapshot();
  return {
    table: currentTable,
    index: currentIndex,
    level: currentLevel,
    caret: s.caret,
    lastCaretIn: s.lastCaretIn,
    lastAnchorIn: s.lastAnchorIn,
  };
}

/** Render the current document at `currentLevel` and sync the slider. */
function renderCurrent(): void {
  viewportEl.dataset.zoom = String(currentLevel);
  if (currentTable && currentIndex) {
    // TODO(Task 2.4): migrate to full store-driven rendering (zoom transition).
    renderLevel(viewportEl, currentTable, currentIndex, currentLevel);
  }
  // Seed the keyed-reconciliation map from the freshly rendered k=0 groups so
  // the FIRST hot reload can already reuse unchanged DOM nodes (D7). The
  // reconciler compares `dataset.key`, so stamp it here to match `groupKey`.
  prevGroups = seedGroups();
  remountCaret();
  remountFocusMask();
  mountSliderForState();
}

/**
 * Read the mounted k=0 `.pgroup[data-sid]` nodes into a `Map<sid, node>`,
 * stamping each with its `groupKey` so the next `reconcile` can compare bytes.
 * Empty for non-native docs or non-k=0 levels (no groups to reuse).
 */
function seedGroups(): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>();
  if (!currentTable || currentLevel !== 0) return map;
  const column = viewportEl.querySelector<HTMLElement>('.reading-column');
  if (!column) return map;
  for (const sid of currentTable.order.sections) {
    const node = column.querySelector<HTMLElement>(`.pgroup[data-sid="${sid}"]`);
    if (!node) continue;
    node.dataset.key = groupKey(currentTable, sid);
    map.set(sid, node);
  }
  return map;
}

/** Move the read-only caret marker onto `pid` (used after hot-reload restore). */
function markCaret(pid: string): void {
  for (const el of viewportEl.querySelectorAll('.pnode[data-caret]')) {
    el.removeAttribute('data-caret');
  }
  viewportEl
    .querySelector<HTMLElement>(`.pnode[data-pid="${pid}"]`)
    ?.setAttribute('data-caret', '');
}

/**
 * (Re)mount the group focus-mask after a render. It only makes sense at k=0 for
 * a native doc (where `.pgroup[data-sid]` groups exist and a caret can pick an
 * active group); at other levels or for raw/untagged docs we tear down and skip.
 * mountFocusMask subscribes to the store, so a teardown-then-mount is idempotent.
 */
function remountFocusMask(): void {
  focusMaskTeardown?.();
  focusMaskTeardown = null;
  const nativeAtK0 = !!currentTable && currentLevel === 0;
  if (!nativeAtK0) return;
  focusMaskTeardown = mountFocusMask(viewportEl);
}

/**
 * (Re)mount the read-only caret after a render. Only k=0 renders `.pnode`s;
 * at k=−1/−2 there is nothing to place a caret on, so we tear down and skip.
 * Caret placements feed the store; the reducer recomputes activeGroupHead
 * (spec §3.2) which focus-mask + anchor consume in later tasks.
 */
function remountCaret(): void {
  caretTeardown?.();
  caretTeardown = null;
  const hasParagraphs = !!currentTable && currentLevel === 0;
  if (!hasParagraphs) return;
  caretTeardown = mountCaret(viewportEl, (pid, offset) =>
    actions$.next(caretPlaced(pid, offset)),
  );
}

/**
 * Request a zoom-level change. Dispatches `ZOOM_SET`, which the two-frame
 * transition effect (spec §2.5) picks up via `switchMap`. `actions$.next` runs
 * the effect's frame n SYNCHRONOUSLY while `currentLevel` still holds the SOURCE
 * level (what `getZoomState` reports); we advance `currentLevel` to the target
 * only after and update the slider. Caret + focus-mask are (re)mounted by the
 * transition's `onSettled` callback against the FINAL layer — remounting here
 * would attach them to the still-transitioning (pre-settle) layer.
 */
function requestLevel(level: ZoomLevel): void {
  if (!availableLevels().includes(level)) return;
  if (level === currentLevel) return;
  actions$.next(zoomSet(level)); // frame n mounts the entering layer synchronously
  currentLevel = level;
  viewportEl.dataset.zoom = String(level);
  mountSliderForState();
}

/** Step zoom: +1 = zoom in (toward raw/0), −1 = zoom out (toward story/−2). */
function stepZoom(dir: 1 | -1): void {
  const target = Math.max(-2, Math.min(0, currentLevel + dir)) as ZoomLevel;
  requestLevel(target);
}

// --- Content scale (⌘= / ⌘- / ⌘0): browser-style zoom of the reading content,
// independent of the semantic zoom LEVELS. Applied as a CSS `zoom` via the
// --content-scale custom property on #viewport, so it persists across level
// re-renders and transition layer swaps automatically.
let contentScale = SCALE_DEFAULT;

function applyContentScale(): void {
  viewportEl.style.setProperty('--content-scale', String(contentScale));
}

/** Scale the content larger (+1) or smaller (−1). */
function scaleContent(dir: 1 | -1): void {
  contentScale = nextScale(contentScale, dir);
  applyContentScale();
}

/** Reset content scale to 100% (⌘0 / "Actual Size"). */
function resetContentScale(): void {
  contentScale = SCALE_DEFAULT;
  applyContentScale();
}

/** Apply a freshly loaded document. Resets to the raw level. */
function applyResult(result: LoadResultDTO): void {
  currentResult = result;
  currentLevel = 0;
  // Reset the store's zoom to 0 so a later ZOOM_SET isn't swallowed by
  // distinctUntilChanged if the previous doc left a non-zero level. The
  // transition effect no-ops on this (source === target === 0).
  actions$.next(zoomSet(0));

  if (result.kind === 'native') {
    summariesAvailable = true;
    currentTable = result.table;
    currentIndex = buildIndex(result.table);
    statusEl.textContent = 'Native';
    statusBadge?.setStatus('native');
    renderCurrent();
  } else {
    // Untagged / Corrupt: no summaries exist. Show raw at k=0 and disable
    // the summary detents (spec §2.7 seam).
    summariesAvailable = false;
    currentTable = null;
    currentIndex = null;

    const layer = document.createElement('div');
    layer.className = 'level-layer';
    const pre = document.createElement('pre');
    pre.textContent = result.raw;
    layer.appendChild(pre);
    viewportEl.replaceChildren(layer);
    viewportEl.dataset.zoom = '0';
    // Raw view has no `.pnode`s or `.pgroup`s — no caret or focus-mask target.
    caretTeardown?.();
    caretTeardown = null;
    focusMaskTeardown?.();
    focusMaskTeardown = null;

    statusEl.textContent =
      result.kind === 'corrupt' ? `Corrupt: ${result.error}` : 'Untagged';
    if (result.kind === 'corrupt') {
      statusBadge?.setStatus('corrupt', result.error);
    } else {
      statusBadge?.setStatus('untagged');
    }
    mountSliderForState();
  }
}

export async function openFile(path: string): Promise<void> {
  currentPath = path; // remembered so `doc://changed` can silently reload it (§5.3)
  const result = await invoke<LoadResultDTO>('load_document', { path });
  // Feed the store so it holds doc/index/raw (caret→activeGroupHead recompute,
  // Task 2.5). Direct render below stays until full store-driven rendering
  // migrates in Task 2.4.
  actions$.next(docLoaded(result));
  applyResult(result);

  // `watch_directory` (spec §5) lands in Task 3.1 and is not yet registered
  // on the Rust side. Guard so opening a file never crashes the app.
  try {
    await invoke('watch_directory', { path }); // TODO(Task 3.1): watches parent dir
  } catch (err) {
    console.warn('watch_directory not yet available (lands in Task 3.1):', err);
  }
}

/** Prompt for a markdown file and open it. Shared by button, menu, shortcut. */
async function promptOpen(): Promise<void> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (typeof selected === 'string') {
    await openFile(selected);
  }
}

/**
 * Build the native macOS application menu with accelerators. Uses the JS menu
 * API so all Tauri access stays in main.ts and no new Rust↔TS domain crossing
 * is introduced (the three crossings remain load_document / watch_directory /
 * doc://changed). Menu accelerators double as the app's keyboard shortcuts.
 */
async function installMenu(): Promise<void> {
  const sep = () => PredefinedMenuItem.new({ item: 'Separator' });

  const appMenu = await Submenu.new({
    text: 'Semantic Zoom',
    items: [
      await PredefinedMenuItem.new({ item: { About: null } }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Services' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Hide' }),
      await PredefinedMenuItem.new({ item: 'HideOthers' }),
      await PredefinedMenuItem.new({ item: 'ShowAll' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Quit' }),
    ],
  });

  const fileMenu = await Submenu.new({
    text: 'File',
    items: [
      await MenuItem.new({
        id: 'open',
        text: 'Open…',
        accelerator: 'CmdOrCtrl+O',
        action: () => void promptOpen(),
      }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'CloseWindow' }),
    ],
  });

  const editMenu = await Submenu.new({
    text: 'Edit',
    items: [
      await PredefinedMenuItem.new({ item: 'Undo' }),
      await PredefinedMenuItem.new({ item: 'Redo' }),
      await sep(),
      await PredefinedMenuItem.new({ item: 'Cut' }),
      await PredefinedMenuItem.new({ item: 'Copy' }),
      await PredefinedMenuItem.new({ item: 'Paste' }),
      await PredefinedMenuItem.new({ item: 'SelectAll' }),
    ],
  });

  const viewMenu = await Submenu.new({
    text: 'View',
    items: [
      await MenuItem.new({ id: 'lvl-raw', text: 'Detail (Raw)', accelerator: 'CmdOrCtrl+1', action: () => requestLevel(0) }),
      await MenuItem.new({ id: 'lvl-sections', text: 'Sections', accelerator: 'CmdOrCtrl+2', action: () => requestLevel(-1) }),
      await MenuItem.new({ id: 'lvl-story', text: 'Story', accelerator: 'CmdOrCtrl+3', action: () => requestLevel(-2) }),
      await sep(),
      // Content scale (browser-style). ⌘+ is the macOS-standard zoom-in
      // accelerator and fires on the unshifted ⌘= key too.
      await MenuItem.new({ id: 'scale-in', text: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', action: () => scaleContent(1) }),
      await MenuItem.new({ id: 'scale-out', text: 'Zoom Out', accelerator: 'CmdOrCtrl+-', action: () => scaleContent(-1) }),
      await MenuItem.new({ id: 'scale-reset', text: 'Actual Size', accelerator: 'CmdOrCtrl+0', action: () => resetContentScale() }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: 'Window',
    items: [
      await PredefinedMenuItem.new({ item: 'Minimize' }),
      await PredefinedMenuItem.new({ item: 'Maximize' }),
      await PredefinedMenuItem.new({ item: 'Fullscreen' }),
    ],
  });

  const menu = await Menu.new({ items: [appMenu, fileMenu, editMenu, viewMenu, windowMenu] });
  await menu.setAsAppMenu();
}

function inEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

/**
 * Plain-key shortcuts (no modifier) as quick conveniences alongside the menu
 * accelerators: 1/2/3 jump to a level, [ / ] step zoom. Ignored while a text
 * field is focused or when a modifier is held (so ⌘-combos reach the menu).
 */
function installKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (inEditable(e.target)) return;

    switch (e.key) {
      case '1': requestLevel(0); break;
      case '2': requestLevel(-1); break;
      case '3': requestLevel(-2); break;
      case ']': stepZoom(1); break;   // zoom in toward raw
      case '[': stepZoom(-1); break;  // zoom out toward story
      default: return;
    }
    e.preventDefault();
  });

  // Content-scale zoom-IN via the physical =/+ key. The View-menu accelerator
  // `CmdOrCtrl+Plus` only matches the SHIFTED '+' (⌘⇧=), so the unshifted ⌘=
  // never reaches it — handle it here. macOS consumes ⌘⇧= at the menu before
  // keydown, so there is no double-fire. (⌘- and ⌘0 work via their menu
  // accelerators, which match the unshifted keys directly.)
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    if (inEditable(e.target)) return;
    if (e.key === '=' || e.key === '+') {
      scaleContent(1);
      e.preventDefault();
    }
  });
}

let devHudSub: Subscription | null = null;

/**
 * Dev HUD (Task 2.2 "done when"): behind `?dev`, a low-key corner readout of
 * the caret's paragraphId + offset, driven by the store's selectCaret selector.
 * Subscribing to a selector (not actions$) keeps main.ts consistent with the
 * component discipline. Remembered in `devHudSub` for teardown.
 */
function installDevHud(): void {
  if (!location.search.includes('dev')) return;
  const hud = document.createElement('div');
  hud.id = 'dev-hud';
  Object.assign(hud.style, {
    position: 'fixed',
    bottom: '8px',
    right: '8px',
    zIndex: '9999',
    font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '4px 8px',
    background: 'rgba(0,0,0,0.6)',
    color: '#8f8',
    borderRadius: '4px',
    pointerEvents: 'none',
    opacity: '0.6',
  });
  document.body.appendChild(hud);
  devHudSub = selectCaret().subscribe((caret) => {
    hud.textContent = `caret: ${caret.paragraphId ?? '—'} @${caret.offset}`;
  });
  // main.ts owns lifecycles: release the subscription when the window unloads.
  window.addEventListener('beforeunload', () => {
    devHudSub?.unsubscribe();
    devHudSub = null;
  });
}

window.addEventListener('DOMContentLoaded', () => {
  viewportEl = document.querySelector<HTMLElement>('#viewport')!;
  sliderEl = document.querySelector<HTMLElement>('#slider')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;

  applyContentScale(); // seed --content-scale at 100%

  // Mount the non-modal status affordance once, into the toolbar. It is driven
  // imperatively (main.ts holds the load result + its corrupt error text).
  const toolbar = document.querySelector<HTMLElement>('.toolbar') ?? document.body;
  statusBadge = mountStatusBadge(toolbar);

  // Mount the two-frame zoom-transition effect once (spec §2.5). Subsequent
  // ZOOM_SET actions drive crossfades; the first render on open stays direct.
  // After a transition settles into its FINAL layer, (re)mount the caret and
  // focus-mask against the layer that actually remains (fixes them otherwise
  // attaching to the pre-transition layer).
  zoomTeardown = mountZoomTransitions(viewportEl, getZoomState, () => {
    remountCaret();
    remountFocusMask();
  });
  window.addEventListener('beforeunload', () => {
    zoomTeardown?.();
    zoomTeardown = null;
    caretTeardown?.();
    caretTeardown = null;
    focusMaskTeardown?.();
    focusMaskTeardown = null;
    statusBadge?.teardown();
    statusBadge = null;
  });

  void installMenu();
  installKeyboardShortcuts();
  installDevHud();

  // The watcher fires this on disk change → silent hot-reload (spec §5.3).
  void listen('doc://changed', () => {
    void handleDocChanged();
  });
});

/**
 * The silent hot-reload contract (spec §5.3), driven by `doc://changed`:
 *  1. re-`invoke('load_document')` for the tracked path;
 *  2. same `docHash` (both native) → drop silently, no UI change at all;
 *  3. else one `DOC_LOADED` store emission;
 *  4. keyed per-group reconciliation at k=0 (D7 — unchanged groups keep DOM
 *     identity; NEVER a container wipe); a plain re-render at −1/−2;
 *  5. tiered caret restoration; null → clear caret + preserve scroll by ratio;
 *  6. NO modal, NO diff view.
 */
async function handleDocChanged(): Promise<void> {
  if (currentPath === null) return;

  let newResult: LoadResultDTO;
  try {
    newResult = await invoke<LoadResultDTO>('load_document', { path: currentPath });
  } catch (err) {
    console.warn('reload: load_document failed; keeping current view:', err);
    return;
  }

  // (§5.3 step 2) Identical content on both sides → drop silently.
  if (
    currentResult?.kind === 'native' &&
    newResult.kind === 'native' &&
    currentTable !== null &&
    newResult.table.docHash === currentTable.docHash
  ) {
    return;
  }

  // Capture the OLD state before the store swap so caret restoration can diff.
  const oldTable = currentTable;
  const oldCaret = snapshot().caret;
  const wasNativeK0 = currentResult?.kind === 'native' && currentLevel === 0;
  const oldLayer = viewportEl.querySelector<HTMLElement>('.level-layer');
  const scrollRatio =
    oldLayer && oldLayer.scrollHeight > 0 ? oldLayer.scrollTop / oldLayer.scrollHeight : 0;

  // (§5.3 step 3) One store emission ⇒ one render pass.
  actions$.next(docLoaded(newResult));
  currentResult = newResult;

  if (newResult.kind === 'native') {
    summariesAvailable = true;
    currentTable = newResult.table;
    currentIndex = buildIndex(newResult.table);
    statusEl.textContent = 'Native';
    statusBadge?.setStatus('native');

    if (wasNativeK0 && currentLevel === 0) {
      // (§5.3 step 4) Keyed reconciliation of the LIVE k=0 reading column.
      const column = viewportEl.querySelector<HTMLElement>('.reading-column');
      if (column) {
        const table = newResult.table;
        const index = currentIndex;
        prevGroups = reconcile(column, table, index, prevGroups, (sid) =>
          buildGroup(table, index, sid),
        );
        remountCaret();
        remountFocusMask();
        mountSliderForState();
      } else {
        renderCurrent();
      }
    } else {
      // At −1/−2 a plain re-render is cheap and correct (no k=0 groups mounted).
      renderCurrent();
    }

    // (§5.3 step 5) Tiered caret restoration.
    if (oldTable) {
      const restored = restoreCaret(oldCaret, oldTable, newResult.table);
      if (restored) {
        markCaret(restored.paragraphId);
        actions$.next(caretPlaced(restored.paragraphId, restored.offset));
      } else if (currentLevel === 0) {
        // Caret cleared (already reset by DOC_LOADED) → preserve scroll by ratio.
        const layer = viewportEl.querySelector<HTMLElement>('.level-layer');
        if (layer) scrollCommands$.next({ el: layer, top: scrollRatio * layer.scrollHeight });
      }
    }
  } else {
    // Untagged / Corrupt: fall back to the raw k=0 view.
    summariesAvailable = false;
    currentTable = null;
    currentIndex = null;
    currentLevel = 0;
    prevGroups = new Map();

    const layer = document.createElement('div');
    layer.className = 'level-layer';
    const pre = document.createElement('pre');
    pre.textContent = newResult.raw;
    layer.appendChild(pre);
    viewportEl.replaceChildren(layer);
    viewportEl.dataset.zoom = '0';
    caretTeardown?.();
    caretTeardown = null;
    focusMaskTeardown?.();
    focusMaskTeardown = null;
    statusEl.textContent =
      newResult.kind === 'corrupt' ? `Corrupt: ${newResult.error}` : 'Untagged';
    if (newResult.kind === 'corrupt') {
      statusBadge?.setStatus('corrupt', newResult.error);
    } else {
      statusBadge?.setStatus('untagged');
    }
    mountSliderForState();
  }

  // (§5.3 step 6) A real (non-silent) reload was applied → the ONLY permitted
  // feedback: a 1.5s non-modal "Updated" pill. The identical-docHash silent
  // path returned early above and shows NOTHING.
  statusBadge?.flashUpdated('Updated');
}
