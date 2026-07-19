// template-resolve.ts — Task 8's pure fallback-chain resolver. Deliberately
// dependency-free (no @tauri-apps/* imports, no DOM): it only combines the
// builtin editorial texts (synthesis-prompt.mjs) with the config object
// Rust's `get_prompt_templates` returns, and picks one. The invoke() call
// and its error handling live in engine-b-remote.ts, not here.

import { BUILTIN_TEMPLATES } from './zoom-tools/synthesis-prompt.mjs';

/** Mirrors Rust's `PromptTemplates` struct (provider_config.rs), camelCase
    over the bridge — see get_prompt_templates. */
export interface PromptTemplatesConfig {
  selected: string;
  overrides: Record<string, string>;
  custom: Array<{ id: string; name: string; text: string }>;
}

export interface ResolvedTemplate {
  id: string;
  name: string;
  text: string;
}

/** Resolve the editorial text for a template id against config + builtins.
    Resolution: docTemplateId (if given) -> config.selected -> 'general'.
    Unknown/deleted ids fall through to the next step, never throw. */
export function resolveTemplate(
  config: PromptTemplatesConfig | null,
  docTemplateId?: string | null,
): ResolvedTemplate {
  const byId = new Map<string, ResolvedTemplate>();
  for (const b of BUILTIN_TEMPLATES as ResolvedTemplate[]) {
    const overrideText = config?.overrides?.[b.id];
    byId.set(b.id, { id: b.id, name: b.name, text: overrideText ?? b.text });
  }
  for (const c of config?.custom ?? []) {
    byId.set(c.id, { id: c.id, name: c.name, text: c.text });
  }

  for (const candidate of [docTemplateId, config?.selected, 'general']) {
    if (candidate && byId.has(candidate)) return byId.get(candidate)!;
  }
  // Unreachable in practice ('general' is always in byId via BUILTIN_TEMPLATES)
  // but kept as a never-throw safety net.
  return { id: 'general', name: 'General', text: BUILTIN_TEMPLATES[0].text };
}
