// tabs.ts — segmented-control tab switching for the settings window.
// Pure show/hide over one bundle; no per-tab entry points.
export function initTabs(root: HTMLElement): void {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"][data-tab]'));
  const panels = Array.from(root.querySelectorAll<HTMLElement>('section[data-tab]'));
  const select = (name: string) => {
    for (const b of buttons) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of panels) p.toggleAttribute('hidden', p.dataset.tab !== name);
  };
  for (const b of buttons) b.addEventListener('click', () => select(b.dataset.tab!));
}
