# Product

## Register

product

## Users
Knowledge workers and engineers reading AI-generated Markdown (implementation plans, specs, research reports) on macOS. They open the app to read a long document while it's actively being written by an agent, zooming between a bird's-eye milestone view and full text. The settings window is a secondary, occasional surface: they visit it to pick an accent/theme, wire up a local or remote LLM provider for summary generation, or tweak the prompt template — then leave. It is not the primary task surface.

## Product Purpose
Semantic Zoom lets a reader move fluidly between three zoom levels of a Markdown document (milestones → sections → full text) with spatially anchored, flicker-free transitions, including hot-reload while the file is being written. Settings configures the app around that core reading loop: appearance (accent/theme/anchor IDs), the inference engine used to (re)generate summaries, and the prompt template that shapes those summaries.

## Brand Personality
Warm and approachable, but still a precise native macOS tool — not a SaaS dashboard. Three words: **calm, considered, unfussy**. It should feel like a well-made system preference pane that happens to be a little friendlier than Apple's own: generous whitespace, soft rounding, an inviting (not clinical) tone in labels and helper copy, while staying quiet and getting out of the way once configured.

## Anti-references
The generic "AI-generated form" look: flat undifferentiated inputs, no visual hierarchy between primary/secondary actions, a default-blue save button unrelated to the app's own accent system, tab pills with no breathing room, dense stacked fields with no grouping or explanation. Nothing that looks like a bootstrapped admin panel.

## Design Principles
- **One accent, one system.** The window must draw from the app's existing token system (`--sz-accent`, `--sz-bg`, `--sz-ink`, navy dark palette) rather than inventing a parallel palette (e.g. the hardcoded `#2f6fed` save button today) — consistency across windows is the product's credibility.
- **Quiet by default, clear on focus.** Settings is visited briefly and rarely; hierarchy should guide the eye to the one relevant action per tab without shouting.
- **Warmth through space and voice, not color.** Personality comes from generous spacing, rounded surfaces, and considerate microcopy — not from saturated color or decoration, since accent color itself is a user-configurable, functional token.
- **Never regress functionality.** Every existing behavior (tab switching, provider/model wiring, template CRUD, keyboard/AX semantics) must survive the visual pass unchanged.
- **Native restraint.** No shadows, gradients, or motion that would feel out of place next to a real macOS panel; it should still feel like part of the same OS, just considered.

## Accessibility & Inclusion
WCAG AA: body text ≥4.5:1, focus-visible states on every interactive control (tabs, radios, swatches, inputs, buttons), full keyboard operability (the tab bar already uses `role="tablist"`/`role="tab"` — preserve and extend that semantics), and `prefers-reduced-motion` respected for any added transitions. Supports light/dark/system theme already; new styling must pass contrast in both palettes.
