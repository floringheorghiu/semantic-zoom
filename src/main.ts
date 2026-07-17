// The ONLY module allowed to import `@tauri-apps/*` (ESLint boundary).
// It owns all lifecycles and routes Tauri access to the Tauri-free
// engine/ and ui/ modules (spec §6, §3.3).
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { ask, open } from '@tauri-apps/plugin-dialog';
import { Menu, Submenu, MenuItem, PredefinedMenuItem } from '@tauri-apps/api/menu';

import { buildIndex, type ZoomLevel, type LookupTable, type ResolvedIndex } from './engine/schema';
import type { LoadResultDTO } from './engine/engine-a';
import {
  renderLevel,
  buildGroup,
  mountZoomTransitions,
  scrollCommands$,
  topAlignedScrollTop,
  type ZoomTransitionState,
} from './ui/viewport';
import { buildHeader, titlePid } from './ui/header';
import { buildRawLevel } from './ui/raw-markdown';
import { mountZoomScrubber } from './ui/zoom-scrubber';
import { mountCaret, nextParagraph } from './ui/caret';
import { nextScale, SCALE_DEFAULT } from './ui/content-scale';
// mountFocusMask import removed with the mask disable — see remountFocusMask.
import { markActiveGroup, clearActiveGroups, sectionAtTop } from './ui/active-group';
import { mountStatusBadge, type StatusBadgeHandle } from './ui/status-badge';
import { mountEmptyState } from './ui/empty-state';
import { getRecentFiles, addRecentFile } from './state/recent-files';
import {
  mountContentMap,
  buildMapModel,
  visibleIds,
  type ContentMapHandle,
  type MapBox,
} from './ui/content-map';
import { reconcile, restoreCaret, groupKey } from './state/reload';
import { mountGenerateAffordance, type GenerateAffordanceHandle } from './ui/generate-affordance';
import {
  mountGeneratePicker,
  type GeneratePickerChoice,
  type GeneratePickerHandle,
} from './ui/generate-picker';
import { remoteSynthesizer, lastSynthesisRunMeta } from './native/engine-b-remote';
import {
  mountGenerationTooltip,
  type GenerationRun,
  type GenerationTooltipHandle,
} from './ui/generation-tooltip';

// The store: main.ts is the only place (with state/) allowed to feed actions$.
// Components dispatch + subscribe to selectors; only this file wires the bus.
import { actions$, snapshot } from './state/store';
import { caretPlaced, docLoaded, docClosed, zoomSet, providerStatusLoaded, synthesisStarted, synthesisSucceeded, synthesisFailed } from './state/actions';
import { selectCaret } from './state/selectors';
import type { Subscription } from 'rxjs';

import './styles/tokens.css';
import './styles/base.css';
import './styles/scrubber.css';
import './styles/focus-mask.css';
import './styles/reading.css';
import './styles/content-map.css';
import './styles/empty-state.css';
import './styles/generate-picker.css';
import './styles/generation-tooltip.css';

// --- session state (the RxJS store arrives in Task 2.1; direct wiring for now) ---
let currentLevel: ZoomLevel = 0;
let currentResult: LoadResultDTO | null = null;
let currentTable: LookupTable | null = null;
let currentIndex: ResolvedIndex | null = null;
/** The file currently open — re-invoked on `doc://changed` (silent reload, §5.3). */
let currentPath: string | null = null;
/** k=0 groups from the last render, keyed by sid, for keyed reconciliation (D7). */
let prevGroups = new Map<string, HTMLElement>();
/** Engine B (D10/§8.5): whether a usable provider is configured, and the
    trust-boundary tooltip text to show on the Generate affordance. Refreshed
    at startup and whenever an Untagged doc loads (catches a Settings change
    made in the other window without needing live cross-window sync). */
let providerConfigured = false;
let providerGenerateTooltip = 'Generate summary';
/** The in-flight Engine B request, if any — aborted on hot reload, doc
    close, or a second Generate click (§3.2 row 1's switchMap pattern,
    applied here since this path isn't itself store-driven). */
let synthesisAbort: AbortController | null = null;
/** True only when Engine-A summaries exist (native docs). Gates −1/−2. */
let summariesAvailable = false;
let scrubberTeardown: (() => void) | null = null;
let caretTeardown: (() => void) | null = null;
let focusMaskTeardown: (() => void) | null = null;
let zoomTeardown: (() => void) | null = null;
/** Non-modal status affordance (spec §2.6, §5.3): warning badge + "Updated" pill. */
let statusBadge: StatusBadgeHandle | null = null;
let generationTooltip: GenerationTooltipHandle | null = null;
/** Generation-run history for the OPEN document (chronological, as stored —
    the tooltip reverses for newest-first display). */
let generationRuns: GenerationRun[] = [];
/** The content map sidebar (§4.9). Mounted once; driven by refreshMap/scroll. */
let contentMap: ContentMapHandle | null = null;
/** Engine B's Generate trigger (D10/§8.5, Figma node 199:494) — mounted once. */
let generateAffordance: GenerateAffordanceHandle | null = null;
/** The local-vs-remote picker modal (Figma 202:1232) — non-null while open. */
let generatePicker: GeneratePickerHandle | null = null;
let contentMapTeardown: (() => void) | null = null;
/** The pre-open placeholder (Figma 77:2622); torn down on the first openFile. */
let emptyStateTeardown: (() => void) | null = null;
/**
 * True right after the caret is placed (click/arrow/hot-reload restore),
 * false once the user has scrolled since. Gates whether the caret still
 * counts as "where you currently are" for zoom-out anchoring (§2.5 anchor
 * rule 1) — refining the spec-literal "caret always wins once placed" rule,
 * which otherwise anchors zoom-out to an arbitrarily old click regardless of
 * where you've since scrolled to. See `getZoomState`'s `caretIsCurrent` and
 * `getZoomTransitionEffect` in viewport.ts for where this is consumed.
 */
let caretIsCurrent = false;

let viewportEl: HTMLElement;
let scrubberEl: HTMLElement;
let zoomContextEl: HTMLElement;
let zoomFooterEl: HTMLElement;
let statusEl: HTMLElement;
let docFilenameEl: HTMLElement;
let contentMapEl: HTMLElement;
let generateAffordanceEl: HTMLButtonElement;

/** Window-centered title-bar text (Figma 104-3409 slot) when no document is open. */
const APP_NAME = 'Semantic Zoom';

/** Levels available given the current document. */
function availableLevels(): ZoomLevel[] {
  return summariesAvailable ? [0, -1, -2] : [0];
}

/** Mirrors src-tauri/src/commands/provider_config.rs's ProviderConfig. */
interface ProviderConfigDTO {
  kind: 'remote' | 'ollama' | 'custom-local';
  provider: 'cerebras' | 'xiaomi' | 'openrouter' | 'llama-cpp' | 'ollama';
  base_url: string;
  model: string;
}

/**
 * Engine B provider status (D10/§8.5), re-checked at startup and on every
 * Untagged load. "Configured" means a usable endpoint: local providers just
 * need a base_url; Remote also needs a saved key. Also computes the
 * trust-boundary tooltip text — visible consent at the point of action, not
 * a buried settings-screen disclosure.
 */
async function refreshProviderStatus(): Promise<void> {
  try {
    const config = await invoke<ProviderConfigDTO>('get_provider_config');
    const needsKey = config.kind === 'remote';
    const hasKey = needsKey
      ? await invoke<boolean>('get_api_key_status', { provider: config.provider })
      : true;
    const configured = config.base_url.trim() !== '' && hasKey;
    providerConfigured = configured;
    providerGenerateTooltip = needsKey
      ? `Sends this document's text to ${config.base_url}.`
      : 'Runs locally — nothing leaves your Mac.';
    actions$.next(providerStatusLoaded(configured));
  } catch (err) {
    console.warn('refreshProviderStatus: get_provider_config/get_api_key_status failed:', err);
    providerConfigured = false;
    actions$.next(providerStatusLoaded(false));
  }
}

/** The most recent recorded run failed → the untagged pill's dot turns
    amber (spec: generation-history tooltip design). */
function lastGenerationRunFailed(): boolean {
  return generationRuns[generationRuns.length - 1]?.outcome === 'failed';
}

/** Load the sidecar history for a freshly opened document (rename-resilient
    lookup happens Rust-side). A read failure means an empty tooltip, never
    a blocked open. */
async function refreshGenerationHistory(path: string): Promise<void> {
  try {
    generationRuns = await invoke<GenerationRun[]>('get_generation_history', { path });
  } catch (err) {
    console.warn('get_generation_history failed:', err);
    generationRuns = [];
  }
}

/**
 * Record a completed run (success or failure — NEVER cancels, which are the
 * user changing their mind, not an outcome worth history). Rust assigns the
 * version and returns the capped list, so the tooltip re-renders from what
 * was actually persisted. Recording is best-effort: a store write failure
 * must not turn a successful generation into a visible error.
 */
async function recordGenerationRun(
  outcome: 'succeeded' | 'failed',
  startedAtMs: number,
  config: ProviderConfigDTO | null,
  error?: string,
  table?: LookupTable,
): Promise<void> {
  if (currentPath === null) return;
  const meta = lastSynthesisRunMeta();
  const run: GenerationRun = {
    outcome,
    providerKind: config?.kind ?? 'ollama',
    baseUrl: config?.base_url ?? '',
    model: config?.model ?? '',
    durationMs: Date.now() - startedAtMs,
    finishedAt: new Date().toISOString(),
    version: 0, // assigned by append_generation_run
    attempts: meta?.attempts ?? 0,
    temperature: meta?.temperature ?? 0,
    promptTokens: meta?.usage?.promptTokens,
    completionTokens: meta?.usage?.completionTokens,
    milestones: table ? table.order.meta.length : undefined,
    sections: table ? table.order.sections.length : undefined,
    error,
  };
  try {
    generationRuns = await invoke<GenerationRun[]>('append_generation_run', {
      path: currentPath,
      run,
    });
  } catch (err) {
    console.warn('append_generation_run failed (run not recorded):', err);
  }
}

/** (Re)mount the scrubber reflecting the active level and disabled segments,
    and refresh the per-level context count beside it. The −1/−2 segments
    stay in their normal disabled/dimmed state regardless of Engine B
    availability (Figma node 199:164) — Generate is a separate affordance,
    not a scrubber-segment special case. */
function mountScrubberForState(): void {
  scrubberTeardown?.();
  const available = availableLevels();
  const disabledLevels = ([0, -1, -2] as ZoomLevel[]).filter((l) => !available.includes(l));
  scrubberTeardown = mountZoomScrubber(scrubberEl, {
    onChange: requestLevel,
    disabledLevels,
    active: currentLevel,
  });
  updateZoomContext();
  updateGenerateAffordance();
}

/**
 * Generate affordance visibility (D10/§8.5's matrix, computed the same way
 * selectors.ts's generateAffordanceVisibility does): shown only for an
 * Untagged doc with a usable Engine B provider. Occupies the same corner
 * slot as #content-map, which is hidden whenever there's no LookupTable —
 * i.e. exactly when this needs to show — so the two never collide.
 */
function updateGenerateAffordance(): void {
  const isUntagged = currentResult?.kind === 'untagged';
  const visible = isUntagged && providerConfigured;
  // A picker left open for a document that can no longer generate (closed,
  // reloaded with a payload, went corrupt) is a stale question — retract it.
  if (!isUntagged) closeGeneratePicker();
  generateAffordance?.setVisible(visible);
  generateAffordance?.setTooltip(providerGenerateTooltip);
  // A freshly (re)mounted scrubber always reflects a settled state — never
  // stuck mid-animation from a previous document. handleGenerate/handleCancel
  // own the 'loading' transition explicitly while a request is in flight.
  if (visible) generateAffordance?.setState('idle');
}

function closeGeneratePicker(): void {
  generatePicker?.teardown();
  generatePicker = null;
}

/**
 * The Generate affordance no longer starts synthesis directly — it opens the
 * provider picker (Figma 252:951) and the chosen provider is written to the
 * config store before generating, since that store is the single source the
 * Rust LLM client reads. The v2 microcopy is model-agnostic and static, so
 * no config reads are needed to label the dialog.
 */
function openGeneratePicker(): void {
  if (generatePicker !== null) return;
  if (currentResult?.kind !== 'untagged') return;

  generatePicker = mountGeneratePicker(document.body, {
    onPick: (choice) => void pickProviderAndGenerate(choice),
    onDismiss: closeGeneratePicker,
  });
}

/**
 * Switch the provider config to match the picked kind (if it doesn't
 * already), then run the normal generation path. Switching never erases the
 * other providers' settings — set_provider_config remembers a record per
 * kind, and get_saved_provider_config returns it on the way back.
 */
async function pickProviderAndGenerate(choice: GeneratePickerChoice): Promise<void> {
  closeGeneratePicker();
  try {
    const current = await invoke<ProviderConfigDTO>('get_provider_config');
    const target =
      current.kind === choice
        ? current
        : await invoke<ProviderConfigDTO>('get_saved_provider_config', { kind: choice });
    // Same usability gate as refreshProviderStatus: any kind needs an
    // endpoint; Remote additionally needs a saved key. An unusable pick
    // routes to Settings instead of failing later inside the HTTP client.
    const hasKey =
      choice === 'remote'
        ? await invoke<boolean>('get_api_key_status', { provider: target.provider })
        : true;
    if (target.base_url.trim() === '' || !hasKey) {
      statusBadge?.flashUpdated(
        choice === 'remote'
          ? 'Set the remote endpoint and API key in Settings first'
          : 'Set the server address in Settings first',
        FAILURE_TOAST_MS,
      );
      void invoke('open_settings_window');
      return;
    }
    if (current.kind !== choice) {
      await invoke('set_provider_config', { config: target });
    }
    await refreshProviderStatus();
    updateGenerateAffordance();
    await handleGenerate();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Provider switch failed:', message);
    statusBadge?.flashUpdated(
      `Couldn't switch provider — ${shortenForToast(message)}`,
      FAILURE_TOAST_MS,
    );
  }
}

/**
 * Engine B generation (D10/§8.4-§8.5): runs the retry-loop synthesizer
 * (T6), persists via write_payload (T8 — hash-guarded, so a concurrent edit
 * is never clobbered), then renders the result immediately rather than
 * waiting for the watcher's own doc://changed round-trip (which still
 * fires and is a no-op, same docHash). Aborts any prior in-flight request —
 * a second click or a hot reload mid-flight must not race two writes.
 */
async function handleGenerate(): Promise<void> {
  if (currentResult?.kind !== 'untagged' || currentPath === null) return;

  synthesisAbort?.abort();
  const controller = new AbortController();
  synthesisAbort = controller;

  // History raw material: what config this run ACTUALLY uses, and when it
  // started. Read up front — a Settings change mid-run must not relabel it.
  const startedAt = Date.now();
  let runConfig: ProviderConfigDTO | null = null;
  try {
    runConfig = await invoke<ProviderConfigDTO>('get_provider_config');
  } catch (err) {
    console.warn('handleGenerate: could not read provider config for history:', err);
  }
  if (controller.signal.aborted) return;

  actions$.next(synthesisStarted());
  generateAffordance?.setState('loading');
  // PERSISTENT badge, not just a toast: a run takes minutes, so anyone who
  // looked away must still find the current state (and later the outcome)
  // in the toolbar, not have missed a 3-second pill.
  statusBadge?.setStatus('synthesizing');
  statusEl.textContent = 'Generating…';
  statusBadge?.flashUpdated('Generating summary…', TOAST_MS);

  try {
    const table = await remoteSynthesizer.synthesize(currentResult.raw, controller.signal);
    if (controller.signal.aborted) return;

    // write_payload's return value MUST be checked, not just awaited — a
    // hash-mismatch guard (§8.4: the file changed on disk since we read it)
    // resolves successfully with `{ kind: 'skippedHashMismatch' }`, not a
    // thrown error. Treating any non-throwing result as success previously
    // meant the UI claimed "Summary generated" and jumped to Native for a
    // file that was never actually written — the next watcher reload would
    // then silently snap it back to Untagged, since load_document correctly
    // found no payload on disk. That mismatch is exactly what a hash-guard
    // skip must surface honestly instead.
    const outcome = await invoke<{ kind: 'written' | 'skippedHashMismatch' }>('write_payload', {
      path: currentPath,
      table,
      docHash: table.docHash,
    });
    if (controller.signal.aborted) return;

    if (outcome.kind === 'skippedHashMismatch') {
      generateAffordance?.setState('idle');
      console.error('write_payload: skipped — file changed on disk since generation started');
      statusBadge?.setStatus('generationFailed', 'the file changed on disk while generating; nothing was written');
      statusEl.textContent = 'Untagged';
      statusBadge?.flashUpdated("Couldn't save — the file changed while generating", FAILURE_TOAST_MS);
      mountScrubberForState();
      void recordGenerationRun(
        'failed',
        startedAt,
        runConfig,
        'Generation failed: the file changed on disk while generating; nothing was written',
      );
      return;
    }

    actions$.next(synthesisSucceeded(table));
    void recordGenerationRun('succeeded', startedAt, runConfig, undefined, table);
    currentTable = table;
    currentIndex = buildIndex(table);
    currentResult = { kind: 'native', table, raw: currentResult.raw };
    summariesAvailable = true;
    statusEl.textContent = 'Native';
    statusBadge?.setStatus('native');
    statusBadge?.flashUpdated('Summary generated', TOAST_MS);
    renderCurrent();
    mountScrubberForState();
  } catch (err) {
    if (controller.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    actions$.next(synthesisFailed(message));
    void recordGenerationRun('failed', startedAt, runConfig, `Generation failed: ${message}`);
    generateAffordance?.setState('idle');
    // Persistent amber badge with the full error on hover — survives until
    // the user's next action, unlike the toast. Console gets it verbatim.
    console.error('Engine B generation failed:', message);
    statusBadge?.setStatus('generationFailed', message);
    statusEl.textContent = 'Untagged';
    statusBadge?.flashUpdated(`Couldn't generate — ${shortenForToast(message)}`, FAILURE_TOAST_MS);
    mountScrubberForState();
  } finally {
    if (synthesisAbort === controller) synthesisAbort = null;
  }
}

/** How long Engine B's start/success/cancel toasts stay legible — longer
    than the 1.5s hot-reload pill (spec §5.3), which is too brief to read a
    full sentence. */
const TOAST_MS = 3000;
/** Failure toasts get even more time — the message is inherently less
    skimmable ("Couldn't generate — ..."). */
const FAILURE_TOAST_MS = 6000;

/** Keep the transient pill to one glanceable line; full detail goes to
    the console (see the call site above), never into the toast itself. */
function shortenForToast(message: string, maxLen = 80): string {
  const firstSentence = message.split(/(?<=[.!?])\s/)[0] ?? message;
  return firstSentence.length > maxLen ? `${firstSentence.slice(0, maxLen - 1)}…` : firstSentence;
}

/**
 * "Remove zoom layers…" from the history card (spec
 * docs/superpowers/specs/2026-07-17-remove-zoom-payload-design.md): gate
 * behind a NATIVE confirmation dialog, then have Rust strip the payload
 * block (remove_payload mirrors write_payload — same scanner as
 * load_document, same atomic write). The watcher deliberately ignores the
 * rewrite (raw-content hash unchanged), so the reload here is explicit.
 * Generation history is a sidecar, never part of the file — it survives,
 * and the removal itself lands in it as a `removed` event.
 */
async function handleRemoveZoomLayers(): Promise<void> {
  if (currentPath === null || currentResult?.kind !== 'native') return;
  const path = currentPath;

  const confirmed = await ask(
    'The generated summaries will be deleted from the file. ' +
      'Your markdown text and the generation history are untouched, ' +
      'and you can generate new zoom layers at any time.',
    { title: 'Remove zoom layers?', kind: 'warning', okLabel: 'Remove', cancelLabel: 'Cancel' },
  );
  if (!confirmed) return;
  // The dialog was open for an arbitrary while — the doc may have closed
  // or changed underneath it. Re-check before touching disk.
  if (currentPath !== path) return;

  try {
    await invoke('remove_payload', { path, removedAt: new Date().toISOString() });
  } catch (err) {
    console.warn('remove_payload failed:', err);
    statusBadge?.flashUpdated(
      `Couldn't remove zoom layers — ${shortenForToast(String(err))}`,
      FAILURE_TOAST_MS,
    );
    return;
  }

  // NoPayload and Removed converge here on purpose: either way the file has
  // no payload now, and the view must say so.
  await refreshGenerationHistory(path);
  try {
    const result = await invoke<LoadResultDTO>('load_document', { path });
    actions$.next(docLoaded(result));
    applyResult(result);
  } catch (err) {
    console.warn('reload after remove_payload failed:', err);
  }
  statusBadge?.flashUpdated('Zoom layers removed', TOAST_MS);
}

/**
 * User-initiated cancel (hover-to-stop on the loading affordance, Figma
 * node 199:890) — distinct from the silent aborts in handleDocChanged/
 * closeDocument: this one gets its own toast because the user explicitly
 * asked for it, where those are superseded-by-something-else and stay quiet.
 * "Soft" cancellation: the in-flight llm_complete/write_payload calls keep
 * running to completion on the Rust/provider side, their result is just
 * ignored once `signal.aborted` is checked — matching the existing
 * switchMap-abort convention (§3.2 row 1), not a real network cancel.
 */
function handleCancel(): void {
  if (!synthesisAbort) return;
  synthesisAbort.abort();
  synthesisAbort = null;
  // Real cancellation: drop Rust's in-flight HTTP request so the provider
  // actually stops generating (llama-server frees the GPU the moment the
  // connection drops) — without this, Stop only made the UI look idle
  // while Ollama kept computing the full answer in the background.
  void invoke('cancel_llm_generation');
  actions$.next(synthesisFailed('cancelled by user'));
  generateAffordance?.setState('idle');
  // Back to the plain untagged note — a user-initiated cancel isn't a
  // failure worth a persistent amber badge (and is never recorded in the
  // generation history); the toast is acknowledgment.
  statusBadge?.setStatus('untagged', undefined, { lastRunFailed: lastGenerationRunFailed() });
  statusEl.textContent = 'Untagged';
  statusBadge?.flashUpdated('Generation cancelled', TOAST_MS);
  mountScrubberForState();
}

/**
 * Update the bottom-right context count for the CURRENT level, drawn from
 * `currentTable.order`: −2 → `${M} milestones`, −1 → `${S} sections`,
 * 0 → `${P} paragraphs`. Empty when no native document is open.
 */
function updateZoomContext(): void {
  if (!currentTable) {
    zoomContextEl.textContent = '';
    return;
  }
  const P = currentTable.order.paragraphs.length;
  const S = currentTable.order.sections.length;
  const M = currentTable.order.meta.length;
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (currentLevel === -2) zoomContextEl.textContent = plural(M, 'milestone');
  else if (currentLevel === -1) zoomContextEl.textContent = plural(S, 'section');
  else zoomContextEl.textContent = plural(P, 'paragraph');
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
    caretIsCurrent,
    lastCaretIn: s.lastCaretIn,
    lastAnchorIn: s.lastAnchorIn,
  };
}

// --- Content map sidebar (§4.9) ---------------------------------------------
//
// The map is `#content-map`, a sibling of `#viewport` inside `.viewport-wrap`,
// so `renderLevel`'s `replaceChildren(#viewport)` can never wipe it. main.ts
// owns every crossing: it injects `onSelect`, rebuilds the model on doc/level/
// scale change, and drives the active-section highlight from a rAF-throttled
// scroll read.

/** Cached `.pgroup` boxes of the current layer; the scroll path never re-reads. */
let mapBoxes: MapBox[] = [];
/** Pending scroll-update frame, so bursts of scroll events coalesce into one. */
let mapRaf = 0;
/**
 * The group currently carrying `data-active` (the accent border, §4.6). Derived
 * from the SAME scroll read that drives the map, so the border costs no extra
 * layout access. Reset — with the stale attribute swept — whenever the layer or
 * its groups are rebuilt (see `resetActiveGroup`).
 */
let prevActiveGroupId: string | null = null;

/**
 * The layer (or, after a keyed reconcile, some of its groups) was rebuilt: drop
 * any surviving `data-active` and forget the remembered id, so the next scroll
 * read re-derives the border from scratch. A reused D7 node keeps its
 * attributes, hence the sweep — nulling `prevActiveGroupId` alone would strand
 * a border on it. Called once per rebuild, never on the scroll path.
 */
function resetActiveGroup(): void {
  prevActiveGroupId = null;
  const layer = currentLayer();
  if (layer) clearActiveGroups(layer);
}

/**
 * The layer that owns scroll. `.level-layer` is `position:absolute; inset:0;
 * overflow-y:auto` — it, not `#viewport`, is the scroll container. Mid-
 * transition two layers are mounted; the entering one is appended last and is
 * the one that survives, so take the last.
 */
function currentLayer(): HTMLElement | null {
  const layers = viewportEl.querySelectorAll<HTMLElement>('.level-layer');
  return layers.length ? layers[layers.length - 1] : null;
}

/**
 * Scroll the current layer so `id`'s element (a paragraph, section, or
 * milestone — whichever it is) sits just below the top edge — never
 * centered. The write goes through the single rAF `scrollCommands$` queue
 * (spec §3.2) — `.scrollTop` is NEVER assigned here. Used by both the
 * content-map's click-to-navigate and ⌘↓/⌘↑'s step-to-next-item.
 *
 * Delegates to `topAlignedScrollTop` (viewport.ts), NOT a raw `el.offsetTop`
 * — a paragraph inside a currently off-screen section reads a missing or
 * GROUP-relative box under `content-visibility: auto` (§4.2) unless that's
 * guarded against (see `measureBox`/`chainedOffsetTop` there for both traps).
 * Deliberately does NOT pass `currentLevel`: content-map bars are SECTION
 * ids at BOTH k=0 and k=−1 (buildMapModel), not "whatever the zoom-anchor
 * target type is at this level" — passing the level here once caused this
 * function to silently search for the wrong element and no-op at k=0.
 * `topAlignedScrollTop` instead matches whichever id "kind" `id` actually is.
 *
 * Measure → scroll → re-measure over a few frames, exactly like the zoom
 * transition's `settleScroll` (§2.5) and for the same reason: the first
 * measurement can be approximate (skipped groups above the target still
 * carry `contain-intrinsic-size` estimates; an engine that doesn't
 * materialize forced boxes synchronously lands coarsely at the group top).
 * Scrolling makes the browser really render the target region, the next
 * frame's measurement is exact, and the loop stops at the fixpoint.
 */
function scrollItemToTop(id: string, framesLeft = 5): void {
  const layer = currentLayer();
  if (!layer) return;
  const top = topAlignedScrollTop(layer, id);
  if (top === null) return;
  if (Math.abs(layer.scrollTop - top) <= 1) return; // converged
  scrollCommands$.next({ el: layer, top }); // the single rAF-scheduled queue
  if (framesLeft > 0) {
    requestAnimationFrame(() => scrollItemToTop(id, framesLeft - 1));
  }
}

/**
 * Move the active-item marker + scroll + (at k=0) caret to `next` — the
 * shared tail end of both ⌘↓/⌘↑ single-stepping and ⌘⇧↓/⌘⇧↑ jump-to-edge.
 * A no-op if there's nothing to move to, or `next` is already current.
 *
 * `prevActiveGroupId` is kept current by every scroll tick
 * (`updateMapFromScroll`'s `sectionAtTop`) at all levels, so callers pick up
 * from wherever the user scrolled to, and the explicit `markActiveGroup`
 * here keeps a second rapid call stepping from the right place.
 */
function moveActiveGroup(next: string | null): void {
  if (!currentTable || !next) return;
  const current = prevActiveGroupId;
  if (next === current) return;
  const layer = currentLayer();
  if (layer) markActiveGroup(layer, next, current);
  prevActiveGroupId = next;
  scrollItemToTop(next);

  // Focus mask (§4.3) is caret-driven and independent of the active-group
  // border above — without this, stepping to a new section left the mask
  // spotlit on wherever the caret was last CLICKED, not where navigation
  // just took you. Move the caret to the target section's first paragraph,
  // same as a click there would (mountCaret's callback), so the mask
  // follows. Only meaningful at k=0 — the caret/mask don't exist at −1/−2.
  if (currentLevel === 0) {
    const firstPid = currentTable.sections[next]?.children[0];
    if (firstPid) {
      caretIsCurrent = true;
      actions$.next(caretPlaced(firstPid, 0));
    }
  }
}

/**
 * ⌘↓ / ⌘↑ (View menu): step to the next/previous item at the CURRENT zoom
 * level — SECTIONS at k=0 and k=−1, milestones at k=−2 — and scroll it to
 * the top via `scrollItemToTop` (never centered, per the request this
 * implements). A no-op with nothing structured to step through (no
 * document, or an untagged/corrupt raw view).
 *
 * k=0 deliberately steps SECTION-by-section, not paragraph-by-paragraph.
 * Paragraph stepping shipped four times and never scrolled in the real
 * app's WKWebView despite passing every headless-Chrome and jsdom check —
 * measuring a `.pnode` inside a `content-visibility: auto` group is
 * engine-behavior-dependent in ways this machine cannot verify headlessly
 * (see bb00e65 and docs/live-app-testing-setup.md). Section targets are
 * their own `.pgroup` boxes — the one measurement path the user confirmed
 * working at EVERY level (it's what content-map clicks use, including at
 * k=0) — so ⌘↓/⌘↑ now walks the same ids the content map shows,
 * user-approved trade. Restore paragraph stepping only with real-WebKit
 * verification in hand.
 */
function navigateItem(dir: 1 | -1): void {
  if (!currentTable) return;
  const ids = currentLevel === -2 ? currentTable.order.meta : currentTable.order.sections;
  moveActiveGroup(nextParagraph(ids, prevActiveGroupId, dir));
}

/**
 * ⌘⇧↓ / ⌘⇧↑ (View menu): jump straight to the LAST/FIRST item at the
 * current level — same id space as `navigateItem` (sections at k=0/−1,
 * milestones at k=−2), just the ends of `ids` instead of one step from
 * wherever you are. `topAlignedScrollTop`'s own clamp to
 * `[0, scrollHeight - clientHeight]` (viewport.ts) means landing on the
 * LAST id already lands at the true bottom of the document, not just that
 * section's top — no separate "scroll to max" path needed.
 */
function jumpToEdge(dir: 1 | -1): void {
  if (!currentTable) return;
  const ids = currentLevel === -2 ? currentTable.order.meta : currentTable.order.sections;
  if (ids.length === 0) return;
  moveActiveGroup(dir === 1 ? ids[ids.length - 1] : ids[0]);
}

/**
 * Cache the mounted group boxes (`offsetTop`/`offsetHeight`) — a plain offset
 * read of an already-laid-out layer, the same cheap measurement `mountedBoxes`
 * uses in the transition.
 *
 * Called on EVERY rAF-throttled scroll tick (from `updateMapFromScroll`), not
 * just once per render. `.pgroup` carries `content-visibility: auto` (§4.2)
 * for performance on long documents: an off-screen group's height is a rough
 * `contain-intrinsic-size` PLACEHOLDER (480px) until the browser has actually
 * rendered it. A one-time cache taken right after render bakes that
 * placeholder into every not-yet-visited section's `offsetTop`/`offsetHeight`
 * — and never corrects it, so real scroll position and the cached numbers
 * diverge further the deeper you read (worst for a section padded out by a
 * big code block, whose true height differs most from the guess). Both
 * consumers below — `sectionAtTop` (the reading-column border) AND
 * `visibleIds` (the sidebar map's active bars, content-map.ts, LOCKED
 * semantics) — read this same cache, so a stale snapshot broke both:
 * mid-document the wrong section lit up; near the end, the stale cache's
 * "document" was numerically shorter than the real one, so nothing did.
 * Re-measuring here keeps every VISITED section's box exactly correct at all
 * times — only sections still below the fold carry any estimate, matching
 * the browser's own corrected state as you scroll through them.
 */
function cacheMapBoxes(): void {
  mapBoxes = [];
  const layer = currentLayer();
  if (!layer) return;
  for (const el of layer.querySelectorAll<HTMLElement>('.pgroup[data-sid], .pgroup[data-mid]')) {
    const id = el.dataset.sid ?? el.dataset.mid;
    if (!id) continue;
    mapBoxes.push({ id, offsetTop: el.offsetTop, offsetHeight: el.offsetHeight });
  }
}

/**
 * Refresh the box cache, then read the layer's scroll metrics, then write the
 * map's active bars AND the reading column's active-group border (§4.6).
 * Strict read-then-write: `cacheMapBoxes` and the scroll metrics are both
 * reads, done together before any write below.
 *
 * The border uses `sectionAtTop` (ui/active-group.ts), NOT the §2.5
 * zoom-transition anchor (`resolveAnchor`, "nearest box center" — that one
 * stays untouched, used only for cross-level scroll targeting). Reusing
 * `resolveAnchor` here used to make the border drift, worst around any
 * section padded out by a large code block — see active-group.ts for why.
 * The caret is deliberately NOT consulted for the border — it must exist
 * before any caret is placed, and `focus-mask.ts` already owns the
 * caret-driven dimming.
 */
function updateMapFromScroll(): void {
  const layer = currentLayer();
  if (!layer) return;

  // --- READS (all of them, together) ---
  cacheMapBoxes();
  const { scrollTop, clientHeight } = layer;

  // --- WRITES ---
  const activeId = sectionAtTop(mapBoxes, scrollTop);
  markActiveGroup(layer, activeId, prevActiveGroupId);
  prevActiveGroupId = activeId;

  if (!contentMap) return;
  contentMap.setActive(visibleIds(mapBoxes, scrollTop, clientHeight));
}

/**
 * Rebuild the map for the current document + level, and sync the active
 * highlight once (which also (re)caches the group boxes — see
 * `updateMapFromScroll`). Called after every render, after the zoom
 * transition settles, and after a content-scale change (CSS `zoom` reflows
 * the column, invalidating every cached offset). Hidden for non-native
 * documents, which have no groups to map.
 */
function refreshMap(): void {
  if (!contentMap) return;
  if (!currentTable || !currentIndex) {
    contentMapEl.hidden = true;
    mapBoxes = [];
    return;
  }
  contentMapEl.hidden = false;
  contentMap.render(buildMapModel(currentTable, currentIndex, currentLevel));
  updateMapFromScroll();
}

/** rAF-throttled scroll tracking: one frame per burst, regardless of event rate. */
function onViewportScroll(): void {
  if (mapRaf) return;
  mapRaf = requestAnimationFrame(() => {
    mapRaf = 0;
    updateMapFromScroll();
  });
}

/**
 * A genuine user scroll gesture (trackpad/wheel) happened — the caret no
 * longer represents "where you currently are" for zoom-out anchoring (see
 * `caretIsCurrent`). Deliberately `wheel`, not the `scroll` event: `scroll`
 * also fires for OUR OWN programmatic writes (`scrollCommands$`, e.g. the
 * zoom transition settling into its target), which must NOT invalidate the
 * caret that transition itself just used as anchor.
 */
function onViewportWheel(): void {
  caretIsCurrent = false;
}

/**
 * Mount the map once. The listener is CAPTURE-phase on `#viewport`: scroll does
 * not bubble, but it does propagate down the capture path from the window, so
 * this single listener catches the `.level-layer`'s scroll across layer swaps.
 */
function mountContentMapOnce(): void {
  contentMap = mountContentMap(contentMapEl, { onSelect: scrollItemToTop });
  viewportEl.addEventListener('scroll', onViewportScroll, true);
  viewportEl.addEventListener('wheel', onViewportWheel, { passive: true });
  contentMapTeardown = () => {
    viewportEl.removeEventListener('scroll', onViewportScroll, true);
    viewportEl.removeEventListener('wheel', onViewportWheel);
    if (mapRaf) cancelAnimationFrame(mapRaf);
    mapRaf = 0;
    contentMap?.teardown();
    contentMap = null;
  };
  refreshMap();
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
  mountScrubberForState();
  resetActiveGroup(); // the old layer node is gone; re-derive the border below
  refreshMap();
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
 * Focus mask (§4.3) DISABLED by product decision, 2026-07-09: in live use the
 * caret-driven dimming read as annoying — everything except the last-clicked
 * section sat at reduced opacity, which fought the new ⌘↓/⌘↑ section
 * navigation instead of helping it. The module and its tests are kept intact
 * (src/ui/focus-mask.ts); to re-enable, restore the mountFocusMask import and
 * the original body:
 *
 *   focusMaskTeardown?.();
 *   focusMaskTeardown = null;
 *   if (!(currentTable && currentLevel === 0)) return;
 *   focusMaskTeardown = mountFocusMask(viewportEl);
 *
 * The function is kept (as a teardown-only no-op) so every existing call site
 * — render, zoom settle, hot reload — stays wired for that re-enable.
 */
function remountFocusMask(): void {
  focusMaskTeardown?.();
  focusMaskTeardown = null;
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
  caretTeardown = mountCaret(viewportEl, (pid, offset) => {
    caretIsCurrent = true;
    actions$.next(caretPlaced(pid, offset));
  });
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
  mountScrubberForState();
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
  // `zoom` reflows the reading column, so every cached `offsetTop`/`offsetHeight`
  // in the map is now stale. Re-measure. (No-op before the map is mounted.)
  refreshMap();
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

    viewportEl.replaceChildren(buildRawLevel(result.raw));
    viewportEl.dataset.zoom = '0';
    // Raw view has `.pnode`s (styled like native k=0) but no `.pgroup`s and no
    // `data-pid` (no LookupTable → no D6 ids to key on) — no caret or
    // focus-mask target.
    caretTeardown?.();
    caretTeardown = null;
    focusMaskTeardown?.();
    focusMaskTeardown = null;

    statusEl.textContent =
      result.kind === 'corrupt' ? `Corrupt: ${result.error}` : 'Untagged';
    if (result.kind === 'corrupt') {
      statusBadge?.setStatus('corrupt', result.error);
    } else {
      statusBadge?.setStatus('untagged', undefined, { lastRunFailed: lastGenerationRunFailed() });
      // Re-check on every Untagged load (not just at startup): catches a
      // Settings change made in the other window since app launch.
      void refreshProviderStatus().then(() => mountScrubberForState());
    }
    mountScrubberForState();
    resetActiveGroup();
    refreshMap(); // no table → hides the map
  }
}

/**
 * Show the pre-open placeholder (Figma 111:3743) in the empty viewport.
 *
 * Also owns the two other "no document" chrome states, so there is exactly
 * one place that flips them together instead of three call sites agreeing by
 * convention:
 *  - the window-centered title-bar slot (Figma 104-3409) falls back to the
 *    app name, the same slot `openFile` later overwrites with the filename;
 *  - `#zoom-footer` (the real, functional level scrubber — meaningless with
 *    no document loaded) is hidden so it can't stack a second, empty-looking
 *    padded bar directly above the empty state's own shortcut-hints footer.
 *    `hideEmptyState` (called the moment a file opens) restores it — this
 *    must NEVER stay hidden once a document is open.
 */
function showEmptyState(): void {
  emptyStateTeardown?.();
  emptyStateTeardown = mountEmptyState(viewportEl, {
    recentFiles: getRecentFiles(),
    onOpen: () => void promptOpen(),
    onSelectRecent: (path) => void openFile(path),
    onSettings: () => void invoke('open_settings_window'),
    version: __APP_VERSION__,
  }).teardown;
  docFilenameEl.textContent = APP_NAME;
  zoomFooterEl.hidden = true;
}

function hideEmptyState(): void {
  emptyStateTeardown?.();
  emptyStateTeardown = null;
  zoomFooterEl.hidden = false;
}

/**
 * File > Close (⌘W): close the current document and return to the pre-open
 * empty state, bumping the just-closed path to the front of Recent Files. A
 * no-op if nothing is open. Note this closes the DOCUMENT, not the window —
 * the native window-chrome close button still closes the actual window.
 */
function closeDocument(): void {
  if (currentPath === null) return;
  addRecentFile(currentPath);

  if (synthesisAbort) {
    synthesisAbort.abort();
    synthesisAbort = null;
    void invoke('cancel_llm_generation'); // free the GPU too, not just the promise
  }

  currentPath = null;
  currentResult = null;
  currentTable = null;
  currentIndex = null;
  currentLevel = 0;
  generationRuns = []; // history is per-document; the tooltip goes dormant
  summariesAvailable = false;
  prevGroups = new Map();
  caretIsCurrent = false;

  actions$.next(docClosed());
  actions$.next(zoomSet(0));

  caretTeardown?.();
  caretTeardown = null;
  focusMaskTeardown?.();
  focusMaskTeardown = null;
  scrubberTeardown?.();
  scrubberTeardown = null;
  zoomContextEl.textContent = '';
  statusEl.textContent = 'No document';
  // docFilenameEl reset to APP_NAME by showEmptyState() below.
  statusBadge?.setStatus('none'); // no document → the status pill disappears

  viewportEl.replaceChildren();
  viewportEl.dataset.zoom = '0';
  resetActiveGroup();
  refreshMap(); // no table → hides the map
  generateAffordance?.setVisible(false);
  showEmptyState();
}

export async function openFile(path: string): Promise<void> {
  currentPath = path; // remembered so `doc://changed` can silently reload it (§5.3)
  // Title-bar filename (Figma 104-3409): the basename, window-centered.
  docFilenameEl.textContent = path.split('/').pop() ?? path;
  // History BEFORE applyResult — the untagged pill's dot state (and the
  // tooltip behind it) must reflect this document from first paint.
  await refreshGenerationHistory(path);
  const result = await invoke<LoadResultDTO>('load_document', { path });
  hideEmptyState();
  addRecentFile(path);
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
      await MenuItem.new({
        id: 'open-settings',
        text: 'Settings…',
        accelerator: 'CmdOrCtrl+,',
        action: () => void invoke('open_settings_window'),
      }),
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
      await MenuItem.new({
        id: 'close-doc',
        text: 'Close',
        accelerator: 'CmdOrCtrl+W',
        action: () => closeDocument(),
      }),
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
      // Step to the next/previous item AT THE CURRENT LEVEL (paragraph at
      // k=0, section at k=−1, milestone at k=−2) — distinct from the level
      // switches above, which change WHICH level you're viewing.
      await MenuItem.new({ id: 'nav-next', text: 'Next Item', accelerator: 'CmdOrCtrl+Down', action: () => navigateItem(1) }),
      await MenuItem.new({ id: 'nav-prev', text: 'Previous Item', accelerator: 'CmdOrCtrl+Up', action: () => navigateItem(-1) }),
      await MenuItem.new({ id: 'nav-end', text: 'Jump to End', accelerator: 'CmdOrCtrl+Shift+Down', action: () => jumpToEdge(1) }),
      await MenuItem.new({ id: 'nav-top', text: 'Jump to Top', accelerator: 'CmdOrCtrl+Shift+Up', action: () => jumpToEdge(-1) }),
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

  // Register the Window submenu as NSApp.windowsMenu. Without this, AppKit
  // treats it as an ordinary submenu and never injects the native window-
  // management items (Move & Resize halves/quarters, Fill, Center, the
  // open-window list). The system window-tiling keyboard shortcuts are
  // accelerators on those injected items, so they silently no-op app-wide
  // until the submenu is registered — mouse tiling via the green-button
  // hover grid works either way, which is what made this hard to spot.
  await windowMenu.setAsWindowsMenuForNSApp();
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

  // ⌘↓/⌘↑ item navigation, handled in the DOM rather than only via the View-
  // menu accelerator. ⌘↓/⌘↑ are macOS TEXT-NAVIGATION key equivalents
  // (move-to-end/start-of-document), and the webview gets first shot at key
  // equivalents before the menu: whenever a DOM text selection exists — always
  // at k=0 once the caret has been clicked into place — WebKit consumes the
  // event itself and the menu accelerator NEVER fires (verified in the live
  // app 2026-07-09: menu clicks logged, keyboard at k=0 logged nothing; the
  // same keys DID reach navigateItem at −1/−2, where no selection exists).
  // preventDefault() marks the event page-handled, which (a) suppresses
  // WebKit's own move-to-end scroll and (b) stops it being forwarded to the
  // menu — so this fires exactly once per press at every level.
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (inEditable(e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      navigateItem(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // ⌘⇧↓/⌘⇧↑ jump-to-edge, handled in the DOM for the same reason as ⌘↓/⌘↑
  // above: Cmd+Shift+Arrow is macOS's "extend selection to start/end of
  // document" key equivalent, the shifted sibling of the combo that turned
  // out to be eaten by WebKit before the menu accelerator ever saw it
  // whenever a text selection exists (k=0) — same risk, same fix.
  window.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || !e.shiftKey) return;
    if (inEditable(e.target)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      jumpToEdge(e.key === 'ArrowDown' ? 1 : -1);
    }
  });

  // Plain ArrowUp/ArrowDown: wheel-like line scroll of the current layer,
  // previously unsupported. Deliberately independent of the read-only
  // caret's OWN ArrowUp/Down handling (caret.ts, mounted only at k=0): that
  // silently repositions the `.pnode[data-caret]` marker for anchor-engine
  // bookkeeping (no CSS renders it, so it has no visible effect on its own)
  // and never scrolled the view. This handler never touches the caret, so
  // the two run side by side on the same keypress without fighting over it.
  // Sets `caretIsCurrent = false` for the same reason `onViewportWheel`
  // does: a keyboard scroll is just as much "the user moved away from the
  // caret" as a trackpad gesture is, for zoom-out anchoring purposes (§2.5).
  const LINE_SCROLL_PX = 80;
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (inEditable(e.target)) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const layer = currentLayer();
    if (!layer) return;
    e.preventDefault();
    caretIsCurrent = false;
    const max = Math.max(0, layer.scrollHeight - layer.clientHeight);
    const delta = e.key === 'ArrowDown' ? LINE_SCROLL_PX : -LINE_SCROLL_PX;
    const top = Math.min(Math.max(layer.scrollTop + delta, 0), max);
    scrollCommands$.next({ el: layer, top });
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
  scrubberEl = document.querySelector<HTMLElement>('#scrubber')!;
  zoomContextEl = document.querySelector<HTMLElement>('#zoom-context')!;
  zoomFooterEl = document.querySelector<HTMLElement>('#zoom-footer')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  docFilenameEl = document.querySelector<HTMLElement>('#doc-filename')!;
  contentMapEl = document.querySelector<HTMLElement>('#content-map')!;
  generateAffordanceEl = document.querySelector<HTMLButtonElement>('#generate-affordance')!;

  applyContentScale(); // seed --content-scale at 100%

  generateAffordance = mountGenerateAffordance(generateAffordanceEl, {
    // Interpose the local-vs-remote picker (Figma 202:1232) between the
    // click and handleGenerate — the pick decides the provider config.
    onGenerate: () => openGeneratePicker(),
    onCancel: handleCancel,
  });

  // Mount the non-modal status affordance once, into the toolbar. It is driven
  // imperatively (main.ts holds the load result + its corrupt error text).
  const toolbar = document.querySelector<HTMLElement>('.toolbar') ?? document.body;
  statusBadge = mountStatusBadge(toolbar);

  // The generation-history hover card (Figma 241:456) rides on the pill.
  // getRuns is a live getter — no history (fresh raw file) ⇒ it never opens.
  generationTooltip = mountGenerationTooltip(document.body, {
    anchor: statusBadge.anchor,
    getRuns: () => generationRuns,
    // 'native' only: a corrupt payload isn't safely removable (the scanner
    // can't vouch for its bounds), so corrupt docs don't offer the action.
    isTagged: () => currentResult?.kind === 'native',
    onRemoveRequest: () => void handleRemoveZoomLayers(),
  });

  // Mount the two-frame zoom-transition effect once (spec §2.5). Subsequent
  // ZOOM_SET actions drive crossfades; the first render on open stays direct.
  // After a transition settles into its FINAL layer, (re)mount the caret and
  // focus-mask against the layer that actually remains (fixes them otherwise
  // attaching to the pre-transition layer).
  zoomTeardown = mountZoomTransitions(viewportEl, getZoomState, () => {
    remountCaret();
    remountFocusMask();
    // The FINAL layer is the one that survives: rebuild the map against it and
    // re-measure the group boxes (a new level has entirely new offsets). The
    // previously-active group lived on the layer that was just removed.
    resetActiveGroup();
    refreshMap();
  });

  // The map sidebar (§4.9): mounted once, outside #viewport so `renderLevel`'s
  // replaceChildren cannot destroy it. Click-to-scroll routes through
  // scrollCommands$ (see scrollItemToTop).
  mountContentMapOnce();

  // No document is open yet — show the placeholder until the first openFile.
  showEmptyState();

  window.addEventListener('beforeunload', () => {
    zoomTeardown?.();
    zoomTeardown = null;
    caretTeardown?.();
    caretTeardown = null;
    focusMaskTeardown?.();
    focusMaskTeardown = null;
    generationTooltip?.teardown();
    generationTooltip = null;
    statusBadge?.teardown();
    statusBadge = null;
    contentMapTeardown?.();
    contentMapTeardown = null;
    emptyStateTeardown?.();
    emptyStateTeardown = null;
  });

  void installMenu();
  installKeyboardShortcuts();
  installDevHud();
  void refreshProviderStatus();

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

  // A hot reload supersedes any in-flight Generate request (§3.2 row 1's
  // switchMap pattern) — the file on disk just changed out from under it.
  if (synthesisAbort) {
    synthesisAbort.abort();
    synthesisAbort = null;
    void invoke('cancel_llm_generation'); // free the GPU too, not just the promise
  }

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
        const skipPid = titlePid(table);
        prevGroups = reconcile(column, table, index, prevGroups, (sid) =>
          buildGroup(table, index, sid, skipPid),
        );
        // reconcile only manages `.pgroup` children; re-prepend a fresh header
        // (its paragraph count may have changed on reload) as the column's head.
        column.querySelector(':scope > .doc-header')?.remove();
        column.insertBefore(buildHeader(table, 0), column.firstChild);
        remountCaret();
        remountFocusMask();
        mountScrubberForState();
        // Reconcile may have replaced the active group's node (or kept it, D7):
        // sweep the marker and re-derive it from the fresh offsets.
        resetActiveGroup();
        refreshMap(); // reconcile changed the groups → rebuild + re-measure
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
        caretIsCurrent = true;
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

    viewportEl.replaceChildren(buildRawLevel(newResult.raw));
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
      statusBadge?.setStatus('untagged', undefined, { lastRunFailed: lastGenerationRunFailed() });
    }
    mountScrubberForState();
    resetActiveGroup();
    refreshMap(); // no table → hides the map
  }

  // (§5.3 step 6) A real (non-silent) reload was applied → the ONLY permitted
  // feedback: a 1.5s non-modal "Updated" pill. The identical-docHash silent
  // path returned early above and shows NOTHING.
  statusBadge?.flashUpdated('Updated');
}
