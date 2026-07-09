// src/ui/focus-mask.ts
import { select } from '../state/store';

export function mountFocusMask(viewport: HTMLElement): () => void {
  let prevSid: string | null = null;

  const sub = select((s) => {
    if (!s.doc || !s.index || !s.activeGroupHead) return null;
    return s.index.parentOfParagraph.get(s.activeGroupHead) ?? null;
  }).subscribe((sid) => {
    if (sid === prevSid) return;
    viewport.setAttribute('data-transitioning', '');

    if (prevSid) {
      viewport.querySelector(`.pgroup[data-sid="${prevSid}"]`)
        ?.setAttribute('data-dimmed', '');
    }
    viewport.querySelector(`.pgroup[data-sid="${sid}"]`)
      ?.removeAttribute('data-dimmed');

    // Initial spotlight: dim everything except the active group, once.
    if (prevSid === null) {
      viewport.querySelectorAll(`.pgroup:not([data-sid="${sid}"])`)
        .forEach((g) => g.setAttribute('data-dimmed', ''));
    }
    prevSid = sid;

    viewport.addEventListener('transitionend',
      () => viewport.removeAttribute('data-transitioning'),
      { once: true });
  });

  return () => sub.unsubscribe();
}
