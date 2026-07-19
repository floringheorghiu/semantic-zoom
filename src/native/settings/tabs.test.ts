import { describe, expect, it } from 'vitest';
import { initTabs } from './tabs';

function mount(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <div id="tab-bar" role="tablist">
      <button role="tab" data-tab="general" aria-selected="true">General</button>
      <button role="tab" data-tab="inference" aria-selected="false">Inference</button>
    </div>
    <section data-tab="general"></section>
    <section data-tab="inference" hidden></section>`;
  document.body.appendChild(root);
  return root;
}

describe('initTabs', () => {
  it('shows the clicked tab panel and hides the others', () => {
    const root = mount();
    initTabs(root);
    (root.querySelector('[data-tab="inference"][role="tab"]') as HTMLButtonElement).click();
    expect(root.querySelector('section[data-tab="inference"]')!.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('section[data-tab="general"]')!.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-tab="inference"][role="tab"]')!.getAttribute('aria-selected')).toBe('true');
  });
});
