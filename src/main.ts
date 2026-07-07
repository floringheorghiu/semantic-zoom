// The ONLY module allowed to import `@tauri-apps/*` (ESLint boundary).
// It owns all lifecycles and routes Tauri access to the Tauri-free
// engine/ and ui/ modules (spec §6, §3.3).
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

import { buildIndex, type ZoomLevel, type LookupTable, type ResolvedIndex } from './engine/schema';
import type { LoadResultDTO } from './engine/engine-a';
import { renderLevel } from './ui/viewport';
import { mountSlider } from './ui/slider';
import { mountCaret } from './ui/caret';

// The store: main.ts is the only place (with state/) allowed to feed actions$.
// Components dispatch + subscribe to selectors; only this file wires the bus.
import { actions$ } from './state/store';
import { caretPlaced, docLoaded } from './state/actions';
import { selectCaret } from './state/selectors';
import type { Subscription } from 'rxjs';

import './styles/base.css';
import './styles/slider.css';
import './styles/focus-mask.css';
import './styles/reading.css';

// --- session state (the RxJS store arrives in Task 2.1; direct wiring for now) ---
let currentLevel: ZoomLevel = 0;
let currentResult: LoadResultDTO | null = null;
let currentTable: LookupTable | null = null;
let currentIndex: ResolvedIndex | null = null;
/** True only when Engine-A summaries exist (native docs). Gates −1/−2. */
let summariesAvailable = false;
let sliderTeardown: (() => void) | null = null;
let caretTeardown: (() => void) | null = null;

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
    onChange: setLevel,
    disabledLevels,
    active: currentLevel,
  });
}

/** Render the current document at `currentLevel` and sync the slider. */
function renderCurrent(): void {
  viewportEl.dataset.zoom = String(currentLevel);
  if (currentTable && currentIndex) {
    // TODO(Task 2.4): migrate to full store-driven rendering (zoom transition).
    renderLevel(viewportEl, currentTable, currentIndex, currentLevel);
  }
  remountCaret();
  mountSliderForState();
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

/** Set the active zoom level. Ignores levels whose summaries don't exist. */
function setLevel(level: ZoomLevel): void {
  if (!availableLevels().includes(level)) return;
  if (level === currentLevel) return;
  currentLevel = level;
  // No transition yet (Task 2.4) — re-render instantly.
  renderCurrent();
}

/** Step zoom: +1 = zoom in (toward raw/0), −1 = zoom out (toward story/−2). */
function stepZoom(dir: 1 | -1): void {
  const target = Math.max(-2, Math.min(0, currentLevel + dir)) as ZoomLevel;
  setLevel(target);
}

/** Apply a freshly loaded document. Resets to the raw level. */
function applyResult(result: LoadResultDTO): void {
  currentResult = result;
  currentLevel = 0;

  if (result.kind === 'native') {
    summariesAvailable = true;
    currentTable = result.table;
    currentIndex = buildIndex(result.table);
    statusEl.textContent = 'Native';
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
    // Raw view has no `.pnode`s — no caret target.
    caretTeardown?.();
    caretTeardown = null;

    statusEl.textContent =
      result.kind === 'corrupt' ? `Corrupt: ${result.error}` : 'Untagged';
    mountSliderForState();
  }
}

export async function openFile(path: string): Promise<void> {
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
      await MenuItem.new({ id: 'lvl-raw', text: 'Detail (Raw)', accelerator: 'CmdOrCtrl+1', action: () => setLevel(0) }),
      await MenuItem.new({ id: 'lvl-sections', text: 'Sections', accelerator: 'CmdOrCtrl+2', action: () => setLevel(-1) }),
      await MenuItem.new({ id: 'lvl-story', text: 'Story', accelerator: 'CmdOrCtrl+3', action: () => setLevel(-2) }),
      await sep(),
      await MenuItem.new({ id: 'zoom-in', text: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', action: () => stepZoom(1) }),
      await MenuItem.new({ id: 'zoom-out', text: 'Zoom Out', accelerator: 'CmdOrCtrl+-', action: () => stepZoom(-1) }),
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

/**
 * Plain-key shortcuts (no modifier) as quick conveniences alongside the menu
 * accelerators: 1/2/3 jump to a level, [ / ] step zoom. Ignored while a text
 * field is focused or when a modifier is held (so ⌘-combos reach the menu).
 */
function installKeyboardShortcuts(): void {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;

    switch (e.key) {
      case '1': setLevel(0); break;
      case '2': setLevel(-1); break;
      case '3': setLevel(-2); break;
      case ']': stepZoom(1); break;   // zoom in toward raw
      case '[': stepZoom(-1); break;  // zoom out toward story
      default: return;
    }
    e.preventDefault();
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

  document.querySelector('#open-file')?.addEventListener('click', () => void promptOpen());

  void installMenu();
  installKeyboardShortcuts();
  installDevHud();

  // The watcher fires this on disk change. Silent hot-reload lands in Task 3.2;
  // for now, re-render the current document.
  void listen('doc://changed', () => {
    if (currentResult) renderCurrent();
  });
});
