// The ONLY module allowed to import `@tauri-apps/*` (ESLint boundary).
// It owns all lifecycles and routes Tauri access to the Tauri-free
// engine/ and ui/ modules (spec §6, §3.3).
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

import { buildIndex, type ZoomLevel } from './engine/schema';
import type { LoadResultDTO } from './engine/engine-a';
import { renderLevel } from './ui/viewport';
import { mountSlider } from './ui/slider';

import './styles/base.css';
import './styles/slider.css';
import './styles/focus-mask.css';

// --- session state (the RxJS store arrives in Task 2.1; direct wiring for now) ---
let currentLevel: ZoomLevel = 0;
let currentResult: LoadResultDTO | null = null;
let sliderTeardown: (() => void) | null = null;

let viewportEl: HTMLElement;
let sliderEl: HTMLElement;
let statusEl: HTMLElement;

/** Render the active result at `currentLevel` and (re)mount the slider. */
function applyResult(result: LoadResultDTO): void {
  currentResult = result;

  if (result.kind === 'native') {
    const { table } = result;
    const index = buildIndex(table);
    renderLevel(viewportEl, table, index, currentLevel);
    statusEl.textContent = 'Native';

    sliderTeardown?.();
    sliderTeardown = mountSlider(sliderEl, {
      onChange: (level) => {
        currentLevel = level;
        // No transition yet (Task 2.4) — re-render instantly.
        renderLevel(viewportEl, table, index, level);
      },
    });
  } else {
    // Untagged / Corrupt: no summaries exist. Show raw at k=0 and disable
    // the summary detents (spec §2.7 seam).
    currentLevel = 0;
    viewportEl.dataset.zoom = '0';
    const layer = document.createElement('div');
    layer.className = 'level-layer';
    const pre = document.createElement('pre');
    pre.textContent = result.raw;
    layer.appendChild(pre);
    viewportEl.replaceChildren(layer);

    statusEl.textContent =
      result.kind === 'corrupt' ? `Corrupt: ${result.error}` : 'Untagged';

    sliderTeardown?.();
    sliderTeardown = mountSlider(sliderEl, {
      onChange: (level) => {
        currentLevel = level;
      },
      disabledLevels: [-1, -2],
    });
  }
}

export async function openFile(path: string): Promise<void> {
  const result = await invoke<LoadResultDTO>('load_document', { path });
  applyResult(result);

  // `watch_directory` (spec §5) lands in Task 3.1 and is not yet registered
  // on the Rust side. Guard so opening a file never crashes the app.
  try {
    await invoke('watch_directory', { path }); // TODO(Task 3.1): watches parent dir
  } catch (err) {
    console.warn('watch_directory not yet available (lands in Task 3.1):', err);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  viewportEl = document.querySelector<HTMLElement>('#viewport')!;
  sliderEl = document.querySelector<HTMLElement>('#slider')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;

  document.querySelector('#open-file')?.addEventListener('click', async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (typeof selected === 'string') {
      await openFile(selected);
    }
  });

  // The watcher fires this on disk change. Silent hot-reload lands in Task 3.2;
  // for now, re-open the last file's directory event is a no-op placeholder.
  void listen('doc://changed', () => {
    if (currentResult) applyResult(currentResult);
  });
});
