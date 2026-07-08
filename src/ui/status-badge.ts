// A small, imperatively-driven status affordance (spec §2.6, §5.3 step 6).
// NON-MODAL only: a persistent warning badge for corrupt docs, a calm note for
// untagged docs, and a 1.5s auto-dismissing "Updated" pill for hot reloads.
// NEVER a modal or a diff view. No `@tauri-apps/*` — pure DOM (ui/ boundary).

export type StatusKind = 'native' | 'untagged' | 'corrupt';

export interface StatusBadgeHandle {
  teardown: () => void;
  /** Persistent, non-modal status. `error` is surfaced for the corrupt kind. */
  setStatus: (status: StatusKind, error?: string) => void;
  /** Show a 1.5s auto-dismissing pill (the ONLY permitted reload feedback). */
  flashUpdated: (message?: string) => void;
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

  // The persistent status note (warning for corrupt, calm for untagged).
  const note = document.createElement('span');
  note.className = 'status-badge__note';
  container.appendChild(note);

  let pill: HTMLElement | null = null;
  let pillTimer: ReturnType<typeof setTimeout> | null = null;

  function clearPillTimer(): void {
    if (pillTimer !== null) {
      clearTimeout(pillTimer);
      pillTimer = null;
    }
  }

  function setStatus(status: StatusKind, error?: string): void {
    if (status === 'corrupt') {
      note.dataset.status = 'corrupt';
      note.setAttribute('role', 'status');
      const detail = error ? `: ${error}` : '';
      note.textContent = `⚠ Unreadable summary—showing raw text${detail}`;
      note.title = error ? `Could not read summaries: ${error}` : 'Could not read summaries';
      Object.assign(note.style, {
        // Text uses the AA-safe amber (4.61:1); the tint/border may use the
        // exact Figma amber, which is a non-text graphic (3:1 suffices).
        color: 'var(--sz-warn-text)',
        background: 'color-mix(in srgb, var(--sz-warn) 12%, transparent)',
        border: '1px solid var(--sz-warn)',
        borderRadius: 'var(--sz-radius-pill)',
        padding: '2px 8px',
      } satisfies Partial<CSSStyleDeclaration>);
    } else if (status === 'untagged') {
      note.dataset.status = 'untagged';
      note.removeAttribute('role');
      note.textContent = 'No summary layer';
      note.title = 'This document has no semantic summaries; showing raw text.';
      Object.assign(note.style, {
        color: 'var(--sz-muted)',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: 'var(--sz-radius-pill)',
        padding: '2px 8px',
      } satisfies Partial<CSSStyleDeclaration>);
    } else {
      // native: clear any warning/note.
      delete note.dataset.status;
      note.removeAttribute('role');
      note.removeAttribute('title');
      note.textContent = '';
      Object.assign(note.style, {
        background: 'transparent',
        border: '1px solid transparent',
        padding: '0',
      } satisfies Partial<CSSStyleDeclaration>);
    }
  }

  function flashUpdated(message = 'Updated'): void {
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

    // Reset the dismissal window so the pill lives 1500ms past the LAST call.
    clearPillTimer();
    pillTimer = setTimeout(() => {
      pillTimer = null;
      pill?.remove();
      pill = null;
    }, PILL_MS);
  }

  function teardown(): void {
    clearPillTimer();
    pill?.remove();
    pill = null;
    container.remove();
  }

  return { teardown, setStatus, flashUpdated };
}
