# Settings Restructure & Customizable Summarization Templates — Design

Date: 2026-07-19. Status: approved in brainstorm session "Semantic Zoom — Settings & Prompt".

## Purpose

Let users shape Engine B's editorial voice (summary length, tone, emphasis)
without ever being able to break the output-format contract the app parses.
Simultaneously restructure the settings window into tabs and gather small
UI quality-of-life controls in a General tab.

## The safety line this design is built on

Engine B's system prompt (`src/native/zoom-tools/synthesis-prompt.mjs`,
consumed by `src/native/engine-b-remote.ts`) has two parts with different
safety profiles:

- **Format contract** — role framing, HARD RULES, TASK step 1 (grouping
  rules), OUTPUT SHAPE. Locked. Grouping must stay locked not only because
  parsing depends on the shape but because `S-` ids derive from grouping
  (D6/D7): editable grouping would churn section ids on every regeneration
  and defeat keyed hot-reload reconciliation.
- **Editorial instructions** — TASK steps 2–3 (section title/body style,
  the Accomplished/Blockers/Next-steps meta shape — never parsed by the
  app). This is the only user-editable layer.

Every template is injected between the same locked `CONTRACT_HEADER` and
`CONTRACT_FOOTER`. No new validation of user text is added: the existing
mechanical output validation → retry ladder → `Untagged` fallback is the
guardrail, and a style that breaks generation fails safely.

## Settings window

`settings.html` gains a segmented control: **General / Prompt / Inference**.
Tabs are pure show/hide — one bundle, no per-tab entry points.
`src/native/settings-form.ts` (246 lines, about to triple) is split into
`src/native/settings/` modules: `tabs.ts`, `general-tab.ts`,
`prompt-tab.ts`, `inference-tab.ts`, plus a thin entry that wires them.
The bundle-alone rule holds: no engine/viewport imports anywhere under it.

### Inference tab

The current provider form, moved verbatim. No behavior change.

### General tab

- **Theme** — a larger radio-group duplicate of the main-view switcher,
  driving the same `theme.ts` mechanism (localStorage + `storage` events)
  so the two live-sync. The small main-view switcher stays.
- **Accent color** — replaces hardcoded `#8080FF`. ~6 preset swatches + a
  native color input. Stored in localStorage (view truth; Rust never needs
  it), synced across webviews like theme, applied as CSS custom property
  `--accent`. Prerequisite chore: sweep stylesheets so every `#8080FF`
  routes through `var(--accent)`.
- **Show anchor IDs** — checkbox toggling a class on the viewport root;
  CSS shows/hides the id labels. localStorage, same sync pattern.

### Prompt tab

- **Template dropdown**: built-in templates tuned to verbose
  coding-LLM-emitted documents, plus **"Add custom…"** last. Built-ins
  (names reviewable): **General** (current default text; ultimate
  fallback), **PRD / Spec**, **Implementation plan**, **Task / progress
  report**, **Research / analysis**.
- Below it, a **textarea** with the selected template's text, live-
  editable. **Save** persists; **Restore default** reverts a built-in to
  shipped text (hidden for customs, which get **Delete** instead).
  "Add custom…" asks for a name and starts from the General text.
- Built-ins are edited **in place** — a tweak to "PRD / Spec" affects every
  doc using it. "Duplicate as custom" is a possible later convenience.
- A short note in the tab states that a style which breaks generation
  fails safely (retry → Untagged).
- **Scope control**: "Default / This document". "This document" is enabled
  only when a doc is open (settings window asks Rust for the current doc
  path via a small command) and selects which template applies to that doc.

## Prompt module refactor

`synthesis-prompt.mjs` exports become: `CONTRACT_HEADER`,
`DEFAULT_EDITORIAL` (and the other shipped template texts — one file owns
all prompt text), `CONTRACT_FOOTER`, and
`buildSystemPrompt(editorial?: string)`. A prompt-assembly test pins that
contract text is always present regardless of template text.

## Storage

The provider-config settings JSON gains one top-level structure (serde
`#[serde(default)]` so old files deserialize cleanly):

```
prompt_templates: {
  selected: string,                    // global default template id
  overrides: { [builtinId]: string },  // absent = shipped default text,
                                       // so shipped-template updates reach
                                       // untweaked users
  custom: [{ id, name, text }],
}
```

Rust stores strings and never interprets them. Small commands
(`get_prompt_templates` / `set_prompt_templates` or equivalent) on the
existing file path; serde round-trip test. The style text travels
settings-webview → Rust file → main-webview at generation time — ordinary
command traffic, not a new document-pipeline crossing.

## Per-document override

The path-keyed generation-history sidecar stores a **template id** per doc
(it already solves path identity + sha256 rename fallback). Resolution at
generation time: doc's template → global selected → General. The history
tooltip records which template a run used. Per-doc free text is explicitly
out of scope — a doc needing unique instructions gets a custom template,
which stays reusable.

## Delivery — three PRs, each independently shippable

1. **Settings tabs + General tab** — segmented control, module split,
   theme duplicate, accent color (+ CSS sweep), anchor-ID toggle. Pure
   frontend.
2. **Prompt templates, global** — prompt module refactor, template
   picker/editor UI, Rust storage + commands, prompt-assembly and config
   round-trip tests.
3. **Per-doc override** — sidecar field, scope UI, resolution order,
   history record.

Each PR ends with the user's manual WebKit pass (background sessions
cannot run it), per standing practice.

<!-- semantic-zoom:payload:v1
{"version":1,"docHash":"49b62cec7756709e77196807217f03193c06c3e92e70c003371cf1370bd65c27","meta":{"M1":{"id":"M1","level":-2,"title":"A settings redesign that lets users tune how their documents get summarized","body":"**Accomplished:**\n- A ratified design for splitting the settings window into three tabs and letting users edit the AI's writing style through swappable templates.\n- A clear safety line: the parts of the AI prompt the app depends on stay locked, so no style tweak can corrupt a document.\n\n**Blockers:**\n- None noted — every piece rides on infrastructure that already shipped.\n\n**Next steps:**\n- Build it in three independent pull requests: the tabbed window first, then the template editor, then per-document template choices.","children":["S-7ce3a0f3-0","S-bfb38c5e-0","S-420089de-0","S-9d919086-0","S-07b62768-0","S-49c11b11-0","S-10291451-0","S-c5197277-0"]}},"sections":{"S-7ce3a0f3-0":{"id":"S-7ce3a0f3-0","level":-1,"parent":"M1","children":["P-7ce3a0f3-0","P-046b20fa-0","P-b8abb050-0","P-0b4f773d-0"],"title":"What this design is for","body":"Users should be able to shape the voice of the summaries the app generates — how long, how formal, what to emphasize — without any way of breaking the machinery underneath. At the same time, the settings window gets reorganized into tabs, making room for small comfort features like picking an accent color."},"S-bfb38c5e-0":{"id":"S-bfb38c5e-0","level":-1,"parent":"M1","children":["P-bfb38c5e-0","P-5ffc0f9b-0","P-2150c42e-0","P-752fd194-0"],"title":"The line between safe and dangerous edits","body":"The instructions sent to the AI have two halves: strict formatting rules the app depends on to read the answer back, and editorial guidance about tone and emphasis. Only the editorial half becomes editable. The strict half also protects something subtle: how paragraphs get grouped determines each section's permanent identity, so grouping rules stay locked or live-reload would break. If a user's style still confuses the AI, the app's existing retry-and-fall-back machinery catches it — nothing new to build there."},"S-420089de-0":{"id":"S-420089de-0","level":-1,"parent":"M1","children":["P-420089de-0","P-5dbeed5e-0","P-447ea52e-0","P-84fe363e-0","P-c20044ec-0","P-55497c5b-0"],"title":"Three tabs and the everyday comforts","body":"The settings window splits into General, Prompt, and Inference tabs. Inference is the existing connection form, unchanged. General gathers small quality-of-life controls: a full-size theme picker that stays in sync with the little one in the main window, an accent color choice replacing the hardcoded purple, and a switch to hide the technical ID labels shown beside sections."},"S-9d919086-0":{"id":"S-9d919086-0","level":-1,"parent":"M1","children":["P-9d919086-0","P-2db56922-0"],"title":"Picking and tweaking a writing style","body":"The Prompt tab offers a dropdown of ready-made styles tuned to the kinds of documents coding assistants typically produce — specs, plans, progress reports, research. Each is freely editable in a text box below, with a restore button for the built-ins; users can also add their own named styles. Editing a built-in changes it everywhere it's used, which is the intended behavior."},"S-07b62768-0":{"id":"S-07b62768-0","level":-1,"parent":"M1","children":["P-07b62768-0","P-9a2c0fb0-0"],"title":"Restructuring the prompt code so styles slot in","body":"The single block of AI instructions gets split into a locked opening, a swappable middle (the style), and a locked ending. A test permanently guarantees the locked parts appear in every assembled prompt no matter what style is active."},"S-49c11b11-0":{"id":"S-49c11b11-0","level":-1,"parent":"M1","children":["P-49c11b11-0","P-7d9d1196-0","P-0b6bb428-0","P-d768d1a9-0"],"title":"Where the styles are saved","body":"Template choices and edits go into the same settings file that already stores the AI connection details. Only user changes are saved — untouched built-ins keep following app updates. The storage layer treats all of it as opaque text."},"S-10291451-0":{"id":"S-10291451-0","level":-1,"parent":"M1","children":["P-10291451-0","P-52996136-0"],"title":"A different style for a specific document","body":"A document can be pinned to a particular template, remembered in the same per-document history file the app already keeps. When generating, the app checks the document's pin first, then the global choice, then the built-in default — and records which style each run used."},"S-c5197277-0":{"id":"S-c5197277-0","level":-1,"parent":"M1","children":["P-c5197277-0","P-4db602c6-0","P-13b52b3f-0"],"title":"Shipping it in three pieces","body":"The work lands as three self-contained pull requests: the tabbed window with its comfort features, then the template system, then the per-document pinning. Each ends with a manual check in the real app, which only the user can run."}},"paragraphs":{"P-7ce3a0f3-0":{"id":"P-7ce3a0f3-0","level":0,"parent":"S-7ce3a0f3-0","kind":"heading","span":{"start":0,"end":72},"html":"<h1>Settings Restructure &amp; Customizable Summarization Templates — Design</h1>"},"P-046b20fa-0":{"id":"P-046b20fa-0","level":0,"parent":"S-7ce3a0f3-0","kind":"prose","span":{"start":74,"end":169},"html":"<p>Date: 2026-07-19. Status: approved in brainstorm session &quot;Semantic Zoom — Settings &amp; Prompt&quot;.</p>"},"P-b8abb050-0":{"id":"P-b8abb050-0","level":0,"parent":"S-7ce3a0f3-0","kind":"heading","span":{"start":171,"end":181},"html":"<h2>Purpose</h2>"},"P-0b4f773d-0":{"id":"P-0b4f773d-0","level":0,"parent":"S-7ce3a0f3-0","kind":"prose","span":{"start":183,"end":454},"html":"<p>Let users shape Engine B&#39;s editorial voice (summary length, tone, emphasis)\nwithout ever being able to break the output-format contract the app parses.\nSimultaneously restructure the settings window into tabs and gather small\nUI quality-of-life controls in a General tab.</p>"},"P-bfb38c5e-0":{"id":"P-bfb38c5e-0","level":0,"parent":"S-bfb38c5e-0","kind":"heading","span":{"start":456,"end":498},"html":"<h2>The safety line this design is built on</h2>"},"P-5ffc0f9b-0":{"id":"P-5ffc0f9b-0","level":0,"parent":"S-bfb38c5e-0","kind":"prose","span":{"start":500,"end":662},"html":"<p>Engine B&#39;s system prompt (<code>src/native/zoom-tools/synthesis-prompt.mjs</code>,\nconsumed by <code>src/native/engine-b-remote.ts</code>) has two parts with different\nsafety profiles:</p>"},"P-2150c42e-0":{"id":"P-2150c42e-0","level":0,"parent":"S-bfb38c5e-0","kind":"list","span":{"start":664,"end":1203},"html":"<ul>\n<li><strong>Format contract</strong> — role framing, HARD RULES, TASK step 1 (grouping\nrules), OUTPUT SHAPE. Locked. Grouping must stay locked not only because\nparsing depends on the shape but because <code>S-</code> ids derive from grouping\n(D6/D7): editable grouping would churn section ids on every regeneration\nand defeat keyed hot-reload reconciliation.</li>\n<li><strong>Editorial instructions</strong> — TASK steps 2–3 (section title/body style,\nthe Accomplished/Blockers/Next-steps meta shape — never parsed by the\napp). This is the only user-editable layer.</li>\n</ul>"},"P-752fd194-0":{"id":"P-752fd194-0","level":0,"parent":"S-bfb38c5e-0","kind":"prose","span":{"start":1205,"end":1487},"html":"<p>Every template is injected between the same locked <code>CONTRACT_HEADER</code> and\n<code>CONTRACT_FOOTER</code>. No new validation of user text is added: the existing\nmechanical output validation → retry ladder → <code>Untagged</code> fallback is the\nguardrail, and a style that breaks generation fails safely.</p>"},"P-420089de-0":{"id":"P-420089de-0","level":0,"parent":"S-420089de-0","kind":"heading","span":{"start":1489,"end":1507},"html":"<h2>Settings window</h2>"},"P-5dbeed5e-0":{"id":"P-5dbeed5e-0","level":0,"parent":"S-420089de-0","kind":"prose","span":{"start":1509,"end":1931},"html":"<p><code>settings.html</code> gains a segmented control: <strong>General / Prompt / Inference</strong>.\nTabs are pure show/hide — one bundle, no per-tab entry points.\n<code>src/native/settings-form.ts</code> (246 lines, about to triple) is split into\n<code>src/native/settings/</code> modules: <code>tabs.ts</code>, <code>general-tab.ts</code>,\n<code>prompt-tab.ts</code>, <code>inference-tab.ts</code>, plus a thin entry that wires them.\nThe bundle-alone rule holds: no engine/viewport imports anywhere under it.</p>"},"P-447ea52e-0":{"id":"P-447ea52e-0","level":0,"parent":"S-420089de-0","kind":"heading","span":{"start":1933,"end":1950},"html":"<h3>Inference tab</h3>"},"P-84fe363e-0":{"id":"P-84fe363e-0","level":0,"parent":"S-420089de-0","kind":"prose","span":{"start":1952,"end":2014},"html":"<p>The current provider form, moved verbatim. No behavior change.</p>"},"P-c20044ec-0":{"id":"P-c20044ec-0","level":0,"parent":"S-420089de-0","kind":"heading","span":{"start":2016,"end":2031},"html":"<h3>General tab</h3>"},"P-55497c5b-0":{"id":"P-55497c5b-0","level":0,"parent":"S-420089de-0","kind":"list","span":{"start":2033,"end":2709},"html":"<ul>\n<li><strong>Theme</strong> — a larger radio-group duplicate of the main-view switcher,\ndriving the same <code>theme.ts</code> mechanism (localStorage + <code>storage</code> events)\nso the two live-sync. The small main-view switcher stays.</li>\n<li><strong>Accent color</strong> — replaces hardcoded <code>#8080FF</code>. ~6 preset swatches + a\nnative color input. Stored in localStorage (view truth; Rust never needs\nit), synced across webviews like theme, applied as CSS custom property\n<code>--accent</code>. Prerequisite chore: sweep stylesheets so every <code>#8080FF</code>\nroutes through <code>var(--accent)</code>.</li>\n<li><strong>Show anchor IDs</strong> — checkbox toggling a class on the viewport root;\nCSS shows/hides the id labels. localStorage, same sync pattern.</li>\n</ul>"},"P-9d919086-0":{"id":"P-9d919086-0","level":0,"parent":"S-9d919086-0","kind":"heading","span":{"start":2711,"end":2725},"html":"<h3>Prompt tab</h3>"},"P-2db56922-0":{"id":"P-2db56922-0","level":0,"parent":"S-9d919086-0","kind":"list","span":{"start":2727,"end":3791},"html":"<ul>\n<li><strong>Template dropdown</strong>: built-in templates tuned to verbose\ncoding-LLM-emitted documents, plus <strong>&quot;Add custom…&quot;</strong> last. Built-ins\n(names reviewable): <strong>General</strong> (current default text; ultimate\nfallback), <strong>PRD / Spec</strong>, <strong>Implementation plan</strong>, <strong>Task / progress\nreport</strong>, <strong>Research / analysis</strong>.</li>\n<li>Below it, a <strong>textarea</strong> with the selected template&#39;s text, live-\neditable. <strong>Save</strong> persists; <strong>Restore default</strong> reverts a built-in to\nshipped text (hidden for customs, which get <strong>Delete</strong> instead).\n&quot;Add custom…&quot; asks for a name and starts from the General text.</li>\n<li>Built-ins are edited <strong>in place</strong> — a tweak to &quot;PRD / Spec&quot; affects every\ndoc using it. &quot;Duplicate as custom&quot; is a possible later convenience.</li>\n<li>A short note in the tab states that a style which breaks generation\nfails safely (retry → Untagged).</li>\n<li><strong>Scope control</strong>: &quot;Default / This document&quot;. &quot;This document&quot; is enabled\nonly when a doc is open (settings window asks Rust for the current doc\npath via a small command) and selects which template applies to that doc.</li>\n</ul>"},"P-07b62768-0":{"id":"P-07b62768-0","level":0,"parent":"S-07b62768-0","kind":"heading","span":{"start":3793,"end":3818},"html":"<h2>Prompt module refactor</h2>"},"P-9a2c0fb0-0":{"id":"P-9a2c0fb0-0","level":0,"parent":"S-07b62768-0","kind":"prose","span":{"start":3820,"end":4129},"html":"<p><code>synthesis-prompt.mjs</code> exports become: <code>CONTRACT_HEADER</code>,\n<code>DEFAULT_EDITORIAL</code> (and the other shipped template texts — one file owns\nall prompt text), <code>CONTRACT_FOOTER</code>, and\n<code>buildSystemPrompt(editorial?: string)</code>. A prompt-assembly test pins that\ncontract text is always present regardless of template text.</p>"},"P-49c11b11-0":{"id":"P-49c11b11-0","level":0,"parent":"S-49c11b11-0","kind":"heading","span":{"start":4131,"end":4141},"html":"<h2>Storage</h2>"},"P-7d9d1196-0":{"id":"P-7d9d1196-0","level":0,"parent":"S-49c11b11-0","kind":"prose","span":{"start":4143,"end":4268},"html":"<p>The provider-config settings JSON gains one top-level structure (serde\n<code>#[serde(default)]</code> so old files deserialize cleanly):</p>"},"P-0b6bb428-0":{"id":"P-0b6bb428-0","level":0,"parent":"S-49c11b11-0","kind":"code","span":{"start":4270,"end":4607},"html":"<pre><code>prompt_templates: {\n  selected: string,                    // global default template id\n  overrides: { [builtinId]: string },  // absent = shipped default text,\n                                       // so shipped-template updates reach\n                                       // untweaked users\n  custom: [{ id, name, text }],\n}\n</code></pre>"},"P-d768d1a9-0":{"id":"P-d768d1a9-0","level":0,"parent":"S-49c11b11-0","kind":"prose","span":{"start":4609,"end":4942},"html":"<p>Rust stores strings and never interprets them. Small commands\n(<code>get_prompt_templates</code> / <code>set_prompt_templates</code> or equivalent) on the\nexisting file path; serde round-trip test. The style text travels\nsettings-webview → Rust file → main-webview at generation time — ordinary\ncommand traffic, not a new document-pipeline crossing.</p>"},"P-10291451-0":{"id":"P-10291451-0","level":0,"parent":"S-10291451-0","kind":"heading","span":{"start":4944,"end":4968},"html":"<h2>Per-document override</h2>"},"P-52996136-0":{"id":"P-52996136-0","level":0,"parent":"S-10291451-0","kind":"prose","span":{"start":4970,"end":5367},"html":"<p>The path-keyed generation-history sidecar stores a <strong>template id</strong> per doc\n(it already solves path identity + sha256 rename fallback). Resolution at\ngeneration time: doc&#39;s template → global selected → General. The history\ntooltip records which template a run used. Per-doc free text is explicitly\nout of scope — a doc needing unique instructions gets a custom template,\nwhich stays reusable.</p>"},"P-c5197277-0":{"id":"P-c5197277-0","level":0,"parent":"S-c5197277-0","kind":"heading","span":{"start":5369,"end":5424},"html":"<h2>Delivery — three PRs, each independently shippable</h2>"},"P-4db602c6-0":{"id":"P-4db602c6-0","level":0,"parent":"S-c5197277-0","kind":"list","span":{"start":5426,"end":5834},"html":"<ol>\n<li><strong>Settings tabs + General tab</strong> — segmented control, module split,\ntheme duplicate, accent color (+ CSS sweep), anchor-ID toggle. Pure\nfrontend.</li>\n<li><strong>Prompt templates, global</strong> — prompt module refactor, template\npicker/editor UI, Rust storage + commands, prompt-assembly and config\nround-trip tests.</li>\n<li><strong>Per-doc override</strong> — sidecar field, scope UI, resolution order,\nhistory record.</li>\n</ol>"},"P-13b52b3f-0":{"id":"P-13b52b3f-0","level":0,"parent":"S-c5197277-0","kind":"prose","span":{"start":5836,"end":5943},"html":"<p>Each PR ends with the user&#39;s manual WebKit pass (background sessions\ncannot run it), per standing practice.</p>"}},"order":{"meta":["M1"],"sections":["S-7ce3a0f3-0","S-bfb38c5e-0","S-420089de-0","S-9d919086-0","S-07b62768-0","S-49c11b11-0","S-10291451-0","S-c5197277-0"],"paragraphs":["P-7ce3a0f3-0","P-046b20fa-0","P-b8abb050-0","P-0b4f773d-0","P-bfb38c5e-0","P-5ffc0f9b-0","P-2150c42e-0","P-752fd194-0","P-420089de-0","P-5dbeed5e-0","P-447ea52e-0","P-84fe363e-0","P-c20044ec-0","P-55497c5b-0","P-9d919086-0","P-2db56922-0","P-07b62768-0","P-9a2c0fb0-0","P-49c11b11-0","P-7d9d1196-0","P-0b6bb428-0","P-d768d1a9-0","P-10291451-0","P-52996136-0","P-c5197277-0","P-4db602c6-0","P-13b52b3f-0"]}}
-->
