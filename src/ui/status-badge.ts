// A small, imperatively-driven status affordance (spec §2.6, §5.3 step 6).
// NON-MODAL only: a persistent warning badge for corrupt docs, a calm note for
// untagged docs, and a 1.5s auto-dismissing "Updated" pill for hot reloads.
// NEVER a modal or a diff view. No `@tauri-apps/*` — pure DOM (ui/ boundary).
//
// Since the generation-history tooltip (Figma 241:456), the label is
// PERMANENT — a dot-prefixed pill in every state, including 'native'
// ("Zoomable", green dot), because it doubles as the tooltip's hover entry
// point. The hover wiring itself lives with the tooltip component; this
// module only exposes the anchor element.

// 'synthesizing' / 'generationFailed' (D10/§8.5): Engine B runs take
// minutes, so the outcome must be PERSISTENT — a transient pill expires
// long before the user looks back at the window. Both are cleared by the
// next setStatus call (success → 'native', next doc → whatever it is).
// 'none': no document open — the pill disappears entirely (the label is
// per-document status; the empty state has nothing to report).
export type StatusKind =
  | 'none'
  | 'native'
  | 'untagged'
  | 'corrupt'
  | 'synthesizing'
  | 'generationFailed';

export interface StatusOptions {
  /** Untagged only: the document's most recent recorded generation run
      failed → the dot turns amber (the screengrab's red-dot state) while
      the label text stays the calm "No summary layer". */
  lastRunFailed?: boolean;
}

export interface StatusBadgeHandle {
  teardown: () => void;
  /** Persistent, non-modal status. `error` is surfaced for the corrupt kind. */
  setStatus: (status: StatusKind, error?: string, opts?: StatusOptions) => void;
  /** Show an auto-dismissing pill (the ONLY permitted reload feedback for
      hot reload — 1.5s default). `durationMs` lets Engine B's longer
      start/success/failure/cancel toasts stay legible past the default
      reload-pill duration, which is too brief to read a full sentence. */
  flashUpdated: (message?: string, durationMs?: number) => void;
  /** The permanent status pill — the generation-history tooltip's hover
      anchor. Never removed before teardown. */
  anchor: HTMLElement;
}

/** How long the "Updated" pill stays before auto-dismissing (spec §5.3). */
const PILL_MS = 1500;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Mount the status badge into `root`. Kept out of the reading flow (a small
 * cluster near the toolbar/corner) with a modest z-index on a semantic scale —
 * NOT 9999. Returns imperative controls; main.ts (which holds the load result
 * and its error text) drives it.
 */
export function mountStatusBadge(root: HTMLElement): StatusBadgeHandle {
  const container = document.createElement('div');
  container.className = 'status-badge';
  Object.assign(container.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    position: 'relative',
    zIndex: '5',
    marginLeft: 'auto',
    font: '12px/1.4 var(--sz-font)',
  } satisfies Partial<CSSStyleDeclaration>);
  root.appendChild(container);

  // The persistent status note (warning for corrupt, calm for untagged,
  // "Zoomable" for native) — dot + label, always a pill. The dot span is
  // text-free so `note.textContent` remains exactly the label.
  const note = document.createElement('span');
  note.className = 'status-badge__note';
  Object.assign(note.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  } satisfies Partial<CSSStyleDeclaration>);
  const dot = document.createElement('span');
  dot.className = 'status-badge__dot';
  dot.setAttribute('aria-hidden', 'true');
  Object.assign(dot.style, {
    width: '6px',
    height: '6px',
    borderRadius: 'var(--sz-radius-pill)',
    flex: '0 0 auto',
  } satisfies Partial<CSSStyleDeclaration>);
  const noteLabel = document.createElement('span');
  note.append(dot, noteLabel);
  container.appendChild(note);

  /** Pill chrome shared by every visible state. */
  function pillStyle(): Partial<CSSStyleDeclaration> {
    return {
      background: 'var(--sz-bg)',
      border: '1px solid var(--sz-border)',
      borderRadius: 'var(--sz-radius-pill)',
      padding: '2px 10px',
    };
  }

  function setDot(color: string | null): void {
    dot.style.display = color === null ? 'none' : '';
    dot.style.background = color ?? 'transparent';
  }

  let pill: HTMLElement | null = null;
  let pillTimer: ReturnType<typeof setTimeout> | null = null;
  /** Elapsed-time ticker for the 'synthesizing' state — a generation runs
      for minutes, and a static "Generating…" gives no sense of progress or
      of whether the app is even alive. Cleared on ANY status change. */
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;

  function clearElapsedTimer(): void {
    if (elapsedTimer !== null) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function formatElapsed(startMs: number): string {
    const total = Math.floor((Date.now() - startMs) / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function clearPillTimer(): void {
    if (pillTimer !== null) {
      clearTimeout(pillTimer);
      pillTimer = null;
    }
  }

  function setStatus(status: StatusKind, error?: string, opts?: StatusOptions): void {
    clearElapsedTimer();
    note.style.display = status === 'none' ? 'none' : 'inline-flex';
    if (status === 'none') {
      delete note.dataset.status;
      note.removeAttribute('role');
      note.removeAttribute('title');
      noteLabel.textContent = '';
      return;
    }
    if (status === 'corrupt') {
      note.dataset.status = 'corrupt';
      note.setAttribute('role', 'status');
      setDot(null); // the ⚠ glyph carries the warning; a dot would double it
      const detail = error ? `: ${error}` : '';
      noteLabel.textContent = `⚠ Unreadable summary—showing raw text${detail}`;
      note.title = error ? `Could not read summaries: ${error}` : 'Could not read summaries';
      Object.assign(note.style, {
        // Text uses the AA-safe amber (4.61:1); the tint/border may use the
        // exact Figma amber, which is a non-text graphic (3:1 suffices).
        ...pillStyle(),
        color: 'var(--sz-warn-text)',
        background: 'color-mix(in srgb, var(--sz-warn) 12%, transparent)',
        border: '1px solid var(--sz-warn)',
      } satisfies Partial<CSSStyleDeclaration>);
    } else if (status === 'generationFailed') {
      // Same persistent amber treatment as 'corrupt' — this must survive
      // until the user's next action, not vanish on a timer. Full error in
      // the hover title; the visible text stays glanceable.
      note.dataset.status = 'generation-failed';
      note.setAttribute('role', 'status');
      setDot(null);
      noteLabel.textContent = '⚠ Summary generation failed';
      note.title = error
        ? `Generation failed: ${error}`
        : 'Generation failed — hover for details once available.';
      Object.assign(note.style, {
        ...pillStyle(),
        color: 'var(--sz-warn-text)',
        background: 'color-mix(in srgb, var(--sz-warn) 12%, transparent)',
        border: '1px solid var(--sz-warn)',
      } satisfies Partial<CSSStyleDeclaration>);
    } else if (status === 'synthesizing') {
      note.dataset.status = 'synthesizing';
      note.setAttribute('role', 'status');
      setDot('var(--sz-muted-50)');
      const start = Date.now();
      noteLabel.textContent = 'Generating summary… 0:00';
      note.title = 'Engine B is generating the summary layers for this document.';
      elapsedTimer = setInterval(() => {
        noteLabel.textContent = `Generating summary… ${formatElapsed(start)}`;
      }, 1000);
      Object.assign(note.style, {
        ...pillStyle(),
        color: 'var(--sz-muted)',
      } satisfies Partial<CSSStyleDeclaration>);
    } else if (status === 'untagged') {
      note.dataset.status = 'untagged';
      note.removeAttribute('role');
      // Amber dot when the last recorded run failed (screengrab state);
      // calm gray otherwise. Label text identical in both.
      setDot(opts?.lastRunFailed ? 'var(--sz-warn)' : 'var(--sz-muted-50)');
      noteLabel.textContent = 'No summary layer';
      note.title = 'This document has no semantic summaries; showing raw text.';
      Object.assign(note.style, {
        ...pillStyle(),
        color: 'var(--sz-muted)',
      } satisfies Partial<CSSStyleDeclaration>);
    } else {
      // native: the permanent "Zoomable" pill (Figma screengrab) — the
      // label stays as the generation-history hover entry point.
      note.dataset.status = 'native';
      note.removeAttribute('role');
      setDot('var(--sz-ok)');
      noteLabel.textContent = 'Zoomable';
      note.title = 'This document has semantic summaries — zoom out to read them.';
      Object.assign(note.style, {
        ...pillStyle(),
        color: 'var(--sz-muted)',
      } satisfies Partial<CSSStyleDeclaration>);
    }
  }

  function flashUpdated(message = 'Updated', durationMs = PILL_MS): void {
    const reduced = prefersReducedMotion();
    if (pill === null) {
      pill = document.createElement('span');
      pill.dataset.pill = 'updated';
      pill.setAttribute('role', 'status');
      Object.assign(pill.style, {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        color: 'var(--sz-muted)',
        background: 'var(--sz-track)',
        border: '1px solid var(--sz-border)',
        borderRadius: 'var(--sz-radius-pill)',
        padding: '2px 10px',
        transition: reduced ? 'none' : 'opacity 150ms ease',
        opacity: reduced ? '1' : '0',
      } satisfies Partial<CSSStyleDeclaration>);

      // A small green status dot precedes the "Updated" text (Figma pill).
      const dot = document.createElement('span');
      dot.setAttribute('aria-hidden', 'true');
      Object.assign(dot.style, {
        width: '6px',
        height: '6px',
        borderRadius: 'var(--sz-radius-pill)',
        background: 'var(--sz-ok)',
        flex: '0 0 auto',
      } satisfies Partial<CSSStyleDeclaration>);
      pill.appendChild(dot);

      // Keep the label in its own node so updating text never wipes the dot.
      const label = document.createElement('span');
      label.dataset.pillLabel = '';
      pill.appendChild(label);

      container.appendChild(pill);
      if (!reduced) {
        // Next frame → fade in (instant when reduced motion is requested).
        requestAnimationFrame(() => {
          if (pill) pill.style.opacity = '1';
        });
      }
    }
    const label = pill.querySelector<HTMLElement>('[data-pill-label]');
    if (label) label.textContent = message;

    // Reset the dismissal window so the pill lives `durationMs` past the LAST call.
    clearPillTimer();
    pillTimer = setTimeout(() => {
      pillTimer = null;
      pill?.remove();
      pill = null;
    }, durationMs);
  }

  function teardown(): void {
    clearPillTimer();
    clearElapsedTimer();
    pill?.remove();
    pill = null;
    container.remove();
  }

  // Hidden until the first load result — no document, nothing to report.
  setStatus('none');

  return { teardown, setStatus, flashUpdated, anchor: note };
}
