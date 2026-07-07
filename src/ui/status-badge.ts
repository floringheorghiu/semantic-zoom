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
    font: '12px/1.4 system-ui, -apple-system, sans-serif',
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
        color: '#8a5a00',
        background: '#fff4d6',
        border: '1px solid #e6c35c',
        borderRadius: '4px',
        padding: '2px 8px',
      } satisfies Partial<CSSStyleDeclaration>);
    } else if (status === 'untagged') {
      note.dataset.status = 'untagged';
      note.removeAttribute('role');
      note.textContent = 'No summary layer';
      note.title = 'This document has no semantic summaries; showing raw text.';
      Object.assign(note.style, {
        color: '#555',
        background: 'transparent',
        border: '1px solid transparent',
        borderRadius: '4px',
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
        color: '#0a5a2f',
        background: '#dff3e6',
        border: '1px solid #8fd3ab',
        borderRadius: '999px',
        padding: '2px 10px',
        transition: reduced ? 'none' : 'opacity 150ms ease',
        opacity: reduced ? '1' : '0',
      } satisfies Partial<CSSStyleDeclaration>);
      container.appendChild(pill);
      if (!reduced) {
        // Next frame → fade in (instant when reduced motion is requested).
        requestAnimationFrame(() => {
          if (pill) pill.style.opacity = '1';
        });
      }
    }
    pill.textContent = message;

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
